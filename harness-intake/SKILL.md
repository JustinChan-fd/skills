---
name: harness-intake
description: Universal harness entry point. Classifies any ticket or prompt into a typed intake manifest (XS/S/M) or split manifest (L). Always run this before harness-plan. Replaces harness-split.
---

# harness-intake

> **IMPORTANT — invoke via `/harness-intake`, never directly.**
> Running `workflow.js` directly bypasses the SKILL.md wrapper entirely: `startTs`, `skillsCommit`, `runTs`, `runId`, and the post-workflow telemetry patch (subagentTokens, inputTokens, durationMs, recomputedCost) are all set by the wrapper, not the workflow. A bare Workflow call produces an incomplete audit record and a mismatched or missing telemetry file. Always enter through the skill.

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
| L | `intake-manifest.json` (with `groups[]`) — work classification + split subtasks | `/harness-plan --intake <path>` on each G1 subtask |

The manifest is written to `{repoPath}/docs/manifests/`.

## Step-by-Step

### 1. Parse input

Extract from the URL or text:
- `issueKey` — e.g. `TARS-1271` (from URL path segment `[A-Z]+-\d+`)
- `cloudId` — the Jira site hostname, e.g. `fandango.atlassian.net`

For freeform prompts with no URL: set `issueKey = null`, `cloudId = null`.

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

Run the workflow. All metadata (runId, skillsCommit, timestamps) is captured here — the workflow receives them as args and emits them verbatim. After completion, patch the telemetry file with `subagentTokens` and `inputTokens` so cost can be computed accurately. `usage.subagent_tokens` is in the `<usage>` block of the Workflow completion notification.

```js
// Capture everything before Workflow() — Date.now() is unavailable inside workflow scripts.
const [startTs, skillsCommit, runTs] = await Promise.all([
  Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim()),
  Bash('git -C ~/Desktop/Repos/skills rev-parse HEAD 2>/dev/null || git -C ~/.claude/skills rev-parse HEAD 2>/dev/null || echo unknown').then(r => r.trim()),
  Bash('python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime(\'%Y%m%dT%H%M%SZ\'))"').then(r => r.trim()),
])
// runId: unique per logical run — shared with harness-plan and harness-implement so all 3 records link together.
const runId = `${issueKey || 'intake'}-${runTs}`

// Helper: patch fields into the last JSONL line of the telemetry file.
// Supports dot-notation keys for nested paths (e.g. "tokens.total.input").
// Wrapped in try/catch — no-op if the file doesn't exist yet (early crash).
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
    open(path, 'w').writelines([l + ('\\\n' if not l.endswith('\\\n') else '') for l in lines])
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
    },
  })

  // Compute wall-clock duration and token breakdown after Workflow() returns.
  const endTs = parseInt(await Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim()), 10)
  const durationMs = endTs - parseInt(startTs, 10)

  // subagent_tokens from the <usage> block in the completion notification above.
  // inputTokens = subagentTokens - outputTokensTotal (both measured by the workflow runtime).
  const subagentTokens = <usage.subagent_tokens from completion notification>
  const outputTokensTotal = result?.outputTokensTotal ?? null
  const inputTokens = (subagentTokens != null && outputTokensTotal != null)
    ? subagentTokens - outputTokensTotal
    : null

  if (result?.telemetryPath) {
    // Recompute cost with full input+output for accuracy.
    // Use inline blended-rate formula matching lib/cost.js (import() unavailable in skills).
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
      durationMs,
      'tokens.total.subagentTokens': subagentTokens,
      'tokens.total.input': inputTokens,
      ...(recomputedCost != null ? { 'cost.rateLockedUsd': recomputedCost } : {}),
      ...(inputTokens != null ? { 'cost.nullReasons.tokens.total.input': null } : {}),
    })
  }

} catch (err) {
  // Workflow failed or was cancelled. The workflow's internal catch already wrote
  // a CRASHED/FAILED audit record. Patch subagentTokens into it if available —
  // on cancellation the <usage> block still appears in the notification.
  const subagentTokens = <usage.subagent_tokens from completion notification, or null if absent>
  if (subagentTokens && result?.telemetryPath) {
    await patchTelemetryRecord(result.telemetryPath, { subagentTokens })
  }
  throw err
}
```

**Do not search the codebase, read files, grep patterns, or investigate the ticket independently while the workflow runs. Wait for `result` to return.**

### 5. Print cliSummary

Print `result.cliSummary` verbatim.

### 6. Write intake-manifest.json

Always write the intake manifest, regardless of size. Use the absolute path — relative paths will fail:

```js
// Ensure directory exists
await Bash(`mkdir -p ${repoPath}/docs/manifests`)
const repo = repoPath.split('/').pop()
const intakeManifestPath = `${repoPath}/docs/manifests/${repo}__harness-intake__${issueKey || 'intake'}__${runTs}__manifest.json`
// Write result.intakeManifest as prettified JSON using the Write tool
// Path must be absolute: ${repoPath}/docs/manifests/... NOT docs/manifests/...
```

### 7. XS/S/M exit — direct to harness-plan

If `result.splitRequired === false`:

Print the next step clearly:
```
Intake complete. Run:
  /harness-plan --intake docs/manifests/{today}-{issueKey}-intake-manifest.json
```

Stop here. Do not create Jira subtasks.

### 8. L path — quality gate

If `result.splitRequired === true` and `result.qualityIssues.length > 0`:
Surface issues, ask whether to continue or adjust.

### 9. L path — confirmation gate

```
Create these {N} subtasks in Jira under {issueKey}?

[G1 — run in parallel]
  {title}  ({N} files)  → {size}
  ...

[G2 — after all G1 complete]
  ...
```

Wait for explicit confirmation before creating anything.

### 10. L path — create Jira subtasks

```js
mcp__atlassian__createJiraIssue({
  cloudId,
  projectKey: issueKey.split('-')[0],
  issueTypeName: 'Subtask',
  summary: subtask.title,
  description: subtask.description,
  contentFormat: 'markdown',
  additional_fields: { parent: { key: issueKey } },
})
```

Collect created keys + URLs.

### 11. L path — write intake-manifest.json (with groups)

Inject `jiraKey` + `jiraUrl` per subtask in `result.intakeManifest.groups[*].subtasks[*]`, then write:

```js
const repo = repoPath.split('/').pop()
const intakeManifestPath = `${repoPath}/docs/manifests/${repo}__harness-intake__${issueKey}__${runTs}__manifest.json`
// Write result.intakeManifest (already contains groups[]) as prettified JSON
```

### 12. Print next steps

```
Subtasks created under {issueKey}.

[G1 — run these in parallel]
  /harness-plan --intake docs/manifests/{today}-{key}-intake-manifest.json --entry {TARS-XXXX}
  ...

[G2 — after all G1 plans are implemented]
  /harness-plan --intake docs/manifests/{today}-{key}-intake-manifest.json --entry {TARS-YYYY}
```

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
Same top-level fields as XS/S/M, plus a `groups[]` array with subtasks carrying `scopePath`, `files[]`, `jiraKey`, `jiraUrl`. There is no separate split-manifest file.

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
