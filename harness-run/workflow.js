export const meta = {
  name: 'harness-run',
  description: 'Full harness pipeline conductor: provision worktree → intake → plan → implement → draft PR',
  phases: [
    { title: 'Provision',   detail: 'Create isolated worktree off origin/<base>' },
    { title: 'Intake',      detail: 'harness-intake: classify ticket, synthesize ACs, size' },
    { title: 'Plan',        detail: 'harness-plan: research, architect, synthesize plan' },
    { title: 'Implement',   detail: 'harness-implement: TDD-gated implementation' },
    { title: 'PR',          detail: 'Push branch, open DRAFT PR' },
    { title: 'Summary',     detail: 'Assemble run summary' },
  ],
}

// ── MANIFEST-AS-GOSPEL (2026-07-27) ──────────────────────────────────────────
// harness-bridge is deliberately NOT in this sequence. Each stage's manifest is
// accepted as ground truth by the next stage — no scoring gate, no RE_ASK loop,
// no refine passes. Rationale: the RE_ASK loop death-spiralled (four consecutive
// refine agents died mid-Read) and blocked a run whose goal is a proven happy
// path to a draft PR. The bridge skill and its lib/checks-*.js are untouched on
// disk; re-add them here behind an opt-in --gate flag when the checks-B ↔
// harness-plan schema contract is aligned.
//
// Child skills are invoked with workflow({scriptPath}) at SCRIPT level, not via
// agent() prompts telling a subagent to call Workflow — subagents cannot nest
// Workflow, so that older shape silently never ran any child workflow.js and
// every stage returned a hand-written manifest with null telemetry.

// ===== PURE (inlined from lib/*.js — import() unavailable in workflow scripts) =====
// Every function below is a verbatim copy of its lib/ source. Change one, change both;
// the lib/ copy is what `node lib/*.test.js` exercises.

function buildStateFilePath(wtp, repo, issueKey, runTs) {
  return `${wtp}/docs/manifests/${repo}__harness-run__${issueKey}__${runTs}__run-state.json`
}

// allWeightChanges/weightsOverride are retained as always-empty fields so run-state
// files stay shape-compatible with bridge-era checkpoints (harness-run-state-v1).
function buildRunState({ runId, parentRunId = null, lastCompletedStage, nextStage, artifacts, stageRecords, allWeightChanges = [], weightsOverride = {}, worktreePath, runBranch, startTs, skillsCommit }) {
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

// Bridge-era checkpoints name stages that no longer exist. Map them onto the stage
// the manifest-as-gospel sequence would resume at, so a `nextStage: 'gate-B'` state
// file resumes at implement rather than silently re-running plan from scratch
// (an unrecognised stage name matches no laterStages list, so nothing is skipped).
const LEGACY_STAGE_ALIASES = {
  'gate-a': 'plan',       // gate A sat between intake and plan; intake is done
  'gatea':  'plan',
  'gate-b': 'implement',  // gate B sat between plan and implement; plan is done
  'gateb':  'implement',
}

function normalizeResumeStage(stage) {
  if (!stage) return null
  const key = String(stage).toLowerCase()
  return LEGACY_STAGE_ALIASES[key] || stage
}

// Bridge-era checkpoints stored worktreePath as `${repoPath}/../wt-<...>`. A literal
// `..` segment breaks the homeDir regex the child telemetry-path builders run against
// repoPath, so collapse it the way the fresh-run derivation already does.
function collapseParentSegments(p) {
  if (!p || !p.includes('..')) return p
  const out = []
  for (const seg of p.split('/')) {
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

// Mirror of lib/run-state.js — a resumed run must reuse the worktree the original run
// provisioned, since runTs (and therefore the derived worktree name) is new every time.
function resolveWorktreeTarget(state, derived) {
  const worktreePath = collapseParentSegments((state && state.worktreePath) || derived.worktreePath)
  const runBranch    = (state && state.runBranch)    || derived.runBranch
  return {
    worktreePath,
    runBranch,
    reused: worktreePath !== derived.worktreePath || runBranch !== derived.runBranch,
  }
}

function shouldSkipStage(resumeNextStage, currentStage, laterStages, requiredArtifact) {
  const next = normalizeResumeStage(resumeNextStage)
  if (!next) return false
  if (next === currentStage) return false
  if (!laterStages.includes(next)) return false
  return !!requiredArtifact
}

// agent() returns null when a subagent dies on a terminal API error (403 after a
// logout, budget exhaustion, retries exhausted). `typeof null === 'object'` is true,
// so a bare `typeof r === 'object' ? r : JSON.parse(...)` assigns null straight
// through and the next property access throws — turning a recoverable stage failure
// into a workflow crash with no summary box and no resumable state file.
// Always returns a plain object, so `.prUrl` etc. are safe to read.
function parseAgentJson(result) {
  if (result && typeof result === 'object') return Array.isArray(result) ? {} : result
  if (typeof result !== 'string' || !result) return {}
  const match = result.match(/\{[\s\S]*\}/)
  if (!match) return {}
  try {
    const parsed = JSON.parse(match[0])
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

function assembleRunSummary(records) {
  const stages = records.map(r => ({
    skill: r.skill,
    // `outcome` only. Never fall back to r.status — status carries lifecycle
    // values (COMPLETE, COMPLETE_FRAMING_CORRECTED) on a different axis, and
    // conflating them is what made the dashboard RESULT column unreadable.
    outcome: r.outcome ?? null,
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

// lib/plan-sequencer.js — keep identical.
function extractPlanEntries(manifest) {
  if (manifest == null) throw new Error('manifest is required')
  return manifest.plans || []
}
// Prefers the MARKDOWN path. harness-implement derives the JSON companion itself
// (`planPath.replace(/\.md$/, '.json')`) and keeps the .md as its fallback when the
// JSON is missing or malformed. Passing jsonPath makes both resolve to the same
// .json file, so that fallback can never fire.
function planPathFor(plan) {
  if (plan == null) throw new Error('plan entry is required')
  const p = plan.path || plan.jsonPath
  if (!p) throw new Error(`Plan "${plan.id ?? '(no id)'}" has neither path nor jsonPath`)
  return p
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

// lib/plan-input.js — keep identical.
// harness-plan's `input` is RAW TEXT, not a manifest: it sizes the ticket from it,
// regexes the issue key out of it, and derives the plan slug/title/description from
// its first lines. So the conductor renders the manifest back down to prose.
// groundedReality (size L only) outranks the ticket text — the intake manifest's own
// comment says downstream workers MUST prefer it. For XS/S/M it is null by design,
// so the raw ticket text is the fallback.
function buildPlanInput(manifest, { issueKey = null, ticketInput = null } = {}) {
  if (manifest == null) throw new Error('manifest is required')

  const gr = manifest.groundedReality || null
  const acBullets = (manifest.acList || []).map(ac => ac?.bullet).filter(Boolean)

  const grBlock = gr?.summary
    ? [
        'GROUNDED REALITY (verified by intake research — outranks ticket text):',
        gr.summary,
        `Verified file count: ${gr.actualFileCount ?? (manifest.files || []).length}`,
        gr.actualScope    ? `Verified scope: ${gr.actualScope}` : null,
        gr.migrationNotes ? `Migration notes: ${gr.migrationNotes}` : null,
        (gr.ticketClaimsToIgnore || []).length
          ? `Ticket claims research proved wrong: ${gr.ticketClaimsToIgnore.join('; ')}`
          : null,
      ].filter(Boolean).join('\n')
    : (ticketInput || null)

  const scopeBlock = [
    manifest.migrationPattern ? `Migration pattern: ${manifest.migrationPattern}` : null,
    manifest.scopePath        ? `Scope path: ${manifest.scopePath}` : null,
  ].filter(Boolean).join('\n')

  const heading = issueKey
    ? `${issueKey} — ${manifest.sourceTitle || issueKey}`
    : (manifest.sourceTitle || null)

  return [
    heading,
    grBlock,
    acBullets.length ? ['Acceptance criteria:', ...acBullets.map(b => `- ${b}`)].join('\n') : null,
    scopeBlock || null,
  ].filter(Boolean).join('\n\n').trim()
}
const MIN_PLAN_INPUT_CHARS = 40
// ===== END PURE =====

const a = args || {}
const issueKey   = a.issueKey
const repoPath   = a.repoPath
const baseBranch = a.baseBranch || 'feat/migrate-native-fetch-from-axios'
const runTs      = a.runTs
const runId      = a.runId
const skillsCommit = a.skillsCommit || 'unknown'
const today      = a.today || null
const parentRunId    = a.parentRunId    || null
const resumeFromState = a.resumeFromState || null

if (!issueKey)   throw new Error('harness-run workflow requires issueKey')
if (!repoPath)   throw new Error('harness-run workflow requires repoPath')
if (!baseBranch) throw new Error('harness-run workflow requires baseBranch — never default to main/master')
if (!runTs)      throw new Error('harness-run workflow requires runTs')
if (!today)      throw new Error('harness-run workflow requires today (calendar date for telemetry ts)')

// Canonical repo name — the real repo directory, NOT the worktree we provision below.
// Passed to every child as `repoName` so their telemetry says `webtarsthree`,
// not `wt-TARS-1271-20260727T194141Z`.
const repo         = repoPath.replace(/\/$/, '').split('/').pop()
const worktreeName = `wt-${issueKey}-${runTs}`
// Resolve the parent dir explicitly — a literal `..` in the path breaks the
// homeDir regex the child telemetry-path builders run against repoPath.
const reposDir     = repoPath.replace(/\/$/, '').split('/').slice(0, -1).join('/')
// A resumed run must land in the worktree the ORIGINAL run provisioned, not one named
// after this invocation's runTs — Provision is skipped when resuming, so a derived-but-
// absent directory makes the first stage that reads an artifact fail.
const _derivedTarget = { worktreePath: `${reposDir}/${worktreeName}`, runBranch: `harness/${issueKey}-${runTs}` }
const { worktreePath, runBranch: _resolvedBranch, reused: _reusedWorktree } =
  resolveWorktreeTarget(a.resumeFromState || null, _derivedTarget)
const runBranch = _resolvedBranch
// Report the directory we actually work in, so the summary box and PR steps agree.
const activeWorktreeName = worktreePath.split('/').pop()

const stateFilePath = buildStateFilePath(worktreePath, repo, issueKey, runTs)

const stageRecords = []

// Restore from checkpoint if --resume was passed.
// intakeGatedPath / planGatedPath are still read (not written) so run-state files
// from bridge-era runs remain resumable — a gated path, if present, is preferred
// as the plan input since it is a strictly enriched form of the raw manifest.
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
  const _rawNextStage = resumeFromState.nextStage || null
  resumeNextStage  = normalizeResumeStage(_rawNextStage)
  const restoredRecords = resumeFromState.stageRecords || []
  stageRecords.push(...restoredRecords)
  const _aliased = _rawNextStage && _rawNextStage !== resumeNextStage ? ` (bridge-era "${_rawNextStage}")` : ''
  log(`Resuming run ${runId} from stage: ${resumeNextStage}${_aliased} (${restoredRecords.length} prior stage records restored)`)
  if (_reusedWorktree) log(`Reusing checkpoint worktree ${worktreePath} on branch ${runBranch} (this invocation's runTs would have derived ${_derivedTarget.worktreePath})`)
}

async function writeCheckpoint(lastCompletedStage, nextStage, artifacts) {
  const state = buildRunState({
    runId, parentRunId, lastCompletedStage, nextStage, artifacts,
    stageRecords, allWeightChanges: [], weightsOverride: {}, worktreePath, runBranch,
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
    }
  }
}

// Args every child workflow needs for a linked, correctly-labelled telemetry record.
// repoName is the canonical repo; repoPath is the worktree the child actually edits.
const childTelemetryArgs = {
  repoName: repo,
  worktree: activeWorktreeName,
  branch:   runBranch,
  runId,
  runTs,
  today,
  skillsCommit,
  parentRunId,
  // Fallback only — each call site overrides this with its own stage-start stamp (_t0), so
  // a child measures ITS duration and not the whole run's. Without an override a late stage
  // would report cumulative time, which is plausible and wrong: the same class of error as
  // measuring "run start → a human noticed the log was missing".
  startTs:  a.startTs || null,
}

// ── Stage telemetry, conductor-side ──────────────────────────────────────────
// Calling a child workflow() directly bypasses its SKILL.md wrapper, which is
// what normally stamps wall-clock duration and appends the audit record. The
// conductor takes over both jobs here.
//
// Output tokens are free to compute: budget.spent() is shared across child
// workflows, so a delta around the workflow() call is that stage's output.
// Wall-clock needs a shell — Date.now() is unavailable in workflow scripts — so
// a haiku agent stamps epoch ms at each boundary.

async function nowMs(label) {
  const r = await agent(
    `Run exactly: python3 -c "import time; print(int(time.time()*1000))"
Return ONLY the integer it prints. No prose, no units, no punctuation.`,
    { label: `stamp-${label}`, phase: 'Summary', model: 'claude-haiku-4-5-20251001', effort: 'low' }
  )
  const n = parseInt(String(r).match(/\d{10,}/)?.[0] || '', 10)
  return Number.isFinite(n) ? n : null
}

// PATCH-ONLY as of 2026-07-27. The child workflow appends its own audit record from its
// own Debrief phase now (see each child's _writeAuditRecord), so appending here too would
// put the same run on the dashboard twice — `v2/*.jsonl` is read line-by-line, so a
// duplicate line is a duplicate run in every count, cost total, and average.
//
// What survives is the patch, because the conductor is the only party that can measure it:
// wall-clock either side of the `workflow()` call (tighter than the child's own startTs
// span) and the `budget.spent()` delta for that stage. Never throws — telemetry must not
// fail a run.
async function finalizeStageTelemetry(skill, { telemetryPath, auditRecords, durationMs, outputTokens }) {
  if (!telemetryPath) {
    log(`Telemetry: ${skill} returned no telemetryPath — nothing to patch`)
    return
  }
  const records = (Array.isArray(auditRecords) ? auditRecords : [auditRecords]).filter(Boolean)
  if (!records.length) {
    // The child returned no record, which now means its own write never happened either.
    // Say so loudly: this is the Phase 1a regression, not a missing conductor step.
    log(`Telemetry: ${skill} returned no audit record — its in-workflow write likely did not run`)
    return
  }
  const patch = {
    ...(durationMs != null ? { durationMs } : {}),
    ...(outputTokens != null ? { 'tokens.total.output': outputTokens } : {}),
  }
  if (!Object.keys(patch).length) {
    log(`Telemetry: ${skill} — nothing measured to patch, leaving the child's record as written`)
    return
  }
  await agent(
    `Patch measured fields onto the ${skill} stage's telemetry record. ONE step.

The record has ALREADY been written by the ${skill} workflow itself — do NOT append, do NOT
create the file, do NOT re-write the record. Appending duplicates the run on the dashboard.

File: ${telemetryPath}

Patch these fields onto the LAST line of that file (dotted keys are nested paths):
${JSON.stringify(patch, null, 2)}

If the file does not exist or is empty, report TELEMETRY_ERROR and stop — a missing file
means the workflow's own write failed, and that is a finding to surface, not to paper over.

Use this exact command shape, passing the JSON via argv (never via shell interpolation):

python3 -c "
import json, sys
def set_nested(d, dotted, value):
    keys = dotted.split('.')
    for k in keys[:-1]:
        if k not in d or not isinstance(d[k], dict): d[k] = {}
        d = d[k]
    d[keys[-1]] = value
path, fields = sys.argv[1], json.loads(sys.argv[2])
lines = open(path).readlines()
if lines:
    last = json.loads(lines[-1])
    for k, v in fields.items():
        set_nested(last, k, v) if '.' in k else last.__setitem__(k, v)
    lines[-1] = json.dumps(last) + '\\n'
    open(path, 'w').writelines(lines)
" <path> <fields-json>

Report "TELEMETRY_OK" or "TELEMETRY_ERROR: <reason>".`,
    { label: `telemetry-${skill}`, phase: 'Summary', model: 'claude-haiku-4-5-20251001', effort: 'low' }
  )
}

// ── Phase 1: Intake ───────────────────────────────────────────────────────────
phase('Intake')
let intakeManifestPath = resumeArtifacts.intakeManifestPath || null
let intakeManifest = null

// Ticket text. The wrapper may pass it in; otherwise Intake fetches it below so
// the runbook stays self-contained. Declared out here because the Plan phase
// falls back to it when the intake manifest has no groundedReality (XS/S/M).
let ticketInput = a.ticketInput || null

const _skipIntake = shouldSkipStage(resumeNextStage, 'intake', ['plan', 'implement', 'pr'], intakeManifestPath)
if (_skipIntake) {
  log(`Skipping Intake (resumed — manifest at ${intakeManifestPath})`)
} else {
  if (!ticketInput) {
    const ticket = await agent(
      `Fetch Jira issue ${issueKey} and return its text.

Use the Atlassian MCP tool getJiraIssue with:
  cloudId: '${a.cloudId || 'fandango.atlassian.net'}'
  issueIdOrKey: '${issueKey}'
  fields: ['summary', 'description', 'issuetype', 'parent', 'project']
  responseContentFormat: 'markdown'

Return the summary verbatim and the description verbatim — do NOT paraphrase,
summarize, or shorten. The description is the harness's primary input; losing
detail here degrades every downstream stage.`,
      { label: 'fetch-ticket', phase: 'Intake', effort: 'low',
        schema: {
          type: 'object',
          required: ['summary', 'description'],
          properties: {
            summary:     { type: 'string' },
            description: { type: 'string' },
          },
        },
      }
    )
    if (!ticket?.summary) {
      return { finalStatus: 'ERROR', errorMessage: `Could not fetch ticket ${issueKey} from Jira`, stageRecords, summary: assembleRunSummary(stageRecords) }
    }
    ticketInput = `${ticket.summary}\n\n${ticket.description || ''}`
  }

  log(`Running harness-intake for ${issueKey} (${ticketInput.length} chars of ticket text)`)
  const _t0 = await nowMs('intake-start')
  const _tok0 = budget.spent()

  const intakeResult = await workflow(
    { scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-intake/workflow.js' },
    {
      ...childTelemetryArgs,
      startTs:  _t0 != null ? String(_t0) : (a.startTs || null),
      input:    ticketInput,
      issueKey,
      repoPath: worktreePath,
      cloudId:  a.cloudId || null,
      refine:   null,
    }
  )

  const _t1 = await nowMs('intake-end')
  const _intakeDur = (_t0 != null && _t1 != null) ? _t1 - _t0 : null
  await finalizeStageTelemetry('harness-intake', {
    telemetryPath: intakeResult?.telemetryPath,
    auditRecords:  intakeResult?.auditRecord,
    durationMs:    _intakeDur,
    outputTokens:  budget.spent() - _tok0,
  })

  if (intakeResult?.cliSummary) log(intakeResult.cliSummary)

  intakeManifest = intakeResult?.intakeManifest || null
  if (!intakeManifest) {
    return { finalStatus: 'ERROR', errorMessage: 'harness-intake returned no intakeManifest', stageRecords, summary: assembleRunSummary(stageRecords) }
  }

  // The child workflow returns the manifest object; writing it is the wrapper's
  // job, so the conductor does it. Path format matches harness-intake SKILL.md §6.
  intakeManifestPath = `${worktreePath}/docs/manifests/${repo}__harness-intake__${issueKey}__${runTs}__manifest.json`
  await agent(
    `Write this JSON to the path below, prettified with 2-space indent. Create parent
directories first (mkdir -p). Overwrite if it exists. Do not modify the content.

Path: ${intakeManifestPath}

Content:
${JSON.stringify(intakeManifest, null, 2)}

Report "MANIFEST_OK" or "MANIFEST_ERROR: <reason>".`,
    { label: 'write-intake-manifest', phase: 'Intake', model: 'claude-haiku-4-5-20251001', effort: 'low' }
  )

  stageRecords.push({
    skill: 'harness-intake',
    status: intakeResult?.status ?? null,
    outcome: intakeResult?.status ? String(intakeResult.status).toUpperCase().startsWith('COMPLETE') ? 'COMPLETE' : String(intakeResult.status).toUpperCase() : 'COMPLETE',
    size: intakeResult?.size ?? null,
    durationMs: _intakeDur ?? 0,
    cost: intakeResult?.auditRecord?.cost ?? null,
  })

  // Size L means the ticket needs splitting into multiple plan groups. That path
  // exists in harness-plan (gatedIntake.groups) but has never run end-to-end
  // through this conductor — surface rather than silently take an unproven path.
  if (intakeResult?.splitRequired) {
    log(`Intake returned splitRequired=true (size ${intakeResult.size}) — harness-run has not proven the L split path.`)
  }

  await writeCheckpoint('intake', 'plan', { ...resumeArtifacts, intakeManifestPath })
}

// ── Phase 2: Plan ─────────────────────────────────────────────────────────────
// Manifest-as-gospel: the intake manifest is passed straight through as
// gatedIntake. harness-plan already treats args.gatedIntake as authoritative for
// size and file scope (manifest supremacy) — it does not care whether a bridge
// stamped it, only that it is present.
phase('Plan')
let planManifestPath = resumeArtifacts.planManifestPath || null
let p1JsonPath = resumeArtifacts.p1JsonPath || null

const _skipPlan = shouldSkipStage(resumeNextStage, 'plan', ['implement', 'pr'], planManifestPath)
if (_skipPlan) {
  log(`Skipping Plan (resumed — manifest at ${planManifestPath})`)
} else {
  // On a resumed bridge-era run the manifest object isn't in memory — read it
  // from disk. Prefer a gated path if the old run-state has one; it is a
  // strictly enriched form of the raw intake manifest.
  const _intakeSourcePath = resumeArtifacts.intakeGatedPath || intakeManifestPath
  if (!intakeManifest) {
    log(`Reading intake manifest from disk: ${_intakeSourcePath}`)
    intakeManifest = await agent(
      `Read the file at: ${_intakeSourcePath}
Parse it as JSON and return the parsed object exactly as-is. Do not summarize,
reformat, or drop any field.`,
      { label: 'read-intake-manifest', phase: 'Plan', model: 'claude-haiku-4-5-20251001', effort: 'low',
        schema: { type: 'object', properties: { size: { type: 'string' } } } }
    )
    if (!intakeManifest) {
      return { finalStatus: 'ERROR', errorMessage: `Could not read intake manifest at ${_intakeSourcePath}`, stageRecords, summary: assembleRunSummary(stageRecords) }
    }
  }

  log(`Running harness-plan for ${issueKey} (manifest-as-gospel: size=${intakeManifest.size || '?'}, files=${(intakeManifest.files || []).length})`)
  const _t0 = await nowMs('plan-start')
  const _tok0 = budget.spent()

  // harness-plan's `input` is raw text, not a manifest — it sizes from it, regexes
  // the issue key out of it, and slugs the plan from its first line. buildPlanInput
  // renders the manifest back down to prose; the manifest object itself still goes
  // over as gatedIntake, which is what carries authoritative size and file scope.
  const _planInput = buildPlanInput(intakeManifest, { issueKey, ticketInput })

  if (_planInput.length < MIN_PLAN_INPUT_CHARS) {
    return { finalStatus: 'ERROR', errorMessage: `Refusing to call harness-plan with a near-empty input (${_planInput.length} chars, floor ${MIN_PLAN_INPUT_CHARS}). The intake manifest carried no groundedReality, no acList, and no ticket text was available.`, stageRecords, summary: assembleRunSummary(stageRecords) }
  }
  log(`Plan input: ${_planInput.length} chars (${intakeManifest.groundedReality?.summary ? 'groundedReality' : 'raw ticket text'}, ${(intakeManifest.acList || []).length} AC bullet(s))`)

  const planResult = await workflow(
    { scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-plan/workflow.js' },
    {
      ...childTelemetryArgs,
      startTs:      _t0 != null ? String(_t0) : (a.startTs || null),
      input:        _planInput,
      repoPath:     worktreePath,
      gatedIntake:  intakeManifest,   // manifest supremacy — authoritative size + file scope
      manifestEntry: null,
      forceplan:    true,             // conductor always wants a plan, even for XS
      refine:       null,
    }
  )

  const _t1 = await nowMs('plan-end')
  const _planDur = (_t0 != null && _t1 != null) ? _t1 - _t0 : null
  await finalizeStageTelemetry('harness-plan', {
    telemetryPath: planResult?.telemetryPath,
    auditRecords:  planResult?.auditRecords,
    durationMs:    _planDur,
    outputTokens:  budget.spent() - _tok0,
  })

  if (planResult?.cliSummary) log(planResult.cliSummary)

  // harness-plan writes its own plan files (its workflow spawns Write agents) and
  // returns manifestPath relative to repoPath. Build absolutes here — never ask a
  // subagent to construct absolute paths, it gets them wrong.
  const _manifestRel = planResult?.manifestPath || null
  planManifestPath = _manifestRel ? `${worktreePath}/${_manifestRel}` : null

  if (!planManifestPath) {
    return { finalStatus: 'ERROR', errorMessage: 'harness-plan did not return manifestPath', stageRecords, summary: assembleRunSummary(stageRecords) }
  }

  stageRecords.push({
    skill: 'harness-plan',
    status: planResult?.status ?? null,
    outcome: planResult?.status ? (String(planResult.status).toUpperCase().startsWith('COMPLETE') || String(planResult.status).toUpperCase() === 'PROPOSED' ? 'COMPLETE' : String(planResult.status).toUpperCase()) : 'COMPLETE',
    taskCount: planResult?.taskCount ?? null,
    planCount: planResult?.planCount ?? null,
    durationMs: _planDur ?? 0,
    cost: planResult?.auditRecords?.[planResult.auditRecords.length - 1]?.cost ?? null,
  })

  await writeCheckpoint('plan', 'implement', { ...resumeArtifacts, intakeManifestPath, planManifestPath, p1JsonPath })
}

// ── Phase 3: Implement ────────────────────────────────────────────────────────
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
    return { finalStatus: 'ERROR', errorMessage: 'Failed to read plan manifest for implement sequencing', stageRecords, summary: assembleRunSummary(stageRecords) }
  }

  // Resolve execution order via topological sort on dependsOn graph.
  const orderedPlans = orderPlansByDeps(extractPlanEntries(manifestReadResult))
  log(`Implement: ${orderedPlans.length} plan(s) to execute in order: ${orderedPlans.map(p => p.id).join(' → ')}`)

  // Walk plans sequentially — each plan's jsonPath is the input to harness-implement.
  // All plans share the same pre-provisioned worktree and branch.
  let allImplOutcomes = []
  for (const plan of orderedPlans) {
    // harness-implement takes planPath RELATIVE to repoPath — it joins them itself
    // (absJsonPath = `${args.repoPath}/${jsonPath}`). Passing an absolute path here
    // produces a doubled path and a failed read.
    //
    // planPathFor prefers the .md so implement's JSON-missing fallback stays live.
    const planRelPath = planPathFor(plan)
    log(`Running harness-implement for plan ${plan.id}: ${planRelPath}`)

    const _t0 = await nowMs(`impl-${plan.id}-start`)
    const _tok0 = budget.spent()

    const implResult = await workflow(
      { scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-implement/workflow.js' },
      {
        ...childTelemetryArgs,
        startTs:  _t0 != null ? String(_t0) : (a.startTs || null),
        planPath:     planRelPath,
        repoPath:     worktreePath,
        baseBranch,                  // pre-answered — implement must not prompt
        worktreePath,                // conductor-provisioned; skip `git worktree add`
        runBranch,
      }
    )

    const _t1 = await nowMs(`impl-${plan.id}-end`)
    const _implDur = (_t0 != null && _t1 != null) ? _t1 - _t0 : null
    await finalizeStageTelemetry(`harness-implement-${plan.id}`, {
      telemetryPath: implResult?.telemetryPath,
      auditRecords:  implResult?.auditRecord,
      durationMs:    _implDur,
      outputTokens:  budget.spent() - _tok0,
    })

    if (implResult?.cliSummary) log(implResult.cliSummary)

    const planOutcome = implResult?.status ? String(implResult.status).toUpperCase() : 'FAILED'
    allImplOutcomes.push(planOutcome)
    stageRecords.push({
      skill: 'harness-implement',
      planId: plan.id,
      status: implResult?.status ?? null,
      outcome: planOutcome,
      durationMs: _implDur ?? 0,
      cost: implResult?.auditRecord?.cost ?? null,
    })

    // Stop the loop on failure — don't run G2 if G1 failed
    if (planOutcome === 'FAILED' || planOutcome === 'UNKNOWN' || planOutcome === 'CRASHED') {
      log(`Implement: plan ${plan.id} returned ${planOutcome} — stopping implement loop`)
      break
    }
  }

  // Overall implement outcome: COMPLETE only if all plans completed
  implOutcome = allImplOutcomes.every(o => o === 'COMPLETE') ? 'COMPLETE'
    : allImplOutcomes.some(o => o === 'PARTIAL') ? 'PARTIAL'
    : 'FAILED'

  await writeCheckpoint('implement', 'pr', { ...resumeArtifacts, intakeManifestPath, planManifestPath, p1JsonPath })
}

// Don't push a branch or open a PR off a failed implement — surface instead.
if (implOutcome === 'FAILED') {
  log(`Implement returned FAILED — stopping before PR. Worktree left in place at ${worktreePath} for inspection.`)
  const failSummary = assembleRunSummary(stageRecords)
  return {
    finalStatus: 'FAILED',
    exitPhase: 'Implement',
    runId,
    parentRunId,
    runBranch,
    worktreeName: activeWorktreeName,
    stateFilePath,
    prUrl: null,
    testsPassed: false,
    stageRecords,
    summary: failSummary,
  }
}

// ── Phase 4: Push + Draft PR ──────────────────────────────────────────────────
phase('PR')
log(`Pushing branch and opening DRAFT PR`)
const prResult = await agent(
  `You are the harness-run conductor. Implementation is complete. Create a DRAFT PR.

GUARDRAILS — NEVER cross these:
- DRAFT PR only. NEVER merge, NEVER force-push, NEVER touch main/master.
- Base branch: ${baseBranch} (the feature branch, NOT main/master)
- Push branch: ${runBranch}

Steps:
1. Verify there is something to push:
     git -C ${worktreePath} log --oneline origin/${baseBranch}..${runBranch}
   If that returns NO commits, stop and report {"prUrl": null, "noCommits": true} —
   do not push an empty branch or open an empty PR.
2. git -C ${worktreePath} push -u origin ${runBranch}
3. Run tests BEFORE opening the PR so the result can go in the body:
     cd ${worktreePath} && npm test
   Capture pass/fail and the last ~20 lines of output.
4. gh pr create --draft --title "harness: ${issueKey} auto-migration (${runTs})" --base ${baseBranch} --head ${runBranch} --body "Auto-generated by harness-run. Ticket: ${issueKey}. Run: ${runId}. Tests: <PASS|FAIL>. Review before merging."
5. Capture the PR URL from gh output.

Return JSON: {"prUrl": "...", "testsPassed": true/false, "testOutput": "...", "noCommits": false}`,
  { label: 'draft-pr', phase: 'PR', effort: 'low' }
)

const prParsed = parseAgentJson(prResult)
if (prResult == null) log('PR stage agent died (no result) — recording FAILED and continuing to the summary so the run stays resumable.')
stageRecords.push({ skill: 'harness-pr', outcome: prParsed.prUrl ? 'COMPLETE' : 'FAILED', durationMs: 0 })

// ── Phase 5: Summary ──────────────────────────────────────────────────────────
phase('Summary')
const summary = assembleRunSummary(stageRecords)

const summaryBox = [
  '╭─ harness-run summary ──────────────────────────────────',
  `│ Run:       ${runId}`,
  parentRunId ? `│ Parent:    ${parentRunId}` : null,
  `│ Ticket:    ${issueKey}`,
  `│ Branch:    ${runBranch}`,
  `│ Worktree:  ${activeWorktreeName}`,
  `│ PR:        ${prParsed.prUrl || (prParsed.noCommits ? '(not created — no commits on branch)' : '(not created)')}`,
  `│ Tests:     ${prParsed.testsPassed ? 'PASS' : 'FAIL'}`,
  `│ Status:    ${summary.finalStatus}`,
  `│ Cost:      ~$${summary.totalCostUsd}`,
  `│ Duration:  ${Math.round(summary.totalDurationMs / 60000)}min`,
  '╰────────────────────────────────────────────────────────',
].filter(Boolean).join('\n')

log(summaryBox)

return {
  finalStatus: summary.finalStatus,
  runId,
  parentRunId,
  runBranch,
  worktreeName: activeWorktreeName,
  stateFilePath,
  prUrl: prParsed.prUrl || null,
  testsPassed: prParsed.testsPassed || false,
  stageRecords,
  summary,
  summaryBox,
}
