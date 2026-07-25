export const meta = {
  name: 'harness-implement',
  description: 'Execute an approved plan file into a ready-to-push branch',
  phases: [
    { title: 'Load',      detail: 'read plan + toolbelt (conventions, scripts, generators) in parallel' },
    { title: 'Worktree',  detail: 'create isolated git worktree from origin/<default>' },
    { title: 'Implement', detail: 'walk DAG — developer (with toolbelt) → QA + per-task diff review' },
    { title: 'Verify',    detail: 'npm test + tsc --noEmit' },
    { title: 'Review',    detail: 'Haiku file-reviewers (parallel) + Sonnet spec-compliance + Sonnet security' },
    { title: 'Return',    detail: 'PR title/body' },
    { title: 'Debrief',   detail: 'Haiku — audit log, CLI summary box' },
  ],
}

// args: { planPath, repoPath, branchName?, resumeState? }
// planPath: repo-relative path to plan file, e.g. "docs/plans/2026-07-20-tars-1294.md"
// repoPath: absolute path to repo
// branchName: optional override; defaults to "implement/<plan-slug>"

const resume = args.resumeState || {}

// ─── Token tracking + wall-clock start ───────────────────────────────────────
// trackedAgent wraps agent() to accumulate output tokens per model tier.
// For parallel blocks, snapshot from outside the block — never inside thunks.
// _workflowStartTs: captured at run start for self-contained durationMs.

let _workflowStartTs = null
const _startTsPromise = agent(
  `Run: python3 -c "import time; print(int(time.time()*1000))"\nReturn { ms: <number> }`,
  { label: 'workflow-start-ts', phase: 'Load', model: 'claude-haiku-4-5-20251001', effort: 'low',
    schema: { type: 'object', required: ['ms'], properties: { ms: { type: 'number' } } } }
).then(r => { _workflowStartTs = r?.ms || null }).catch(() => {})

const workflowStartTokens = budget.spent()
const tokensByModel = { haiku: 0, sonnet: 0, opus: 0 }
const agentCountByModel = { haiku: 0, sonnet: 0, opus: 0 }

async function trackedAgent(prompt, opts) {
  const before = budget.spent()
  const result = await agent(prompt, opts)
  const m = opts.model || 'sonnet'
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
function _buildImplTelemetryPath({ repoPath, issueKey, rawText, timestamp }) {
  const repo    = _repoNameFromPath(repoPath)
  const key     = issueKey || _slugFromInput(rawText)
  const ts      = timestamp || 'unknown-ts'
  const homeDir = (repoPath || '').replace(/\/Desktop\/Repos\/[^/]+\/?$/, '') || '/tmp'
  return `${homeDir}/Desktop/Repos/harness-telemetry/logs/${repo}__harness-implement__${key}__${ts}.jsonl`
}
// lib/status.js — keep identical.
const _IMPL_OUTCOME_MAP = {
  COMPLETE: 'success',
  PARTIAL:  'partial',
  CRASHED:  'failed',
  FAILED:   'failed',
}
function toOutcome(status) { return _IMPL_OUTCOME_MAP[status] ?? 'failed' }
// ===== END PURE =====

// telemetryPath is set on first writeAuditRecord call, then reused for the Debrief write.
let _telemetryPath = null

async function writeAuditRecord(status, extra = {}) {
  const outputTokensTotal = budget.spent() - workflowStartTokens
  await _startTsPromise  // ensure start timestamp resolved before computing delta
  const [durationMs, skillsCommit, runTs] = await Promise.all([
    agent(
      `Run: python3 -c "import time; print(int(time.time()*1000) - ${_workflowStartTs || (args.startTs || 0)})"\nReturn { ms: <number> }`,
      { label: 'duration-ms', phase: 'Debrief', model: 'haiku', effort: 'low',
        schema: { type: 'object', required: ['ms'], properties: { ms: { type: 'number' } } } }
    ).then(r => { const v = r?.ms; return (v != null && v > 0 && v < 36_000_000) ? v : null }).catch(() => null),
    agent(
      `Run: git -C ~/Desktop/Repos/skills rev-parse HEAD 2>/dev/null || git -C ~/.claude/skills rev-parse HEAD 2>/dev/null || echo unknown\nReturn { sha: "<40-char hex or unknown>" }`,
      { label: 'skills-commit', phase: 'Debrief', model: 'haiku', effort: 'low',
        schema: { type: 'object', required: ['sha'], properties: { sha: { type: 'string' } } } }
    ).then(r => r?.sha || null).catch(() => null),
    _telemetryPath
      ? Promise.resolve(null)
      : agent(
          `Run: python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))"\nReturn { ts: "<compact-utc-timestamp>" }`,
          { label: 'run-ts', phase: 'Debrief', model: 'haiku', effort: 'low',
            schema: { type: 'object', required: ['ts'], properties: { ts: { type: 'string' } } } }
        ).then(r => r?.ts || null).catch(() => null),
  ])
  if (!_telemetryPath) {
    const issueKey = (args.planPath || '').match(/\b([A-Z]+-\d+)\b/i)?.[1] || null
    _telemetryPath = _buildImplTelemetryPath({ repoPath: args.repoPath, issueKey, rawText: args.planPath, timestamp: runTs })
  }
  const tsDate = args.today || (runTs ? runTs.slice(0, 4) + '-' + runTs.slice(4, 6) + '-' + runTs.slice(6, 8) : 'unknown')
  const record = JSON.stringify({
    ts: tsDate,
    skill: 'harness-implement',
    skillsSchemaVersion: SKILLS_SCHEMA_VERSION,
    skillsCommit,
    status,
    outcome: toOutcome(status),
    repo: _repoNameFromPath(args.repoPath),
    repoPath: args.repoPath || null,
    branch: null,
    planPath: args.planPath || 'unknown',
    durationMs,
    outputTokensByModel: tokensByModel,
    agentCountByModel,
    outputTokensTotal,
    ...extra,
  })
  const legacyCmd    = `echo '${record.replace(/'/g, "'\\''")}' >> ~/.claude/harness-implement-runs.jsonl`
  const telemetryCmd = `mkdir -p "$(dirname '${_telemetryPath}')" && echo '${record.replace(/'/g, "'\\''")}' >> '${_telemetryPath}'`
  await agent(
    `Append an audit record to two JSONL files. Use the Bash tool only. Run both commands:\n1. ${legacyCmd}\n2. ${telemetryCmd}\nReturn { appended: true }.`,
    { label: 'audit-write', phase: 'Debrief', model: 'haiku', effort: 'low',
      schema: { type: 'object', required: ['appended'], properties: { appended: { type: 'boolean' } } },
    }
  )
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const TASK_SCHEMA_ITEM = {
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
}

const HANDOFF_SCHEMA = {
  type: 'object',
  required: ['taskId', 'status', 'filesChanged', 'testsAdded', 'summary'],
  properties: {
    taskId:       { type: 'string' },
    status:       { type: 'string', enum: ['DONE', 'NEEDS_CONTEXT'] },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsAdded:   { type: 'array', items: { type: 'string' } },
    summary:      { type: 'string' },
    caveats:      { type: 'string' },
    tddEvidence:  { type: 'string' },
  },
}

const CODE_REVIEW_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'severity', 'issue', 'suggestion'],
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          category: { type: 'string' },
          issue: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
  },
}

const SECURITY_SCHEMA = {
  type: 'object',
  required: ['status', 'findings', 'passedChecks'],
  properties: {
    status: { type: 'string', enum: ['PASS', 'PASS_WITH_NOTES', 'FAIL'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['owasp', 'severity', 'file', 'issue'],
        properties: {
          owasp: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          file: { type: 'string' },
          line: { type: 'number' },
          issue: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
    passedChecks: { type: 'array', items: { type: 'string' } },
  },
}

const SCOPE_DRIFT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'changes', 'suggestedTickets'],
  properties: {
    verdict: { type: 'string', enum: ['CLEAN', 'DRIFT', 'FOLLOW_UP'] },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'classification', 'reason'],
        properties: {
          file:           { type: 'string' },
          classification: { type: 'string', enum: ['necessary', 'drift', 'follow-up'] },
          reason:         { type: 'string', description: 'one sentence: why this file was touched and whether it belongs in this PR' },
        },
      },
    },
    suggestedTickets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'rationale'],
        properties: {
          title:     { type: 'string', description: 'short Jira-ready ticket title' },
          rationale: { type: 'string', description: 'one sentence: what work this ticket would contain' },
        },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['testsPassed', 'typeCheckPassed', 'summary'],
  properties: {
    testsPassed: { type: 'boolean' },
    testsOutput: { type: 'string' },
    typeCheckPassed: { type: 'boolean' },
    typeCheckOutput: { type: 'string' },
    summary: { type: 'string' },
  },
}

const TOOLBELT_SCHEMA = {
  type: 'object',
  required: ['forbiddenPatterns', 'requiredPatterns', 'namingRules', 'testRules', 'scripts', 'generators', 'templates'],
  properties: {
    forbiddenPatterns: { type: 'array', items: { type: 'string' } },
    requiredPatterns:  { type: 'array', items: { type: 'string' } },
    namingRules:       { type: 'array', items: { type: 'string' } },
    testRules:         { type: 'array', items: { type: 'string' } },
    scripts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'command'],
        properties: {
          name:          { type: 'string' },
          command:       { type: 'string' },
          mustRunBefore: { type: 'string' },
          description:   { type: 'string' },
        },
      },
    },
    generators: {
      type: 'array',
      items: {
        type: 'object',
        required: ['trigger', 'command'],
        properties: {
          trigger:  { type: 'string' },
          command:  { type: 'string' },
          template: { type: 'string' },
        },
      },
    },
    templates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['for', 'copyFrom'],
        properties: {
          for:      { type: 'string' },
          copyFrom: { type: 'string' },
        },
      },
    },
  },
}

// ─── Diff helpers ─────────────────────────────────────────────────────────────
// Split an accumulated diff into per-file chunks, then sub-chunk each file by
// hunk boundaries (never mid-hunk). Single oversized hunks pass through whole.

function splitDiffByFile(rawDiff) {
  return rawDiff.split(/(?=^diff --git )/m).filter(s => s.trim().length > 0)
}

function splitFileIntoChunks(fileDiff, maxLines = 300) {
  const lines = fileDiff.split('\n')
  // Separate file header (diff --git, index, ---, +++) from hunk bodies
  const firstHunkIdx = lines.findIndex(l => l.startsWith('@@'))
  const header = firstHunkIdx > 0 ? lines.slice(0, firstHunkIdx).join('\n') + '\n' : ''
  const body = firstHunkIdx > 0 ? lines.slice(firstHunkIdx).join('\n') : fileDiff

  const hunks = body.split(/(?=^@@ )/m).filter(s => s.trim().length > 0)
  const chunks = []
  let current = header

  for (const hunk of hunks) {
    const projected = current + hunk
    if (current !== header && projected.split('\n').length > maxLines) {
      chunks.push(current)
      current = header + hunk  // re-attach file header so reviewer has context
    } else {
      current = projected
    }
  }
  if (current !== header) chunks.push(current)
  return chunks.length > 0 ? chunks : [fileDiff]
}

// ─── Stage 1: Load plan ───────────────────────────────────────────────────────
// Prefer companion .json (written by harness-plan) — eliminates 2-agent parse hop.
// Falls back to markdown extraction if json not found.

let currentPhase = 'init'
let auditWritten = false
const partialState = {}
function trackPhase(name) { currentPhase = name; phase(name) }

try {

trackPhase('Load')

if (!args.planPath) throw new Error('harness-implement requires planPath')
if (!args.repoPath) throw new Error('harness-implement requires repoPath')

// Derive companion JSON path: docs/plans/2026-07-21-slug.md → docs/plans/2026-07-21-slug.json
const jsonPath = args.planPath.replace(/\.md$/, '.json')
const absJsonPath = `${args.repoPath}/${jsonPath}`
const absMdPath = `${args.repoPath}/${args.planPath}`

const PLAN_EXTRACT_SCHEMA = {
  type: 'object',
  required: ['tasks', 'prTitle', 'planKey'],
  properties: {
    tasks: { type: 'array', items: TASK_SCHEMA_ITEM },
    prTitle: { type: 'string' },
    planKey: { type: 'string' },
    mockPolicy: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
  },
}

const [planData, toolbelt] = await parallel([
  () => agent(
    `Load the plan data for harness-implement. Try in this order:

1. Read ${absJsonPath} — if it exists and is valid JSON, parse it directly and return the structured data.
2. If the JSON file does not exist, read ${absMdPath} instead and extract:
   a. tasks: the JSON array from the "## Tasks" section — parse it exactly as written
   b. prTitle: from the first # heading, formatted as a conventional commit title
   c. planKey: ticket key or slug from filename (e.g. "tars-1294")
   d. mockPolicy: mock policy from constraints section (empty string if absent)
   e. constraints: named constraints listed in the document (empty array if absent)

Return the structured plan data as JSON.`,
    { label: 'load-plan', phase: 'Load', model: 'haiku', effort: 'low', schema: PLAN_EXTRACT_SCHEMA }
  ),
  () => (async () => {
    // 4 parallel concern agents — each discovers its own files via find, no hardcoded paths
    const RULES_SCHEMA    = { type: 'object', required: ['forbiddenPatterns','requiredPatterns','namingRules'], properties: { forbiddenPatterns: { type: 'array', items: { type: 'string' } }, requiredPatterns: { type: 'array', items: { type: 'string' } }, namingRules: { type: 'array', items: { type: 'string' } } } }
    const STYLING_SCHEMA  = { type: 'object', required: ['forbiddenPatterns','requiredPatterns','namingRules'], properties: { forbiddenPatterns: { type: 'array', items: { type: 'string' } }, requiredPatterns: { type: 'array', items: { type: 'string' } }, namingRules: { type: 'array', items: { type: 'string' } } } }
    const TESTING_SCHEMA  = { type: 'object', required: ['testRules'], properties: { testRules: { type: 'array', items: { type: 'string' } } } }
    const TOOLING_SCHEMA  = { type: 'object', required: ['scripts','generators','templates'], properties: { scripts: { type: 'array', items: { type: 'object', required: ['name','command'], properties: { name: { type: 'string' }, command: { type: 'string' }, mustRunBefore: { type: 'string' }, description: { type: 'string' } } } }, generators: { type: 'array', items: { type: 'object', required: ['trigger','command'], properties: { trigger: { type: 'string' }, command: { type: 'string' }, template: { type: 'string' } } } }, templates: { type: 'array', items: { type: 'object', required: ['for','copyFrom'], properties: { for: { type: 'string' }, copyFrom: { type: 'string' } } } } } }

    const [rules, styling, testing, tooling] = await parallel([
      () => agent(
        `REPO: ${args.repoPath}
Find and read instruction/rule files. Run:
  find ${args.repoPath} -maxdepth 3 -type f \\( -iname "CLAUDE.md" -o -iname "AGENTS.md" -o -iname ".cursorrules" -o -iname "CONTRIBUTING.md" -o -iname "CONVENTIONS.md" \\) 2>/dev/null
Read each file found (skip if none). Extract ONLY: forbidden patterns, required patterns, naming rules.
Return compact arrays — rules not prose.`,
        { label: 'toolbelt:rules', phase: 'Load', model: 'haiku', effort: 'low', schema: RULES_SCHEMA }
      ),
      () => agent(
        `REPO: ${args.repoPath}
Find and read styling/design files. Run:
  find ${args.repoPath} -maxdepth 4 -type f \\( -iname "*STYLING*" -o -iname "*DESIGN*" -o -iname "*TOKEN*" -o -iname "*COMPONENT*" -o -name "tailwind.config.*" -o -name "postcss.config.*" \\) 2>/dev/null
Read each file found (skip if none). Extract ONLY: forbidden CSS/class patterns, required patterns, naming rules for components/tokens.
Return compact arrays — rules not prose.`,
        { label: 'toolbelt:styling', phase: 'Load', model: 'haiku', effort: 'low', schema: STYLING_SCHEMA }
      ),
      () => agent(
        `REPO: ${args.repoPath}
Find and read testing config and one representative test file. Run:
  find ${args.repoPath} -maxdepth 3 -type f \\( -name "vitest.config.*" -o -name "jest.config.*" -o -iname "*TEST*GUIDE*" -o -iname "*TESTING*" \\) 2>/dev/null
Also run:
  find ${args.repoPath} -maxdepth 4 -type f -name "*.test.*" 2>/dev/null | head -2
Read config files and skim one test file. Extract ONLY: test rules, mock policy, TDD requirements, framework patterns.
IMPORTANT: If vi.mock or jest.mock is used to mock a module (e.g. vi.mock('../utils/clientFetch')), extract the rule:
"In tests that vi.mock a module, assert on the MOCKED module directly (e.g. expect(clientFetch).toHaveBeenCalledWith(...)).
NEVER assert on underlying globals (e.g. global.fetch) — those are never called when the module is mocked."
Return compact array of actionable rules.`,
        { label: 'toolbelt:testing', phase: 'Load', model: 'haiku', effort: 'low', schema: TESTING_SCHEMA }
      ),
      () => agent(
        `REPO: ${args.repoPath}
Find scripts, generators and templates. Run:
  cat ${args.repoPath}/package.json 2>/dev/null | grep -A 50 '"scripts"'
  find ${args.repoPath} -maxdepth 3 -type f \\( -name "_template*" -o -name "*.template.*" -o -path "*/scripts/*.sh" -o -path "*/scripts/*.ts" -o -path "*/scripts/*.js" \\) 2>/dev/null
Read package.json scripts section and any template/script files found. Extract:
- scripts: name, command, mustRunBefore (commit/push/pr), description
- generators: trigger condition → command to run
- templates: what it's for → file path to copy from
Return compact structured arrays.`,
        { label: 'toolbelt:tooling', phase: 'Load', model: 'haiku', effort: 'low', schema: TOOLING_SCHEMA }
      ),
    ])

    // Merge 4 concern slices into one TOOLBELT_SCHEMA-shaped object
    return {
      forbiddenPatterns: [...(rules?.forbiddenPatterns || []), ...(styling?.forbiddenPatterns || [])],
      requiredPatterns:  [...(rules?.requiredPatterns  || []), ...(styling?.requiredPatterns  || [])],
      namingRules:       [...(rules?.namingRules       || []), ...(styling?.namingRules       || [])],
      testRules:         testing?.testRules   || [],
      scripts:           tooling?.scripts     || [],
      generators:        tooling?.generators  || [],
      templates:         tooling?.templates   || [],
    }
  })(),
])

if (!planData?.tasks?.length) throw new Error('Plan file contains no tasks — run /harness-plan first')

log(`Loaded: ${planData.tasks.length} task(s), key=${planData.planKey}`)
partialState.planKey = planData.planKey
partialState.tasksTotal = planData.tasks.length

const planKey = planData.planKey || 'implement'
const branchName = args.branchName || `implement/${planKey}`
const allTasks = planData.tasks
// baseBranch: passed by the skill after asking the user upfront; falls back to origin HEAD detection
const baseBranch = args.baseBranch || null

// DAG file-conflict guard — enforce here too in case plan was hand-edited
const tasksByGroup = {}
for (const task of allTasks) {
  if (!tasksByGroup[task.groupId]) tasksByGroup[task.groupId] = []
  tasksByGroup[task.groupId].push(task)
}
for (const [groupId, tasks] of Object.entries(tasksByGroup)) {
  if (tasks[0]?.block !== 'parallel' || tasks.length < 2) continue
  const seen = new Set()
  for (const task of tasks) {
    for (const f of task.files) {
      if (seen.has(f)) {
        log(`DAG guard: parallel tasks in ${groupId} share ${f} — forcing sequential`)
        for (const t of tasks) t.block = 'sequential'
        break
      }
      seen.add(f)
    }
  }
}

// ─── Stage 2: Worktree ────────────────────────────────────────────────────────

trackPhase('Worktree')

const worktreeResult = resume.worktree || await agent(
  `Run these exact shell commands in sequence and return JSON.

\`\`\`bash
cd ${args.repoPath}
git fetch origin
${baseBranch
  ? `DEFAULT="${baseBranch}"`
  : `DEFAULT=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')`
}
WORKTREE_PATH="${args.repoPath}/.claude/worktrees/${planKey}"
git worktree add -b ${branchName} "$WORKTREE_PATH" origin/$DEFAULT
echo "{\"worktreePath\":\"$WORKTREE_PATH\",\"branch\":\"${branchName}\",\"baseBranch\":\"$DEFAULT\"}"
\`\`\`

Return the JSON object printed by the last echo.`,
  { label: 'worktree-setup', phase: 'Worktree', model: 'haiku', effort: 'low',
    schema: {
      type: 'object',
      required: ['worktreePath', 'branch', 'baseBranch'],
      properties: { worktreePath: { type: 'string' }, branch: { type: 'string' }, baseBranch: { type: 'string' } },
    },
  }
)

if (!worktreeResult) throw new Error('Worktree setup failed')

const workDir = worktreeResult.worktreePath
log(`Worktree: ${workDir} (branch: ${branchName}, base: ${worktreeResult.baseBranch})`)
partialState.branch = worktreeResult.branch
partialState.baseBranch = worktreeResult.baseBranch

// ─── Stage 3: Implement (DAG walk) ───────────────────────────────────────────

trackPhase('Implement')

const taskGroups = []
const seenGroups = {}
for (const task of allTasks) {
  if (!seenGroups[task.groupId]) {
    seenGroups[task.groupId] = []
    taskGroups.push({ groupId: task.groupId, block: task.block, tasks: seenGroups[task.groupId] })
  }
  seenGroups[task.groupId].push(task)
}

const implementationReports = []

// Single-pass dev execution for one task.
// TDD gate: if tddRequired, run npm test before dev writes code to capture red output,
// then after to confirm green. No QA agent — test suite is the gate.
async function runDeveloper(task) {
  const label = `${task.id}-${task.title.slice(0, 25).replace(/\s+/g, '-').toLowerCase()}`

  const devPrompt = `REPO: ${workDir}
TASK_ID: ${task.id}
TITLE: ${task.title}
FILES: ${task.files.join(', ')}
TDD_REQUIRED: ${task.tddRequired}

DESCRIPTION:
${task.description}

ACCEPTANCE_CRITERIA:
${task.acceptanceCriteria.map(c => `- ${c}`).join('\n')}
${planData.mockPolicy ? `\nMOCK_POLICY: ${planData.mockPolicy}` : ''}
${planData.constraints?.length ? `\nCONSTRAINTS:\n${planData.constraints.map(c => `- ${c}`).join('\n')}` : ''}
UNIVERSAL TEST CONSTRAINT: When vi.mock or jest.mock intercepts a module, assert on the mocked module directly — NEVER on underlying globals (e.g. global.fetch). If a test mocks clientFetch, assert expect(clientFetch).toHaveBeenCalledWith(...), not expect(global.fetch).
${toolbelt ? `\nTOOLBELT (repo conventions — apply before committing):
FORBIDDEN: ${(toolbelt.forbiddenPatterns || []).join('; ') || 'none'}
REQUIRED:  ${(toolbelt.requiredPatterns  || []).join('; ') || 'none'}
NAMING:    ${(toolbelt.namingRules        || []).join('; ') || 'none'}
TEST RULES: ${(toolbelt.testRules         || []).join('; ') || 'none'}
SCRIPTS TO RUN BEFORE COMMIT: ${(toolbelt.scripts || []).filter(s => s.mustRunBefore === 'commit').map(s => s.command).join('  |  ') || 'none'}
GENERATORS: ${(toolbelt.generators || []).map(g => `when ${g.trigger} → ${g.command}`).join('; ') || 'none'}` : ''}

At the end of your work, your return value must be a structured handoff JSON:
- taskId: "${task.id}"
- status: "DONE" or "NEEDS_CONTEXT"
- filesChanged: list of files you modified
- testsAdded: list of test names (it/describe strings) you added
- summary: one sentence of what changed
- caveats: any assumptions or edge cases (empty string if none)
- tddEvidence: last 5 lines of your final npm test run showing tests passing (empty string if not applicable)`

  const handoff = await trackedAgent(
    devPrompt,
    { label: `dev-${label}`, phase: 'Implement', model: 'sonnet', effort: 'high', agentType: 'hi-developer', schema: HANDOFF_SCHEMA }
  )

  if (!handoff) return { task, handoff: null, diffText: null, label, needsContext: false }

  if (handoff.status === 'NEEDS_CONTEXT') {
    return { task, handoff, diffText: null, label, needsContext: true }
  }

  // TDD: capture green run after implementation
  let tddGreenOutput = null
  if (task.tddRequired) {
    tddGreenOutput = await agent(
      `Run: cd ${workDir} && npm test -- --run 2>&1 | tail -20\nReturn ONLY the raw output.`,
      { label: `tdd-green-${task.id}`, phase: 'Implement', model: 'haiku', effort: 'low' }
    )
    const tddPassed = tddGreenOutput && !tddGreenOutput.includes('failed') && !tddGreenOutput.includes('FAIL')
    if (!tddPassed) {
      log(`TDD gate: ${task.id} — tests still failing after implementation`)
    }
  }

  const diffText = await trackedAgent(
    `Run: git -C ${workDir} diff HEAD -- ${task.files.join(' ')}\nReturn ONLY the raw diff output (max 300 lines).`,
    { label: `diff-${label}`, phase: 'Implement', model: 'haiku', effort: 'low' }
  ) || 'diff unavailable'

  return { task, handoff, diffText, label, needsContext: false, tddGreenOutput }
}

// Group-level round: fan-out devs → per-task diff review → evaluate.
// No QA agent — test suite is the gate. Handoff note is the structured output.
async function runGroupRound(tasks) {
  const devResults = await parallel(tasks.map(task => () => runDeveloper(task)))
  const validDevResults = devResults.filter(Boolean)
  const stalledDevs = devResults.filter(r => r === null)
  if (stalledDevs.length > 0) log(`⚠ Implement: ${stalledDevs.length}/${tasks.length} developer agent(s) stalled (null)`)
  if (validDevResults.length === 0) throw new Error(`All ${tasks.length} developer agents stalled in group — cannot continue`)

  // Per-task diff review (haiku, mechanical only)
  const reviewBlockStart = budget.spent()
  const withReviews = await parallel(validDevResults.map(dr => async () => {
    if (!dr.handoff || dr.needsContext) return dr

    const codeReview = await agent(
      `Review this per-task diff for correctness issues only (logic bugs, wrong assumptions, missing null checks).
Read every line. Flag only real issues, not style.

TASK: ${dr.task.title}
FILES: ${dr.task.files.join(', ')}

DIFF:
${dr.diffText}`,
      { label: `cr-${dr.label}`, phase: 'Implement', model: 'haiku', effort: 'low', schema: CODE_REVIEW_SCHEMA }
    )
    return { ...dr, codeReview }
  }))
  tokensByModel.haiku += budget.spent() - reviewBlockStart

  // Partition: NEEDS_CONTEXT is blocked; everything else is passed
  const passed = [], needsContext = []
  for (const r of withReviews.filter(Boolean)) {
    if (r.needsContext || r.handoff?.status === 'NEEDS_CONTEXT') {
      needsContext.push({ task: r.task, handoff: r.handoff, qaResult: { status: 'NEEDS_CONTEXT' }, codeReview: null })
    } else {
      passed.push({ task: r.task, handoff: r.handoff, qaResult: { status: 'PASS' }, codeReview: r.codeReview, tddGreenOutput: r.tddGreenOutput })
    }
  }

  return { passed, blocked: [], needsContext }
}

for (const group of taskGroups) {
  const isParallel = group.block === 'parallel' && group.tasks.length > 1
  log(`Group ${group.groupId}: ${group.tasks.length} task(s)`)

  const { passed, blocked, needsContext } = await runGroupRound(group.tasks)

  for (const r of [...passed, ...needsContext, ...blocked]) {
    implementationReports.push({ ...r, redispatches: 0 })
  }

  // Commit after group completes
  if (isParallel) {
    const titles = group.tasks.map(t => t.title.slice(0, 25)).join(', ')
    await trackedAgent(
      `Commit all staged changes.\nREPO: ${workDir}\n1. git -C ${workDir} add -A\n2. git -C ${workDir} commit -m "${planKey} ${group.groupId}: ${titles.slice(0, 60)}"\nReturn commit hash or "NOTHING_TO_COMMIT".`,
      { label: `commit-${group.groupId}`, phase: 'Implement', model: 'haiku', effort: 'low' }
    )
  } else {
    for (const report of implementationReports.filter(r => group.tasks.some(t => t.id === r.task.id))) {
      const s = report.qaResult?.status
      if (s === 'PASS') {
        await trackedAgent(
          `Commit completed task.\nREPO: ${workDir}\n1. git -C ${workDir} add -A\n2. git -C ${workDir} commit -m "${planKey} ${report.task.id}: ${report.task.title.slice(0, 55)}"\nReturn commit hash or "NOTHING_TO_COMMIT".`,
          { label: `commit-${report.task.id}`, phase: 'Implement', model: 'haiku', effort: 'low' }
        )
      }
    }
  }
}

// ─── Stage 4: Verify ─────────────────────────────────────────────────────────

trackPhase('Verify')

const verifyResult = await trackedAgent(
  `REPO: ${workDir}
Run:
1. npm test -- --run
2. npx tsc --noEmit
Return JSON: testsPassed, testsOutput (last 20 lines), typeCheckPassed, typeCheckOutput, summary.`,
  { label: 'verify', phase: 'Verify', model: 'haiku', effort: 'low', schema: VERIFY_SCHEMA }
)

// ─── Stage 5: Review (per-file Haiku + spec-compliance Sonnet + security Sonnet) ──
// Diff fetched once, split by file, each chunk reviewed by Haiku in parallel.
// Sonnet spec-compliance gets only task descriptions + diff stat (no raw diff).
// Sonnet security gets file list + raw diff (unchanged).

trackPhase('Review')

const [accumulatedDiff, diffSummary, commitLog, changedFilesList] = await parallel([
  () => agent(
    `Run: git -C ${workDir} diff origin/${worktreeResult.baseBranch}...HEAD\nReturn ONLY the raw diff output. No line limit.`,
    { label: 'review-diff', phase: 'Review', model: 'haiku', effort: 'low' }
  ),
  () => agent(
    `Run: git -C ${workDir} diff --stat origin/${worktreeResult.baseBranch}...HEAD\nReturn ONLY the raw output.`,
    { label: 'diff-stat', phase: 'Review', model: 'haiku', effort: 'low' }
  ),
  () => agent(
    `Run: git -C ${workDir} log --oneline origin/${worktreeResult.baseBranch}...HEAD\nReturn ONLY the raw output.`,
    { label: 'commit-log', phase: 'Review', model: 'haiku', effort: 'low' }
  ),
  () => agent(
    `Run: git -C ${workDir} diff --name-only origin/${worktreeResult.baseBranch}...HEAD\nReturn ONLY the raw output (one file path per line, no extra text).`,
    { label: 'changed-files', phase: 'Review', model: 'haiku', effort: 'low' }
  ),
])
const reviewDiff = accumulatedDiff || 'diff unavailable'

// Truncated diff for security agent — full diff can be 8k-15k lines; security needs patterns not volume
const reviewDiffLines = reviewDiff.split('\n')
const securityDiff = reviewDiffLines.length > 2500
  ? reviewDiffLines.slice(0, 2500).join('\n') + `\n\n[...diff truncated at 2500/${reviewDiffLines.length} lines for security review]`
  : reviewDiff

// Split diff into per-file chunks, then sub-chunk by hunk boundary
const fileDiffs = splitDiffByFile(reviewDiff)
const reviewChunks = fileDiffs.flatMap(fd => splitFileIntoChunks(fd, 300))
log(`Review: ${fileDiffs.length} file(s) → ${reviewChunks.length} chunk(s)`)

const toolbeltReviewRules = toolbelt ? [
  ...(toolbelt.forbiddenPatterns || []).map(p => `FORBIDDEN: ${p}`),
  ...(toolbelt.requiredPatterns  || []).map(p => `REQUIRED: ${p}`),
  ...(toolbelt.namingRules       || []).map(r => `NAMING: ${r}`),
].join('\n') : ''

// Fan-out: Haiku reviews each chunk, batched at 6 to avoid rate-limit stalls on large diffs
const reviewBlockStart = budget.spent()
const runChunkReviews = async () => {
  const allChunkResults = []
  for (let i = 0; i < reviewChunks.length; i += 6) {
    const batch = reviewChunks.slice(i, i + 6)
    const batchResults = await parallel(batch.map((chunk, batchIdx) => () =>
      agent(
        `Review this diff chunk for: logic bugs, missing null checks, wrong assumptions, and convention violations.
Flag only real issues. Include exact file and line for each finding.

${toolbeltReviewRules ? `REPO CONVENTIONS:\n${toolbeltReviewRules}\n` : ''}
DIFF CHUNK ${i + batchIdx + 1}/${reviewChunks.length}:
${chunk}`,
        { label: `file-review-${i + batchIdx + 1}`, phase: 'Review', model: 'haiku', effort: 'low', schema: CODE_REVIEW_SCHEMA }
      )
    ))
    allChunkResults.push(...batchResults)
  }
  return allChunkResults
}

// Pre-filter: find files touched outside the plan's declared file list
const plannedFileSet = new Set(allTasks.flatMap(t => t.files || []))
const actualChangedFiles = (changedFilesList || '').split('\n').map(f => f.trim()).filter(Boolean)
const unplannedFiles = actualChangedFiles.filter(f => !plannedFileSet.has(f))
log(`Scope drift pre-filter: ${actualChangedFiles.length} files changed, ${unplannedFiles.length} unplanned`)

const [chunkReviews, specComplianceResult, securityResult, scopeDriftResult] = await parallel([
  runChunkReviews,
  () => agent(
    `You are a spec compliance reviewer. Answer: did the implementation match the plan?
Do NOT look at raw diffs — compare the task descriptions against what the commit log and diff stat show.

PLAN TASKS:
${allTasks.map(t => `${t.id}: ${t.title}\n  ${t.acceptanceCriteria.map(c => `- ${c}`).join('\n  ')}`).join('\n\n')}

DIFF STAT:
${diffSummary || 'unavailable'}

COMMIT LOG:
${commitLog || 'unavailable'}

Flag only genuine spec gaps — tasks that appear unaddressed or implemented differently than described.`,
    { label: 'spec-compliance', phase: 'Review', model: 'sonnet', effort: 'high', schema: CODE_REVIEW_SCHEMA }
  ),
  () => agent(
    `REPO: ${workDir}
TASK_COUNT: ${allTasks.length}
FILES_CHANGED:
${allTasks.flatMap(t => t.files).join('\n')}

DIFF:
${securityDiff}`,
    { label: 'security-review', phase: 'Review', model: 'sonnet', effort: 'high', schema: SECURITY_SCHEMA, agentType: 'hp-security' }
  ),
  () => {
    if (unplannedFiles.length === 0) {
      return Promise.resolve({ verdict: 'CLEAN', changes: [], suggestedTickets: [] })
    }
    // Build targeted diff for only the unplanned files — keeps context small
    const unplannedDiff = splitDiffByFile(accumulatedDiff || '')
      .filter(chunk => unplannedFiles.some(f => chunk.includes(f)))
      .join('\n')
    return agent(
      `You are a scope drift reviewer for harness-implement. Do not use any tools.

PLANNED FILES (from the approved plan — changes to these are expected):
${[...plannedFileSet].join('\n')}

UNPLANNED FILES (touched but not in the plan — assess each one):
${unplannedFiles.join('\n')}

DIFF OF UNPLANNED FILES ONLY:
${unplannedDiff.slice(0, 4000) || '(diff unavailable — assess from file names only)'}

PLAN TASKS (for context on what was asked):
${allTasks.map(t => `${t.id}: ${t.title}`).join('\n')}

For each unplanned file, classify it as:
  necessary  — had to be touched to complete the planned work (e.g. shared type file, auto-generated index)
  drift      — scope creep: real work that should have been planned but wasn't (belongs in a follow-up)
  follow-up  — new capability or refactor discovered during implementation; warrants its own ticket

For each "drift" or "follow-up" file, add a suggested Jira ticket title to suggestedTickets[].

verdict:
  CLEAN      — all unplanned files are "necessary"
  DRIFT      — at least one file is "drift" (unplanned but should have been planned)
  FOLLOW_UP  — at least one file is "follow-up" (new work surfaced during implementation)

Return SCOPE_DRIFT_SCHEMA.`,
      { label: 'scope-drift', phase: 'Review', model: 'sonnet', effort: 'medium', schema: SCOPE_DRIFT_SCHEMA }
    )
  },
])
tokensByModel.haiku  += Math.round((budget.spent() - reviewBlockStart) * 0.4)
tokensByModel.sonnet += Math.round((budget.spent() - reviewBlockStart) * 0.6)

// Merge all chunk findings into one list
const allChunkFindings = (chunkReviews || []).filter(Boolean).flatMap(r => r.findings || [])
const specFindings = specComplianceResult?.findings || []
const codeReviewResult = { findings: [...allChunkFindings, ...specFindings] }

// Critical findings: one targeted fix pass
const criticalFindings = codeReviewResult.findings.filter(f => f.severity === 'critical')
const codeReviewFixes = []

if (criticalFindings.length > 0) {
  log(`Code review: ${criticalFindings.length} critical finding(s) — fixing`)
  const fixBlockStart = budget.spent()
  const fixReports = (await parallel(criticalFindings.map(item => () =>
    agent(
      `REPO: ${workDir}
Targeted post-review fix — no TDD required.
FILE: ${item.file}
ISSUE: ${item.issue}
CHANGE: ${item.suggestion}
Touch ONLY this file. Minimal change. Return under 100 words with file:line.`,
      { label: `fix-${(item.file || '').replace(/[^a-z0-9]/gi, '-').slice(-20)}`, phase: 'Review', model: 'sonnet', effort: 'high', agentType: 'hi-developer' }
    )
  ))).filter(Boolean)
  tokensByModel.sonnet += budget.spent() - fixBlockStart

  if (fixReports.length > 0) {
    await trackedAgent(
      `Commit fixes.\nREPO: ${workDir}\n1. git -C ${workDir} add -A\n2. git -C ${workDir} commit -m "${planKey} fix: apply ${fixReports.length} code review correction(s)"\nReturn commit hash or "NOTHING_TO_COMMIT".`,
      { label: 'fix-commit', phase: 'Review', model: 'haiku', effort: 'low' }
    )
    codeReviewFixes.push(...criticalFindings.map((f, i) => ({ ...f, report: fixReports[i] || null })))

    // Re-review only the fixed files — not the full diff again
    const fixedFiles = [...new Set(criticalFindings.map(f => f.file).filter(Boolean))]
    log(`Re-reviewing ${fixedFiles.length} fixed file(s)`)
    const reReviewResults = []
    for (let i = 0; i < fixedFiles.length; i += 6) {
      const batch = fixedFiles.slice(i, i + 6)
      const batchResults = await parallel(batch.map(file => async () => {
        const fileDiff = await agent(
          `Run: git -C ${workDir} diff HEAD~1 -- ${file}\nReturn ONLY the raw diff output.`,
          { label: `recheck-diff-${file.replace(/[^a-z0-9]/gi, '-').slice(-20)}`, phase: 'Review', model: 'haiku', effort: 'low' }
        )
        if (!fileDiff) return null
        const chunks = splitFileIntoChunks(fileDiff, 300)
        const chunkResults = await parallel(chunks.map((chunk, idx) => () =>
          agent(
            `Re-review after fix. Confirm the critical issue is resolved and no new issues introduced.
FILE: ${file}
${toolbeltReviewRules ? `REPO CONVENTIONS:\n${toolbeltReviewRules}\n` : ''}
DIFF:
${chunk}`,
            { label: `recheck-${file.replace(/[^a-z0-9]/gi, '-').slice(-20)}-${idx}`, phase: 'Review', model: 'haiku', effort: 'low', schema: CODE_REVIEW_SCHEMA }
          )
        ))
        return chunkResults.filter(Boolean).flatMap(r => r.findings || [])
      }))
      reReviewResults.push(...batchResults)
    }
    const reReviewFindings = reReviewResults.filter(Boolean).flat()
    if (reReviewFindings.length > 0) {
      log(`Re-review: ${reReviewFindings.length} remaining finding(s) after fixes`)
      codeReviewResult.findings.push(...reReviewFindings)
    } else {
      log('Re-review: all critical fixes verified clean')
    }
  }
}

// Post-commit verification — confirm changes are actually committed
const postCommitCheck = await agent(
  `Run: git -C ${workDir} show --stat HEAD\nReturn ONLY the raw output.`,
  { label: 'verify-commit', phase: 'Review', model: 'haiku', effort: 'low' }
)
if (postCommitCheck) {
  log(`Commit verified: ${postCommitCheck.split('\n').slice(-2).join(' ').trim()}`)
} else {
  log(`Warning: could not verify commit — git show returned empty`)
}

// ─── Stage 6: Return ──────────────────────────────────────────────────────────
// diff-stat and commit-log already fetched in Review phase — reused here.

trackPhase('Return')

const prBody = await trackedAgent(
  `Write a concise GitHub PR body (under 200 words).
TITLE: ${planData.prTitle}
PLAN: ${args.planPath}
TASKS: ${allTasks.map(t => t.title).join(', ')}
TESTS: ${verifyResult?.summary || 'not run'}
SECURITY: ${securityResult?.status || 'not run'}
DIFF:
${diffSummary || 'unavailable'}
Format: one paragraph + bullet list of key changes. No headers.`,
  { label: 'pr-body', phase: 'Return', model: 'haiku', effort: 'low' }
)

// ─── Debrief ──────────────────────────────────────────────────────────────────

const passed = implementationReports.filter(r => r.handoff?.status === 'DONE' || r.qaResult?.status === 'PASS')
const blocked = implementationReports.filter(r => r.handoff?.status === 'NEEDS_CONTEXT' || r.qaResult?.status === 'NEEDS_CONTEXT')

const debrief = `# harness-implement debrief: ${planData.prTitle}

**Plan:** ${args.planPath}
**Branch:** ${worktreeResult.branch}
**Base:** ${worktreeResult.baseBranch}

---

## Metrics

| | |
|---|---|
| Tasks total | ${implementationReports.length} |
| Tasks passed QA | ${passed.length} |
| Tasks blocked | ${blocked.length} |
| QA redispatches | 0 |
| Critical code review findings | ${criticalFindings.length} |
| Code review fixes applied | ${codeReviewFixes.length} |
| Security status | ${securityResult?.status || 'not run'} |
| Tests passed | ${verifyResult?.testsPassed ?? 'unknown'} |
| Type check | ${verifyResult?.typeCheckPassed ? 'clean' : 'errors'} |

---

## Tasks

${implementationReports.map(r => {
  const status = r.handoff?.status || r.qaResult?.status || 'UNKNOWN'
  const crCritical = (r.codeReview?.findings || []).filter(f => f.severity === 'critical').length
  const crNote = crCritical > 0 ? ` | ${crCritical} critical finding(s)` : ''
  const caveat = r.handoff?.caveats ? ` — ${r.handoff.caveats}` : ''
  return `- **${r.task.id}** ${r.task.title}: **${status}**${crNote}${caveat}`
}).join('\n')}

---

## Issues

### Blocked Tasks
${blocked.length > 0
  ? blocked.map(r => `- **${r.task.id}** ${r.task.title}\n  ${r.handoff?.caveats || r.qaResult?.status || 'NEEDS_CONTEXT'}`).join('\n')
  : 'None.'}

### Code Review (post-implement)
${(codeReviewResult?.findings || []).length === 0
  ? 'No findings.'
  : `${(codeReviewResult.findings).length} findings (${criticalFindings.length} critical, ${(codeReviewResult.findings).filter(f => f.severity === 'major').length} major, ${(codeReviewResult.findings).filter(f => f.severity === 'minor').length} minor)${codeReviewFixes.length > 0 ? `\nFixed: ${codeReviewFixes.map(f => f.file + ': ' + f.issue).join('; ')}` : ''}${criticalFindings.length > codeReviewFixes.length ? `\nUnfixed critical:\n${criticalFindings.slice(codeReviewFixes.length).map(f => `- ${f.file}: ${f.issue}`).join('\n')}` : ''}`}

### Security
${securityResult
  ? `**${securityResult.status}**\n${(securityResult.findings || []).filter(f => f.severity !== 'minor').map(f => `- ${f.owasp}: ${f.issue}`).join('\n') || 'No critical/major findings.'}`
  : 'Not run.'}

### Scope Drift
${!scopeDriftResult || scopeDriftResult.verdict === 'CLEAN'
  ? 'None detected.'
  : `**${scopeDriftResult.verdict}** — ${unplannedFiles.length} unplanned file(s)\n` +
    (scopeDriftResult.changes || []).filter(c => c.classification !== 'necessary').map(c =>
      `- \`${c.file}\` [${c.classification}]: ${c.reason}`
    ).join('\n') +
    (scopeDriftResult.suggestedTickets?.length > 0
      ? '\n\n**Suggested follow-up tickets:**\n' + scopeDriftResult.suggestedTickets.map(t => `- ${t.title}: ${t.rationale}`).join('\n')
      : '')}

### Tests
${verifyResult?.testsOutput ? `\`\`\`\n${verifyResult.testsOutput.split('\n').slice(-8).join('\n')}\n\`\`\`` : 'Not run.'}
Type check: ${verifyResult?.typeCheckOutput || 'not run'}

---

## Diff

\`\`\`
${diffSummary || 'unavailable'}
\`\`\`

## Commits

\`\`\`
${commitLog || 'none'}
\`\`\`

---

## Next Steps

${verifyResult?.testsPassed === false ? '- [ ] Fix failing tests\n' : ''}${verifyResult?.typeCheckPassed === false ? '- [ ] Fix type errors\n' : ''}${securityResult?.status === 'FAIL' ? '- [ ] Review security findings\n' : ''}${blocked.length > 0 ? `- [ ] Investigate ${blocked.length} blocked task(s)\n` : ''}- [ ] Review diff above
- [ ] \`git push -u origin ${worktreeResult.branch}\`
- [ ] \`gh pr create --title "..." --body "..."\`
`

// ─── Stage 7: Debrief ────────────────────────────────────────────────────────

trackPhase('Debrief')

// ─── Audit JSONL ──────────────────────────────────────────────────────────────

// Audit verdict checklist — COMPLETE only when all gates pass
// FAILED: nothing implemented (all blocked or verify never ran)
// PARTIAL: some tasks done but blockers, test failures, type errors, or unfixed critical findings
// COMPLETE: all tasks DONE, tests pass, types clean, no unfixed critical findings
const hasUnfixedCritical = criticalFindings.length > codeReviewFixes.length
const allTasksDone = implementationReports.length > 0 && blocked.length === 0
const runStatus = !allTasksDone && implementationReports.length === 0
  ? 'FAILED'
  : (blocked.length > 0
    || verifyResult?.testsPassed === false
    || verifyResult?.typeCheckPassed === false
    || hasUnfixedCritical
    || securityResult?.status === 'FAIL')
    ? 'PARTIAL'
    : 'COMPLETE'

const outputTokensTotal = budget.spent() - workflowStartTokens
const sonnetCost = (tokensByModel.sonnet / 1_000_000) * 15
const haikuCost  = (tokensByModel.haiku  / 1_000_000) * 1.25
const opusCost   = (tokensByModel.opus   / 1_000_000) * 75
const outputCostUsd = sonnetCost + haikuCost + opusCost
// Input tokens not tracked; apply 2.5x multiplier as mid-range estimate
// (input rates ~1/5 output rates, typical input volume ~4-6x output tokens)
const estimatedCostUsd = parseFloat((outputCostUsd * 2.5).toFixed(4))

const auditRecord = JSON.stringify({
  ts: args.today || 'unknown',
  skill: 'harness-implement',
  skillsSchemaVersion: SKILLS_SCHEMA_VERSION,
  status: runStatus,
  repo: _repoNameFromPath(args.repoPath),
  repoPath: args.repoPath || null,
  branch: worktreeResult.branch,
  planPath: args.planPath,
  planKey,
  tasksTotal: implementationReports.length,
  tasksPassed: passed.length,
  tasksBlocked: blocked.length,
  criticalFindings: criticalFindings.length,
  codeReviewFixesApplied: codeReviewFixes.length,
  testsPassed: verifyResult?.testsPassed ?? null,
  typeCheckPassed: verifyResult?.typeCheckPassed ?? null,
  securityStatus: securityResult?.status || null,
  scopeDrift: {
    verdict: scopeDriftResult?.verdict || 'CLEAN',
    unplannedFileCount: unplannedFiles.length,
    suggestedTickets: scopeDriftResult?.suggestedTickets || [],
  },
  outputTokensByModel: tokensByModel,
  outputTokensTotal,
  estimatedCostUsd,
  costNote: 'estimated total: output cost × 2.5 (input tokens not tracked; input rates ~1/5 of output rates, typical input volume ~4-6x output). Verify on Anthropic usage dashboard.',
  blockedDetails: blocked.map(r => ({ id: r.task.id, reason: r.handoff?.caveats || 'NEEDS_CONTEXT' })),
  recommendations: [
    'plan quality: no redispatches — descriptions are self-contained',
    ...(verifyResult?.testsPassed === false ? ['failing tests after implement — check TDD evidence in task reports'] : []),
    ...(verifyResult?.typeCheckPassed === false ? ['type errors present — run npx tsc --noEmit to see details'] : []),
    ...(hasUnfixedCritical ? [`${criticalFindings.length - codeReviewFixes.length} unfixed critical finding(s) — must resolve before merge`] : criticalFindings.length > 0 ? [`${criticalFindings.length} critical finding(s) applied as fixes`] : []),
    ...(securityResult?.status === 'FAIL' ? ['security FAIL — review findings before merge'] : []),
    ...(blocked.length > 0 ? [`${blocked.length} blocked task(s) — re-run harness-plan for missing context`] : []),
  ],
})

// If crash handler already set _telemetryPath, reuse it; otherwise build from planPath
if (!_telemetryPath) {
  const issueKey = (args.planPath || '').match(/\b([A-Z]+-\d+)\b/i)?.[1] || null
  _telemetryPath = _buildImplTelemetryPath({ repoPath: args.repoPath, issueKey, rawText: args.planPath, timestamp: null })
}
const _legacyCmd    = `echo '${auditRecord.replace(/'/g, "'\\''")}' >> ~/.claude/harness-implement-runs.jsonl`
const _telemetryCmd = `mkdir -p "$(dirname '${_telemetryPath}')" && echo '${auditRecord.replace(/'/g, "'\\''")}' >> '${_telemetryPath}'`

await agent(
  `Append an audit record to two JSONL files. Use the Bash tool only. Run both commands:\n1. ${_legacyCmd}\n2. ${_telemetryCmd}\nReturn { appended: true }.`,
  { label: 'audit-write', phase: 'Debrief', model: 'haiku', effort: 'low',
    schema: { type: 'object', required: ['appended'], properties: { appended: { type: 'boolean' } } },
  }
)
auditWritten = true

// ─── CLI Summary ──────────────────────────────────────────────────────────────

const implIcon = runStatus === 'COMPLETE' ? '✅' : runStatus === 'PARTIAL' ? '⚠️' : '❌'

const taskLines = implementationReports.map(r => {
  const s = r.handoff?.status || r.qaResult?.status || 'UNKNOWN'
  const icon = s === 'DONE' || s === 'PASS' ? '  ✅' : '  ❌'
  return `${icon} ${r.task.id}  ${r.task.title}`
}).join('\n')

const blockedLines = blocked.length > 0
  ? `\n  blocked:\n${blocked.map(r => `  ❌ ${r.task.id}: ${r.handoff?.caveats || 'NEEDS_CONTEXT'}`).join('\n')}`
  : ''

const testsIcon = verifyResult?.testsPassed === true ? '✅' : verifyResult?.testsPassed === false ? '❌' : '—'
const typesIcon = verifyResult?.typeCheckPassed === true ? '✅' : verifyResult?.typeCheckPassed === false ? '❌' : '—'
const secIcon   = securityResult?.status === 'PASS' ? '✅' : securityResult?.status === 'FAIL' ? '❌' : securityResult?.status === 'PASS_WITH_NOTES' ? '⚠️' : '—'
const crFindings = (codeReviewResult?.findings || []).length
const crIcon    = criticalFindings.length > 0 ? '❌' : crFindings > 0 ? '⚠️' : '✅'

const tokenSonnet = tokensByModel.sonnet || 0
const tokenHaiku  = tokensByModel.haiku  || 0
const tokenOpus   = tokensByModel.opus   || 0

const planSlugForDisplay = (() => {
  const m = (args.planPath || '').match(/\b([A-Z]+-\d+)\b/)
  if (m) return m[1]
  return (args.planPath || '').split('/').pop()?.replace(/\.json$/, '') || 'unknown'
})()

const totalAgents = Object.values(agentCountByModel).reduce((a,b)=>a+b,0)
const agentMetricsLines = Object.entries(agentCountByModel)
  .filter(([,c]) => c > 0)
  .map(([m, c]) => {
    const label = m.includes('opus') ? 'opus  ' : m.includes('haiku') ? 'haiku ' : 'sonnet'
    const tok = (tokensByModel[m] || 0).toLocaleString()
    return `    ${label}  (×${c})  ${tok} tok`
  }).join('\n')
const implSize = planData?.tasks?.length <= 2 ? 'XS' : planData?.tasks?.length <= 5 ? 'S' : planData?.tasks?.length <= 10 ? 'M' : 'L'

const cliSummary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
harness-implement
  status:  ${runStatus}  ${implIcon}

  ticket:  ${planSlugForDisplay}
  size:    ${implSize}
  agents:  ${totalAgents}
${agentMetricsLines}
  cost:    ~$${estimatedCostUsd}

  tasks: ${passed.length}/${implementationReports.length} passed    blocks: ${blocked.length}
  tests: ${verifyResult?.testsPassed === true ? 'PASS' : verifyResult?.testsPassed === false ? 'FAIL' : 'not run'}    types: ${verifyResult?.typeCheckPassed === true ? 'clean' : verifyResult?.typeCheckPassed === false ? 'errors' : 'not run'}    security: ${securityResult?.status || 'not run'}
${taskLines}${blockedLines}

  quality: ${criticalFindings.length > 0 ? `${criticalFindings.length} critical finding(s)` : crFindings > 0 ? `${crFindings} finding(s)` : '✓ clean'}${crFindings > 0 ? '\n' + (codeReviewResult?.findings || []).map(f => `    ${f.severity === 'critical' ? '❌' : f.severity === 'major' ? '⚠️' : '·'} ${f.file}:${f.line || '?'}  ${f.issue}`).join('\n') : ''}
  drift:   ${!scopeDriftResult || scopeDriftResult.verdict === 'CLEAN' ? '✓ none' : `${scopeDriftResult.verdict} — ${unplannedFiles.length} unplanned file(s)${scopeDriftResult.suggestedTickets?.length > 0 ? '\n' + scopeDriftResult.suggestedTickets.map(t => `    · follow-up: ${t.title}`).join('\n') : ''}`}
  next:    git push -u origin ${worktreeResult.branch} && gh pr create
  audit:   ~/.claude/harness-implement-runs.jsonl
           ~/Desktop/Repos/harness-telemetry/logs/  (run-specific file)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

log(cliSummary)

return {
  prTitle: planData.prTitle,
  prBody: prBody || '',
  debrief,
  diffSummary: diffSummary || '',
  filesChanged: allTasks.flatMap(t => t.files),
  worktreePath: workDir,
  baseBranch: worktreeResult.baseBranch,
  branch: worktreeResult.branch,
  status: runStatus.toLowerCase(),
  cliSummary,
}

} catch (err) {
  if (!auditWritten) {
    const isKilled = err.message?.includes('abort') || err.message?.includes('cancel') || err.message?.includes('interrupt')
    const crashStatus = isKilled
      ? 'CRASHED'
      : ['Implement', 'Verify', 'Review', 'Return', 'Debrief'].includes(currentPhase) ? 'PARTIAL' : 'FAILED'
    await writeAuditRecord(crashStatus, {
      planKey: partialState.planKey || 'unknown',
      branch: partialState.branch || null,
      failedAtPhase: currentPhase,
      error: err.message || String(err),
      tasksTotal: partialState.tasksTotal || 0,
      tasksPassed: 0,
      tasksBlocked: 0,
      criticalFindings: 0,
      codeReviewFixesApplied: 0,
      testsPassed: null,
      typeCheckPassed: null,
      securityStatus: null,
      blockedDetails: [],
      recommendations: [`failed at phase: ${currentPhase} — ${err.message || String(err)}`],
    }).catch(() => {})
  }
  throw err
}
