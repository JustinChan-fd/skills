---
name: harness-intake
description: Universal harness entry point. Classifies any ticket or prompt into a typed intake manifest (XS/S/M) or split manifest (L). Always run this before harness-plan. Replaces harness-split.
---

# harness-intake

> **IMPORTANT — invoke via `/harness-intake`, never directly.**
> Running `workflow.js` directly bypasses the SKILL.md wrapper entirely: `startTs`, `skillsCommit`, `runTs`, `runId`, and the post-workflow telemetry patch (subagentTokens, inputTokens, recomputedCost) are all set by the wrapper, not the workflow. (`durationMs` is measured by the workflow itself as of 2026-07-27 — see step 4.) A bare Workflow call produces an incomplete audit record and a mismatched or missing telemetry file. Always enter through the skill.

## Philosophy

**harness-intake is the universal front door for all harness work.**

It answers three questions before any code is touched:
1. What kind of work is this? (migration, feature, bug, refactor, cleanup, non-deployable)
2. What does "done" look like? (AC list — explicit or inferred)
3. How big is it? (XS/S/M → single plan; L → split into subtasks first)

The ticket doesn't need to be well-written. harness-intake infers ACs from a greenfield prompt, a vague description, or a fully-specified spec — it adapts to whatever it receives.

## When to Use

Run `/harness-intake` before every harness-plan invocation. Always.

```
/harness-intake <jira-url>
/harness-intake <jira-url> --repo /path/to/repo
```

## Output

| Size | Output | Next step |
|------|--------|-----------|
| XS/S/M | `intake-manifest.json` — typed work classification + AC list | `/harness-plan --intake <path>` |
| L | `intake-manifest.json` (with `groups[]`) — work classification + split subtasks | `/harness-plan --intake <path> --entry G1-1` per G1 subtask |

The workflow writes the manifest itself, to `{repoPath}/docs/manifests/{repo}__harness-intake__{key}__{runTs}__manifest.json`, and returns the path as `result.intakeManifestPath`.

**No Jira subtasks are created.** An L split produces subtasks addressed by `id` (`G1-1`, `G2-1`, …) that become phased commits on the implementation PR.

## Step-by-Step

### 1. Parse input

Extract from the URL or text:
- `issueKey` — e.g. `TARS-1271` (from URL path segment `[A-Z]+-\d+`)
- `cloudId` — the Jira site hostname, e.g. `fandango.atlassian.net`

For freeform prompts with no URL: set `issueKey = null`, `cloudId = null`.

### 1b. Parse --refine (RE_ASK path)

**`--refine <priorManifestPath>`** — re-research mode, invoked by harness-run after a RE_ASK verdict. Load the prior manifest and the bridge's flags/probeResults, and pass them as `args.refine`. The workflow uses them to target its re-research at the specific weak checks (e.g. `grounding-evidence-fresh` low → re-run the grep with `verifiedCount`; `files-populated` low on an L → re-derive subtask files). This does not change the manifest contract — it produces a better-grounded manifest of the same shape.

Invocation delta:

```js
// when --refine is present:
const refine = {
  flags: bridgeResult.flags || [],
  probeResults: bridgeResult.probeResults || [],
  priorManifestPath,
}
// pass refine into the existing Workflow(...) args object (add `refine` key; default null otherwise)
```

### 2. Resolve repoPath + cloudId

**Check the config first** — it's authoritative and avoids heuristic matching:

```js
const projectConfig = await Bash(
  `node --input-type=module <<'EOF'\nimport { resolveProject } from '/Users/206618626@bwt3.com/Desktop/Repos/skills/config.js'\nconst r = resolveProject('${issueKey}')\nconsole.log(JSON.stringify(r))\nEOF`
).then(r => { try { return JSON.parse(r.trim()) } catch { return null } })

const repoPath = projectConfig?.repoPath ?? null
const cloudId  = projectConfig?.cloudId  ?? 'fandango.atlassian.net'
```

If `projectConfig` is null (project key not in config), fall back to the git-remote scan:

```bash
find ~/Desktop/Repos ~/repos ~/code -maxdepth 2 -name ".git" 2>/dev/null \
  | xargs -I{} dirname {} \
  | while read d; do
      remote=$(git -C "$d" remote get-url origin 2>/dev/null)
      echo "$remote $d"
    done
```

Match the git remote against the Jira project key or repo name. If still ambiguous or not found, ask the user. Once resolved, add the mapping to `~/Desktop/Repos/skills/config.js` so future runs are deterministic.

### 3. Fetch ticket from Jira (if URL provided)

```js
mcp__atlassian__getJiraIssue({
  cloudId,
  issueIdOrKey: issueKey,
  fields: ['summary', 'description', 'issuetype', 'parent', 'project'],
  responseContentFormat: 'markdown',
})
```

Build `input` as `${summary}\n\n${description}`. For freeform prompts, use the prompt directly as `input`.

### 4. Run the workflow

Run the workflow. All metadata (runId, skillsCommit, timestamps) is captured here — the workflow receives them as args and emits them verbatim.

**The workflow writes its own audit record.** Its Debrief phase spawns a `write-telemetry` haiku agent that appends the record and stamps `durationMs` measured from `startTs`. You do not write it and must not re-write it — appending again duplicates the row on the dashboard.

> **Why this moved into the workflow (2026-07-27).** This step used to be `writeAuditTelemetry(result.telemetryPath, result.auditRecord)` right here, i.e. a prose instruction for *you* to run after `Workflow()` returned. Nothing enforced it, so when the context was long or `cliSummary` read like a natural end of turn, it was silently dropped — `harness-implement` never wrote a single record in its entire history, and the one MC-1077 intake record exists only because a human noticed and asked for it. A missing record is indistinguishable from a stage that never ran, which made every telemetry-based conclusion unfalsifiable.

**The workflow also grades the record before writing it.** `_gradeAuditRecord` runs
`_classifyV2Record` over each record and logs one of three verdicts:

| Verdict | Meaning | What to do |
|---|---|---|
| `FULL` | every required field present and measured | nothing |
| `PARTIAL` | the record landed, but a field the dashboard renders is null — it will show a dash | patch the named field, or investigate why it was never measured |
| `STUB` | no `2.0` `schemaVersion`, or fewer keys than the contract requires — the fingerprint of a stage that never ran its own workflow | treat as a failed stage, not a telemetry problem |

The grade is **advisory and never fails a run**: a run that produced working code must not be
failed over thin telemetry. But a `STUB` verdict in the log is a finding — it means the stage
did not execute its own `workflow.js`. That was previously invisible, and it is why two
fabricated TARS-1271 artifacts replayed into fixed code without anything noticing.

What is left for you is **patch-only**: the three fields no workflow script can see, because they live in the `<usage>` block of the Workflow completion notification. `patchTelemetryRecord` is idempotent and `try`-swallowed, so if *this* step is skipped the record is still complete — it just lacks the input/cache split. That is the inversion: the unreliable step now costs three fields instead of the whole record.

```js
// Capture everything before Workflow() — Date.now() is unavailable inside workflow scripts.
const [startTs, skillsCommit, runTs] = await Promise.all([
  Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim()),
  Bash('git -C ~/Desktop/Repos/skills rev-parse HEAD 2>/dev/null || git -C ~/.claude/skills rev-parse HEAD 2>/dev/null || echo unknown').then(r => r.trim()),
  Bash('python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime(\'%Y%m%dT%H%M%SZ\'))"').then(r => r.trim()),
])
// runId: unique per logical run — shared with harness-plan and harness-implement so all 3 records link together.
const runId = `${issueKey || 'intake'}-${runTs}`

// CRASH PATH ONLY. The happy path is written by the workflow's own Debrief agent; this
// exists because a workflow that throws may never have reached Debrief, and a crashed run
// still needs a dashboard row. Called from the catch block, nowhere else.
// No shell escaping needed — JSON.stringify goes to Python via sys.argv, not shell interpolation.
const writeCrashRecord = async (path, record) => {
  if (!path || !record) return
  try {
    const line = JSON.stringify(record).replace(/'/g, "'\\''")
    await Bash(`python3 -c "
import json, sys, os
path, line = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'a') as f:
    f.write(line + '\\n')
" "${path}" '${line}'`)
  } catch (_) {}
}

// Patch fields into the last JSONL line — the <usage> figures only the main agent can see.
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
    scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-intake/workflow.js',
    args: {
      input,
      cloudId: cloudId || null,
      issueKey: issueKey || null,
      repoPath,
      today: currentDate,
      startTs,
      runId,
      runTs,
      skillsCommit,
      refine: refine || null,
    },
  })

  // The workflow wrote its own record in Debrief (write-telemetry agent) and stamped
  // durationMs there. Do NOT append or re-stamp here: a second append duplicates the
  // dashboard row, and a duration measured from *this* point measures how long the main
  // agent took to get around to it — which is precisely the bug that made MC-1077's
  // 239210ms a real measurement of the wrong interval.

  // subagent_tokens from the <usage> block in the completion notification above.
  // inputTokens = subagentTokens - outputTokensTotal (both measured by the workflow runtime).
  const subagentTokens = <usage.subagent_tokens from completion notification>
  const outputTokensTotal = result?.outputTokensTotal ?? null
  const inputTokens = (subagentTokens != null && outputTokensTotal != null)
    ? subagentTokens - outputTokensTotal
    : null

  if (result?.telemetryPath) {
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
    await patchTelemetryRecord(result.telemetryPath, {
      'tokens.total.subagentTokens': subagentTokens,
      'tokens.total.input': inputTokens,
      ...(recomputedCost != null ? { 'cost.rateLockedUsd': recomputedCost } : {}),
      ...(inputTokens != null ? { 'cost.nullReasons.tokens.total.input': null } : {}),
    })
  }

} catch (err) {
  // Workflow crashed — it attaches telemetryPath + auditRecord to the error object.
  // Write the crash record before re-throwing so the dashboard always has an entry.
  const subagentTokens = <usage.subagent_tokens from completion notification, or null if absent>
  await writeCrashRecord(err.telemetryPath, err.auditRecord)
  if (subagentTokens && err.telemetryPath) {
    await patchTelemetryRecord(err.telemetryPath, { 'tokens.total.subagentTokens': subagentTokens })
  }
  throw err
}
```

**Do not search the codebase, read files, grep patterns, or investigate the ticket independently while the workflow runs. Wait for `result` to return.**

### 5. Print cliSummary

Print `result.cliSummary` verbatim.

### 6. The manifest is already written — do not write it again

**The workflow writes its own manifest.** Its Debrief phase spawns a `write-manifest` haiku agent alongside `write-telemetry`, and returns the path it landed at as `result.intakeManifestPath`. Both artifacts of the run are written by the same phase, and the audit record carries `intakeManifestPath` so a dashboard row points at its own manifest.

> **Why this moved into the workflow (2026-07-27).** This step used to hand you a path template and ask you to write `result.intakeManifest` with the Write tool — the same shape as the telemetry append, and the same failure. Losing the manifest is the worse of the two: `harness-plan --intake` reads that exact path and there is no second copy, so the run is stranded rather than merely unaudited. It also produced the fabricated TARS-1271 manifest (`fileCount`, `notes` — keys that exist nowhere in this codebase), because when the write is prose, an agent that cannot find the real artifact improvises a plausible one.

What is left for you: print `result.intakeManifestPath`, and if it is null, say so — the workflow logged the failure and the manifest is still in `result.intakeManifest`, so it can be written by hand as a recovery step rather than lost.

### 7. XS/S/M exit — direct to harness-plan

If `result.splitRequired === false`, the `next:` line of `result.cliSummary` already names the manifest path and the command. Print it and stop.

### 8. L path — quality gate

If `result.splitRequired === true` and `result.qualityIssues.length > 0`:
Surface issues, ask whether to continue or adjust. This is the only gate on the L path.

### 9. L path — print the next commands

There is **no Jira subtask creation and no confirmation gate.** Decomps are phased commits on the PR, so nothing needs creating before planning starts, and there is nothing irreversible to confirm.

> **Why the gate is gone (2026-07-27).** Steps 9–11 used to ask for confirmation, call `createJiraIssue` once per subtask, then inject `jiraKey`/`jiraUrl` into the manifest. That existed to give each subtask an addressable handle for `--entry`. Since decomps land as phased commits rather than Jira issues, the loop minted issues nobody read, and the gate blocked the intake→plan handoff on a human round-trip for a decision with no downside. The handle is now `id` (`G1-1`, `G1-2`, `G2-1`, …), stamped by the workflow — deterministic, stable across a retitle, and legible as a CLI argument.

`result.cliSummary` already contains one ready-to-run command per G1 subtask, with the real manifest path and the real ids. Print it verbatim; do not rewrite it into placeholders.

```
[G1 — independent, can run concurrently]
  /harness-plan --intake <result.intakeManifestPath> --entry G1-1
  /harness-plan --intake <result.intakeManifestPath> --entry G1-2

[G2/G3 — after G1's commits land]
  ... same shape, --entry G2-1 …
```

G1 carries no `dependsOn`, so those commands are runnable immediately. G2/G3 are gated on G1's commits, so they are named but not offered as commands yet.

## Manifest Contracts

### intake-manifest.json
```json
{
  "skill": "harness-intake",
  "sourceIssue": "TARS-1271",
  "sourceTitle": "Phase 5: Client - Migrate client HTTP layer",
  "size": "S",
  "workType": "migration",
  "migrationPattern": "axios → clientFetch",
  "scopePath": "src/client",
  "acList": [
    {
      "bullet": "118 client files migrated to use clientFetch",
      "researchType": "grep",
      "grepPattern": "axios",
      "searchScope": "src/client",
      "shellCommand": ""
    }
  ],
  "files": [],
  "execution": "sequential"
}
```

harness-plan reads this via `--intake` flag and skips its own Intake phase entirely.

### intake-manifest.json — L path (with groups)
Same top-level fields as XS/S/M, plus a `groups[]` array. Each subtask carries `id`, `title`, `description`, `scopePath`, `files[]`, `groupId`, `dependsOn`, `targetSize`, and the propagated `migrationPattern`/`size`. There is no separate split-manifest file.

`id` is the handle `/harness-plan --entry` takes: `G1-1`, `G1-2`, `G2-1` — per-group and 1-based, so `G2-1` reads as "first task of the second wave". It replaced `jiraKey` when Jira subtask creation was removed; nothing mints keys any more, and the only alternative handle was the subtask title, which is long, punctuated, and rewritten whenever the split agent rewords.

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
- **Blocking** — stop and surface; do not proceed.
- **Non-blocking** — proceed under a clearly-labeled default; flag it in the output.

Every barrier event is logged to the audit record (`~/Desktop/Repos/harness-telemetry/v2/`).
