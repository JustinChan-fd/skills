---
name: sync-keystone-models
displayName: Sync Keystone Models
version: "1.0.0"
category: development
skillType: action
description: >
  Check Keystone platform for changes to available models and governance rules,
  then update local model configs to only show models that won't be auto-downgraded
  and meet the minimum context window (1M tokens). Use when asked to "sync my models",
  "check for new models", "update my keystone models", "refresh model list", or
  "what models are available now".
license: Private
compatibility: macOS/Linux with curl, python3, and ANTHROPIC_AUTH_TOKEN set
metadata:
  version: "1.0.0"
  displayName: Sync Keystone Models
  category: development
  tags:
    - keystone
    - models
    - governance
    - sync
  skillType: action
  author:
    name: Trevor Menagh
    email: tmenagh@fandango.com
  specVersion: "1.0"
---

# Sync Keystone Models

Checks the Keystone platform for the current model catalog and governance rules,
filters to only models that will actually be served (not silently downgraded),
applies the minimum 1M context window requirement, and updates all local model
config files.

## When to invoke

Trigger on phrases like:
- "sync my models"
- "check for new models"
- "update my keystone models"
- "refresh my model list"
- "what models are available now"
- "has anything changed with my models"

## How to run

```bash
bash ~/.pi/agent/skills/sync-keystone-models/scripts/sync-models.sh
```

The script requires `ANTHROPIC_AUTH_TOKEN` to be set (used for Keystone API auth).

## Output format

The script outputs JSON to stdout with this shape:

```json
{
  "status": "updated|unchanged|error",
  "baseUrl": "https://developer-bedrock-platform.fandango.com",
  "governance": {
    "userEmail": "...",
    "tier": "standard",
    "teamName": "...",
    "enforcementMode": "downgrade"
  },
  "tierAllowPatterns": ["haiku", "sonnet", ...],
  "minimumContextWindow": 1000000,
  "models": {
    "available": [...],
    "passThrough": [...],
    "downgradeWorkarounds": [...],
    "excluded": [...]
  },
  "configsUpdated": ["~/.pi/agent/models.json", ...]
}
```

## How to present results

1. Run the script and parse the JSON output.
2. If `status` is `unchanged`, report "No changes — your model list is current."
3. If `status` is `updated`, show:
   - New models added (if any)
   - Models removed (if any)
   - Current usable model list with context windows
4. If `status` is `error`, show the error message and suggest fixes.

## Special downgrade workarounds

Some models are only accessible via a "back door" — requesting a newer version
that gets downgraded to the one you actually want. The script detects these cases
from the downgrade rules and includes them with a note. Currently:

- **Opus 4.7** → served as Opus 4.6 (proactive downgrade rule, same pricing tier)

These are included because you still get Opus-class reasoning, even though it's
technically a downgrade.

## Configuration

The script respects these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_AUTH_TOKEN` | (required) | Keystone bearer token |
| `KEYSTONE_BASE_URL` | `https://developer-bedrock-platform.fandango.com` | API base URL |
| `MIN_CONTEXT_WINDOW` | `1000000` | Minimum context window in tokens |

## Files updated

- `~/.pi/agent/models.json` — Pi model picker
- `~/.claude/cache/gateway-models.json` — Claude Code model cache
- `~/.config/claude-code/claude_code_config.json` — Claude Code config
