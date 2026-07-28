# Next session: fix live directional-token capture (TDD) + enforce it with hooks

Branch `harness/harness-core` in `~/Desktop/Repos/skills`. Follow the
`test-driven-development` skill: failing test FIRST for every change.

## READ FIRST — the token capture and costs are NOT correct yet

If you finished the backfill work believing the e2e run's final token capture
and costs are correct: they are not. The backfill tooling got better and the
tests pass (687/0), but the RUN's data is still incomplete and the costs are
off by 1–2 orders of magnitude. Evidence from the records on disk
(`~/Desktop/Repos/webtarsthree/.harness/runs/*`), confirmed 2026-07-28:

- **implement `tokens_directional.by_model` is `{}`** — the largest phase has
  NO directional (input/output) data. Backfill failed it at a 61.6× cross-check.
  So the e2e input/output split is 2-of-3, missing the biggest phase.
- **intake/plan directional exist ONLY because of a manual after-the-fact
  backfill.** During the live run all three stamped empty. Re-run the loop
  as-is tonight and you'd get three empty records again — the live capture path
  is still broken. "Correct because a human backfilled it" ≠ "the feature
  captures correctly."
- **`estimated_cost` is ~10–65× understated.** It is computed from
  `tokens_by_tier` (coarse tier totals), never from directional counts, and
  `estimateCost` prices only input/output — it NEVER prices
  `cache_read`/`cache_creation`, which is ~98% of token volume. Intake on disk:
  `estimated_cost.mid` = $0.072; the real directional counts priced at the MID
  table come to ~$4.65 (cache alone ~$3.85). Same structural gap on plan and
  implement.

So do not treat the tasks below as polish on working code. Treat directional
capture as a BROKEN feature that produced correct-looking data only via a
manual rescue, and only for 2 of 3 phases. The goal is a capture path that is
clean, correct, and complete on EVERY live run with zero manual steps.

## The bug (confirmed 2026-07-28)

`tokens_directional.by_model` was written `{}` for all three TARS-1271 phases
during the live overnight run. A manual `backfill-directional` command rescued
intake/plan afterward (real counts on disk now) but FAILED on implement
(`by_model: {}`, unresolved at 61.6×). A capture feature that only works when a
human remembers to run a rescue command is broken.

**Root cause:** `run-end` -> `collectAndStamp` (harness.mjs:249) defaults to
STANDALONE mode, which reads the newest TOP-LEVEL session `.jsonl`. But phase
drivers ARE subagents — their usage lives in `subagents/agent-*.jsonl`, which
standalone mode deliberately skips (tokens-collect.mjs:43). The phase skills
never pass `--mode loop --subagents-dir`, so live collection reads the wrong
transcript and stamps empty. `backfill-directional` is a manual rescue, not the
capture path.

## The design constraint (do not violate)

**The harness captures RAW values only. It does NOT compute cost.** The v2
record stores raw directional counts per model
(`input`/`output`/`cache_read`/`cache_creation`) and the raw observed total.
All blended-cost / cache-pricing / dollar math belongs to the
dashboard/harness-telemetry side, which reads these raw fields. So:

- DO NOT rewire `estimateCost` to price cache, sum directional, etc. If
  anything, `estimated_cost` should be reconsidered as OUT of scope for the
  harness (a raw-data capture layer shouldn't emit a dollar figure at all).
  Decide explicitly: keep it as a convenience range, or drop it and let the
  dashboard own 100% of cost. Lean toward dropping — one source of truth.
- The harness's ONLY cost-relevant job: emit CLEAN, CORRECT, COMPLETE raw
  token counts on the templated v2 schema, reliably, on EVERY run, for MANY
  runs — no manual rescue step.

## Task 1 — make live capture resolve the subagent transcript (TDD)

Failing test first (`test/tokens-collect.test.mjs` or a new `cli` test):
a `run-end`/`phase-end` for a subagent-driven phase, given a `subagents/` dir
containing the driver's `agent-*.jsonl`, must stamp NON-EMPTY `by_model` with
real directional counts — WITHOUT any separate backfill call.

Then make it pass. Options to weigh (pick the simplest that holds over many
runs, document why):
1. `collectAndStamp` at run-end auto-discovers the correct subagent transcript
   for THIS run (reuse `discoverSubagentForRun`'s window+issue+phase matching)
   instead of defaulting to standalone. Standalone stays the fallback only when
   no subagent dir/match exists.
2. The loop/skills pass `--mode loop --subagents-dir <dir>` explicitly at
   run-end. (Weaker — relies on the LLM remembering. See Task 3.)
- Preserve refuse-on-ambiguity: never guess between two candidate transcripts;
  stamp `complete:false` with a reason note, never a silent `{}`.
- Resolve WHY implement failed at 61.6× (long-session input growth vs the
  cross-check). Either fix the cross-check to be length-robust, or if implement
  genuinely can't be attributed from its transcript, stamp it explicitly
  unresolved-with-reason — never empty-and-silent.

**Evidence this will work — the discovery mechanism is already proven.** The
manual backfill resolved intake and plan by calling exactly the matching logic
option 1 proposes to move into the live path. The records prove
`discoverSubagentForRun` + `collectFromFile` correctly attribute a
subagent-driven phase's transcript:

  - intake `tokens_directional.by_model["claude-sonnet-4-6"]` =
    `{input:91, output:53304, cache_read:8877711, cache_creation:317910}`,
    `complete:true` — cross-check ratio 0.42×.
  - plan `["claude-sonnet-4-6"]` =
    `{input:77, output:93466, cache_read:6278396, cache_creation:248272}`,
    `complete:true` — cross-check ratio 0.81×.

So Task 1 is not new discovery logic — it is moving an already-working
discovery call from a manual command onto the run-end path and letting the
standalone read be the fallback. The only genuinely-unsolved piece is
implement's 61.6× cross-check (the long-session input-growth case), which is
why it stays a separate, explicit sub-item above rather than assumed-fixed.

## Task 2 — a schema-level completeness guard (TDD)

The v2 schema / a `run-end` validation step should make "directional captured"
observable and enforceable:
- Failing test: a finalized `succeeded` run whose `tokens_directional.complete`
  is false (or `by_model` empty) must surface as an ANOMALY via `CLI anomalies`
  (a new finding type, e.g. `directional_uncaptured`), not pass silently.
- This turns a silent capture miss into a red flag the loop already scans for
  in step 7 — so the NEXT run's operator sees it immediately.

**Evidence this will work — the detection has a live, non-empty signal to key
off, and a consumer already wired.** The empty state is unambiguous on disk:
implement's record carries `tokens_directional: {by_model:{}, complete:true}`
while intake/plan carry populated `by_model` with `complete:true`. An anomaly
rule of "`complete:true` but `by_model` empty (or `complete:false`)" cleanly
separates the broken record from the good ones with the fields already present —
no schema migration needed to detect it. And the loop's step 7 ALREADY runs
`CLI anomalies --repo <slug> --limit 20 > .../anomalies-scan.json` every tick
and feeds the count into `loop-record`; a new `directional_uncaptured` finding
type rides that existing path with zero new plumbing. The gap today is purely
that no rule inspects `tokens_directional` — the scan-and-surface machinery it
plugs into is proven and running.

## Task 3 — hooks / triggers so the LLM can't skip capture

The user's instinct is right: capture correctness should not depend on a driver
remembering a flag. Investigate Claude Code hooks
(`.claude/settings.json` hooks, or a PostToolUse/Stop hook) to enforce the
mechanical steps. Ask the claude-code-guide agent for the current hook surface
before designing. Candidate enforcement points:
- After an Agent-tool dispatch returns, ensure the observed `subagent_tokens`
  was recorded (`record-observed-tokens`) before the next phase.
- At run-end, ensure directional capture ran and `complete:true` (or a logged
  reason) before the record is allowed to sync.
- A Stop/SubagentStop hook that refuses to close a phase whose mandatory
  audit/gate/token steps didn't fire.
Deliverable: a short design note (what a hook CAN enforce deterministically vs
what still needs prose in SKILL.md) + a minimal working hook for the
highest-leverage gap (likely: block run-end sync when directional is empty).
Keep hooks in-repo and tested where possible.

**Evidence this will work — the failure it prevents is exactly the one we hit,
and the check is a pure disk read.** This run IS the proof case: three phases
whose SKILL.md instructed a token-capture step, all three stamped empty because
a flag was missing — precisely the "prose asked, LLM didn't do it" class a hook
exists to close. The highest-leverage hook (block run-end/sync when
`tokens_directional.by_model` is empty on a `succeeded` record) is a
deterministic read of a field already on disk — the same predicate Task 2's
anomaly rule uses — so the hook doesn't depend on any new capability, only on
gating an already-observable state. Task 1 makes capture succeed; Task 2 makes
a miss visible after the fact; Task 3 makes a miss impossible to close over in
the first place. They reinforce, and each is testable against the concrete
empty-implement record we already have.

## Verification (all three tasks)

- `cd harness-core && node --test` fully green.
- A dry-run: init-run -> spawn a fixture subagent transcript -> run-end, and
  assert the record on disk has non-empty `by_model` with NO manual backfill.
- `CLI anomalies` flags an artificially-empty directional record.
- Commit on `harness/harness-core`; do not merge to main without review.
