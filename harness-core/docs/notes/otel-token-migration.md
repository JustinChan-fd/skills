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

## Backfill — 2026-07-28 (re-run after cross-check formula fix)

The original backfill on 2026-07-28 used `input+output+cache_read+cache_creation`
as the cross-check numerator. That formula was wrong: `tokens_observed.total`
comes from the Agent-tool `subagent_tokens` tag, which does not accumulate
session-wide cache tokens the way raw JSONL does. Cache counts grow with every
API call across the session; a long session can inflate the sum 57–429×.

The fix (commit on `harness/harness-core`) changes the cross-check to compare
`input+output` only (non-cache tokens) against `tokens_observed.total`.

Re-run results after the fix against all four TARS-1271 runs under
`~/Desktop/Repos/webtarsthree/.harness/runs/`. The pipeline run (`f183b2`)
already had correct directional data and was skipped.

| run_id (suffix) | phase     | status     | observed_total | input+output sum | ratio  | by_model (claude-sonnet-4-6)                                      |
|-----------------|-----------|------------|----------------|------------------|--------|-------------------------------------------------------------------|
| `1ff6b2`        | intake    | resolved   | 126,669        | 53,395           | 0.42×  | input=91, output=53304, cache_read=8,877,711, cache_creation=317,910 |
| `1f6f4c`        | plan      | resolved   | 115,357        | 93,543           | 0.81×  | input=77, output=93466, cache_read=6,278,396, cache_creation=248,272 |
| `202956`        | implement | unresolved | 532,540        | 32,814,809       | 61.6×  | not stamped — cross-check still fails                             |
| `f183b2`        | pipeline  | skipped    | —              | —                | —      | already populated                                                 |

The intake and plan runs are now resolved. The implement run (`202956`) remains
unresolved even with the corrected formula: its `input+output` sum is 32.8 M
vs 532 K observed (ratio 61.6×). The root cause for implement is different from
the cache-inflation issue: a ~4.5-hour implement session re-sends the full
conversation history on every API call, so `input_tokens` itself grows
quadratically across turns. The directional JSONL sum is a cumulative count of
all input bytes ever sent, while `tokens_observed.total` is approximately the
net marginal cost. There is no reliable way to reconstruct the marginal per-run
cost from raw JSONL for long sessions.

The OTel migration (described above) is the correct long-term path for the
implement case. Records outside this repo — data mutation, not a code change.
