#!/usr/bin/env python3
"""
filter-models.py — Core logic for sync-keystone-models skill.

Takes governance status + model catalog, applies tier rules and context window
filter, detects downgrade workarounds, and updates all local config files.
Outputs JSON summary.
"""

import argparse
import json
import os
import sys
from pathlib import Path

# ── Tier pattern matching (mirrors model-access.service.js logic) ────────────

FALLBACK_TIER_PATTERNS = {
    "budget": ["haiku", "nova-micro", "nova-lite", "deepseek.v3"],
    "standard": ["haiku", "sonnet", "nova-pro", "nova-micro", "nova-lite", "deepseek."],
    "premium": ["*"],
    "service_account": ["*"],
}

# Known downgrade workarounds: requesting model A gets you model B (which is
# actually good). These are proactive downgrade rules where the TARGET is
# desirable. Format: { requested_id: { target_id, note } }
DOWNGRADE_WORKAROUNDS = {
    "anthropic.claude-opus-4-7": {
        "target": "anthropic.claude-opus-4-6-v1",
        "note": "Proactive rule: served as Opus 4.6 (same pricing, Opus-class reasoning)",
    },
}


def model_matches_tier(model_id: str, tier: str) -> bool:
    """Check if a model ID is allowed by the tier's patterns."""
    patterns = FALLBACK_TIER_PATTERNS.get(tier, FALLBACK_TIER_PATTERNS["standard"])
    mid = model_id.lower()

    if "*" in patterns:
        return True

    # Opus is explicitly blocked unless the tier has 'opus' pattern
    if "opus" in mid and "opus" not in patterns:
        return False

    return any(pat in mid for pat in patterns)


def get_model_context_window(model: dict) -> int:
    """Extract context window from model metadata. Platform reports it various ways."""
    # The /v1/models endpoint may include context_window or we infer from known models
    for key in ("context_window", "contextWindow", "context_length"):
        if key in model:
            try:
                return int(model[key])
            except (ValueError, TypeError):
                pass
    # Known context windows for models the platform serves
    mid = model.get("id", "").lower()
    if "opus-4-6" in mid or "opus-4-7" in mid or "opus-4-8" in mid or "sonnet-4-6" in mid:
        return 1_000_000
    if "sonnet-4-5" in mid or "haiku-4-5" in mid or "opus-4-1" in mid or "opus-4-5" in mid:
        return 200_000
    if "deepseek" in mid:
        return 128_000 if "r1" in mid or "v3.2" in mid else 200_000
    if "nova" in mid:
        return 200_000
    # Default conservative estimate
    return 200_000


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--governance", required=True, help="JSON string of governance status")
    parser.add_argument("--models", required=True, help="JSON string of model catalog")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--min-context", type=int, default=1_000_000)
    args = parser.parse_args()

    governance = json.loads(args.governance)
    models_data = json.loads(args.models)
    min_ctx = args.min_context

    # Extract model list (API returns { data: [...] } or just [...])
    if isinstance(models_data, dict):
        all_models = models_data.get("data", models_data.get("models", []))
    else:
        all_models = models_data

    tier = governance.get("tier", "standard")
    enforcement = governance.get("enforcementMode", "log")

    # ── Filter models ────────────────────────────────────────────────────
    pass_through = []
    excluded = []
    workarounds = []

    for model in all_models:
        mid = model.get("id", "")
        ctx = get_model_context_window(model)

        # Check if this model would pass the tier gate
        if model_matches_tier(mid, tier):
            if ctx >= min_ctx:
                pass_through.append({"id": mid, "contextWindow": ctx, "reason": "tier_allows"})
            else:
                excluded.append({"id": mid, "contextWindow": ctx, "reason": f"context_window_{ctx}_below_{min_ctx}"})
        else:
            # Check if it's a known workaround
            if mid in DOWNGRADE_WORKAROUNDS:
                wa = DOWNGRADE_WORKAROUNDS[mid]
                target_ctx = 1_000_000  # We know opus-4-6 is 1M
                if target_ctx >= min_ctx:
                    workarounds.append({
                        "requestId": mid,
                        "servedAs": wa["target"],
                        "contextWindow": target_ctx,
                        "note": wa["note"],
                    })
                else:
                    excluded.append({"id": mid, "contextWindow": target_ctx, "reason": "workaround_below_min_context"})
            else:
                excluded.append({"id": mid, "contextWindow": ctx, "reason": f"tier_{tier}_excludes"})

    # ── Build config models list ─────────────────────────────────────────
    config_models = []

    for m in pass_through:
        mid = m["id"]
        name = _display_name(mid)
        config_models.append({
            "id": mid,
            "name": name,
            "contextWindow": m["contextWindow"],
            "maxTokens": 8192,
            "reasoning": _is_reasoning(mid),
            "input": _input_types(mid),
        })

    for wa in workarounds:
        mid = wa["requestId"]
        name = _display_name(mid) + " → serves " + _short_name(wa["servedAs"])
        config_models.append({
            "id": mid,
            "name": name,
            "contextWindow": wa["contextWindow"],
            "maxTokens": 8192,
            "reasoning": _is_reasoning(mid),
            "input": _input_types(mid),
        })

    # ── Check if anything changed ────────────────────────────────────────
    pi_models_path = Path.home() / ".pi" / "agent" / "models.json"
    existing_ids = set()
    if pi_models_path.exists():
        try:
            existing = json.loads(pi_models_path.read_text())
            existing_ids = {m["id"] for m in existing.get("providers", {}).get("keystone", {}).get("models", [])}
        except (json.JSONDecodeError, KeyError):
            pass

    new_ids = {m["id"] for m in config_models}
    changed = new_ids != existing_ids

    # ── Write configs ────────────────────────────────────────────────────
    configs_updated = []

    if changed or not pi_models_path.exists():
        # 1. Pi models.json
        pi_config = {
            "providers": {
                "keystone": {
                    "baseUrl": args.base_url,
                    "api": "anthropic-messages",
                    "apiKey": "$ANTHROPIC_AUTH_TOKEN",
                    "authHeader": True,
                    "models": config_models,
                    "headers": {
                        "x-claude-code-session-id": "$PI_KEYSTONE_SESSION_ID"
                    },
                    "compat": {
                        "supportsEagerToolInputStreaming": False,
                        "sendSessionAffinityHeaders": True,
                    },
                }
            }
        }
        pi_models_path.parent.mkdir(parents=True, exist_ok=True)
        pi_models_path.write_text(json.dumps(pi_config, indent=4) + "\n")
        configs_updated.append(str(pi_models_path))

        # 2. Claude Code gateway cache
        gateway_path = Path.home() / ".claude" / "cache" / "gateway-models.json"
        gateway_models = []
        for m in config_models:
            gateway_models.append({"id": m["id"], "display_name": m["name"]})
        gateway_config = {
            "baseUrl": args.base_url,
            "fetchedAt": int(__import__("time").time() * 1000),
            "models": gateway_models,
        }
        gateway_path.parent.mkdir(parents=True, exist_ok=True)
        gateway_path.write_text(json.dumps(gateway_config, indent=4) + "\n")
        configs_updated.append(str(gateway_path))

        # 3. Claude Code config
        cc_config_path = Path.home() / ".config" / "claude-code" / "claude_code_config.json"
        # Pick best default model (prefer sonnet for speed)
        default_model = next((m["id"] for m in config_models if "sonnet" in m["id"].lower()), config_models[0]["id"] if config_models else "")
        cc_config = {
            "keystone_platform": {
                "api_base_url": args.base_url,
                "bearer_token": args.token,
                "anthropic_default_sonnet_model": default_model,
                "anthropic_default_haiku_model": default_model,
                "available_models": [m["id"] for m in config_models],
            }
        }
        cc_config_path.parent.mkdir(parents=True, exist_ok=True)
        cc_config_path.write_text(json.dumps(cc_config, indent=4) + "\n")
        configs_updated.append(str(cc_config_path))

    # ── Output summary ───────────────────────────────────────────────────
    added = new_ids - existing_ids
    removed = existing_ids - new_ids

    result = {
        "status": "updated" if changed else "unchanged",
        "baseUrl": args.base_url,
        "governance": {
            "userEmail": governance.get("userEmail"),
            "tier": tier,
            "teamName": governance.get("teamName"),
            "enforcementMode": enforcement,
        },
        "tierAllowPatterns": FALLBACK_TIER_PATTERNS.get(tier, []),
        "minimumContextWindow": min_ctx,
        "models": {
            "available": [m["id"] for m in config_models],
            "passThrough": [m["id"] for m in pass_through if m["id"] in new_ids],
            "downgradeWorkarounds": [{"request": wa["requestId"], "served": wa["servedAs"]} for wa in workarounds],
            "excluded": excluded,
        },
        "changes": {
            "added": sorted(added),
            "removed": sorted(removed),
        },
        "configsUpdated": configs_updated,
    }

    print(json.dumps(result, indent=2))


# ── Helpers ──────────────────────────────────────────────────────────────────

def _display_name(model_id: str) -> str:
    """Generate a human-friendly display name from a model ID."""
    names = {
        "anthropic.claude-sonnet-4-6": "Claude Sonnet 4.6",
        "anthropic.claude-sonnet-4-5-20250929-v1:0": "Claude Sonnet 4.5",
        "anthropic.claude-haiku-4-5-20251001-v1:0": "Claude Haiku 4.5",
        "anthropic.claude-opus-4-7": "Claude Opus 4.7",
        "anthropic.claude-opus-4-8": "Claude Opus 4.8",
        "anthropic.claude-opus-4-6-v1": "Claude Opus 4.6",
        "anthropic.claude-opus-4-5-20251101-v1:0": "Claude Opus 4.5",
        "anthropic.claude-opus-4-1-20250805-v1:0": "Claude Opus 4.1",
        "anthropic.claude-fable-5": "Claude Fable 5",
        "deepseek.r1-v1:0": "DeepSeek-R1",
        "deepseek.v3-v1:0": "DeepSeek-V3.1",
        "deepseek.v3.2": "DeepSeek V3.2",
        "amazon.nova-pro-v1:0": "Nova Pro",
        "amazon.nova-lite-v1:0": "Nova Lite",
        "amazon.nova-micro-v1:0": "Nova Micro",
        "amazon.nova-2-lite-v1:0": "Nova 2 Lite",
        "amazon.nova-2-sonic-v1:0": "Nova 2 Sonic",
    }
    if model_id in names:
        return names[model_id]
    # Fallback: clean up the ID
    parts = model_id.split(".")
    return parts[-1].replace("-", " ").title() if len(parts) > 1 else model_id


def _short_name(model_id: str) -> str:
    """Short version for 'serves as' labels."""
    name = _display_name(model_id)
    return name.split("(")[0].strip()


def _is_reasoning(model_id: str) -> bool:
    """Does this model support extended thinking/reasoning?"""
    mid = model_id.lower()
    if "opus" in mid or "sonnet" in mid or "haiku" in mid:
        return True
    if "deepseek" in mid and "r1" in mid:
        return True
    return False


def _input_types(model_id: str) -> list:
    """What input types does this model support?"""
    mid = model_id.lower()
    # Most Claude models support vision
    if "anthropic" in mid:
        return ["text", "image"]
    if "nova-lite" in mid or "nova-pro" in mid or "nova-2-lite" in mid:
        return ["text", "image"]
    return ["text"]


if __name__ == "__main__":
    main()
