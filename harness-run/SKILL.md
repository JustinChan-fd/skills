---
name: harness-run
description: Conductor and runbook for the full harness pipeline; walks intake → bridge → plan → bridge → implement, gates each stage on confidence, and produces a guardrailed DRAFT PR.
---

# harness-run

> **IMPORTANT — enter via `/harness-run`, not by launching any child `workflow.js` directly.**
> harness-run is a runbook with no `workflow.js` of its own. Its children (`/harness-intake`, `/harness-bridge`, `/harness-plan`, `/harness-implement`) must be fired as skills — their wrappers are what set `startTs`/`skillsCommit`/`runId` and write the telemetry records this run aggregates. A bare Workflow call bypasses every one of those and produces an audit-dark, telemetry-incomplete run.

## Philosophy

**harness-run is the conductor, not a player.** It is an artifact-gated runbook — NOT a JS program that calls skills. It provisions an isolated worktree, then walks the fixed SEQUENCE (`lib/conductor.js`), invoking each child skill **as a skill** (`/harness-intake`, `/harness-plan`, `/harness-implement`) and running `/harness-bridge` between them as a confidence gate. It never launches any `workflow.js` directly. It aggregates every stage's telemetry and, at the end, prints a run summary and a weight-evolution report.

## The Sequence

```
Phase 0  provision worktree (off origin/<base>)
  ↓
harness-intake        → intake-manifest.json
  ↓  harness-bridge (Handoff A)   PROCEED / RE_ASK→refine intake / EXIT
harness-plan          → plan -manifest.json + p1.json
  ↓  harness-bridge (Handoff B)   PROCEED / RE_ASK→refine plan / EXIT
harness-implement     → code + tests
  ↓
guardrailed DRAFT PR + run summary + weight-evolution report
```

## Guardrails (NEVER cross without explicit human approval)

- **Draft PR only.** Push to a `harness/<ISSUE>-<slug>` branch; open a DRAFT PR with **base = the feature branch passed via `--base`** (default `feat/migrate-native-fetch-from-axios` for TARS-1271). NEVER merge, NEVER force-push, NEVER touch main/master.
- **Isolated worktree.** Base off `origin/<base>`; never touch the user's dirty local branches.
- **Fire children as skills.** Never launch a child `workflow.js` directly.
- **Stop on first success.** Once the PR lands + `npm test` green + telemetry flowed, STOP iterating.
- **Spend ceiling.** Hard stop if aggregate cost crosses the run's ceiling (default $500 tonight); stop-on-first-success is the primary brake.
- **NEVER-list categories** (irreversible-destructive, security-auth-permission, cost-over-threshold, public-api-contract, out-of-scope, legal-compliance) are never auto-decided — stop and surface.

## Phase 0 — Provision the worktree

```js
// resolve repoPath (webtarsthree for TARS-1271) and base branch
const base = flags.base || 'feat/migrate-native-fetch-from-axios'
const slug = `${issueKey.toLowerCase()}-e2e`
await Bash(`git -C ${repoPath} fetch origin ${base}`)
await Bash(`git -C ${repoPath} worktree add -b harness/${issueKey}-${runTs} ../wt-${issueKey}-${runTs} origin/${base}`)
// all subsequent child skills run with --repo pointing at the worktree path
```

## Walking the sequence

For each stage in `SEQUENCE` (from `lib/conductor.js`):

1. **Child skill** (intake/plan/implement): invoke as a slash-skill with `--repo <worktreePath>`, capture its manifest path and telemetry record.
2. **Bridge stage**: invoke `/harness-bridge` with the upstream artifact path + `handoff` + `retriesUsed` + current `weightsOverride`. Read `result.verdict`:
   - `actionForVerdict(verdict, retriesUsed).next === 'advance'` → pass `result.gatedPath` to the next child.
   - `=== 'refine'` → re-run the upstream child with `--refine` (passing `result.flags`, `result.probeResults`, and the gated intake path for plan), then re-gate with `retriesUsed: 1`.
   - `=== 'stop'` → halt; print the weak checks + skeptic reasons; do NOT advance.

## Weight agency (tonight only)

The frozen checklist is the jumping-off point. During the run, if a gate is visibly miscalibrated (e.g. it PROCEEDs on a plan that then stalls implement, or EXITs on a plan that is actually fine), harness-run MAY adjust a weight — under these guardrails:

**Override file wiring (do this in the runbook):** before the first gate, read `harness-bridge/weights-override.json`, creating it as `{}` if absent:

```js
let weightsOverride = {}
try { weightsOverride = JSON.parse(await Read('/Users/206618626@bwt3.com/.claude/skills/harness-bridge/weights-override.json')) }
catch { await Write('/Users/206618626@bwt3.com/.claude/skills/harness-bridge/weights-override.json', '{}\n'); weightsOverride = {} }
// shape: { A: {checkId: weight, ...}, B: {checkId: weight, ...} } — pass the per-handoff slice to each bridge call:
//   weightsOverride: (weightsOverride[handoff] && Object.keys(weightsOverride[handoff]).length) ? weightsOverride[handoff] : null
```

Pass that per-handoff slice as the bridge's `weightsOverride` arg (Task 11). To adjust mid-run, compute the new map with `applyWeightChange`, write it back to `weights-override.json` under its handoff key, record a `makeWeightChange({...})` event into the run's `allWeightChanges[]`, and pass it to the next gate call.

- Edit only `harness-bridge/weights-override.json` (the default `weight:` literals in `lib/checks-a.js` / `lib/checks-b.js` are NEVER edited).
- Use `applyWeightChange` semantics: ±15 per adjustment, floor 1, ceiling 60, renormalize to exactly 100.
- Log every change as a `weightChanges[]` event `{handoff, checkId, oldWeight, newWeight, reason, triggeringRunId, ts}` on the bridge telemetry record.
- Adjustments are for tonight's run only and are surfaced in the final report for human review.

## End of run

1. Aggregate all stage records with `assembleRunSummary(records)`; print the summary box.
2. Print `weightEvolutionReport(initialWeights, allWeightChanges)` — initial → final for both handoffs, every change with its reason.
3. If `finalStatus === 'COMPLETE'` and the draft PR landed and `npm test` is green → STOP (first success).

## Getting past a barrier

When you are stuck or unsure on an important, hard-to-reverse decision:

1. **Name the single unknown** that would most change your answer.
2. **Do a quick read-only look** to resolve just that — one shell command, no file writes.
3. **Re-decide.** Repeat at most **twice** (`MAX_PROBE_LOOPS = 2`).

**NEVER-list decisions** (categories below) are never yours to make — stop and surface them regardless of confidence:

| Category | Keywords |
|---|---|
| irreversible-destructive | delete, drop table, force-push, prod deploy, rm -rf, truncate |
| security-auth-permission | auth, permission, credential, secret, token, iam, acl, rbac |
| cost-over-threshold | budget exceed, over budget, cost cap |
| public-api-contract | public api, breaking change, contract change, schema migration |
| out-of-scope | outside scope, unplanned file, not in plan |
| legal-compliance | license, gdpr, compliance, pii |

**After two probes, if still stuck:** record the decision, options, and what you found, then:
- **Blocking** — stop the run and surface to the human; do not proceed.
- **Non-blocking** — proceed under a clearly-labeled default; flag it in the output.

Every barrier event is logged to the audit record (`~/Desktop/Repos/harness-telemetry/v2/`).
