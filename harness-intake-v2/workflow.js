export const meta = {
  name: 'harness-intake-v2',
  description: 'ORVA rewrite of harness-intake — Observe (shell facts) → Reason (LLM on facts) → Verify (JS invariants) → Act (write manifest). Same inputs/outputs as v1.',
  phases: [
    { title: 'Observe',  detail: 'Shell-only JS: ls layers, broad grep file lists, cascade imports, wc counts, regex AC bullets — no LLM' },
    { title: 'Reason',   detail: 'LLMs receive pre-counted facts: classify+ac-synth parallel (Sonnet), ac-files per-AC (Haiku), groupers per-AC (Haiku)' },
    { title: 'Verify',   detail: 'JS: classifyAcBullet, dedup, assignGroups, AC coverage check, structural validator; groundedReality (Sonnet)' },
    { title: 'Act',      detail: 'JS: build splitManifest, framing correction report, CLI summary. Haiku: audit log write.' },
  ],
}

// args: { input, cloudId?, issueKey?, repoPath, today?, startTs? }
// Returns (same contract as v1):
//   XS/S/M: { splitRequired: false, intakeManifest, size, cliSummary }
//   L:      { splitRequired: true,  intakeManifest, splitManifest, size, ... }

const input    = args.input
const repoPath = args.repoPath
const issueKey = args.issueKey || ''

if (!input)    throw new Error('harness-intake-v2 requires input')
if (!repoPath) throw new Error('harness-intake-v2 requires repoPath')

// ─── Models ───────────────────────────────────────────────────────────────────
const opusModel   = 'claude-opus-4-8'
const sonnetModel = 'anthropic.claude-sonnet-4-6'
const haikuModel  = 'anthropic.claude-haiku-4-5-20251001'

// ─── Token tracking ───────────────────────────────────────────────────────────
const workflowStartTokens = budget.spent()
const tokensByModel       = {}
const agentCountByModel   = {}

async function trackedAgent(prompt, opts) {
  const before = budget.spent()
  const result = await agent(prompt, opts)
  const m = opts.model || sonnetModel
  tokensByModel[m]     = (tokensByModel[m]     || 0) + (budget.spent() - before)
  agentCountByModel[m] = (agentCountByModel[m] || 0) + 1
  return result
}

async function writeAuditRecord(status, extra = {}) {
  const outputTokensTotal = budget.spent() - workflowStartTokens
  const estimatedCostUsd = parseFloat(
    Object.entries(tokensByModel).reduce((sum, [model, tokens]) => {
      const rate = model.includes('opus') ? 75 : model.includes('haiku') ? 1.25 : 15
      return sum + (tokens / 1_000_000) * rate
    }, 0).toFixed(4)
  )
  const durationMs = args.startTs
    ? await agent(
        `Run: python3 -c "import time; print(int(time.time()*1000) - ${args.startTs})"\nReturn { ms: <number> }`,
        { label: 'duration-ms', phase: 'Act', model: haikuModel,
          schema: { type: 'object', required: ['ms'], properties: { ms: { type: 'number' } } } }
      ).then(r => r?.ms || null).catch(() => null)
    : null
  const record = JSON.stringify({
    ts: args.today || 'unknown',
    skill: 'harness-intake-v2',
    status,
    sourceIssue: issueKey || 'unknown',
    durationMs,
    outputTokensByModel: tokensByModel,
    outputTokensTotal,
    estimatedCostUsd,
    ...extra,
  })
  await agent(
    `Append exactly one line to a JSONL file. Use the Bash tool only.
Run: echo '${record.replace(/'/g, "'\\''")}' >> ~/.claude/harness-intake-runs.jsonl
Return { appended: true }.`,
    { label: 'audit-write', phase: 'Act', model: haikuModel,
      schema: { type: 'object', required: ['appended'], properties: { appended: { type: 'boolean' } } } }
  )
}

// ─── Pure JS helpers ──────────────────────────────────────────────────────────

// Single source of truth for G1/G2/G3 classification. LLMs never override this.
function classifyAcBullet(bullet) {
  const text = bullet.toLowerCase()
  const isCleanup    = text.includes('remov') || text.includes('delet') || text.includes('package.json') || text.includes('npm install')
  const isValidation = text.includes('verif') || text.includes('confirm') || text.includes('passing') || text.includes('clean install') || text.includes('baseline') || /\bcheck\b/.test(text) || /\bremains?\b/.test(text)
  const isDeferred   = text.includes('abortcontroller') || text.includes('timeout') || text.includes('npm ')
  const isMigration  = !isCleanup && !isValidation && !isDeferred
  return { isCleanup, isValidation, isDeferred, isMigration }
}

// G1/G2/G3 assignment + dependsOn wiring. Called once in Verify.
function assignGroups(subtasks) {
  const g1Titles = []
  const g2Titles = []
  for (const s of subtasks) {
    if (s.isValidation)                   s.groupId = 'G3'
    else if (s.isCleanup || s.isDeferred) s.groupId = 'G2'
    else                                  s.groupId = 'G1'
    s.canRunInParallel = s.groupId === 'G1'
    s.needsReview      = s.needsReview || (s.files || []).length === 0
    if (s.groupId === 'G1') g1Titles.push(s.title)
    if (s.groupId === 'G2') g2Titles.push(s.title)
  }
  for (const s of subtasks) {
    if      (s.groupId === 'G2') s.dependsOn = [...g1Titles]
    else if (s.groupId === 'G3') s.dependsOn = [...g2Titles]
    else                         s.dependsOn = []
  }
  const hasG2 = subtasks.some(s => s.groupId === 'G2')
  const hasG3 = subtasks.some(s => s.groupId === 'G3')
  const execution = (hasG2 || hasG3) ? 'mixed'
    : subtasks.every(s => !s.canRunInParallel) ? 'sequential'
    : 'parallel'
  return { subtasks, g1Titles, g2Titles, execution }
}

// Dedup by file overlap (>50% = duplicate, most-specific scopePath wins).
function deduplicateSubtasks(proposed) {
  const seenFiles    = new Set()
  const seenFileKeys = new Set()
  const deduped      = []
  const sorted = [...proposed].sort((a, b) => (b.scopePath || '').length - (a.scopePath || '').length)
  for (const s of sorted) {
    const sFiles      = new Set(s.files || [])
    const overlapCount = sFiles.size > 0 ? [...sFiles].filter(f => seenFiles.has(f)).length : 0
    if (sFiles.size > 0 && overlapCount / sFiles.size >= 0.5) continue
    const fileKey = (s.files || []).slice().sort().join('|')
    if (fileKey && seenFileKeys.has(fileKey)) continue
    deduped.push(s)
    for (const f of sFiles) seenFiles.add(f)
    if (fileKey) seenFileKeys.add(fileKey)
  }
  return deduped
}

// Build stub subtask(s). Chunks at 8. needsReview=true always.
function makeStubs(bullet, files, findings, reason) {
  const cls    = classifyAcBullet(bullet)
  const chunks = files.length > 8
    ? Array.from({ length: Math.ceil(files.length / 8) }, (_, i) => files.slice(i * 8, (i + 1) * 8))
    : [files]
  return chunks.map((chunk, i) => ({
    title:              `${issueKey ? issueKey + ': ' : ''}${bullet.slice(0, 70)}${chunks.length > 1 ? ` (part ${i + 1})` : ''}`,
    description:        `${bullet}\n\n${reason}${chunk.length > 0 ? `\nFiles: ${JSON.stringify(chunk)}` : ''}${findings ? `\nFindings: ${findings}` : ''}`,
    scopePath:          '',
    files:              chunk,
    estimatedFileCount: chunk.length,
    targetSize:         chunk.length <= 4 ? 'XS' : 'S',
    ...cls,
    needsReview:        true,
  }))
}

let auditWritten = false
let currentPhase = 'Observe'

try {

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1: OBSERVE
// Pure shell/JS. No LLM. All facts gathered here before any reasoning.
// ═══════════════════════════════════════════════════════════════════════════════

phase('Observe')
currentPhase = 'Observe'
log('Observe: gathering shell facts before any LLM reasoning')

// 1a. Repo layer list
const layersRaw = await agent(
  `Run: ls ${repoPath}/src 2>/dev/null || ls ${repoPath}/app 2>/dev/null || ls ${repoPath}/lib 2>/dev/null
Return { dirs: ["dir1", "dir2", ...] } — directory names only, no paths.`,
  { label: 'observe:layers', phase: 'Observe', model: haikuModel,
    schema: { type: 'object', required: ['dirs'], properties: { dirs: { type: 'array', items: { type: 'string' } } } } }
)
const repoLayers = layersRaw?.dirs || []
log(`Observe: layers=[${repoLayers.join(', ')}]`)

// 1b. Raw AC bullets from ticket — pure regex, no LLM
const rawAcBullets = [...(input || '').matchAll(/^[*\-]\s+(.+)$/gm)].map(m => m[1].trim())
log(`Observe: ${rawAcBullets.length} raw AC bullets from ticket regex`)

// 1c. Migration pattern heuristic — used for broad layer greps only
//     Classify in Reason will return the authoritative migrationPattern.
const patternMatch = input.match(/(?:migrat|replac(?:e|ing)|convert(?:ing)?)\s+["']?(\S+)["']?\s+(?:to|with|→|->)\s+["']?(\S+)["']?/i)
  || input.match(/["']?(\S+)["']?\s+(?:→|->)\s+["']?(\S+)["']?/)
const roughPattern    = patternMatch ? `${patternMatch[1]} → ${patternMatch[2]}` : ''
// Fix 1: always grep from src/ — never pre-scope from ticket text
const broadSearchRoot = `${repoPath}/src`
let patternGrepArg = roughPattern
  ? roughPattern.replace(/\s*[-→>]+.*$/, '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  : ''
log(`Observe: roughPattern="${roughPattern}" grepArg="${patternGrepArg}" searchRoot=${broadSearchRoot}`)

// 1d. Broad file counts per layer (always from src/)
const OBSERVE_LAYER_SCHEMA = {
  type: 'object',
  required: ['layer', 'files', 'count'],
  properties: {
    layer: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    count: { type: 'number' },
  },
}

const layersToScan = repoLayers.length > 0 ? repoLayers : ['']
// Y1: convert to trackedAgent so these Observe agents count toward cost tracking
const observeLayerResults = await parallel(
  layersToScan.map(layer => () => trackedAgent(
    `Shell only. Run:
${patternGrepArg
  ? `timeout 15 grep -rl "${patternGrepArg}" ${broadSearchRoot}${layer ? '/' + layer : ''}/ 2>/dev/null`
  : `find ${broadSearchRoot}${layer ? '/' + layer : ''} -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \\) 2>/dev/null`}
Return { layer: "${layer || 'root'}", files: [<all matching paths>], count: <line count> }`,
    { label: `observe:layer:${layer || 'root'}`, phase: 'Observe', model: haikuModel, schema: OBSERVE_LAYER_SCHEMA }
  ))
)

// Y2: per-layer zero retry — retry individual zero layers with -i before the all-zero check
const observeLayerRaw = observeLayerResults.filter(Boolean)
const zeroLayers = patternGrepArg ? observeLayerRaw.filter(l => l.count === 0) : []
const retryLayerResults = zeroLayers.length === 0 ? [] : await parallel(
  zeroLayers.map(l => () => trackedAgent(
    `Shell only. Run: timeout 15 grep -irl "${patternGrepArg}" ${broadSearchRoot}${l.layer !== 'root' ? '/' + l.layer : ''}/ 2>/dev/null
Return { layer: "${l.layer}", files: [<all matching paths>], count: <number> }`,
    { label: `observe:layer-retry:${l.layer}`, phase: 'Observe', model: haikuModel, schema: OBSERVE_LAYER_SCHEMA }
  ))
)
// Merge retry results back — prefer retry count if > 0
const retryByLayer = {}
for (const r of retryLayerResults.filter(Boolean)) retryByLayer[r.layer] = r
const observeLayerMerged = observeLayerRaw.map(l =>
  retryByLayer[l.layer]?.count > 0 ? retryByLayer[l.layer] : l
)
const validObserveLayers = observeLayerMerged.filter(l => l.count > 0)
let totalObservedFiles   = validObserveLayers.reduce((sum, l) => sum + l.count, 0)

// 1e. Pattern fallback — if grep found 0 across all layers, try simpler variants (JS selection, not LLM)
if (patternGrepArg && totalObservedFiles === 0) {
  const candidates = [
    patternGrepArg.split(/\s+/)[0],
    patternGrepArg.replace(/[^a-zA-Z0-9_$]/g, '').slice(0, 20),
  ].filter((p, i, arr) => p && p !== patternGrepArg && arr.indexOf(p) === i)

  for (const candidate of candidates) {
    const escaped  = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const fallback = await trackedAgent(
      `Run: timeout 15 grep -rl "${escaped}" ${broadSearchRoot}/ 2>/dev/null | wc -l\nReturn { count: <number> }`,
      { label: 'observe:pattern-fallback', phase: 'Observe', model: haikuModel,
        schema: { type: 'object', required: ['count'], properties: { count: { type: 'number' } } } }
    )
    if ((fallback?.count || 0) > 0) {
      log(`Observe: pattern fallback "${patternGrepArg}" → "${candidate}" (${fallback.count} files)`)
      patternGrepArg = escaped
      totalObservedFiles = fallback.count
      break
    }
  }
}

// Fix 3: Zero-file migration retry — if any layer returned 0, run broader (no --include, -i)
// This catches files Phase B would miss with extension filters (e.g. axios in api.js when grep used --include)
const ZERO_RETRY_SCHEMA = {
  type: 'object',
  required: ['files', 'count'],
  properties: { files: { type: 'array', items: { type: 'string' } }, count: { type: 'number' } },
}
let zeroRetryFiles = []
if (patternGrepArg && totalObservedFiles === 0) {
  const retryResult = await trackedAgent(
    `Shell only. Run both:
1. timeout 15 grep -rl "${patternGrepArg}" ${broadSearchRoot}/ 2>/dev/null
2. timeout 15 grep -irl "${patternGrepArg}" ${broadSearchRoot}/ 2>/dev/null
Return { files: [<union of all unique paths>], count: <total unique count> }`,
    { label: 'observe:zero-retry', phase: 'Observe', model: haikuModel, schema: ZERO_RETRY_SCHEMA }
  )
  if ((retryResult?.count || 0) > 0) {
    log(`Observe: zero-retry found ${retryResult.count} files with broader grep`)
    zeroRetryFiles      = retryResult.files || []
    totalObservedFiles  = retryResult.count
  }
}

// Collect all observed files into a flat set
const allObservedFiles = [...new Set([
  ...validObserveLayers.flatMap(l => l.files || []),
  ...zeroRetryFiles,
])]

// 1f. Sublayer enumeration for layers with >8 files
const OBSERVE_SUBLAYER_SCHEMA = {
  type: 'object',
  required: ['layer', 'sublayers'],
  properties: {
    layer: { type: 'string' },
    sublayers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'files'],
        properties: { name: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
}
const bigLayers     = validObserveLayers.filter(l => l.count > 8)
// Y1: use trackedAgent for sublayer enumeration
const sublayerResults = bigLayers.length === 0 ? [] : await parallel(
  bigLayers.map(l => () => trackedAgent(
    `Shell only.
1. ls ${broadSearchRoot}${l.layer ? '/' + l.layer : ''}/ 2>/dev/null
2. For each subdir: grep -rl "${patternGrepArg || '.'}" ${broadSearchRoot}${l.layer ? '/' + l.layer : ''}/<subdir>/ 2>/dev/null
Return { layer: "${l.layer}", sublayers: [{ name, files: [...paths] }] }`,
    { label: `observe:sublayers:${l.layer || 'root'}`, phase: 'Observe', model: haikuModel, schema: OBSERVE_SUBLAYER_SCHEMA }
  ))
)
const sublayerByLayer = {}
for (const sr of sublayerResults.filter(Boolean)) sublayerByLayer[sr.layer] = sr.sublayers || []
const observedLayers = validObserveLayers.map(l => ({
  ...l,
  sublayers: sublayerByLayer[l.layer] || [],
}))

// Cascade grep helper — find importers of files being deleted.
// Y3: moved to run TWICE: once on rawAcBullets in Observe, once on acList cleanup ACs after ac-synth.
// Y4: require term length > 6 to avoid overly broad matches ("auth" → "authorization", etc.)
const CASCADE_SCHEMA = {
  type: 'object',
  required: ['acBullet', 'cascadeFiles'],
  properties: {
    acBullet:     { type: 'string' },
    cascadeFiles: { type: 'array', items: { type: 'string' } },
  },
}

async function runCascadeGrep(bullets, phase) {
  if (bullets.length === 0) return {}
  const results = await parallel(bullets.map(b => () => {
    const term = b.replace(/^(delete|remove|delet|remov)\s+/i, '').split(/\s+/)[0]
      .replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30)
    // Y4: skip terms ≤6 chars (too broad — "auth" matches authorization, authToken, etc.)
    if (!term || term.length <= 6) return Promise.resolve(null)
    return trackedAgent(
      `Shell only. Find files that import or reference "${term}":
Run: timeout 15 grep -rl "${term}" ${broadSearchRoot}/ 2>/dev/null
Return { acBullet: "${b.replace(/"/g, '\\"')}", cascadeFiles: [<all matching paths>] }`,
      { label: `${phase}:cascade:${term}`, phase, model: haikuModel, schema: CASCADE_SCHEMA }
    )
  }))
  const map = {}
  for (const r of results.filter(Boolean)) {
    if ((r.cascadeFiles || []).length > 0) map[r.acBullet] = r.cascadeFiles
  }
  return map
}

// Y3: first pass on rawAcBullets (available now in Observe)
const cleanupBullets = rawAcBullets.filter(b => classifyAcBullet(b).isCleanup)
const cascadeFileMap = await runCascadeGrep(cleanupBullets, 'Observe')
const cascadeTotal = Object.values(cascadeFileMap).reduce((s, f) => s + f.length, 0)
if (cascadeTotal > 0) log(`Observe: cascade grep found ${cascadeTotal} importer file(s) for ${Object.keys(cascadeFileMap).length} cleanup AC(s)`)

log(`Observe complete: ${allObservedFiles.length} files, ${observedLayers.length} layers, ${Object.keys(cascadeFileMap).length} cleanup cascades`)

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2: REASON
// LLMs receive pre-counted facts from Observe. NL tasks only — no shell.
// Fix 1: classify receives observed counts → scopePath refined here, used in ac-files below.
// Fix 4: AC-synth adds suggestedType per AC → groupers receive it as pre-set hint.
// Fix 2: ac-files runs shellCommand fallback for non-grep ACs.
// ═══════════════════════════════════════════════════════════════════════════════

phase('Reason')
currentPhase = 'Reason'

const CLASSIFY_SCHEMA = {
  type: 'object',
  required: ['workType', 'size', 'splitRequired', 'reasoning', 'scopePath', 'sourceTitle', 'migrationPattern'],
  properties: {
    workType:         { type: 'string', enum: ['migration', 'feature', 'bug', 'refactor', 'cleanup', 'non-deployable'] },
    size:             { type: 'string', enum: ['XS', 'S', 'M', 'L'] },
    splitRequired:    { type: 'boolean' },
    reasoning:        { type: 'string' },
    scopePath:        { type: 'string', description: 'refined directory scope e.g. src/client; empty if whole repo' },
    sourceTitle:      { type: 'string', description: 'first line of ticket, max 80 chars' },
    migrationPattern: { type: 'string', description: '"old → new" for migrations, else empty' },
  },
}

// Fix 4: suggestedType added to AC_SYNTH_SCHEMA — groupers receive pre-classified hint
// Fix 2: shellCommand added for non-grep ACs (find, read, custom)
const AC_SYNTH_SCHEMA = {
  type: 'object',
  required: ['acList'],
  properties: {
    acList: {
      type: 'array',
      items: {
        type: 'object',
        required: ['bullet', 'grepPattern', 'searchScope', 'suggestedType', 'shellCommand'],
        properties: {
          bullet:        { type: 'string', description: 'action-framed AC text' },
          grepPattern:   { type: 'string', description: 'grep -rl pattern; empty for non-grep ACs' },
          searchScope:   { type: 'string', description: 'path relative to repoPath; empty = use scopePath' },
          suggestedType: { type: 'string', enum: ['migration', 'cleanup', 'deferred', 'validation'],
                          description: 'hint for grouper classification — classifyAcBullet in JS is authoritative but this prevents flag inheritance gaps' },
          shellCommand:  { type: 'string', description: 'full shell command for non-grep ACs (find, cat, ls); empty if grepPattern is set' },
        },
      },
    },
  },
}

const GROUPER_SCHEMA = {
  type: 'object',
  required: ['subtasks'],
  properties: {
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'description', 'scopePath', 'files', 'estimatedFileCount', 'targetSize'],
        properties: {
          title:              { type: 'string' },
          description:        { type: 'string' },
          scopePath:          { type: 'string' },
          files:              { type: 'array', items: { type: 'string' } },
          estimatedFileCount: { type: 'number' },
          targetSize:         { type: 'string', enum: ['XS', 'S'] },
        },
      },
    },
  },
}

// 2a. Classify + AC-synth in parallel (both no-tools)
const [classifyResult, acSynthResult] = await parallel([
  () => trackedAgent(
    `You are a work classifier. Do NOT run any shell commands or use any tools.

OBSERVED FILE COUNTS (from shell — ground truth, not ticket claims):
${observedLayers.map(l => `  ${l.layer || 'root'}: ${l.count} files`).join('\n') || '  (none found)'}
Total observed: ${totalObservedFiles} files

TICKET TEXT:
${input}

SIZE RULES (use observed counts, not ticket text):
  XS: 1-3 files  |  S: <10  |  M: 10-30  |  L: 30+ or cross-cutting
  When between sizes choose the LARGER. splitRequired = true ONLY for L.

SCOPE PATH: narrow to the specific directory the work lives in (e.g. src/client, not src/).
MIGRATION PATTERN: "old → new" if migration, else empty string.
SOURCE TITLE: first line of ticket text, max 80 chars.

Return CLASSIFY_SCHEMA.`,
    { label: 'reason:classify', phase: 'Reason', model: sonnetModel, schema: CLASSIFY_SCHEMA }
  ),

  () => trackedAgent(
    `You are an AC synthesizer. Do NOT run any shell commands or use any tools.

TICKET TEXT:
${input}

RAW AC BULLETS FROM TICKET (regex-extracted — may need rephrasing):
${rawAcBullets.length > 0 ? rawAcBullets.map(b => '  * ' + b).join('\n') : '  (none — infer from description)'}

OBSERVED FACTS:
  total files matching migration pattern: ${totalObservedFiles}
  layers: ${repoLayers.join(', ') || '(single root)'}

AC FRAMING RULES — implementation ACs must be ACTIONS not outcomes:
  WRONG: "No axios imports remain in src/client/"
  RIGHT: "Migrate axios imports to clientFetch in src/client/"
  Validation ACs (verify/confirm/check) only valid for shell checks like "npm install"

GRANULARITY: one AC per distinct concern (not per directory). Max 10 ACs total.
For migrations: always add an AC for bypass patterns (e.g. bare fetch() alongside axios).

suggestedType rules:
  migration  — file changes implementing the core pattern swap
  cleanup    — deleting files, removing deps, package.json changes
  deferred   — new feature additions, config changes (AbortController, timeouts)
  validation — shell-only verification (npm install, test runs)

shellCommand: for non-grep ACs (cleanup/deferred/validation), provide the exact shell command
  that would find relevant files. Examples:
    cleanup: "find ${repoPath}/src -name 'authMiddleware*' -type f"
    deferred: "find ${repoPath}/src -name 'clientFetch*' -type f"
    validation: "cat ${repoPath}/package.json | grep axios"

Return AC_SYNTH_SCHEMA.`,
    { label: 'reason:ac-synth', phase: 'Reason', model: sonnetModel, schema: AC_SYNTH_SCHEMA }
  ),
])

if (!classifyResult) throw new Error('Classify agent failed')
if (!acSynthResult)  throw new Error('AC synthesis agent failed')

const { workType, size, splitRequired, scopePath, migrationPattern } = classifyResult
const ticketType  = workType
const sourceTitle = classifyResult.sourceTitle || input.split('\n')[0].slice(0, 80)
// R2: add researchType for harness-plan compatibility (reads researchType enum, not grepPattern/shellCommand)
const acList = (acSynthResult.acList || []).map(ac => ({
  ...ac,
  researchType: ac.grepPattern
    ? 'grep'
    : ac.shellCommand?.startsWith('find') ? 'find'
    : ac.shellCommand ? 'shell'
    : 'grep',
}))

// Fix 1: scopePath from classify is now authoritative — used for ac-files scoping below
const refinedSearchRoot = scopePath ? `${repoPath}/${scopePath}` : broadSearchRoot
log(`Reason: size=${size} splitRequired=${splitRequired} type=${workType} scopePath="${scopePath}" acList=${acList.length}`)

// Y3: second cascade pass — pick up inferred cleanup ACs that didn't exist in rawAcBullets
const inferredCleanupBullets = acList
  .filter(ac => classifyAcBullet(ac.bullet).isCleanup && !cascadeFileMap[ac.bullet])
  .map(ac => ac.bullet)
if (inferredCleanupBullets.length > 0) {
  const inferredCascadeMap = await runCascadeGrep(inferredCleanupBullets, 'Reason')
  for (const [bullet, files] of Object.entries(inferredCascadeMap)) {
    cascadeFileMap[bullet] = files
    log(`Reason: cascade (inferred AC) → ${files.length} file(s) for "${bullet.slice(0, 50)}"`)
  }
}

// ─── Early exit for XS/S/M ────────────────────────────────────────────────────
if (!splitRequired) {
  const outputTokensTotal = budget.spent() - workflowStartTokens
  const estimatedCostUsd = parseFloat(
    Object.entries(tokensByModel).reduce((sum, [model, tokens]) => {
      const rate = model.includes('opus') ? 75 : model.includes('haiku') ? 1.25 : 15
      return sum + (tokens / 1_000_000) * rate
    }, 0).toFixed(4)
  )
  const intakeManifest = {
    skill: 'harness-intake-v2', sourceIssue: issueKey || null, sourceTitle,
    size, workType, migrationPattern, scopePath, acList,
    files: allObservedFiles, execution: 'sequential', groundedReality: null,
  }
  const nextCmd = issueKey
    ? `/harness-plan --intake docs/plans/${args.today || 'today'}-${issueKey}-intake-manifest.json`
    : `/harness-plan --intake <intake-manifest-path>`
  const totalAgents = Object.values(agentCountByModel).reduce((a, b) => a + b, 0)
  const agentLines  = Object.entries(agentCountByModel).filter(([, c]) => c > 0).map(([m, c]) => {
    const label = m.includes('opus') ? 'opus  ' : m.includes('haiku') ? 'haiku ' : 'sonnet'
    return `    ${label}  (×${c})  ${(tokensByModel[m] || 0).toLocaleString()} tok`
  }).join('\n')
  const cliSummary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
harness-intake-v2
  status:  COMPLETE  ✅

  ticket:  ${issueKey || 'unknown'}
  size:    ${size}
  agents:  ${totalAgents}
${agentLines}
  cost:    ~$${estimatedCostUsd}

  type:    ${workType}
  reason:  ${classifyResult.reasoning}
  ac:      ${acList.length} criteria  files: ${allObservedFiles.length} observed${migrationPattern ? `  pattern: ${migrationPattern}` : ''}

  quality: ✓ clean
  next:    ${nextCmd}
  audit:   ~/.claude/harness-intake-runs.jsonl
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  await writeAuditRecord('COMPLETE', { size, workType, acCount: acList.length, subtaskCount: 0, execution: 'sequential', framingConflicts: 0 })
  auditWritten = true
  log(cliSummary)
  return { splitRequired: false, size, intakeManifest, cliSummary }
}

// ─── L ticket: per-AC file mapping ────────────────────────────────────────────
// Fix 1: scope-after-classify — ac-files uses refinedSearchRoot (from classify), not roughScope
// Fix 2: shellCommand fallback for non-grep ACs (find, cat, custom)
// Fix 3: inline zero-file retry — if grep returns 0, run broader (no --include, -i)

const AC_FILES_SCHEMA = {
  type: 'object',
  required: ['acBullet', 'files', 'count'],
  properties: {
    acBullet: { type: 'string' },
    files:    { type: 'array', items: { type: 'string' } },
    count:    { type: 'number' },
  },
}

const acFilesBatches = []
for (let i = 0; i < acList.length; i += 5) {
  const batch = acList.slice(i, i + 5)
  const batchResults = await parallel(batch.map((ac, batchIdx) => () => {
    // Y5: if ac.searchScope exists but doesn't start with scopePath, override with refinedSearchRoot
    const acScope = ac.searchScope
      ? (scopePath && !ac.searchScope.startsWith(scopePath) ? refinedSearchRoot : `${repoPath}/${ac.searchScope}`)
      : refinedSearchRoot
    const escapedPat  = (ac.grepPattern || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Fix 2: use shellCommand when no grepPattern
    // Fix 3: run two grep variants (with and without -i) and pick the higher count
    const cmd = ac.grepPattern
      ? `timeout 15 grep -rl "${escapedPat}" ${acScope}/ 2>/dev/null`
      : (ac.shellCommand || `echo ""`)
    const retryCmd = ac.grepPattern
      ? `timeout 15 grep -irl "${escapedPat}" ${acScope}/ 2>/dev/null`
      : null
    // Y1: convert to trackedAgent so ac-files calls count toward cost tracking
    return trackedAgent(
      `Shell only.
Step 1: ${cmd}
${retryCmd ? `Step 2 (broader, -i): ${retryCmd}
Use whichever step returned more results as your files[] list.` : ''}
Return { acBullet: "${ac.bullet.replace(/"/g, '\\"')}", files: [<all paths from best step>], count: <number> }`,
      { label: `reason:ac-files:${i + batchIdx}`, phase: 'Reason', model: haikuModel, schema: AC_FILES_SCHEMA }
    )
  }))
  acFilesBatches.push(...batchResults)
}

const acFileResults = acFilesBatches.filter(Boolean)
log(`Reason: AC file mapping — ${acFileResults.length}/${acList.length} ACs resolved`)

// Build map: acBullet → files
const acFilesMap = {}
for (const r of acFileResults) acFilesMap[r.acBullet] = r.files || []

// Inject cascade files into corresponding cleanup AC file lists (Fix 5)
for (const [bullet, cascadeFiles] of Object.entries(cascadeFileMap)) {
  const existing = acFilesMap[bullet] || []
  const merged   = [...new Set([...existing, ...cascadeFiles])]
  if (merged.length > existing.length) {
    log(`Reason: injected ${merged.length - existing.length} cascade file(s) into cleanup AC "${bullet.slice(0, 50)}"`)
    acFilesMap[bullet] = merged
    const r = acFileResults.find(r => r.acBullet === bullet)
    if (r) { r.files = merged; r.count = merged.length }
  }
}

// ─── Groupers ─────────────────────────────────────────────────────────────────
// Fix 4: groupers receive suggestedType pre-set — no silent flag inheritance gap

const grouperBatches = []
for (let i = 0; i < acList.length; i += 5) {
  const batch = acList.slice(i, i + 5)
  const batchResults = await parallel(batch.map(ac => () => {
    const { isValidation } = classifyAcBullet(ac.bullet)
    const files = acFilesMap[ac.bullet] || []

    // Validation ACs and zero-file ACs skip the grouper
    if (isValidation || files.length === 0) return Promise.resolve({ subtasks: [] })

    // Fix 4: pass suggestedType explicitly so flag inheritance never relies on file intersection
    const suggestedType = ac.suggestedType || 'migration'
    return trackedAgent(
      `You are a subtask grouper. Do NOT use any tools or run any shell commands.

ACCEPTANCE CRITERION: "${ac.bullet}"
SUGGESTED TYPE: ${suggestedType}  ← pre-classified; use to inform description framing
FILES (${files.length} total, already verified by shell): ${JSON.stringify(files)}
${migrationPattern ? `MIGRATION PATTERN: ${migrationPattern}` : ''}
${issueKey ? `ISSUE KEY: ${issueKey}` : ''}

YOUR ONLY JOBS:
1. Write a title: "${issueKey ? issueKey + ': ' : ''}[verb] [directory] ([N] files)"
2. Write a description: one paragraph — what changes, what pattern, list files explicitly
3. scopePath = longest common directory prefix of the files
4. targetSize = XS (≤4 files) or S (5-8 files)
5. If files.length > 8: split into chunks of 8 alphabetically, one subtask per chunk

Do NOT assign groupId. Do NOT run any shell commands.

Return GROUPER_SCHEMA.`,
      { label: `reason:grouper:${ac.bullet.slice(0, 30).replace(/\s+/g, '-')}`, phase: 'Reason', model: haikuModel, schema: GROUPER_SCHEMA }
    )
  }))
  grouperBatches.push(...batchResults)
}

const allGrouperSubtasks = grouperBatches.filter(Boolean).flatMap(d => d.subtasks || [])
log(`Reason: groupers → ${allGrouperSubtasks.length} subtask drafts`)

// Y6: classifyAcBullet(s.title) is authoritative — do not use file intersection to inherit flags.
// File intersection was wrong when a subtask's files spanned multiple AC types; first-match won.
for (const s of allGrouperSubtasks) {
  Object.assign(s, classifyAcBullet(s.title))
}

// ─── Deferred/cleanup ACs with files → direct subtask injection ───────────────
const coveredFileSet  = new Set(allGrouperSubtasks.flatMap(s => s.files || []))
const doneConditionAcs = []

for (const r of acFileResults) {
  const { isDeferred, isCleanup, isValidation } = classifyAcBullet(r.acBullet)
  if (isValidation)             { doneConditionAcs.push(r.acBullet); continue }
  if (!isDeferred && !isCleanup) continue
  const acFiles = acFilesMap[r.acBullet] || []
  if (acFiles.length === 0)    continue
  const alreadyCovered = acFiles.filter(f => coveredFileSet.has(f)).length / acFiles.length > 0.5
  if (alreadyCovered)          continue
  const chunks = acFiles.length > 8
    ? Array.from({ length: Math.ceil(acFiles.length / 8) }, (_, i) => acFiles.slice(i * 8, (i + 1) * 8))
    : [acFiles]
  const cls = classifyAcBullet(r.acBullet)
  for (const chunk of chunks) {
    allGrouperSubtasks.push({
      title: `${issueKey ? issueKey + ': ' : ''}${r.acBullet.slice(0, 70)}`,
      description: r.acBullet,
      scopePath: scopePath || '',
      files: chunk, estimatedFileCount: chunk.length,
      targetSize: chunk.length <= 4 ? 'XS' : 'S',
      needsReview: false, ...cls,
    })
    for (const f of chunk) coveredFileSet.add(f)
  }
}

// Zero-file migration ACs → stubs; others → done-conditions
for (const r of acFileResults) {
  if (r.count > 0) continue
  const { isMigration } = classifyAcBullet(r.acBullet)
  if (isMigration) {
    allGrouperSubtasks.push(...makeStubs(r.acBullet, [], null, 'Auto-generated stub — file search found no files. Implementer must locate relevant files.'))
  } else {
    doneConditionAcs.push(r.acBullet)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3: VERIFY
// Pure JS except groundedReality (NL summary). No shell.
// ═══════════════════════════════════════════════════════════════════════════════

phase('Verify')
currentPhase = 'Verify'

// 3a. Dedup
const deduped = deduplicateSubtasks(allGrouperSubtasks)
log(`Verify: ${allGrouperSubtasks.length} drafts → ${deduped.length} after dedup`)

// 3b. Deterministic group assignment
const { subtasks: proposedSubtasks, g1Titles, g2Titles, execution: executionMode } = assignGroups(deduped)
log(`Verify: G1=${g1Titles.length} G2=${g2Titles.length} G3=${proposedSubtasks.filter(s => s.groupId === 'G3').length} execution=${executionMode}`)

// 3c. AC coverage check — string prefix OR file-set overlap (Y7)
// String-prefix alone breaks when groupers paraphrase the AC text.
// File overlap catches those cases: if any subtask covers files from this AC it's covered.
const acCoverageResults = acList.map(ac => {
  const acFiles = new Set(acFilesMap[ac.bullet] || [])
  const covered = proposedSubtasks.some(s => {
    const textMatch = (s.title || '').includes(ac.bullet.slice(0, 40)) ||
      (s.description || '').includes(ac.bullet.slice(0, 40))
    const fileOverlap = acFiles.size > 0 &&
      (s.files || []).some(f => acFiles.has(f))
    return textMatch || fileOverlap
  })
  return { bullet: ac.bullet, covered }
})
const missingAcs     = acCoverageResults.filter(r => !r.covered).map(r => r.bullet)
const coveredAcCount = acCoverageResults.filter(r => r.covered).length
log(`Verify: AC coverage ${coveredAcCount}/${acList.length} | ${missingAcs.length} missing`)

for (const missingBullet of missingAcs) {
  const already = proposedSubtasks.some(s =>
    (s.title || '').includes(missingBullet.slice(0, 40)) ||
    (s.description || '').includes(missingBullet.slice(0, 40))
  )
  if (already) continue
  const { isValidation, isCleanup, isDeferred } = classifyAcBullet(missingBullet)
  if (isValidation) { doneConditionAcs.push(missingBullet); continue }
  const acResearch = acFileResults.find(r => r.acBullet === missingBullet)
  const stubs = makeStubs(missingBullet, acResearch?.files || [], null,
    'Auto-generated stub — AC coverage check found no subtask covering this criterion.')
  for (const stub of stubs) {
    stub.groupId          = (isCleanup || isDeferred) ? 'G2' : 'G1'
    stub.canRunInParallel = stub.groupId === 'G1'
    stub.dependsOn        = stub.groupId === 'G2' ? [...g1Titles] : []
  }
  proposedSubtasks.push(...stubs)
}

// Y8: re-run assignGroups after coverage loop so late-added stubs get correct dependsOn
// (g1Titles captured before the loop is stale — any G1 stubs added inside the loop are missing)
const { subtasks: finalSubtasks, g1Titles: finalG1Titles, g2Titles: finalG2Titles, execution: finalExecutionMode } =
  assignGroups(proposedSubtasks)
// Mutate in place to keep all downstream references pointing at the same array
proposedSubtasks.length = 0
proposedSubtasks.push(...finalSubtasks)

// 3d. Structural invariants
const qualityIssues = []
const g2Subs = proposedSubtasks.filter(s => s.groupId === 'G2')
const g3Subs = proposedSubtasks.filter(s => s.groupId === 'G3')
if (g2Subs.some(s => (s.dependsOn || []).length === 0)) qualityIssues.push('G2 subtask missing dependsOn — assignGroups bug')
if (g3Subs.some(s => (s.dependsOn || []).length === 0)) qualityIssues.push('G3 subtask missing dependsOn — assignGroups bug')
if (proposedSubtasks.some(s => (s.files || []).length > 8)) qualityIssues.push('oversized subtask (>8 files)')
// Use finalG1Titles from post-coverage assignGroups pass
if (finalG1Titles.length === 0) qualityIssues.push('no G1 subtasks — all work classified as cleanup/validation/deferred')

// R1: framing conflict — scan ticket body text for number claims, compare to verified shell counts.
// Previous version scanned ac.bullet only, which only has digits when the AC itself states a count.
// Real conflicts live in ticket description (e.g. "migrate 47 files") vs observed counts.
const framingConflicts = []
const ticketNumberClaims = [...(input || '').matchAll(/\b(\d+)\s+(?:file|import|call|instance|usage|occurrence|migration)/gi)]
  .map(m => ({ claim: parseInt(m[1]), context: m[0] }))
  .filter(c => c.claim > 3)  // ignore "2 files" — could be legit small scope

for (const { claim, context } of ticketNumberClaims) {
  const discrepancy = Math.abs(totalObservedFiles - claim) / Math.max(claim, 1)
  if (discrepancy > 0.20) {
    framingConflicts.push({ bullet: context, ticketClaimed: claim, verified: totalObservedFiles })
  }
}
// Also check per-AC bullet for inline digit claims (original intent, now secondary)
for (const ac of acList) {
  const ticketMatch = ac.bullet.match(/\b(\d+)\b/)
  const ticketClaimed = ticketMatch ? parseInt(ticketMatch[1]) : 0
  const verified = (acFileResults.find(r => r.acBullet === ac.bullet)?.count) || 0
  if (ticketClaimed > 3 && verified > 0) {
    const discrepancy = Math.abs(verified - ticketClaimed) / Math.max(ticketClaimed, 1)
    if (discrepancy > 0.20 && !framingConflicts.some(c => c.ticketClaimed === ticketClaimed)) {
      framingConflicts.push({ bullet: ac.bullet, ticketClaimed, verified })
    }
  }
}
if (framingConflicts.length > 0) {
  log(`⚠️  Framing conflicts: ${framingConflicts.length} claim(s) where ticket count ≠ verified count`)
}

// 3f. Holistic summary — only NL task in Verify
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['verdict', 'acCoverage', 'fileCountPlausible', 'stubsNeedReview', 'issues', 'groundedReality'],
  properties: {
    verdict:            { type: 'string', enum: ['PASS', 'PASS_WITH_NOTES', 'FAIL'] },
    acCoverage:         { type: 'string' },
    fileCountPlausible: { type: 'boolean' },
    stubsNeedReview:    { type: 'array', items: { type: 'string' } },
    issues:             { type: 'array', items: { type: 'string' } },
    groundedReality: {
      type: 'object',
      required: ['summary', 'actualFileCount', 'actualScope', 'ticketClaimsToIgnore', 'keyFiles', 'migrationNotes'],
      properties: {
        summary:              { type: 'string' },
        actualFileCount:      { type: 'number' },
        actualScope:          { type: 'string' },
        ticketClaimsToIgnore: { type: 'array', items: { type: 'string' } },
        keyFiles:             { type: 'array', items: { type: 'string' } },
        migrationNotes:       { type: 'string' },
      },
    },
  },
}

const verifyResult = await trackedAgent(
  `You are a manifest verifier. Do not use any tools.

ORIGINAL TICKET TEXT (may contain wrong numbers — treat with suspicion):
${input.slice(0, 800)}

OBSERVED FACTS (from shell — ground truth):
  total files found: ${totalObservedFiles}
  layers: ${observedLayers.map(l => (l.layer || 'root') + ' (' + l.count + ')').join(', ')}
  AC file mapping: ${acFileResults.map(r => `"${r.acBullet.slice(0, 40)}" → ${r.count} files`).join(', ')}
${framingConflicts.length > 0 ? `\nFRAMING CONFLICTS:\n${framingConflicts.map(c => `  "${c.bullet.slice(0, 60)}"  ticket:${c.ticketClaimed} verified:${c.verified}`).join('\n')}` : ''}

ASSEMBLED SUBTASKS (${proposedSubtasks.length} total):
${JSON.stringify(proposedSubtasks.map(s => ({ title: s.title, groupId: s.groupId, fileCount: (s.files || []).length, needsReview: s.needsReview })))}

TASKS:
1. groundedReality — what did shell commands ACTUALLY find vs ticket claims?
2. Is file count plausible? (subtask total ≈ observed total ±20%)
3. verdict: PASS if good, PASS_WITH_NOTES if minor gaps, FAIL if >2 ACs uncovered

Return VERIFY_SCHEMA.`,
  { label: 'verify:summary', phase: 'Verify', model: sonnetModel, schema: VERIFY_SCHEMA }
)

if (verifyResult?.issues?.length > 0) {
  for (const issue of verifyResult.issues) qualityIssues.push(`verify: ${issue}`)
}
if (verifyResult?.stubsNeedReview?.length > 0) {
  for (const stub of verifyResult.stubsNeedReview) qualityIssues.push(`stub needs review: "${stub}"`)
}
log(`Verify: ${verifyResult?.verdict || 'no result'} — ${verifyResult?.acCoverage || '?'} | plausible: ${verifyResult?.fileCountPlausible}`)

// Y9: structural log fires here — after verifyResult is processed and qualityIssues is complete
const structuralPass = qualityIssues.length === 0
if (!structuralPass) {
  log(`⚠️  Structural issues: ${qualityIssues.join(' | ')}`)
} else {
  log(`✅ Structural check passed — G1:${finalG1Titles.length} G2:${g2Subs.length} G3:${g3Subs.length} deps:wired stubs:${proposedSubtasks.filter(s => s.needsReview).length}`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4: ACT
// No decisions. Build outputs and write. Fix 6: SKILL.md handles Jira creation.
// ═══════════════════════════════════════════════════════════════════════════════

phase('Act')
currentPhase = 'Act'

const groupMap = {}
for (const s of proposedSubtasks) {
  if (!groupMap[s.groupId]) groupMap[s.groupId] = []
  groupMap[s.groupId].push(s)
}
const groups = Object.entries(groupMap).map(([groupId, subtasks]) => ({
  groupId,
  parallel: subtasks.every(s => s.canRunInParallel),
  subtasks,
}))

const groundedReality = verifyResult?.groundedReality || null
const splitManifest = {
  skill: 'harness-intake-v2',
  sourceIssue: issueKey || 'unknown',
  sourceTitle,
  size,
  ticketType,
  migrationPattern,
  groundedReality,
  execution: finalExecutionMode,
  groups,
}

const parallelCount   = proposedSubtasks.filter(s => s.canRunInParallel).length
const sequentialCount = proposedSubtasks.filter(s => !s.canRunInParallel).length
const hasStubs        = proposedSubtasks.some(s => s.needsReview)

const planStatus =
    framingConflicts.length > 0 ? 'COMPLETE_FRAMING_CORRECTED'
  : hasStubs                    ? 'COMPLETE_WITH_STUBS'
  : qualityIssues.length > 0    ? 'PROPOSED_WITH_GAPS'
  : 'COMPLETE'

await writeAuditRecord(planStatus, {
  size,
  ticketType: workType,
  migrationPattern,
  subtaskCount: proposedSubtasks.length,
  execution: finalExecutionMode,
  parallelCount,
  sequentialCount,
  acStrategiesRun: acList.length,
  acFilesFound: acFileResults.reduce((sum, r) => sum + r.count, 0),
  zeroCoverageAcs: acFileResults.filter(r => r.count === 0).map(r => r.acBullet),
  doneConditionAcs,
  framingConflicts: framingConflicts.length,
  framingConflictDetails: framingConflicts,
  qualityIssues,
})
auditWritten = true

// Build CLI
const groupLines = groups.map(g => {
  const label    = g.parallel ? '— parallel' : '— sequential'
  const taskLines = g.subtasks.map(t =>
    `    ${t.title.padEnd(55)}  ${String((t.files || []).length).padStart(2)} files  → ${t.targetSize}`
  ).join('\n')
  return `  [${g.groupId} ${label}]\n${taskLines}`
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
const statusIcon  = planStatus === 'COMPLETE' || planStatus === 'COMPLETE_FRAMING_CORRECTED' ? '✅' : '⚠️'
const totalAgents = Object.values(agentCountByModel).reduce((a, b) => a + b, 0)
const agentLines  = Object.entries(agentCountByModel).filter(([, c]) => c > 0).map(([m, c]) => {
  const label = m.includes('opus') ? 'opus  ' : m.includes('haiku') ? 'haiku ' : 'sonnet'
  return `    ${label}  (×${c})  ${(tokensByModel[m] || 0).toLocaleString()} tok`
}).join('\n')

const conflictLines = framingConflicts.length > 0
  ? `\n  framing: corrected — ticket claims overridden by verified counts\n` +
    framingConflicts.map(c => `     "${c.bullet.slice(0, 60)}"  ticket:${c.ticketClaimed} → verified:${c.verified}`).join('\n') + '\n'
  : ''

const cliSummary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
harness-intake-v2
  status:  ${planStatus}  ${statusIcon}

  ticket:  ${issueKey || 'unknown'}
  size:    ${size}
  agents:  ${totalAgents}
${agentLines}
  cost:    ~$${estimatedCostUsd}
${conflictLines}
  subtasks: ${proposedSubtasks.length} proposed    execution: ${finalExecutionMode}
${groupLines}
${doneConditionAcs.length > 0 ? `\n  done-conditions:\n${doneConditionAcs.map(ac => `    · ${ac.slice(0, 80)}`).join('\n')}\n` : ''}
  quality: ${qualityLine}
  next:    confirm → create Jira subtasks → /harness-plan each G1 subtask
  audit:   ~/.claude/harness-intake-runs.jsonl
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

log(cliSummary)

const intakeManifestL = {
  skill: 'harness-intake-v2', sourceIssue: issueKey || null, sourceTitle,
  size, workType, migrationPattern, scopePath, acList,
  files: allObservedFiles, execution: finalExecutionMode, groundedReality,
}

return {
  splitRequired: true,
  size, workType, ticketType, migrationPattern,
  splitPlan: { execution: finalExecutionMode, subtasks: proposedSubtasks },
  splitManifest,
  intakeManifest: intakeManifestL,
  totalFilesFound: totalObservedFiles,
  qualityIssues,
  status: planStatus,
  cliSummary,
}

} catch (err) {
  if (!auditWritten) {
    const isKilled = err.message?.includes('abort') || err.message?.includes('cancel') || err.message?.includes('interrupt')
    const crashStatus = isKilled ? 'KILLED'
      : ['Reason', 'Verify', 'Act'].includes(currentPhase) ? 'PROPOSED_WITH_GAPS'
      : 'FAILED'
    await writeAuditRecord(crashStatus, {
      failedAtPhase: currentPhase,
      error: err.message || String(err),
      size: null,
      subtaskCount: 0,
      qualityIssues: [],
    }).catch(() => {})
  }
  throw err
}
