# Next session: cost accounting + sonnet-first routing

**Written:** 2026-07-29, end of session. **Branch:** `harness/harness-core`.
**Purpose:** a demo of harness cost that budgeting/finance can act on, and a
routing change that lowers it. Read this whole file before touching anything —
several "obvious" conclusions from the prior session were wrong and are
corrected here.

---

## 1. What the numbers actually are

One delivered issue (jarvis #4, 2026-07-29, pipeline run `…172b51`) cost
**$104.69** at published first-party API list rates.

| phase | cost | share |
|---|---|---|
| intake | $2.89 | 3% |
| plan | $1.64 | 2% |
| **implement** | **$93.83** | **90%** |
| residual opus outside implement | $5.12 | 5% |
| sonnet across all phases | $5.73 | 5% |
| **tick total** | **$104.69** | |

Implement, by token column (all Opus 5):

| column | tokens | cost | share |
|---|---|---|---|
| uncached input | 8,554,331 | $45.63 | **46%** |
| cache_read | 55,500,066 | $28.82 | 29% |
| cache_creation | 1,915,258 | $12.94 | 13% |
| output | 453,656 | $11.56 | 12% |

Uncached input is 13% of input tokens but 46% of cost. Cache saved $284.73
(73%) against a no-cache counterfactual of $389.42.

**Finance frame:** enterprise average is ~$13/developer/active-day,
$150–250/developer/month, 90% of users under $30/active-day. This tick is
**8.1× an average developer's entire day**, 52% of a monthly seat.

---

## 2. Corrections to carry forward — do not re-derive these wrong

**The rate table was already correct.** A prior session flagged the exact
0.600 MID/HIGH ratio as evidence the table had been scaled rather than
transcribed, and named rate verification as the blocker on everything else.
That was wrong. Published Opus 5 is **$5/$25**, not $15/$75 — the $15 tier is
Opus **4.1**, deprecated. Our HIGH and MID matched Opus 5 and Sonnet 4.6
exactly. **$104.69 is the real figure. Do not re-open this.**

**Published rates** (platform.claude.com/docs/en/about-claude/pricing,
retrieved 2026-07-29), per MTok:

| Model | in | out | cache read | 5m write | 1h write |
|---|---|---|---|---|---|
| Opus 5 | $5 | $25 | $0.50 | $6.25 | $10 |
| Sonnet 4.6 | $3 | $15 | $0.30 | $3.75 | $6 |
| Sonnet 5 (intro, thru 2026-08-31) | $2 | $10 | $0.20 | $2.50 | $4 |
| Sonnet 5 (from 2026-09-01) | $3 | $15 | $0.30 | $3.75 | $6 |
| Haiku 4.5 | $1 | $5 | $0.10 | $1.25 | $2 |

Cache columns are fixed multiples of that model's input rate: read 0.1×, 5m
write 1.25×, 1h write 2×. Output is 5× input on every current model. A rate
that breaks those ratios is a transcription error — `config.test.mjs` now
asserts them.

**Billing shape these rates assume:** first-party Claude API, standard
(non-batch), `inference_geo` global, fast mode off. Batch (−50%), fast mode
(Opus $10/$50), and US-only residency (1.1×) all **stack on top** and are
excluded. A finance number without this line is unfalsifiable.

**Cache TTL is 5 minutes on an API key** (an hour on subscription; 5 min once
drawing on usage credits). This is the mechanism behind the whole $45.63
uncached-input line — see §4.

**Never verified against a bill.** Everything here is list-rate arithmetic
over our own token counts. The Console is the only place a real invoice
exists. Say so in the demo.

---

## 3. Already done this session (committed? NO — working tree only)

`git status` on `harness/harness-core` shows:
- `harness-core/config/routing.json` — modified
- `harness-core/test/config.test.mjs` — modified
- `harness-core/config/user.json` — modified but **gitignored** (`.gitignore:13`),
  so it will not appear in `git status`. It is still changed on disk.

Changes:
1. **`user.json`: `billing_mode` `"subscription"` → `"api"`.** It was stamped
   wrong on every record ever written. Historical records still say
   `subscription` and are wrong; decide whether to backfill.
2. **`routing.json`: added `model_prices_usd_per_mtok`** — per-model rates,
   now authoritative. `tier_prices_usd_per_mtok` stays only as a fallback bound.
   **The tier table cannot price correctly going forward:** Sonnet 5 at intro
   $2/$10 and Sonnet 4.6 at $3/$15 are both MID. A tier-priced Sonnet 5 record
   overstates by 50%.
3. **Added `cache_write_1h`** to every rate row ($10/MTok on Opus). This is the
   column that makes §4's lever priceable.
4. **`claude-sonnet-5` carries `introductory_until: "2026-08-31"` +
   `standard_after`.** Price a record by comparing its `started_at` to that
   boundary. **Anything run on Sonnet 5 after Sept 1 costs 50% more than the
   same run in August** — this will look like a regression in the dashboard if
   nobody knows.
5. **Added `billing_assumption`** to `price_table` (the §2 paragraph, verbatim).
6. Bumped `price_table.version` to `2026-07-29.1`, `source_url` to
   `platform.claude.com`.
7. **Tests: 460/460 pass.** Three new in `config.test.mjs` (per-model price
   coverage + ratio invariants; Sonnet 5 step-up; billing_assumption presence),
   one version assertion updated.

**Nothing else was touched.** No skill files, no code paths, no commit.

---

## 4. The two cost levers, with arithmetic

### Lever A — sonnet driver, Opus verifier ("voice of reason" seat)

The user's directive, verbatim: *"sonnet for everything, and essentially what
youre saying Opus can be used but it better be used in places that are worth
it. not as a last resort but as someone that comes in to be a voice of reason
and usher the sonnet agents along."*

The config already separates these seats. `routing.json`'s
`tiers.verifier_implement: HIGH` governs verifiers; the **driver** model is
pinned separately in `harness-loop-core/SKILL.md:220`
(`| implement | opus | …`). Flipping the driver to sonnet while leaving
verifiers on Opus:

| verifier share of implement volume | driver = Sonnet 4.6 | driver = Sonnet 5 (intro) |
|---|---|---|
| 0% | $56.30 | $37.53 |
| 15% | $61.93 | $45.98 |
| 30% | $67.56 | $54.42 |

Whole tick at Sonnet 4.6 driver + Opus verifiers ≈ **$70.73 (−32%)**.

**The verifier-share column is a guess.** No per-seat attribution exists —
only per-model totals. Getting that split is task #3 below.

**Quality counterweight — the real metric is tokens-per-delivered-issue
including every round, not per-round price.** Implement took 2 rounds
(0.88 → advisory-fail, then 0.95 → pass) and its Opus verifier caught:
a plan gap (5 test files the plan never enumerated); a `## `-heading
round-trip data loss; a last-wins `Object.fromEntries` collapse; and
`verify/fidelity.mjs` printing FAIL lines with no `process.exit` so it always
exited 0. If a sonnet driver needs a 3rd round, 3 × $56 ≈ $169 vs Opus's
2 × $47 ≈ $94 — **worse off.** That risk is precisely what the Opus verifier
seat is there to absorb. Measure rounds, not just price.

### Lever B — the 5-minute cache TTL. Free; no quality tradeoff.

The implement driver blocks synchronously on each nested verifier dispatch.
From its own `events.jsonl`:
- round 1: spawn **07:15:45** → return **07:24:10** = **8m 25s**
- round 2: spawn **07:39:41** → return **07:49:50** = **10m 09s**

Both exceed the 5-minute TTL. The driver's own cache expired while it waited,
then it re-sent the full context at full input rate. That is the 8.55M
uncached input tokens and $45.63.

Fixing it: **implement $93.83 → $57.89.** Paying the 1h-write premium
(2× instead of 1.25×) on all 1.92M cache_creation costs **$7.77** and saves
**$41.06** — a 5:1 return.

### Both levers together

| scenario | tick | vs baseline | dev-days |
|---|---|---|---|
| baseline (as run) | $104.69 | — | 8.1× |
| A only (Sonnet 4.6 driver) | $70.73 | −32% | 5.4× |
| B only (cache misses fixed, keep Opus) | $63.62 | −39% | 4.9× |
| A + B (Sonnet 5 intro + no misses) | $26.98 | **−74%** | 2.1× |
| A + B with 1h writes | $30.64 | −71% | 2.4× |

---

## 5. The blocker nobody has looked at: every logged token number is wrong

`tokens_observed` on the implement record: **254,351**.
`tokens_directional` on the *same* record: **66,423,311** billable tokens.
That is **0.38%** — off by 261×.

It is not a broken sum. It matches no combination of the directional columns:

| candidate | implement | plan |
|---|---|---|
| all four columns | 0.38% | 2.51% |
| input + output | 2.8% | **345%** |
| output alone | 56.1% | **346%** |

Plan's `tokens_observed` (86,518) is **3.5× its entire in+out volume**. So
`subagent_tokens` — the `<usage>` tag the orchestrator reads off each `Agent()`
result — is measuring something other than billable volume (plausibly a
context-window or turn-weighted figure). **Find out what it measures before
using it for anything.**

Consequences:
- `tokens_by_tier` on implement (285,970) **exceeds** `tokens_observed`
  (254,351), which is impossible if one is a subset of the other.
- `loop.jsonl` reports `"total": 437490` for a tick whose real volume is ~80M.
  **If the finance demo reads `loop.jsonl`, it shows a ~$0.50 tick instead of
  a $105 one.**
- `tokens_directional` is the only trustworthy figure, and it is present on
  **2 of 5** records for this tick (`plan-4`, `implement-4`). The other three
  have `by_model: {}`.

**This outranks the routing change.** A cheaper tick you cannot measure is not
a demo.

---

## 6. Task list for the AM, in order

Multitasking note: **#1 and #2 are independent of #3–#5** and of each other —
they are separate files with separate tests. #6's test runs can start as soon
as #1 lands, and #7/#8 can proceed in parallel with everything, since they
touch only the telemetry repo. Do not parallelize #3 with #4: both touch the
routing/skill seam.

1. **Fix `--repo` slug filtering (issue #14).** `anomalies.mjs:193` does
   `if (repo && repoDir !== repo) continue;` — an exact directory-name match.
   A slug like `JustinChan-fd/jarvis` matches no entry, so the scan examines
   **zero** records and returns `ok: true, findings: []`. That is why
   `anomalies-scan.json` says `"scanned": 0` and `loop.jsonl` line 2 says
   `"anomalies": 0`. **That zero means "nothing examined," not "nothing
   wrong."** Re-running with `--repo jarvis` gave `ok: false, scanned: 5` with
   real findings; unfiltered gave **50 scanned, 93 findings**. Same bug also
   splits the sink into `log/jarvis/` and `log/JustinChan-fd/jarvis/`, which
   double-counts one tick in per-repo aggregation. **Do this first** — nothing
   downstream is readable until the scan works.

2. **Resolve what `subagent_tokens` actually measures (§5).** Until this is
   answered, `tokens_observed`, `tokens_by_tier`, and every `tokens` field in
   `loop.jsonl` are unusable. Options: read the Agent-tool usage-tag semantics;
   or treat `tokens_directional` as the sole source and demote the others to
   diagnostic-only with an explicit note in the schema. Related: #15
   (`session_id` missing on all four records), #17 and #19 (peak-context
   fingerprint — the smoke test they were gated on has now run).

3. **Get per-seat token attribution inside implement.** The verifier-share
   column in §4's table is the single biggest unknown in the routing decision.
   Two Opus verifier spawns are visible in `events.jsonl` with `task_type`,
   `tier`, `model`, `reasoning`, `round` — attribute directional tokens to them
   vs the driver. Without this, lever A's savings are a range, not a number.

4. **Implement lever A as a stamped experiment arm, not a default flip.**
   `harness-loop-core/SKILL.md` invariant 3 requires any driver-model
   deviation to be stamped as the run record's `routing_policy` via
   `init-run --routing-policy`; an unstamped dispatch runs the default. So:
   run the sonnet-driver arm stamped, against the Opus-driver baseline, and
   compare **rounds and score**, not just dollars. Do this **after** #1, so
   round counts are readable.

5. **Attack the 5-min TTL (lever B).** Largest single cost line ($45.63) and
   no quality tradeoff. Two directions: shorten the driver's blocking wait
   below 5 min (the verifier rounds took 8.4 and 10.1 min — the driver has
   nothing to do while blocked), or use 1h cache writes on the driver's
   context (+$7.77 to save $41.06). These are not exclusive.

6. **Wire the cost ceiling.** `sizes.{S,M,L}.cost_ceiling_usd` = 5/15/50
   exists in config, `cost_ceiling` is a valid `reason.code`, and **grep finds
   it only in tests and config — no code enforces it.** This tick was size M
   ($15 ceiling) and cost $104.69: **7× over, silently.** Needs the per-model
   price table (now in place) to evaluate mid-run.

7. **Then more test runs.** The user asked for several to confirm stability.
   Read records directly until #1 lands. Candidates: further jarvis issues;
   TARS-1272 (**base branch is the epic branch
   `feat/migrate-native-fetch-from-axios`, NOT master** — diffing against
   master falsely reads the epic's unmerged work as missing).

8. **`price` subcommand (#12)** — the arithmetic in §1/§4 is proven and the
   per-model table now exists; it needs to live in the CLI instead of ad-hoc
   `node -e`. Telemetry-repo **#2** is its read-time dashboard twin; **#3** is
   the four-dimension explainer; **#1** is `build.js` reading a deleted `v2/`.

9. **Provenance gaps (#15):** `skills_commit` on 1/4 records, `repo_path` on
   2/4, `synced_at: null` throughout the sink, intake's `estimated: true`.
   Also consider `model: haiku` for mechanical subagent seats (LOW tier is
   defined and mapped but nothing routes to it), and `/effort` or
   `MAX_THINKING_TOKENS` on the FULL-reasoning verifier spawns — extended
   thinking bills as **output tokens** with a default budget in the tens of
   thousands. Note: adaptive-reasoning models ignore nonzero budgets; use
   effort levels there instead.

10. **Unanswered from an earlier session:** branch/merge precedence —
    push-straight-to-main vs "before merging to main." Harness never merges
    its own PRs; this is about what the base should be.

---

## 7. Constraints that still bind

- **Do not mutate the TARS-1271 run dirs** under
  `~/Desktop/Repos/webtarsthree/.harness/runs/` — they are evidence. Copy to
  `/tmp`.
- **Two telemetry clones, one is stale.** `~/.harness/telemetry` is
  machine-written by `telemetry.mjs`'s `syncRun` and is the real sink.
  `~/Desktop/Repos/harness-telemetry` is human-edited and goes stale. A prior
  session looked in the wrong one and found zero records.
- **OTel (#16) content flags stay unset:** `OTEL_LOG_USER_PROMPTS`,
  `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`,
  `OTEL_LOG_TOOL_CONTENT`, and especially `OTEL_LOG_RAW_API_BODIES` (writes
  the entire conversation history; its `file:<dir>` form writes untruncated
  bodies to disk). Do not unset or falsify `OTEL_METRICS_INCLUDE_SESSION_ID`
  — `session.id` is the join key. Standard attributes include `user.email`,
  `user.account_uuid`, `user.account_id`, `organization.id`; local-only
  capture makes that moot but any forwarding needs an explicit decision.
  Capture must be a pure side-car: harness code paths unchanged, harness never
  reads telemetry mid-run, capture failure cannot fail a tick, no new
  dependency in `package.json` (Node built-ins only). OTel is currently
  **entirely absent** — no `OTEL_*` vars, nothing in `~/.claude/settings.json`.
- **No Jira subtasks.** Subtasks become phased commits on the PR.
- **Harness never merges its own PRs.**
- Harness = engineering team; ticket author = product/stakeholder.
- Agent tool, workflows, and deep-research only when the user asks.
