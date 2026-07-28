# Prompt Caching — how it works, and how it works here

Status: reference note. No cost figures are asserted here yet — the with-cache /
without-cache split has not been reconciled against a real Anthropic bill (see
issue #12's reconciliation criterion). This note exists to record the mechanism,
cite the sources, and say where the numbers come from, so that when we do prove
a figure out there is a place to cite the evidence.

## Sources

All four dimensions and their semantics come from Anthropic's own docs. Cite
these, not this note, when a number is questioned. Retrieved 2026-07-28; docs
are dated snapshots, so re-verify before treating as current.

| what | url |
|---|---|
| Messages API `usage` object (billing-grade counts) | https://platform.claude.com/docs/en/api/messages |
| Prompt caching — field semantics, write/read economics, TTL | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| Pricing — per-model rates and cache multipliers | https://platform.claude.com/docs/en/about-claude/pricing |
| Claude Code + cache — subagents build their own cache | https://code.claude.com/docs/en/prompt-caching |
| Monitoring usage — transcript location, format-stability caveat | https://code.claude.com/docs/en/monitoring-usage |

The same list, with the quotes that matter, lives in the provenance block at
the top of `tools/lib/tokens-collect.mjs`. Keep the two in sync.

## Where the cache lives

At the Anthropic API layer, not on this machine and not in the harness. There
is no local cache directory to inspect, clear, or warm. A request either
matches a cached prefix server-side or it does not; the only local evidence is
the token counts that come back in the response's `usage` object.

That has one practical consequence worth stating plainly: nothing in this repo
can *make* a cache hit happen. What the harness controls is prompt *stability* —
and stability is what produces hits.

## The four dimensions

Every API response reports input tokens split three ways, plus output:

| field | meaning |
|---|---|
| `input_tokens` | tokens **after** the last cache breakpoint — the uncached tail only |
| `cache_read_input_tokens` | tokens served from an existing cache entry |
| `cache_creation_input_tokens` | tokens written into a new cache entry |
| `output_tokens` | tokens generated |

Total input is the sum of the first three:

    total_input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens

This is why `input_tokens` alone is not a cost input. On a cache-heavy run it is
a rounding error against the other two — pricing off it undercounts by orders of
magnitude, silently, and the result still looks like a plausible dollar figure.

## Matching is prefix-based

A cache entry keys off an exact prefix of the prompt. The match runs
left-to-right and stops at the first difference: one changed token early in the
system prompt invalidates everything after it, no matter how much of the tail is
byte-identical. There is no partial or fuzzy reuse.

Two corollaries the harness design leans on:

- **Volatile content belongs late.** A timestamp, a run id, or a freshly-read
  file near the top of a prompt costs the whole downstream cache.
- **Stable content belongs early.** System prompt, tool definitions, and skill
  text are the same across calls, so they sit in front and stay cached.

## Write costs more than input; read costs a tenth

Per the pricing docs, relative to a model's base input rate:

- cache **write** ≈ 1.25× input (5-minute TTL)
- cache **read** ≈ 0.1× input

So a cached prefix is a bet: you pay a 25% premium once to write it, and recover
10× on each subsequent read. Break-even lands after roughly two reads. Written
once and never read again, a cache entry is pure loss — and it is loss that no
single-number cost view can show you, because it appears as a larger input bill
with nothing to attribute it to.

The tier rates and cache multipliers live in `config/routing.json` under
`tier_prices_usd_per_mtok`, versioned by `price_table.version`.

## TTL

Default cache lifetime is 5 minutes, refreshed on each hit. A prefix used
steadily stays warm indefinitely; a gap longer than the TTL means the next call
pays the write again. A longer TTL option exists at a higher write multiplier —
we do not use it, and should not without measuring first.

## How it shows up in this codebase

`tools/lib/tokens-collect.mjs` parses Claude Code transcript JSONL and sums the
four dimensions per model. Facts specific to our setup:

- **`DIRECTIONS` is the mapping.** The four internal keys — `input`, `output`,
  `cache_read`, `cache_creation` — map to the API's `usage` field names in one
  place (`tokens-collect.mjs`). Anything downstream that needs a fifth
  dimension changes there, not at the call sites.

- **The record field is `tokens_directional.by_model`.** Per-model buckets, each
  with all four counts, plus `format_version`, `collected_at`, and `complete`.
  The schema is in `schemas/run-record.schema.json`. It is stamped additively —
  `stampTokensDirectional` writes only this field and never touches
  `tokens_observed` or `tokens_by_tier`, which come from a different (Agent-tool
  tag) source and mean a different thing.

- **`input` values look absurdly small, and that is correct.** Live runs record
  three-digit `input` against seven-digit `cache_read`. That is not a parse bug:
  it is `input_tokens` doing exactly what the API says — counting only the tail
  past the last breakpoint. Nearly the whole prompt is cache-served.

- **Each subagent has its own cache.** Per the Claude Code docs, a subagent
  starts its own conversation with its own system prompt and tool set, so it
  builds its own cache. Two consequences: driver tokens live in a *subagent*
  transcript rather than the top-level session transcript (which is why
  standalone discovery misses them and why `backfill-directional` exists), and a
  fan-out of N subagents pays N cache writes before any of them reads.

- **An empty `by_model` is not proof of zero spend.** Some records carry
  `complete: true` with `by_model: {}` — the collector found no transcript to
  attribute, not a run that consumed nothing. Treating those as zero understates
  totals. Tracked as issues #5 (vacuous `complete`) and #7
  (`directional_uncaptured` anomaly rule).

- **Transcript parsing is version-specific, not a contract.** The Claude Code
  docs state outright that the transcript entry format is internal and changes
  between versions. Joins on those fields can break on any release. The stable
  replacement is the OpenTelemetry exporter — see `otel-token-migration.md`.

## Where pricing happens

Deliberately not here. The record layer carries captured token counts; the
consumer (the telemetry dashboard) applies rates at read time and stamps which
price-table version it used. Rates change and old records must stay
re-priceable, which they cannot be if a dollar figure is frozen into them at
write time. Issue #8 removes the last such frozen field (`estimated_cost`);
issue #12 builds the read-time computation.

## What is not yet proven

The with-cache / without-cache split is computable from the four dimensions we
now capture, and a first pass over the TARS-1271 records produced a
cache-dominant picture. That pass is **not** cited here as fact: it has not been
reconciled against a real Anthropic billing figure for a known run. Until that
reconciliation exists and the delta is recorded (issue #12, fifth acceptance
criterion), treat any total as better-shaped than the old estimate and still
unverified.
