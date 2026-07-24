export const meta = {
  name: 'harness-split',
  description: 'Size a Jira ticket and split it into atomic subtasks before harness-plan runs',
  phases: [
    { title: 'Work Intelligence', detail: 'Sonnet — classify work, synthesize AC list, derive per-AC research strategies' },
    { title: 'Research',          detail: 'Sonnet — dual fan-out: per-AC strategy agents + per-layer structure agents' },
    { title: 'Split Design',      detail: 'Sonnet — per-layer designer fan-out + AC stub injection + merge agent + AC verify' },
    { title: 'Debrief',           detail: 'Haiku — audit log, quality check, CLI summary' },
  ],
}

// args: { input, cloudId?, issueKey?, repoPath, today? }
// input: raw ticket text (summary + description)
// cloudId + issueKey: passed by SKILL.md for audit labeling only — not used inside workflow
// repoPath: absolute path to the repo

const input = args.input
const repoPath = args.repoPath
const issueKey = args.issueKey || ''

if (!input) throw new Error('harness-split requires input')
if (!repoPath) throw new Error('harness-split requires repoPath')

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
`

// ─── Token tracking ───────────────────────────────────────────────────────────
const workflowStartTokens = budget.spent()
const tokensByModel = {}

async function trackedAgent(prompt, opts) {
  const before = budget.spent()
  const result = await agent(prompt, opts)
  const m = opts.model || sonnetModel
  tokensByModel[m] = (tokensByModel[m] || 0) + (budget.spent() - before)
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
  const record = JSON.stringify({
    ts: args.today || 'unknown',
    skill: 'harness-split',
    status,
    sourceIssue: issueKey || 'unknown',
    outputTokensByModel: tokensByModel,
    outputTokensTotal,
    estimatedCostUsd,
    ...extra,
  })
  await agent(
    `Append exactly one line to a JSONL file. Use the Bash tool only.
Run: echo '${record.replace(/'/g, "'\\''")}' >> ~/.claude/harness-split-runs.jsonl
Return { appended: true }.`,
    {
      label: 'audit-write',
      phase: 'Debrief',
      model: haikuModel,
      schema: { type: 'object', required: ['appended'], properties: { appended: { type: 'boolean' } } },
    }
  )
}

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
          bullet:       { type: 'string', description: 'the AC text verbatim or inferred' },
          researchType: { type: 'string', enum: ['grep', 'find', 'read', 'shell'], description: 'grep=pattern search; find=directory enumerate; read=single file; shell=custom command' },
          grepPattern:  { type: 'string', description: 'grep -rl pattern, e.g. "axios" or "fetch(" — empty if researchType is not grep' },
          searchScope:  { type: 'string', description: 'path relative to repoPath to constrain this AC search, e.g. src/client/middleware — empty = use scopePath' },
          shellCommand: { type: 'string', description: 'full shell command for researchType=shell or find, e.g. "find src/client/middleware -name auth.js"' },
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
        required: ['title', 'description', 'scopePath', 'files', 'estimatedFileCount', 'targetSize', 'isMigration', 'isCleanup', 'isValidation'],
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
        required: ['title', 'description', 'layer', 'scopePath', 'files', 'estimatedFileCount', 'groupId', 'canRunInParallel', 'dependsOn', 'targetSize'],
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

// ─── Phase 0: Work Intelligence ───────────────────────────────────────────────
// Classifies work type, synthesizes a complete AC list (inferred when missing),
// and derives per-AC research strategies. Research agents are driven by these
// strategies — NOT by layer structure alone. Layer structure is secondary scope.

phase('Work Intelligence')

const workIntelResult = await trackedAgent(
  `You are a work intelligence agent for harness-split. Your job is to fully understand what this ticket requires BEFORE any files are touched.
${PHILOSOPHY}

STEP 1 — REPO LAYER DISCOVERY (shell command — never infer):
Run: ls ${repoPath}/src 2>/dev/null || ls ${repoPath}/app 2>/dev/null || ls ${repoPath}/lib 2>/dev/null
Populate repoLayers from actual output.

STEP 2 — CLASSIFY the work type:
  migration     — replace pattern A with B across N files (e.g. axios → fetch)
  feature       — add new capability; find integration points and analogous patterns
  bug           — fix broken behavior; find call sites and test coverage
  refactor      — restructure without behavior change; find all usages + dependents
  cleanup       — remove dead code, imports, deps; find all references
  non-deployable — config, CI, docs, tooling only

STEP 3 — SIZE the ticket:
  XS: 1-3 files, single obvious change
  S:  under 10 files, single concern
  M:  10-30 files, multiple concerns, no cross-cutting migration
  L:  30+ files OR cross-cutting change OR multiple distinct subsystems
  HARD RULE: file count ≥ 30 mentioned explicitly → L, no downgrade.
  HARD RULE: when between two sizes, choose the LARGER.
  splitRequired = true ONLY for L.

STEP 4 — SYNTHESIZE the complete AC list:
  If ACs are explicit in the ticket: use them verbatim.
  If ACs are partial or missing: INFER the full set from the ticket description.
  For each AC, derive a research strategy:
    - grep:  use when you need to find files matching a code pattern
             grepPattern = the literal string to grep, e.g. "axios" or "fetch("
    - find:  use when you need to enumerate files in a directory
             shellCommand = e.g. "find ${repoPath}/src/client/middleware -type f"
    - read:  use when a specific file must be read, e.g. package.json
             shellCommand = e.g. "cat ${repoPath}/package.json"
    - shell: use for any other verification, e.g. "npm ls axios"
             shellCommand = the full command

  CRITICAL: every AC that implies file changes needs its own strategy entry.
  ACs like "remove auth middleware" → researchType=find, shellCommand=find on that dir.
  ACs like "no axios imports remaining" → researchType=grep, grepPattern="axios".
  ACs about package.json → researchType=read, shellCommand=cat package.json.
  ACs about adding a feature → researchType=grep on analogous pattern + find on target dir.

SCOPE PATH:
  If ticket mentions a specific directory (e.g. "src/client/"), set scopePath to that.
  Empty string = whole repo or can't determine from text.

INPUT:
${input}`,
  { label: 'work-intel', phase: 'Work Intelligence', model: sonnetModel, schema: WORK_INTEL_SCHEMA }
)

if (!workIntelResult) throw new Error('Work Intelligence failed — cannot proceed')

const { workType, size, splitRequired, migrationPattern, repoLayers, scopePath, acList } = workIntelResult
const ticketType = workType  // preserve compatibility with downstream references
const sourceTitle = workIntelResult.sourceTitle || input.split('\n')[0].slice(0, 80)

log(`Work Intelligence: size=${size} splitRequired=${splitRequired} type=${workType}${migrationPattern ? ` pattern="${migrationPattern}"` : ''}${scopePath ? ` scope="${scopePath}"` : ''} layers=[${repoLayers.join(', ')}] acList=${acList.length} strategies`)

// ─── Early exit for XS/S/M ────────────────────────────────────────────────────

if (!splitRequired) {
  const outputTokensTotal = budget.spent() - workflowStartTokens
  const estimatedCostUsd = parseFloat(
    Object.entries(tokensByModel).reduce((sum, [model, tokens]) => {
      const rate = model.includes('opus') ? 75 : model.includes('haiku') ? 1.25 : 15
      return sum + (tokens / 1_000_000) * rate
    }, 0).toFixed(4)
  )
  const skipSummary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SKIPPED  ✅

  ticket:  ${issueKey || 'unknown'}
  size:    ${size}        cost:  ~$${estimatedCostUsd}

  reason:  ${workIntelResult.reasoning}

  quality: ✓ clean
  next:    /harness-plan ${issueKey ? `https://fandango.atlassian.net/browse/${issueKey}` : '<ticket-url>'}
  audit:   ~/.claude/harness-split-runs.jsonl
  tokens:  ${outputTokensTotal.toLocaleString()}  (~$${estimatedCostUsd} estimated)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  await writeAuditRecord('SKIPPED', {
    size,
    ticketType,
    subtaskCount: 0,
    execution: 'sequential',
    parallelCount: 0,
    sequentialCount: 0,
  })
  log(skipSummary)
  return {
    splitRequired: false,
    size,
    cliSummary: skipSummary,
  }
}

// ─── Phase 1: Research — dual fan-out (AC strategies + layer structure) ───────
// Stream 1: one agent per AC strategy — finds files/facts for each acceptance criterion
// Stream 2: one agent per repo layer — finds ALL in-scope files by structural layer
// Both run in parallel. Fan-in merges results; AC-covered files get acCoverage metadata.

phase('Research')

const searchRoot = scopePath
  ? `${repoPath}/${scopePath}`
  : `${repoPath}/src`

// Stream 1: AC-driven research — one agent per AC strategy
const acResearchResults = await parallel(
  acList.map(ac => () => trackedAgent(
    `You are a shell-only AC researcher for harness-split. Do not read any files.
${PHILOSOPHY}

YOUR ACCEPTANCE CRITERION: "${ac.bullet}"
RESEARCH TYPE: ${ac.researchType}
${ac.grepPattern ? `GREP PATTERN: ${ac.grepPattern}` : ''}
${ac.searchScope ? `SEARCH SCOPE: ${repoPath}/${ac.searchScope}` : `SEARCH SCOPE: ${searchRoot}`}
${ac.shellCommand ? `SHELL COMMAND: ${ac.shellCommand}` : ''}

REQUIRED (pick by researchType):
  grep:  grep -rl "${ac.grepPattern || '.'}" ${ac.searchScope ? repoPath + '/' + ac.searchScope : searchRoot}/ 2>/dev/null
         Capture ALL paths. Then wc -l for count.
  find:  ${ac.shellCommand || `find ${ac.searchScope ? repoPath + '/' + ac.searchScope : searchRoot} -type f 2>/dev/null`}
  read:  ${ac.shellCommand || `cat ${repoPath}/package.json`}
  shell: ${ac.shellCommand || 'echo "no command specified"'}

RULES:
- files[] must be the COMPLETE list — not a sample, not head -5
- If the command returns nothing, files=[] and fileCount=0 — do not invent files
- findings: one line summarising what you found (e.g. "found 26 files with fetch(")

Return AC_RESEARCH_SCHEMA.`,
    { label: `ac-research:${ac.bullet.slice(0, 40).replace(/\s+/g, '-')}`, phase: 'Research', model: sonnetModel, schema: AC_RESEARCH_SCHEMA }
  ))
)

// Stream 2: layer structure research — one agent per repo layer (existing behavior)
const layersToResearch = repoLayers.length ? repoLayers : ['']
const patternGrepArg = migrationPattern
  ? migrationPattern.split('→')[0].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  : ''

const layerResults = await parallel(
  layersToResearch.map(layer => () => trackedAgent(
    `You are a shell-only layer researcher for harness-split. Do not read any files.
${PHILOSOPHY}

SEARCH ROOT: ${searchRoot}${layer ? '/' + layer : ''}
${patternGrepArg ? `PATTERN: ${patternGrepArg}` : 'TICKET TYPE: non-migration — enumerate all source files by directory'}

REQUIRED COMMANDS (run ALL of these in order):
1. grep -rl "${patternGrepArg || '.'}" ${searchRoot}${layer ? '/' + layer : ''}/ 2>/dev/null
   → capture the full list of matching paths (ALL paths, not just head -5)
2. echo above output | wc -l → for fileCount
3. if fileCount > 8:
   ls ${searchRoot}${layer ? '/' + layer : ''}/ → enumerate subdirectories
   then grep -rl "${patternGrepArg || '.'}" ${searchRoot}${layer ? '/' + layer : ''}/<subdir>/ 2>/dev/null for each subdir

RULES:
- files[] must be the COMPLETE list — not a sample, not head -5
- sublayers[] must list subdirectory breakdowns when fileCount > 8
- canRunInParallel: true if this layer has no shared state with other layers
- dependsOnLayers: list layer names this one must come after (empty for most)

Return LAYER_SCHEMA.`,
    { label: `research:${layer || 'root'}`, phase: 'Research', model: sonnetModel, schema: LAYER_SCHEMA }
  ))
)

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
const validLayers = layerResults.filter(Boolean).filter(l => l.fileCount > 0)
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
const totalAcFiles    = validAcResults.reduce((sum, r) => sum + r.fileCount, 0)

log(`Research: ${validLayers.length} layer(s) with ${totalFilesFound} files | ${validAcResults.length} AC strategies, ${totalAcFiles} AC-covered files | ${zeroCoverageAcs.length} ACs with no files (will stub)`)

if (validLayers.length === 0 && validAcResults.every(r => r.fileCount === 0)) {
  throw new Error(`Research found 0 files in all streams under ${searchRoot} — check scopePath or migrationPattern`)
}

// ─── Phase 2: Split Design — fan-out per layer + AC stubs + merge + AC verify ──

phase('Split Design')

// Normalise file lists: layer files are now objects {path, acCoverage[]}
// Extract plain paths for designer prompts, keep acCoverage for context
const layerFilePaths = (files) => files.map(f => typeof f === 'string' ? f : f.path)

// Per-layer designers run in parallel — each gets its own layer's complete file list
const layerDesigns = await parallel(validLayers.map(layerData => () => trackedAgent(
  `You are a subtask designer for harness-split. Do not use any tools.
${PHILOSOPHY}

LAYER: ${layerData.name}
SCOPE: ${layerData.path}
FILES (${layerData.files.length} total): ${JSON.stringify(layerFilePaths(layerData.files))}
SUBLAYERS: ${JSON.stringify((layerData.sublayers || []).map(s => ({ ...s, files: layerFilePaths(s.files || []) })))}
${migrationPattern ? `MIGRATION PATTERN: ${migrationPattern}` : ''}
${issueKey ? `ISSUE KEY: ${issueKey}` : ''}

RULES:
- max 8 files per subtask — hard cap
- when a sublayer has >8 files, split into two subtasks (alphabetical halves or logical groups)
- default to atomic — never justify grouping to reduce count
- TITLE FORMAT: "${issueKey ? issueKey + ': ' : ''}[verb] [layer/sublayer] ([N] files)"
  Example: "${issueKey || 'TARS-1271'}: Migrate hooks/data-fetching (7 files)"
- DESCRIPTION: one paragraph — what changes, what pattern, list files by path explicitly
- scopePath: the specific directory these files live in (use layerData.path or sublayer path)
- files[]: the exact file paths from the FILES list for this subtask
- targetSize: XS (≤4 files), S (5-8 files)
- isMigration: true if these files need pattern replacement
- isCleanup: true if this is removing dead code/imports after migration
- isValidation: true if this is a grep/shell verification step

Do NOT assign groupId — the merge agent assigns that.
Return LAYER_SUBTASKS_SCHEMA.`,
  { label: `design:${layerData.name || 'root'}`, phase: 'Split Design', model: sonnetModel, schema: LAYER_SUBTASKS_SCHEMA }
)))

const flatProposed = layerDesigns.filter(Boolean).flatMap(d => d.subtasks)
log(`Split Design: ${flatProposed.length} subtasks proposed across ${layerDesigns.filter(Boolean).length} layer(s)`)

// Inject stub subtasks for ACs with zero files found — ensures every AC maps to ≥1 subtask
// before the merge agent runs, not after. Merge agent assigns groupId to stubs too.
const acBullets = acList.map(ac => ac.bullet)
for (const r of zeroCoverageAcs) {
  // Determine stub type from AC text heuristics
  const text = r.acBullet.toLowerCase()
  const isCleanup    = text.includes('remov') || text.includes('delet') || text.includes('package.json') || text.includes('npm install')
  const isValidation = text.includes('verif') || text.includes('confirm') || text.includes('no ') || text.includes('passing') || text.includes('clean install')
  const isMigration  = !isCleanup && !isValidation

  flatProposed.push({
    title: `${issueKey ? issueKey + ': ' : ''}${r.acBullet.slice(0, 70)}`,
    description: `${r.acBullet}\n\nThis subtask was auto-generated from an AC with no files found by research. The implementer must locate the relevant files. AC researcher findings: ${r.findings || 'none'}`,
    scopePath: scopePath || '',
    files: [],
    estimatedFileCount: 0,
    targetSize: 'XS',
    isMigration,
    isCleanup,
    isValidation,
  })
}

if (zeroCoverageAcs.length > 0) {
  log(`Split Design: injected ${zeroCoverageAcs.length} stub subtask(s) for zero-file ACs`)
}

// Merge agent + AC verify run in parallel — both are no-tools reasoning agents
const [mergeResult, acResult] = await parallel([
  () => trackedAgent(
    `You are a merge agent for harness-split. Do not use any tools.

ALL_SUBTASKS (${flatProposed.length} total):
${JSON.stringify(flatProposed, null, 2)}

RULES FOR GROUP ASSIGNMENT:
- isMigration=true  → G1, canRunInParallel=true  (unless dependsOnLayers non-empty)
- isCleanup=true    → G2, canRunInParallel=false, dependsOn=[relevant G1 titles in same layer]
- isValidation=true → G3, canRunInParallel=false, dependsOn=[all G2 titles]
- If both isMigration and isCleanup: treat as isCleanup (G2)
- execution:
    "parallel"   — all subtasks are G1 only
    "sequential" — no G1 parallel subtasks (all cleanup/validation)
    "mixed"      — G1 + G2 or G3 present

Assign to each subtask: groupId, canRunInParallel, dependsOn[].
Return SPLIT_SCHEMA with execution flag.`,
    { label: 'merge-design', phase: 'Split Design', model: sonnetModel, schema: SPLIT_SCHEMA }
  ),
  () => acBullets.length === 0
    ? Promise.resolve(null)
    : trackedAgent(
        `You are an AC coverage checker for harness-split. Do not use any tools.

AC_BULLETS (${acBullets.length} total):
${JSON.stringify(acBullets)}

PROPOSED SUBTASKS:
${JSON.stringify(flatProposed.map(s => ({ title: s.title, description: s.description })))}

For each AC bullet, determine:
- covered: the AC bullet text if a subtask fully addresses it
- partial: the AC bullet text if a subtask partially addresses it
- missing: the AC bullet text if no subtask addresses it at all

Return AC_VERIFY_SCHEMA.`,
        { label: 'ac-verify', phase: 'Split Design', model: sonnetModel, schema: AC_VERIFY_SCHEMA }
      ),
])

if (!mergeResult) throw new Error('Merge agent failed — cannot proceed')

log(`Merge: ${mergeResult.subtasks.length} subtasks assigned, execution=${mergeResult.execution}`)

// ─── Phase 3: Debrief ─────────────────────────────────────────────────────────

phase('Debrief')

const qualityIssues = []

// Quality check — oversized subtasks
for (const s of mergeResult.subtasks) {
  if (s.estimatedFileCount > 8) {
    qualityIssues.push(`oversized: "${s.title}" has ${s.estimatedFileCount} files (max 8)`)
  }
}

// Quality check — G2/G3 missing dependencies
for (const s of mergeResult.subtasks.filter(s => s.groupId === 'G2' || s.groupId === 'G3')) {
  if (!s.dependsOn || s.dependsOn.length === 0) {
    qualityIssues.push(`missing dependency: "${s.title}" is ${s.groupId} but has no dependsOn`)
  }
}

// Quality check — AC coverage gaps
if (acResult?.missing?.length > 0) {
  for (const m of acResult.missing) {
    qualityIssues.push(`AC not covered: "${m}"`)
  }
}

// Build groups via pure JS (no agent)
const groupMap = {}
for (const s of mergeResult.subtasks) {
  if (!groupMap[s.groupId]) groupMap[s.groupId] = []
  groupMap[s.groupId].push(s)
}
const groups = Object.entries(groupMap).map(([groupId, subtasks]) => ({
  groupId,
  parallel: subtasks.every(s => s.canRunInParallel),
  subtasks,  // jiraKey/jiraUrl added by SKILL.md after Jira creation
}))

// Build splitManifest — SKILL.md writes this to disk after injecting jiraKey/jiraUrl
const splitManifest = {
  skill: 'harness-split',
  sourceIssue: issueKey || 'unknown',
  sourceTitle,
  size,
  ticketType,
  migrationPattern,  // top-level only — all subtasks share the same pattern
  execution: mergeResult.execution,
  groups,
}

const parallelCount   = mergeResult.subtasks.filter(s => s.canRunInParallel).length
const sequentialCount = mergeResult.subtasks.filter(s => !s.canRunInParallel).length
const planStatus      = qualityIssues.length === 0 ? 'PROPOSED' : 'PROPOSED_WITH_ISSUES'

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
  qualityIssues,
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

const statusIcon = qualityIssues.length === 0 ? '✅' : '⚠️'

const cliSummary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${planStatus}  ${statusIcon}

  ticket:  ${issueKey || 'unknown'}
  size:    ${size}        cost:  ~$${estimatedCostUsd}

  subtasks: ${mergeResult.subtasks.length} proposed    execution: ${mergeResult.execution}
${groupLines}

  quality: ${qualityLine}
  next:    confirm → create Jira subtasks → /harness-plan each G1 subtask
  audit:   ~/.claude/harness-split-runs.jsonl
  tokens:  ${outputTokensTotal.toLocaleString()}  (~$${estimatedCostUsd} estimated)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

log(cliSummary)

return {
  splitRequired: true,
  size,
  ticketType,
  migrationPattern,
  splitPlan: mergeResult,
  splitManifest,
  totalFilesFound,
  qualityIssues,
  status: planStatus,
  cliSummary,
}
