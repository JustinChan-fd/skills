---
name: harness-plan
description: Use when you have a Jira ticket, freeform description, or rough notes and need a committed plan file ready for harness-implement. Produces docs/plans/YYYY-MM-DD-<key>-p1.md + manifest. Human approves before implement runs.
---

# harness-plan

## Mental Model: Manager Workflow vs Dev Team

**harness-plan is the manager workflow. harness-implement is the dev team.**

The manager's job is to make sure every decision is made, every ambiguity resolved, and every task fully specified before a single line of code is written. The dev team reads one plan and executes — they never explore, never ask questions, never fill in gaps.

**If implement stalls with `NEEDS_CONTEXT`, the plan failed. Go back to harness-plan.**

## Model Tier Allocation

| Tier | Models | Used for |
|------|--------|----------|
| **Worker bee** | Haiku | File writes, git commits, audit log — pure execution |
| **Worker bee** | Sonnet | Decompose, research, security, gap-fills, architect (XS/S/M), architect revisions, synthesize, coverage check, coverage patches |
| **Final say** | Opus | Architect for L only — large decomposed input still needs deep DAG judgment |

**Coverage is Sonnet** — it's a structured completeness check on the written plan (compare requirements against output), not deep reasoning.  
**Architect is Sonnet for XS/S/M** — after decomposition, even L inputs arrive as bounded M/S research bundles; Opus fires rarely and only when the architect sees a large merged research object.

## Output Format — Manifest Contract

Every run produces three files, regardless of size:

```
docs/plans/YYYY-MM-DD-<slug>-p1.md       ← human-readable plan
docs/plans/YYYY-MM-DD-<slug>-p1.json     ← harness-implement reads this
docs/plans/YYYY-MM-DD-<slug>-manifest.json  ← orchestration
```

**Manifest schema** (same shape for all sizes):
```json
{
  "title": "string",
  "size": "XS|S|M|L",
  "execution": "sequential|parallel|mixed",
  "plans": [
    {
      "id": "p1",
      "path": "docs/plans/YYYY-MM-DD-<slug>-p1.md",
      "jsonPath": "docs/plans/YYYY-MM-DD-<slug>-p1.json",
      "dependsOn": []
    }
  ]
}
```

XS/S/M → `plans` array length 1, `execution: "sequential"`.  
L (independent concerns) → N entries, `execution: "parallel"`.  
L (interdependent) → N entries with `dependsOn` wiring, `execution: "sequential"` or `"mixed"`.

**harness-implement never reads the manifest.** It receives one `jsonPath` and executes it. The manifest is for the human today, `loop:run` tomorrow.

## Philosophy: When In Doubt, Break It Down

**Always prefer smaller over larger.** A concern that is too small costs one extra researcher agent. A concern that is too large produces an oversized plan that stalls implement. The cost of splitting is low and predictable. The cost of a stalled implement run is high and unpredictable.

This applies at every level:
- **Sizing:** when between two sizes, choose the larger — it triggers decompose
- **Decompose:** when a concern feels borderline M, split it into two S concerns
- **Architect:** when a task covers more than 3 files, consider splitting it

## Philosophy: Think Here, Not There

**harness-plan does the thinking. harness-implement does the typing.**

Every question the developer might ask must be answered in the plan before implement runs. The developer never reads files, explores the codebase, or fills in gaps — if the description is incomplete, implement returns `NEEDS_CONTEXT` and stalls. That stall is always a plan failure, never an implement failure.

Concretely:
- Task descriptions embed inline code snippets — not just `file:line` anchors
- Each TDD task covers at most 3 exported functions
- Acceptance criteria are literal test assertions, not prose
- Every `WHERE` names exact file path + function + line range
- Every `HOW` shows the actual code to mirror, inline

## How to Invoke

```
/harness-plan
/harness-plan --grill-me                          # force Q&A regardless of size
/harness-plan --forceplan                         # run full pipeline even for XS tickets
/harness-plan --manifest path/to/split-manifest.json --entry TARS-1275
                                                  # consume a harness-split subtask entry
```

### Parsing flags

When the user invokes `/harness-plan [url] [flags]`:

1. **`--grill-me`** — set `qaMode: true`, run grill-me Q&A before workflow.
2. **`--forceplan`** — pass `forceplan: true` to workflow args; skips the XS fast path.
3. **`--manifest <path> --entry <jiraKey>`** — read `splitManifestPath` from disk, find the subtask with `jiraKey` in `groups[*].subtasks[*]`, pass it as `manifestEntry` to workflow args. The `input` arg becomes the subtask's `description` field.

Example invocation with manifest entry:
```js
const splitManifest = JSON.parse(fs.readFileSync(splitManifestPath, 'utf8'))
const subtask = splitManifest.groups
  .flatMap(g => g.subtasks)
  .find(s => s.jiraKey === entryKey)

// Stitch top-level groundedReality into the subtask so the workflow researcher gets it
const manifestEntry = {
  ...subtask,
  groundedReality: subtask.groundedReality || splitManifest.groundedReality || null,
  migrationPattern: subtask.migrationPattern || splitManifest.migrationPattern || null,
}

const startTs = await Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim())
const result = await Workflow({
  scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-plan/workflow.js',
  args: {
    input: manifestEntry.description,
    repoPath,
    today: currentDate,
    manifestEntry,
    forceplan: false,
    startTs,
  },
})
```

## Mode Routing

Sizing is determined by the Intake phase inside the workflow — the assistant does not pre-size.

| Mode | Trigger | What happens |
|------|---------|--------------|
| **Auto** | Intake returns XS/S + no ambiguity | Workflow fires immediately |
| **XS fast path** | Intake returns XS + no `--forceplan` | Skip Research→Coverage, write minimal plan directly |
| **Manifest entry** | `--manifest` flag or `manifestEntry` arg | Skip Intake + Decompose, inject files/scopePath/pattern |
| **Confirm** | Intake returns M, or any ambiguity | One approval gate before commit |
| **Grill me** | Intake returns L, or `--grill-me` flag | Q&A first, then workflow fires |

## Flow

```
Decompose (L only) — Sonnet
  split into N M/S concerns (sprint planning: nothing L-sized through)
  XS/S/M: single concern, skip

Research — Sonnet, parallel fan-out
  one researcher per concern + security always its own agent
  [fan-in] → mergedResearch

Architect — Opus (L) / Sonnet (XS/S/M)
  builds scope + DAG task list from mergedResearch
  flags open questions / ambiguities

  ┌─ Revision loop (max 2, Sonnet) ──────────────────────────┐
  │  inline check: tasks missing WHAT/WHERE/HOW/DONE/snippet? │
  │  yes → Sonnet revises failing tasks only (delta, not full) │
  │  no  → exit loop                                          │
  └───────────────────────────────────────────────────────────┘

Synthesize — Sonnet
  formats architect output into canonical plan doc (pure formatting)

Coverage — Sonnet  ← final verification gate
  reads WRITTEN PLAN against original ask
  "does what we wrote cover what was asked?"

  ┌─ Round N (max 2) ─────────────────────────────────────────┐
  │  covered? → exit loop ✓                                   │
  │  gaps found? →                                            │
  │    reuse mergedResearch if info already known (no re-read) │
  │    spawn Sonnet gap-fill researcher only if truly missing  │
  │    patch affected plan sections only (no full re-synth)   │
  │    round < MAX? → re-check                                │
  └───────────────────────────────────────────────────────────┘

Return — Haiku
  write plan .md + companion .json + manifest
  commit all three

Debrief — Haiku + inline
  audit log, quality check (WHAT/WHERE/HOW/DONE),
  CLI summary box with manifest path
```

Invoke using the skill's own `workflow.js`:
```js
const startTs = await Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim())
const result = await Workflow({
  scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-plan/workflow.js',
  args: {
    input,
    repoPath,
    today: currentDate,
    manifestEntry: manifestEntry || null,
    forceplan: forcePlan || false,
    startTs,
  },
})
```

Do NOT pass `size` — the workflow sizes the ticket internally via the Intake phase (or reads it from `manifestEntry.size` on the fast path).

After workflow completes, run this backup audit immediately — no-op if internal write succeeded, safety net if it silently failed:

```js
const auditBackup = JSON.stringify({
  ts: currentDate, skill: 'harness-plan', status: result.status || 'COMPLETE',
  planSlug: result.planEntries?.[0]?.planKey || 'unknown',
  planCount: result.planEntries?.length || 0,
  taskCount: result.allTasks?.length || 0,
  backup: true,
})
await Bash(`grep -q '"backup":true' ~/.claude/harness-plan-runs.jsonl 2>/dev/null || echo '${auditBackup.replace(/'/g, "'\\''")}' >> ~/.claude/harness-plan-runs.jsonl`)
```

Then print `result.cliSummary` verbatim, then:

> "Plan ready. Does the scope and task breakdown look right before I hand this to implement?"

Once approved:
```
/harness-implement docs/plans/YYYY-MM-DD-<slug>-p1.json
```

## What a Good Task Description Contains

1. **What** — exact change in concrete terms
2. **Where** — exact file path + function/line range
3. **How** — named pattern with inline code snippet (3-5 lines, not a file:line ref)
4. **Done** — literal test assertion (when tddRequired is true)

Missing any of these → `NEEDS_CONTEXT` from the developer.

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
- **Blocking** — stop and surface (return `PROPOSED_WITH_GAPS`); do not proceed.
- **Non-blocking** — proceed under a clearly-labeled default; flag it in the output.

Every barrier event is logged to the audit record (`~/.claude/harness-plan-runs.jsonl`).
