# harness-implement — Decision & Change Log

A running journal of paradigm shifts, key decisions, and bug fixes. Most recent first.

---

## 2026-07-24 — Self-contained durationMs (_workflowStartTs)

**Problem:** Same as harness-plan — `durationMs` relied on `args.startTs` from the caller, which was never guaranteed. The dashboard couldn't plot time trends for implement runs.

**Fix:** Identical pattern to harness-plan — `_workflowStartTs` haiku capture at run start, `await _startTsPromise` before computing delta, 36M ms sanity clamp.

---

## 2026-07-23 — spec-v8 era: lib/ modules extracted

Same phase-by-phase lib/ extraction as harness-plan:

- `lib/dag.js` — `downgradeConflictingGroups(tasks)`: shared fixture test asserts identical output to harness-plan's copy (the canonical cross-skill consistency check).
- `lib/diff.js` — `splitDiffByFile`, `splitFileIntoChunks`: diff chunking logic for large file diffs. Header re-attached to every chunk; never splits mid-hunk; `maxLines=300` threshold; oversized single hunk passes whole.
- `lib/cost.js` — same as harness-plan.
- `lib/models.js` — same as harness-plan.
- `lib/barrier.js` — same as harness-plan.
- `lib/schemas.js` — shared JSON schemas.

---

## 2026-07-22 — spec-v8 era: latent bug fixes

Bugs discovered during spec-v8 audit:

- `totalRedispatches` variable and its dead reporting branch removed (line 869, 1020, 886, 1003, 1093, 1132) — the redispatch mechanism was never triggered in any run
- Dead `PASS_WITH_CONCERNS` branch deleted (line 601)
- Always-empty local `blocked` no-op removed (lines 569, 578)
- Unused `tddRedOutput` capture removed (lines 470, 574) — red/green comparison was never wired
- `skillsSchemaVersion: 'spec-v8'` and `skillsCommit` added to audit records

---

## Pre-spec-v8 — Original architecture

**Phases:** Parse plan → TDD loop per task (failing test → implement → verify) → QA gate → audit.

**TDD contract:** Each task must produce evidence of a failing test before implementation. The `hi-developer` subagent type enforces this. `hi-qa` verifies TDD was actually followed and all ACs are covered by named tests.

**Known drift at spec-v8 start:**
- `totalRedispatches` plumbing existed but the triggering condition was never met — dead code accumulating
- `PASS_WITH_CONCERNS` branch never reached in practice
- `durationMs` / `ts` not emitted (same gap as harness-plan)
- Cost math duplicated inline; model IDs stale

**Diff splitter rationale:** Large files produce diffs that exceed model context. `splitDiffByFile` keeps each file's diff as a unit; `splitFileIntoChunks` further splits within a file at 300-line boundaries while never splitting a hunk. The "oversized single hunk passes whole" rule is intentional — splitting mid-hunk produces an unreadable partial diff that's worse than a long one.
