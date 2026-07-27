---
name: harness-plan
description: Use when you have a Jira ticket, freeform description, or rough notes and need a committed plan file ready for harness-implement. Produces docs/manifests/YYYY-MM-DD-<key>-p1.md + manifest. Human approves before implement runs.
---

# harness-plan

> **IMPORTANT — invoke via `/harness-plan`, never directly.**
> Running `workflow.js` directly bypasses the SKILL.md wrapper entirely: `startTs`, `skillsCommit`, `runTs`, `runId`, and the post-workflow telemetry patch (subagentTokens, inputTokens, durationMs, recomputedCost) are all set by the wrapper, not the workflow. A bare Workflow call produces an incomplete audit record and a mismatched or missing telemetry file. Always enter through the skill.

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
docs/manifests/YYYY-MM-DD-<slug>-p1.md       ← human-readable plan
docs/manifests/YYYY-MM-DD-<slug>-p1.json     ← harness-implement reads this
docs/manifests/YYYY-MM-DD-<slug>-manifest.json  ← orchestration
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
      "path": "docs/manifests/YYYY-MM-DD-<slug>-p1.md",
      "jsonPath": "docs/manifests/YYYY-MM-DD-<slug>-p1.json",
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
/harness-plan --intake path/to/intake-manifest-gated.json
                                                  # non-refine path with gate-A gated manifest (manifest supremacy)
/harness-plan --refine path/to/prior-plan-manifest.json
                                                  # re-plan after Handoff-B RE_ASK (manifest supremacy)
```

### Parsing flags

When the user invokes `/harness-plan [url] [flags]`:

1. **`--grill-me`** — set `qaMode: true`, run grill-me Q&A before workflow.
2. **`--forceplan`** — pass `forceplan: true` to workflow args; skips the XS fast path.
3. **`--manifest <path> --entry <jiraKey>`** — read `splitManifestPath` from disk, find the subtask with `jiraKey` in `groups[*].subtasks[*]`, pass it as `manifestEntry` to workflow args. The `input` arg becomes the subtask's `description` field.
4. **`--intake <gatedIntakeManifestPath>`** — the **PROCEED output of harness-bridge Handoff A**. Read the gated intake manifest from disk and pass the parsed object as `args.gatedIntake`. This flag makes the gated manifest authoritative over the ticket text for size, file scope, and AC list (**manifest supremacy**). Does NOT require `--entry` and does NOT skip Intake — the normal Intake phase still runs but receives the gated manifest's verified numbers as ground truth, overriding any file count or size the ticket text claims. `--intake` and `--refine` may both be present (a refine pass also carries the same gated intake); when both are set, pass both.

   ```js
   // Read gatedIntake when --intake (or --refine with a gatedIntakePath) is set
   const gatedIntake = intakePath || refinePayload?.gatedIntakePath
     ? JSON.parse(await Read(intakePath || refinePayload.gatedIntakePath))
     : null
   ```

5. **`--refine <priorPlanManifestPath>`** — re-plan mode after a Handoff-B RE_ASK. Loads the prior plan manifest + the bridge flags/probeResults, and (critically) the **gated intake manifest** (`*-intake-manifest-gated.json`). The architect re-sizes and re-specifies tasks treating the gated manifest as ground truth — if the ticket says "118 files" but the gated manifest verified 92, the plan uses 92. This is **manifest supremacy**: a gated manifest outranks the ticket.

   When `--refine` is present, the SKILL wrapper reads the gated intake manifest and passes it as `args.gatedIntake`:
   ```js
   // Only read gatedIntake when --refine is set (legacy path; prefer --intake for non-refine)
   const gatedIntake = refinePayload?.gatedIntakePath
     ? JSON.parse(await Read(refinePayload.gatedIntakePath))
     : null
   ```

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

const [startTs, skillsCommit, runTs] = await Promise.all([
  Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim()),
  Bash('git -C ~/Desktop/Repos/skills rev-parse HEAD 2>/dev/null || git -C ~/.claude/skills rev-parse HEAD 2>/dev/null || echo unknown').then(r => r.trim()),
  Bash('python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime(\'%Y%m%dT%H%M%SZ\'))"').then(r => r.trim()),
])
const runId = `${entryKey || 'plan'}-${runTs}`

const result = await Workflow({
  scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-plan/workflow.js',
  args: {
    input: manifestEntry.description,
    repoPath,
    today: currentDate,
    manifestEntry,
    forceplan: false,
    startTs,
    runId,
    runTs,
    skillsCommit,
    refine: refinePayload || null,       // { flags, probeResults, priorPlanManifestPath, gatedIntakePath } | null
    gatedIntake: gatedIntake || null,    // parsed gated intake manifest; set by --intake OR --refine (manifest supremacy)
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
// Capture metadata before Workflow() — Date.now() is unavailable inside workflow scripts.
const [startTs, skillsCommit, runTs] = await Promise.all([
  Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim()),
  Bash('git -C ~/Desktop/Repos/skills rev-parse HEAD 2>/dev/null || git -C ~/.claude/skills rev-parse HEAD 2>/dev/null || echo unknown').then(r => r.trim()),
  Bash('python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime(\'%Y%m%dT%H%M%SZ\'))"').then(r => r.trim()),
])
const runId = `${issueKey || 'plan'}-${runTs}`

// Write audit record(s) — workflow returns them as plain JS objects, no shell escaping needed.
// harness-plan may return multiple records (barrier events + final status), all appended in order.
const writeAuditTelemetry = async (path, records) => {
  if (!path || !records?.length) return
  try {
    const lines = records.map(r => JSON.stringify(r).replace(/'/g, "'\\''"))
    for (const line of lines) {
      await Bash(`python3 -c "
import json, sys, os
path, line = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'a') as f:
    f.write(line + '\\n')
" "${path}" '${line}'`)
    }
  } catch (_) {}
}

const patchTelemetryRecord = async (path, fields) => {
  try {
    const fieldJson = JSON.stringify(fields).replace(/'/g, "'\\''")
    await Bash(`python3 -c "
import json, sys

def set_nested(d, dotted_key, value):
    keys = dotted_key.split('.')
    for k in keys[:-1]:
        if k not in d or not isinstance(d[k], dict):
            d[k] = {}
        d = d[k]
    if value is None:
        d.pop(keys[-1], None)
    else:
        d[keys[-1]] = value

path, fields_json = sys.argv[1], sys.argv[2]
fields = json.loads(fields_json)
lines = open(path).readlines()
if lines:
    last = json.loads(lines[-1])
    for k, v in fields.items():
        if '.' in k:
            set_nested(last, k, v)
        else:
            last[k] = v
    lines[-1] = json.dumps(last)
    open(path, 'w').writelines([l + ('\\n' if not l.endswith('\\n') else '') for l in lines])
" "${path}" '${fieldJson}'`)
  } catch (_) {}
}

let result
try {
  result = await Workflow({
    scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-plan/workflow.js',
    args: {
      input,
      repoPath,
      today: currentDate,
      manifestEntry: manifestEntry || null,
      forceplan: forcePlan || false,
      startTs,
      runId,
      runTs,
      skillsCommit,
    },
  })

  // Write all audit records (barrier events + final status record).
  await writeAuditTelemetry(result?.telemetryPath, result?.auditRecords)

  const endTs = parseInt(await Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim()), 10)
  const durationMs = endTs - parseInt(startTs, 10)
  const subagentTokens = <usage.subagent_tokens from completion notification>
  const outputTokensTotal = result?.outputTokensTotal ?? null
  const inputTokens = (subagentTokens != null && outputTokensTotal != null) ? subagentTokens - outputTokensTotal : null

  let recomputedCost = null
  if (inputTokens != null && outputTokensTotal != null && result?.agentCountByModel) {
    const entries = Object.entries(result.agentCountByModel)
    const totalAgents = entries.reduce((s, [, c]) => s + c, 0)
    if (totalAgents > 0) {
      const rate = m => m.includes('opus') ? {in:5,out:25} : m.includes('haiku') ? {in:1,out:5} : {in:3,out:15}
      const bIn  = entries.reduce((s,[m,c]) => s + rate(m).in  * (c/totalAgents), 0)
      const bOut = entries.reduce((s,[m,c]) => s + rate(m).out * (c/totalAgents), 0)
      recomputedCost = parseFloat(((inputTokens/1e6)*bIn + (outputTokensTotal/1e6)*bOut).toFixed(4))
    }
  }
  if (result?.telemetryPath) {
    await patchTelemetryRecord(result.telemetryPath, {
      durationMs,
      'tokens.total.subagentTokens': subagentTokens,
      'tokens.total.input': inputTokens,
      ...(recomputedCost != null ? { 'cost.rateLockedUsd': recomputedCost } : {}),
      ...(inputTokens != null ? { 'cost.nullReasons.tokens.total.input': null } : {}),
    })
  }

} catch (err) {
  const subagentTokens = <usage.subagent_tokens from completion notification, or null if absent>
  await writeAuditTelemetry(err.telemetryPath, err.auditRecords)
  if (subagentTokens && err.telemetryPath) {
    await patchTelemetryRecord(err.telemetryPath, { 'tokens.total.subagentTokens': subagentTokens })
  }
  throw err
}
```

Do NOT pass `size` — the workflow sizes the ticket internally via the Intake phase (or reads it from `manifestEntry.size` on the fast path).

Then print `result.cliSummary` verbatim, then:

> "Plan ready. Does the scope and task breakdown look right before I hand this to implement?"

Once approved:
```
/harness-implement docs/manifests/YYYY-MM-DD-<slug>-p1.json
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

Every barrier event is logged to the audit record (`~/Desktop/Repos/harness-telemetry/v2/`).
