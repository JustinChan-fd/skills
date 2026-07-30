# Alfred — v3 design plan

Status: **plan only. No code written. Not approved.**
Inputs: `alfred/docs/HANDOFF.md` (every number cited here is measured there).
Date: 2026-07-29.

---

## 0. The one-sentence thesis

**Claude Code is already the harness.** Alfred adds only the two things it
genuinely lacks — *accounting* and *unattended scheduling* — and adds a
deterministic *gate* to grade the result from outside. It does not re-implement
orchestration, because orchestration is what cost 4.6x and still didn't ship.

Measured basis (HANDOFF §1): one `claude -p` context did TARS-1339 in **$1.12 /
3.6m** and pushed; the four-phase harness spent **$5.15 / 24.6m** producing a
plan and shipped nothing. 95.6% of the cheap arm's tokens were `cache_read` —
one context reuses its prefix, four phases each rebuild theirs.

**Scope discipline that follows from this:** every piece below is a *pure
function or a shell script*. If a component needs an LLM to decide something,
that is a signal it belongs inside the worker context, not in Alfred.

---

## 1. Standalone constraint

Alfred lives at `skills/alfred/`. It is a directory in the existing repo, not
a new git repo — it inherits the root `package.json` (`harness-skills`, private,
`"type": "module"`, `"test": "node --test"`, **zero dependencies**).

**Hard rule, both directions:**

- Alfred `import`s nothing from `harness-core`.
- `harness-core` `import`s nothing from Alfred.
- No shared config file, no shared `.harness/` directory, no shared run dirs.

`harness-core` stays exactly as it is — it is the evidence that produced this
plan. When someone asks "why is there no verifier loop," the answer is a
directory they can read, not a paragraph I wrote.

Values are **copied, not linked**. The price table gets duplicated into
`alfred/config/prices.json` with its own version stamp. A duplicated 60-line
table is cheaper than a coupling.

### Proposed layout

```
alfred/
  bin/alfred                 # single entrypoint: work | loop | report | gate
  lib/
    config.mjs                # load + validate .alfred/config.json
    tokens.mjs                # transcript → by_model sums, peak, active_ms
    report.mjs                # (transcript, subagentsDir, config) → record
    gate.mjs                  # (config, acMap, gitState, cmdResults) → verdict
    router.mjs                # config + escalation → CLI flags
    fixture.mjs               # provision / reset a sandbox from a fixture
    prices.mjs                # model id normalization + cost math
  config/prices.json          # copied table, version stamped
  test/*.test.mjs
  fixtures/tars-1339/         # see §7 — in-git vs generated is OPEN
  docs/{HANDOFF,PLAN}.md
```

`bin/alfred` is one script with subcommands so the slash command and cron
invoke the *same* code path. There is no second implementation of the trigger.

---

## 2. The four pieces

```
launchd/cron ──▶ bin/alfred loop ──┐
/loop  ────────▶ (shells out)       │  lock → poll source → pick 1 → resolve base
alfred work TARS-1339 ─────────────┘
                     │ spawn
                     ▼
        claude -p  ← ONE context. reads .alfred/config.json.
                     may delegate subagents (tiered, ceilinged).
                     │ exits
                     ▼
        gate   ← deterministic checklist, runs AFTER the worker,
                 in a separate process, on the worker's artifacts
                     │
                     ▼
        report ← transcript + subagents/*.jsonl → record → telemetry sink
```

### 2.1 `alfred work <item>` — the trigger

A shell script. Responsibilities, in order:

1. Load and validate `.alfred/config.json`; refuse with a named error if absent
   or invalid. **No defaults invented for a missing config** — an unattended 3am
   run guessing the base branch is worse than not running.
2. Resolve the work item to `{id, title, body, acceptance_criteria[], source}`
   and **write the raw fetched payload to disk** before doing anything with it.
3. Resolve the base branch (config rule; may be an epic branch — TARS-1271 and
   TARS-1339 both were).
4. Build CLI flags via `router.mjs`.
5. `exec claude -p` with the prompt, and **wait**.
6. Run `gate`.
7. Run `report`.
8. Exit with the gate's verdict as the exit code.

**Step 2's write-to-disk is non-negotiable and is a bug fix, not a feature.**
HANDOFF §"Also found": in `harness-core` the raw ticket is persisted nowhere —
`manifest.json` carries a one-line `source.excerpt`. Fetch-once-with-no-copy
means **no run is replayable**. Alfred writes `run/<id>/source.json` first.

### 2.2 `alfred loop` — scheduling

The only genuinely absent capability (HANDOFF §5 table). Same script, plus:

- A **lock file** with a pid + timestamp; a stale lock (pid dead) is reclaimed,
  a live one exits 0 quietly. Two ticks must never work the same item.
- Poll the configured source, filter by config predicate, pick **one** item.
  Cadence is `loop.poll_interval_minutes` in config (§4), **default 30** — the one
  operational number the persona brief fixed ("he patrols the horizon every 30
  minutes"). It lives in config rather than in code or in `docs/PERSONA.md` because
  an operator will want it different per repo, and a prose doc is a poor place to
  keep a value people change.
- Blocked items are skipped; when nothing workable remains the loop **terminates**
  rather than waking to re-skip forever. `lib/blocked.mjs` `planTick` decides this
  (see §8.5 and `docs/BLOCKED.md`).
- Nothing picked → exit 0 silently. A no-op tick must be indistinguishable from
  a healthy tick to the scheduler.
- Delegate to the `work` path. `loop` adds selection; it does not add behavior.

`harness-loop-core`'s ~3,000-word `SKILL.md` asking an LLM to *be* the loop
("You are ONE TICK of an unattended loop") is what this replaces. The loop is
`while`, a lock, and a poll. Paying model tokens to simulate that is the purest
form of the mistake this whole plan is correcting.

`/loop` the slash command is a thin wrapper that shells out to `bin/alfred
loop`. It carries no logic of its own.

### 2.3 The worker — `claude -p`, one context

Alfred's contribution here is *what it hands over*, not orchestration:

- The ticket, verbatim, plus its AC as an enumerated list.
- `.alfred/config.json` contents (commands, off-limits paths, PR template).
- An `--append-system-prompt` carrying the standing rules: audit the ticket's
  claims before acting; a false premise is a finding, not an obstacle; never
  claim a check passed without having run it.
- Subagent tiers via `--agents <json>`, each with a token ceiling.
- `--fallback-model` — required for unattended ticks; a 3am capacity error must
  not silently produce a dead tick.

The worker may delegate. HANDOFF §4 proves delegation stays fully accounted:
subagent turns are **not** in the parent transcript (0 sidechain entries in a
3-agent session) but live at
`<project-dir>/<session-id>/subagents/agent-<id>.jsonl` with a sibling
`.meta.json` carrying `{agentType, description, toolUseId, spawnDepth}`.
`toolUseId` joins each one back to the exact parent tool call.

**Counter-lesson, priced:** the three unbounded research digs in the session
that produced HANDOFF cost **$11.98** — all opus-5, 3.2–3.9M tokens each. That
is more than the harness run being criticized. Delegation gets a **cheap default
tier and a hard token ceiling**, or it becomes the new 4.6x.

### 2.4 `gate` — deterministic verification

Runs **after** the worker exits, **in a separate process**, reading only
artifacts. It cannot be argued out of a verdict by the agent it is grading.

What was deleted from `harness-core`'s verifier, and why: **scores, rounds,
plateau thresholds, and self-assessed confidence are gone.** The thing that
failed was *LLM self-scoring* — it stamped a stakeholder falsehood `verified`
after sampling one file. Verification itself was never the problem. So the gate
keeps verification and drops the self-assessment.

Checklist, all mechanical (detail in §5):

1. Every config-declared repo check exits 0.
2. Every AC is either **mapped to a command that ran and passed**, or
   **explicitly marked `unverifiable` with a reason**. Silence is a fail.
3. Scope assertion — files touched ⊆ declared scope, ∩ off-limits = ∅.
4. No-fabrication — every claim of the form "X passes" has a recorded command
   with an exit code.
5. Any claim one command settles gets settled, not asserted.

Verdict: `{pass, findings[], unverified[]}`. The gate **never edits the repo**
and never re-runs the worker. It reports.

### 2.5 `report` — accounting

A pure function: `(transcriptPath, subagentsDir, config, expected) → record`.
No I/O in the core; the two entry points do the I/O.

**Two entry points, one implementation:**

- **Stop hook** (`alfred report --from-hook`, reads the payload on stdin).
  Verified this session to fire under `claude -p`. Payload carries
  `session_id, transcript_path, cwd, prompt_id, permission_mode,
  hook_event_name, stop_hook_active, last_assistant_message,
  background_tasks, session_crons`.
- **Script** (`alfred report --transcript <p> --session <id>`) for backfill and
  for grading a transcript after the fact.

The hook path means **hand-run sessions get dashboard numbers too** — you get
accounting for the thing you were already doing instead of it, which is exactly
the shape the measurement argues for.

**The hook payload deletes two-thirds of the old collector.** Everything in
`tokens-collect.mjs` under `subagentsDirForSession`, `discoverLoopTranscript`,
`discoverSubagentForRun` (with `observedTotal` fingerprinting and the
four-strategy `via` widening) exists *only* because nothing told it which
transcript was the run's. The hook is told. That whole layer does not get
ported — see the open question in §8.2 before assuming this.

Record shape (fields, not final JSON):

```
session   { id, run_id, repo, branch, base, cwd, started_at, ended_at, wall_ms }
work      { source, item_id, title, ac_count }
tokens    { by_model: {<id>: {in,out,cache_read,cache_creation}},
            peak_context, active_ms, lines, skipped }
subagents [ { agent_id, agentType, description, toolUseId, spawnDepth,
              by_model, wall_ms } ]
cost      { by_model: {<id>: usd}, total_usd, price_table_version }
gate      { pass, findings[], unverified[] }
delivery  { commits[], pushed_to, pr_url|null }
```

`by_phase` is **absent by design.** There are no phases. If a dashboard panel
needs phases, the honest answer is one bar.

### AS BUILT — five deviations from the sketch above (M2, 2026-07-30)

The sketch was written before M0 and M1 existed, so it names shapes those modules
turned out not to have. The deviations are recorded here rather than silently
absorbed, because a schema sketch nobody reconciles becomes a second, wrong
vocabulary — the defect §8 warns about.

1. **`tokens.by_model[id]` uses `input`/`output`, not `in`/`out`.** The collector
   emits the long spellings; `prices.mjs` COLUMNS accepts both because the
   mismatch is a recorded defect (§9) that shipped twice and priced two
   directions at $0 with green tests. The record carries the producer's spelling
   rather than translating, so there is one name per number end to end.
2. **`cost.by_model[id]` is `{usd, unpriced}`, not a bare `usd`.** A bare number
   cannot express `usd: null, unpriced: true` — the whole never-zero-fill rule.
   The record carries `priceTokens`' own shape instead of flattening it and then
   re-inventing a way to say "unknown".
3. **`cost` gains `parent_usd`, `unpriced[]`, and `complete`; `subagents[]` gains
   `cost_usd` and `active_ms`.** Cost is totalled whole-run per the frozen name,
   so without `parent_usd` and per-subagent `cost_usd` the parent/subagent split
   would be unrecoverable from the total — which is the thing M2 exists to
   measure.
4. **`gaps[]` is a top-level block**, per the M2 amendment (`cdb83a8`).
5. **`sink` is a top-level field, defaulting to `null`.** Carried as data; the
   library never resolves it and never writes. There is deliberately NO default
   path — mutation testing showed a hardcoded `.harness/telemetry` default left
   every test green, because each test either injects a sink or ignores the
   field, so the default was never evaluated. The frozen test now asserts the
   uninjected case too.

`tokens.lines` is the record's name for the collector's `lines_parsed`, and
`tokens.skipped` (non-empty lines minus parsed lines) is derived in `report.mjs`
rather than added to `tokens.mjs`, being a property of the file and not of the
accounting.

---

## 2.6 Build order — DECIDED 2026-07-29

**The ambiguous-ticket fixture comes before any of M0–M7.** Reasoning: the 4.7x
is n=1 on the simplest ticket shape, and an ambiguous ticket is the one shape
where the pipeline could genuinely pay. Nothing in `lib/` exists yet, so this is
the cheapest moment the answer can arrive. Finding out after M4 means a gate and
a router built on a premise that didn't hold.

See `docs/EXPERIMENT-2.md` for the design. **The experiment can overturn §2.**
Explicit possible outcomes, committed to in advance:

| result | what it means | what changes |
|---|---|---|
| single context ≈ or beats pipeline | thesis holds on a second shape | build M0–M7 as written |
| pipeline wins on *quality*, single wins on cost | ambiguity needs a thinking step, not four phases | add **one** pre-step inside the worker context, not a phase graph |
| pipeline wins decisively | phase separation earns its cost on ambiguity | §2 is wrong; route by ticket shape |

## 3. TDD sequence

Standing directive: *"lets try remaining TDD and deterministic as much as
possible."* So: every milestone below is **a list of test names written and
watched fail, before any implementation.** Milestones are ordered so each one is
independently useful — if we stop after M2 we still have something that pays.

Determinism rules for the whole suite:

- No network. No live Jira, no live GitHub, no live `claude`.
- No wall-clock reads in assertions — timestamps come from fixtures.
- Fixtures are files on disk; tests build temp dirs and clean them up.
- **The test suite must not touch `~/.harness/telemetry`.** The known hazard:
  `harness-core`'s tests wrote to the production sink, and `syncRun`'s
  `git add -A -- log` absorbs unrelated staged changes. Alfred's sink path is
  injected, and the default in tests is a temp bare repo.

### M0 — prices (smallest thing that has a real bug in its history)

Chosen first because it is where a silent `$NaN` already happened once.

```
test('price keys are in/out/cache_read/cache_write — not input/output')
test('a dated model id normalizes by stripping -\d{8}$ before lookup')
test('an anthropic.-prefixed id normalizes too')
test('an unknown model id yields a named unpriced result, never NaN and never 0')
test('cost math uses cache_write (5m TTL) and never cache_write_1h')
test('the loaded table carries a version stamp and the record records it')
```

The `NaN`-not-zero test is the important one: a zero cost is plottable and
false, which is worse than a hole. Same reasoning as `timing.mjs`'s
`pr_precedes_run` — withhold the number, flag the input.

### M1 — tokens (spec ported from `harness-core`'s earned cases)

These test names are **lifted verbatim from `harness-core/test/tokens-collect.test.mjs`**
because each one encodes a real bug that was found the expensive way. Porting
the *cases* is free; porting the *code* is the open question in §8.2.

The dedupe seven (the `message.id` double-count that inflated every figure ~2.2x):

```
test('two lines sharing one message.id count that API call once')
test('four lines sharing one message.id count that API call once (real split-block shape)')
test('usage rows with no message.id are each counted, never collapsed together')
test('id-less iterations[] sub-entries still all count under a deduplicated parent line')
test('peak_context is unchanged by deduplication — the fingerprint must not move')
test('two distinct message.ids in one file are both counted — dedupe must not over-collapse')
test('active_ms and timestamps are unchanged by deduplication')
```

Sums and windows:

```
test('sums token usage by model x direction across a transcript')
test('iterations[] sub-entries are summed in addition to top-level message.usage')
test('slices to a caller-supplied start/end ISO window, excluding out-of-window lines')
test('reports per-call timestamp min/max and a gap-capped active-time sum')
test('the gap cap is a named documented parameter with a sensible default')
test('an unrecognized model id is still summed under its own id (tiering happens later)')
```

peak_context:

```
test('peak_context is the largest single call context, not the sum and not the last call')
test('peak_context ignores the start/end window that sums honour')
test('peak_context counts iterations[] sub-entries as their own calls')
test('missing cache keys coerce to 0 rather than NaN')
test('a transcript with no usage entries reports peak_context 0, not -Infinity')
```

Degradation — **never throw, always structured**:

```
test('garbage/malformed transcript returns a structured failure result, never throws')
test('a missing path returns a structured not-found result, never throws')
test('an empty or unparseable transcript still carries a numeric peak_context')
```

Privacy, carried forward as a hard rule:

```
test('return value contains no raw transcript text anywhere in its object graph')
```

*The parser reads no content.* This is why fixtures can be committed at all.

#### M1 as built (2026-07-30) — two decisions the frozen names did not reach

The 20 names above were all implemented without amendment, and the §8.2 mitigation
passed: on the arm 0 real transcript and all three committed fixtures, Alfred's
`by_model`, `peak_context`, `active_ms`, and `lines_parsed` match upstream
`collectFromFile` EXACTLY. Arm 0's anchors are unmoved — 2,207,405 tokens, $1.118285.

Two questions the frozen names leave open, decided here and covered by `ADDED:` tests:

1. **Which row survives a dedupe.** *"Two lines sharing one message.id count that API
   call once"* does not say whose numbers to keep, and every group in
   `split-blocks.jsonl` carries identical rows, so that fixture cannot tell first-wins
   from max-wins. Real duplicates are **not** always identical: id `…7re4umvq` has two
   rows with `{input 2, cache_creation 5502}` and, ~350 lines later, two more with
   every top-level count zeroed. Across 17,330 multi-row groups, 2 disagree per
   direction — and in **0** of them is the first row not the max, so first-wins is
   right today purely by the order the producer happened to use. **Decided: max per
   direction per (model, id).** Order-independent, and a zeroed duplicate is a
   truncated record of one call rather than a second call that cost nothing. The key
   includes the model because a bare-id key drops a second model's call sharing that
   id — an undercount that looks exactly like a model not having been used.

2. **Where cache-write tokens are read from.** `split-blocks.jsonl` was privacy-reduced
   upstream in a way that stripped the nested `cache_creation` block, while **all
   53,950** real usage rows carry one. Ten real rows report flat `0` with a nonzero
   nested 5m bucket, in 3 groups where *every* row has flat 0, so no sibling row can
   supply the number; the largest is 241,475 tokens (~$0.90 at sonnet-5 rates)
   reported as free. **Decided: flat first, nested only as a fallback** — never both,
   because flat is the total across TTL buckets (measured: 25204 flat alongside
   `{5m: 0, 1h: 25204}`) and summing them double-bills. Safe because a nonzero flat
   agreed with `5m + 1h` on all 53,950 rows.

   This is the one place Alfred deliberately **disagrees** with upstream, and the
   difference is recorded rather than reconciled: on those three transcripts Alfred
   reports +1,041, +121, and +241,475 cache-creation tokens. Alfred's figure is the
   correct one.

**Falsified, not merely green.** All 29 tests passed on the first implementation pass,
which is the signature of a suite that cannot fail, so 14 mutants were run. Each killed
a *different* named subset — per-line summing (4 tests), first-wins (1), flat-only
read (2), flat-plus-nested (1), id-less rows keyed as one (6), peak gated on the window
(1), peak as a running sum (4), unseeded `Math.max` (3), no gap cap (2), stamps deduped
with tokens (3), throw-on-malformed (3), iterations ignored (3), NaN uncoerced (2),
model dropped from the key (1). No mutation failed everything, so the propositions are
genuinely separate rather than one assertion wearing several names.

*Process note, recorded because it nearly cost more than it did:* the mutation harness
wrote a literal NUL byte into `lib/tokens.mjs` (an unquoted heredoc expanded
`` `${model}\0${id}` ``). macOS `grep` silently reports **no matches** in a file
containing a NUL, so several greps returned empty and were read as "pattern absent"
when they meant "grep refused to look." One mutant appeared to kill nothing for the
same reason. The delimiter is now written as the escape sequence `\u0000` rather than a raw byte, and a check for NUL
bytes across `alfred/` is part of this milestone's verification.

### M2 — report

```
test('the Stop hook payload alone locates the transcript — no filesystem discovery')
test('subagent files are read from <session>/subagents/ and attributed by toolUseId')
test('spawnDepth is preserved so nested delegation stays attributable')
test('a session that spawned nothing yields subagents: [] and still reports totals')
test('a missing subagents dir is not an error — it is zero subagents')
test('parent totals and subagent totals are reported separately, never conflated')
test('cost is computed per model from the copied table and totalled')
test('a hand-run session with no Alfred work item still produces a valid record')
test('by_phase is absent from the record — there are no phases')
test('the sink path is injected; nothing writes to ~/.harness/telemetry in tests')
test('report failure cannot fail the run — it exits 0 and records its own error')
```

The last one is the pure-sidecar rule, carried over verbatim from the OTel
constraint: capture failure must never fail a tick.

Regression test from arm 0's real numbers, as an end-to-end anchor:

```
test('arm 0 fixture transcript reports 2,207,405 tokens and $1.12 (+/- rounding)')
```

That single assertion is worth the whole suite. It fails loudly if any change to
dedupe, normalization, or the price table moves the headline number.

**Amendment, 2026-07-30 — three names appended, none of the 11 changed.** Added
after reviewing a separate research pass on whether sidecar/metrics collection
would work (`~/Downloads/harness-audit-log-schema.md` + bundle). Implemented in
`lib/gaps.mjs`, tested in `test/gaps.test.mjs` (9 tests).

```
test('ADDED: a structural hole is named in gaps[] and does not set ok: false')
test('ADDED: a transcript with parsed lines but zero usable usage records is a named refusal, not $0')
test('ADDED: a model id that disagrees between sources is named in gaps[], not silently picked')
```

The 11 frozen names and the arm 0 anchor are byte-identical, so arm C's control
holds — additions carry `ADDED:` and name their measurement, per M1's rule.

*Why `gaps` was worth taking.* The doc's §7 step 7 states this project's own M0
principle in other words: "Never zero-fill missing usage. An unmeasured unit and a
free unit must not look the same." Alfred already honoured that for **cost** holes
(`usd: null`, `unpriced: []`, `complete: false`) and had nothing for **structural**
ones — an unreadable subagents dir, an absent session id, a guessed window. Those
either blunted the record to `ok: false` or vanished. That was the one place the
research found Alfred genuinely weaker, so it is the one place amended.

*Why the tripwire keys on parsed-but-unusable.* The doc is right that the
transcript format is internal and moves between versions. Alfred cannot abandon it
— §2.3's by-subagent requirement forces it, and OTel cannot deliver by-subagent
without `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` and a corporate sign-off. So the
answer is to fail loudly on a shape change rather than parse it into a clean,
plottable, false `$0.00`. The trigger is `lines_parsed > 0 && usable === 0`, **not**
"totals are zero": a tripwire that fires on every trivial session gets muted within
a week, and a muted tripwire reads as coverage.

*What the model-disagreement name is for.* Measured 2026-07-30 with a local
OTLP/HTTP listener (~30 lines of `node:http`, no new dependency) against one
`claude -p` through the Bedrock gateway, session `14171034-…`:

| source | model reported |
|---|---|
| `api_request` log record | `claude-haiku-4-5-20251001` |
| `cost.usage` metric | `sonney` |
| `token.usage` metric | `sonney` |
| `--output-format json` `modelUsage` | `sonney` |

One session, identical 4642/264/0/41812 tokens, identical `$0.291135` — a figure
that reconciles to **opus-5 $5/$25 to seven decimals while naming haiku**. Grouping
spend by `model` therefore attributes it to whichever field the reader opened. A
cost that is precise, integer, and wrong is this project's recurring failure shape,
so `cost_usd_micros` is kept as a **disagreement detector and never as the cost
source** — the rate table stays.

**The confounder is now separated — SETTLED 2026-07-30.** The paragraph here
previously left two candidates open: the `"model": "sonney"` typo in
`~/.claude/settings.json`, or Bedrock-style ids missing Claude Code's internal
price table. Three `claude -p` runs with `--output-format json`, reconciling
`total_cost_usd` against the four-dimension table, name the first and clear the
second:

| requested id | reported id | cost | reconciles to |
|---|---|---|---|
| (shell default) | `anthropic.claude-sonnet-4-6` | $0.20610900 | **$3/$15 exact** |
| `anthropic.claude-sonnet-5` | `anthropic.claude-sonnet-5` | $0.27609450 | **$3/$15 exact** |
| `anthropic.claude-opus-5` | `anthropic.claude-opus-5` | $0.38601500 | **$5/$25 exact** |

Bedrock-style ids DO hit the price table. `sonney` was the entire story: an
unrecognized id fell back to opus-5 pricing silently, which is why `$0.291135`
reconciled to $5/$25 while the log named haiku. The typo is fixed.

This changes nothing about the consequence — `cost_usd_micros` stays a detector,
not a source. The disagreement was real and would recur on any unrecognized id,
and a silent fallback to the most expensive rate is a worse failure than a
refusal. What it does change is the *severity* of the earlier claim that "every
session on this machine bills at opus-5 rates": true only while the typo was
present, and no longer true.

*Also settled by that test, for the record.* Telemetry capture works through the
Bedrock gateway (the instrumentation is client-side); `harness.*` resource
attributes land on **both** logs and metrics; `active_time.total` is available
(5.528s, `type: cli`); and `query_source` can be `sdk` — a fourth value the doc's
`main|subagent|auxiliary` enum omits, which is why it was taken as a concept and not
a field. No `OTEL_*` variable is set anywhere on this machine, so capture only
happens when a caller opts in per-process. Nothing in `gaps.mjs` reads telemetry:
`reconcileModel` takes whatever sources a caller *has*, so these tests pass whether
OTel is ever enabled or not. The pure-sidecar rule is unchanged.

*What was deliberately not taken*, so a later reader does not "restore" it:

- **`attempt`.** §2.4 above — the gate "never re-runs the worker. It reports." The
  doc's `attempt` is load-bearing because its harness re-runs phases on verifier
  rejection; Alfred does not, so the field would sit at 1 forever, implying a retry
  loop that does not exist. Absent beats green-and-blind.
- **The doc's `outcome` enum** (`ok|stalled|needs_decision|verifier_rejected|error|aborted`).
  `BLOCKED.md`'s `REASONS` is already a closed set over the same ground
  (`verifier_rejected` ≈ `verification-failed`, `needs_decision` ≈
  `ambiguous-requirement`). Two vocabularies for one concept is the defect the doc's
  own §8 warns about.
- **Markers as the primary source**, and `cost_usd_micros` as the cost source.
- The bundle's `aggregate.py` as a starting point: its backend queries are
  `TODO(backend)` stubs (`query_events` raises, `query_active_time_seconds` returns
  `None`), so adopting it is design adoption, not a working pipeline. It also
  initializes `cost_usd_micros: 0` on units whose `usage` stays `null` and sums those
  into `estimated_total_micros` with no `complete` flag — breaking, in §4, the rule it
  states in §7.

### M3 — config

```
test('a valid .alfred/config.json loads and every field is typed')
test('a missing config is a named refusal, not a set of invented defaults')
test('an unknown top-level key is a validation error, not ignored')
test('base-branch resolution returns the configured epic branch, not master')
test('base-branch resolution falls back only when config says it may')
test('off-limits paths are globs and are resolved relative to repo root')
test('a config declaring no verification commands is invalid — the gate needs at least one')
test('loop.poll_interval_minutes defaults to 30 when the loop block is absent')
test('an explicit poll interval overrides the default')
test('a zero or negative poll interval is a validation error, not a hot loop')
```

The interval tests are three propositions, not one: that the default exists, that
config beats the default, and that a nonsense value is refused. A single
"interval is 30" test would pass a build in which config was ignored entirely.

The epic-branch test exists because TARS-1271 got this wrong: the base was
`feat/migrate-native-fetch-from-axios`, not `master`, and a phased epic ticket
resolving to `master` produces a PR against the wrong tree.

### M4 — gate

```
test('all declared checks exit 0 → pass')
test('one declared check exits non-zero → fail, naming the check and its output')
test('an AC with no mapping and no unverifiable marker → fail (silence is not a pass)')
test('an AC marked unverifiable with a reason → pass, and appears in unverified[]')
test('an AC marked unverifiable with no reason → fail')
test('a claim of "X passes" with no recorded command + exit code → fail (no-fabrication)')
test('a file touched outside declared scope → fail, naming the file')
test('a file touched in an off-limits path → fail, naming the pattern it matched')
test('the gate never writes to the repo — the working tree is byte-identical after')
test('the gate verdict is a pure function of its inputs — same inputs, same verdict')
test('the gate has no model call and no network access')
```

The last three are the whole point. `harness-core`'s verifier produced a false
`verified` because it was an LLM grading with a score. This one is a function.

Two TARS-1339-specific gate tests, from the real findings:

```
test('an AC demanding "0 warnings" against a tree with 2 pre-existing warnings is reported unsatisfiable, not passed')
test('an AC of the form "no behavior changes" with only a formatter run recorded lands in unverified[], not pass')
```

The second is the AC #2 case: 147 files, 526 insertions, 435 deletions, and
**both arms and I left it unverified.** A gate that silently passes it is
reproducing exactly the bug being fixed.

### M5 — router

```
test('worker model comes from config; sonnet is the default when config is silent')
test('--fallback-model is always present for loop-launched runs')
test('subagent tiers become an --agents JSON payload with per-tier ceilings')
test('no tier defaults to opus — the expensive tier must be named explicitly')
// §6.1/§6.2, already implemented in lib/models.mjs and test/models.test.mjs ahead of
// this milestone, because the defect they fix was live in this document.
test('every seat declares max_tokens within its model ceiling')          // done
test('token_budget may exceed the ceiling — it is a different quantity')  // done
test('an unknown model id throws rather than taking a default ceiling')   // done
test('a max_tokens stop_reason is a failure, not a completed turn')       // done
// Still M5's to write: the wiring, which is what carries the above into a real call.
test('the worker records stop_reason per call, and a truncated call fails the run')
test('a truncated response is never written to disk as a completed artifact')
test('escalation to opus emits exactly one logged event with a reason')
test('flag construction is pure: config in, argv array out, no spawn')
```

`no tier defaults to opus` is the $11.98 lesson as an assertion.

### M6 — fixture / eval harness

```
test('provisioning a fixture yields the documented start-state sha')
test('reset restores every ref to its documented sha after a run mutated them')
test('a fixture missing .gitignore is rejected at provision time')
test('a fixture missing package.json is rejected at provision time')
test('result refs land under refs/arm-results/ and are never fetched by a plain clone')
test('the answer branches are absent from the provisioned clone')
```

Every one of these is a hazard that **actually fired** (HANDOFF §3): the saved
fixture was contaminated because arm 0 pushed to the epic branch; a missing
`.gitignore` makes biome hard-error; a missing `package.json` silently disables
biome's React domain and produces 18 phantom warnings that corrupt trap (c)
*while looking plausible*. Provision-time rejection is cheaper than debugging a
plausible-looking wrong number.

### M7 — loop

```
test('a live lock makes a second tick exit 0 without working')
test('a stale lock (dead pid) is reclaimed')
test('no eligible item → exit 0, silent, indistinguishable from a healthy tick')
test('exactly one item is picked even when several are eligible')
test('the raw fetched source payload is written to disk before any interpretation')
test('the loop path and the work path share one implementation')
```

---

## 4. `.alfred/config.json` — schema

Per repo, committed, **the source of truth**. This was the user's call and it was
right: it replaces what a phase used to re-derive every run, at zero tokens.

```jsonc
{
  "version": 1,
  "repo": "webtarsthree",

  "source": {
    "kind": "jira" | "github",
    "jira": { "cloud": "...", "project": "TARS", "epic": "TARS-1271",
              "jql": "..." },
    "github": { "owner": "...", "repo": "...", "labels": ["ready"] }
  },

  "loop": {
    // cadence for `alfred loop`. 30 is the persona brief's number (§2 of
    // docs/PERSONA.md); it is config because operators change it per repo.
    "poll_interval_minutes": 30,
    // the marker a blocked item carries. lib/blocked.mjs BLOCKED_LABEL.
    "blocked_label": "alfred:blocked"
  },

  "base": {
    // in order; first match wins. epic branches are the normal case, not
    // the exception — do not default to the default branch.
    "rules": [
      { "when_epic": "TARS-1271", "branch": "feat/migrate-native-fetch-from-axios" },
      { "default": "master" }
    ]
  },

  "branch_prefix": "alfred/",

  "verify": {
    // name → command. every one must exit 0. at least one required.
    "lint":  "node_modules/.bin/biome check src/",
    "test":  "npm test",
    "build": "npm run build"
  },

  "delivery": {
    "mode": "pr" | "push",        // 1339's AC #4 said push to the epic branch
    "pr_template": ".github/pull_request_template.md",
    "never_merge": true            // standing rule: harness never merges its own PRs
  },

  "off_limits": ["node_modules/**", ".husky/**", "**/*.snap"],

  "models": {
    "worker": "claude-sonnet-4-6",
    "fallback": "claude-sonnet-4-6",
    "agents": {
      // max_tokens   = per-RESPONSE output ceiling (the API parameter).
      // token_budget = per-SEAT spend cap across the subagent's whole life.
      // Two different quantities. See §6.1 — an earlier draft of this block used
      // one name for both and shipped values the gateway would reject.
      "scan":  { "model": "claude-haiku-4-5",  "max_tokens": 64000, "token_budget": 200000 },
      "reason":{ "model": "claude-sonnet-4-6", "max_tokens": 64000, "token_budget": 500000 }
    }
  },

  "telemetry": { "sink": "~/.harness/telemetry", "repo_slug": "webtarsthree" }
}
```

Notes:

- `delivery.mode` exists because of a correction I had to make about my own
  metric: **arm 0 opened no PR *correctly*** — AC #4 said commit directly to the
  epic branch. The delivery bit is "did what the ticket asked," not "was there a
  PR." A config that only knows how to open PRs would grade a correct run as a
  failure.
- `never_merge: true` is the standing rule made mechanical.
- `models.agents` has **no opus entry by default.** Escalation is explicit.

### AS BUILT — M3, 2026-07-30

`lib/config.mjs`, 26 tests. The ten frozen names above are implemented verbatim; 16
carry an `ADDED:` prefix and name their measurement. Four deviations from the schema
sketch, recorded rather than absorbed:

1. **Validation is recursive, not depth-1.** The sketch implies a flat key check. A
   depth-1 walk accepts `delivery.never_merged` — it sees `delivery` as a known key and
   never looks inside — so a typo on the standing never-merge rule reads as applied
   while merging is permitted. `off_limit` for `off_limits` is the same shape one level
   up. An unknown key is an error at every depth, and the error names its full path.
2. **`never_merge: false` is refused, not honoured.** The sketch calls it "the standing
   rule made mechanical," which only holds if `false` is invalid. Accepting it would
   make a standing constraint a per-repo preference one commit can flip.
3. **`loadConfig` does not walk upward.** Deliberate, and the reason is arm C: a loader
   that searched parent directories would find *this* repo's config when run against a
   sandbox that has none, and grade the sandbox against skills' verify commands. It
   reads only the root it is given.
4. **`poll_interval_minutes: 0` is refused, not coerced to 30.** Coercion produces a
   config that reads as applied and is not, and the operator who typed 0 never learns.
   The default applies only when the value is absent, and only after validation.

The value of this module is that it is not an LLM: §4's claim is that config "replaces
what a phase used to re-derive every run, at zero tokens." Nothing in it runs a
command — `verify` values are carried as strings for the gate — because a loader that
shelled out would give a malformed config arbitrary execution at the top of an
unattended tick.

**Mutation testing found three real holes**, none of which review would have caught,
because in every case the guard was already present and correct:

- **`resolveBase`'s `epic &&` and `isOffLimits`'s `..` check are unreachable through
  the validated path.** Inverting either left the whole suite green. Not because the
  guards are untested-but-fine: through `loadConfig`, validation *already* refuses the
  input that would make them fire, so nothing observable distinguishes a working guard
  from a deleted one. This is the unfalsifiable-conjunct shape from §10, met twice
  concretely. The resolution is neither to delete them (both functions are exported
  independently, so the unvalidated surface is real) nor to leave them uncovered: they
  are now tested against hand-built configs the loader would reject, with the loader's
  own refusal asserted alongside, so both layers are proven rather than one assumed.
- **Six semantic guards had no coverage at all** — empty `base.rules`, rule shape,
  empty default branch, non-string verify command, empty off_limits glob, non-object
  JSON. Now one table test covers all six; each was re-verified to kill exactly one.
- **The `repoRoot` type guard was untested, and removing it makes `loadConfig` throw.**
  Every test passed a real temp dir, so the bypass read as green — but the module's
  contract is that it never throws, precisely because an exception at the top of an
  unattended tick kills the tick with no record of why. `join(undefined, …)` raises a
  TypeError. A caller reading a root from a payload field is how undefined arrives.

Two smaller mutation findings: an explicit `null` on an optional block must be treated
as absent rather than type-refused (a templating step emits null for an unset value),
while a `null` on a required field must still be refused; and `loop.blocked_label`'s
default was a string literal duplicating `blocked.mjs`'s `BLOCKED_LABEL` with nothing
asserting they agree — the two-literal drift that has the loop labelling an item with
one name and skipping on another, with neither side looking wrong alone. The test now
binds them by importing the constant, and both drift directions were verified to fail.

---

### AS BUILT — M4, 2026-07-30

`lib/gate.mjs`, 28 tests: the 13 frozen names byte-identical to §3, plus 15 `ADDED:`.
The verdict is `{ pass, findings: [{rule, detail, evidence}], unverified: [{ac, reason}],
blocked_reason }` — no score, no total, no average, because a total is what let a run
look graded while the load-bearing check was never run.

**All 13 frozen names passed on the first run of the implementation.** That is recorded
because it is the least trustworthy possible signal, and the mutation sweep that
followed is why: 39 inversions, of which **10 initially survived** — ten guards that
could each be deleted with every frozen name still green. In all ten cases the guard
was already present and correct (verified by direct probe before any test was written),
so these were test holes, not code bugs. One is worth naming above the others:

- **`ac-command-exit-ignored`.** Deleting the check that reads the exit code of the
  worker's *own proposed* `ac_map` command left all 13 green. That guard is §8.1's
  entire mitigation for the conflict of interest — "a dishonest `ac_map` can only
  propose a command; it cannot fake an exit code." The frozen names cover a declared
  `config.verify` check failing, but never an AC's own mapped command failing, so the
  one mechanism that makes worker-authored input safe to accept had nothing asserting
  it worked. The added test supplies an entry carrying both `result: 'passed'` and
  `exit: 0` alongside a command that exits 1, and asserts the gate ran the command and
  used the code it got back.

**A frozen name passing for the wrong reason.** Emptying `NOT_COMMAND_SETTLEABLE` — the
list encoding "an absence-of-change claim is not settleable by any exit code" — left
every test green. The frozen "no behavior changes" name maps the AC to `npm run lint`,
which shares no subject word with it, so the *subject-overlap* branch catches it and the
pattern list is never reached. Two propositions were riding on one green boolean (§10's
unfalsifiable conjunct, met for the third time in this project). Probing with the list
emptied: `npm run lint` still fails, but `npm run check:behavior` **passes** — it
mentions the subject, so overlap is satisfied, and nothing else objects. Renaming the
command is the cheapest possible response to a `mapping_implausible` finding, so this
was not a theoretical gap. Both branches now have tests that assert *which* reason
fired, so neither can hide behind the other.

**A false kill in my own mutation runner.** `not-settleable-list-emptied` was reported
killed on two consecutive sweeps. It was not: my replacement string produced unbalanced
brackets, node failed to parse the module, and the runner counted the resulting whole-file
failure as a dead mutant. A parse failure scored as a kill is the same false-green shape
this module exists to prevent, arrived at through the tool built to detect it. The final
runner therefore reports three states — `killed`, `SURVIVED`, and **`INVALID — DID NOT
PARSE`** — and separately flags a needle that was never found, so a silent no-op cannot
be certified as coverage either.

**Final: 38 of 39 killed.** The one survivor, `command-presence-not-required`, is a
proven *equivalent mutant* rather than a hole: `words(undefined)` returns `[]`, so a
recorded entry with no command string can never overlap any claim, which makes the
`c.command &&` filter redundant with the overlap check that follows it. No test can
distinguish the two forms, so none was written — an assertion that cannot fail is worth
less than a recorded reason why.

Four decisions the frozen names did not dictate:

- **`ac_failed` is its own rule, distinct from `check_failed`.** A failing declared check
  is a repo-wide fact; a failing AC command is scoped to one AC and names it.
- **First mapping wins on a duplicate `ac_map` entry.** Last-wins lets a worker propose
  a command and then append a second entry for the same AC marked `unverifiable` with a
  plausible reason. Both entries are individually honest; the pair is an escape hatch.
- **Plausibility is checked *before* the exit code.** The exit code is the misleading
  input — `npm run lint` exits 0 on a tree whose behaviour nobody examined — so a gate
  that read it first would have already decided pass.
- **An off-limits file is reported once, under `off_limits`, not also as a scope
  violation.** Two findings for one file reads as two problems, and triage decisions get
  made against counts.

`mapping_implausible` both fails the run *and* records the AC in `unverified[]`. The
finding is what fails; the `unverified` entry is what tells a human which AC still needs
looking at. `unsatisfiable` does the opposite — it stays out of `unverified[]` and sets
`blocked_reason: 'unsatisfiable-ac'` from `blocked.mjs`'s closed set, because "a human
must look" understates a ticket that needs amending (§8.5).

`blocked_reason` is `null` on a pass **and on ordinary failed work**. Nothing asserted
that until mutation: `blocked-reason-always-set` was green, and §8.5 skips blocked items
on later ticks, so a gate that stamped every verdict as blocked would label everything on
the first tick and then terminate as "nothing workable remains" rather than as a bug.

---

## 5. The gate checklist, in detail

Inputs, all files on disk after the worker exits — never the worker's opinion:

| input | source |
|---|---|
| declared checks | `config.verify` |
| check results | the gate runs them itself |
| AC list | `run/<id>/source.json` (the raw payload) |
| AC→command map | **OPEN — see §8.1** |
| files touched | `git diff --name-only <base>...HEAD` |
| worker claims | `REPORT.md` + `run/<id>/commands.jsonl` |

Rules:

1. **Checks.** Run every `config.verify` entry. Any non-zero → fail, with the
   check name and its output. The gate runs them; it does not read the worker's
   report of having run them.
2. **AC coverage.** Each AC resolves to exactly one of:
   `passed(command, exit 0)` / `failed(command, exit N)` /
   `unverifiable(reason)` / `unsatisfiable(evidence)`. **A fifth state does not
   exist. Silence is `fail`.** The `unsatisfiable` state is what TARS-1339's
   AC #1 needs — it demands 0 warnings against a tree with 2 pre-existing ones.
3. **Scope.** `touched ⊆ declared` and `touched ∩ off_limits = ∅`.
4. **No fabrication.** Scan claims for verification language; each must join to
   a recorded command with an exit code. An unbacked claim is a finding, even
   when it happens to be true — because you cannot tell which from the artifact.
5. **Settle the settleable.** Any claim one command decides gets that command
   run. This is the trap-(d) fix: intake stamped *"master is clean at 0 errors"*
   `verified` after sampling **one file** and never running biome on master.
   Master had **5 errors**. One command would have settled it.

Verdict is data, not a score:

```
{ pass: boolean, findings: [{rule, detail, evidence}], unverified: [{ac, reason}] }
```

`unverified` being non-empty does **not** auto-fail — it is the honest channel
for "a human must look." What fails is an AC that is neither verified nor
declared unverifiable. The distinction is the entire design.

---

## 6. Router

A table and two flags. Not a service, not a phase, not a model call.

The table is `lib/models.mjs`'s `SEATS`, and it is validated at import rather than
described here — the numbers below are transcribed from the code, not the reverse.

| seat | model | `max_tokens` | `token_budget` | why |
|---|---|---|---|---|
| worker | `config.models.worker`, default sonnet-4-6 | 64k | 2M | arm 0 did 1339 on sonnet for $1.12 |
| fallback | `config.models.fallback` | 64k | 2M | capacity error at 3am must not kill the tick |
| `scan` subagent | haiku-4-5 | 64k | 200k | mechanical reads. A scan needing 500k has stopped being a scan |
| `reason` subagent | sonnet-4-6 | 64k | 500k | needs judgment |
| adjudicator | opus-5, **explicit only** | 128k | 500k | one logged escalation event, with a reason |

Consistent with the standing position: **sonnet in every seat, Opus as
adjudicator rather than fallback**, and the metric is *tokens per delivered
issue* — not tokens per run, which rewards not shipping.

### 6.1 The two token limits, which are not the same limit

An earlier draft of §4 set `"max_tokens": 200000` on the scan seat and `500000` on
reason. Both are impossible as the API parameter, and finding out why is worth more
than the correction:

| | `max_tokens` | `token_budget` |
|---|---|---|
| scope | one response | one subagent's whole life, summed over every call |
| enforced by | the gateway, which **rejects** the request | Alfred, by stopping the subagent |
| ceiling | **64,000** (sonnet-4-5/4-6, haiku-4-5) or **128,000** (opus-4-6+, opus-5, sonnet-5) | none — bounded by what the work is worth |
| exceeding it costs | nothing; the call never runs | real money |

The original numbers were not wrong about anything real. They were the **$11.98
counter-lesson** — a subagent with no cap burning 3.2–3.9M tokens — which is a spend
cap, the larger of the two quantities, wearing the smaller one's name. The tempting
fix is to clamp both to 64k, and it is the wrong one: it silences the rejected request
while deleting the only bound that was ever protecting the wallet. So the two are
separate fields, and `validateSeat` refuses a seat missing either. Omission has to be
an error rather than an infinity, because absence is exactly how the $11.98 run
happened.

A note on the ceilings: there is **no rule** mapping a model family to its ceiling.
sonnet-4-6 is 64k and sonnet-5 is 128k. `OUTPUT_CEILINGS` is therefore transcribed
from the gateway's model list, and an unrecognised id **throws** rather than receiving
a default — a guessed 64k on a 128k model silently halves the headroom, and a guessed
128k on a 64k model produces a rejected call in the middle of an unattended tick.
Both are invisible; the throw is not.

`max_tokens` sits at each model's ceiling for every seat. The parameter costs nothing
unused, and any lower value is a truncation waiting for the one call that writes a
large file. **Sonnet 5 doubles the ceiling at the same 1M context** — free headroom on
the approved list, and the reason a future worker-seat move from sonnet-4-6 is
attractive on grounds other than capability. That move is not made here: the worker
model is the arm-A baseline's model, and changing it would confound Experiment 2.

### 6.2 Truncation is a failure, not a completed turn

`max_tokens` is a per-response ceiling, so a long run never hits it as a run — an
agent loop makes hundreds of calls and each gets its own 64k. The hazard is narrower
and worse: **one call that tries to emit an enormous file.**

What makes it worth its own component is that **truncation looks like success.** A
`stop_reason: "max_tokens"` response is well-formed — valid envelope, valid content
block — containing half a function or an unterminated JSON object. Nothing downstream
can distinguish it from a finished answer except that one field. A worker that reads
only `content` will commit the corruption and a green suite will not notice, because
the truncated half is what the suite now describes.

So `classifyStop` is a gate, not a log line:

- `end_turn` / `stop_sequence` / `tool_use` → completed.
- `max_tokens` → **failed, `truncated: true`.** Discard the content. The remedy is to
  split the work across calls, never to raise `max_tokens`, which is already at the
  ceiling.
- `refusal` / `pause_turn` → failed, but **not** truncated. Reporting these as
  truncation sends a reader to the wrong fix.
- `null`, or anything unrecognised → **failed.** An unread `stop_reason` and a clean
  finish must not look the same, which is the whole defect in miniature.

---

## 7. Fixtures and evals

### Format

```
fixtures/<slug>/
  origin.git/          bare, ref-surgical — answer branches absent
  ticket-prompt.txt    verbatim ticket + AC, exactly what the arm receives
  ground-truth.json    per-tree assertions, machine-checkable
  refs.json            ref → sha, for reset
  README.md            what this fixture distinguishes, and what it cannot
```

`ground-truth.json` for tars-1339 encodes what HANDOFF §2 measured:

| tree | assertion |
|---|---|
| epic tip `8257ff7f` | 201 errors, 2 warnings, 2 infos |
| `master` `a06a0b59` | **5 errors**, 4 warnings, 4 infos |
| epic + `825e9391` | 2 errors |
| arm 0 final | 2 infos, exit 0 |

Plus the trap table as scored assertions:

| trap | ticket claims | reality | scoreable as |
|---|---|---|---|
| a | 148 files | 144 | did the arm state a count, and was it right |
| b | autofix covers all 201 | leaves 2 | did it find the 2 |
| c | both biome-ignores stale | only `useSemanticElements` is | did it keep the load-bearing one |
| d | "master is clean at 0 errors" | 5 errors | did it check master, and report it |
| e | "no behavior changes" (AC #2) | **unverified by everyone** | did it verify or declare unverifiable |

Trap (e) is new here — it is the fifth assertion HANDOFF §2 says the fixture
needs. Trap (c) is verified by deletion: removing the surviving
`noStaticElementInteractions` yields `Found 1 warning`, because
`role={disabled ? undefined : 'button'}` at `PendingReviewCard.jsx:129` makes
the *conditional* role the reason one suppression is dead and the other is not.
`harness-core`'s plan said "All biome-ignore comments … are removed" — **a
harness following its own plan literally ships a contract violation.** That is
what an eval is for.

### Missing shapes — the honest limit

TARS-1339 covers exactly one shape: *trivially specified + false premise in the
ticket*. **The 4.7x is n=1 on the simplest possible ticket.** Three shapes are
needed before "drop the pipeline" generalizes:

1. **Ambiguous ticket** — the case where intake's ceremony might genuinely pay.
   **This is the one that could falsify the plan**, which is why it should be
   built first, not last.
2. **Ticket that should be pushed back on** — does the arm stop instead of
   confidently building the wrong thing?
3. **Multi-file feature with real tests** — 1339 was formatting; nothing in it
   exercised design judgment.

I am not going to pretend the plan is validated. It is *well-supported on one
shape* and the fixture that would test it hardest doesn't exist yet.

---

## 8. Open questions

**Four of six decided 2026-07-29** (§8.1, §8.2, §8.4, and sequencing). Two
remain open: §8.3 and §8.5.

### 8.1 AC→command mapping — DECIDED: hybrid

**The worker proposes an `ac_map`; the gate never invents a mapping and refuses
silence.** Every AC must resolve to a command that ran, or a `unverifiable`
declaration carrying a reason. This is what §5 rule 2 already assumes, so §5
stands as written.

The conflict of interest is real and stays named: the worker is authoring input
to its own grading. Two mitigations, both mechanical:

- The gate **runs the proposed commands itself** and ignores the worker's claimed
  results. A dishonest `ac_map` can only propose a command; it cannot fake an
  exit code.
- An `ac_map` entry whose command does not mention the AC's subject at all is a
  finding (`mapping_implausible`), not a pass. On 1339, mapping AC #2 ("no
  behavior changes") to `biome check` would trip this — a formatter cannot settle
  a behavior question.

Rejected: *derived* (a wrong mapping silently passing an AC is the exact shape of
the false-`verified` bug) and *human-authored per ticket* (fights the unattended
loop, which is the point of the whole thing).

### 8.2 `tokens-collect` port strategy — DECIDED: port the tests, write fresh

Port the test cases named in §3/M1 as Alfred's spec; TDD ~80 lines fresh. The
Stop hook payload eliminates the discovery two-thirds, and a wholesale port would
carry that dead code past its own passing tests.

**The risk this accepts:** an edge case that exists in the old code but has no
named test. Mitigation — before M1 is called done, diff Alfred's behavior against
`collectFromFile` on the arm 0 transcript and the subagent-driver fixture. Same
inputs must produce the same sums. That is the M2 anchor test
(`2,207,405` tokens / `$1.12`) doing double duty.

### 8.3 Fixture in git, or regenerated by script? — OPEN for the sandbox repo, DECIDED for transcripts

6.7MB bare repo. In-git = reproducible forever, bloats the repo, and needs a
privacy read on every blob. Script-generated = small, but depends on the live
repo still having those shas — and the live TARS-1339 is already
`status: Development Complete`, so the tree has moved on. That argues for
in-git, but it's your repo.

**TRANSCRIPT fixtures: in git. DECIDED 2026-07-30, on evidence from building
them.** Both objections above dissolve for transcripts specifically, because the
parser reads no content and so the fixture need not carry any:

- **Size.** Privacy reduction (keep `type`, `timestamp`,
  `message.{role,model,id,usage}`; replace every content field with the literal
  `SENSITIVE_TRANSCRIPT_TEXT`) took the arm 0 anchor from 316KB to **44KB** and
  the 999-line 28-subagent session to **264KB**. Not repo-bloating.
- **The privacy read is mechanical, not a judgement call.** Enumerate the key
  paths present and assert only accounting fields and the placeholder survive.
  Audited: 0 suspicious long strings, 0 paths, 0 emails, 0 urls. And the
  placeholder is load-bearing — it gives the privacy test something it *could*
  find, so a green there is falsifiable rather than vacuous.
- **Reduction is provably lossless for our purposes.** The reduced arm 0 fixture
  reproduces all four numbers byte-identically: 2,207,405 tokens, $1.118285,
  peak_context 86708, active_ms 211281. That equality IS the proof the parser
  reads no content.
- **Script-generation is impossible here anyway.** These came from real sessions
  in `~/.claude/projects/`, which Claude Code prunes. The 28-subagent session
  cannot be re-run to produce the same numbers.

One exposure is deliberate and named rather than hidden: `subagents[].description`
is model-authored prose, carried because §2.5 asks for it and a dashboard needs a
label. The record's privacy test asserts prose appears **only** there — a
falsifiable claim that documents the exposure. In the committed fixtures that
field is scrubbed to the placeholder. If publishing it is ever ruled out, that
test names the one line to change.

Still open, unchanged: the 6.7MB **sandbox repo**, which is a different question —
it holds real content, so none of the above transfers.

### 8.4 Codename — DECIDED: Alfred

### 8.5 `harness-core` #20 — unsatisfiable or amended blocking AC — DECIDED

**Stop the run, comment on the ticket, label it `alfred:blocked`. Later ticks skip
blocked items; when nothing workable remains, terminate the loop.** A human replies
and removes the label to unblock.

Full policy, rationale and reason codes: **`docs/BLOCKED.md`**. Implementation:
`lib/blocked.mjs`, 21 tests in `test/blocked.test.mjs`, each of the five guards
falsified individually.

TARS-1339 was the instance that made this concrete rather than hypothetical: **AC #1
is not satisfiable as written** (0 warnings against a tree carrying 2 pre-existing
ones), and **AC #4 asks for a direct push, not a PR.** `sandbox-a`'s AC3 reproduces
the same shape deliberately.

---

## 9. Inspired by, does not import — what each idea cost to learn

`harness-core` is not deleted, and this section is why. Each row is an idea worth
keeping and the price paid to find it.

| idea kept | where it was learned | what it cost |
|---|---|---|
| **Ticket-skepticism as a first-class job** | intake stamped *"master is clean at 0 errors"* `verified`; master had 5 errors | a whole phase whose only job it was, failing at it |
| **Accounting must be a pure sidecar** | OTel constraint work; capture failure cannot fail a tick | designed right the first time, kept |
| **`message.id` dedupe** | every cost figure was ~2.2x inflated | one full re-audit of every number ever reported |
| **Withhold bad numbers, don't clamp them** | `timing.mjs`'s `pr_precedes_run` | a dashboard that would have plotted something false |
| **`NaN`-not-zero on unpriced models** | `in`/`out` vs `input`/`output` key mismatch | a `$NaN` in a report |
| **Price ids need normalization** | collector emits `claude-haiku-4-5-20251001`; table has `claude-haiku-4-5` | silent unpriced rows |
| **Config as source of truth** | your call, and correct | would have been re-derived per phase, forever |
| **Base branch is often an epic branch** | TARS-1271 | a PR against the wrong tree |
| **Reconciliation needs a tolerance with a floor** | `TOLERANCE_FRACTION 0.05` + 60s floor | short runs permanently "unreconciled" for no reason |
| **A gate must run outside the thing it grades** | the false `verified` | the central lesson of v2 |
| **Delegation needs ceilings** | 3 unbounded research agents | **$11.98** in one session |
| **Phases destroy cache reuse** | arm 0 vs harness | **4.6x cost, 6.8x wall, and no PR** |
| **Raw source must be persisted** | `manifest.json` keeps a one-line excerpt | no harness run is replayable |
| **Fixtures must reset between runs** | arm 0 pushed to the epic branch mid-save | a contaminated fixture, caught by luck |
| **Fixtures need `.gitignore` + `package.json`** | 18 phantom biome warnings | a wrong number that looked plausible |
| **The loop is `while`, not a prompt** | `harness-loop-core`'s 3,000-word SKILL.md | model tokens spent simulating a `while` loop |

Two things `harness-core` got right that this plan simply keeps: **determinism
over LLM** wherever a command can decide, and **size-based routing** rather than
one model for everything.

---

## 10. What I am not confident about

Stated plainly, because the plan is stronger if these are on the record:

1. **n=1.** The measurement is one ticket, and the simplest shape there is. The
   ambiguous-ticket fixture is the experiment that could overturn §2's structure,
   and it does not exist yet.
2. **The gate's AC mapping is the load-bearing unknown** (§8.1). Get it wrong and
   the gate is theater with better manners than the last one.
3. **The worker's freedom to delegate is unbounded in prompt space.** Ceilings
   cap tokens per subagent; nothing yet caps *how many* it spawns. That needs a
   number, and I don't have a measured basis for one.
4. **`unverified[]` not auto-failing is a judgment call** I made in §5. It is the
   honest channel, but an unattended loop that accumulates `unverified` items
   nobody reads is how you get a second false `verified` — just slower.
