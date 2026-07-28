---
name: harness-run
description: Conductor and runbook for the full harness pipeline; walks intake → plan → implement with each manifest passed through as ground truth, and produces a guardrailed DRAFT PR.
---

# harness-run

> **IMPORTANT — enter via `/harness-run`, never by launching `workflow.js` directly.**
> The SKILL.md wrapper captures `startTs`, `skillsCommit`, `runTs`, `runId`, `today`, derives `repo`/`worktreeName`/`runBranch`, and fires `Workflow({scriptPath: harness-run/workflow.js})`. A bare Workflow call skips all of that and produces an incomplete run.

## Philosophy

**harness-run is the conductor, not a player.** It provisions an isolated worktree, then walks the fixed sequence — intake → plan → implement — calling each child skill's `workflow.js` directly via the script-level `workflow()` hook. Each stage's token budget stays isolated in its own child workflow, so the main session never accumulates output tokens across stages.

**Manifest-as-gospel.** Each stage's manifest is accepted as ground truth by the next stage. There is no scoring gate between stages, no RE_ASK verdict, and no refine loop. harness-plan already honours `args.gatedIntake` as authoritative for size and file scope (manifest supremacy) — it does not care whether a bridge stamped the manifest, only that one is present.

> **Why no bridge (2026-07-27).** harness-bridge used to gate Handoff A and Handoff B. Its RE_ASK loop death-spiralled — four consecutive refine agents died mid-`Read` — and blocked a run whose whole purpose was a proven happy path to a draft PR. The skill and its `lib/checks-*.js` are untouched on disk. Re-add the gates here behind an opt-in `--gate` flag once the checks-B ↔ harness-plan schema contract is aligned (checks-B expects a single `description` string per task; harness-plan emits flat `what`/`where`/`how`/`done`/`snippets`).

## Why `workflow()`, not `agent()`

Child skills MUST be invoked with the script-level `workflow({scriptPath}, args)` hook:

```js
const intakeResult = await workflow(
  { scriptPath: '.../harness-intake/workflow.js' },
  { input, issueKey, repoPath: worktreePath, ...childTelemetryArgs }
)
```

**Never** spawn an `agent()` whose prompt tells it to call `Workflow` or `/harness-intake`. Subagents cannot nest `Workflow`, so that shape silently never runs the child's `workflow.js` — the subagent instead improvises a hand-written manifest and every per-stage telemetry field comes back null. That was the single root cause of the null DURATION/TOKENS/COST columns in the dashboard for the harness-run era.

Each child workflow **writes its own audit record** from its own Debrief phase (2026-07-27). The conductor no longer appends it — doing both would put the same run on the dashboard twice, since `v2/*.jsonl` is read line-by-line. What the conductor still does is **patch** the two fields only it can measure: wall-clock `durationMs` either side of the `workflow()` call, and that stage's `budget.spent()` delta. See `finalizeStageTelemetry` in `workflow.js`.

If a child returns no audit record, that is now a finding rather than a missing conductor step — it means the child's in-workflow write did not run. The conductor logs it plainly instead of silently filling the gap.

## The Sequence

```
Phase 0  provision worktree (off origin/<base>)
  ↓
harness-intake        → intake manifest (written by the conductor)
  ↓  passed through verbatim as gatedIntake
harness-plan          → plan-manifest.json + p1.json (written by harness-plan)
  ↓  plans[] ordered by dependsOn
harness-implement     → code + tests (once per plan entry)
  ↓
guardrailed DRAFT PR + run summary
```

### Two handoff shapes that bite

**intake → plan.** harness-plan takes *two* inputs off the intake manifest, and they
are not interchangeable:

| Arg | Shape | Role |
|---|---|---|
| `gatedIntake` | the manifest object, verbatim | authoritative size + file scope (manifest supremacy) |
| `input` | **raw prose** | what the sizing agent reads, what the issue-key regex scans, what the plan slug/title come from |

`input` is built by `lib/plan-input.js` from the fields the manifest actually carries
— `sourceTitle`, `groundedReality`, `acList`, `migrationPattern`, `scopePath` —
preferring `groundedReality` (present only for size L, and per its own manifest
comment it outranks the ticket text) and falling back to raw ticket text for XS/S/M,
where `groundedReality` is null by design. The conductor refuses to call harness-plan
with fewer than `MIN_PLAN_INPUT_CHARS` (40) of input rather than let it size off a
bare issue key.

**plan → implement.** Pass each plan entry's **`path`** (the `.md`), not `jsonPath`.
harness-implement derives the JSON companion itself and keeps the markdown as its
fallback when the JSON is missing or malformed; handing it `jsonPath` collapses both
to the same file and that fallback can never fire. Use `planPathFor(plan)`. The path
stays repo-relative — implement joins it onto `repoPath` itself.

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
const [startTs, skillsCommit, runTs, today] = await Promise.all([
  Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim()),
  Bash('git -C ~/Desktop/Repos/skills rev-parse HEAD 2>/dev/null || echo unknown').then(r => r.trim()),
  Bash('python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime(\'%Y%m%dT%H%M%SZ\'))"').then(r => r.trim()),
  Bash('python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime(\'%Y-%m-%d\'))"').then(r => r.trim()),
])
const runId = `${issueKey}-${runTs}`

const result = await Workflow({
  scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-run/workflow.js',
  args: {
    issueKey,
    repoPath,          // the REAL repo — the workflow derives the worktree path from it
    baseBranch,
    runTs,
    runId,
    today,             // calendar date; every child telemetry record's `ts`
    skillsCommit,
    startTs,
    cloudId:          cloudId || 'fandango.atlassian.net',
    parentRunId:      parentRunId || null,
    resumeFromState:  resumeFromState || null,
  },
})
```

`today` is required — the workflow throws without it. It is what lands in each child record's `ts` field (a calendar date per the telemetry-v2 schema); `runTs` is the compact stamp used in filenames and is only a fallback.

Do NOT pass `repo` — the workflow derives the canonical repo name from `repoPath` and forwards it to every child as `repoName`, so child telemetry says `webtarsthree` rather than the worktree directory name.

After Workflow returns, print `result.summaryBox` verbatim.

If `result.finalStatus === 'FAILED'`, print `result.exitPhase` and the failing stage record clearly — the worktree is left in place for inspection, and no PR was opened.

If `result.stateFilePath` is set, print:
```
Run state saved to: <result.stateFilePath>
To resume: /harness-run <issueKey> --repo <repoPath> --base <baseBranch> --resume <result.stateFilePath>
To continue as new run: /harness-run <issueKey> --repo <repoPath> --base <baseBranch> --parent <result.runId>
```

## Telemetry

One record per stage in `~/Desktop/Repos/harness-telemetry/v2/`, named
`{repo}__{skill}__{ticket}__{runTs}.jsonl`. Those per-stage records are authoritative; harness-run writes no record of its own — the run summary is printed from `result.summaryBox`.

Because the conductor calls child `workflow.js` files directly, it does what each child's SKILL.md wrapper would otherwise do:

| Field | Who sets it | How |
|---|---|---|
| `repo` | conductor → child `repoName` | canonical repo name, not the worktree dir |
| `ts` | conductor → child `today` | calendar date (`2026-07-27`) |
| `runId` / `parentRunId` | conductor | shared across all stages, so records link |
| `durationMs` | child, then conductor | the child's write agent measures it from the stage `startTs` the conductor passes down; the conductor then patches its own tighter stamp over the top |
| `tokens.total.output` | conductor | `budget.spent()` delta around the call |
| `status` / `outcome` | child workflow | lifecycle value, and the derived `success`/`partial`/`failed` |
| the record itself | child workflow | appended by the child's Debrief `write-telemetry` agent — never by the conductor |

`status` and `outcome` are separate axes and must not be conflated — `assembleRunSummary` reads `outcome` only and never falls back to `status`.

Still unmeasured per stage: `tokens.total.subagentTokens`, `input`, and the cache split. Those come from the `<usage>` block of a `Workflow` completion notification, which the conductor does not see for a nested `workflow()` call. They are recoverable after the fact from the run's `agent-*.jsonl` transcripts.

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
