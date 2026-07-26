export const meta = {
  name: 'harness-plan',
  description: 'Research and plan a ticket into a committed plan file ready for harness-implement',
  phases: [
    { title: 'Intake',     detail: 'Sonnet — size the ticket (XS/S/M/L) from input before anything runs', model: 'sonnet' },
    { title: 'Decompose',  detail: 'Opus (L) / Sonnet (M) — break into S/XS concerns; XS/S skip entirely', model: 'opus' },
    { title: 'Research',   detail: 'Sonnet — per-concern researcher + security in parallel', model: 'sonnet' },
    { title: 'Architect',  detail: 'Sonnet — per-concern DAG task list with revision loop', model: 'sonnet' },
    { title: 'Synthesize', detail: 'Sonnet — per-concern plan doc formatting', model: 'sonnet' },
    { title: 'Coverage',   detail: 'Sonnet — per-concern gate: written plan vs original ask', model: 'sonnet' },
    { title: 'Return',     detail: 'Haiku — write N plan files + manifest, commit', model: 'haiku' },
    { title: 'Debrief',   detail: 'Haiku — audit log, quality check, CLI summary box', model: 'haiku' },
  ],
}

// args: { input, repoPath, qaAnswers?, today?, manifestEntry?, forceplan? }
// input: raw text — Jira ticket, freeform description, rough notes
// manifestEntry: one subtask from split-manifest.json groups[*].subtasks[*]
//   When present: skip Intake + Decompose entirely — size/files/scopePath already known
//   Required fields: { title, description, scopePath?, files?, migrationPattern?, size?, jiraKey? }
// forceplan: when true, skip XS fast path and run full pipeline even for XS
// qaAnswers: string — collected Q&A answers from grill-me session (L-size or flag)

const input = args.input || (args.manifestEntry?.description ? args.manifestEntry.description : '')
const qaAnswers = args.qaAnswers || ''
const repoPath = args.repoPath
const manifestEntry = args.manifestEntry || null

if (!input) throw new Error('harness-plan requires input or manifestEntry')

// ─── Token tracking ───────────────────────────────────────────────────────────
// durationMs is passed in from args.durationMs (computed by SKILL.md wrapper after Workflow() returns).
const workflowStartTokens = budget.spent()
const agentCountByModel = {}
const agentCountByPhase = {}

async function trackedAgent(prompt, opts) {
  const result = await agent(prompt, opts)
  const m = opts.model || researcherModel
  agentCountByModel[m] = (agentCountByModel[m] || 0) + 1
  const p = opts.phase || 'unknown'
  agentCountByPhase[p] = (agentCountByPhase[p] || 0) + 1
  return result
}

// Era marker — bump when the skill paradigm changes significantly.
// Lets future analysis slice runs by era (pre/post spec-v8, etc).
const SKILLS_SCHEMA_VERSION = 'spec-v8'

// telemetryPath: built from args.runId + args.runTs passed by SKILL.md wrapper.
let _telemetryPath = null

function _buildV2Record(status, extra = {}) {
  const outputTokensTotal = budget.spent() - workflowStartTokens
  const inputTokens = args.inputTokens != null ? args.inputTokens : null
  const costResult  = _computeCostV2({ agentCountByModel, inputTokens, outputTokensTotal })
  const repo = (repoPath || '').replace(/\/$/, '').split('/').pop() || null
  const issueKey = (input || '').match(/\b([A-Z]+-\d+)\b/)?.[1] || manifestEntry?.jiraKey || _slugFromInput(input)
  return {
    schemaVersion: '2.0',
    runId:         args.runId || null,
    skill:         'harness-plan',
    skillsSchemaVersion: SKILLS_SCHEMA_VERSION,
    skillsCommit:  args.skillsCommit || null,
    emitTrigger:   'workflow',
    billingMode:   'api',
    ts:            args.today || 'unknown',
    status,
    outcome:       toOutcome(status),
    sourceIssue:   issueKey || 'unknown',
    repo,
    repoPath:      repoPath || null,
    branch:        null,
    durationMs:    args.durationMs != null ? args.durationMs : null,
    size:          null,
    tokens: {
      byModel:     Object.fromEntries(Object.entries(agentCountByModel).map(([m, _]) => [m, { output: null }])),
      total: {
        input:          inputTokens,
        output:         outputTokensTotal,
        subagentTokens: null,
        cacheRead:      null,
        cacheCreation:  null,
      },
    },
    agentCount: {
      byModel: agentCountByModel,
      byPhase: agentCountByPhase,
    },
    cost: costResult,
    ...extra,
  }
}

const _COST_RATES_V2 = { haiku: { in: 1.00, out: 5.00 }, sonnet: { in: 3.00, out: 15.00 }, opus: { in: 5.00, out: 25.00 } }
const _PRICE_TABLE_VERSION = '2026-07-25'
function _rateForV2(model) {
  const m = String(model)
  if (m.includes('opus'))  return _COST_RATES_V2.opus
  if (m.includes('haiku')) return _COST_RATES_V2.haiku
  return _COST_RATES_V2.sonnet
}
function _computeCostV2({ agentCountByModel, inputTokens, outputTokensTotal }) {
  const nullReasons = {}
  const entries = Object.entries(agentCountByModel || {})
  const totalAgents = entries.reduce((s, [, c]) => s + c, 0)
  if (!entries.length || !totalAgents) {
    nullReasons['cost.rateLockedUsd'] = 'no agentCountByModel'
    return { rateLockedUsd: null, priceTableVersion: _PRICE_TABLE_VERSION, nullReasons }
  }
  const blendedIn  = entries.reduce((s, [m, c]) => s + _rateForV2(m).in  * (c / totalAgents), 0)
  const blendedOut = entries.reduce((s, [m, c]) => s + _rateForV2(m).out * (c / totalAgents), 0)
  const inCost  = inputTokens       != null ? (inputTokens       / 1_000_000) * blendedIn  : 0
  const outCost = outputTokensTotal != null ? (outputTokensTotal / 1_000_000) * blendedOut : 0
  if (inputTokens == null) nullReasons['tokens.total.input'] = 'subagentTokens not yet patched'
  return { rateLockedUsd: parseFloat((inCost + outCost).toFixed(4)), priceTableVersion: _PRICE_TABLE_VERSION, nullReasons }
}

// Record schema: skills/harness-telemetry-schema/telemetry-v2.jsonc
const _pendingAuditRecords = []
function _buildAuditRecord(status, extra = {}) {
  if (!_telemetryPath) {
    const repo = (repoPath || '').replace(/\/$/, '').split('/').pop() || 'unknown-repo'
    const issueKey = (input || '').match(/\b([A-Z]+-\d+)\b/)?.[1] || manifestEntry?.jiraKey || _slugFromInput(input)
    const homeDir = (repoPath || '').replace(/\/Desktop\/Repos\/[^/]+\/?$/, '') || '/tmp'
    const runTs = args.runTs || 'unknown-ts'
    _telemetryPath = `${homeDir}/Desktop/Repos/harness-telemetry/v2/${repo}__harness-plan__${issueKey}__${runTs}.jsonl`
  }
  const record = _buildV2Record(status, extra)
  _pendingAuditRecords.push(record)
  return record
}
// kept for barrier call-sites that use await syntax — now synchronous
function writeAuditRecord(status, extra = {}) { return Promise.resolve(_buildAuditRecord(status, extra)) }

// ─── Model tier allocation ────────────────────────────────────────────────────
//
//  Front-load heavy reasoning — front of chain, irreversible decisions:
//    Opus    → Decompose for L only — highest-stakes call; a wrong split
//              cascades through every downstream phase
//
//  Worker bees — bounded, well-defined tasks downstream of decompose:
//    Sonnet  → Intake, Decompose (M), Research, Architect (all sizes),
//              architect revisions, Synthesize, Coverage check + patches
//    Haiku   → file writes, git commits, audit log
//
//  Why Architect is Sonnet for all sizes:
//    After decompose, even L inputs arrive as bounded S/XS research bundles.
//    The hard reasoning is already done — Architect is structured formatting.

const researcherModel = 'anthropic.claude-sonnet-4-6'
const synthModel      = 'anthropic.claude-sonnet-4-6'
const haikuModel      = 'anthropic.claude-haiku-4-5-20251001'
const opusModel       = 'claude-opus-4-8'
// architectModel and decomposeModel hoisted — set from either manifestEntry or Intake path

// ===== PURE (mirrors lib/) =====
// lib/telemetry.js — keep identical. import() unavailable in workflow scripts (probe-confirmed).
function _slugFromInput(text) {
  if (!text) return 'greenfield'
  const first = String(text).split('\n').map(l => l.trim()).find(l => l.length > 0) || ''
  const slug = first.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim()
    .replace(/\s+/g, '-').replace(/-{2,}/g, '-').slice(0, 40).replace(/-+$/, '')
  return slug || 'greenfield'
}
// Format: {telemetryDir}/v2/{repo}__{skill}__{ticket}__{timestamp}.jsonl
// (path is assembled inline in writeAuditRecord above)

// lib/barrier.js — keep identical. import() unavailable in workflow scripts (probe-confirmed).
const MAX_PROBE_LOOPS = 2
const NEVER_LIST = {
  'irreversible-destructive': ['delete', 'drop table', 'force-push', 'force push', 'prod deploy', 'rm -rf', 'truncate'],
  'security-auth-permission': ['auth', 'permission', 'credential', 'secret', 'token', 'iam', 'acl', 'rbac'],
  'cost-over-threshold':      ['budget exceed', 'over budget', 'cost cap'],
  'public-api-contract':      ['public api', 'breaking change', 'contract change', 'schema migration'],
  'out-of-scope':             ['outside scope', 'unplanned file', 'not in plan'],
  'legal-compliance':         ['license', 'gdpr', 'compliance', 'pii'],
}
function matchesNeverList(action) {
  const a = String(action).toLowerCase()
  for (const [cat, kws] of Object.entries(NEVER_LIST))
    if (kws.some(k => a.includes(k))) return cat
  return null
}
function makeBarrierRecord({ decision, hinge, options, probes, confidence, blocking }) {
  return { decision, hinge, options: options ?? [], probes: probes ?? [], confidence: confidence ?? null, blocking: !!blocking }
}
function validateBarrierRecord(r) {
  const errors = []
  for (const k of ['decision', 'hinge']) if (!r?.[k]) errors.push(`missing ${k}`)
  if (typeof r?.blocking !== 'boolean') errors.push('blocking must be boolean')
  return { valid: errors.length === 0, errors }
}
// lib/status.js — keep identical.
const _PLAN_OUTCOME_MAP = {
  COMPLETE:           'success',
  PROPOSED_WITH_GAPS: 'partial',
  CRASHED:            'failed',
  FAILED:             'failed',
}
function toOutcome(status) { return _PLAN_OUTCOME_MAP[status] ?? 'failed' }
// lib/cost.js — keep identical. Rates from https://docs.claude.com/en/docs/about-claude/pricing (2026-07-25)
const _COST_RATES_V2 = { haiku: { in: 1.00, out: 5.00 }, sonnet: { in: 3.00, out: 15.00 }, opus: { in: 5.00, out: 25.00 } }
function _rateForV2(model) {
  const m = String(model)
  if (m.includes('opus'))  return _COST_RATES_V2.opus
  if (m.includes('haiku')) return _COST_RATES_V2.haiku
  return _COST_RATES_V2.sonnet
}
// ===== END PURE =====

// ─── Manifest contract ────────────────────────────────────────────────────────
// Every harness-plan run produces a manifest alongside plan files.
// XS/S/M → manifest with plans array length 1.
// L (independent concerns) → manifest with N parallel-safe entries.
// L (interdependent) → manifest with N sequentially ordered entries.
//
// Manifest schema (docs/manifests/YYYY-MM-DD-<slug>-manifest.json):
// {
//   "title": string,
//   "size": "XS"|"S"|"M"|"L",
//   "execution": "sequential"|"parallel"|"mixed",
//   "plans": [
//     { "id": "p1", "path": "docs/manifests/YYYY-MM-DD-<slug>-p1.md",
//       "jsonPath": "docs/manifests/YYYY-MM-DD-<slug>-p1.json",
//       "dependsOn": [] }
//   ]
// }
//
// harness-implement reads ONE plan file (the .json companion).
// The manifest is consumed by the human (or future loop:run) to sequence invocations.

// ─── Schemas ──────────────────────────────────────────────────────────────────

const RESEARCHER_SCHEMA = {
  type: 'object',
  required: ['filesInScope', 'patterns', 'constraints', 'testFramework', 'mockPolicy', 'codegenTools'],
  properties: {
    filesInScope: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'changeType'],
        properties: {
          path: { type: 'string' },
          changeType: { type: 'string', enum: ['modify', 'create', 'delete'] },
          patternAnchor: { type: 'string' },
        },
      },
    },
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'anchor', 'snippet'],
        properties: {
          name: { type: 'string' },
          anchor: { type: 'string' },
          snippet: { type: 'string', description: '3-5 lines of actual code — embedded inline so developer never reads the file' },
          before: { type: 'string' },
          after: { type: 'string' },
        },
      },
    },
    constraints: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rule', 'source', 'howToApply', 'patternAnchor'],
        properties: {
          rule: { type: 'string' },
          source: { type: 'string' },
          howToApply: { type: 'string' },
          patternAnchor: { type: 'string' },
        },
      },
    },
    testFramework: { type: 'string' },
    mockPolicy: { type: 'string' },
    codegenTools: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'trigger', 'command'],
        properties: { name: { type: 'string' }, trigger: { type: 'string' }, command: { type: 'string' } },
      },
    },
    answeredQuestions: {
      type: 'array',
      description: 'One entry per question from the concern — must cover every question asked, even if the answer is "unknown".',
      items: {
        type: 'object',
        required: ['question', 'answer'],
        properties: {
          question: { type: 'string' },
          answer: { type: 'string', description: 'concrete answer, or "could not determine: <reason>" if unknown' },
        },
      },
    },
    keyFindings: {
      type: 'array',
      description: '3-7 bullet points summarising the most important things the architect must know: exact file paths, pattern names, critical constraints, "could not determine" blockers. No prose — one line per finding.',
      items: { type: 'string' },
    },
    couldNotDetermine: { type: 'array', items: { type: 'string' } },
  },
}

const SECURITY_SCHEMA = {
  type: 'object',
  required: ['alreadyHandled', 'newSurface', 'noNewSurface'],
  properties: {
    alreadyHandled: { type: 'array', items: { type: 'string' } },
    newSurface: { type: 'array', items: { type: 'string' } },
    noNewSurface: { type: 'boolean' },
  },
}

const ARCHITECT_SCHEMA = {
  type: 'object',
  required: ['scopeIn', 'scopeOut', 'dependencies', 'openQuestions', 'tasks'],
  properties: {
    scopeIn: { type: 'string' },
    scopeOut: { type: 'array', items: { type: 'string' } },
    dependencies: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'description', 'block', 'groupId', 'files', 'tddRequired', 'acceptanceCriteria'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          block: { type: 'string', enum: ['sequential', 'parallel'] },
          groupId: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          tddRequired: { type: 'boolean' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const INTAKE_SCHEMA = {
  type: 'object',
  required: ['size', 'reasoning', 'fileCountEstimate', 'concernCount', 'repoLayers'],
  properties: {
    size: { type: 'string', enum: ['XS', 'S', 'M', 'L'] },
    reasoning: { type: 'string', description: 'one sentence explaining why this size was chosen' },
    fileCountEstimate: { type: 'number', description: 'estimated number of files touched — 0 if unknown' },
    concernCount: { type: 'number', description: 'estimated number of distinct concerns — 1 for XS/S, 2-4 for M, 5+ for L' },
    repoLayers: {
      type: 'array',
      description: 'top-level architectural layers found in the repo src/ directory — used by decompose to slice concerns correctly. Run `ls` on src/ or the main source dir to derive this.',
      items: { type: 'string' },
    },
  },
}

const DECOMPOSE_SCHEMA = {
  type: 'object',
  required: ['concerns'],
  properties: {
    concerns: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'filesToRead', 'questions'],
        properties: {
          label: { type: 'string' },
          filesToRead: {
            type: 'array',
            description: 'Files the researcher should read. Hard cap: 8. For validation concerns this must be empty — grep/node commands only.',
            items: { type: 'string' },
          },
          fileBudget: {
            type: 'number',
            description: 'Max files the researcher may read. 0 for shell-command-only concerns (validation/cleanup). Default 8.',
          },
          questions: {
            type: 'array',
            description: 'All questions this concern must answer. For validation concerns: max 5, all answerable by shell commands. For pattern/file concerns: no hard limit, but if > 10 the concern is probably over-bundled.',
            items: { type: 'string' },
          },
        },
      },
    },
  },
}

const COVERAGE_SCHEMA = {
  type: 'object',
  required: ['covered', 'gaps'],
  properties: {
    covered: { type: 'boolean' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['section', 'missingRequirement', 'filesToRead', 'question'],
        properties: {
          section: { type: 'string', description: 'which plan section needs patching, e.g. "Approach", "Tasks", "Acceptance Criteria"' },
          missingRequirement: { type: 'string', description: 'what from the original ask is not covered' },
          filesToRead: { type: 'array', items: { type: 'string' }, description: 'files a gap-fill researcher needs to read — empty if already in mergedResearch' },
          question: { type: 'string', description: 'focused question the gap-fill researcher must answer' },
        },
      },
    },
  },
}

// ─── Phase 0: Intake ─────────────────────────────────────────────────────────
// Sonnet reasons about ticket size from the input text before anything else runs.
// No file reading — input text + file counts mentioned in the ticket only.
// Output drives: architectModel selection, decompose routing, grill-me gate.

let currentPhase = 'init'
let auditWritten = false
const partialState = {}
function trackPhase(name) { currentPhase = name; phase(name) }

try {

// ─── Hoisted model vars + fast path branching ─────────────────────────────────
// architectModel and decomposeModel must be set before Research regardless of path taken.

let size, architectModel, decomposeModel
let intakeResult = null

if (manifestEntry) {
  // ── manifestEntry fast path: skip Intake + Decompose entirely ──────────────
  // harness-split already sized this subtask — trust it
  size = manifestEntry.size || 'S'
  architectModel = researcherModel
  decomposeModel = researcherModel
  log(`Fast path: manifest entry — skipping Intake + Decompose. size=${size} files=${(manifestEntry.files || []).length}`)
  partialState.size = size
} else {
  // ── Normal path: Intake ────────────────────────────────────────────────────
  trackPhase('Intake')

  intakeResult = await trackedAgent(
    `You are a sizing agent. Read the input, size the ticket, and discover the repo's layer taxonomy.

SIZE RULES:
- XS: single function or config change, 1-3 files
- S: single concern, under 10 files
- M: multiple concerns, 10-30 files, no cross-cutting migration
- L: cross-cutting change OR any of: 30+ files mentioned, "migrate N files", multiple distinct subsystems touched

HARD RULES:
- If the input explicitly mentions a file count ≥ 30 (e.g. "118 files", "26 files"), size is L. Do not downgrade.
- When in doubt between two sizes, always choose the LARGER. A ticket sized too large decomposes into more concerns and produces more focused plans. A ticket sized too small skips decompose and produces one oversized plan that stalls implement.
- Prefer over-sizing. The cost of extra concerns is low. The cost of a stalled implement run is high.

REPO LAYER DISCOVERY:
Run: ls ${repoPath}/src 2>/dev/null || ls ${repoPath}/app 2>/dev/null || ls ${repoPath}/lib 2>/dev/null
Use the output to populate repoLayers — the actual top-level directories in the source tree.
These layers are used by decompose to slice concerns correctly (e.g. "hooks layer" vs "pages layer").
If ls returns nothing, use an empty array.

INPUT:
${input}

Return your sizing decision with a one-sentence reasoning and the repo layer list.`,
    { label: 'intake', phase: 'Intake', model: researcherModel, effort: 'medium', schema: INTAKE_SCHEMA }
  )

  if (!intakeResult) throw new Error('Intake sizing failed — cannot proceed')

  size = intakeResult.size
  decomposeModel = size === 'L' ? opusModel : researcherModel  // Opus for L, Sonnet for M
  architectModel = researcherModel  // always Sonnet — receives bounded M/S chunks post-decompose

  log(`Intake: size=${size} — ${intakeResult.reasoning} (est. ${intakeResult.fileCountEstimate} files, ${intakeResult.concernCount} concern(s), layers: ${(intakeResult.repoLayers || []).join(', ') || 'none found'})`)
  partialState.size = size
  partialState.fileCountEstimate = intakeResult.fileCountEstimate
  partialState.concernCount = intakeResult.concernCount
}

// ─── XS fast path: write minimal plan, skip Research through Coverage ─────────
// Only applies when NOT in manifestEntry mode and NOT --forceplan

if (size === 'XS' && !manifestEntry && !args.forceplan) {
  trackPhase('Return')
  const today = args.today || 'unknown'
  const planSlug = (() => {
    const jiraMatch = (input || '').match(/\b([A-Z]+-\d+)\b/)
    if (jiraMatch) return jiraMatch[1].toLowerCase()
    return (input || '').split('\n')[0].slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  })()
  const microTask = {
    id: 'T1',
    title: (input || '').split('\n')[0].slice(0, 80),
    description: input,
    block: 'sequential',
    groupId: 'G1',
    files: [],
    tddRequired: true,
    acceptanceCriteria: [],
  }
  const planFileName = `${today}-${planSlug}-p1.md`
  const planJsonName = `${today}-${planSlug}-p1.json`
  const manifestName = `${today}-${planSlug}-manifest.json`
  const planJson = JSON.stringify({
    planKey: `${planSlug}-p1`,
    planPath: `docs/manifests/${planFileName}`,
    prTitle: microTask.title,
    mockPolicy: '',
    constraints: [],
    tasks: [microTask],
  }, null, 2)
  const manifestObj = {
    title: microTask.title,
    size: 'XS',
    execution: 'sequential',
    sourceSubtask: null,
    plans: [{ id: 'p1', path: `docs/manifests/${planFileName}`, jsonPath: `docs/manifests/${planJsonName}`, dependsOn: [] }],
  }
  const xsWriteResult = await trackedAgent(
    `Write THREE files using the Write tool. Do NOT truncate.

FILE 1 — plan markdown:
PATH: ${repoPath}/docs/manifests/${planFileName}
CONTENT:
# ${microTask.title}

## Task
${microTask.description}

## Tasks JSON
\`\`\`json
${JSON.stringify({ tasks: [microTask] }, null, 2)}
\`\`\`

FILE 2 — plan JSON:
PATH: ${repoPath}/docs/manifests/${planJsonName}
CONTENT:
${planJson}

FILE 3 — manifest:
PATH: ${repoPath}/docs/manifests/${manifestName}
CONTENT:
${JSON.stringify(manifestObj, null, 2)}

Return { written: true }`,
    { label: 'write-xs-plan', phase: 'Return', model: haikuModel, effort: 'low',
      schema: { type: 'object', required: ['written'], properties: { written: { type: 'boolean' } } } }
  )

  trackPhase('Debrief')
  const xsTokensTotal = budget.spent() - workflowStartTokens
  const xsCostUsd = _computeCostV2({ agentCountByModel, inputTokens: null, outputTokensTotal: xsTokensTotal }).rateLockedUsd  // display only — not written to audit log
  _buildAuditRecord('COMPLETE', {
    planSlug,
    manifestPath: `docs/manifests/${manifestName}`,
    planCount: 1,
    taskCount: 1,
    filesInScope: 0,
    qualityIssues: [],
    architectRevisions: 0,
    coverageRounds: 0,
    size: 'XS',
    xsFastPath: true,
  })
  auditWritten = true
  const xsCliSummary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
harness-plan
  status:  COMPLETE  ✅
  ticket:  ${planSlug}
  size:    XS
  tasks:   1
  quality: ✓ clean

  next:    /harness-implement docs/manifests/${planJsonName}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  log(xsCliSummary)
  return {
    manifestPath: `docs/manifests/${manifestName}`,
    planCount: 1,
    taskCount: 1,
    qualityIssues: [],
    status: 'COMPLETE',
    cliSummary: xsCliSummary,
    telemetryPath: _telemetryPath,
    auditRecords: [..._pendingAuditRecords],
    outputTokensTotal: budget.spent() - workflowStartTokens,
    agentCountByModel,
  }
}

// ─── Phase 1 (L + M): Decompose ──────────────────────────────────────────────
// Sprint-planning style: L/M input split into S/XS concerns before research.
// Each concern is one focused researcher agent — bounded files, one question.
// XS/S: single concern wrapping the raw input, decompose is a no-op.
//
// Model: Opus for L (high-stakes cross-cutting split), Sonnet for M (bounded split)
//
// CONSTRAINT: No file reading in decompose — that is Research's job.
//   Allowed: reasoning from input text only, at most one `ls` to confirm a directory exists.
//   Forbidden: grep, find, cat, head, any file content reads.

trackPhase('Decompose')

let decomposeConcerns

if (size === 'L' || size === 'M') {
  const decomposeResult = await trackedAgent(
    `You are a decomposer. Break this task into focused concerns for parallel research.
Each concern maps to a small focused file set with a list of questions a single researcher can answer.

REPO: ${repoPath}
INPUT:
${input}

INTAKE SIZING: ${intakeResult.reasoning} (estimated ${intakeResult.fileCountEstimate} files, ${intakeResult.concernCount} concerns)

── DECOMPOSE TOOLKIT ────────────────────────────────────────────────────────────
Choose the right technique(s) for this work. Combine as needed.

MIGRATION (use when: "migrate X to Y across N files"):
  □ source-pattern   — what does the OLD thing look like? Read EXACTLY 2-3 representative files — not all N files. filesToRead max 3.
                       REQUIRED questions (add these to every source-pattern concern):
                         1. "Run grep to count call sites per file in this layer — which files have more than 1 call site?"
                         2. "For each file read, list every call site by line number — not just the first one."
                         3. "Are there any files with unusual call shapes (extra args, different error handling, wrapped calls)?"
                       [FILE concern, one per architectural layer — hooks layer, pages layer, utils layer are separate concerns]
  □ target-pattern   — what does the NEW thing look like? Read the canonical new implementation only. filesToRead max 2. [FILE concern]
  □ delta            — mechanical diff: what is the exact substitution old→new? [FILE concern]
  □ exceptions       — files that don't fit the mechanical pattern (unique call shapes, extra args, multiple call sites with different shapes)
                       Each exception file gets its own task in the architect output — do not group exceptions together.
                       [FILE concern]
  □ cleanup          — what gets deleted after migration (dead imports, removed packages, middleware) [FILE concern]
  □ test-migration   — old mock pattern → new mock pattern [FILE concern]
  □ validation       — grep + package.json checks to verify migration is complete [VALIDATION concern — filesToRead: [], fileBudget: 0, shell commands only]

VALIDATION concerns are ALWAYS separate from FILE concerns. Mixed validation-with-pattern = over-bundled.
  ✓ validation concern: questions answered by grep/find/node/cat on package.json — filesToRead must be []
  ✗ never bundle: "which files use X" (grep) + "what does X look like in file A" (file read) = two concerns

PATTERN-EXTRACT (use when: same change applied across many files):
  → one concern reads 2-3 representative files to extract the pattern
  → do NOT create one concern per file — file count is irrelevant to concern count
  → if files span multiple layers (hooks + pages + utils), use SUBSYSTEM-SLICE instead

SUBSYSTEM-SLICE (use when: distinct layers with no shared files):
  → one concern per subsystem — use the actual repo layers discovered by Intake
  → HARD RULE: a single concern must not span more than one architectural layer
  → "axios usage across all client files" = wrong. "axios in hooks layer" + "axios in pages layer" = correct
  → repo layers for this codebase: ${(intakeResult.repoLayers || []).join(', ') || 'run ls src/ to discover'}

DEPENDENCY-ORDER (use when: work must sequence — A before B):
  → flag these in questions: "does X need to exist before Y can be modified?"

EDGE-CASE-ISOLATE (use when: one file/area has unique behavior):
  → one concern per unique outlier, explain why it doesn't fit the main pattern

TEST-SCAFFOLD (always its own concern when test patterns differ from prod):
  → what does the mock look like post-change?

SECURITY (always its own concern, label: "security"):
  → what new attack surface does this work open?

── DECISION CHECKLIST ───────────────────────────────────────────────────────────
Run through this before finalizing concerns:
  □ Is this a migration? → use MIGRATION technique first
  □ Are there files that must change before others? → DEPENDENCY-ORDER those
  □ Are N files doing the same thing? → one PATTERN-EXTRACT, not N file concerns
  □ Do those N files span multiple layers (hooks + pages + utils)? → SUBSYSTEM-SLICE, one per layer
  □ Are there distinct subsystems with no shared files? → SUBSYSTEM-SLICE
  □ Are there outlier files with unique behavior? → EDGE-CASE-ISOLATE each
  □ Does the test mock pattern differ from prod? → TEST-SCAFFOLD concern
  □ Security concern added? → always yes
  □ Any concern still M/L-sized? → split further

── RULES ────────────────────────────────────────────────────────────────────────
- Each concern has questions[] — every unknown, no matter how small. No question is wasteful.
- "could not determine" is a valid answer and surfaces gaps early — better now than at implement.
- File paths must be absolute (prefix with ${repoPath}/)
- When in doubt, split further. More concerns = smaller prompts = faster, more reliable runs.
- Prefer more concerns over fewer. A concern too small costs one extra agent. A concern too large stalls.
- FILE concerns: filesToRead max 8, questions answered by reading those specific files
- VALIDATION concerns: filesToRead must be [], fileBudget must be 0, questions answered by grep/node/bash only
- NEVER mix file-read questions and shell-command questions into the same concern
- DO NOT read files or run grep/find/cat — derive concerns from the input text only
- A single directory listing (ls) is the maximum file system access allowed

── ATOMIC TASK PHILOSOPHY ───────────────────────────────────────────────────────
The architect produces one task per file being modified. This is non-negotiable for migrations.
- "migrate useMovieDetails.ts" = one task. "migrate all hooks that use axios" = wrong.
- A task that requires the developer to discover files or call sites will stall with NEEDS_CONTEXT.
- More tasks is always better. A task too small = one extra developer dispatch. A task too large = stall.
- Concerns exist to gather information, not to group tasks. One concern can produce many tasks.`,
    { label: 'decompose', phase: 'Decompose', model: decomposeModel, effort: 'high', schema: DECOMPOSE_SCHEMA }
  )
  decomposeConcerns = decomposeResult?.concerns || [{ label: 'researcher', filesToRead: [], questions: [input] }]

  // Post-decompose validation: warn on obvious over-bundling before research runs
  for (const c of decomposeConcerns) {
    const budget = c.fileBudget !== undefined ? c.fileBudget : 8
    const hasShellQuestions = (c.questions || []).some(q =>
      /grep|find|package\.json|import count|how many|exists?|installed/i.test(q)
    )
    const hasFileQuestions = (c.questions || []).some(q =>
      /what does|what pattern|how is|what is the shape|show me|example of/i.test(q)
    )
    if (hasShellQuestions && hasFileQuestions && budget > 0) {
      log(`⚠ Decompose[${c.label}]: mixed shell + file questions — consider splitting into FILE + VALIDATION concerns`)
    }
    if (budget === 0 && c.filesToRead?.length > 0) {
      log(`⚠ Decompose[${c.label}]: validation concern has filesToRead=${c.filesToRead.length} — should be empty`)
      c.filesToRead = []
    }
    if (c.filesToRead?.length > 8) {
      log(`⚠ Decompose[${c.label}]: ${c.filesToRead.length} filesToRead exceeds budget 8 — researcher will sample 2-3`)
    }
  }

  log(`Decompose: ${decomposeConcerns.length} focused sub-problems (model: ${size === 'L' ? 'opus' : 'sonnet'})`)
} else if (manifestEntry) {
  // manifestEntry fast path: synthesize a single concern from the manifest subtask
  decomposeConcerns = [{
    label: manifestEntry.title || 'main',
    filesToRead: (manifestEntry.files || []).slice(0, 8),
    fileBudget: Math.min((manifestEntry.files || []).length, 8),
    questions: [
      `What is the exact before/after pattern for "${manifestEntry.migrationPattern || 'this change'}"?`,
      `For each file in the list, what are the exact call sites by line number?`,
      `Are there any files with unusual call shapes that don't fit the main pattern?`,
    ],
    scopePath: manifestEntry.scopePath,
    migrationPattern: manifestEntry.migrationPattern,
  }]
  log(`Decompose: skipped — manifest entry, ${decomposeConcerns[0].filesToRead.length} file(s) pre-scoped`)
} else {
  decomposeConcerns = [{ label: 'main', filesToRead: [], questions: [input] }]
  log(`Decompose: skipped — size is ${size}`)
}

// ─── Phases 2–5: per-concern pipeline ────────────────────────────────────────
// Each concern runs its own Research → Architect → Synthesize → Coverage chain.
// Security runs in parallel alongside all concerns — results injected into each
// concern's architect prompt via closure.
// No global merge — concerns never reassemble into one blob.
// XS/S: decomposeConcerns has exactly one entry → same pipeline, one plan file.
// M/L: N entries → N plan files, all in parallel.

trackPhase('Research')

const securityConcern = decomposeConcerns.find(c => c.label === 'security')
const researchConcerns = decomposeConcerns.filter(c => c.label !== 'security')

// Security runs in parallel with the first researcher batch so it doesn't block architects.
// Researcher concerns are batched at 5 to avoid rate-limit stalls on large L tickets.
// securityResult is resolved before the pipeline starts — safe to reference in closures.

const makeResearcherThunk = (concern) => () => {
  const fileBudget = concern.fileBudget !== undefined ? concern.fileBudget : 8
  const isValidationConcern = fileBudget === 0
  const groundedReality = manifestEntry?.groundedReality || null
  return trackedAgent(
    `REPO: ${repoPath}
${groundedReality ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GROUNDED REALITY (from harness-intake research — trust this over the ticket text below)
  Summary:     ${groundedReality.summary}
  Actual files: ${groundedReality.actualFileCount} (ticket may claim a different number — ignore that claim)
  Actual scope: ${groundedReality.actualScope}
  Key files confirmed present: ${(groundedReality.keyFiles || []).join(', ')}
  Migration notes: ${groundedReality.migrationNotes || 'none'}
  Ticket claims to ignore: ${(groundedReality.ticketClaimsToIgnore || []).join('; ') || 'none'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : ''}
${isValidationConcern
  ? `FILE BUDGET: 0 — this is a VALIDATION concern. Answer ALL questions using only grep/find/node/bash commands. Do NOT read any file contents.`
  : `FILE BUDGET: ${fileBudget} — read AT MOST ${fileBudget} files total. If the concern lists more, read the 2-3 most representative ones only. Do NOT enumerate all N files.`}
FILES TO READ: ${concern.filesToRead.join(', ') || (isValidationConcern ? 'none — shell commands only' : 'enumerate from repo')}
${concern.scopePath ? `\nSCOPE CONSTRAINT: only grep and read files under ${repoPath}/${concern.scopePath} — do not touch files outside this path` : ''}
${concern.migrationPattern ? `\nMIGRATION PATTERN: ${concern.migrationPattern}` : ''}

CONCERN: ${concern.label}

GREP-FIRST RULE: Before reading any file, run grep to confirm the pattern exists at those locations.
Use: grep -n "PATTERN" FILE to get exact line numbers. Only read a file if grep confirms hits in it.
This saves 2-3 file reads per concern and surfaces line numbers the architect needs directly.

QUESTIONS TO ANSWER (answer ALL of these — no question is too small, "could not determine" is a valid answer):
${(concern.questions || []).map((q, i) => `${i + 1}. ${q}`).join('\n') || '1. What files need to change and how?'}

Full input for context (ticket text — defer to GROUNDED REALITY above where it contradicts this):
${input}

SCOPE NOTE: Focus on task-specific patterns, file locations, and constraints relevant to THIS concern only.
Do NOT enumerate general repo conventions — focus on: which files change, what patterns exist at those
specific locations, what constraints apply, inline code snippets the developer will need.

MOCK CONSTRAINT: If you see vi.mock or jest.mock in test files for the files in scope, add this as a constraint:
"In tests that vi.mock a module, assert on the MOCKED module (e.g. expect(clientFetch).toHaveBeenCalledWith(...)). NEVER assert on globals like global.fetch — those are never reached when the module is mocked."

You MUST populate:
- answeredQuestions: one entry per question above (every question, every answer)
- keyFindings: 3-7 single-line bullets — the most important facts for the architect: exact paths, pattern names, critical constraints, any "could not determine" blockers. This is all the architect will see; make it complete.`,
    isValidationConcern
      ? { label: `hp-researcher:${concern.label}`, phase: 'Research', model: researcherModel, effort: 'medium', schema: RESEARCHER_SCHEMA }
      : { label: `hp-researcher:${concern.label}`, phase: 'Research', model: researcherModel, effort: 'medium', schema: RESEARCHER_SCHEMA, agentType: 'hp-researcher' }
  )
}

// Run security alongside batch 0 of researchers, then remaining batches sequentially
const researchResults = []
let securityResult = { alreadyHandled: [], newSurface: [], noNewSurface: true }

for (let i = 0; i < researchConcerns.length; i += 5) {
  const batch = researchConcerns.slice(i, i + 5)
  const thunks = batch.map(makeResearcherThunk)
  if (i === 0) {
    // First batch: security runs alongside
    const firstBatchResults = await parallel([
      () => trackedAgent(
        `REPO: ${repoPath}
${securityConcern ? `FILES TO READ: ${securityConcern.filesToRead.join(', ')}` : ''}

INPUT:
${input}`,
        { label: 'hp-security', phase: 'Research', model: researcherModel, effort: 'medium', schema: SECURITY_SCHEMA, agentType: 'hp-security' }
      ),
      ...thunks,
    ])
    securityResult = firstBatchResults[0] || securityResult
    researchResults.push(...firstBatchResults.slice(1))
  } else {
    const batchResults = await parallel(thunks)
    researchResults.push(...batchResults)
  }
}
log(`Security: ${securityResult?.newSurface?.length || 0} new surface item(s)`)
log(`Research: ${researchResults.filter(Boolean).length}/${researchConcerns.length} concern(s) completed`)

// Pair each research result back to its concern for the architect pipeline
const researchPairs = researchConcerns.map((concern, i) => {
  const research = researchResults[i]
  if (!research) {
    log(`⚠ Research[${concern.label}]: returned null — skipping concern`)
    return null
  }
  log(`Research[${concern.label}]: ${research.filesInScope?.length || 0} file(s), ${research.patterns?.length || 0} pattern(s), ${research.keyFindings?.length || 0} key finding(s)`)
  return { concern, research }
}).filter(Boolean)

if (researchPairs.length === 0) throw new Error('All researchers returned null — cannot proceed to architect')

// Per-concern pipeline: Architect → Synthesize → Coverage
// securityResult is a plain resolved value — safe to reference in closure, no await needed
const concernResults = await pipeline(
  researchPairs,

  // ── Stage 1: Architect ────────────────────────────────────────────────────
  // Research already completed in the parallel barrier above — prev = { concern, research }
  async (prev, _orig, idx) => {
    if (!prev) return null
    const { concern, research } = prev

    // Guard: architect needs substantive input to reason from.
    // Validation concerns (fileBudget: 0) produce no filesInScope — use answeredQuestions
    // as the content source instead. If both are empty, skip — nothing to architect.
    const hasFindings = (research.keyFindings?.length > 0)
    const hasFiles = (research.filesInScope?.length > 0)
    const hasAnswers = (research.answeredQuestions?.length > 0)
    if (!hasFindings && !hasFiles && !hasAnswers) {
      log(`⚠ Architect[${concern.label}]: researcher returned empty output — skipping concern`)
      return null
    }

    // For validation concerns: synthesize answeredQuestions into keyFindings if missing
    if (!hasFindings && hasAnswers && concern.fileBudget === 0) {
      research.keyFindings = research.answeredQuestions
        .filter(qa => !qa.answer?.toLowerCase().startsWith('could not determine'))
        .slice(0, 7)
        .map(qa => `${qa.question} → ${qa.answer}`)
      log(`Architect[${concern.label}]: validation concern — derived ${research.keyFindings.length} keyFinding(s) from answeredQuestions`)
    }

    // securityResult resolved upfront before pipeline — plain closure value, no await needed

    // Architect receives slim research — all arrays capped to keep prompt bounded
    // No pattern blobs, no full Q&A, no full security object
    const architectResearch = {
      filesInScope: (research.filesInScope || []).slice(0, 20),
      constraints: (research.constraints || []).slice(0, 10),
      testFramework: research.testFramework,
      mockPolicy: research.mockPolicy,
      couldNotDetermine: (research.couldNotDetermine || []).slice(0, 5),
    }

    // Surface any unanswered questions so architect can flag them
    const unansweredQuestions = (research.answeredQuestions || [])
      .filter(qa => qa.answer?.toLowerCase().startsWith('could not determine'))

    // Security: architect only needs new surface, not what's already handled
    const securityNewSurface = (securityResult?.newSurface || [])

    // Input: pass concern questions + first 3 lines of ticket (title/summary only)
    // Full ticket is too large for broad concerns — decompose already distilled it into questions
    const ticketSummary = (input || '').split('\n').slice(0, 3).join('\n').trim()
    // Cap questions at 8 — architect uses keyFindings as primary signal, questions are context only
    const architectQuestions = (concern.questions || []).slice(0, 8)
    const concernContext = [
      `TICKET SUMMARY: ${ticketSummary}`,
      '',
      `CONCERN QUESTIONS (what this concern must answer):`,
      ...architectQuestions.map((q, i) => `${i + 1}. ${q}`),
    ].join('\n')

    const architectResult = await trackedAgent(
      `${concernContext}

CONCERN: ${concern.label}

KEY FINDINGS (from researcher — the most important facts for task design):
${(research.keyFindings || []).map(f => `• ${f}`).join('\n') || '(none provided)'}

${unansweredQuestions.length > 0 ? `UNANSWERED (flag in openQuestions — implementation is blocked without these):
${unansweredQuestions.map(qa => `• ${qa.question}: ${qa.answer}`).join('\n')}` : ''}

RESEARCHER_OUTPUT:
${JSON.stringify(architectResearch, null, 2)}

${securityNewSurface.length > 0 ? `NEW SECURITY SURFACE (address in tasks where relevant):
${securityNewSurface.map(s => `• ${s}`).join('\n')}` : ''}
${qaAnswers ? `\nQA_ANSWERS:\n${qaAnswers}` : ''}`,
      { label: `hp-architect:${concern.label}`, phase: 'Architect', model: architectModel, effort: 'high', schema: ARCHITECT_SCHEMA, agentType: 'hp-architect' }
    )

    if (!architectResult) {
      log(`⚠ Architect[${concern.label}]: stalled/null — concern dropped. Check researcher output for oversized payload.`)
      return null
    }

    // ── Barrier Protocol (architect/decompose fork only) ──────────────────────
    // Check every task title+description for NEVER_LIST keywords.
    // On match: record barrier, write audit entry, return null (PROPOSED_WITH_GAPS via crash handler).
    // On no match: run confidence probe loop (≤ MAX_PROBE_LOOPS) if openQuestions contains blockers.
    {
      // Phase 1: NEVER_LIST scan — hard stop, no probe loop
      let neverHit = null
      for (const task of architectResult.tasks) {
        const combined = `${task.title || ''} ${task.description || ''}`
        const cat = matchesNeverList(combined)
        if (cat) { neverHit = { task, cat }; break }
      }
      if (neverHit) {
        const rec = makeBarrierRecord({
          decision: `task "${neverHit.task.title}" matches NEVER_LIST category "${neverHit.cat}"`,
          hinge: neverHit.cat,
          probes: [],
          confidence: 0,
          blocking: true,
        })
        log(`🛑 Barrier[${concern.label}]: NEVER_LIST hit — "${neverHit.cat}" in task "${neverHit.task.title}". Surfacing for user review.`)
        await writeAuditRecord('PROPOSED_WITH_GAPS', { barrier: rec })
        return null
      }

      // Phase 2: confidence probe loop — only when architect flagged open blockers
      const openBlockers = (architectResult.openQuestions || []).filter(q => q)
      if (openBlockers.length > 0) {
        let probeLog = []
        let probesRun = 0
        let resolved = false
        while (probesRun < MAX_PROBE_LOOPS && !resolved) {
          const hingeResult = await trackedAgent(
            `You are a confidence evaluator. The architect returned ${openBlockers.length} open question(s) for concern "${concern.label}".
Open questions: ${JSON.stringify(openBlockers)}
Name the SINGLE unknown that, if resolved, would most change whether the plan is safe to proceed.
Return { hinge: "<one sentence>", readOnlyLookup: "<exact shell command to resolve it, read-only only>" }`,
            { label: `barrier-hinge:${concern.label}-${probesRun}`, phase: 'Architect', model: haikuModel, effort: 'low',
              schema: { type: 'object', required: ['hinge', 'readOnlyLookup'],
                properties: { hinge: { type: 'string' }, readOnlyLookup: { type: 'string' } } } }
          )
          if (!hingeResult) break
          probeLog.push(hingeResult.hinge)
          const probeResult = await trackedAgent(
            `Run this read-only command and return the output. Do not modify any files.
Command: ${hingeResult.readOnlyLookup}
Return { output: "<stdout>" }`,
            { label: `barrier-probe:${concern.label}-${probesRun}`, phase: 'Architect', model: haikuModel, effort: 'low',
              schema: { type: 'object', required: ['output'], properties: { output: { type: 'string' } } } }
          )
          probesRun++
          // Treat the probe result as resolving if we got non-empty output (heuristic: any answer is better than none)
          if (probeResult?.output?.trim()) { resolved = true; break }
        }
        if (!resolved && probesRun >= MAX_PROBE_LOOPS) {
          const rec = makeBarrierRecord({
            decision: `concern "${concern.label}" has ${openBlockers.length} unresolved blocker(s) after ${probesRun} probe(s)`,
            hinge: probeLog[0] || 'unknown',
            probes: probeLog,
            confidence: 0,
            blocking: false,
          })
          log(`⚠ Barrier[${concern.label}]: ${openBlockers.length} blocker(s) unresolved after ${probesRun} probe(s) — proceeding under labeled default.`)
          await writeAuditRecord('PROPOSED_WITH_GAPS', { barrier: rec })
          // non-blocking: proceed with the plan; caller sees PROPOSED_WITH_GAPS status
        }
      }
    }
    // ── End Barrier Protocol ──────────────────────────────────────────────────

    // DAG file-conflict guard
    const tasksByGroup = {}
    for (const task of architectResult.tasks) {
      if (!tasksByGroup[task.groupId]) tasksByGroup[task.groupId] = []
      tasksByGroup[task.groupId].push(task)
    }
    for (const [groupId, tasks] of Object.entries(tasksByGroup)) {
      if (tasks[0]?.block !== 'parallel' || tasks.length < 2) continue
      const seen = new Set()
      for (const task of tasks) {
        for (const f of task.files) {
          if (seen.has(f)) {
            for (const t of tasks) t.block = 'sequential'
            break
          }
          seen.add(f)
        }
      }
    }

    // Revision loop — inline check, Sonnet fixes, max 2 rounds
    const MAX_REVISIONS = 2
    let revisionRound = 0
    while (revisionRound < MAX_REVISIONS) {
      const failingTasks = architectResult.tasks.filter(t => {
        const d = t.description || ''
        return !/what/i.test(d) || !/where/i.test(d) || !/how/i.test(d) ||
               (t.tddRequired && !/done/i.test(d)) || !/```/.test(d)
      })
      if (failingTasks.length === 0) break
      revisionRound++

      const revisionResult = await trackedAgent(
        `Revise ONLY the tasks listed below. All other tasks are correct — do not touch them.
Each revised description must answer: WHAT, WHERE, HOW (with inline code snippet), DONE (if tddRequired).
Source snippets from KEY FINDINGS — do not read files.

KEY FINDINGS:
${(research.keyFindings || []).map(f => `• ${f}`).join('\n') || 'none'}

TASKS TO FIX:
${JSON.stringify(failingTasks, null, 2)}

Return ONLY the revised tasks array (same schema, same ids).`,
        { label: `architect-revision:${concern.label}-${revisionRound}`, phase: 'Architect', model: researcherModel, effort: 'medium',
          schema: { type: 'object', required: ['tasks'], properties: { tasks: { type: 'array', items: ARCHITECT_SCHEMA.properties.tasks.items } } }
        }
      )
      if (revisionResult?.tasks?.length) {
        for (const revised of revisionResult.tasks) {
          const i = architectResult.tasks.findIndex(t => t.id === revised.id)
          if (i !== -1) architectResult.tasks[i] = revised
        }
      }
    }

    log(`Architect[${concern.label}]: ${architectResult.tasks.length} task(s), ${revisionRound} revision(s)`)
    return { concern, research, architectResult, revisionRound, idx }
  },

  // ── Stage 3: Synthesize ────────────────────────────────────────────────────
  async (prev) => {
    if (!prev) return null
    const { concern, research, architectResult } = prev
    // securityResult resolved upfront before pipeline — plain closure value

    // Synthesize job: format architect decisions into canonical plan doc.
    // Does NOT receive: full ticket, full Q&A, concern questions — architect already used those.
    // Receives only what it needs to format: tasks, scope, files, patterns (capped), security summary.
    const planText = await trackedAgent(
      `Write the complete plan document using the canonical template.

CONCERN: ${concern.label}

ARCHITECT_OUTPUT:
${JSON.stringify(architectResult, null, 2)}

FILES_IN_SCOPE:
${JSON.stringify((research.filesInScope || []).slice(0, 20), null, 2)}

PATTERNS (for inline snippet embedding — top 5 only):
${JSON.stringify((research.patterns || []).slice(0, 5), null, 2)}

MOCK_POLICY: ${research.mockPolicy || 'none'}
TEST_FRAMEWORK: ${research.testFramework || 'unknown'}

SECURITY_ALREADY_HANDLED:
${(securityResult?.alreadyHandled || []).map(s => `• ${s}`).join('\n') || 'none'}

SECURITY_NEW_SURFACE:
${(securityResult?.newSurface || []).map(s => `• ${s}`).join('\n') || 'none'}
${qaAnswers ? `\nQA_ANSWERS:\n${qaAnswers}` : ''}`,
      { label: `hp-synthesizer:${concern.label}`, phase: 'Synthesize', model: synthModel, effort: 'medium', agentType: 'hp-synthesizer' }
    )

    if (!planText) {
      log(`Synthesize[${concern.label}]: returned null — skipping`)
      return null
    }

    const clean = planText.replace(/^```(?:markdown)?\n/, '').replace(/\n```\s*$/, '')
    let planFileContent = clean.trimStart().startsWith('#') ? clean : `# ${concern.label.toUpperCase()}\n\n${clean}`

    return { ...prev, planFileContent }
  },

  // ── Stage 4: Coverage ──────────────────────────────────────────────────────
  async (prev) => {
    if (!prev) return null
    const { concern, research, architectResult } = prev
    let { planFileContent } = prev

    const MAX_COVERAGE_ROUNDS = 2
    let coverageRound = 0
    let priorGaps = []

    while (coverageRound < MAX_COVERAGE_ROUNDS) {
      coverageRound++

      const unansweredInCoverage = (research.answeredQuestions || [])
        .filter(qa => qa.answer?.toLowerCase().startsWith('could not determine'))

      // Coverage job: check written plan covers the concern's questions.
      // Does NOT receive: full ticket, full Q&A answers — questions are the checklist, answers are in the plan.
      // Round 1: questions checklist + plan. Round 2: prior gaps only + last 2000 chars of plan.
      const coverageChecklist = [
        ...(concern.questions || []).map((q, i) => `${i + 1}. ${q}`),
        ...(unansweredInCoverage.length > 0
          ? [`\nUNANSWERED (flag as gaps if they affect implementation):`
            , ...unansweredInCoverage.map(qa => `• ${qa.question}`)]
          : []),
      ].join('\n')

      // Truncate plan for coverage — full plan can be 8k-12k tokens; checker only needs content
      const planForCoverage = planFileContent.length > 8000
        ? planFileContent.slice(0, 8000) + '\n\n[...plan truncated for coverage check — Tasks JSON block omitted]'
        : planFileContent

      const coveragePrompt = coverageRound === 1
        ? `You are the coverage reviewer. Check whether the written plan answers every concern question.
Declare covered=true only when every question is addressed in the plan.
If gaps found, return covered=false with each gap: which plan section to patch and a focused question.

CONCERN: ${concern.label}

QUESTIONS TO CHECK (each must be answered somewhere in the plan):
${coverageChecklist || 'none'}

WRITTEN PLAN:
${planForCoverage}`
        : `Coverage re-check round ${coverageRound}. Check ONLY whether prior gaps were patched.
Do not find new gaps. Declare covered=true if all prior gaps are resolved.

PRIOR GAPS:
${priorGaps.map((g, i) => `${i + 1}. [${g.section}] ${g.missingRequirement}`).join('\n')}

UPDATED PLAN TAIL:
${planFileContent.slice(-2000)}`

      const coverageResult = await trackedAgent(
        coveragePrompt,
        { label: `coverage:${concern.label}-round-${coverageRound}`, phase: 'Coverage',
          model: coverageRound === 1 ? researcherModel : haikuModel,
          effort: coverageRound === 1 ? 'medium' : 'low',
          schema: COVERAGE_SCHEMA }
      )

      if (!coverageResult || coverageResult.covered || !coverageResult.gaps?.length) {
        log(`Coverage[${concern.label}]: confirmed after ${coverageRound} round(s)`)
        break
      }

      priorGaps = coverageResult.gaps
      log(`Coverage[${concern.label}] round ${coverageRound}: ${coverageResult.gaps.length} gap(s)`)

      // Sequential gap fills — avoids nested parallel() stall risk inside pipeline stage
      const gapFillResults = []
      for (const gap of coverageResult.gaps) {
        let patch
        if (!gap.filesToRead?.length) {
          patch = await trackedAgent(
            `Patch the "${gap.section}" section of this plan to address the gap. Return ONLY the patched section (markdown).
SECTION: ${gap.section}
GAP: ${gap.missingRequirement}
QUESTION: ${gap.question}
KEY FINDINGS: ${(research.keyFindings || []).map(f => `• ${f}`).join('\n') || 'none'}`,
            { label: `coverage-patch:${concern.label}-${gap.section}`, phase: 'Coverage',
              model: coverageRound === 1 ? researcherModel : haikuModel,
              effort: coverageRound === 1 ? 'medium' : 'low' }
          )
        } else {
          const gapResearch = await agent(
            `REPO: ${repoPath}\nFILES TO READ: ${gap.filesToRead.join(', ')}\nQUESTION: ${gap.question}\nCONCERN: ${concern.label}`,
            { label: `gap-fill:${concern.label}-${gap.section}`, phase: 'Coverage', model: researcherModel, effort: 'medium', schema: RESEARCHER_SCHEMA, agentType: 'hp-researcher' }
          )
          patch = await trackedAgent(
            `Patch the "${gap.section}" section to address this gap. Return ONLY the patched section (markdown).
GAP: ${gap.missingRequirement}
NEW RESEARCH: ${JSON.stringify(gapResearch || {}, null, 2)}`,
            { label: `coverage-patch:${concern.label}-${gap.section}`, phase: 'Coverage',
              model: coverageRound === 1 ? researcherModel : haikuModel,
              effort: coverageRound === 1 ? 'medium' : 'low' }
          )
        }
        gapFillResults.push(patch)
      }

      const validPatches = (gapFillResults || []).filter(Boolean)
      if (validPatches.length > 0) {
        const patchBundle = coverageResult.gaps
          .map((g, i) => validPatches[i] ? `SECTION: ${g.section}\nPATCH:\n${validPatches[i]}` : null)
          .filter(Boolean).join('\n\n---\n\n')
        // Truncate plan for integrate agent — preserve head (sections to patch) + tail (Tasks JSON block)
        const planForIntegrate = planFileContent.length > 8000
          ? planFileContent.slice(0, 5000) + '\n\n[...middle omitted...]\n\n' + planFileContent.slice(-3000)
          : planFileContent
        const integrated = await agent(
          `Integrate patches into the plan by merging each into the correct section in place.
Do NOT append as addendums. Keep the Tasks JSON block exactly as-is.
PATCHES:\n${patchBundle}\n\nPLAN:\n${planForIntegrate}`,
          { label: `coverage-integrate:${concern.label}-round-${coverageRound}`, phase: 'Coverage', model: haikuModel, effort: 'low' }
        )
        if (integrated) planFileContent = integrated
      }
    }

    return { ...prev, planFileContent, coverageRound }
  }
)

const validConcernResults = (concernResults || []).filter(Boolean)
const stalledCount = researchConcerns.length - validConcernResults.length
const droppedConcerns = researchConcerns
  .filter(c => !validConcernResults.find(r => r.concern.label === c.label))
  .map(c => c.label)
if (validConcernResults.length === 0) throw new Error(`All ${researchConcerns.length} concerns stalled — cannot produce plan. Check architect prompt sizes.`)
if (stalledCount > 0) {
  log(`⚠ Stall gate: ${stalledCount}/${researchConcerns.length} concern(s) dropped: ${droppedConcerns.join(', ')}`)
  log(`Proceeding with ${validConcernResults.length} valid concern(s). Dropped concerns will appear as gaps in debrief.`)
  log(`Fix: these concerns are over-broad — split each by architectural layer before next run.`)
}

// securityResult already resolved upfront before pipeline

// ─── Phase 6: Return ─────────────────────────────────────────────────────────
// Haiku writes N plan files + manifest, commits all in one shot.

trackPhase('Return')

const today = args.today
if (!today) throw new Error('harness-plan requires args.today (YYYY-MM-DD) — ensure SKILL passes the current date')

const planSlug = (() => {
  if (args.slug) return args.slug
  const jiraMatch = (input || '').match(/\b([A-Z]+-\d+)\b/)
  if (jiraMatch) return jiraMatch[1].toLowerCase()
  const ghMatch = (input || '').match(/issue\s*#?(\d+)/i)
  if (ghMatch) return `issue-${ghMatch[1]}`
  return (input || '').split('\n')[0].slice(0, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
})()

const manifestName = `${today}-${planSlug}-manifest.json`
const manifestPath = `${repoPath}/docs/manifests/${manifestName}`

// Build per-concern file entries
const planEntries = validConcernResults.map((r, i) => {
  const suffix = validConcernResults.length === 1 ? 'p1' : `p${i + 1}`
  const fileName = `${today}-${planSlug}-${suffix}.md`
  const jsonName  = `${today}-${planSlug}-${suffix}.json`
  const prTitleMatch = r.planFileContent.match(/^#\s+(.+)$/m)
  const prTitle = prTitleMatch ? prTitleMatch[1].trim() : r.concern.label
  const planJson = JSON.stringify({
    planKey: `${planSlug}-${suffix}`,
    planPath: `docs/manifests/${fileName}`,
    prTitle,
    mockPolicy: r.research.mockPolicy || '',
    constraints: r.research.constraints.map(c => c.howToApply ? `${c.rule} — ${c.howToApply}` : c.rule),
    tasks: r.architectResult.tasks,
  }, null, 2)
  return { suffix, fileName, jsonName, planFileContent: r.planFileContent, planJson, prTitle, concern: r.concern }
})

// Determine execution order — sequential by default, parallel if all concerns are independent
const execution = validConcernResults.length === 1 ? 'sequential' : 'parallel'

const manifestObj = {
  title: (input || '').split('\n')[0].slice(0, 80).trim(),
  size,
  execution,
  sourceSubtask: manifestEntry?.jiraKey || null,
  plans: planEntries.map((e, i) => ({
    id: e.suffix,
    path: `docs/manifests/${e.fileName}`,
    jsonPath: `docs/manifests/${e.jsonName}`,
    dependsOn: execution === 'sequential' && i > 0 ? [planEntries[i - 1].suffix] : [],
  })),
}

// Write each concern's plan files in parallel — one agent per concern (bounded prompt size)
const writeResults = await parallel(planEntries.map(e => () => trackedAgent(
  `Write TWO files exactly as provided using the Write tool. Do NOT truncate or reformat — write byte-for-byte.

FILE 1 — markdown plan:
PATH: ${repoPath}/docs/manifests/${e.fileName}
CONTENT:
${e.planFileContent}

FILE 2 — companion JSON (write EXACTLY as given, do not truncate):
PATH: ${repoPath}/docs/manifests/${e.jsonName}
CONTENT:
${e.planJson}

Return JSON: { written: true }`,
  { label: `write-plan:${e.concern.label}`, phase: 'Return', model: haikuModel, effort: 'low',
    schema: { type: 'object', required: ['written'], properties: { written: { type: 'boolean' } } },
  }
)))

const writeFailures = writeResults.filter(r => !r?.written)
const writeStalls = writeResults.filter(r => r === null)
if (writeStalls.length > 0) log(`⚠ Return: ${writeStalls.length} write agent(s) stalled (null) — files may be missing`)
if (writeFailures.length > 0) throw new Error(`${writeFailures.length} plan file write(s) failed — check docs/manifests/ permissions`)

// Write manifest only — no git commit. Plan files are local artifacts, not committed to the branch.
// Committing plan files causes them to be discovered by future runs' researchers and biases output.
// harness-implement reads plan files from disk directly — git history is not needed.
const writeResult = await trackedAgent(
  `Write ONE file exactly as provided using the Write tool.

FILE — manifest:
PATH: ${manifestPath}
CONTENT:
${JSON.stringify(manifestObj, null, 2)}

Return JSON: { written: true, committed: false, planCount: ${planEntries.length} }`,
  { label: 'write-manifest', phase: 'Return', model: haikuModel, effort: 'low',
    schema: {
      type: 'object',
      required: ['written', 'committed', 'planCount'],
      properties: { written: { type: 'boolean' }, committed: { type: 'boolean' }, planCount: { type: 'number' } },
    },
  }
)

if (!writeResult?.written) throw new Error('write-manifest agent failed — check docs/manifests/ permissions')

// Post-commit verification — confirm files exist on disk and JSON is valid
const verifyResult = await trackedAgent(
  `Verify that all plan files exist on disk and JSON files are valid.
Run these commands:
1. Check each file exists: ${[...planEntries.map(e => `${repoPath}/docs/manifests/${e.fileName}`), ...planEntries.map(e => `${repoPath}/docs/manifests/${e.jsonName}`), manifestPath].map(f => `test -f "${f}" && echo "ok: ${f}" || echo "missing: ${f}"`).join('\n')}
2. Validate each JSON: ${planEntries.map(e => `node -e "JSON.parse(require('fs').readFileSync('${repoPath}/docs/manifests/${e.jsonName}','utf8'))" && echo "valid: ${e.jsonName}" || echo "invalid: ${e.jsonName}"`).join('\n')}

Return JSON: { allFilesPresent: boolean, allJsonValid: boolean, commitStat: "n/a — plans are local only, not committed", issues: string[] }`,
  { label: 'verify-files', phase: 'Return', model: haikuModel, effort: 'low',
    schema: {
      type: 'object',
      required: ['allFilesPresent', 'allJsonValid', 'commitStat', 'issues'],
      properties: {
        allFilesPresent: { type: 'boolean' },
        allJsonValid: { type: 'boolean' },
        commitStat: { type: 'string' },
        issues: { type: 'array', items: { type: 'string' } },
      },
    },
  }
)

if (verifyResult && (!verifyResult.allFilesPresent || !verifyResult.allJsonValid)) {
  log(`Return verify: issues found — ${verifyResult.issues.join(', ')}`)
} else {
  log(`Plans written and verified: ${planEntries.length} plan file(s) + ${manifestName} (local only, not committed)`)
}

// ─── Phase 7: Debrief ─────────────────────────────────────────────────────────

trackPhase('Debrief')

const allTasks = validConcernResults.flatMap(r => r.architectResult.tasks)
const allFilesInScope = validConcernResults.flatMap(r => r.research.filesInScope)
const allPatterns = validConcernResults.flatMap(r => r.research.patterns)
const allConstraints = validConcernResults.flatMap(r => r.research.constraints)
const totalRevisions = validConcernResults.reduce((s, r) => s + (r.revisionRound || 0), 0)
const totalCoverageRounds = validConcernResults.reduce((s, r) => s + (r.coverageRound || 0), 0)

const outputTokensTotal = budget.spent() - workflowStartTokens
const displayCostUsd = _computeCostV2({ agentCountByModel, inputTokens: null, outputTokensTotal }).rateLockedUsd

// Quality check — inline, no agent
const qualityIssues = []
for (const task of allTasks) {
  const d = task.description || ''
  if (!/what/i.test(d)) qualityIssues.push(`${task.id}: missing WHAT`)
  if (!/where/i.test(d)) qualityIssues.push(`${task.id}: missing WHERE`)
  if (!/how/i.test(d)) qualityIssues.push(`${task.id}: missing HOW`)
  if (task.tddRequired && !/done/i.test(d)) qualityIssues.push(`${task.id}: tddRequired but missing DONE`)
  if (!/```/.test(d)) qualityIssues.push(`${task.id}: no inline code snippet found`)
}

// ── Structural validator — gates on field substance, not just keyword presence ──
// Keyword check above catches "WHAT: " with no content. This catches thin content.
const structurallyWeak = allTasks.filter(t => {
  const d = t.description || ''
  const whereMatch = d.match(/where[:\s]+(.+?)(?=\n(?:what|how|done)|$)/is)
  const howMatch   = d.match(/how[:\s]+(.+?)(?=\n(?:what|where|done)|$)/is)
  const whereLen = (whereMatch?.[1] || '').trim().length
  const howLen   = (howMatch?.[1] || '').trim().length
  const hasSnippet = /```/.test(d)
  return whereLen < 20 || howLen < 20 || !hasSnippet
})

if (structurallyWeak.length > 0) {
  for (const t of structurallyWeak) {
    qualityIssues.push(`thin-spec: ${t.id} "${(t.title || '').slice(0, 50)}" — WHERE/HOW too short or missing code snippet (implement will NEEDS_CONTEXT)`)
  }
  log(`⚠️  Structural validator: ${structurallyWeak.length} task(s) with thin WHERE/HOW/snippet — likely NEEDS_CONTEXT in implement`)
} else {
  log(`✅ Structural validator: all ${allTasks.length} tasks have substantive WHERE/HOW + snippet`)
}

// Structural coverage check
const assignedFiles = new Set(allTasks.flatMap(t => t.files || []))
const unassignedFiles = allFilesInScope.map(f => f.path || f).filter(p => !assignedFiles.has(p))
for (const f of unassignedFiles) {
  qualityIssues.push(`unassigned: ${f} is in scope but has no task`)
}

// Unanswered question check — any "could not determine" that made it through is a quality issue
const allUnanswered = validConcernResults.flatMap(r =>
  (r.research.answeredQuestions || [])
    .filter(qa => qa.answer?.toLowerCase().startsWith('could not determine'))
    .map(qa => `${r.concern.label}: unanswered — ${qa.question}`)
)
qualityIssues.push(...allUnanswered)

// Concern count check — if fewer plans than concerns, some silently dropped
if (planEntries.length < researchConcerns.length) {
  qualityIssues.push(`concern drop: ${researchConcerns.length} concerns decomposed but only ${planEntries.length} plan(s) produced`)
}

// Audit verdict — COMPLETE only if zero quality issues AND commit verified
const commitOk = !verifyResult || (verifyResult.allFilesPresent && verifyResult.allJsonValid)
const planStatus = (qualityIssues.length === 0 && commitOk) ? 'COMPLETE' : 'PROPOSED_WITH_GAPS'

_buildAuditRecord(planStatus, {
  planSlug,
  manifestPath: `docs/manifests/${manifestName}`,
  planCount: planEntries.length,
  taskCount: allTasks.length,
  filesInScope: allFilesInScope.length,
  patternsFound: allPatterns.length,
  constraintsFound: allConstraints.length,
  qualityIssues,
  architectRevisions: totalRevisions,
  coverageRounds: totalCoverageRounds,
  size,
  planManifest: manifestObj,
})
auditWritten = true

const qualityLine = qualityIssues.length === 0
  ? 'quality: ✓ all tasks have WHAT/WHERE/HOW/DONE + snippet'
  : `quality: ${qualityIssues.length} issue(s) — see audit log`

const planSlugForDisplay = (input || '').match(/\b([A-Z]+-\d+)\b/)?.[1] || planSlug
const nextCmd = manifestObj.execution === 'parallel'
  ? planEntries.map(e => `/harness-implement docs/manifests/${e.jsonName}`).join('\n         ')
  : planEntries.map((e, i) => i === 0
      ? `/harness-implement docs/manifests/${e.jsonName}`
      : `/harness-implement docs/manifests/${e.jsonName}  (after ${planEntries[i-1].suffix})`
    ).join('\n         ')

const planStatusIcon = planStatus === 'COMPLETE' ? '✅' : '⚠️'

const totalAgents = Object.values(agentCountByModel).reduce((a,b)=>a+b,0)
const agentMetricsLines = Object.entries(agentCountByModel)
  .filter(([,c]) => c > 0)
  .map(([m, c]) => {
    const label = m.includes('opus') ? 'opus  ' : m.includes('haiku') ? 'haiku ' : 'sonnet'
    return `    ${label}  (×${c})`
  }).join('\n')

const cliSummary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
harness-plan
  status:  ${planStatus}  ${planStatusIcon}
  ticket:  ${planSlugForDisplay}
  size:    ${size}
  plans:   ${planEntries.length}
  tasks:   ${allTasks.length}
  files:   ${allFilesInScope.length}
  quality: ${qualityIssues.length === 0 ? '✓ clean' : `${qualityIssues.length} issue(s)`}
${planEntries.map(e => `    · docs/manifests/${e.fileName}`).join('\n')}

  next:    ${nextCmd}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

log(cliSummary)

return {
  manifestPath: `docs/manifests/${manifestName}`,
  planCount: planEntries.length,
  taskCount: allTasks.length,
  qualityIssues,
  estimatedCostUsd: displayCostUsd,
  status: planStatus,
  cliSummary,
  telemetryPath: _telemetryPath,
  auditRecords: [..._pendingAuditRecords],
  outputTokensTotal: budget.spent() - workflowStartTokens,
  agentCountByModel,
}

} catch (err) {
  if (!auditWritten) {
    const isKilled = err.message?.includes('abort') || err.message?.includes('cancel') || err.message?.includes('interrupt')
    const crashStatus = isKilled
      ? 'CRASHED'
      : ['Research', 'Architect', 'Synthesize', 'Coverage', 'Return', 'Debrief'].includes(currentPhase) ? 'PROPOSED_WITH_GAPS' : 'FAILED'
    _buildAuditRecord(crashStatus, {
      planSlug: (args.slug || (input || '').match(/\b([A-Z]+-\d+)\b/)?.[1]?.toLowerCase() || 'unknown'),
      failedAtPhase: currentPhase,
      error: err.message || String(err),
      inputSlug: (input || '').slice(0, 80),
      size: partialState.size || null,
      qualityIssues: [],
      architectRevisions: 0,
      coverageRounds: 0,
    })
  }
  throw Object.assign(err, { telemetryPath: _telemetryPath, auditRecords: [..._pendingAuditRecords] })
}
