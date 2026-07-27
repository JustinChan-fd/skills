export const meta = {
  name: 'harness-run',
  description: 'Full harness pipeline conductor: provision worktree → intake → bridge-A → plan → bridge-B → implement → draft PR',
  phases: [
    { title: 'Provision',   detail: 'Create isolated worktree off origin/<base>' },
    { title: 'Intake',      detail: 'harness-intake: classify ticket, synthesize ACs, size' },
    { title: 'Gate-A',      detail: 'harness-bridge Handoff A: gate intake manifest' },
    { title: 'Plan',        detail: 'harness-plan: research, architect, synthesize plan' },
    { title: 'Gate-B',      detail: 'harness-bridge Handoff B: gate plan manifest' },
    { title: 'Implement',   detail: 'harness-implement: TDD-gated implementation' },
    { title: 'PR',          detail: 'Push branch, open DRAFT PR' },
    { title: 'Summary',     detail: 'Assemble run summary + weight-evolution report' },
  ],
}

// ===== PURE (inlined from lib/conductor.js + lib/run-state.js — import() unavailable in workflow scripts) =====

function buildStateFilePath(wtp, repo, issueKey, runTs) {
  return `${wtp}/docs/manifests/${repo}__harness-run__${issueKey}__${runTs}__run-state.json`
}

function buildRunState({ runId, parentRunId = null, lastCompletedStage, nextStage, artifacts, stageRecords, allWeightChanges, weightsOverride, worktreePath, runBranch, startTs, skillsCommit }) {
  return {
    schema: 'harness-run-state-v1',
    runId,
    parentRunId: parentRunId ?? null,
    lastCompletedStage,
    nextStage,
    artifacts,
    stageRecords: [...stageRecords],
    allWeightChanges: [...allWeightChanges],
    weightsOverride,
    worktreePath,
    runBranch,
    startTs,
    skillsCommit,
  }
}

function shouldSkipStage(resumeNextStage, currentStage, laterStages, requiredArtifact) {
  if (!resumeNextStage) return false
  if (resumeNextStage === currentStage) return false
  if (!laterStages.includes(resumeNextStage)) return false
  return !!requiredArtifact
}

function actionForVerdict(verdict, retriesUsed) {
  if (verdict === 'PROCEED') return { next: 'advance' }
  if (verdict === 'RE_ASK' && retriesUsed === 0) return { next: 'refine' }
  return { next: 'stop' }
}

function assembleRunSummary(records) {
  const stages = records.map(r => ({
    skill: r.skill,
    outcome: r.outcome ?? r.status ?? null,
    confidence: r.confidence ?? null,
    costUsd: r.cost?.rateLockedUsd ?? 0,
    durationMs: r.durationMs ?? 0,
  }))
  const totalCostUsd = +stages.reduce((s, x) => s + (x.costUsd || 0), 0).toFixed(4)
  const totalDurationMs = stages.reduce((s, x) => s + (x.durationMs || 0), 0)
  const outcomes = stages.map(x => (x.outcome == null ? null : String(x.outcome).toLowerCase()))
  const withOutcome = outcomes.filter(o => o !== null)
  if (withOutcome.length === 0) return { stages, totalCostUsd, totalDurationMs, finalStatus: 'UNKNOWN' }
  const exited = outcomes.some(o => o === 'exit')
  const failed = outcomes.some(o => o === 'failed' || o === 'crashed' || o === 'partial')
  const finalStatus = exited ? 'EXIT' : failed ? 'FAILED' : 'COMPLETE'
  return { stages, totalCostUsd, totalDurationMs, finalStatus }
}

function weightEvolutionReport(initialWeights, weightChanges) {
  const byHandoff = { A: [], B: [] }
  for (const c of weightChanges || []) (byHandoff[c.handoff] || (byHandoff[c.handoff] = [])).push(c)
  const lines = ['# Weight-evolution report', '']
  for (const h of ['A', 'B']) {
    lines.push(`## Handoff ${h}`)
    const init = initialWeights[h] || {}
    const final = { ...init }
    for (const c of byHandoff[h]) final[c.checkId] = c.newWeight
    lines.push('| check | initial | final |', '|---|---|---|')
    for (const id of Object.keys(init)) lines.push(`| ${id} | ${init[id]} | ${final[id] ?? init[id]} |`)
    lines.push('')
    if (byHandoff[h].length) {
      lines.push('Changes:')
      for (const c of byHandoff[h]) lines.push(`- \`${c.checkId}\` ${c.oldWeight} → ${c.newWeight} — ${c.reason} (run ${c.triggeringRunId})`)
    } else {
      lines.push('No weight changes this run.')
    }
    lines.push('')
  }
  return lines.join('\n')
}

// lib/plan-sequencer.js — keep identical.
function extractPlanEntries(manifest) {
  if (manifest == null) throw new Error('manifest is required')
  return manifest.plans || []
}
function orderPlansByDeps(plans) {
  if (!plans.length) return []
  const byId = Object.fromEntries(plans.map(p => [p.id, p]))
  for (const p of plans) {
    for (const dep of (p.dependsOn || [])) {
      if (!byId[dep]) throw new Error(`Plan "${p.id}" depends on unknown id "${dep}"`)
    }
  }
  const inDegree = Object.fromEntries(plans.map(p => [p.id, 0]))
  const dependents = Object.fromEntries(plans.map(p => [p.id, []]))
  for (const p of plans) {
    for (const dep of (p.dependsOn || [])) {
      inDegree[p.id]++
      dependents[dep].push(p.id)
    }
  }
  const queue = plans.filter(p => inDegree[p.id] === 0)
  const result = []
  while (queue.length) {
    const node = queue.shift()
    result.push(node)
    for (const depId of dependents[node.id]) {
      inDegree[depId]--
      if (inDegree[depId] === 0) queue.push(byId[depId])
    }
  }
  if (result.length !== plans.length) throw new Error('Circular dependency detected in plan manifest dependsOn graph')
  return result
}
// ===== END PURE =====

const a = args || {}
const issueKey   = a.issueKey
const repoPath   = a.repoPath
const baseBranch = a.baseBranch || 'feat/migrate-native-fetch-from-axios'
const runTs      = a.runTs
const runId      = a.runId
const skillsCommit = a.skillsCommit || 'unknown'
const homeDir    = a.homeDir
const parentRunId    = a.parentRunId    || null
const resumeFromState = a.resumeFromState || null
const initialWeights = a.initialWeights || { A: {}, B: {} }
const weightsOverride = a.weightsOverride || {}

if (!issueKey)   throw new Error('harness-run workflow requires issueKey')
if (!repoPath)   throw new Error('harness-run workflow requires repoPath')
if (!baseBranch) throw new Error('harness-run workflow requires baseBranch — never default to main/master')
if (!runTs)      throw new Error('harness-run workflow requires runTs')

// Derived from repoPath — canonical repo name, NOT the worktree directory
const repo         = repoPath.split('/').pop()
const worktreeName = `wt-${issueKey}-${runTs}`
const runBranch    = `harness/${issueKey}-${runTs}`
const worktreePath = `${repoPath}/../${worktreeName}`

const stateFilePath = buildStateFilePath(worktreePath, repo, issueKey, runTs)

const allWeightChanges = []
const stageRecords = []

// Restore from checkpoint if --resume was passed
let resumeArtifacts = {
  intakeManifestPath: null,
  intakeGatedPath:    null,
  planManifestPath:   null,
  planGatedPath:      null,
  p1JsonPath:         null,
}
let resumeNextStage = null
if (resumeFromState) {
  resumeArtifacts  = { ...resumeArtifacts, ...(resumeFromState.artifacts || {}) }
  resumeNextStage  = resumeFromState.nextStage || null
  const restoredRecords = resumeFromState.stageRecords || []
  stageRecords.push(...restoredRecords)
  log(`Resuming run ${runId} from stage: ${resumeNextStage} (${restoredRecords.length} prior stage records restored)`)
}

async function writeCheckpoint(lastCompletedStage, nextStage, artifacts) {
  const state = buildRunState({
    runId, parentRunId, lastCompletedStage, nextStage, artifacts,
    stageRecords, allWeightChanges, weightsOverride, worktreePath, runBranch,
    startTs: a.startTs || null, skillsCommit,
  })
  await agent(
    `Write the following JSON exactly to the file path below — overwrite if it exists, create if not. Do not modify the content.

Path: ${stateFilePath}

Content:
${JSON.stringify(state, null, 2)}

After writing, confirm with "CHECKPOINT_OK" or "CHECKPOINT_ERROR: <reason>".`,
    { label: `checkpoint-${lastCompletedStage}`, phase: 'Summary', effort: 'low' }
  )
}

// ── Phase 0: Provision worktree ───────────────────────────────────────────────
phase('Provision')
if (resumeNextStage && resumeNextStage !== 'provision') {
  log(`Skipping Provision (resumed — worktree already exists at ${worktreePath})`)
} else {
  log(`Provisioning worktree: ${worktreeName} off origin/${baseBranch}`)
  const worktreeSetup = await agent(
    `You are provisioning a git worktree for a harness run. Run these commands in order and report success or any error:

1. git -C ${repoPath} fetch origin ${baseBranch}
2. git -C ${repoPath} worktree add -b ${runBranch} ../${worktreeName} origin/${baseBranch}
3. ls ${worktreePath}/src 2>/dev/null | head -3 || echo "(src not found — repo may use different layout)"

If step 2 fails because the branch already exists, that means a previous run left it. Report the error and stop — do not force-create. The wrapper will surface this to the user.

Report: "WORKTREE_OK: <worktreePath>" on success, or "WORKTREE_ERROR: <message>" on failure.`,
    { label: 'provision-worktree', phase: 'Provision', effort: 'low' }
  )
  if (String(worktreeSetup).includes('WORKTREE_ERROR')) {
    return {
      finalStatus: 'ERROR',
      errorMessage: `Worktree provisioning failed: ${worktreeSetup}`,
      stageRecords,
      summary: assembleRunSummary(stageRecords),
      weightReport: weightEvolutionReport(initialWeights, allWeightChanges),
    }
  }
}

// ── Phase 1: Intake ───────────────────────────────────────────────────────────
phase('Intake')
let intakeManifestPath = resumeArtifacts.intakeManifestPath || null
let intakeTelemetryPath = null

const _skipIntake = shouldSkipStage(resumeNextStage, 'intake', ['gate-A', 'plan', 'gate-B', 'implement', 'pr'], intakeManifestPath)
if (_skipIntake) {
  log(`Skipping Intake (resumed — manifest at ${intakeManifestPath})`)
} else {
  log(`Running harness-intake for ${issueKey}`)
  const intakeResult = await agent(
    `You are the harness-run conductor invoking harness-intake as a child skill.

Invoke the skill: /harness-intake ${issueKey} --repo ${worktreePath}

The skill will classify the ticket, synthesize ACs, size the work, and write the intake manifest to ${worktreePath}/docs/manifests/.

After the skill completes, report back:
- intakeManifestPath: the absolute path to the written manifest JSON file (look for *__manifest.json in ${worktreePath}/docs/manifests/)
- runTs: the runTs embedded in the manifest filename
- size: the size from the manifest (XS/S/M/L)
- splitRequired: true/false
- telemetryPath: from result.telemetryPath
- cliSummary: print result.cliSummary verbatim to the user

Return JSON: {"intakeManifestPath": "...", "runTs": "...", "size": "...", "splitRequired": false, "telemetryPath": "..."}`,
    { label: 'intake', phase: 'Intake', effort: 'high' }
  )

  let intakeParsed = {}
  try { intakeParsed = typeof intakeResult === 'object' ? intakeResult : JSON.parse(String(intakeResult).match(/\{[\s\S]*\}/)?.[0] || '{}') } catch (_) {}
  intakeManifestPath = intakeParsed.intakeManifestPath || null
  intakeTelemetryPath = intakeParsed.telemetryPath || null

  if (!intakeManifestPath) {
    return { finalStatus: 'ERROR', errorMessage: 'harness-intake did not return intakeManifestPath', stageRecords, summary: assembleRunSummary(stageRecords), weightReport: weightEvolutionReport(initialWeights, allWeightChanges) }
  }

  stageRecords.push({ skill: 'harness-intake', outcome: 'COMPLETE', durationMs: 0 })
  await writeCheckpoint('intake', 'gate-A', { ...resumeArtifacts, intakeManifestPath })
}

// ── Phase 2: Gate-A ───────────────────────────────────────────────────────────
phase('Gate-A')
let gateARetries = 0
let gatedIntakePath = resumeArtifacts.intakeGatedPath || null
let gateAVerdict = null

const _skipGateA = shouldSkipStage(resumeNextStage, 'gate-A', ['plan', 'gate-B', 'implement', 'pr'], gatedIntakePath)
if (_skipGateA) {
  log(`Skipping Gate-A (resumed — gated manifest at ${gatedIntakePath})`)
  gateAVerdict = 'PROCEED'
}

while (gateAVerdict !== 'PROCEED') {
  log(`Running harness-bridge Handoff A (retriesUsed=${gateARetries})`)
  const artifactPathA = gateARetries === 0 ? intakeManifestPath : (gatedIntakePath || intakeManifestPath)

  const bridgeA = await agent(
    `You are the harness-run conductor invoking harness-bridge Handoff A.

Read the intake manifest from: ${artifactPathA}
Parse it as JSON — this is the artifact to gate.

Then invoke Workflow({
  scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-bridge/workflow.js',
  args: {
    artifact: <parsed manifest JSON>,
    artifactPath: '${artifactPathA}',
    handoff: 'A',
    retriesUsed: ${gateARetries},
    weightsOverride: ${JSON.stringify((weightsOverride.A && Object.keys(weightsOverride.A).length) ? weightsOverride.A : null)},
    homeDir: '${homeDir}',
    repo: '${repo}',
    worktree: '${worktreeName}',
    branch: '${runBranch}',
    repoPath: '${worktreePath}',
    issueKey: '${issueKey}',
    runId: '${runId}',
    runTs: '${runTs}',
    skillsCommit: '${skillsCommit}',
    startTs: <current epoch ms as integer>,
  }
})

After the workflow completes:
1. Write result.stamped as prettified JSON to result.gatedPath (if result.gatedPath is set)
2. Run: ${"`"}await Bash(result.appendCmd)${"`"} to append the telemetry line
3. Patch durationMs and subagentTokens into the telemetry record

Return JSON: {"verdict": "PROCEED|RE_ASK|EXIT", "action": "advance|refine|stop", "gatedPath": "...", "flags": [...], "probeResults": [...], "telemetryPath": "..."}`,
    { label: `bridge-A-try${gateARetries}`, phase: 'Gate-A', effort: 'high' }
  )

  let bridgeAParsed = {}
  try { bridgeAParsed = typeof bridgeA === 'object' ? bridgeA : JSON.parse(String(bridgeA).match(/\{[\s\S]*\}/)?.[0] || '{}') } catch (_) {}

  gateAVerdict = bridgeAParsed.verdict || 'EXIT'
  const gateAAction = actionForVerdict(gateAVerdict, gateARetries)

  stageRecords.push({ skill: 'harness-bridge', handoff: 'A', outcome: gateAVerdict, confidence: bridgeAParsed.confidence ?? null, durationMs: 0 })

  if (gateAAction.next === 'advance') {
    gatedIntakePath = bridgeAParsed.gatedPath || intakeManifestPath
    log(`Gate-A PROCEED — gated manifest: ${gatedIntakePath}`)
    await writeCheckpoint('gate-A', 'plan', { ...resumeArtifacts, intakeManifestPath, intakeGatedPath: gatedIntakePath })
    break
  }

  if (gateAAction.next === 'refine') {
    log(`Gate-A RE_ASK — re-running harness-intake with --refine`)
    gateARetries = 1

    const refineIntake = await agent(
      `You are the harness-run conductor invoking harness-intake in refine mode.

The bridge flagged these checks: ${JSON.stringify(bridgeAParsed.flags || [])}
Skeptic notes: ${JSON.stringify((bridgeAParsed.probeResults || []).map(p => p.reason))}

Invoke the skill: /harness-intake ${issueKey} --repo ${worktreePath} --refine ${intakeManifestPath}

Pass these refine args to the workflow:
  refine: { flags: ${JSON.stringify(bridgeAParsed.flags || [])}, probeResults: ${JSON.stringify(bridgeAParsed.probeResults || [])}, priorManifestPath: '${intakeManifestPath}' }

After completion, report:
- refinedManifestPath: the absolute path to the new manifest JSON
- telemetryPath: from result.telemetryPath

Return JSON: {"refinedManifestPath": "...", "telemetryPath": "..."}`,
      { label: 'intake-refine', phase: 'Gate-A', effort: 'high' }
    )

    let refineIntakeParsed = {}
    try { refineIntakeParsed = typeof refineIntake === 'object' ? refineIntake : JSON.parse(String(refineIntake).match(/\{[\s\S]*\}/)?.[0] || '{}') } catch (_) {}
    // Next bridge pass uses the refined manifest
    if (refineIntakeParsed.refinedManifestPath) {
      // Update artifactPathA for the next loop iteration via gatedIntakePath
      gatedIntakePath = refineIntakeParsed.refinedManifestPath
    }
    continue
  }

  // EXIT
  log(`Gate-A EXIT — halting run`)
  return {
    finalStatus: 'EXIT',
    exitPhase: 'Gate-A',
    flags: bridgeAParsed.flags || [],
    probeResults: bridgeAParsed.probeResults || [],
    stageRecords,
    summary: assembleRunSummary(stageRecords),
    weightReport: weightEvolutionReport(initialWeights, allWeightChanges),
  }
}

// ── Phase 3: Plan ─────────────────────────────────────────────────────────────
phase('Plan')
let planManifestPath = resumeArtifacts.planManifestPath || null
let p1JsonPath = resumeArtifacts.p1JsonPath || null

const _skipPlan = shouldSkipStage(resumeNextStage, 'plan', ['gate-B', 'implement', 'pr'], planManifestPath)
if (_skipPlan) {
  log(`Skipping Plan (resumed — manifest at ${planManifestPath})`)
} else {
  log(`Running harness-plan for ${issueKey} with gated intake: ${gatedIntakePath}`)
  const planResult = await agent(
    `You are the harness-run conductor invoking harness-plan as a child skill.

Invoke the skill: /harness-plan ${issueKey} --intake ${gatedIntakePath} --repo ${worktreePath}

The --intake flag passes the gated intake manifest as ground truth (manifest supremacy). The skill will research, architect, and synthesize the plan, writing files to ${worktreePath}/docs/manifests/.

After the skill completes:
- Print result.cliSummary verbatim to the user
- Return the result's manifestPath (relative, e.g. "docs/manifests/...manifest.json"), p1JsonPath (e.g. "docs/manifests/...p1.json"), and telemetryPath exactly as harness-plan returned them`,
    { label: 'plan', phase: 'Plan', effort: 'high',
      schema: {
        type: 'object',
        required: ['manifestPath'],
        properties: {
          manifestPath:  { type: 'string', description: 'relative path to *-manifest.json as returned by harness-plan result.manifestPath' },
          p1JsonPath:    { type: 'string', description: 'relative path to *-p1.json as returned by harness-plan result (may be inside plans[0].jsonPath)' },
          telemetryPath: { type: 'string' },
        },
      },
    }
  )

  // Construct absolute paths from the relative paths harness-plan returns.
  // Never ask an LLM sub-agent to build absolute paths — it gets them wrong.
  const _manifestRel = planResult?.manifestPath || null
  const _p1Rel = planResult?.p1JsonPath || (planResult?.plans?.[0]?.jsonPath) || null
  planManifestPath = _manifestRel ? `${worktreePath}/${_manifestRel}` : null
  p1JsonPath = _p1Rel ? `${worktreePath}/${_p1Rel}` : null

  if (!planManifestPath) {
    return { finalStatus: 'ERROR', errorMessage: 'harness-plan did not return manifestPath', stageRecords, summary: assembleRunSummary(stageRecords), weightReport: weightEvolutionReport(initialWeights, allWeightChanges) }
  }

  stageRecords.push({ skill: 'harness-plan', outcome: 'COMPLETE', durationMs: 0 })
  await writeCheckpoint('plan', 'gate-B', { ...resumeArtifacts, intakeManifestPath, intakeGatedPath: gatedIntakePath, planManifestPath, p1JsonPath })
}

// ── Phase 4: Gate-B ───────────────────────────────────────────────────────────
phase('Gate-B')
let gateBRetries = 0
let gatedPlanPath = resumeArtifacts.planGatedPath || null
let gateBVerdict = null

const _skipGateB = shouldSkipStage(resumeNextStage, 'gate-B', ['implement', 'pr'], gatedPlanPath)
if (_skipGateB) {
  log(`Skipping Gate-B (resumed — gated plan at ${gatedPlanPath})`)
  gateBVerdict = 'PROCEED'
}

while (gateBVerdict !== 'PROCEED') {
  log(`Running harness-bridge Handoff B (retriesUsed=${gateBRetries})`)
  const artifactPathB = gateBRetries === 0 ? planManifestPath : (gatedPlanPath || planManifestPath)

  const bridgeB = await agent(
    `You are the harness-run conductor invoking harness-bridge Handoff B.

Read the plan manifest from: ${artifactPathB}
Parse it as JSON — this is the base artifact.

For Handoff B, also read every plans[].jsonPath file listed in the manifest and concatenate their tasks[] arrays into artifact._tasks:
  const tasks = []
  for (const p of artifact.plans || []) {
    const pj = JSON.parse(await Read(\`${worktreePath}/\${p.jsonPath}\`))
    tasks.push(...(pj.tasks || []))
  }
  artifact._tasks = tasks

Then invoke Workflow({
  scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-bridge/workflow.js',
  args: {
    artifact: <enriched manifest with _tasks>,
    artifactPath: '${artifactPathB}',
    handoff: 'B',
    retriesUsed: ${gateBRetries},
    weightsOverride: ${JSON.stringify((weightsOverride.B && Object.keys(weightsOverride.B).length) ? weightsOverride.B : null)},
    homeDir: '${homeDir}',
    repo: '${repo}',
    worktree: '${worktreeName}',
    branch: '${runBranch}',
    repoPath: '${worktreePath}',
    issueKey: '${issueKey}',
    runId: '${runId}',
    runTs: '${runTs}',
    skillsCommit: '${skillsCommit}',
    startTs: <current epoch ms as integer>,
  }
})

After the workflow completes:
1. Write result.stamped as prettified JSON to result.gatedPath (if set)
2. Run Bash(result.appendCmd)
3. Patch durationMs and subagentTokens into the telemetry record

Return JSON: {"verdict": "PROCEED|RE_ASK|EXIT", "action": "advance|refine|stop", "gatedPath": "...", "flags": [...], "probeResults": [...], "telemetryPath": "..."}`,
    { label: `bridge-B-try${gateBRetries}`, phase: 'Gate-B', effort: 'high' }
  )

  let bridgeBParsed = {}
  try { bridgeBParsed = typeof bridgeB === 'object' ? bridgeB : JSON.parse(String(bridgeB).match(/\{[\s\S]*\}/)?.[0] || '{}') } catch (_) {}

  gateBVerdict = bridgeBParsed.verdict || 'EXIT'
  const gateBAction = actionForVerdict(gateBVerdict, gateBRetries)

  stageRecords.push({ skill: 'harness-bridge', handoff: 'B', outcome: gateBVerdict, confidence: bridgeBParsed.confidence ?? null, durationMs: 0 })

  if (gateBAction.next === 'advance') {
    gatedPlanPath = bridgeBParsed.gatedPath || planManifestPath
    log(`Gate-B PROCEED — gated plan: ${gatedPlanPath}`)
    await writeCheckpoint('gate-B', 'implement', { ...resumeArtifacts, intakeManifestPath, intakeGatedPath: gatedIntakePath, planManifestPath, p1JsonPath, planGatedPath: gatedPlanPath })
    break
  }

  if (gateBAction.next === 'refine') {
    log(`Gate-B RE_ASK — re-running harness-plan with --refine`)
    gateBRetries = 1

    const refinePlan = await agent(
      `You are the harness-run conductor invoking harness-plan in refine mode.

The bridge flagged these checks: ${JSON.stringify(bridgeBParsed.flags || [])}
Skeptic notes: ${JSON.stringify((bridgeBParsed.probeResults || []).map(p => p.reason))}

Invoke the skill: /harness-plan ${issueKey} --intake ${gatedIntakePath} --refine ${planManifestPath} --repo ${worktreePath}

Pass refine payload:
  refine: { flags: ${JSON.stringify(bridgeBParsed.flags || [])}, probeResults: ${JSON.stringify(bridgeBParsed.probeResults || [])}, priorPlanManifestPath: '${planManifestPath}', gatedIntakePath: '${gatedIntakePath}' }

Return JSON: {"refinedPlanManifestPath": "...", "refinedP1JsonPath": "...", "telemetryPath": "..."}`,
      { label: 'plan-refine', phase: 'Gate-B', effort: 'high' }
    )

    let refinePlanParsed = {}
    try { refinePlanParsed = typeof refinePlan === 'object' ? refinePlan : JSON.parse(String(refinePlan).match(/\{[\s\S]*\}/)?.[0] || '{}') } catch (_) {}
    if (refinePlanParsed.refinedPlanManifestPath) {
      gatedPlanPath = refinePlanParsed.refinedPlanManifestPath
    }
    continue
  }

  // EXIT
  log(`Gate-B EXIT — halting run`)
  return {
    finalStatus: 'EXIT',
    exitPhase: 'Gate-B',
    flags: bridgeBParsed.flags || [],
    probeResults: bridgeBParsed.probeResults || [],
    stageRecords,
    summary: assembleRunSummary(stageRecords),
    weightReport: weightEvolutionReport(initialWeights, allWeightChanges),
  }
}

// ── Phase 5: Implement ────────────────────────────────────────────────────────
// Reads plan manifest → orders plans by dependsOn → runs harness-implement once per plan.
// Works for any size: XS/S/M produce 1 plan entry, L produces N entries (G1…G3).
phase('Implement')
let implOutcome = null

const _skipImpl = shouldSkipStage(resumeNextStage, 'implement', ['pr'], true)
if (_skipImpl) {
  log(`Skipping Implement (resumed — already completed)`)
  implOutcome = 'COMPLETE'
} else {
  // Read and parse the plan manifest to get the ordered plan list.
  // planManifestPath is the *-manifest.json; it contains plans[] with jsonPath per entry.
  const manifestReadResult = await agent(
    `Read the file at: ${planManifestPath}
Parse it as JSON and return the parsed object as-is.
Return JSON: the parsed manifest object (plans array, size, execution, etc.)`,
    { label: 'read-plan-manifest', phase: 'Implement', model: 'claude-haiku-4-5-20251001', effort: 'low',
      schema: {
        type: 'object',
        required: ['plans'],
        properties: {
          plans: { type: 'array' },
          size: { type: 'string' },
          execution: { type: 'string' },
        },
      },
    }
  )
  if (!manifestReadResult?.plans) {
    return { finalStatus: 'ERROR', errorMessage: 'Failed to read plan manifest for implement sequencing', stageRecords, summary: assembleRunSummary(stageRecords), weightReport: weightEvolutionReport(initialWeights, allWeightChanges) }
  }

  // Resolve execution order via topological sort on dependsOn graph.
  const orderedPlans = orderPlansByDeps(extractPlanEntries(manifestReadResult))
  log(`Implement: ${orderedPlans.length} plan(s) to execute in order: ${orderedPlans.map(p => p.id).join(' → ')}`)

  // Walk plans sequentially — each plan's jsonPath is the input to harness-implement.
  // All plans share the same pre-provisioned worktree and branch.
  let allImplOutcomes = []
  for (const plan of orderedPlans) {
    const planJsonPath = `${worktreePath}/${plan.jsonPath}`
    log(`Running harness-implement for plan ${plan.id}: ${planJsonPath}`)

    const implResult = await agent(
      `You are the harness-run conductor invoking harness-implement as a child skill.

The plan JSON is at: ${planJsonPath}
The worktree is ALREADY provisioned at: ${worktreePath}
The run branch is: ${runBranch}
The base branch is: ${baseBranch}

Invoke the skill: /harness-implement ${planJsonPath}

CRITICAL — when you call Workflow({scriptPath: harness-implement/workflow.js, args: {...}}), you MUST include these two extra args in addition to the standard ones:
  worktreePath: "${worktreePath}"
  runBranch: "${runBranch}"

These tell harness-implement to use the pre-existing worktree instead of creating a new one.
The baseBranch is pre-answered as "${baseBranch}" — do NOT ask the user which branch to use; pass it directly as baseBranch in the Workflow args.

After the skill completes, print result.cliSummary verbatim to the user.
Return the outcome from harness-implement's result.status (normalised to uppercase: COMPLETE / PARTIAL / FAILED) and result.telemetryPath.`,
      { label: `implement:${plan.id}`, phase: 'Implement', effort: 'high',
        schema: {
          type: 'object',
          required: ['outcome'],
          properties: {
            outcome:      { type: 'string', enum: ['COMPLETE', 'PARTIAL', 'FAILED'] },
            telemetryPath: { type: 'string' },
          },
        },
      }
    )

    const planOutcome = implResult?.outcome || 'FAILED'
    allImplOutcomes.push(planOutcome)
    stageRecords.push({ skill: 'harness-implement', planId: plan.id, outcome: planOutcome, durationMs: 0 })

    // Stop the loop on failure — don't run G2 if G1 failed
    if (planOutcome === 'FAILED' || planOutcome === 'UNKNOWN') {
      log(`Implement: plan ${plan.id} returned ${planOutcome} — stopping implement loop`)
      break
    }
  }

  // Overall implement outcome: COMPLETE only if all plans completed
  implOutcome = allImplOutcomes.every(o => o === 'COMPLETE') ? 'COMPLETE'
    : allImplOutcomes.some(o => o === 'PARTIAL') ? 'PARTIAL'
    : 'FAILED'

  await writeCheckpoint('implement', 'pr', { ...resumeArtifacts, intakeManifestPath, intakeGatedPath: gatedIntakePath, planManifestPath, p1JsonPath, planGatedPath: gatedPlanPath })
}

// ── Phase 6: Push + Draft PR ──────────────────────────────────────────────────
phase('PR')
log(`Pushing branch and opening DRAFT PR`)
const prResult = await agent(
  `You are the harness-run conductor. Implementation is complete. Create a DRAFT PR.

GUARDRAILS — NEVER cross these:
- DRAFT PR only. NEVER merge, NEVER force-push, NEVER touch main/master.
- Base branch: ${baseBranch} (the feature branch, NOT main/master)
- Push branch: ${runBranch}

Steps:
1. cd ${worktreePath} && git push -u origin ${runBranch}
2. gh pr create --draft --title "harness: ${issueKey} auto-migration (${runTs})" --base ${baseBranch} --head ${runBranch} --body "Auto-generated by harness-run. Ticket: ${issueKey}. Run: ${runId}. Review before merging."
3. Capture the PR URL from gh output.
4. Run npm test in ${worktreePath} and report pass/fail.

Return JSON: {"prUrl": "...", "testsPassed": true/false, "testOutput": "..."}`,
  { label: 'draft-pr', phase: 'PR', effort: 'low' }
)

let prParsed = {}
try { prParsed = typeof prResult === 'object' ? prResult : JSON.parse(String(prResult).match(/\{[\s\S]*\}/)?.[0] || '{}') } catch (_) {}
stageRecords.push({ skill: 'harness-pr', outcome: prParsed.prUrl ? 'COMPLETE' : 'FAILED', durationMs: 0 })

// ── Phase 7: Summary ──────────────────────────────────────────────────────────
phase('Summary')
const summary = assembleRunSummary(stageRecords)
const weightReport = weightEvolutionReport(initialWeights, allWeightChanges)

const summaryBox = [
  '╭─ harness-run summary ──────────────────────────────────',
  `│ Run:       ${runId}`,
  parentRunId ? `│ Parent:    ${parentRunId}` : null,
  `│ Ticket:    ${issueKey}`,
  `│ Branch:    ${runBranch}`,
  `│ Worktree:  ${worktreeName}`,
  `│ PR:        ${prParsed.prUrl || '(not created)'}`,
  `│ Tests:     ${prParsed.testsPassed ? 'PASS' : 'FAIL'}`,
  `│ Status:    ${summary.finalStatus}`,
  `│ Cost:      ~$${summary.totalCostUsd}`,
  `│ Duration:  ${Math.round(summary.totalDurationMs / 60000)}min`,
  '╰────────────────────────────────────────────────────────',
].filter(Boolean).join('\n')

log(summaryBox)
log(weightReport)

return {
  finalStatus: summary.finalStatus,
  runId,
  parentRunId,
  runBranch,
  worktreeName,
  stateFilePath,
  prUrl: prParsed.prUrl || null,
  testsPassed: prParsed.testsPassed || false,
  stageRecords,
  summary,
  summaryBox,
  weightReport,
}
