---
name: harness-implement
description: Use after harness-plan has produced and you have approved a plan file. Reads the task list from the plan, creates a worktree, implements each task with TDD gating, verifies, reviews, and returns a debrief. Does not push or create a PR.
---

# harness-implement

> **IMPORTANT — invoke via `/harness-implement`, never directly.**
> Running `workflow.js` directly bypasses the SKILL.md wrapper entirely: `startTs`, `skillsCommit`, `runTs`, `runId`, and the post-workflow telemetry patch (subagentTokens, inputTokens, recomputedCost) are all set by the wrapper, not the workflow. (`durationMs` is measured by the workflow itself as of 2026-07-27 — see step 4.) A bare Workflow call produces an incomplete audit record and a mismatched or missing telemetry file. Always enter through the skill.

## Philosophy: No Thinking, Just Typing

**harness-implement does not think. It executes.**

The plan contains all context needed. The developer reads the task description and writes code — nothing else. If anything is unclear or missing, the developer returns `NEEDS_CONTEXT` immediately and the plan is updated. The developer never:
- Reads files outside the task's `FILES` list
- Explores the codebase to understand patterns
- Makes architectural decisions
- Fills in gaps in the description

A stall or repeated `NEEDS_CONTEXT` is always a signal to go back to harness-plan and improve the task description, not to let the developer explore its way to an answer.

**The plan is the brain. Implement is the hands.**

## What It Does

Reads an approved plan file and executes it:

1. Extracts the `## Tasks` JSON block from the plan
2. Creates a git worktree from `origin/<user-selected-branch>`
3. Implements each task: developer → QA (TDD gate) + code review (parallel)
4. Verifies: `npm test` + `tsc --noEmit`
5. Reviews: correctness + security on the full diff (parallel)
6. Returns a debrief with diff, test results, PR title/body

**Does not push. Does not create a PR.** You do that after reading the debrief.

## How to Invoke

```
/harness-implement docs/manifests/YYYY-MM-DD-<key>-p1.json
```

Pass the companion `.json` path (not the `.md`). harness-plan always produces both.

**If harness-plan produced a manifest** (`-manifest.json`), read it first to understand execution order, then invoke implement once per plan entry in dependency order. harness-implement itself never reads the manifest — you (or loop:run) sequence the invocations.

Before invoking the Workflow, ask the user one question:

```
"Which branch should the worktree base from?"
```

List the available remote branches (run `git branch -r | sed 's|origin/||' | grep -v HEAD | sort`) as options. The user picks one — typically `main`, but may be a feature branch if harness-plan was run on a non-main branch.

Then pass the answer as `baseBranch`:
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

```js
// Capture metadata before Workflow() — Date.now() is unavailable inside workflow scripts.
const [startTs, skillsCommit, runTs] = await Promise.all([
  Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim()),
  Bash('git -C ~/Desktop/Repos/skills rev-parse HEAD 2>/dev/null || git -C ~/.claude/skills rev-parse HEAD 2>/dev/null || echo unknown').then(r => r.trim()),
  Bash('python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime(\'%Y%m%dT%H%M%SZ\'))"').then(r => r.trim()),
])
const issueKey = planPath.match(/[A-Z]+-\d+/)?.[0] || 'impl'
const runId = `${issueKey}-${runTs}`

// Write audit record — workflow returns it as a plain object, no shell escaping needed.
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

const patchTelemetryRecord = async (path, fields) => {
  try {
    const fieldJson = JSON.stringify(fields).replace(/'/g, "'\\''")
    await Bash(`python3 -c "
import json, sys

# Prefixes whose value is a MAP with caller-controlled keys. Everything after one of these is
# a SINGLE literal key, however many dots it holds. cost.nullReasons is keyed by the dotted
# field path a null explains ('tokens.total.input'), so splitting it into levels both leaves
# the stale reason in place AND invents a nullReasons.tokens.total = {} branch nothing reads.
# Mirrors MAP_VALUED_PREFIXES in lib/telemetry-patch.js; lib/skill-patch-parity.test.js runs
# this python for real and fails if the two disagree.
MAP_VALUED_PREFIXES = ['cost.nullReasons', 'agentCount.byModel', 'agentCount.byPhase',
                      'tokens.byModel', 'tokens.byPhase']

def split_patch_key(key):
    for prefix in MAP_VALUED_PREFIXES:
        # Only a key reaching INTO the map is special; the map itself stays replaceable.
        if key.startswith(prefix + '.'):
            return prefix.split('.'), key[len(prefix) + 1:]
    segs = key.split('.')
    return segs[:-1], segs[-1]

def set_nested(d, dotted_key, value):
    path, leaf = split_patch_key(dotted_key)
    deleting = value is None
    for k in path:
        if k not in d or not isinstance(d[k], dict):
            # A delete never creates what it would delete from — that vivification is where
            # the invented branch came from. A set does, since a record may legitimately not
            # carry tokens.total yet.
            if deleting:
                return
            d[k] = {}
        d = d[k]
    if deleting:
        d.pop(leaf, None)
    else:
        d[leaf] = value

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
    scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-implement/workflow.js',
    args: { planPath, repoPath, today: currentDate, baseBranch, startTs, runId, runTs, skillsCommit },
  })
  // currentDate is injected into every session — it is always available, never guess or hardcode it
  // baseBranch: the branch name the user selected (no "origin/" prefix)

  // The workflow wrote its own record in Debrief (write-telemetry agent) and stamped
  // durationMs there. Do NOT append or re-stamp here: a second append duplicates the
  // dashboard row, and a duration measured from *this* point measures how long the main
  // agent took to get around to it — which is precisely the bug that made MC-1077's
  // 239210ms a real measurement of the wrong interval.

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
      'tokens.total.subagentTokens': subagentTokens,
      'tokens.total.input': inputTokens,
      ...(recomputedCost != null ? { 'cost.rateLockedUsd': recomputedCost } : {}),
      ...(inputTokens != null ? { 'cost.nullReasons.tokens.total.input': null } : {}),
    })
  }

} catch (err) {
  const subagentTokens = <usage.subagent_tokens from completion notification, or null if absent>
  await writeCrashRecord(err.telemetryPath, err.auditRecord)
  if (subagentTokens && err.telemetryPath) {
    await patchTelemetryRecord(err.telemetryPath, { 'tokens.total.subagentTokens': subagentTokens })
  }
  throw err
}
```

## What You Get Back

A debrief printed to screen:
- Per-task status (PASS / PASS_WITH_CONCERNS / BLOCKED)
- Code review findings
- Security gate status
- Test + type check results
- Full diff stat
- PR title and body (ready to copy)

Then you:
```bash
git push -u origin <branch>
gh pr create --title "..." --body "..."
```

## TDD Contract

Every task with `tddRequired: true` requires:
1. Developer writes failing test(s) first
2. Developer captures the failure output
3. Developer implements until tests pass
4. QA verifies the failure evidence is real (not post-hoc)

QA blocks the task if TDD evidence is missing. One redispatch is allowed. If still blocked after redispatch, the task surfaces as incomplete in the debrief — it does not silently pass.

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
