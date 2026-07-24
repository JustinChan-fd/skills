# harness-plan — Decision & Change Log

A running journal of paradigm shifts, key decisions, and bug fixes. Most recent first.

---

## 2026-07-24 — Self-contained durationMs (_workflowStartTs)

**Problem:** `durationMs` in the audit record relied on `args.startTs` being passed by the caller (the SKILL.md harness-intake invocation). This was never guaranteed — if the caller didn't pass it, `durationMs` was null or an epoch overflow.

**Fix:** Added `_workflowStartTs` — a haiku shell agent at the very top of the run captures `time.time()*1000` before any other agents spawn. `durationMs` is computed as `now - _workflowStartTs` at audit-write time. Falls back to `args.startTs` if the capture failed. Added a 36M ms sanity clamp to reject epoch-as-duration overflows.

---

## 2026-07-23 — spec-v8 era: lib/ modules extracted

Phase 1–4 of the spec-v8 plan extracted load-bearing logic into `lib/` for unit testability:

- `lib/dag.js` — `downgradeConflictingGroups(tasks)`: when two tasks share a file, the whole parallel group downgrades to sequential.
- `lib/quality.js` — `failsQualityContract`, `failsThinSpec`, `synthesizeKeyFindings`: the "WHAT / WHERE / HOW + DONE" contract check and quality gates.
- `lib/cost.js` — `COST_RATES`, `rateFor`, `computeCost`: unified cost math (was duplicated 3× inline).
- `lib/models.js` — `MODEL`: model ID constants, eliminating stale hardcoded strings like `claude-opus-4-6-v1`.
- `lib/barrier.js` — `NEVER_LIST`, `matchesNeverList`, `makeBarrierRecord`, `validateBarrierRecord`: the Confidence-Gated Convergence protocol.
- `lib/schemas.js` — shared JSON schemas.

All modules are pure functions with no dependency on Workflow globals (`agent`, `phase`, `log`) so they unit-test with `node --test` and no network.

**PURE block pattern:** Since `import` from `./lib/` resolves at workflow invocation time (confirmed via Phase 0 probe), the modules are imported directly. A mirrored `// ===== PURE (mirrors lib/) =====` block is not needed for harness-plan.

---

## 2026-07-22 — spec-v8 era: latent bug fixes

Bugs discovered during spec-v8 audit but predating it:

- `question: input` → `questions: [input]` (lines 611, 651) — pipeline reads `.questions[]`, not `.question`
- Dead `mergeResearchResults` function deleted (line 307-317)
- Dead `allPlanFiles` variable deleted (line 1149)
- All three cost tables replaced with `import { computeCost }` from `lib/cost.js`
- Model constants unified via `lib/models.js`; SKILL.md model table updated to match code
- `skillsSchemaVersion: 'spec-v8'` and `skillsCommit` added to audit records

---

## Pre-spec-v8 — Original architecture

**Phases:** Intake (parse manifest) → Research (parallel researchers per concern) → Architecture (Opus architect with all findings) → Synthesis (Sonnet synthesizer writes plan doc) → Quality gate (WHAT/WHERE/HOW + DONE contract).

**Known drift at spec-v8 start:**
- Cost math duplicated in 3 places with stale model IDs
- DAG conflict guard untested (load-bearing but no characterization test)
- Quality contract functions inline, not extractable without tests
- `durationMs` / `ts` not emitted (dashboard couldn't plot time trends for harness-plan runs)

**Efficiency baseline (pre-spec-v8):** Opus used for both architect and decomposer phases. spec-v8 Phase 3 evaluated downgrading the decomposer but left it Opus pending quality verification via run-log evidence.
