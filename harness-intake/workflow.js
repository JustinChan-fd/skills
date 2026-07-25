export const meta = {
  name: 'harness-intake',
  description: 'Universal harness entry point — classifies work, synthesizes ACs, sizes ticket, and either exits early with an intake manifest (XS/S/M) or continues into split phase (L)',
  phases: [
    { title: 'Triage', detail: 'Haiku+Sonnet×2 parallel — layer-discover (Haiku), classify (Sonnet), ac-synth (Sonnet); then AC verify + suspicious-zero retry + merge' },
    { title: 'Research',          detail: 'Sonnet — dual fan-out: per-AC strategy agents + per-layer structure agents (L only)' },
    { title: 'Split Design',      detail: 'Sonnet — per-layer designer fan-out + dedup + AC stub injection + deterministic merge + AC verify (L only)' },
    { title: 'Verify',            detail: 'Sonnet — holistic manifest check: AC coverage, file count plausibility, stub review flags (L only)' },
    { title: 'Debrief',           detail: 'Haiku — audit log, quality check, CLI summary' },
  ],
}

// args: { input, cloudId?, issueKey?, repoPath, today? }
// input: raw ticket text (summary + description)
// cloudId + issueKey: passed by SKILL.md for audit labeling only
// repoPath: absolute path to the repo
//
// Returns:
//   XS/S/M: { splitRequired: false, intakeManifest, size, cliSummary }
//   L:      { splitRequired: true,  intakeManifest (with groups[]), size, ... }

const input = args.input
const repoPath = args.repoPath
const issueKey = args.issueKey || ''

if (!input) throw new Error('harness-intake requires input')
if (!repoPath) throw new Error('harness-intake requires repoPath')

// ─── Philosophy (injected into every agent prompt) ────────────────────────────
const PHILOSOPHY = `
── CORE RULES ───────────────────────────────────────────────────────────────────
1. PREFER SCRIPTING OVER REASONING.
   File counts come from grep/wc, not from reading the ticket.
   Layer lists come from ls src/, not from inference.
   If a number can be verified by a shell command, you MUST verify it.

2. PREFER MORE, SMALLER SUBTASKS OVER FEWER, LARGER ONES.
   Max 8 files per subtask — hard cap.
   When on the fence between grouping two concerns vs splitting them — always split.
   A subtask too small costs one extra harness-plan run (cheap).
   A subtask too large causes an architect stall (expensive, unpredictable).
   Default to atomic. Never justify grouping to reduce subtask count.

3. CHALLENGE TICKET CLAIMS — never accept ticket-stated file counts at face value.
   When a ticket says "N files", grep the repo yourself and compare.
   If your grep finds a DIFFERENT count (>20% discrepancy), your grep wins — not the ticket.
   For migrations: grep for DIRECT pattern usage (e.g. "from 'axios'") SEPARATELY
   from broad references (e.g. "axios"). Also check ALTERNATIVE patterns that
   bypass the target (e.g. bare "fetch(" calls for an axios→clientFetch migration).
   The DIRECT usage count drives subtask planning — not the broad count, not the ticket.
`

// ─── Token tracking ───────────────────────────────────────────────────────────
const workflowStartTokens = budget.spent()
const tokensByModel = {}
const agentCountByModel = {}

async function trackedAgent(prompt, opts) {
  const before = budget.spent()
  const result = await agent(prompt, opts)
  const m = opts.model || sonnetModel
  tokensByModel[m] = (tokensByModel[m] || 0) + (budget.spent() - before)
  agentCountByModel[m] = (agentCountByModel[m] || 0) + 1
  return result
}

// Era marker — bump when the skill paradigm changes significantly.
const SKILLS_SCHEMA_VERSION = 'spec-v8'

// ===== PURE (mirrors lib/) =====
// lib/telemetry.js — keep identical. import() unavailable in workflow scripts (probe-confirmed).
// NOTE: process.env is unavailable in the workflow runtime — home dir is derived from repoPath.
function _repoNameFromPath(p) {
  if (!p) return 'unknown-repo'
  return String(p).replace(/\/$/, '').split('/').pop() || 'unknown-repo'
}
function _slugFromInput(text) {
  if (!text) return 'greenfield'
  const first = String(text).split('\n').map(l => l.trim()).find(l => l.length > 0) || ''
  const slug = first.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim()
    .replace(/\s+/g, '-').replace(/-{2,}/g, '-').slice(0, 40).replace(/-+$/, '')
  return slug || 'greenfield'
}
// Format: {telemetryDir}/logs/{repo}__{skill}__{ticket}__{timestamp}.jsonl
// Split on __ to get exactly [repo, skill, ticket, timestamp]
function _buildTelemetryPath({ repoPath, skill, issueKey, rawText, timestamp }) {
  const repo    = _repoNameFromPath(repoPath)
  const key     = issueKey || _slugFromInput(rawText)
  const ts      = timestamp || 'unknown-ts'
  const homeDir = (repoPath || '').replace(/\/Desktop\/Repos\/[^/]+\/?$/, '') || '/tmp'
  const teleDir = `${homeDir}/Desktop/Repos/harness-telemetry`
  return `${teleDir}/logs/${repo}__${skill}__${key}__${ts}.jsonl`
}
function _buildAppendCmd(path, jsonLine) {
  const escaped = jsonLine.replace(/'/g, "'\\''")
  return `mkdir -p "$(dirname '${path}')" && echo '${escaped}' >> '${path}'`
}
const _TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$/
function _ejectTestFiles(subtasks, issueKey, scopePath) {
  const ejected = []
  for (const s of subtasks) {
    if (!s.isMigration) continue
    const testFiles = (s.files || []).filter(f => _TEST_FILE_RE.test(f))
    if (testFiles.length === 0) continue
    s.files = s.files.filter(f => !_TEST_FILE_RE.test(f))
    s.estimatedFileCount = s.files.length
    ejected.push(...testFiles)
  }
  const unique = [...new Set(ejected)]
  if (unique.length === 0) return []
  const chunks = unique.length > 8
    ? Array.from({ length: Math.ceil(unique.length / 8) }, (_, i) => unique.slice(i * 8, (i + 1) * 8))
    : [unique]
  return chunks.map((chunk, i) => ({
    title: `${issueKey ? issueKey + ': ' : ''}Update test mocks for migration${chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : ''}`,
    description: 'Update test file mocks to reflect the migration pattern change. These files were ejected from production migration batches.',
    scopePath: scopePath || '',
    files: chunk,
    estimatedFileCount: chunk.length,
    targetSize: chunk.length <= 4 ? 'XS' : 'S',
    isMigration: false,
    isCleanup: true,
    isValidation: false,
    isDeferred: false,
    needsReview: false,
  }))
}
// lib/dedup.js — keep identical.
function makeAbsPrefix(repoPath) {
  if (!repoPath) return null
  return String(repoPath).replace(/\/$/, '') + '/'
}
function toRelPath(f, absPrefix) {
  if (!absPrefix || !f) return f
  return f.startsWith(absPrefix) ? f.slice(absPrefix.length) : f
}
function dedupeByOverlapRatio(subtasks, absPrefix) {
  const sorted = [...subtasks].sort((a, b) => (b.scopePath || '').length - (a.scopePath || '').length)
  const seen = new Set()
  const result = []
  for (const s of sorted) {
    const rawFiles = s.files || []
    if (rawFiles.length === 0) { result.push(s); continue }
    const files = absPrefix ? rawFiles.map(f => toRelPath(f, absPrefix)) : rawFiles
    const sf = new Set(files)
    const overlap = [...sf].filter(f => seen.has(f)).length / sf.size
    if (overlap < 0.5) {
      result.push(absPrefix ? { ...s, files } : s)
      for (const f of sf) seen.add(f)
    }
  }
  return result
}
function dedupeByFileSet(subtasks) {
  const seenKeys = new Map()
  const result = []
  for (const s of subtasks) {
    const files = s.files || []
    if (files.length === 0) { result.push(s); continue }
    const key = files.slice().sort().join('|')
    if (seenKeys.has(key)) {
      const idx = seenKeys.get(key)
      if (s.title.length < result[idx].title.length) {
        result[idx] = { ...result[idx], title: s.title }
      }
    } else {
      seenKeys.set(key, result.length)
      result.push(s)
    }
  }
  return result
}
function categorizeVerifyIssue(issue) {
  if (issue.startsWith('verify: AC UNCOVERED:')) {
    return 'ac-gap:' + issue.slice('verify:'.length)
  }
  return issue
}
// lib/classify.js — keep identical.
function classifyAcBullet(bullet) {
  const text = bullet.toLowerCase()
  const isCleanup    = text.includes('remov') || text.includes('delet') || text.includes('package.json') || text.includes('npm install')
  const hasActionVerb = text.includes('migrat') || text.includes('replac') || text.includes('updat') || text.includes('add ') || text.includes('remov') || text.includes('delet')
  const isValidation = text.includes('verif') || text.includes('confirm') || text.includes('passing') || text.includes('clean install') || text.includes('ran clean') || text.includes('baseline') || (!hasActionVerb && /\bcheck\b/.test(text)) || /\bremains?\b/.test(text)
  const isDeferred   = text.includes('abortcontroller') || text.includes('timeout') || text.includes('npm ')
  const isValidationFinal = isValidation || (isCleanup && isDeferred)
  const isMigration  = !isCleanup && !isValidationFinal && !isDeferred
  return { isCleanup, isValidation: isValidationFinal, isDeferred, isMigration }
}
// lib/dedup.js (continued) — collapseDeferred + capCoordinatorInput — keep identical.
function collapseDeferred(drafts) {
  const nonDeferred = drafts.filter(s => !s.isDeferred)
  const deferred    = drafts.filter(s => s.isDeferred)
  if (deferred.length === 0) return nonDeferred
  const rep = deferred.reduce((a, b) => a.title.length <= b.title.length ? a : b)
  return [...nonDeferred, { ...rep, files: [], estimatedFileCount: 0 }]
}
function capCoordinatorInput(drafts, max = 20) {
  if (drafts.length <= max) return drafts
  return [...drafts]
    .sort((a, b) => (b.scopePath || '').length - (a.scopePath || '').length)
    .slice(0, max)
}
// lib/conflict.js — keep identical.
function resolveFileConflicts(drafts) {
  if (drafts.length === 0) return []
  const stubs = drafts.filter(s => (s.files || []).length === 0)
  const real  = drafts.filter(s => (s.files || []).length > 0)
  if (real.length === 0) return stubs
  const merged = _mergeHighOverlap(real)
  const sorted = [...merged].sort((a, b) => {
    const lenDiff = (b.scopePath || '').length - (a.scopePath || '').length
    if (lenDiff !== 0) return lenDiff
    return (a.files || []).length - (b.files || []).length
  })
  const claimed = new Set()
  const resolved = sorted.map(s => {
    const kept = (s.files || []).filter(f => !claimed.has(f))
    for (const f of kept) claimed.add(f)
    return { ...s, files: kept, estimatedFileCount: kept.length }
  })
  return [...resolved.filter(s => s.files.length > 0), ...stubs]
}
function _mergeHighOverlap(subtasks) {
  const result = []
  const absorbed = new Set()
  for (let i = 0; i < subtasks.length; i++) {
    if (absorbed.has(i)) continue
    let current = subtasks[i]
    for (let j = i + 1; j < subtasks.length; j++) {
      if (absorbed.has(j)) continue
      const a = new Set(current.files)
      const b = new Set(subtasks[j].files)
      const intersection = [...a].filter(f => b.has(f)).length
      const maxSize = Math.max(a.size, b.size)
      const overlapRatio = maxSize === 0 ? 0 : intersection / maxSize
      if (overlapRatio > 0.8) {
        const unionFiles = [...new Set([...current.files, ...subtasks[j].files])]
        const title = current.title.length >= subtasks[j].title.length ? current.title : subtasks[j].title
        current = { ...current, title, files: unionFiles, estimatedFileCount: unionFiles.length }
        absorbed.add(j)
      }
    }
    result.push(current)
  }
  return result
}
function isAcFilesCoveredByExisting(acFiles, existingSubtasks) {
  if (!acFiles || acFiles.length === 0) return false
  const existingFileSet = new Set(existingSubtasks.flatMap(s => s.files || []))
  const covered = acFiles.filter(f => existingFileSet.has(f)).length
  return covered / acFiles.length >= 0.5
}
// lib/status.js — keep identical.
const _INTAKE_OUTCOME_MAP = {
  COMPLETE:                   'success',
  COMPLETE_FRAMING_CORRECTED: 'success',
  COMPLETE_WITH_STUBS:        'partial',
  PROPOSED_WITH_GAPS:         'partial',
  CRASHED:                    'failed',
  FAILED:                     'failed',
}
function toOutcome(status) { return _INTAKE_OUTCOME_MAP[status] ?? 'failed' }
// lib/conflict.js (propagateManifestFields) — keep identical.
function propagateManifestFields(subtasks, migrationPattern, size) {
  for (const s of subtasks) {
    if (!s.migrationPattern && migrationPattern) s.migrationPattern = migrationPattern
    if (!s.size) s.size = s.targetSize || size
  }
}
// lib/routing.js (routingFor) — keep identical.
const _SIZE_ROUTING = {
  XS: { concurrency: 3, skipLayerResearch: true  },
  S:  { concurrency: 3, skipLayerResearch: false },
  M:  { concurrency: 5, skipLayerResearch: false },
  L:  { concurrency: 5, skipLayerResearch: false },
}
function routingFor(size) {
  const r = _SIZE_ROUTING[size]
  if (!r) throw new Error(`routingFor: unknown size "${size}"`)
  return r
}
// ===== END PURE =====

// telemetryPath is set on first writeAuditRecord call (needs a timestamp agent),
// then reused so all writes within a run land in the same file.
let _telemetryPath = null

async function writeAuditRecord(status, extra = {}) {
  const outputTokensTotal = budget.spent() - workflowStartTokens
  const estimatedCostUsd = parseFloat(
    Object.entries(tokensByModel).reduce((sum, [model, tokens]) => {
      const rate = model.includes('opus') ? 75 : model.includes('haiku') ? 1.25 : 15
      return sum + (tokens / 1_000_000) * rate
    }, 0).toFixed(4)
  )
  // durationMs: computed via shell since Date.now() is unavailable in workflow scripts
  // startTs is passed as args.startTs (epoch ms string) from SKILL.md before Workflow() call
  const [durationMs, skillsCommit, runTs] = await Promise.all([
    args.startTs
      ? agent(
          `Run: python3 -c "import time; print(int(time.time()*1000) - ${args.startTs})"\nReturn { ms: <number> }`,
          { label: 'duration-ms', phase: 'Debrief', model: haikuModel, effort: 'low',
            schema: { type: 'object', required: ['ms'], properties: { ms: { type: 'number' } } } }
        ).then(r => { const v = r?.ms; return (v != null && v > 0 && v < 36_000_000) ? v : null }).catch(() => null)
      : Promise.resolve(null),
    agent(
      `Run: git -C ~/Desktop/Repos/skills rev-parse HEAD 2>/dev/null || git -C ~/.claude/skills rev-parse HEAD 2>/dev/null || echo unknown\nReturn { sha: "<40-char hex or unknown>" }`,
      { label: 'skills-commit', phase: 'Debrief', model: haikuModel, effort: 'low',
        schema: { type: 'object', required: ['sha'], properties: { sha: { type: 'string' } } } }
    ).then(r => r?.sha || null).catch(() => null),
    _telemetryPath
      ? Promise.resolve(null)
      : agent(
          `Run: python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))"\nReturn { ts: "<compact-utc-timestamp>" }`,
          { label: 'run-ts', phase: 'Debrief', model: haikuModel, effort: 'low',
            schema: { type: 'object', required: ['ts'], properties: { ts: { type: 'string' } } } }
        ).then(r => r?.ts || null).catch(() => null),
  ])
  if (!_telemetryPath) {
    _telemetryPath = _buildTelemetryPath({ repoPath, skill: 'harness-intake', issueKey, rawText: input, timestamp: runTs })
  }
  const record = JSON.stringify({
    ts: args.today || 'unknown',
    skill: 'harness-intake',
    skillsSchemaVersion: SKILLS_SCHEMA_VERSION,
    telemetryVersion: 'v2',
    skillsCommit,
    status,
    outcome: toOutcome(status),
    sourceIssue: issueKey || 'unknown',
    repo: _repoNameFromPath(repoPath),
    repoPath: repoPath || null,
    branch: null,
    durationMs,
    subagentTokens: null,   // patched by skill after Workflow() returns
    agentCountByModel,
    outputTokensTotal,
    ...extra,
  })
  const legacyCmd  = `echo '${record.replace(/'/g, "'\\''")}' >> ~/.claude/harness-intake-runs.jsonl`
  const telemetryCmd = _buildAppendCmd(_telemetryPath, record)
  await agent(
    `Append an audit record to two JSONL files. Use the Bash tool only. Run both commands:\n1. ${legacyCmd}\n2. ${telemetryCmd}\nReturn { appended: true }.`,
    {
      label: 'audit-write',
      phase: 'Debrief',
      model: haikuModel,
      effort: 'low',
      schema: { type: 'object', required: ['appended'], properties: { appended: { type: 'boolean' } } },
    }
  )
}

const opusModel   = 'claude-opus-4-8'
const sonnetModel = 'anthropic.claude-sonnet-4-6'
const haikuModel  = 'anthropic.claude-haiku-4-5-20251001'

// ─── Schemas ──────────────────────────────────────────────────────────────────

// Work Intelligence output — replaces Intake
// Derives complete AC set (inferred if missing) and per-AC research strategies
// so Research agents are driven by acceptance criteria, not just layer structure.
const WORK_INTEL_SCHEMA = {
  type: 'object',
  required: ['workType', 'size', 'splitRequired', 'reasoning', 'scopePath', 'sourceTitle', 'migrationPattern', 'repoLayers', 'acList'],
  properties: {
    workType:         { type: 'string', enum: ['migration', 'feature', 'bug', 'refactor', 'cleanup', 'non-deployable'] },
    size:             { type: 'string', enum: ['XS', 'S', 'M', 'L'] },
    splitRequired:    { type: 'boolean' },
    reasoning:        { type: 'string' },
    scopePath:        { type: 'string', description: 'primary directory scope, e.g. src/client — empty string if whole repo' },
    sourceTitle:      { type: 'string', description: 'first line of ticket text, max 80 chars' },
    migrationPattern: { type: 'string', description: 'old→new pattern for migrations, e.g. "axios → clientFetch", else empty' },
    repoLayers:       { type: 'array', items: { type: 'string' }, description: 'layer names from ls src/ — populated by shell command, not inferred' },
    acList: {
      type: 'array',
      description: 'One entry per acceptance criterion — explicit from ticket or inferred from description. Every entry drives a research agent.',
      items: {
        type: 'object',
        required: ['bullet', 'researchType', 'grepPattern', 'searchScope'],
        properties: {
          bullet:            { type: 'string', description: 'the AC text verbatim or inferred' },
          researchType:      { type: 'string', enum: ['grep', 'find', 'read', 'shell'], description: 'grep=pattern search; find=directory enumerate; read=single file; shell=custom command' },
          grepPattern:       { type: 'string', description: 'grep -rl pattern, e.g. "axios" or "fetch(" — empty if researchType is not grep' },
          searchScope:       { type: 'string', description: 'path relative to repoPath to constrain this AC search, e.g. src/client/middleware — empty = use scopePath' },
          shellCommand:      { type: 'string', description: 'full shell command for researchType=shell or find, e.g. "find src/client/middleware -name auth.js"' },
          ticketClaimedCount: { type: 'number', description: 'file count the ticket text states — 0 if ticket does not state a count' },
          verifiedCount:     { type: 'number', description: 'actual file count from running the shell command — filled in by Work Intelligence after running the command; 0 if command found nothing' },
          claimConflict:     { type: 'boolean', description: 'true when abs(verifiedCount - ticketClaimedCount) / max(ticketClaimedCount,1) > 0.20 — ticket framing cannot be trusted for this AC' },
        },
      },
    },
  },
}

// Per-layer researcher output (one agent per layer)
const LAYER_SCHEMA = {
  type: 'object',
  required: ['name', 'path', 'fileCount', 'files', 'sublayers', 'canRunInParallel', 'dependsOnLayers'],
  properties: {
    name:             { type: 'string' },
    path:             { type: 'string' },
    fileCount:        { type: 'number' },
    files:            { type: 'array', items: { type: 'string' } },
    sublayers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'path', 'fileCount', 'files'],
        properties: {
          name:      { type: 'string' },
          path:      { type: 'string' },
          fileCount: { type: 'number' },
          files:     { type: 'array', items: { type: 'string' } },
        },
      },
    },
    canRunInParallel:  { type: 'boolean' },
    dependsOnLayers:   { type: 'array', items: { type: 'string' } },
  },
}

// Per-layer designer output — no groupId (merge agent assigns that)
const LAYER_SUBTASKS_SCHEMA = {
  type: 'object',
  required: ['layer', 'subtasks'],
  properties: {
    layer: { type: 'string' },
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'description', 'scopePath', 'files', 'estimatedFileCount', 'targetSize', 'isMigration', 'isCleanup', 'isValidation', 'isDeferred'],
        properties: {
          title:              { type: 'string' },
          description:        { type: 'string' },
          scopePath:          { type: 'string' },
          files:              { type: 'array', items: { type: 'string' } },
          estimatedFileCount: { type: 'number' },
          targetSize:         { type: 'string', enum: ['XS', 'S'] },
          isMigration:        { type: 'boolean' },
          isCleanup:          { type: 'boolean' },
          isValidation:       { type: 'boolean' },
          isDeferred:         { type: 'boolean', description: 'true for non-file-migration work: new feature additions, package.json changes, install verification, config changes — always G2, always small' },
        },
      },
    },
  },
}

const SPLIT_SCHEMA = {
  type: 'object',
  required: ['execution', 'subtasks'],
  properties: {
    execution: { type: 'string', enum: ['parallel', 'sequential', 'mixed'] },
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'description', 'layer', 'scopePath', 'files', 'estimatedFileCount', 'groupId', 'canRunInParallel', 'dependsOn', 'targetSize', 'isDeferred', 'needsReview'],
        properties: {
          title:              { type: 'string' },
          description:        { type: 'string' },
          layer:              { type: 'string' },
          scopePath:          { type: 'string' },
          files:              { type: 'array', items: { type: 'string' } },
          estimatedFileCount: { type: 'number' },
          groupId:            { type: 'string' },
          canRunInParallel:   { type: 'boolean' },
          dependsOn:          { type: 'array', items: { type: 'string' } },
          targetSize:         { type: 'string', enum: ['XS', 'S', 'M'] },
          isDeferred:         { type: 'boolean', description: 'true for non-file-migration work: additions, config, package changes, install steps — always G2' },
          needsReview:        { type: 'boolean', description: 'true for auto-generated stubs where human must verify scope before Jira creation' },
        },
      },
    },
  },
}

// Per-AC strategy researcher output (one agent per AC in acList)
const AC_RESEARCH_SCHEMA = {
  type: 'object',
  required: ['acBullet', 'researchType', 'files', 'fileCount', 'findings'],
  properties: {
    acBullet:     { type: 'string' },
    researchType: { type: 'string' },
    files:        { type: 'array', items: { type: 'string' } },
    fileCount:    { type: 'number' },
    findings:     { type: 'string', description: 'one-line summary of what was found' },
  },
}

// AC coverage verification output
const AC_VERIFY_SCHEMA = {
  type: 'object',
  required: ['covered', 'partial', 'missing'],
  properties: {
    covered: { type: 'array', items: { type: 'string' } },
    partial: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
  },
}

// ─── Phase 0: Triage — 4-phase split ─────────────────────────────────────────
// Phase A: layer-discover + classify + ac-synth run in parallel (Haiku + Sonnet + Sonnet, ~30s)
//   layer-discover: Haiku, shell only — ls src/ → repoLayers[]
//   classify:       Sonnet, NO TOOLS  — workType, size, pattern, scopePath from ticket text
//   ac-synth:       Sonnet, no tools  — acList with per-AC research strategies
// Phase B: one Haiku verifier per AC — batched at 5 (~10s)
// Phase C: suspicious-zero retry — re-verify any migration grep that returned 0 (~5-10s, Haiku)
// Phase D: merge agent — always Sonnet, assembles all three Phase A outputs (~15s)
// Total expected: ~45-60s vs 5min for the single-agent approach.

// LAYER_DISCOVER_SCHEMA — Haiku shell-only agent, no reasoning
const LAYER_DISCOVER_SCHEMA = {
  type: 'object',
  required: ['repoLayers'],
  properties: {
    repoLayers: { type: 'array', items: { type: 'string' }, description: 'directory names from ls src/ (or app/ or lib/)' },
  },
}

// CLASSIFY_SCHEMA — pure reasoning, no shell, no repoLayers
const CLASSIFY_SCHEMA = {
  type: 'object',
  required: ['workType', 'size', 'splitRequired', 'reasoning', 'scopePath', 'sourceTitle', 'migrationPattern'],
  properties: {
    workType:         { type: 'string', enum: ['migration', 'feature', 'bug', 'refactor', 'cleanup', 'non-deployable'] },
    size:             { type: 'string', enum: ['XS', 'S', 'M', 'L'] },
    splitRequired:    { type: 'boolean' },
    reasoning:        { type: 'string' },
    scopePath:        { type: 'string' },
    sourceTitle:      { type: 'string' },
    migrationPattern: { type: 'string' },
  },
}

// AC_SYNTH_SCHEMA — the synthesized AC list (no shell execution — pure reasoning)
const AC_SYNTH_SCHEMA = {
  type: 'object',
  required: ['acList'],
  properties: {
    acList: {
      type: 'array',
      items: {
        type: 'object',
        required: ['bullet', 'researchType', 'grepPattern', 'searchScope', 'shellCommand', 'ticketClaimedCount'],
        properties: {
          bullet:             { type: 'string' },
          researchType:       { type: 'string', enum: ['grep', 'find', 'read', 'shell'] },
          grepPattern:        { type: 'string' },
          searchScope:        { type: 'string' },
          shellCommand:       { type: 'string' },
          ticketClaimedCount: { type: 'number', description: 'file count the ticket states — 0 if none stated' },
        },
      },
    },
  },
}

// AC_VERIFY_ITEM_SCHEMA — one verifier per AC (Phase B Haiku agents)
const AC_VERIFY_ITEM_SCHEMA = {
  type: 'object',
  required: ['acBullet', 'verifiedCount', 'claimConflict', 'rawOutput'],
  properties: {
    acBullet:      { type: 'string' },
    verifiedCount: { type: 'number' },
    claimConflict: { type: 'boolean' },
    rawOutput:     { type: 'string', description: 'first 20 lines of command output for traceability' },
  },
}

let currentPhase = 'init'
let auditWritten = false
const partialState = {}
function trackPhase(name) { currentPhase = name; phase(name) }

try {

trackPhase('Triage')

// Phase A: layer-discover + classify + ac-synth in parallel (3 agents, all no-tools except layer-discover)
const [layerDiscoverResult, classifyResult, acSynthResult] = await parallel([
  () => trackedAgent(
    `You are a repo layer discoverer for harness-intake. Run exactly ONE shell command and return.
Run: ls ${repoPath}/src 2>/dev/null || ls ${repoPath}/app 2>/dev/null || ls ${repoPath}/lib 2>/dev/null
Return the directory names as repoLayers[]. Do not read any files or run any other commands.`,
    { label: 'layer-discover', phase: 'Triage', model: haikuModel, effort: 'low', schema: LAYER_DISCOVER_SCHEMA }
  ),
  () => trackedAgent(
    `You are a work classifier for harness-intake. Do NOT use any tools or run any shell commands.
${PHILOSOPHY}

CLASSIFY the work type from the ticket text:
  migration     — replace pattern A with B across N files
  feature       — add new capability
  bug           — fix broken behavior
  refactor      — restructure without behavior change
  cleanup       — remove dead code/imports/deps
  non-deployable — config, CI, docs, tooling only

SIZE (estimate from ticket scope alone — NOT final, a separate shell pass will verify):
  XS: 1-3 files  |  S: <10 files  |  M: 10-30 files  |  L: 30+ files or cross-cutting
  HARD RULE: when between two sizes, choose the LARGER.
  splitRequired = true ONLY for L.

SCOPE PATH: set from explicit directory mentions in ticket text (e.g. "src/client"), else empty string.
MIGRATION PATTERN: "old → new" for migrations (e.g. "axios → clientFetch"), else empty string.
SOURCE TITLE: first line of ticket text, max 80 chars.

INPUT:
${input}`,
    { label: 'classify', phase: 'Triage', model: sonnetModel, effort: 'high', schema: CLASSIFY_SCHEMA }
  ),
  () => trackedAgent(
    `You are an AC synthesizer for harness-intake. Do NOT use any tools or run any shell commands.
${PHILOSOPHY}

Your job: synthesize the complete acceptance criteria list from the ticket text alone.
For each AC, derive the research strategy that a separate verifier will run to check the file count.

STRATEGY TYPES:
  grep:  files matching a code pattern — set grepPattern (literal string, e.g. "from 'axios'")
  find:  enumerate files in a directory — set shellCommand (e.g. "find src/client/middleware -type f")
  read:  read a specific file — set shellCommand (e.g. "cat package.json")
  shell: any other verification — set shellCommand

AC FRAMING RULES — implementation ACs must be phrased as ACTIONS, not outcomes:
- WRONG: "No axios imports remain in src/client/"  ← outcome framing → classified as validation (G3)
- WRONG: "Verify all fetch() calls are standardized" ← outcome framing → classified as validation (G3)
- RIGHT: "Migrate axios imports to clientFetch in src/client/" ← action framing → classified as migration (G1)
- RIGHT: "Replace bare fetch() calls with clientFetch in src/client/" ← action framing → migration (G1)
- Validation ACs (verify, confirm, check, no X remains) are only valid for shell-only checks like "npm install completes cleanly"
- If the ticket states an AC in outcome framing, rephrase it as an action before adding it to the list

GRANULARITY RULES — read these before writing any AC:
- One AC per distinct CONCERN — do not split the same concern by directory or layer
- "Migrate axios imports in src/client/" is ONE AC, not four directory-scoped ACs
- Migrations typically need 5-8 ACs total. If you have more than 8, you are over-splitting.
- HARD CAP: generate at most 10 ACs regardless of ticket complexity.
- Ask: "is this AC testing a different thing than the others, or the same thing in a different place?" Same thing = merge it.

CRITICAL rules for AC strategies:
- Every AC that implies file changes needs its own strategy
- ACs about axios imports → grep grepPattern="from 'axios'" or grepPattern="require('axios')"
- ACs about bare fetch() calls → grep grepPattern="fetch(" (separate from axios grep)
- For migrations — ALWAYS add an AC for bypass patterns even if not in ticket
- ticketClaimedCount: the number explicitly stated in the ticket text (0 if none stated)
- searchScope: path relative to repoPath to constrain this search (empty = use top-level scope)
- If ACs are explicit in ticket: rephrase as actions if needed, then use them. If partial/missing: INFER from description.

INPUT:
${input}`,
    { label: 'ac-synth', phase: 'Triage', model: sonnetModel, effort: 'medium', schema: AC_SYNTH_SCHEMA }
  ),
])

if (!layerDiscoverResult) throw new Error('Layer discovery agent failed — cannot proceed')
if (!classifyResult)      throw new Error('Classify agent failed — cannot proceed')
if (!acSynthResult)       throw new Error('AC synthesis agent failed — cannot proceed')

// Phase B: one Haiku verifier per AC, batched at 5
const acSynthList = acSynthResult.acList || []
const acSearchRoot = classifyResult.scopePath
  ? `${repoPath}/${classifyResult.scopePath}`
  : `${repoPath}/src`

const acVerifyItems = []
for (let i = 0; i < acSynthList.length; i += 5) {
  const batch = acSynthList.slice(i, i + 5)
  const batchResults = await parallel(batch.map((ac, batchIdx) => () => trackedAgent(
    `You are an AC verifier for harness-intake. Run exactly ONE shell command to verify this AC's file count.
${PHILOSOPHY}

AC: "${ac.bullet}"
RESEARCH TYPE: ${ac.researchType}
${ac.grepPattern  ? `GREP PATTERN: ${ac.grepPattern}` : ''}
${ac.searchScope  ? `SEARCH SCOPE: ${repoPath}/${ac.searchScope}` : `SEARCH SCOPE: ${acSearchRoot}`}
${ac.shellCommand ? `SHELL COMMAND: ${ac.shellCommand}` : ''}

EXECUTE one command (pick by researchType):
  grep:  timeout 15 grep -rl "${ac.grepPattern || '.'}" ${ac.searchScope ? repoPath + '/' + ac.searchScope : acSearchRoot}/ 2>/dev/null | wc -l
  find:  ${ac.shellCommand || `find ${ac.searchScope ? repoPath + '/' + ac.searchScope : acSearchRoot} -type f 2>/dev/null | wc -l`}
  read:  ${ac.shellCommand || `cat ${repoPath}/package.json`} (count relevant lines)
  shell: ${ac.shellCommand || 'echo 0'}

RULES:
- verifiedCount = integer from your command output
- claimConflict = true when abs(verifiedCount - ${ac.ticketClaimedCount}) / max(${ac.ticketClaimedCount},1) > 0.20 AND ticketClaimedCount > 0
- rawOutput = first 20 lines of what the command produced (for traceability)

Return AC_VERIFY_ITEM_SCHEMA.`,
    { label: `ac-verify:${i + batchIdx}`, phase: 'Triage', model: haikuModel, effort: 'low', schema: AC_VERIFY_ITEM_SCHEMA }
  )))
  acVerifyItems.push(...batchResults)
}

// Merge verify results back into the AC list
const acListWithVerify = acSynthList.map((ac, idx) => {
  const verify = acVerifyItems[idx]
  return {
    ...ac,
    verifiedCount: verify?.verifiedCount ?? 0,
    claimConflict: verify?.claimConflict ?? false,
  }
})

// Phase C — broader-pattern retry for ALL grep ACs (un-skippable)
// Runs on every AC where researchType=grep, regardless of verifiedCount.
// Phase C runs broader pattern variants to catch files missed by the initial grep.
//
// Audit trail: every grep AC gets suspiciousZeroRetried=true after this phase.
// The structural validator will FAIL with PHASE_C_NOT_RUN if any grep AC has
// verifiedCount=0 and suspiciousZeroRetried !== true — that is the Run G/K failure mode.
//
// The three retry variants (run in order, stop at first non-zero):
//   1. No --include filters — catches test files excluded by Phase B extension filter
//   2. Case-insensitive (-i) + no filters — catches casing variants
//   3. First word of pattern only — catches import alias or wrapper renames
const SUSPICIOUS_ZERO_SCHEMA = {
  type: 'object',
  required: ['acBullet', 'retriedCount', 'retriedPattern', 'rawOutput'],
  properties: {
    acBullet:       { type: 'string' },
    retriedCount:   { type: 'number' },
    retriedPattern: { type: 'string', description: 'which variant found the highest count, or "phase-b-confirmed" if phase B already found files' },
    rawOutput:      { type: 'string' },
  },
}

const grepAcs = acListWithVerify.filter(ac => ac.researchType === 'grep' && ac.grepPattern)

// Mark all non-grep ACs as not applicable (no retry needed, not a gap)
for (const ac of acListWithVerify) {
  if (ac.researchType !== 'grep' || !ac.grepPattern) ac.suspiciousZeroRetried = 'n/a'
}

log(`Phase C: running broader-pattern retry on ${grepAcs.length} grep AC(s) (all, not just zeros)`)
const retrySearchRoot = classifyResult.scopePath ? `${repoPath}/${classifyResult.scopePath}` : `${repoPath}/src`

const phaseCResults = []
for (let i = 0; i < grepAcs.length; i += 5) {
  const batch = grepAcs.slice(i, i + 5)
  const batchResults = await parallel(batch.map(ac => () => {
    // AC already found files in Phase B — run the same 3 variants to get the broader count,
    // but we expect them to agree (or find more). Either way we stamp retried=true.
    const base      = (ac.grepPattern || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const firstWord = base.split(/\s+/)[0]
    return trackedAgent(
      `You are a grep re-verifier for harness-intake. Run 3 broader grep variants on this AC to confirm the file count is not under-counted by the Phase B include filters.
AC: "${ac.bullet}"
PHASE B COUNT: ${ac.verifiedCount} (may be under-counted if test files were excluded)
SEARCH ROOT: ${retrySearchRoot}

Run ALL THREE commands:
1. timeout 15 grep -rl "${base}" ${retrySearchRoot}/ 2>/dev/null | wc -l
2. timeout 15 grep -irl "${base}" ${retrySearchRoot}/ 2>/dev/null | wc -l
3. timeout 15 grep -rl "${firstWord}" ${retrySearchRoot}/ 2>/dev/null | wc -l

SELECTION RULES (apply in order):
- retriedCount = highest of commands 1 and 2 only (full-pattern variants)
- Only use command 3 (first-word) if commands 1 AND 2 returned 0 — first-word is a last-resort fallback, its broad pattern inflates counts on common words like "fetch" or "axios"
- If commands 1 and 2 are both 0 and command 3 > 0: retriedCount = command 3 result, retriedPattern = "first-word"
- If commands 1 or 2 > 0: retriedCount = max(cmd1, cmd2), retriedPattern = "no-filter" or "case-insensitive" (whichever was higher)
- If all three = 0: retriedCount = 0, retriedPattern = "phase-b-confirmed"
rawOutput = the actual file paths from the highest-count command (first 5 lines).
Return SUSPICIOUS_ZERO_SCHEMA.`,
      { label: `phase-c:${ac.grepPattern.slice(0, 25).replace(/\s+/g, '-')}`, phase: 'Triage', model: haikuModel, effort: 'low', schema: SUSPICIOUS_ZERO_SCHEMA }
    )
  }))
  phaseCResults.push(...batchResults)
}

for (let i = 0; i < grepAcs.length; i++) {
  const ac = grepAcs[i]
  const retry = phaseCResults[i]
  const entry = acListWithVerify.find(a => a.bullet === ac.bullet)
  if (!entry) continue
  entry.suspiciousZeroRetried = true  // audit trail — Phase C ran on this AC
  if (!retry) continue
  if (retry.retriedCount > entry.verifiedCount) {
    if (retry.retriedPattern === 'first-word') {
      // first-word fallback is last-resort only — it matches too broadly (comments,
      // package.json, test mocks, partial identifiers). Do NOT update verifiedCount.
      // Flag for audit but don't let it inflate size decisions or count totals.
      entry.phaseCFirstWordOnly = true
      log(`  Phase C ↳ "${ac.bullet.slice(0, 60)}": first-word found ${retry.retriedCount} (broad match, not authoritative — verifiedCount stays ${entry.verifiedCount})`)
    } else {
      log(`  Phase C ↳ "${ac.bullet.slice(0, 60)}": ${entry.verifiedCount} → ${retry.retriedCount} via ${retry.retriedPattern}`)
      entry.verifiedCount = retry.retriedCount
      entry.claimConflict = false
      entry.suspiciousZeroResolved = true
      entry.zeroRetryVariant = retry.retriedPattern
    }
  } else if (entry.verifiedCount === 0) {
    entry.suspiciousZeroConfirmed = true
    log(`  Phase C ↳ "${ac.bullet.slice(0, 60)}": still 0 after all variants — genuinely zero or pattern wrong`)
  }
  // else: phase B count confirmed — no change needed
}

const hasSuspiciousZeroResolved = acListWithVerify.some(ac => ac.suspiciousZeroResolved)
const hasConflicts = acListWithVerify.some(ac => ac.claimConflict === true)
const conflictingAcList = acListWithVerify.filter(ac => ac.claimConflict === true)

// Phase D: merge — always Sonnet (WORK_INTEL_SCHEMA is complex; Haiku retry risk outweighs savings)
// Speed gain comes from Phase A/B/C parallelism, not from downgrading the merge tier
const mergeModel = sonnetModel

// Size downgrade guard: if suspicious zeros were resolved upward, the classify result
// may have already estimated L. We inject an explicit guard into the merge prompt
// so a previously-zero-but-now-resolved AC cannot cause the merge to downgrade size.
const sizeDowngradeGuard = hasSuspiciousZeroResolved
  ? `\n\nSIZE DOWNGRADE GUARD (CRITICAL): One or more ACs had their grep count corrected upward from 0 (suspicious-zero-resolved=true). You MUST NOT downgrade the size based on the originally-reported 0 counts. Use the corrected verifiedCount values. If the corrected total >= 30 files, size=L and splitRequired=true is mandatory.`
  : ''

const workIntelResult = await trackedAgent(
  `You are the Work Intelligence merge agent for harness-intake.${hasConflicts ? '\n\nCONFLICT ESCALATION: One or more ACs have claimConflict=true — the ticket\'s stated file counts are wrong. You MUST re-reason about size and scope using the VERIFIED counts, not the ticket text.' : ' No claim conflicts detected — assemble the final output.'}${sizeDowngradeGuard}
Do not use any tools.

CLASSIFY RESULT:
${JSON.stringify(classifyResult, null, 2)}

REPO LAYERS (from shell discovery):
${JSON.stringify(layerDiscoverResult.repoLayers)}

AC LIST WITH VERIFICATION:
${JSON.stringify(acListWithVerify, null, 2)}
${hasConflicts ? `
CONFLICT RESOLUTION RULES:
- Re-derive size from verifiedCount totals, not ticket claims
- If verified total < 30 but ticket claims ≥ 30, downgrade size accordingly
- Re-scope any AC where claimConflict=true to use verifiedCount
- Update reasoning to explain the discrepancy
- migrationPattern stays as classified unless verification proves it wrong` : ''}

Assemble the final WORK_INTEL_SCHEMA. Use the REPO LAYERS above for the repoLayers field. The acList must be the AC LIST WITH VERIFICATION above (preserve all fields including verifiedCount and claimConflict). The size, splitRequired, and reasoning must${hasConflicts ? ' be RE-DERIVED from verified counts' : ' match the classify result'}.`,
  { label: 'work-intel-merge', phase: 'Triage', model: mergeModel, effort: 'medium', schema: WORK_INTEL_SCHEMA }
)

if (!workIntelResult) throw new Error('Work Intelligence merge failed — cannot proceed')

const { workType, size, splitRequired, repoLayers, scopePath, acList } = workIntelResult
const ticketType = workType  // preserve compatibility with downstream references
const sourceTitle = workIntelResult.sourceTitle || input.split('\n')[0].slice(0, 80)

// Triage vs. grounded size — track when Work Intelligence overrides the triage estimate.
// classifyResult.size = ticket-text estimate (before grep verification)
// size = research-verified final size
const triageSize = classifyResult.size
const triageSizeOverride = (triageSize && triageSize !== size)
  ? { triageSize, groundedSize: size, reason: 'Work Intelligence re-derived from verified grep counts' }
  : null
if (triageSizeOverride) {
  log(`⚠️  Size override: triage estimated ${triageSize} → research verified ${size} (ticket claims corrected)`)
}

// Lock migrationPattern with shell verification — try progressively simpler patterns
// until one finds files, then use that as the authoritative pattern for the rest of the run.
// Prevents "axios → clientFetch" vs "api (axios singleton) → clientFetch" framing drift.
let migrationPattern = workIntelResult.migrationPattern || ''
if (migrationPattern && workIntelResult.workType === 'migration') {
  const verifyRoot = scopePath ? `${repoPath}/${scopePath}` : `${repoPath}/src`
  const rawPattern = migrationPattern.replace(/\s*[-→>]+.*$/, '').trim()
  // Try progressively simpler patterns: full → first word → first identifier
  const candidates = [
    rawPattern,
    rawPattern.split(/\s+/)[0],
    rawPattern.replace(/[^a-zA-Z0-9_$]/g, '').slice(0, 20),
  ].filter((p, i, arr) => p && arr.indexOf(p) === i)

  let lockedPattern = ''
  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const checkResult = await trackedAgent(
      `Run: timeout 15 grep -rl "${escaped}" ${verifyRoot}/ 2>/dev/null | wc -l\nReturn { count: <number> }`,
      { label: 'pattern-lock', phase: 'Triage', model: haikuModel, effort: 'low',
        schema: { type: 'object', required: ['count'], properties: { count: { type: 'number' } } } }
    )
    if ((checkResult?.count || 0) > 0) { lockedPattern = candidate; break }
  }
  if (lockedPattern && lockedPattern !== rawPattern) {
    log(`Pattern lock: "${rawPattern}" found 0 files — locked to simpler pattern "${lockedPattern}"`)
    migrationPattern = lockedPattern
  } else if (!lockedPattern) {
    log(`Pattern lock: no candidates found files under ${verifyRoot} — keeping classify result "${rawPattern}"`)
  } else {
    log(`Pattern lock: "${lockedPattern}" confirmed (found files under ${verifyRoot})`)
  }
}

// conflictingAcs already computed in Phase B before merge
const conflictingAcs = conflictingAcList
if (conflictingAcs.length > 0) {
  log(`⚠️  CLAIM CONFLICTS detected in ${conflictingAcs.length} AC(s) — ticket framing cannot be trusted for these:`)
  for (const ac of conflictingAcs) {
    log(`   AC: "${ac.bullet.slice(0, 70)}"  ticket claimed: ${ac.ticketClaimedCount}  verified: ${ac.verifiedCount}`)
  }
  log(`   Work Intelligence has re-derived AC scope from verified counts. Proceeding with ground-truth sizing.`)
}

log(`Work Intelligence: size=${size} splitRequired=${splitRequired} type=${workType}${migrationPattern ? ` pattern="${migrationPattern}"` : ''}${scopePath ? ` scope="${scopePath}"` : ''} layers=[${repoLayers.join(', ')}] acList=${acList.length} strategies${conflictingAcs.length > 0 ? ` ⚠️ ${conflictingAcs.length} claim conflict(s)` : ''}`)

// ─── Early exit for XS/S/M — emit intakeManifest, skip split phase ───────────
// intakeManifest is the typed handoff contract to harness-plan.
// harness-plan consumes it via the manifestEntry fast path, skipping its own Intake.

if (!splitRequired) {
  const outputTokensTotal = budget.spent() - workflowStartTokens
  const estimatedCostUsd = parseFloat(
    Object.entries(tokensByModel).reduce((sum, [model, tokens]) => {
      const rate = model.includes('opus') ? 75 : model.includes('haiku') ? 1.25 : 15
      return sum + (tokens / 1_000_000) * rate
    }, 0).toFixed(4)
  )

  // intakeManifest — full typed handoff for harness-plan
  const intakeManifest = {
    skill: 'harness-intake',
    sourceIssue: issueKey || null,
    sourceTitle,
    size,
    workType,
    migrationPattern,
    scopePath,
    acList,          // per-AC research strategies — harness-plan researcher uses these
    files: [],       // no file research at this stage for XS/S/M — harness-plan does it
    execution: 'sequential',
    groundedReality: null,  // no research run for XS/S/M — harness-plan researcher is ground truth
  }

  const nextCmd = issueKey
    ? `/harness-plan --intake <path-to-intake-manifest>`
    : `/harness-plan --intake <intake-manifest-path>`

  const triageSizeLine = triageSizeOverride
    ? `\n  triage:  estimated ${triageSizeOverride.triageSize} → verified ${triageSizeOverride.groundedSize} (ticket claims overridden by research)`
    : ''

  const skipSummary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
harness-intake
  status:  COMPLETE  ✅

  ticket:  ${issueKey || 'unknown'}
  size:    ${size}        cost:  ~$${estimatedCostUsd}
  type:    ${workType}${triageSizeLine}

  reason:  ${workIntelResult.reasoning}
  ac:      ${acList.length} criteria synthesized${migrationPattern ? `  pattern: ${migrationPattern}` : ''}

  quality: ✓ clean
  next:    ${nextCmd}
  audit:   ~/.claude/harness-intake-runs.jsonl
           ~/Desktop/Repos/harness-telemetry/logs/  (run-specific file)
  tokens:  ${outputTokensTotal.toLocaleString()}  (~$${estimatedCostUsd} estimated)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

  auditWritten = true
  await writeAuditRecord('COMPLETE', {
    size,
    workType,
    acCount: acList.length,
    subtaskCount: 0,
    execution: 'sequential',
    framingConflicts: 0,
    triageSizeOverride,
  })
  log(skipSummary)
  return {
    splitRequired: false,
    size,
    intakeManifest,
    cliSummary: skipSummary,
  }
}

// ─── Phase 1: Research — dual fan-out (AC strategies + layer structure) ───────
// Stream 1: one agent per AC strategy — finds files/facts for each acceptance criterion
// Stream 2: one agent per repo layer — finds ALL in-scope files by structural layer
// Both run in parallel. Fan-in merges results; AC-covered files get acCoverage metadata.

trackPhase('Research')

const researchRouting = routingFor(size)
log(`Research routing: size=${size} concurrency=${researchRouting.concurrency} skipLayerResearch=${researchRouting.skipLayerResearch}`)

const searchRoot = scopePath
  ? `${repoPath}/${scopePath}`
  : `${repoPath}/src`

// Stream 1: AC-driven research — one agent per AC strategy, batched at 5 to avoid rate-limit stalls.
// Deferred and validation ACs are short-circuited in JS — they describe done-conditions or
// feature additions, not file sets to discover. Skipping the Haiku grep agent for these
// saves ~90s and ~60k tokens per deferred/validation AC (e.g. AbortController, npm install).
const acResearchResultsAll = []
for (let i = 0; i < acList.length; i += researchRouting.concurrency) {
  const batch = acList.slice(i, i + researchRouting.concurrency)
  const batchResults = await parallel(
    batch.map(ac => () => {
      const { isDeferred, isValidation } = classifyAcBullet(ac.bullet)
      if (isDeferred || isValidation) {
        // Skip research entirely — return empty result inline (no agent call, no tokens)
        log(`  ac-research skip (${isDeferred ? 'deferred' : 'validation'}): "${ac.bullet.slice(0, 60)}"`)
        return Promise.resolve({ acBullet: ac.bullet, researchType: ac.researchType, files: [], fileCount: 0, findings: 'skipped — deferred/validation AC does not need file discovery' })
      }
      return trackedAgent(
        `You are a shell-only AC researcher for harness-intake. Do not read any files.
${PHILOSOPHY}

YOUR ACCEPTANCE CRITERION: "${ac.bullet}"
RESEARCH TYPE: ${ac.researchType}
${ac.grepPattern ? `GREP PATTERN: ${ac.grepPattern}` : ''}
${ac.searchScope ? `SEARCH SCOPE: ${repoPath}/${ac.searchScope}` : `SEARCH SCOPE: ${searchRoot}`}
${ac.shellCommand ? `SHELL COMMAND: ${ac.shellCommand}` : ''}

REQUIRED (pick by researchType):
  grep:  timeout 15 grep -rl "${ac.grepPattern || '.'}" ${ac.searchScope ? repoPath + '/' + ac.searchScope : searchRoot}/ 2>/dev/null
         Capture ALL paths. Then wc -l for count.
  find:  ${ac.shellCommand || `find ${ac.searchScope ? repoPath + '/' + ac.searchScope : searchRoot} -type f 2>/dev/null`}
  read:  ${ac.shellCommand || `cat ${repoPath}/package.json`}
  shell: ${ac.shellCommand || 'echo "no command specified"'}

RULES:
- files[] must be the COMPLETE list — not a sample, not head -5
- If the command returns nothing, files=[] and fileCount=0 — do not invent files
- findings: one line summarising what you found (e.g. "found 26 files with fetch(")

Return AC_RESEARCH_SCHEMA.`,
        { label: `ac-research:${ac.bullet.slice(0, 40).replace(/\s+/g, '-')}`, phase: 'Research', model: haikuModel, effort: 'low', schema: AC_RESEARCH_SCHEMA }
      )
    })
  )
  acResearchResultsAll.push(...batchResults)
}
// Enforce acBullet from original acList — Haiku research agents occasionally put
// their findings summary (e.g. "Found 3 files in /Users/...") into acBullet instead
// of copying the original AC text. Since Phase 1 iterates acList in order and
// parallel() resolves in order, index alignment is guaranteed.
for (let i = 0; i < acResearchResultsAll.length; i++) {
  if (acResearchResultsAll[i] && acList[i]) acResearchResultsAll[i].acBullet = acList[i].bullet
}
// Normalize AC research file paths to repo-relative — grep returns absolute paths.
// Done once here so every downstream consumer (groupers, injection loops, stubs) sees clean paths.
const _absPrefix = makeAbsPrefix(repoPath)
for (const r of acResearchResultsAll) {
  if (r && r.files) r.files = r.files.map(f => toRelPath(f, _absPrefix))
}
const acResearchResults = acResearchResultsAll

// Stream 2: layer structure research — one agent per repo layer (existing behavior)
const patternGrepArg = migrationPattern
  ? migrationPattern.replace(/\s*[-→>]+.*$/, '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  : ''

// When scopePath is set, searchRoot is already scoped — repoLayers are `ls src/` subdirs
// and would produce paths like `src/client/client/` which don't exist.
// Use a single '' layer so the researcher greps searchRoot directly and discovers sublayers itself.
const layersToResearch = scopePath
  ? ['']
  : (repoLayers.length ? repoLayers : [''])

const layerResultsAll = []
for (let i = 0; !researchRouting.skipLayerResearch && i < layersToResearch.length; i += researchRouting.concurrency) {
  const batch = layersToResearch.slice(i, i + researchRouting.concurrency)
  const batchResults = await parallel(
    batch.map(layer => () => trackedAgent(
      `You are a shell-only layer researcher for harness-intake. Do not read any files.
${PHILOSOPHY}

SEARCH ROOT: ${searchRoot}${layer ? '/' + layer : ''}
${patternGrepArg ? `PATTERN: ${patternGrepArg}` : 'TICKET TYPE: non-migration — enumerate all source files by directory'}

REQUIRED COMMANDS (run ALL of these in order):
${patternGrepArg ? `1. timeout 15 grep -rl "${patternGrepArg}" ${searchRoot}${layer ? '/' + layer : ''}/ 2>/dev/null
   → capture the full list of matching paths (ALL paths, not just head -5)
   → if command times out or returns nothing, return files=[] fileCount=0
2. echo above output | wc -l → for fileCount
3. if fileCount > 8:
   ls ${searchRoot}${layer ? '/' + layer : ''}/ → enumerate subdirectories
   then timeout 10 grep -rl "${patternGrepArg}" ${searchRoot}${layer ? '/' + layer : ''}/<subdir>/ 2>/dev/null for each subdir` : `1. find ${searchRoot}${layer ? '/' + layer : ''} -type f 2>/dev/null
   → capture ALL paths
2. echo above output | wc -l → for fileCount
3. if fileCount > 8:
   ls ${searchRoot}${layer ? '/' + layer : ''}/ → enumerate subdirectories
   then repeat find per subdir`}

RULES:
- files[] must be the COMPLETE list — not a sample, not head -5
- sublayers[] must list subdirectory breakdowns when fileCount > 8
- canRunInParallel: true if this layer has no shared state with other layers
- dependsOnLayers: list layer names this one must come after (empty for most)

Return LAYER_SCHEMA.`,
      { label: `research:${layer || 'root'}`, phase: 'Research', model: sonnetModel, effort: 'medium', schema: LAYER_SCHEMA }
    ))
  )
  layerResultsAll.push(...batchResults)
}
const layerResults = layerResultsAll

// Fan-in: merge AC results with layer results
// Build a set of all AC-covered files for metadata injection into layer results
const validAcResults = acResearchResults.filter(Boolean)
const acCoveredFiles = new Set(validAcResults.flatMap(r => r.files || []))
const acCoverageMap = {}  // file path → AC bullets that cover it
for (const r of validAcResults) {
  for (const f of (r.files || [])) {
    if (!acCoverageMap[f]) acCoverageMap[f] = []
    acCoverageMap[f].push(r.acBullet)
  }
}

// Inject acCoverage metadata into layer files
let validLayers = layerResults.filter(Boolean).filter(l => l.fileCount > 0)

// Compute AC file total early — needed for fallback check below and log
const totalAcFiles = validAcResults.reduce((sum, r) => sum + r.fileCount, 0)

// Fallback: if layer research returned nothing but AC research found files,
// synthesize a root layer from AC research so split design has something to design from.
// This can happen when scopePath is a deep subtree and the layer researcher greps too broadly.
if (validLayers.length === 0 && totalAcFiles > 0) {
  const allAcFiles = [...new Set(validAcResults.flatMap(r => r.files || []))]
  // Group files by immediate parent directory relative to searchRoot for sublayer structure
  const dirMap = {}
  for (const f of allAcFiles) {
    const rel = f.startsWith(searchRoot) ? f.slice(searchRoot.length + 1) : f
    const dir = rel.includes('/') ? rel.split('/')[0] : ''
    const key = dir ? `${searchRoot}/${dir}` : searchRoot
    if (!dirMap[key]) dirMap[key] = { name: dir || 'root', path: key, files: [] }
    dirMap[key].files.push(f)
  }
  const sublayers = Object.values(dirMap)
    .filter(d => d.name !== 'root' && d.files.length > 0)
    .map(d => ({ name: d.name, path: d.path, fileCount: d.files.length, files: d.files }))
  log(`Layer research returned 0 files but AC research found ${totalAcFiles} — synthesizing root layer from AC results (${sublayers.length} sublayers)`)
  validLayers = [{
    name: 'root',
    path: searchRoot,
    fileCount: allAcFiles.length,
    files: allAcFiles,
    sublayers,
    canRunInParallel: true,
    dependsOnLayers: [],
  }]
}
for (const layer of validLayers) {
  layer.files = layer.files.map(f => {
    const coverage = acCoverageMap[f]
    return coverage ? { path: f, acCoverage: coverage } : { path: f, acCoverage: [] }
  })
  // Normalise: sublayer files too
  for (const sub of (layer.sublayers || [])) {
    sub.files = (sub.files || []).map(f => {
      const coverage = acCoverageMap[f]
      return coverage ? { path: f, acCoverage: coverage } : { path: f, acCoverage: [] }
    })
  }
}

// ACs with zero files found from AC research — will need stub subtasks
const zeroCoverageAcs = validAcResults.filter(r => r.fileCount === 0)

const totalFilesFound = validLayers.reduce((sum, l) => sum + l.fileCount, 0)

log(`Research: ${validLayers.length} layer(s) with ${totalFilesFound} files | ${validAcResults.length} AC strategies, ${totalAcFiles} AC-covered files | ${zeroCoverageAcs.length} ACs with no files (will stub)`)

if (validLayers.length === 0 && validAcResults.every(r => r.fileCount === 0)) {
  throw new Error(`Research found 0 files in all streams under ${searchRoot} — check scopePath or migrationPattern`)
}

// ─── Phase 2: Split Design — AC-driven grouper fan-out + coordinator ──────────
// Stage 1: design:grouper (Haiku, parallel, one per AC) — mechanical batching only
// Stage 2: design:coordinator (Opus, single) — file conflict resolution across groupers
// Replaces the single design:root agent that was stalling at ~180s on large tickets
// because it held 120k+ tokens of file enumeration while also doing coordination.

trackPhase('Split Design')

// Normalise file lists: layer files are now objects {path, acCoverage[]}
// Extract plain paths for verify/debrief prompts, keep acCoverage for context
const layerFilePaths = (files) => files.map(f => typeof f === 'string' ? f : f.path)

// Stage 1: design:grouper — one Haiku per AC, mechanical batching only (no cross-AC decisions)
// Input: a single AC's file list from AC research results (not layer research)
// Each grouper sees ≤N files for its own AC — tiny context, no stall risk
const grouperResultsAll = []
for (let i = 0; i < validAcResults.length; i += 5) {
  const batch = validAcResults.slice(i, i + 5)
  const batchResults = await parallel(batch.map(r => () => {
    const { isCleanup, isValidation, isDeferred, isMigration } = classifyAcBullet(r.acBullet)
    // Validation ACs: shell checks — never own files. Skip grouper entirely.
    if ((r.files || []).length === 0 || isValidation) {
      return Promise.resolve({ layer: r.acBullet.slice(0, 30), subtasks: [] })
    }
    // Deferred ACs: feature additions (e.g. AbortController) — produce one empty stub
    // directly in JS rather than sending hundreds of research files to a grouper.
    // collapseDeferred() would catch any that slip through, but this avoids the agent call.
    if (isDeferred) {
      const { isCleanup: iC, isValidation: iV, isDeferred: iD, isMigration: iM } = { isCleanup, isValidation, isDeferred, isMigration }
      return Promise.resolve({ layer: r.acBullet.slice(0, 30), subtasks: [{
        title: `${issueKey ? issueKey + ': ' : ''}${r.acBullet.slice(0, 60)}`,
        description: r.acBullet,
        scopePath: scopePath || '',
        files: [],
        estimatedFileCount: 0,
        targetSize: 'XS',
        isMigration: iM,
        isCleanup: iC,
        isValidation: iV,
        isDeferred: iD,
        needsReview: true,
      }]})
    }
    return trackedAgent(
      `You are a subtask grouper for harness-intake. Do not use any tools.
${PHILOSOPHY}

ACCEPTANCE CRITERION: "${r.acBullet}"
FILES (${r.files.length} total): ${JSON.stringify(r.files)}
${migrationPattern ? `MIGRATION PATTERN: ${migrationPattern}` : ''}
${issueKey ? `ISSUE KEY: ${issueKey}` : ''}

PRE-CLASSIFIED FLAGS (use exactly as given, do not override):
  isMigration:  ${isMigration}
  isCleanup:    ${isCleanup}
  isValidation: ${isValidation}
  isDeferred:   ${isDeferred}

RULES:
- If isDeferred=true: emit EXACTLY ONE subtask with files=[] and estimatedFileCount=0.
  Deferred ACs describe a feature addition (e.g. "add AbortController to clientFetch").
  They are NOT file migrations — do not list consumer files, do not chunk. One stub only.
- max 8 files per subtask — hard cap (migration/cleanup ACs only)
- when files.length > 8 (and NOT isDeferred): chunk into groups of 8 (alphabetical), one subtask per chunk
- TITLE FORMAT: "${issueKey ? issueKey + ': ' : ''}[verb] [directory] ([N] files)"
- DESCRIPTION: one paragraph — what changes, what pattern, list files explicitly by path
- scopePath: longest common directory prefix of files in this subtask
- targetSize: XS (≤4 files), S (5-8 files)
- Set isMigration/isCleanup/isValidation/isDeferred exactly as pre-classified above

Do NOT assign groupId — that is handled deterministically after all groupers finish.
Return LAYER_SUBTASKS_SCHEMA.`,
      { label: `design:grouper:${r.acBullet.slice(0, 30).replace(/\s+/g, '-')}`, phase: 'Split Design', model: haikuModel, effort: 'low', schema: LAYER_SUBTASKS_SCHEMA }
    )
  }))
  grouperResultsAll.push(...batchResults)
}

const allGrouperDraftsRaw = grouperResultsAll.filter(Boolean).flatMap(d => d.subtasks || [])

// Pre-normalize grouper drafts: _absPrefix is already set above (after AC research).
// Groupers sometimes emit absolute paths; normalize before coordinator sees them.
for (const s of allGrouperDraftsRaw) {
  if (s.files) s.files = s.files.map(f => toRelPath(f, _absPrefix))
}

// Pre-resolution pipeline: three passes to normalize grouper output before conflict resolution.
// 1. overlap-ratio: drop subtasks whose file set ≥50% overlaps already-seen files
// 2. collapseDeferred: all isDeferred=true chunks collapse to one stub (defense-in-depth
//    — the grouper short-circuit above should prevent these, but belt-and-suspenders)
// 3. cap20: hard backstop — keeps resolveFileConflicts O(N²) merge check fast
// Files are already normalized to relative paths at this point (_absPrefix applied above).
const _afterOverlap   = dedupeByOverlapRatio(allGrouperDraftsRaw)
const _afterCollapse  = collapseDeferred(_afterOverlap)
const allGrouperDrafts = capCoordinatorInput(_afterCollapse, 20)
log(`design:grouper: ${validAcResults.length} ACs → ${allGrouperDraftsRaw.length} raw → ${_afterOverlap.length} overlap-dedup → ${_afterCollapse.length} collapse-deferred → ${allGrouperDrafts.length} cap20`)


// Stage 2 replaced: deterministic resolveFileConflicts instead of Opus coordinator.
// resolveFileConflicts: merges >80%-overlap pairs, then assigns conflicting files to
// the most-specific subtask (longest scopePath; tie-break on fewer files).
// This is fully mechanical — no model judgment needed, no stall risk, no token cost.
const resolvedDrafts = resolveFileConflicts(allGrouperDrafts)
log(`design:coordinator (deterministic): ${allGrouperDrafts.length} drafts → ${resolvedDrafts.length} after conflict resolution`)

// ── Deterministic test file ejection ────────────────────────────────────────
// _ejectTestFiles moves test files out of production-migration batches into their own subtask.
const rawProposed = resolvedDrafts.slice()
const testMockSubtasks = _ejectTestFiles(rawProposed, issueKey, scopePath)
if (testMockSubtasks.length > 0) {
  const ejectedCount = testMockSubtasks.reduce((n, s) => n + s.files.length, 0)
  log(`test-file ejection: moved ${ejectedCount} test file(s) out of migration batches → ${testMockSubtasks.length} test-mock subtask(s)`)
  rawProposed.push(...testMockSubtasks)
}
// Drop migration subtasks that became empty after test-file ejection.
const rawProposedNonEmpty = rawProposed.filter(s => !s.isMigration || (s.files || []).length > 0)
if (rawProposedNonEmpty.length < rawProposed.length) {
  log(`test-file ejection: removed ${rawProposed.length - rawProposedNonEmpty.length} now-empty migration stub(s)`)
  rawProposed.length = 0
  rawProposed.push(...rawProposedNonEmpty)
}

// Post-resolution dedup: file-key dedup catches any remaining identical-file-list pairs.
const flatProposed = dedupeByFileSet(rawProposed)
log(`Split Design: ${resolvedDrafts.length} resolved → ${rawProposed.length} after test-ejection → ${flatProposed.length} after file-key dedup`)

// Build stub(s) for a given AC + file list — chunks at 8 files to enforce the size cap
function makeStubs(bullet, files, findings, reason) {
  const { isCleanup, isValidation, isDeferred, isMigration } = classifyAcBullet(bullet)
  const chunks = files.length > 8
    ? Array.from({ length: Math.ceil(files.length / 8) }, (_, i) => files.slice(i * 8, (i + 1) * 8))
    : [files]
  return chunks.map((chunk, i) => ({
    title: `${issueKey ? issueKey + ': ' : ''}${bullet.slice(0, 70)}${chunks.length > 1 ? ` (part ${i + 1})` : ''}`,
    description: `${bullet}\n\n${reason}${chunk.length > 0 ? `\nFiles: ${JSON.stringify(chunk)}` : ''}${findings ? `\nFindings: ${findings}` : ''}`,
    scopePath: scopePath || '',
    files: chunk,
    estimatedFileCount: chunk.length,
    targetSize: chunk.length <= 4 ? 'XS' : 'S',
    isMigration,
    isCleanup,
    isValidation,
    isDeferred,
    needsReview: true,
  }))
}

// Pre-merge: inject real subtasks for deferred/feature-addition ACs that have files
// but won't be covered by layer designers (who only speak "migration").
// Examples: "add AbortController to clientFetch.js" — AC research found the file,
// but the layer designer ignores it because it's not a pattern replacement.
// These are injected as isDeferred=true (G2) with needsReview=false — real work items.
const coveredFileSet = new Set(flatProposed.flatMap(s => s.files || []))
for (const r of validAcResults) {
  if (r.fileCount === 0) continue
  const { isDeferred, isCleanup, isValidation, isMigration } = classifyAcBullet(r.acBullet)
  if (!isDeferred && !isCleanup) continue  // migration ACs are handled by layer designers
  if (isValidation) continue               // validation ACs are done-conditions, not work items
  // Sanity cap: cleanup/deferred ACs should touch ≤20 files (package.json, config, a handful of wiring).
  // A large file list means the AC researcher ran a broad find/ls and returned the whole directory —
  // that's a shell-research artifact, not real work. Treat as done-condition and skip.
  if ((r.files || []).length > 20) continue
  // Check if any existing subtask already covers these files (>50% overlap)
  const acFiles = r.files || []
  const alreadyCovered = acFiles.length > 0 && acFiles.filter(f => coveredFileSet.has(f)).length / acFiles.length > 0.5
  if (alreadyCovered) continue
  // Not covered — inject as a real subtask (needsReview=false, not a stub)
  const chunks = acFiles.length > 8
    ? Array.from({ length: Math.ceil(acFiles.length / 8) }, (_, i) => acFiles.slice(i * 8, (i + 1) * 8))
    : [acFiles]
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    flatProposed.push({
      title: `${issueKey ? issueKey + ': ' : ''}${r.acBullet.slice(0, 70)}${chunks.length > 1 ? ` (part ${i + 1})` : ''}`,
      description: `${r.acBullet}\n\nFiles: ${JSON.stringify(chunk)}\nFindings: ${r.findings || 'none'}`,
      scopePath: scopePath || '',
      files: chunk,
      estimatedFileCount: chunk.length,
      targetSize: chunk.length <= 4 ? 'XS' : 'S',
      isMigration: false,
      isCleanup,
      isValidation: false,
      isDeferred,
      needsReview: false,
    })
    for (const f of chunk) coveredFileSet.add(f)
  }
}

// Inject stub subtasks for ACs with zero files found — ensures every AC maps to ≥1 subtask
// before the merge agent runs, not after. Merge agent assigns groupId to stubs too.
const acBullets = acList.map(ac => ac.bullet)
// Zero-file ACs: only create a stub if it's a migration concern (implies real file work).
// Validation/cleanup/deferred ACs with no files are done-conditions — they belong as
// acceptance criteria on an existing subtask, not as standalone Jira subtasks.
const doneConditionAcs = []
for (const r of zeroCoverageAcs) {
  const { isMigration } = classifyAcBullet(r.acBullet)
  if (isMigration) {
    // Before creating a files-empty stub, check whether Phase C found files for this AC.
    // Phase C runs on all grep ACs and may have resolved a higher count even when Phase 1
    // research returned 0 (different include-filter or broader pattern). If Phase C has a
    // count > 0, note it in the stub description so the implementer knows where to look.
    const phaseCEntry = acListWithVerify.find(a => a.bullet === r.acBullet)
    const phaseCCount = phaseCEntry?.verifiedCount || 0
    const reason = phaseCCount > 0
      ? `Auto-generated stub — Phase 1 research found no files matching the AC grep but Phase C broader-pattern retry found ${phaseCCount} file(s). Implementer should verify file list using: grep -rl "${phaseCEntry?.grepPattern || ''}" ${scopePath ? repoPath + '/' + scopePath : repoPath + '/src'}/ 2>/dev/null`
      : 'Auto-generated stub — AC research found no files. Implementer must locate relevant files.'
    const stubs = makeStubs(r.acBullet, [], r.findings, reason)
    flatProposed.push(...stubs)
  } else {
    doneConditionAcs.push(r.acBullet)
  }
}

if (zeroCoverageAcs.length > 0) {
  const stubCount = zeroCoverageAcs.length - doneConditionAcs.length
  log(`Split Design: ${stubCount} stub subtask(s) for zero-file migration ACs | ${doneConditionAcs.length} zero-file validation/deferred ACs treated as done-conditions (not separate subtasks)`)
}

// ── Deterministic merge — no agent needed ─────────────────────────────────────
// Group assignment, canRunInParallel, dependsOn, and execution are all pure functions
// of the classification flags already set by classifyAcBullet. Replacing the merge
// agent with JS eliminates the biggest non-determinism source in the pipeline.
const g1Titles = []
const g2Titles = []

// Pass 1: assign groupId + canRunInParallel, collect titles per group
for (const s of flatProposed) {
  // both flags set: isCleanup wins (G2) over isMigration; isValidation wins over isDeferred
  if (s.isValidation)                  s.groupId = 'G3'
  else if (s.isCleanup || s.isDeferred) s.groupId = 'G2'
  else                                  s.groupId = 'G1'
  s.canRunInParallel = s.groupId === 'G1'
  s.needsReview = s.needsReview || (s.files || []).length === 0
  if (s.groupId === 'G1') g1Titles.push(s.title)
  if (s.groupId === 'G2') g2Titles.push(s.title)
}

// Pass 2: wire dependsOn deterministically
for (const s of flatProposed) {
  if (s.groupId === 'G2') s.dependsOn = [...g1Titles]
  else if (s.groupId === 'G3') s.dependsOn = [...g2Titles]
  else s.dependsOn = []
}

const hasG2 = flatProposed.some(s => s.groupId === 'G2')
const hasG3 = flatProposed.some(s => s.groupId === 'G3')
const executionMode = (hasG2 || hasG3) ? 'mixed'
  : flatProposed.every(s => !s.canRunInParallel) ? 'sequential'
  : 'parallel'

const mergeResult = { execution: executionMode, subtasks: flatProposed }
log(`Merge (deterministic): ${mergeResult.subtasks.length} subtasks — G1:${g1Titles.length} G2:${g2Titles.length} G3:${flatProposed.filter(s => s.groupId === 'G3').length} execution=${executionMode}`)

// AC verify still runs as an agent — it needs to reason about coverage, not just classify
const acResult = acBullets.length === 0 ? null : await trackedAgent(
        `You are an AC coverage checker for harness-intake. Do not use any tools.

AC_BULLETS (${acBullets.length} total):
${JSON.stringify(acBullets)}

PROPOSED SUBTASKS:
${JSON.stringify(flatProposed.map(s => ({ title: s.title, description: s.description })))}

For each AC bullet, determine:
- covered: the AC bullet text if a subtask fully addresses it
- partial: the AC bullet text if a subtask partially addresses it
- missing: the AC bullet text if no subtask addresses it at all

Return AC_VERIFY_SCHEMA.`,
    { label: 'ac-verify', phase: 'Split Design', model: sonnetModel, effort: 'medium', schema: AC_VERIFY_SCHEMA }
  )

// Post-verify stub injection — for ACs that had files in research but no subtask covered them.
// zeroCoverageAcs handled stubs for zero-file ACs before merge. This handles the rest.
if (acResult?.missing?.length > 0) {
  const stubsFromMissing = []
  for (const missingBullet of acResult.missing) {
    const { isValidation, isCleanup, isDeferred, isMigration } = classifyAcBullet(missingBullet)
    // Validation ACs and ACs already in doneConditionAcs are shell checks or
    // done-conditions — never create a separate stub for them.
    const alreadyDoneCondition = doneConditionAcs.includes(missingBullet)
    if (isValidation || alreadyDoneCondition) {
      if (!alreadyDoneCondition) doneConditionAcs.push(missingBullet)
      continue
    }
    const acResearch = validAcResults.find(r => r.acBullet === missingBullet)
    const acFiles = acResearch?.files || []
    // Skip if ≥50% of this AC's research files are already assigned to existing subtasks.
    // The grouper sometimes mislabels subtasks (e.g. bare-fetch files titled as "axios"
    // subtasks) causing AC verify to flag the AC as missing — but the files are covered.
    if (isAcFilesCoveredByExisting(acFiles, mergeResult.subtasks)) {
      log(`Post-verify: skip stub for "${missingBullet.slice(0, 60)}" — files already covered by existing subtasks`)
      continue
    }
    const alreadyStubbed = mergeResult.subtasks.some(s =>
      s.title.includes(missingBullet.slice(0, 40)) || s.description.includes(missingBullet.slice(0, 40))
    )
    if (alreadyStubbed) continue
    const stubs = makeStubs(
      missingBullet,
      acFiles,
      acResearch?.findings,
      'Auto-generated stub — AC verify found no subtask covering this criterion.'
    )
    for (const stub of stubs) {
      stub.layer = 'stub'
      stub.groupId = (isCleanup || isDeferred) ? 'G2' : 'G1'
      stub.canRunInParallel = stub.groupId === 'G1'
      stub.dependsOn = stub.groupId === 'G2' ? [...g1Titles] : []
    }
    stubsFromMissing.push(...stubs)
  }
  if (stubsFromMissing.length > 0) {
    mergeResult.subtasks.push(...stubsFromMissing)
    log(`Post-verify: injected ${stubsFromMissing.length} stub subtask(s) for AC-verify-missing bullets`)
  }
}

// ─── Phase 3: Verify — holistic manifest check ────────────────────────────────
// Single no-tools agent reads the assembled manifest against acList + totalFilesFound.
// Catches: AC gaps the AC verify missed, stub quality, file count plausibility.

trackPhase('Verify')

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['verdict', 'acCoverage', 'fileCountPlausible', 'stubsNeedReview', 'issues', 'groundedReality'],
  properties: {
    verdict:            { type: 'string', enum: ['PASS', 'PASS_WITH_NOTES', 'FAIL'] },
    acCoverage:         { type: 'string', description: 'one-line summary: N/M ACs covered' },
    fileCountPlausible: { type: 'boolean' },
    stubsNeedReview:    { type: 'array', items: { type: 'string' } },
    issues:             { type: 'array', items: { type: 'string' } },
    groundedReality: {
      type: 'object',
      description: 'Authoritative summary of what research actually found — OVERRIDES ticket claims in all downstream prompts',
      required: ['summary', 'actualFileCount', 'actualScope', 'ticketClaimsToIgnore', 'keyFiles', 'migrationNotes'],
      properties: {
        summary:              { type: 'string', description: '2-3 sentence plain-English description of what the work actually is, based on research not ticket text' },
        actualFileCount:      { type: 'number', description: 'real file count from research, not ticket claim' },
        actualScope:          { type: 'string', description: 'the real directory scope verified by research' },
        ticketClaimsToIgnore: { type: 'array', items: { type: 'string' }, description: 'specific ticket claims research proved wrong or misleading' },
        keyFiles:             { type: 'array', items: { type: 'string' }, description: 'the most important files confirmed to exist by research' },
        migrationNotes:       { type: 'string', description: 'any nuances about the migration pattern verified by research — e.g. test files use different mock pattern than prod files' },
      },
    },
  },
}

// Build AC research summary for the verifier — what each strategy actually found
const acResearchSummary = validAcResults.map(r => ({
  bullet: r.acBullet,
  filesFound: r.fileCount,
  sample: (r.files || []).slice(0, 5),
  findings: r.findings,
}))

const verifyResult = await trackedAgent(
  `You are a manifest verifier for harness-intake. Do not use any tools.

ORIGINAL TICKET TEXT (may contain wrong or stale numbers — treat with suspicion):
${input.slice(0, 800)}

AC RESEARCH RESULTS (ground truth — from actual shell commands on the repo):
${JSON.stringify(acResearchSummary, null, 2)}

LAYER RESEARCH RESULTS (ground truth):
  layers found: ${validLayers.map(l => l.name + ' (' + l.fileCount + ' files)').join(', ')}
  total files found: ${totalFilesFound}
  total AC-covered files: ${totalAcFiles}

ASSEMBLED SUBTASKS (${mergeResult.subtasks.length} total):
${JSON.stringify(mergeResult.subtasks.map(s => ({ title: s.title, groupId: s.groupId, files: s.files, estimatedFileCount: s.estimatedFileCount, needsReview: s.needsReview })))}

TASKS:
1. Build groundedReality — synthesize what research ACTUALLY found vs. what the ticket claims.
   - If the ticket says "118 files" but research found 30, actualFileCount=30 and add the ticket claim to ticketClaimsToIgnore.
   - keyFiles = the specific files confirmed present by research (not inferred from ticket).
   - migrationNotes = any important nuance (e.g. "test files use MockAdapter pattern, prod files use bare axios").
   - This object will be injected into ALL downstream harness-plan researcher prompts as authoritative context.

2. AC coverage — does every AC bullet map to ≥1 subtask?
3. File count plausibility — does sum of subtask estimatedFileCounts roughly match totalFilesFound (±20%)?
4. Stubs — flag any subtask with files=[] or needsReview=true.

verdict=PASS if all ACs covered and counts plausible. PASS_WITH_NOTES if minor gaps. FAIL if >2 ACs uncovered.
Return VERIFY_SCHEMA.`,
  { label: 'verify-manifest', phase: 'Verify', model: sonnetModel, effort: 'medium', schema: VERIFY_SCHEMA }
)

if (verifyResult) {
  log(`Verify: ${verifyResult.verdict} — ${verifyResult.acCoverage} | fileCount plausible: ${verifyResult.fileCountPlausible} | stubs needing review: ${verifyResult.stubsNeedReview?.length || 0}`)
}

// ─── Phase 4: Debrief ─────────────────────────────────────────────────────────

trackPhase('Debrief')

const qualityIssues = []

// Misclassification detection: previously done by the Opus coordinator agent;
// now handled entirely by _ejectTestFiles (test files in migration batches) and
// resolveFileConflicts (file assignment). No separate misclassification pass needed.

// Carry forward verify issues — but filter out ticket-vs-reality corrections that are
// already captured in groundedReality.ticketClaimsToIgnore. Those are expected harness
// behavior (COMPLETE_FRAMING_CORRECTED), not defects. Only structural problems remain.
const TICKET_CORRECTION_RE = /^(FILE COUNT MISMATCH|TICKET NUMBER WRONG|ticket claim)/i
if (verifyResult?.issues?.length > 0) {
  const ticketCorrections = verifyResult.groundedReality?.ticketClaimsToIgnore || []
  for (const issue of verifyResult.issues) {
    // If it's a ticket-number complaint AND groundedReality already documents it, skip
    if (TICKET_CORRECTION_RE.test(issue) && ticketCorrections.length > 0) continue
    qualityIssues.push(categorizeVerifyIssue(`verify: ${issue}`))
  }
}
if (verifyResult?.stubsNeedReview?.length > 0) {
  for (const stub of verifyResult.stubsNeedReview) qualityIssues.push(`stub needs review: "${stub}"`)
}

// Quality check — oversized subtasks
for (const s of mergeResult.subtasks) {
  if (s.estimatedFileCount > 8) {
    qualityIssues.push(`oversized: "${s.title}" has ${s.estimatedFileCount} files (max 8)`)
  }
}

// Quality check — G2/G3 missing dependencies (should never fire now — deterministic merge)
for (const s of mergeResult.subtasks.filter(s => s.groupId === 'G2' || s.groupId === 'G3')) {
  if (!s.dependsOn || s.dependsOn.length === 0) {
    qualityIssues.push(`missing dependency: "${s.title}" is ${s.groupId} but has no dependsOn`)
  }
}

// ── Structural validator — programmatic score, flag for re-run if below threshold ──
// Checks deterministic invariants that LLM variance cannot be allowed to violate.
// phaseCRan: true only if every grep AC has suspiciousZeroRetried=true.
// A missing audit trail means Phase C was skipped — the Run G/K silent-zero failure mode.
const phaseCUnchecked = acListWithVerify.filter(ac =>
  ac.researchType === 'grep' && ac.grepPattern && ac.suspiciousZeroRetried !== true && ac.suspiciousZeroRetried !== 'n/a'
)
const structuralScore = {
  phaseCRan:        phaseCUnchecked.length === 0,
  g2HasDeps:        mergeResult.subtasks.filter(s => s.groupId === 'G2').every(s => (s.dependsOn || []).length > 0),
  g3HasDeps:        mergeResult.subtasks.filter(s => s.groupId === 'G3').every(s => (s.dependsOn || []).length > 0),
  noOversized:      mergeResult.subtasks.every(s => (s.files || []).length <= 8),
  stubsUnder4:      mergeResult.subtasks.filter(s => s.needsReview).length <= 4,
  hasMixedOrParallel: ['mixed', 'parallel'].includes(mergeResult.execution),
  g1Count:          g1Titles.length,
}
const structuralPass =
  structuralScore.phaseCRan &&
  structuralScore.g2HasDeps &&
  structuralScore.g3HasDeps &&
  structuralScore.noOversized &&
  structuralScore.stubsUnder4 &&
  structuralScore.hasMixedOrParallel &&
  structuralScore.g1Count > 0

if (!structuralPass) {
  const failures = []
  if (!structuralScore.phaseCRan) {
    for (const ac of phaseCUnchecked) {
      failures.push(`PHASE_C_NOT_RUN: Phase C did not run on AC "${ac.bullet.slice(0, 80)}" (verifiedCount=${ac.verifiedCount}, no retry recorded)`)
    }
  }
  if (!structuralScore.g2HasDeps) failures.push('G2 subtasks missing dependsOn')
  if (!structuralScore.g3HasDeps) failures.push('G3 subtasks missing dependsOn')
  if (!structuralScore.noOversized) failures.push('oversized subtasks (>8 files)')
  if (!structuralScore.stubsUnder4) failures.push(`too many stubs (${mergeResult.subtasks.filter(s => s.needsReview).length} > 4)`)
  if (!structuralScore.hasMixedOrParallel) failures.push(`unexpected execution mode: ${mergeResult.execution}`)
  if (structuralScore.g1Count === 0) failures.push('no G1 subtasks produced')
  log(`⚠️  STRUCTURAL VALIDATOR FAILED: ${failures.join(' | ')} — flag for review before Jira creation`)
  qualityIssues.push(`structural: ${failures.join('; ')}`)
} else {
  log(`✅ Structural validator passed — phase-c:${grepAcs.length}/${grepAcs.length} G1:${structuralScore.g1Count} deps:wired oversized:none stubs:${mergeResult.subtasks.filter(s => s.needsReview).length}`)
}

// Build groups via pure JS (no agent) — G1 first, then G2, then G3
// Propagate top-level migrationPattern and size down to each subtask so
// harness-plan's manifestEntry fast path gets them directly.
propagateManifestFields(mergeResult.subtasks, migrationPattern, size)
const groupMap = {}
for (const s of mergeResult.subtasks) {
  if (!groupMap[s.groupId]) groupMap[s.groupId] = []
  groupMap[s.groupId].push(s)
}
const GROUP_ORDER = ['G1', 'G2', 'G3']
const groups = Object.entries(groupMap)
  .sort(([a], [b]) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b))
  .map(([groupId, subtasks]) => ({
    groupId,
    parallel: subtasks.every(s => s.canRunInParallel),
    subtasks,  // jiraKey/jiraUrl added by SKILL.md after Jira creation
  }))

const groundedReality = verifyResult?.groundedReality || null

// intakeManifest for L — same contract as XS/S/M but adds groups[] for harness-plan fan-out.
// SKILL.md injects jiraKey/jiraUrl per subtask before writing to disk.
const intakeManifest = {
  skill: 'harness-intake',
  sourceIssue: issueKey || null,
  sourceTitle,
  size,
  workType,
  ticketType,
  migrationPattern,
  scopePath,
  acList,
  files: [...new Set(validLayers.flatMap(l => layerFilePaths(l.files)))],
  execution: mergeResult.execution,
  groundedReality,   // downstream workers MUST prefer this over the original ticket text
  groups,
}

const parallelCount   = mergeResult.subtasks.filter(s => s.canRunInParallel).length
const sequentialCount = mergeResult.subtasks.filter(s => !s.canRunInParallel).length
const hasStubs        = mergeResult.subtasks.some(s => s.needsReview)

// Status taxonomy:
//   COMPLETE_FRAMING_CORRECTED — ticket claims overridden by verified grep counts (working as intended)
//   COMPLETE_WITH_STUBS        — split succeeded but some ACs produced stubs needing human review
//   PROPOSED_WITH_GAPS         — split proposed but ACs remain unresolvable
//   COMPLETE                   — clean run, all ACs covered, no conflicts
const planStatus =
    conflictingAcs.length > 0 ? 'COMPLETE_FRAMING_CORRECTED'
  : hasStubs                  ? 'COMPLETE_WITH_STUBS'
  : qualityIssues.length > 0  ? 'PROPOSED_WITH_GAPS'
  : 'COMPLETE'

auditWritten = true
await writeAuditRecord(planStatus, {
  size,
  ticketType: workType,
  migrationPattern,
  subtaskCount: mergeResult.subtasks.length,
  execution: mergeResult.execution,
  parallelCount,
  sequentialCount,
  acStrategiesRun: acList.length,
  acFilesFound: totalAcFiles,
  zeroCoverageAcs: zeroCoverageAcs.map(r => r.acBullet),
  doneConditionAcs,
  framingConflicts: conflictingAcs.length,
  framingConflictDetails: conflictingAcs.map(ac => ({ bullet: ac.bullet, ticketClaimed: ac.ticketClaimedCount, verified: ac.verifiedCount })),
  suspiciousZeros: acListWithVerify
    .filter(ac => ac.suspiciousZeroResolved || ac.suspiciousZeroConfirmed)
    .map(ac => ({ bullet: ac.bullet, resolved: !!ac.suspiciousZeroResolved, variant: ac.zeroRetryVariant || null, finalCount: ac.verifiedCount })),
  qualityIssues,
  triageSizeOverride,
})

// Build CLI group display lines
const groupLines = groups.map(g => {
  const parallelLabel = g.parallel ? '— parallel' : '— sequential'
  const taskLines = g.subtasks.map(t =>
    `    ${t.title.padEnd(55)}  ${String(t.estimatedFileCount).padStart(2)} files  → ${t.targetSize}`
  ).join('\n')
  return `  [${g.groupId} ${parallelLabel}]\n${taskLines}`
}).join('\n\n')

const qualityLine = qualityIssues.length === 0
  ? '✓ clean'
  : `${qualityIssues.length} issue(s) — ${qualityIssues.slice(0, 2).join('; ')}${qualityIssues.length > 2 ? '…' : ''}`

const outputTokensTotal = budget.spent() - workflowStartTokens
const estimatedCostUsd  = parseFloat(
  Object.entries(tokensByModel).reduce((sum, [model, tokens]) => {
    const rate = model.includes('opus') ? 75 : model.includes('haiku') ? 1.25 : 15
    return sum + (tokens / 1_000_000) * rate
  }, 0).toFixed(4)
)

const statusIcon = planStatus === 'COMPLETE' ? '✅' : planStatus === 'COMPLETE_FRAMING_CORRECTED' ? '✅' : planStatus === 'COMPLETE_WITH_STUBS' ? '⚠️' : '⚠️'

const conflictLines = conflictingAcs.length > 0
  ? `\n  framing: corrected — ticket claims overridden by verified grep counts\n` +
    conflictingAcs.map(ac => `     "${ac.bullet.slice(0, 60)}"  ticket:${ac.ticketClaimedCount} → verified:${ac.verifiedCount}`).join('\n') + '\n'
  : ''

const totalAgents = Object.values(agentCountByModel).reduce((a,b)=>a+b,0)
const agentMetricsLines = Object.entries(agentCountByModel)
  .filter(([,c]) => c > 0)
  .map(([m, c]) => {
    const label = m.includes('opus') ? 'opus  ' : m.includes('haiku') ? 'haiku ' : 'sonnet'
    const tok = (tokensByModel[m] || 0).toLocaleString()
    return `    ${label}  (×${c})  ${tok} tok`
  }).join('\n')

// groundedReality block — shows what research overrode vs. what the ticket claimed
const groundedRealityLines = (() => {
  const gr = verifyResult?.groundedReality
  if (!gr) return ''
  const lines = [`\n  research findings (overrides ticket):`, `    · ${gr.summary}`]
  if (gr.actualFileCount != null) lines.push(`    · actual file count: ${gr.actualFileCount} (research-verified)`)
  if (gr.actualScope) lines.push(`    · actual scope: ${gr.actualScope}`)
  if (gr.ticketClaimsToIgnore?.length > 0) {
    lines.push(`    · ticket claims overridden:`)
    for (const c of gr.ticketClaimsToIgnore) lines.push(`        ✗ ${c}`)
  }
  if (gr.migrationNotes) lines.push(`    · migration notes: ${gr.migrationNotes}`)
  return lines.join('\n')
})()

const triageSizeLineLpath = triageSizeOverride
  ? `\n  triage:  estimated ${triageSizeOverride.triageSize} → verified ${triageSizeOverride.groundedSize} (ticket claims overridden by research)`
  : ''

const cliSummary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
harness-intake
  status:  ${planStatus}  ${statusIcon}

  ticket:  ${issueKey || 'unknown'}
  size:    ${size}${triageSizeLineLpath}
  agents:  ${totalAgents}
${agentMetricsLines}
  cost:    ~$${estimatedCostUsd}
${conflictLines}${groundedRealityLines}

  subtasks: ${mergeResult.subtasks.length} proposed    execution: ${mergeResult.execution}
${groupLines}
${doneConditionAcs.length > 0 ? `\n  done-conditions (add to predecessor AC criteria, not separate subtasks):\n${doneConditionAcs.map(ac => `    · ${ac.slice(0, 80)}`).join('\n')}\n` : ''}
  quality: ${qualityLine}
  next:    confirm → create Jira subtasks → /harness-plan each G1 subtask
  audit:   ~/.claude/harness-intake-runs.jsonl
           ~/Desktop/Repos/harness-telemetry/logs/  (run-specific file)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

log(cliSummary)

return {
  splitRequired: true,
  size,
  workType,
  ticketType,
  migrationPattern,
  splitPlan: mergeResult,
  intakeManifest,
  totalFilesFound,
  qualityIssues,
  status: planStatus,
  cliSummary,
}

} catch (err) {
  if (!auditWritten) {
    const isKilled = err.message?.includes('abort') || err.message?.includes('cancel') || err.message?.includes('interrupt')
    const crashStatus = isKilled
      ? 'CRASHED'
      : ['Research', 'Split Design', 'Verify', 'Debrief'].includes(currentPhase) ? 'PROPOSED_WITH_GAPS' : 'FAILED'
    await writeAuditRecord(crashStatus, {
      sourceIssue: issueKey || null,
      failedAtPhase: currentPhase,
      error: err.message || String(err),
      size: partialState.size || null,
      qualityIssues: [],
      subtaskCount: 0,
    }).catch(() => {})
  }
  throw err
}
