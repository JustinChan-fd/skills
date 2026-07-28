// Guards the inline-mirror pattern itself.
//
// Workflow scripts cannot `import` (probe-confirmed), so every pure function in lib/ is
// duplicated verbatim into workflow.js's PURE block. lib/ is what the unit tests exercise;
// workflow.js is what actually runs. When the two drift, the suite stays green while
// production does something else — which is exactly how buildTelemetryPath pointed at a
// `logs/` directory that has never existed on disk, for the entire bridge era, with a
// passing assertion. It survived because the lib copy had zero callers.
//
// These tests read workflow.js as TEXT and compare behaviour, so drift fails the suite
// rather than waiting for a run to notice.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildTelemetryPath, deriveTelemetryDir, repoNameFromPath, slugFromInput } from './telemetry.js'
import { buildWriteAgentPrompt, buildDurationPatchCmd } from './telemetry-write.js'
import { validateV2Record, classifyV2Record, pendingFieldsFor, REQUIRED_V2_KEYS } from './telemetry-validate.js'
import { deriveIssueKey } from './manifest-entry.js'
import { selectSizingSource } from './sizing-source.js'
import { selectDecomposeStrategy } from './decompose-strategy.js'
import { splitOversizedTasks, FILE_CAP } from './split-oversized.js'
import { reconcileTitleCounts, COUNT_RE, fileCountSummary } from './title-counts.js'

const WORKFLOW_SRC = readFileSync(new URL('../workflow.js', import.meta.url), 'utf8')

/**
 * Slice a top-level `function name(...) {...}` out of source text.
 *
 * The parameter list is walked by paren depth FIRST — these functions take a destructured
 * object, so brace-matching from the signature would stop at the param object's own `}`
 * and yield only a fragment. Only then does brace matching begin, at the body's `{`.
 * Adequate for the PURE block (no unbalanced braces inside its strings); returns null if
 * the function is absent, which is itself a drift finding.
 */
function extractFn(src, name) {
  const m = src.match(new RegExp(`function ${name}\\s*\\(`))
  if (!m) return null
  let i = m.index + m[0].length - 1   // at the opening paren
  let parens = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++
    else if (src[i] === ')' && --parens === 0) { i++; break }
  }
  const open = src.indexOf('{', i)
  if (open === -1) return null
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1)
  }
  return null
}

/**
 * Slice a top-level `const NAME = <literal>` out of source text.
 *
 * The validator's mirror is not all functions — REQUIRED_V2_KEYS, OUTCOME_FOR_STATUS,
 * DASH_FIELDS and STUB_KEY_FLOOR are consts, and extractFn cannot see them. Balances
 * whatever bracket the initialiser opens with; for a scalar (`= 20`) it takes the line.
 */
function extractConst(src, name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*`))
  if (!m) return null
  const start = m.index + m[0].length
  const open = src[start]
  const close = { '[': ']', '{': '}', '(': ')' }[open]
  if (!close) {
    const eol = src.indexOf('\n', start)
    return src.slice(m.index, eol === -1 ? src.length : eol)
  }
  let depth = 0
  for (let j = start; j < src.length; j++) {
    if (src[j] === open) depth++
    else if (src[j] === close && --depth === 0) return src.slice(m.index, j + 1)
  }
  return null
}

/**
 * Compile the named inline declaration plus its inline dependencies, and return it.
 *
 * A dependency may be a function or a const; both are tried, because the caller should not
 * have to know which form the mirror happens to use.
 */
function loadInline(name, deps = []) {
  const parts = [...deps, name].map(n => {
    const decl = extractFn(WORKFLOW_SRC, n) || extractConst(WORKFLOW_SRC, n)
    assert.ok(decl, `workflow.js has no inline ${n} — the mirror is missing, not merely drifted`)
    return decl
  })
  return new Function(`${parts.join('\n')}\nreturn ${name}`)()
}

const CASES = [
  { repoPath: '/Users/me/Desktop/Repos/webtarsthree', skill: 'harness-plan', issueKey: 'TARS-1271', timestamp: '20260724T183042Z' },
  { repoPath: '/Users/me/Desktop/Repos/catalog-ui-management', skill: 'harness-plan', issueKey: 'MC-1077', timestamp: '20260728T011109Z' },
  // A conductor worktree: strips the same way, so both runs land in one telemetry dir.
  { repoPath: '/Users/me/Desktop/Repos/wt-TARS-1271-20260727T194141Z', skill: 'harness-plan', issueKey: 'TARS-1271', timestamp: '20260727T194141Z', repoName: 'webtarsthree' },
  // No issue key — both sides must fall back through slugFromInput identically.
  { repoPath: '/Users/me/Desktop/Repos/myapp', skill: 'harness-plan', issueKey: null, rawText: 'Add dark mode to the dashboard', timestamp: '20260101T000000Z' },
  { repoPath: '/Users/me/Desktop/Repos/myapp', skill: 'harness-plan', issueKey: null, rawText: null, timestamp: '20260101T000000Z' },
  // Degenerate repoPath — the homeDir regex does not match, so both must hit the /tmp branch.
  { repoPath: '/elsewhere/checkout', skill: 'harness-plan', issueKey: 'X-1', timestamp: 'ts' },
]

test('inline _buildTelemetryPath is byte-identical to lib buildTelemetryPath', () => {
  const inline = loadInline('_buildTelemetryPath', ['_repoNameFromPath', '_slugFromInput', '_deriveTelemetryDir'])
  for (const c of CASES) {
    assert.equal(inline(c), buildTelemetryPath(c), `mirror drift for ${JSON.stringify(c)}`)
  }
})

test('inline _deriveTelemetryDir is byte-identical to lib deriveTelemetryDir', () => {
  const inline = loadInline('_deriveTelemetryDir')
  for (const p of ['/Users/me/Desktop/Repos/webtarsthree', '/Users/me/Desktop/Repos/wt-x/', '/elsewhere/checkout', '', null]) {
    assert.equal(inline(p), deriveTelemetryDir(p), `mirror drift for repoPath ${p}`)
  }
})

test('inline _repoNameFromPath and _slugFromInput match their lib originals', () => {
  const inlineRepo = loadInline('_repoNameFromPath')
  const inlineSlug = loadInline('_slugFromInput')
  for (const p of ['/a/b/webtarsthree', '/a/b/my-repo/', '', null]) assert.equal(inlineRepo(p), repoNameFromPath(p))
  for (const t of ['Add payment gateway support', '  Migrate auth layer! (critical)\nmore', '', null, '   \n  \n']) {
    assert.equal(inlineSlug(t), slugFromInput(t))
  }
})

test('every telemetry path the workflow can build lands in v2/, never logs/', () => {
  const inline = loadInline('_buildTelemetryPath', ['_repoNameFromPath', '_slugFromInput', '_deriveTelemetryDir'])
  for (const c of CASES) {
    const p = inline(c)
    assert.ok(p.includes('/harness-telemetry/v2/'), `not a dashboard-visible path: ${p}`)
    assert.ok(!p.includes('/logs/'), `legacy dir: ${p}`)
  }
})

// ── The write helpers (Phase 1a) ──────────────────────────────────────────────
//
// These two are more drift-prone than the path builders: they are long template literals
// whose text IS the contract with the write agent. A silent divergence means the tested
// prompt and the shipped prompt are different documents.

test('inline _buildDurationPatchCmd is byte-identical to lib buildDurationPatchCmd', () => {
  const inline = loadInline('_buildDurationPatchCmd')
  for (const [p, ts] of [['/t/v2/a.jsonl', '1769500000000'], ['/t/v2/a.jsonl', null], ['/t/v2/a.jsonl', '']]) {
    assert.equal(inline(p, ts), buildDurationPatchCmd(p, ts), `mirror drift for (${p}, ${ts})`)
  }
})

test('inline _buildWriteAgentPrompt is byte-identical to lib buildWriteAgentPrompt', () => {
  const inline = loadInline('_buildWriteAgentPrompt', ['_buildDurationPatchCmd'])
  const rec = { schemaVersion: '2.0', skill: 'x', status: 'COMPLETE' }
  const cases = [
    { telemetryPath: '/t/v2/a.jsonl', records: [rec], startTs: '1769500000000' },
    { telemetryPath: '/t/v2/a.jsonl', records: [rec], startTs: null },
    { telemetryPath: '/t/v2/a.jsonl', records: [rec, { ...rec, status: 'FAILED' }], startTs: '1' },
    // A single record passed unwrapped, and a list with holes — both normalize the same way.
    { telemetryPath: '/t/v2/a.jsonl', records: rec, startTs: '1' },
    { telemetryPath: '/t/v2/a.jsonl', records: [rec, null, undefined], startTs: '1' },
    // Hostile payload: must be inert on both sides, identically.
    { telemetryPath: '/t/v2/a.jsonl', records: [{ ...rec, e: `$(id) \`whoami\` 'q'` }], startTs: '1' },
  ]
  for (const c of cases) {
    assert.equal(inline(c), buildWriteAgentPrompt(c), `mirror drift for ${JSON.stringify(c).slice(0, 80)}`)
  }
})

// ── The validator (Phase 1e) ──────────────────────────────────────────────────
//
// The validator is what turns "did this stage run?" from an inference into an assertion, so
// a drifted mirror would mean the shipped run is graded by different rules than the suite.
// REQUIRED_V2_KEYS is the highest-risk piece: a key added to lib/ and not to the mirror
// makes production quietly stop checking it.

/**
 * Fixtures spanning all three states plus the garbage inputs, since a mirror that agrees on
 * clean records and diverges on a stub is the case that matters — a stub is the only input
 * production is guaranteed to see when something has gone wrong.
 */
/** Fixture label for assertion messages. String(undefined) is safe where JSON.stringify is not. */
function label(rec) {
  return String(JSON.stringify(rec)).slice(0, 90)
}

const VALIDATOR_CASES = [
  { schemaVersion: '2.0', runId: 'r', skill: 'harness-intake', skillsSchemaVersion: 'spec-v8', skillsCommit: 'abc', emitTrigger: 'workflow', billingMode: 'api', ts: '2026-07-27', status: 'COMPLETE', outcome: 'success', sourceIssue: 'X-1', repo: 'r', repoPath: '/p', durationMs: 1000, size: 'S', tokens: { total: { output: 10 } }, agentCount: { byModel: {} }, cost: { rateLockedUsd: 0.5 } },
  { schemaVersion: '2.0', runId: 'r', skill: 'harness-intake', skillsSchemaVersion: 'spec-v8', skillsCommit: 'abc', emitTrigger: 'workflow', billingMode: 'api', ts: '2026-07-27', status: 'COMPLETE', outcome: 'success', sourceIssue: 'X-1', repo: 'r', repoPath: '/p', durationMs: null, size: 'S', tokens: { total: { output: null } }, agentCount: { byModel: {} }, cost: { rateLockedUsd: null } },
  { schemaVersion: '2.0', runId: 'r', skill: 'x', status: 'FAILED', outcome: 'success' },
  { runId: 'r', skill: 'harness-plan', outcome: 'success', tokens: { total: { output: null } }, cost: { rateLockedUsd: null } },
  { schemaVersion: '1.0', runId: 'r' },
  { schemaVersion: '2.0', status: 'NOT_A_STATUS', outcome: 'success' },
  { tokens: 'not an object', cost: 42 },
  {}, null, undefined, 'a string', 42, [],
]

test('the inline REQUIRED_V2_KEYS list is identical to lib, in the same order', () => {
  const m = WORKFLOW_SRC.match(/const _REQUIRED_V2_KEYS = \[([\s\S]*?)\]/)
  assert.ok(m, 'workflow.js has no inline _REQUIRED_V2_KEYS — the mirror is missing')
  const inline = new Function(`return [${m[1]}]`)()
  assert.deepEqual(inline, REQUIRED_V2_KEYS)
})

test('inline _validateV2Record agrees with lib validateV2Record on every fixture', () => {
  const inline = loadInline('_validateV2Record', ['_REQUIRED_V2_KEYS', '_OUTCOME_FOR_STATUS'])
  for (const rec of VALIDATOR_CASES) {
    assert.deepEqual(inline(rec), validateV2Record(rec), `mirror drift for ${label(rec)}`)
  }
})

test('inline _classifyV2Record agrees with lib classifyV2Record on every fixture', () => {
  const inline = loadInline('_classifyV2Record', ['_REQUIRED_V2_KEYS', '_OUTCOME_FOR_STATUS', '_DASH_FIELDS', '_STUB_KEY_FLOOR', '_validateV2Record'])
  for (const rec of VALIDATOR_CASES) {
    assert.deepEqual(inline(rec), classifyV2Record(rec), `mirror drift for ${label(rec)}`)
  }
})

test('inline _pendingFieldsFor is byte-identical to lib pendingFieldsFor', () => {
  // This one function decides whether a null field is excused, so drift here silently converts
  // a real dash into a "pending" that never resolves.
  const inline = loadInline('_pendingFieldsFor')
  for (const c of [{ startTs: '1' }, { startTs: 1 }, { startTs: null }, { startTs: '' }, { startTs: 0 }, {}, null, undefined, 'nope', 42]) {
    assert.deepEqual(inline(c), pendingFieldsFor(c), `mirror drift for ${JSON.stringify(c)}`)
  }
})

// ── The issue-key derivation (Jira-gate removal) ──────────────────────────────
//
// This one function decides the filename every telemetry record for the run lands under, and it
// is called from two separate sites in workflow.js. Drift means the record is filed under a
// different key than the tests describe — and the failure is a name nobody can join back to the
// ticket, which reads as a missing record rather than a misfiled one.

test('inline _deriveIssueKey is byte-identical to lib deriveIssueKey', () => {
  const inline = loadInline('_deriveIssueKey', ['_slugFromInput'])
  const cases = [
    { input: 'TARS-1271: migrate the client', entry: { sourceIssue: 'MC-9' } },
    { input: 'Migrate campaigns to clientFetch', entry: { sourceIssue: 'TARS-1271' } },
    { input: 'do work', entry: { jiraKey: 'TARS-1275' } },
    { input: 'do work', entry: { sourceIssue: 'TARS-1271', jiraKey: 'TARS-1275' } },
    { input: 'do work', entry: { id: 'G1-1' } },
    { input: 'Add dark mode to the dashboard', entry: null },
    { input: '', entry: {} },
    { input: null, entry: null },
    {}, null, undefined,
  ]
  for (const c of cases) {
    assert.equal(inline(c), deriveIssueKey(c), `mirror drift for ${JSON.stringify(c)}`)
  }
})

// ── Which subtask, and sized off what ────────────────────────────────────────
//
// These two decide, respectively, how many subtasks a run plans and how big it thinks the one
// it planned is. Both were wrong in the same way before this: they resolved `--intake` against
// `--entry` by preferring the manifest, and both failures are silent — the run completes and
// produces plausible output at the wrong scope. So drift here is not a crash, it is a plan for
// work nobody asked for, which is precisely the kind of bug a mirror test exists to catch.

test('inline selectDecomposeStrategy is byte-identical to the lib version', () => {
  const inline = loadInline('selectDecomposeStrategy')
  const GROUPS = { gatedIntake: { size: 'L', groups: [{ groupId: 'G1', subtasks: [{ id: 'G1-1' }] }] } }
  const cases = [
    [GROUPS, 'L', { id: 'G1-1' }],          // --intake --entry: the case that flipped
    [GROUPS, 'S', { id: 'G1-1' }],
    [GROUPS, 'L', null],                    // --intake alone: fan-out
    [{ gatedIntake: { groups: [] } }, 'L', null],
    [{ gatedIntake: null }, 'M', null],
    [{}, 'L', null], [{}, 'M', null], [{}, 'S', null], [{}, 'XS', null],
    [{}, 'S', { title: 'T1' }],
    [null, 'XS', null], [undefined, undefined, undefined],
  ]
  for (const c of cases) {
    assert.equal(inline(...c), selectDecomposeStrategy(...c), `mirror drift for ${JSON.stringify(c)}`)
  }
})

test('inline _selectSizingSource is byte-identical to lib selectSizingSource', () => {
  const inline = loadInline('_selectSizingSource')
  const GATED = { size: 'L', files: ['a.js', 'b.js', 'c.js'], acList: ['x', 'y'] }
  const cases = [
    [{ gatedIntake: GATED }, { id: 'G1-1', size: 'S', files: ['a.js'] }],   // both: the bug
    [{ gatedIntake: GATED }, { id: 'G1-1', targetSize: 'XS', files: [] }],  // explicit empty scope
    [{ gatedIntake: GATED }, { id: 'G1-1' }],                               // no files key: inherit
    [{ gatedIntake: GATED }, { id: 'G1-1', size: 'M', targetSize: 'XS', files: ['a.js'] }],
    [{ gatedIntake: GATED }, { id: 'G1-1', acList: ['own'] }],
    [{ gatedIntake: GATED }, null],
    [{}, { id: 'G1-1', size: 'S', files: ['a.js'] }],
    [{ gatedIntake: { size: 'M' } }, null],
    [{}, null], [null, null], [undefined, undefined], [{ gatedIntake: null }, null],
  ]
  for (const c of cases) {
    assert.deepEqual(inline(...c), selectSizingSource(...c), `mirror drift for ${JSON.stringify(c)}`)
  }
})

// ── The oversized-task splitter (Phase 3e) ────────────────────────────────────
//
// The most drift-sensitive mirror in this file, because it is the only one that REWRITES the
// artifact rather than describing it. lib/ decides what the tests say a 102-file task becomes;
// workflow.js decides what the architect's output actually becomes. If those disagree, the
// suite proves a splitter that never ran, which is the same failure as the `logs/` path
// assertion — green, and about the wrong copy of the code.
//
// Cases are chosen for the branches most likely to diverge when the mirror is retyped rather
// than regenerated: the inclusive boundary, one directory over cap, many small directories,
// the DONE rewrite in both its substitute and synthesize forms, and past-z ids.

test('the inline _FILE_BUDGET_CAP equals lib FILE_CAP', () => {
  // Three places already hold this number (here, lib/, intake's noOversized text). A mirror
  // with its own cap silently splits at a different threshold than every test asserts.
  const m = WORKFLOW_SRC.match(/const _FILE_BUDGET_CAP\s*=\s*(\d+)/)
  assert.ok(m, 'workflow.js has no _FILE_BUDGET_CAP')
  assert.equal(Number(m[1]), FILE_CAP)
})

const SPLIT_CASES = (() => {
  const base = {
    id: 'T05', title: 'Migrate axios to fetch', description: 'WHAT: x\nWHERE: y\nHOW: ```js\n1\n```\nDONE: z',
    block: 'sequential', groupId: 'G3', tddRequired: true,
  }
  const files = (n, dir) => Array.from({ length: n }, (_, i) => `${dir}/f${i}.js`)
  return [
    // Boundary either side of the inclusive cap, and the fileless shapes.
    [[{ ...base, files: files(8, 'src/client'), acceptanceCriteria: ['no axios remains'] }], 8],
    [[{ ...base, files: files(9, 'src/client'), acceptanceCriteria: ['no axios remains'] }], 8],
    [[{ ...base, files: [], acceptanceCriteria: [] }], 8],
    [[{ ...base }], 8],
    // One directory well over cap → index fallback inside it.
    [[{ ...base, files: files(19, 'src/client'), acceptanceCriteria: ['grep -r "axios" src/ returns nothing'] }], 8],
    // Many small directories → packing.
    [[{ ...base, files: Array.from({ length: 12 }, (_, i) => `src/d${i}/only.js`), acceptanceCriteria: ['grep -r axios src/ is empty'] }], 8],
    // Mixed directory sizes, the realistic shape.
    [[{ ...base, files: [...files(11, 'src/campaigns'), ...files(3, 'src/admin'), ...files(6, 'src/reports')], acceptanceCriteria: ['no axios imports remain'] }], 8],
    // DONE with nothing substitutable → synthesized per-file form.
    [[{ ...base, files: files(6, 'src/a'), acceptanceCriteria: ['no axios imports remain anywhere'] }], 2],
    // No criteria at all, and criteria that are not an array.
    [[{ ...base, files: files(10, 'src/z') }], 4],
    [[{ ...base, files: files(10, 'src/z'), acceptanceCriteria: 'a string' }], 4],
    // Extra fields that must ride along verbatim, plus a parent dependency.
    [[{ ...base, files: files(20, 'src/client'), acceptanceCriteria: ['x'], dependsOn: ['T04'],
        conversionRules: { D: 'return res, not res.data' }, conversionTable: [['axios.get', 'fetch']], snippets: '```js\nfetch(u)\n```' }], 8],
    // Past z, and multiple tasks in one array.
    [[{ ...base, files: files(30, 'src/client'), acceptanceCriteria: ['x'] }], 1],
    [[{ ...base, id: 'T01', files: files(2, 'src/a') }, { ...base, files: files(20, 'src/client'), acceptanceCriteria: ['x'] }], 8],
    // Garbage inputs must be inert identically on both sides.
    [[null], 8], [[], 8], [null, 8], ['tasks', 8], [undefined, undefined],
  ]
})()

test('inline _splitOversizedTasks agrees with lib splitOversizedTasks on every case', () => {
  const inline = loadInline('_splitOversizedTasks', ['_FILE_BUDGET_CAP', '_dirOfPath', '_chunkSuffixFor', '_chunkFilesByDir', '_scopeChunkCriteria'])
  for (const [tasks, cap] of SPLIT_CASES) {
    assert.deepEqual(
      inline(tasks, cap), splitOversizedTasks(tasks, cap),
      // label() rather than raw JSON.stringify: the garbage cases include undefined, which
      // stringifies to undefined and then throws on .slice — a failure in the assertion message
      // that masquerades as a failure in the code under test.
      `mirror drift for cap ${cap} / ${label(tasks)}`
    )
  }
})

test('the inline splitter preserves identity for under-cap tasks, exactly as lib does', () => {
  // deepEqual above cannot see the difference between a passed-through task and a rebuilt clone,
  // and that distinction is asserted in split-oversized.test.js — so it must hold in the mirror
  // too or the two copies differ in a way the comparison is blind to.
  const inline = loadInline('_splitOversizedTasks', ['_FILE_BUDGET_CAP', '_dirOfPath', '_chunkSuffixFor', '_chunkFilesByDir', '_scopeChunkCriteria'])
  const t = { id: 'T1', title: 'x', description: 'd', groupId: 'G1', block: 'sequential', files: ['a/b.js'] }
  assert.equal(inline([t], 8)[0], t, 'the inline splitter rebuilt an under-cap task')
})

test('the splitter is called after the DAG guard and before the revision loop', () => {
  // Order is load-bearing in both directions. After the guard: chunks are disjoint by
  // construction, so running the guard on them would find nothing to do — but running the guard
  // BEFORE the split leaves the parent's own conflicts unexamined. Before the revision loop:
  // failsQualityContract must see the chunk descriptions, or a thin chunk spec ships unrepaired.
  const guard = WORKFLOW_SRC.indexOf('// DAG file-conflict guard')
  const split = WORKFLOW_SRC.indexOf('_splitOversizedTasks(')
  const revision = WORKFLOW_SRC.indexOf('const MAX_REVISIONS')
  assert.ok(guard !== -1, 'DAG guard comment moved — this positional check needs updating')
  assert.ok(revision !== -1, 'revision loop moved — this positional check needs updating')
  const callSite = WORKFLOW_SRC.indexOf('_splitOversizedTasks(', split + 1)
  assert.ok(callSite !== -1, 'no call to _splitOversizedTasks — the mirror exists but nothing invokes it')
  assert.ok(callSite > guard, 'the split runs before the DAG guard')
  assert.ok(callSite < revision, 'the split runs after the revision loop — thin chunk specs would ship unrepaired')
})

test('the split is logged, so an invisible rewrite is impossible', () => {
  // The architect said 1 task and the plan contains 13. Nothing else in the run explains that,
  // so it has to be stated at the point it happens.
  const around = WORKFLOW_SRC.slice(
    WORKFLOW_SRC.indexOf('_splitOversizedTasks(', WORKFLOW_SRC.indexOf('// DAG file-conflict guard')),
  )
  assert.match(around.slice(0, 900), /log\(/, 'the split emits no log line')
})

test('the split result is assigned back onto the task list', () => {
  // The mutant this exists to kill: compute afterSplit, log it, and never assign it. Every other
  // check in this file still passes — the mirror agrees, the call is positioned right, the log
  // fires — and the plan ships with the 102-file task intact. That is the same shape as the
  // `logs/` assertion being green over a function nobody called, so it needs its own assertion.
  const call = WORKFLOW_SRC.indexOf('_splitOversizedTasks(', WORKFLOW_SRC.indexOf('// DAG file-conflict guard'))
  assert.ok(call !== -1, 'no call to _splitOversizedTasks')
  const block = WORKFLOW_SRC.slice(call, WORKFLOW_SRC.indexOf('const MAX_REVISIONS'))
  const assigned = block.match(/^\s*architectResult\.tasks\s*=\s*(\w+)/m)
  assert.ok(assigned, 'the split result is never assigned to architectResult.tasks — the plan keeps the oversized task')
  // And it must be the split output, not a re-assignment of the original.
  assert.match(assigned[1], /split|chunk/i, `assigned from '${assigned[1]}', which is not the split result`)
})

// ── title-counts (task #10) ───────────────────────────────────────────────────────────────────
//
// The reconciler has no lib-level caller — like buildTelemetryPath during the bridge era, whose
// `logs/` assertion stayed green for a whole era precisely because the lib copy was dead. So the
// mirror comparison and the call-site checks below carry the entire weight of "this actually
// runs".

const TITLE_CASES = (() => {
  const files = (n, dir = 'src/client') => Array.from({ length: n }, (_, i) => `${dir}/f${i}.js`)
  return [
    // The T05 shape: a stated 76 against a real 102.
    [[{ id: 'T05', title: 'Migrate all remaining src/client/pages/ source files (~76 files)', files: files(102, 'src/client/pages') }]],
    // Correct count, no count, qualifier words, non-count numbers.
    [[{ id: 'T03', title: 'Migrate src/client/hooks/ (7 source files)', files: files(7) }]],
    [[{ id: 'T01', title: 'Enhance clientFetch with AbortController timeout support', files: files(1) }]],
    [[{ id: 'T06', title: 'Convert 29 MockAdapter test files to vi.fn()', files: files(31) }]],
    [[{ id: 'T08', title: 'Bump axios from 0.21 to 1.6 for API v2', files: files(2) }]],
    // Fileless: the XS fast path, with and without a stated count.
    [[{ id: 'X1', title: 'Do the thing', files: [] }]],
    [[{ id: 'X2', title: 'Migrate the three api helpers (3 files)', files: [] }]],
    [[{ id: 'X3', title: 'No files key (4 files)' }]],
    // Several tasks at once, order and independence.
    [[{ id: 'A', title: 'fine (2 files)', files: files(2) }, { id: 'B', title: 'wrong (5 files)', files: files(9) }]],
    // Garbage must be inert identically on both sides.
    [[null]], [[]], [null], ['tasks'], [undefined],
    [[{ id: 'N', title: undefined, files: files(3) }]],
  ]
})()

/**
 * Index of a CALL to `name`, skipping its own declaration in the PURE block.
 *
 * A bare indexOf finds `function _reconcileTitleCounts…(` — the mirror declaration — which sits
 * before every call site by construction, so a positional check built on it compares the wrong
 * two offsets and reports the code as misordered when it is not.
 */
function callSiteOf(name) {
  const pureEnd = WORKFLOW_SRC.indexOf('// ===== END PURE =====')
  assert.ok(pureEnd !== -1, 'the PURE block end marker moved — these positional checks need updating')
  return WORKFLOW_SRC.indexOf(`${name}(`, pureEnd)
}

test('inline _reconcileTitleCounts agrees with lib reconcileTitleCounts on every case', () => {
  const inline = loadInline('_reconcileTitleCounts', ['_COUNT_RE', '_reconcileTitleCount'])
  for (const [tasks] of TITLE_CASES) {
    assert.deepEqual(
      inline(tasks), reconcileTitleCounts(tasks),
      `mirror drift for ${label(tasks)}`
    )
  }
})

test('inline _reconcileTitleCountsWithReport agrees with lib withReport on every case', () => {
  // The report is what the log line is built from, so drift here means the run states a
  // correction it did not make, or stays silent about one it did.
  const inline = loadInline('_reconcileTitleCountsWithReport', ['_COUNT_RE', '_reconcileTitleCount'])
  for (const [tasks] of TITLE_CASES) {
    assert.deepEqual(
      inline(tasks), reconcileTitleCounts.withReport(tasks),
      `report drift for ${label(tasks)}`
    )
  }
})

test('the inline reconciler preserves identity for correct titles, exactly as lib does', () => {
  // deepEqual cannot distinguish a passed-through task from a rebuilt clone, and identity is
  // asserted in title-counts.test.js — so the mirror must hold it too.
  const inline = loadInline('_reconcileTitleCounts', ['_COUNT_RE', '_reconcileTitleCount'])
  const t = { id: 'T1', title: 'fine (2 files)', files: ['a/b.js', 'a/c.js'] }
  assert.equal(inline([t])[0], t, 'the inline reconciler rebuilt a task whose count was already right')
})

test('the inline _COUNT_RE is not a global regex', () => {
  // A /g regex reused through .test() carries lastIndex between calls, so every second identical
  // check returns false — the reconciler corrects alternating tasks and skips the rest, with a
  // fully green suite. deepEqual over the cases above would not necessarily catch it, because
  // each case builds fresh input.
  const decl = extractConst(WORKFLOW_SRC, '_COUNT_RE')
  assert.ok(decl, 'workflow.js has no inline _COUNT_RE')
  assert.ok(!/\/[a-z]*g[a-z]*\s*$/.test(decl.trim()), `inline _COUNT_RE carries the g flag: ${decl}`)
  assert.equal(COUNT_RE.flags, '', 'lib COUNT_RE gained a flag — the mirror check above assumes none')
})

test('the reconciler is called after the split and before the plan doc is written', () => {
  // Order matters in both directions. After the split, or the parent's stale count is reconciled
  // and then thrown away when the parent is replaced by chunks. Before synthesis, or the
  // synthesizer formats the uncorrected title into the plan document and the correction is
  // invisible where a human reads it.
  const split = WORKFLOW_SRC.indexOf('_splitOversizedTasks(', WORKFLOW_SRC.indexOf('// DAG file-conflict guard'))
  const call = callSiteOf('_reconcileTitleCountsWithReport')
  const synth = WORKFLOW_SRC.indexOf('hp-synthesizer')
  assert.ok(split !== -1, 'split call moved — this positional check needs updating')
  assert.ok(synth !== -1, 'synthesizer label moved — this positional check needs updating')
  assert.ok(call !== -1, 'nothing calls the reconciler — the mirror exists as dead code')
  assert.ok(call > split, 'the reconciler runs before the split, so chunk titles are never checked')
  assert.ok(call < synth, 'the reconciler runs after synthesis, so the plan document keeps the wrong count')
})

test('a corrected count is logged, naming both numbers', () => {
  // This task exists because a number was stated in prose and nothing reconciled it. Correcting
  // it silently just moves the silence: the run must say what it changed and from what.
  const call = callSiteOf('_reconcileTitleCountsWithReport')
  assert.ok(call !== -1, 'nothing calls the reconciler')
  const block = WORKFLOW_SRC.slice(call, call + 900)
  assert.match(block, /log\(/, 'a title correction emits no log line')
  assert.match(block, /\.stated/, 'the log does not name the count the architect stated')
  assert.match(block, /\.actual/, 'the log does not name the real count')
})

test('the reconciled task list is assigned back', () => {
  // The mutant this exists to kill, and it has already happened once in this file's history: the
  // split was computed, logged, and never assigned. Every other check here would still pass.
  const call = callSiteOf('_reconcileTitleCountsWithReport')
  assert.ok(call !== -1, 'nothing calls the reconciler')
  const block = WORKFLOW_SRC.slice(call, call + 900)
  const assigned = block.match(/architectResult\.tasks\s*=\s*([\w.]+)/)
  assert.ok(assigned, 'the reconciled list is never assigned to architectResult.tasks — the wrong count ships')
  // Named for the reconciler's output, not re-assigned from the input. `architectResult.tasks =
  // architectResult.tasks` would satisfy a bare "is assigned" check while changing nothing.
  assert.match(assigned[1], /reconcil/i, `assigned from '${assigned[1]}', which is not the reconciler output`)
  assert.ok(!/^architectResult\.tasks$/.test(assigned[1]), 'the list is re-assigned from itself — the correction is discarded')
})

test('inline _fileCountSummary agrees with lib fileCountSummary on every case', () => {
  const inline = loadInline('_fileCountSummary')
  const cases = [
    [{ id: 'A', files: ['src/a.js', 'src/b.js'] }, { id: 'B', files: ['src/b.js'] }],
    [{ id: 'X', files: [] }, { id: 'Y' }],
    Array.from({ length: 13 }, (_, i) => ({ id: `T05${String.fromCharCode(97 + i)}`, files: [`src/p${i}.js`] })),
    [], null, undefined, 'tasks', [null],
  ]
  for (const tasks of cases) {
    assert.deepEqual(inline(tasks), fileCountSummary(tasks), `mirror drift for ${label(tasks)}`)
  }
})

test('the synthesizer prompt receives the derived counts', () => {
  // The synthesizer writes the Summary paragraph and the Files in Scope table — the numbers a
  // human actually reads. Its prompt passes filesInScope sliced to 20, so without this block it
  // cannot count on any larger plan and can only estimate. That is the T05 defect one stage later.
  const synth = WORKFLOW_SRC.indexOf('hp-synthesizer')
  assert.ok(synth !== -1, 'synthesizer label moved — this check needs updating')
  // The prompt is built above its own options object, so search backwards from the label.
  const promptRegion = WORKFLOW_SRC.slice(WORKFLOW_SRC.lastIndexOf('const planText', 0 + synth), synth)
  assert.match(promptRegion, /_fileCountSummary\(/, 'the synthesizer prompt carries no derived file counts')
  assert.match(promptRegion, /promptBlock/, 'the summary is computed but its rendered block is not interpolated')
})

test('the counts handed to the synthesizer come from the reconciled task list', () => {
  // Not from research.filesInScope: that is a researcher artifact, capped at 20, and unrelated to
  // what the tasks actually claim. Counting the wrong array would restate an estimate as a
  // derivation, which is worse than the estimate.
  const synth = WORKFLOW_SRC.indexOf('hp-synthesizer')
  const call = WORKFLOW_SRC.lastIndexOf('_fileCountSummary(', synth)
  assert.ok(call !== -1, 'no _fileCountSummary call before the synthesizer')
  const arg = WORKFLOW_SRC.slice(call, WORKFLOW_SRC.indexOf(')', call))
  assert.match(arg, /architectResult\.tasks/, `counted from '${arg}' rather than the task list`)
})
