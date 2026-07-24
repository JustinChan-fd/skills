#!/usr/bin/env bash
# sync-models.sh — Fetch Keystone models + governance, filter to usable models,
# update local configs. Outputs JSON summary to stdout.
set -euo pipefail

KEYSTONE_BASE_URL="${KEYSTONE_BASE_URL:-https://developer-bedrock-platform.fandango.com}"
MIN_CONTEXT_WINDOW="${MIN_CONTEXT_WINDOW:-1000000}"
TOKEN="${ANTHROPIC_AUTH_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
    echo '{"status":"error","message":"ANTHROPIC_AUTH_TOKEN is not set"}' | python3 -m json.tool
    exit 1
fi

AUTH_HEADER="Authorization: Bearer $TOKEN"

# Fetch governance status
GOVERNANCE=$(curl -sf -H "$AUTH_HEADER" "${KEYSTONE_BASE_URL}/api/me/governance-status" 2>/dev/null) || {
    echo '{"status":"error","message":"Failed to fetch governance status from Keystone"}' | python3 -m json.tool
    exit 1
}

# Fetch full model catalog
MODELS=$(curl -sf -H "$AUTH_HEADER" "${KEYSTONE_BASE_URL}/v1/models" 2>/dev/null) || {
    echo '{"status":"error","message":"Failed to fetch model catalog from Keystone"}' | python3 -m json.tool
    exit 1
}

# Run the Python filter/update logic
python3 "$(dirname "$0")/filter-models.py" \
    --governance "$GOVERNANCE" \
    --models "$MODELS" \
    --base-url "$KEYSTONE_BASE_URL" \
    --token "$TOKEN" \
    --min-context "$MIN_CONTEXT_WINDOW"
