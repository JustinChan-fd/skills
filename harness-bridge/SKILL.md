---
name: harness-bridge
description: Confidence gate between harness stages: scores an upstream artifact with a frozen pure-JS checklist, runs one adversarial skeptic, emits PROCEED/RE_ASK/EXIT + stamped gated manifest, invoked by harness-run (not directly).
---

# harness-bridge

> **IMPORTANT — invoke via harness-run skill, never directly.**
> Running `workflow.js` directly bypasses the SKILL.md wrapper entirely: the wrapper reads the upstream artifact from disk, fires the workflow, persists the gated manifest (`stamped`), appends the telemetry line, and prints the CLI summary. A bare Workflow call produces no gated manifest, no audit record, and returns raw objects the caller must manually handle. Always enter through harness-run.

## Philosophy

**harness-bridge is the confidence gate between every harness stage.** It never does the work of intake, plan, or implement — it decides whether the *previous* stage's output is trustworthy enough to hand forward. It scores an upstream artifact with a frozen pure-JS checklist, runs exactly ONE adversarial skeptic (which may only lower the score), and emits a verdict:

| Verdict | Score | Action |
|---|---|---|
| **PROCEED** | ≥ 85 | Stamp a `-gated.json` and advance. Downstream treats the gated manifest as MORE truthful than the ticket (manifest supremacy). |
| **RE_ASK** | < 85, first miss | Autonomously re-research: re-run the upstream skill with `--refine`, then re-gate once. |
| **EXIT** | < 85, second miss | Stop and surface. Do not advance. |

One retry budget total. The gate is deterministic (weighted checklist); the skeptic can only make it more conservative.

## When to Use

harness-bridge is invoked by **harness-run** between stages — not directly by a human in normal flow. Two handoffs:

- **Handoff A** — intake → plan. Gates `intake-manifest.json`.
- **Handoff B** — plan → implement. Gates the plan `-manifest.json` + `p1.json`.

## Invocation

harness-run calls this skill with the upstream artifact already on disk. The wrapper reads the JSON, fires the workflow, and persists the outputs.

```js
// A: artifact = parsed intake-manifest.json
// B: artifact = parsed plan -manifest.json, PLUS artifact._tasks = concat of every plans[].jsonPath tasks[]
let artifact = JSON.parse(await Read(artifactPath))
if (handoff === 'B') {
  const tasks = []
  for (const p of artifact.plans || []) {
    const pj = JSON.parse(await Read(`${repoPath}/${p.jsonPath}`))
    tasks.push(...(pj.tasks || []))
  }
  artifact._tasks = tasks
}

const startTs = await Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim())
const result = await Workflow({
  scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-bridge/workflow.js',
  args: {
    artifact, artifactPath, handoff,          // 'A' | 'B'
    retriesUsed,                              // 0 on first gate, 1 after one --refine
    weightsOverride: weightsOverride || null, // {checkId: weight} or null
    homeDir, repo, repoPath, issueKey, runId, runTs, skillsCommit, startTs,
  },
})
```

**Do not investigate the artifact independently while the workflow runs. Wait for `result`.**

## Persist the outputs (wrapper responsibility)

The workflow has no filesystem access. After it returns:

```js
// 1. Write the gated manifest (only meaningful on PROCEED; harmless otherwise)
if (result.gatedPath) {
  // Write result.stamped as prettified JSON to result.gatedPath (absolute)
}
// 2. Append telemetry (always — even on EXIT)
await Bash(result.appendCmd)
// 3. Print the summary
// print result.cliSummary verbatim
```

## Verdict handling (returned to harness-run)

harness-run reads `result.verdict` / `result.action` and does NOT re-implement the retry policy — `verdictFor` already encoded it:

- `PROCEED / advance` → pass `result.gatedPath` to the downstream skill.
- `RE_ASK / refine` → re-run the upstream skill with `--refine` (see harness-intake / harness-plan refine modes), then call harness-bridge again with `retriesUsed: 1`.
- `EXIT / stop` → halt the run, surface the weak checks (`result.flags`) and skeptic reasons (`result.probeResults`).

## Manifest supremacy (on PROCEED)

Once a manifest is gated PROCEED, downstream skills treat `<artifact>-gated.json` as ground truth over the original ticket text. If the gated manifest and the ticket disagree (e.g. file count, scope), the gated manifest wins — it was verified against the repo; the ticket was not. See [[feedback_harness_pillars]] (manifest-as-hypothesis, now promoted to verified truth post-gate).

## Telemetry

Bridge records are v2, written to `~/Desktop/Repos/harness-telemetry/v2/{repo}__harness-bridge__{issueKey}__{runTs}.jsonl`. Bridge adds these fields on top of the base v2 shape: `handoff, confidence, jsScore, verdict, action, flags, probeResults, perCheck, weights, retries, errorLog, weightChanges`. Never remove a field; skills may only ADD.

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
- **Blocking** — stop and surface (surface an EXIT verdict); do not proceed.
- **Non-blocking** — proceed under a clearly-labeled default; flag it in the output.

Every barrier event is logged to the audit record (`~/Desktop/Repos/harness-telemetry/v2/`).
