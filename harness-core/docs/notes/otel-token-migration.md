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

## Backfill — 2026-07-28

Ran `backfill-directional` against all four TARS-1271 runs under
`~/Desktop/Repos/webtarsthree/.harness/runs/`. The pipeline run (`f183b2`)
already had correct directional data and was skipped.

The intake, plan, and implement runs were attempted but all three were blocked
by the cross-check invariant (ratio > 10×):

| run_id (suffix) | phase     | status     | observed_total | directional_sum | ratio   |
|-----------------|-----------|------------|----------------|-----------------|---------|
| `1ff6b2`        | intake    | unresolved | 126,669        | 9,249,016       | 73.0×   |
| `1f6f4c`        | plan      | unresolved | 115,357        | 6,620,211       | 57.4×   |
| `202956`        | implement | unresolved | 532,540        | 228,550,012     | 429.2×  |
| `f183b2`        | pipeline  | skipped    | —              | —               | —       |

The high ratios are caused by the subagent JSONL accumulating cumulative cache
tokens across all API calls within the session window (cache_read and
cache_creation counts grow with each turn). The `tokens_observed.total` in the
run record reflects only the net tokens used for that run phase, so the
directional sum from the raw JSONL will always diverge far beyond the 10×
threshold. `by_model` remains `{}` in all three records — the cross-check
correctly prevented writing incorrect data.

This backfill confirms the JSONL-parse approach is not reliable for
retroactively stamping per-run directional splits. The OTel migration (described
above) is the correct long-term path. Records outside this repo — data mutation,
not a code change.
