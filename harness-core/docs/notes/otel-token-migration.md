# OTel Token Migration (TODO)

The current directional token collection parses raw Claude Code transcript files
(~/.claude/projects/*/*.jsonl). This is a pragmatic, version-specific source —
not a stable API contract (see tokens-collect.mjs source-doc block, point 4).

The stable alternative is Claude Code's OpenTelemetry exporter:
- Metrics: `claude_code.token.usage`, `claude_code.cost.usage`
- Events: `api_request` carries `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_creation_tokens`, `cost_usd_micros`, keyed by
  `session.id`

Migrate `collectForRun` (and friends) to read from the OTel exporter once it is
confirmed stable and available in the minimum supported Claude Code version.
Reference: https://code.claude.com/docs/en/monitoring-usage
