---
name: harness-intake-v2
description: ORVA rewrite of harness-intake. Same inputs and outputs as v1. Use /harness-intake-v2 to run side-by-side comparisons against v1.
---

# harness-intake-v2

ORVA rewrite of harness-intake — Observe → Reason → Verify → Act. Same contract as v1.

## When to Use

```
/harness-intake-v2 <jira-url>
/harness-intake-v2 <jira-url> --repo /path/to/repo
```

## Step-by-Step

### 1. Parse input

Extract from the URL or text:
- `issueKey` — e.g. `TARS-1271` (from URL path segment `[A-Z]+-\d+`)
- `cloudId` — the Jira site hostname, e.g. `fandango.atlassian.net`

For freeform prompts with no URL: set `issueKey = null`, `cloudId = null`.

### 2. Resolve repoPath

Search common locations before asking:

```bash
find ~/Desktop/Repos ~/repos ~/code -maxdepth 2 -name ".git" 2>/dev/null \
  | xargs -I{} dirname {} \
  | while read d; do
      remote=$(git -C "$d" remote get-url origin 2>/dev/null)
      echo "$remote $d"
    done
```

Match git remote against Jira project key or repo name. If unambiguous use silently; if ambiguous ask.

### 3. Fetch ticket from Jira (if URL provided)

```js
mcp__atlassian__getJiraIssue({
  cloudId,
  issueIdOrKey: issueKey,
  fields: ['summary', 'description', 'issuetype', 'parent', 'project'],
  responseContentFormat: 'markdown',
})
```

Build `input` as `${summary}\n\n${description}`. For freeform prompts, use the prompt directly.

### 4. Run the workflow

```js
const startTs = await Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim())

const result = await Workflow({
  scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-intake-v2/workflow.js',
  args: {
    input,
    cloudId: cloudId || null,
    issueKey: issueKey || null,
    repoPath,
    today: currentDate,
    startTs,
  },
})
```

**After launching: stop. Do not search the codebase or investigate while the workflow runs.**

### 4b. Backup audit (always run after workflow returns)

If the workflow completed without throwing, run this immediately — it's a no-op if the internal audit-write succeeded, and a safety net if it silently failed:

```js
const auditBackup = JSON.stringify({
  ts: currentDate, skill: 'harness-intake-v2', status: result.status || 'COMPLETE',
  sourceIssue: result.intakeManifest?.sourceIssue || issueKey || 'unknown',
  size: result.size, subtaskCount: result.splitManifest?.groups?.flatMap(g => g.subtasks).length || 0,
  backup: true,
})
await Bash(`grep -q '"backup":true' ~/.claude/harness-intake-runs.jsonl 2>/dev/null || echo '${auditBackup.replace(/'/g, "'\\''")}' >> ~/.claude/harness-intake-runs.jsonl`)
```

### 5. Print cliSummary

Print `result.cliSummary` verbatim.

### 6. Write intake-manifest.json

Always write, regardless of size. Use absolute path:

```js
await Bash(`mkdir -p ${repoPath}/docs/plans`)
const intakeManifestPath = `${repoPath}/docs/plans/${today}-${issueKey || 'intake'}-intake-manifest.json`
// Write result.intakeManifest as prettified JSON using the Write tool
```

### 7. XS/S/M exit — direct to harness-plan

If `result.splitRequired === false`:

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

For each subtask in `result.splitManifest.groups`, in groupId order:

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

Collect created keys + URLs. Track `originalTitle` → `{ jiraKey, jiraUrl }` for manifest injection.

### 11. L path — write split-manifest.json

Inject `jiraKey` + `jiraUrl` into each subtask in `result.splitManifest.groups[*].subtasks[*]`:

```js
const createdByTitle = {}
for (const created of createdSubtasks) {
  createdByTitle[created.originalTitle] = { jiraKey: created.key, jiraUrl: `https://${cloudId}/browse/${created.key}` }
}
for (const group of result.splitManifest.groups) {
  for (const subtask of group.subtasks) {
    const match = createdByTitle[subtask.title]
    if (match) { subtask.jiraKey = match.jiraKey; subtask.jiraUrl = match.jiraUrl }
  }
}
await Bash(`mkdir -p ${repoPath}/docs/plans`)
const splitManifestPath = `${repoPath}/docs/plans/${today}-${issueKey}-split-manifest.json`
// Write result.splitManifest as prettified JSON using the Write tool
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

## Differences from v1

| v1 | v2 |
|----|----|
| layer-discover + classify + ac-synth parallel | Observe (all shell) → then classify + ac-synth parallel |
| Research agents run their own greps | Observe pre-fetches all file lists; groupers title/describe only |
| Phase C retry loop (separate phase) | Inline zero-retry in ac-files (2 grep variants, pick higher) |
| roughScope from ticket → greps scoped wrong before classify | Always greps src/ broad; classify returns scopePath; ac-files uses it |
| AC-synth has no shellCommand | AC-synth produces shellCommand for find/read/cleanup ACs |
| Flag inheritance via file set intersection (fragile) | suggestedType from AC-synth + classifyAcBullet authoritative override |
| Coordinator (Opus) for file conflict resolution | JS deduplicateSubtasks() before groupers; coordinator removed |
| Cascade files not discovered | Observe runs importers grep for cleanup ACs |
| No Jira creation flow in SKILL.md | Full Jira creation + manifest write flow here |
