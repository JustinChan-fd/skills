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

/** Compile the named inline function plus its inline dependencies, and return it. */
function loadInline(name, deps = []) {
  const parts = [...deps, name].map(n => {
    const fn = extractFn(WORKFLOW_SRC, n)
    assert.ok(fn, `workflow.js has no inline function ${n}() — the mirror is missing, not merely drifted`)
    return fn
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
