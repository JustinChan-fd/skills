// The python in SKILL.md is what actually patches records. lib/telemetry-patch.js is what the
// unit tests exercise. This file runs the SKILL.md python for real and compares it to the JS,
// so the two cannot disagree.
//
// Without this, fixing telemetry-patch.js fixes nothing: no workflow imports it. The patcher
// that runs is a python heredoc inside a markdown code fence, and a green lib/ suite over an
// unused module is exactly the failure that let buildTelemetryPath assert a `logs/` directory
// which has never existed on disk, for the entire bridge era.
//
// The python is extracted from SKILL.md by locating the `set_nested` definition, so a rename
// there fails these tests rather than silently skipping them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, readFileSync as rf } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPatch, MAP_VALUED_PREFIXES } from './telemetry-patch.js'

const SKILL_MD = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8')

/**
 * Pull the patcher's python body out of the SKILL.md fence.
 *
 * The block is `const patchTelemetryRecord = async (path, fields) => { ... }` wrapping a
 * `Bash(`python3 -c " ... "`)`. Everything between the first `import json, sys` after the
 * declaration and the closing `" "${path}"` is the program.
 */
function extractPatcherPython() {
  const start = SKILL_MD.indexOf('const patchTelemetryRecord')
  if (start === -1) return null
  const pyStart = SKILL_MD.indexOf('import json, sys', start)
  if (pyStart === -1) return null
  const pyEnd = SKILL_MD.indexOf('" "${path}"', pyStart)
  if (pyEnd === -1) return null
  return SKILL_MD.slice(pyStart, pyEnd)
    // The markdown escapes newlines for the JS template literal that carries it.
    .replace(/\\\\n/g, '\\n')
}

/** Run the extracted python over a record and return the patched object. */
function runPython(record, fields) {
  const py = extractPatcherPython()
  assert.ok(py, 'could not extract the patcher python from SKILL.md — has it been renamed?')
  const dir = mkdtempSync(join(tmpdir(), 'patch-parity-'))
  const file = join(dir, 't.jsonl')
  writeFileSync(file, JSON.stringify(record) + '\n')
  execFileSync('python3', ['-c', py, file, JSON.stringify(fields)])
  return JSON.parse(rf(file, 'utf8').trim().split('\n').pop())
}

// Each case is [label, record, fields]. Both implementations must agree on all of them.
const CASES = [
  ['the bug: clear a nullReasons entry while setting the field it explains', {
    tokens: { total: { input: null, output: 100 } },
    cost: { rateLockedUsd: null, nullReasons: { 'tokens.total.input': 'subagentTokens not yet patched' } },
  }, {
    'tokens.total.input': 812345,
    'cost.rateLockedUsd': 1.021,
    'cost.nullReasons.tokens.total.input': null,
  }],

  ['clear a reason that was never set', { cost: { nullReasons: {} } },
    { 'cost.nullReasons.tokens.total.input': null }],

  ['clear a reason when no nullReasons map exists', { cost: { rateLockedUsd: null } },
    { 'cost.nullReasons.tokens.total.input': null }],

  ['plain nested set into a record missing the intermediate', {},
    { 'tokens.total.input': 5 }],

  ['flat keys', {}, { status: 'COMPLETE', outcome: 'success' }],

  ['set does not clobber siblings', {
    tokens: { total: { output: 100 }, byModel: { 'claude-opus-5': { output: null } } },
  }, { 'tokens.total.input': 7 }],

  ['a non-object where a path segment belongs', { tokens: 'unmeasured' },
    { 'tokens.total.input': 7 }],

  ['replace the whole nullReasons map', {
    cost: { nullReasons: { 'tokens.total.input': 'x' } },
  }, { 'cost.nullReasons': { 'tokens.byModel': 'runtime reports aggregate only' } }],

  ['a dotted key inside agentCount.byPhase', { agentCount: { byPhase: {} } },
    { 'agentCount.byPhase.Debrief': 3 }],

  ['the real post-Workflow patch, verbatim', {
    tokens: { total: { input: null, output: 41000, subagentTokens: null } },
    cost: { rateLockedUsd: null, nullReasons: { 'tokens.total.input': 'subagentTokens not yet patched' } },
  }, {
    'tokens.total.subagentTokens': 588845,
    'tokens.total.input': 547845,
    'cost.rateLockedUsd': 1.021,
    'cost.nullReasons.tokens.total.input': null,
  }],
]

for (const [label, record, fields] of CASES) {
  test(`SKILL.md python matches applyPatch — ${label}`, () => {
    assert.deepEqual(runPython(record, fields), applyPatch(record, fields))
  })
}

test('the SKILL.md python declares the same map-valued prefixes as the JS', () => {
  const py = extractPatcherPython()
  assert.ok(py, 'no patcher python found in SKILL.md')
  for (const prefix of MAP_VALUED_PREFIXES) {
    assert.ok(
      py.includes(`'${prefix}'`) || py.includes(`"${prefix}"`),
      `SKILL.md python does not know about the map-valued prefix ${prefix} — a patch reaching ` +
      `into it will be split into levels and invent a nested branch`
    )
  }
})

test('the stale-reason case is not silently passing because both are broken', () => {
  // Parity alone is satisfiable by two identically-wrong implementations. Assert the actual
  // required outcome, independent of either side.
  const out = runPython(
    { tokens: { total: { input: null } },
      cost: { nullReasons: { 'tokens.total.input': 'subagentTokens not yet patched' } } },
    { 'tokens.total.input': 812345, 'cost.nullReasons.tokens.total.input': null },
  )
  assert.equal(out.tokens.total.input, 812345)
  assert.deepEqual(out.cost.nullReasons, {}, 'SKILL.md python left the stale reason in place')
  assert.equal(out.cost.nullReasons.tokens, undefined, 'SKILL.md python invented a nested branch')
})
