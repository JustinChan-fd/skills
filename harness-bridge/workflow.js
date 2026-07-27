export const meta = {
  name: 'harness-bridge',
  description: 'Confidence gate between harness skills: score an upstream artifact, run one adversarial skeptic, emit PROCEED/RE_ASK/EXIT + a gated manifest.',
  phases: [{ title: 'Score' }, { title: 'Skeptic' }, { title: 'Gate' }],
}

// ===== PURE (mirrors lib/) =====
// import() unavailable in workflow scripts (probe-confirmed). All lib/ logic inlined below.
// lib/ stays authoritative — if mirror and lib/ disagree, lib/ is right.

// -- lib/checks-common.js -------------------------------------------------------
const clamp01 = x => Math.max(0, Math.min(1, x))
const mean = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 1 // vacuous 1 for empty populations

// -- lib/checks-a.js ------------------------------------------------------------
const FILE_RE_A = /[\w./-]+\.[a-z]{1,4}\b/gi

function _subtasksOf(m) { return (m.groups || []).flatMap(g => g.subtasks || []) }
function _isL(m) { return m.size === 'L' }
function _migrationTarget(m) {
  const p = m.migrationPattern || ''
  const idx = p.indexOf('→')
  if (idx < 0) return null
  return (p.slice(idx + 1).trim().split(/\s+/)[0] || '').replace(/[^\w.]/g, '') || null
}
function _unionFilesA(m) {
  return new Set([...(m.files || []), ..._subtasksOf(m).flatMap(s => [...(s.files || []), ...(s.sampleFiles || [])])])
}
function _haystackA(m) {
  const parts = []
  for (const ac of m.acList || []) parts.push(ac.grepPattern || '', ac.shellCommand || '', ac.searchScope || '', ac.bullet || '')
  parts.push(m.scopePath || '', ...(m.files || []))
  for (const s of _subtasksOf(m)) parts.push(s.scopePath || '', ...(s.files || []), ...(s.sampleFiles || []))
  return parts.join('\n')
}

function _groundingEvidenceFresh(m) {
  const target = _migrationTarget(m)
  const researchTyped = (m.acList || []).filter(ac => ['grep', 'find', 'shell', 'read'].includes(ac.researchType))
  const evid = researchTyped.length
    ? mean(researchTyped.map(ac => ac.verifiedCount > 0 ? 1 : (ac.grepPattern || ac.shellCommand ? 0.5 : 0)))
    : 1
  if (!target) return clamp01(0.7 * evid + 0.3)
  const found = _haystackA(m).toLowerCase().includes(target.toLowerCase()) ? 1 : 0
  return clamp01(0.5 * found + 0.5 * evid)
}
function _filesPopulatedA(m) {
  if (!_isL(m)) return 1
  return mean(_subtasksOf(m).map(s => (s.files && s.files.length) ? 1 : 0))
}
function _acResearchExecutable(m) {
  const acs = m.acList || []
  if (!acs.length) return 0
  return mean(acs.map(ac => {
    if (ac.researchType === 'grep') return (ac.grepPattern || '').trim().length >= 2 ? 1 : 0
    if (ac.researchType === 'shell') return (ac.shellCommand || '').trim().length >= 4 ? 1 : 0
    if (ac.researchType === 'find' || ac.researchType === 'read') return (ac.shellCommand || ac.searchScope || '').trim().length >= 2 ? 1 : 0
    return 0
  }))
}
function _sizeCorroboration(m) {
  const acs = m.acList || []
  const totalVerified = acs.reduce((s, ac) => s + (ac.verifiedCount || 0), 0)
  const fileCount = (m.files?.length || 0) + _subtasksOf(m).reduce((s, x) => s + (x.fileCount || x.files?.length || 0), 0)
  const signals = [totalVerified, fileCount, acs.length].filter(x => x > 0)
  const corroborated = signals.length >= 2 ? 1 : 0
  const magnitude = Math.max(totalVerified, fileCount, acs.length)
  const proxy = magnitude > 60 ? 3 : magnitude > 15 ? 2 : magnitude > 4 ? 1 : 0
  const order = { XS: 0, S: 1, M: 2, L: 3 }
  const agree = m.size in order ? (Math.abs(order[m.size] - proxy) <= 1 ? 1 : 0) : 0
  return clamp01(0.6 * corroborated + 0.4 * agree)
}
function _acReferencedFilesCovered(m) {
  const files = [..._unionFilesA(m)]
  const refs = []
  for (const ac of m.acList || []) {
    const text = `${ac.bullet || ''} ${ac.searchScope || ''} ${ac.shellCommand || ''}`
    for (const mm of text.matchAll(FILE_RE_A)) {
      if (/\.(json|md|lock)$/i.test(mm[0])) continue
      refs.push(mm[0])
    }
  }
  if (!refs.length) return 1
  return mean(refs.map(r => files.some(f => f.endsWith(r) || f.includes(r)) ? 1 : 0))
}
function _claimTruthConsistency(m) {
  const acs = (m.acList || []).filter(ac => ac.verifiedCount != null && ac.ticketClaimedCount > 0)
  if (!acs.length) return 1
  return mean(acs.map(ac => Math.abs(ac.verifiedCount - ac.ticketClaimedCount) / ac.ticketClaimedCount <= 0.20 ? 1 : 0))
}
function _scopeGrounded(m) {
  const files = [..._unionFilesA(m)]
  const scopes = [m.scopePath, ...(m.acList || []).map(ac => ac.searchScope)].filter(Boolean)
  if (!scopes.length) return 0.5
  if (!files.length) return 0.25
  return mean(scopes.map(sc => files.some(f => f.startsWith(sc) || f.includes(sc)) ? 1 : 0))
}
function _sizeShapeConsistencyA(m) {
  if (!['XS', 'S', 'M', 'L'].includes(m.size)) return 0
  return (_isL(m) === ((m.groups || []).length > 0)) ? 1 : 0
}

const CHECKS_A = [
  { id: 'grounding-evidence-fresh',    weight: 24, fn: _groundingEvidenceFresh },
  { id: 'files-populated',             weight: 20, fn: _filesPopulatedA },
  { id: 'ac-research-executable',      weight: 18, fn: _acResearchExecutable },
  { id: 'size-corroboration',          weight: 12, fn: _sizeCorroboration },
  { id: 'ac-referenced-files-covered', weight: 10, fn: _acReferencedFilesCovered },
  { id: 'claim-truth-consistency',     weight: 8,  fn: _claimTruthConsistency },
  { id: 'scope-grounded',              weight: 5,  fn: _scopeGrounded },
  { id: 'size-shape-consistency',      weight: 3,  fn: _sizeShapeConsistencyA },
]

// -- lib/checks-b.js ------------------------------------------------------------
function _failsQualityContract(desc, tddRequired) {
  const d = desc || ''
  return !/what/i.test(d) || !/where/i.test(d) || !/how/i.test(d) || (tddRequired && !/done/i.test(d)) || !/```/.test(d)
}
function _failsThinSpec(desc) {
  const d = desc || ''
  const whereLen = (d.match(/where[:\s]+(.+?)(?=\n(?:what|how|done)|$)/is)?.[1] || '').trim().length
  const howLen = (d.match(/how[:\s]+(.+?)(?=\n(?:what|where|done)|$)/is)?.[1] || '').trim().length
  return whereLen < 20 || howLen < 20 || !/```/.test(d)
}
const FILELINE_RE = /([\w./-]+\.[a-z]{1,4}):(\d+)/i
const IMPORT_RE = /(?:from|require\()\s*['"]([^'"]+)['"]/g
const ASSERT_RE = /(expect\(|assert|toBe|toEqual|===|\.status\b|status\s*\(?\s*\d{3}|resolves|rejects)/i

function _taskSpecCompleteness(a) {
  const tasks = a.tasks || []
  if (!tasks.length) return 0
  return mean(tasks.map(t => (!_failsQualityContract(t.description, t.tddRequired) && !_failsThinSpec(t.description)) ? 1 : 0))
}
function _taskFilesPresentBounded(a) {
  const tasks = a.tasks || []
  if (!tasks.length) return 0
  return mean(tasks.map(t => {
    const n = (t.files || []).length
    if (n === 0) return 0
    if (n <= 3) return 1
    return clamp01(3 / n)
  }))
}
function _whereResolvesToFiles(a) {
  const tasks = a.tasks || []
  if (!tasks.length) return 0
  return mean(tasks.map(t => {
    const where = (t.description || '').match(/where[:\s]+(.+?)(?=\n(?:what|how|done)|$)/is)?.[1] || ''
    const m2 = where.match(FILELINE_RE)
    if (!m2) return 0
    return (t.files || []).some(f => f.endsWith(m2[1]) || f.includes(m2[1])) ? 1 : 0.5
  }))
}
function _companionEditClosure(a) {
  const tasks = a.tasks || []
  const allFiles = new Set(tasks.flatMap(t => t.files || []))
  const refs = []
  for (const t of tasks) for (const mm of (t.description || '').matchAll(IMPORT_RE)) {
    const p = mm[1]
    if (p.startsWith('.') || p.includes('/')) refs.push(p.split('/').pop())
  }
  if (!refs.length) return 1
  return mean(refs.map(r => [...allFiles].some(f => f.includes(r)) ? 1 : 0))
}
function _tddDoneLiteralAssertion(a) {
  const tdd = (a.tasks || []).filter(t => t.tddRequired)
  if (!tdd.length) return 1
  return mean(tdd.map(t => {
    const done = (t.description || '').match(/done[:\s]+([\s\S]+?)$/is)?.[1] || ''
    return ASSERT_RE.test(done) ? 1 : 0
  }))
}
function _manifestDagConsistency(a) {
  const plans = a.plans || []
  if (!plans.length) return 0
  const ids = new Set(plans.map(p => p.id))
  const resolvable = plans.every(p => (p.dependsOn || []).every(d => d !== p.id && ids.has(d)))
  const anyDep = plans.some(p => (p.dependsOn || []).length > 0)
  const exec = a.execution
  const execOk = plans.length === 1 ? exec === 'sequential'
    : anyDep ? (exec === 'sequential' || exec === 'mixed') : exec === 'parallel'
  return clamp01((resolvable ? 0.6 : 0) + (execOk ? 0.4 : 0))
}
function _concernAtomicity(a) {
  const tasks = a.tasks || []
  if (!tasks.length) return 1
  return mean(tasks.map(t => {
    const d = t.description || ''
    const doneCount = (d.match(/done[:\s]/gi) || []).length
    const done = d.match(/done[:\s]+([\s\S]+?)$/is)?.[1] || ''
    const chained = /\band\b/i.test(done) && done.length > 60
    return (doneCount <= 1 && !chained) ? 1 : 0
  }))
}
function _sizeShapeConsistencyB(a) {
  if (!a.size) return 0.5
  return ['XS', 'S', 'M', 'L'].includes(a.size) ? 1 : 0
}

const CHECKS_B = [
  { id: 'task-spec-completeness',      weight: 30, fn: _taskSpecCompleteness },
  { id: 'task-files-present-bounded',  weight: 20, fn: _taskFilesPresentBounded },
  { id: 'where-resolves-to-files',     weight: 16, fn: _whereResolvesToFiles },
  { id: 'companion-edit-closure',      weight: 12, fn: _companionEditClosure },
  { id: 'tdd-done-literal-assertion',  weight: 10, fn: _tddDoneLiteralAssertion },
  { id: 'manifest-dag-consistency',    weight: 6,  fn: _manifestDagConsistency },
  { id: 'concern-atomicity',           weight: 3,  fn: _concernAtomicity },
  { id: 'size-shape-consistency',      weight: 3,  fn: _sizeShapeConsistencyB },
]

// -- lib/confidence.js ----------------------------------------------------------
const THRESHOLD = 85

function _scoreArtifact(artifact, handoff, weightsOverride) {
  const checks = handoff === 'A' ? CHECKS_A : CHECKS_B
  const weightOf = id => (weightsOverride && id in weightsOverride)
    ? weightsOverride[id]
    : checks.find(c => c.id === id).weight
  const perCheck = checks.map(c => {
    const value = clamp01(c.fn(artifact))
    const weight = weightOf(c.id)
    return { id: c.id, value: +value.toFixed(4), weight, contribution: +(value * weight).toFixed(2) }
  })
  const score = Math.round(perCheck.reduce((s, p) => s + p.contribution, 0))
  return { score, perCheck }
}

// -- lib/holepoker.js -----------------------------------------------------------
function _clampAdjusted(score, adjusted) {
  if (adjusted == null || Number.isNaN(adjusted)) return score
  return Math.min(score, Math.max(0, adjusted))
}

function _parseHolePoker(raw) {
  const empty = { adjustedScore: null, reasons: [] }
  if (!raw || typeof raw !== 'string') return empty
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  const brace = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (brace < 0 || close < brace) return empty
  try {
    const obj = JSON.parse(text.slice(brace, close + 1))
    const adjustedScore = typeof obj.adjustedScore === 'number' ? obj.adjustedScore : null
    const reasons = Array.isArray(obj.reasons) ? obj.reasons.map(String) : []
    return { adjustedScore, reasons }
  } catch {
    return empty
  }
}

// -- lib/verdict.js -------------------------------------------------------------
function _verdictFor(finalScore, retriesUsed) {
  if (finalScore >= THRESHOLD) return { verdict: 'PROCEED', action: 'advance' }
  if (retriesUsed === 0) return { verdict: 'RE_ASK', action: 'refine' }
  return { verdict: 'EXIT', action: 'stop' }
}

// -- lib/gated.js ---------------------------------------------------------------
function _gatedPathFor(origPath) {
  if (/-gated\.json$/.test(origPath)) return origPath
  return origPath.replace(/\.json$/, '-gated.json')
}
function _stampManifest(artifact, { confidence, verdict, flags = [], probeResults = [] }) {
  return { ...artifact, gated: true, confidence, verdict, flags, probeResults }
}

// -- lib/weights.js -------------------------------------------------------------
function _normalizeTo100(weights) {
  const ids = Object.keys(weights)
  const n = ids.length
  if (n === 0) return {}
  const total = ids.reduce((s, id) => s + weights[id], 0)
  // All-zero (or fully-zero-after-floor): equal split so every weight is valid
  if (total === 0) {
    const base = Math.floor(100 / n)
    const out = {}
    ids.forEach((id, i) => { out[id] = base })
    // Distribute remainder 1 point at a time to the first (100 % n) entries
    const rem = 100 - base * n
    for (let i = 0; i < rem; i++) out[ids[i]]++
    return out
  }
  // Proportional distribution
  const out = {}
  let acc = 0
  ids.forEach((id, i) => {
    if (i === ids.length - 1) out[id] = 100 - acc
    else { const v = Math.round(weights[id] * 100 / total); out[id] = v; acc += v }
  })
  // Floor every weight at 1: take excess off the largest weights (most room)
  const underflowIds = ids.filter(id => out[id] < 1)
  if (underflowIds.length > 0) {
    const deficit = underflowIds.reduce((s, id) => s + (1 - out[id]), 0)
    for (const id of underflowIds) out[id] = 1
    // Take deficit from largest weights, reducing each by at most (weight - 1)
    const sorted = ids.filter(id => !underflowIds.includes(id)).sort((a, b) => out[b] - out[a])
    let remaining = deficit
    for (const id of sorted) {
      if (remaining <= 0) break
      const room = out[id] - 1
      const take = Math.min(room, remaining)
      out[id] -= take
      remaining -= take
    }
  }
  return out
}
function _loadWeights(defaultChecks, override) {
  const base = {}
  for (const c of defaultChecks) base[c.id] = c.weight
  if (!override) return base
  const merged = { ...base }
  for (const [id, w] of Object.entries(override)) if (id in merged) merged[id] = w
  // Clamp each merged weight to [1,60] before normalizing so huge/negative overrides
  // cannot produce zero or negative weights via the proportional distribution.
  for (const id of Object.keys(merged)) merged[id] = Math.max(1, Math.min(60, merged[id]))
  return _normalizeTo100(merged)
}

// -- lib/models.js --------------------------------------------------------------
const MODEL = {
  opus:   'claude-opus-5',
  sonnet: 'anthropic.claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
}

// -- lib/telemetry.js -----------------------------------------------------------
function _repoNameFromPath(repoPath) {
  if (!repoPath) return 'unknown-repo'
  return String(repoPath).replace(/\/$/, '').split('/').pop() || 'unknown-repo'
}
function _bridgeTelemetryPath({ homeDir, repo, issueKey, runTs }) {
  return `${homeDir}/Desktop/Repos/harness-telemetry/v2/${repo}__harness-bridge__${issueKey}__${runTs}.jsonl`
}
function _buildAppendCmd(telemetryPath, jsonLine) {
  const escaped = jsonLine.replace(/'/g, "'\\''")
  return `mkdir -p "$(dirname '${telemetryPath}')" && echo '${escaped}' >> '${telemetryPath}'`
}

// ===== END PURE =====

const a = args || {}
const handoff = a.handoff === 'B' ? 'B' : 'A'
const retriesUsed = a.retriesUsed || 0
const errorLog = []
let currentPhase = 'Score'

try {

function loadArtifact(h, raw) {
  if (h === 'A') return raw
  return { tasks: raw._tasks || [], plans: raw.plans || [], execution: raw.execution || 'sequential', size: raw.size || null }
}

currentPhase = 'Score'
phase('Score')
const artifact = loadArtifact(handoff, a.artifact || {})
const checks = handoff === 'A' ? CHECKS_A : CHECKS_B
const weights = _loadWeights(checks, a.weightsOverride || null)
const { score, perCheck } = _scoreArtifact(artifact, handoff, weights)
log(`JS confidence (handoff ${handoff}): ${score}/100`)

// Flags: any check whose contribution is far below its weight is a weak spot the skeptic should probe.
const flags = perCheck.filter(p => p.value < 0.5).map(p => p.id)

currentPhase = 'Skeptic'
phase('Skeptic')
// ONE adversarial skeptic. It may only LOWER the score. Give it the per-check breakdown + the artifact.
let adjustedScore = null
let reasons = []
try {
  const raw = await agent(
    `You are an adversarial reviewer. A pure-JS checklist scored an upstream ${handoff === 'A' ? 'intake' : 'plan'} artifact at ${score}/100 for readiness to hand to the next harness stage.

Per-check breakdown (id · value 0..1 · weight):
${perCheck.map(p => `- ${p.id}: ${p.value} · ${p.weight}`).join('\n')}

Artifact (JSON):
${JSON.stringify(artifact).slice(0, 12000)}

Your job: find holes the checklist missed — stale grounding, empty/placeholder files, assumed-but-unverified primitives, omitted companion edits, a concern folded into another task, single-source sizing. You may ONLY lower the score or leave it unchanged; you may NEVER raise it. If you find nothing, return the same score.

Respond with ONLY this JSON: {"adjustedScore": <int 0..${score}>, "reasons": ["...", "..."]}`,
    { label: `skeptic:${handoff}`, phase: 'Skeptic', model: MODEL.sonnet, effort: 'high' }
  )
  const parsed = _parseHolePoker(raw)
  adjustedScore = parsed.adjustedScore
  reasons = parsed.reasons
} catch (err) {
  errorLog.push({ phase: 'skeptic', message: String(err?.message || err), ts: a.runTs, severity: 'warn' })
}

const finalScore = _clampAdjusted(score, adjustedScore)
const probeResults = reasons.map(r => ({ source: 'skeptic', reason: r }))
log(`Final confidence after skeptic: ${finalScore}/100${adjustedScore != null && adjustedScore < score ? ` (lowered from ${score})` : ''}`)

currentPhase = 'Gate'
phase('Gate')
const { verdict, action } = _verdictFor(finalScore, retriesUsed)
log(`Verdict: ${verdict} → ${action}`)

// Stamp + path. gatedPath is derived from the primary artifact path passed by the wrapper.
const gatedPath = a.artifactPath ? _gatedPathFor(a.artifactPath) : null
const stamped = _stampManifest(a.artifact || {}, { confidence: finalScore, verdict, flags, probeResults })

// Telemetry
const repo = a.repo || _repoNameFromPath(a.repoPath)
const worktree = a.worktree || null
const branch = a.branch || null
const telemetryPath = _bridgeTelemetryPath({ homeDir: a.homeDir, repo, issueKey: a.issueKey || 'intake', runTs: a.runTs })
const record = {
  schemaVersion: '2.0',
  runId: a.runId,
  skill: 'harness-bridge',
  skillsCommit: a.skillsCommit || 'unknown',
  ts: a.runTs,
  status: verdict === 'PROCEED' ? 'COMPLETE' : verdict,
  outcome: verdict,
  sourceIssue: a.issueKey || null,
  repo,
  worktree,
  branch,
  parentRunId:   a.parentRunId   || null,
  repoPath: a.repoPath || null,
  handoff,
  confidence: finalScore,
  jsScore: score,
  verdict,
  action,
  flags,
  probeResults,
  perCheck,
  weights,
  retries: retriesUsed,
  errorLog,
  weightChanges: a.weightChanges || [],
}
const line = JSON.stringify(record)

const cliSummary = [
  `╭─ harness-bridge (handoff ${handoff}) ─────────────`,
  `│ JS score:    ${score}/100`,
  `│ Final score: ${finalScore}/100  (threshold ${THRESHOLD})`,
  `│ Verdict:     ${verdict} → ${action}`,
  flags.length ? `│ Weak checks: ${flags.join(', ')}` : `│ Weak checks: none`,
  reasons.length ? `│ Skeptic:     ${reasons.slice(0, 3).join(' | ')}` : `│ Skeptic:     no holes found`,
  `╰────────────────────────────────────────────`,
].join('\n')

return {
  score, finalScore, verdict, action, perCheck, flags, probeResults,
  gatedPath, stamped, telemetryPath, telemetryLine: line, appendCmd: _buildAppendCmd(telemetryPath, line),
  outputTokensTotal: null, agentCountByModel: { [MODEL.sonnet]: 1 },
  cliSummary,
}
} catch (err) {
  const isKilled = err.message?.includes('abort') || err.message?.includes('cancel') || err.message?.includes('interrupt')
  const crashStatus = isKilled ? 'CRASHED' : 'FAILED'
  const crashRecord = {
    schemaVersion: '2.0',
    runId:         a.runId || null,
    skill:         'harness-bridge',
    skillsCommit:  a.skillsCommit || 'unknown',
    ts:            a.runTs || 'unknown',
    status:        crashStatus,
    outcome:       'failed',
    sourceIssue:   a.issueKey || null,
    repo:          a.repo || (a.repoPath || '').replace(/\/$/, '').split('/').pop() || null,
    worktree:      a.worktree || null,
    branch:        a.branch || null,
    parentRunId:   a.parentRunId || null,
    repoPath:      a.repoPath || null,
    handoff:       a.handoff || null,
    confidence:    null,
    jsScore:       null,
    verdict:       crashStatus,
    action:        'stop',
    flags:         [],
    probeResults:  [],
    failedAtPhase: currentPhase,
    error:         err.message || String(err),
    retries:       a.retriesUsed || 0,
    errorLog:      [...errorLog, { phase: currentPhase, message: String(err?.message || err), ts: a.runTs || 'unknown', severity: 'error' }],
    weightChanges: a.weightChanges || [],
  }
  const crashLine = JSON.stringify(crashRecord)
  const crashTelemetryPath = _bridgeTelemetryPath({ homeDir: a.homeDir, repo: crashRecord.repo, issueKey: a.issueKey || 'unknown', runTs: a.runTs || 'unknown' })
  throw Object.assign(err, {
    telemetryPath:  crashTelemetryPath,
    telemetryLine:  crashLine,
    appendCmd:      _buildAppendCmd(crashTelemetryPath, crashLine),
    verdict:        crashStatus,
    action:         'stop',
  })
}
