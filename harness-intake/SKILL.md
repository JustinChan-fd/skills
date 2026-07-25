---
name: harness-intake
description: Universal harness entry point. Classifies any ticket or prompt into a typed intake manifest (XS/S/M) or split manifest (L). Always run this before harness-plan. Replaces harness-split.
---

# harness-intake

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

The manifest is written to `{repoPath}/docs/plans/`.

## Step-by-Step

### 1. Parse input

Extract from the URL or text:
- `issueKey` — e.g. `TARS-1271` (from URL path segment `[A-Z]+-\d+`)
- `cloudId` — the Jira site hostname, e.g. `fandango.atlassian.net`

For freeform prompts with no URL: set `issueKey = null`, `cloudId = null`.

### 2. Resolve repoPath

Search common locations for the repo before asking the user:

```bash
find ~/Desktop/Repos ~/repos ~/code -maxdepth 2 -name ".git" 2>/dev/null \
  | xargs -I{} dirname {} \
  | while read d; do
      remote=$(git -C "$d" remote get-url origin 2>/dev/null)
      echo "$remote $d"
    done
```

Match the git remote against the Jira project key or repo name in the URL. If unambiguous, use it silently. If ambiguous or not found, ask the user.

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

Run the workflow and patch `subagentTokens` in a single try/catch block. The patch uses `usage.subagent_tokens` from the Workflow completion — that value is only available when the workflow succeeds, so the catch branch skips it.

```js
const startTs = await Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim())

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
    },
  })

  // Patch subagentTokens immediately after workflow returns.
  // usage.subagent_tokens is in the Workflow completion notification — read it from
  // the <usage><subagent_tokens>NNNN</subagent_tokens></usage> block that appears
  // alongside the result. Patch both JSONL files before doing anything else.
  const subagentTokens = <usage.subagent_tokens from completion notification>
  const patchScript = `
import json, sys
path = sys.argv[1]
lines = open(path).readlines()
if lines:
    last = json.loads(lines[-1])
    last['subagentTokens'] = ${subagentTokens}
    lines[-1] = json.dumps(last)
    open(path, 'w').writelines([l + ('\\n' if not l.endswith('\\n') else '') for l in lines])
`
  await Bash(`python3 -c "${patchScript}" ~/.claude/harness-intake-runs.jsonl`)
  if (result.telemetryPath) {
    await Bash(`python3 -c "${patchScript}" "${result.telemetryPath}"`)
  }
} catch (err) {
  // Workflow failed or was cancelled — subagentTokens unavailable, skip patch.
  // Surface the error so the user knows the run didn't complete.
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
await Bash(`mkdir -p ${repoPath}/docs/plans`)
const intakeManifestPath = `${repoPath}/docs/plans/${today}-${issueKey || 'intake'}-intake-manifest.json`
// Write result.intakeManifest as prettified JSON using the Write tool
// Path must be absolute: ${repoPath}/docs/plans/... NOT docs/plans/...
```

### 7. XS/S/M exit — direct to harness-plan

If `result.splitRequired === false`:

Print the next step clearly:
```
Intake complete. Run:
  /harness-plan --intake docs/plans/{today}-{issueKey}-intake-manifest.json
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
const intakeManifestPath = `${repoPath}/docs/plans/${today}-${issueKey}-intake-manifest.json`
// Write result.intakeManifest (already contains groups[]) as prettified JSON
```

### 12. Print next steps

```
Subtasks created under {issueKey}.

[G1 — run these in parallel]
  /harness-plan --intake docs/plans/{today}-{key}-intake-manifest.json --entry {TARS-XXXX}
  ...

[G2 — after all G1 plans are implemented]
  /harness-plan --intake docs/plans/{today}-{key}-intake-manifest.json --entry {TARS-YYYY}
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

Every barrier event is logged to the audit record (`~/.claude/harness-intake-runs.jsonl`).
