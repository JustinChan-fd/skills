---
name: harness-run
description: Conductor and runbook for the full harness pipeline; walks intake → bridge → plan → bridge → implement, gates each stage on confidence, and produces a guardrailed DRAFT PR.
---

# harness-run

> **IMPORTANT — enter via `/harness-run`, never by launching `workflow.js` directly.**
> The SKILL.md wrapper captures `startTs`, `skillsCommit`, `runTs`, `runId`, derives `repo`/`worktreeName`/`runBranch`, reads `weights-override.json`, loads `initialWeights`, and fires `Workflow({scriptPath: harness-run/workflow.js})`. A bare Workflow call skips all of that and produces an incomplete run with no weight-evolution report.

## Philosophy

**harness-run is the conductor, not a player.** It provisions an isolated worktree, then walks the fixed sequence — intake → bridge-A → plan → bridge-B → implement — with each stage running as an `agent()` call inside the conductor workflow. This keeps every stage's token budget isolated in its own subagent, preventing the main session from accumulating output tokens across all stages.

## The Sequence

```
Phase 0  provision worktree (off origin/<base>)
  ↓
harness-intake        → intake-manifest.json
  ↓  harness-bridge (Handoff A)   PROCEED / RE_ASK→refine intake / EXIT
harness-plan          → plan-manifest.json + p1.json
  ↓  harness-bridge (Handoff B)   PROCEED / RE_ASK→refine plan / EXIT
harness-implement     → code + tests
  ↓
guardrailed DRAFT PR + run summary + weight-evolution report
```

## Parsing the invocation

```js
const issueKey    = argv[0]                                        // e.g. 'TARS-1271'
const repoPath    = flags.repo    || null                          // e.g. '/Users/.../webtarsthree'
const baseBranch  = flags.base    || 'feat/migrate-native-fetch-from-axios'
const resumePath  = flags.resume  || null                          // path to a __run-state.json file
const parentRunId = flags.parent  || null                          // runId of the original run
```

`repoPath` must not be null — STOP and surface if omitted.
`baseBranch` must not be empty — STOP if unset; never let it default to main/master.

### Resume mode (`--resume <stateFilePath>`)

When `--resume` is passed, read the checkpoint and validate it before firing the workflow:

```js
let resumeFromState = null
if (resumePath) {
  resumeFromState = JSON.parse(await Read(resumePath))
  // Validate that all listed artifact paths still exist on disk
  const missing = []
  for (const [k, v] of Object.entries(resumeFromState.artifacts || {})) {
    if (v) {
      const exists = await Bash(`test -f "${v}" && echo ok || echo missing`).then(r => r.trim())
      if (exists !== 'ok') missing.push(`${k}: ${v}`)
    }
  }
  if (missing.length) {
    // Surface missing artifacts — user must fix before resuming
    throw new Error(`Resume validation failed — these artifacts are missing:\n${missing.join('\n')}\nFix the missing files or start a new run with --parent ${resumeFromState.runId}`)
  }
  // Carry forward runTs/runId from the checkpoint so the resumed run shares the same IDs
  // (All new telemetry records will carry the same runId, linking them to the original run)
}
```

Pass `resumeFromState` and `parentRunId` into the Workflow args.

### Continuation mode (`--parent <runId>`)

When `--parent` is passed (without `--resume`), this is a fresh run that acknowledges it continues prior work. All records emitted in this run will carry `parentRunId` in their telemetry, allowing cost aggregation across the full logical run.

```js
// parentRunId flows into workflow args → every _buildV2Record carries it
```

## Guardrails (NEVER cross without explicit human approval)

- **Draft PR only.** Push to `harness/<ISSUE>-<runTs>`; open DRAFT PR with **base = `baseBranch`**. NEVER merge, NEVER force-push, NEVER touch main/master.
- **Isolated worktree.** Base off `origin/<base>`; never touch dirty local branches.
- **Stop on first success.** Once PR lands + `npm test` green + telemetry flowed, STOP.
- **Spend ceiling.** Hard stop if aggregate cost crosses the run ceiling (default $500).
- **NEVER-list categories** (irreversible-destructive, security-auth-permission, cost-over-threshold, public-api-contract, out-of-scope, legal-compliance) — never auto-decide, stop and surface.

## How the wrapper fires the workflow

```js
const [startTs, skillsCommit, runTs] = await Promise.all([
  Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim()),
  Bash('git -C ~/Desktop/Repos/skills rev-parse HEAD 2>/dev/null || echo unknown').then(r => r.trim()),
  Bash('python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime(\'%Y%m%dT%H%M%SZ\'))"').then(r => r.trim()),
])
const runId = `${issueKey}-${runTs}`

// repo: canonical name (e.g. 'webtarsthree') — from repoPath, NOT the worktree dir
const repo = repoPath.split('/').pop()

// Read weights-override.json for tonight's adjustments
let weightsOverride = {}
try {
  weightsOverride = JSON.parse(await Read('/Users/206618626@bwt3.com/.claude/skills/harness-bridge/weights-override.json'))
} catch {
  await Write('/Users/206618626@bwt3.com/.claude/skills/harness-bridge/weights-override.json', '{}\n')
  weightsOverride = {}
}

// Load initial weights for the weight-evolution report
const initialWeights = JSON.parse(await Bash(`node --input-type=module -e "
import { loadWeights } from '/Users/206618626@bwt3.com/.claude/skills/harness-bridge/lib/weights.js'
import { CHECKS_A } from '/Users/206618626@bwt3.com/.claude/skills/harness-bridge/lib/checks-a.js'
import { CHECKS_B } from '/Users/206618626@bwt3.com/.claude/skills/harness-bridge/lib/checks-b.js'
console.log(JSON.stringify({ A: loadWeights(CHECKS_A, null), B: loadWeights(CHECKS_B, null) }))
"`).then(r => r.trim()))

const result = await Workflow({
  scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-run/workflow.js',
  args: {
    issueKey,
    repoPath,
    baseBranch,
    homeDir: '/Users/206618626@bwt3.com',
    repo,
    runTs,
    runId,
    skillsCommit,
    startTs,
    weightsOverride,
    initialWeights,
    parentRunId:      parentRunId || null,
    resumeFromState:  resumeFromState || null,
  },
})
```

After Workflow returns, print `result.summaryBox` and `result.weightReport` verbatim.

If `result.finalStatus === 'EXIT'`, print the exit phase, flags, and skeptic reasons clearly — do NOT advance.

If `result.stateFilePath` is set, print:
```
Run state saved to: <result.stateFilePath>
To resume: /harness-run <issueKey> --repo <repoPath> --base <baseBranch> --resume <result.stateFilePath>
To continue as new run: /harness-run <issueKey> --repo <repoPath> --base <baseBranch> --parent <result.runId>
```

## Weight agency

Before the first bridge call, the workflow reads `weightsOverride` from the wrapper args. To adjust mid-run: compute the new map with `applyWeightChange` semantics (±15 per check, floor 1, ceiling 60, renormalize to 100), write it back to `weights-override.json` under its handoff key, and pass updated `weightsOverride` to the next bridge call. All changes surface in the final `weightEvolutionReport`.

## Telemetry

Each child skill writes its own telemetry record independently. harness-run does not write a separate telemetry record — the run summary is printed from `result.summaryBox`. The individual records in `~/Desktop/Repos/harness-telemetry/v2/` are the authoritative per-stage records.

## Getting past a barrier

**NEVER-list decisions** are never auto-decided — stop and surface:

| Category | Keywords |
|---|---|
| irreversible-destructive | delete, drop table, force-push, prod deploy, rm -rf, truncate |
| security-auth-permission | auth, permission, credential, secret, token, iam, acl, rbac |
| cost-over-threshold | budget exceed, over budget, cost cap |
| public-api-contract | public api, breaking change, contract change, schema migration |
| out-of-scope | outside scope, unplanned file, not in plan |
| legal-compliance | license, gdpr, compliance, pii |
