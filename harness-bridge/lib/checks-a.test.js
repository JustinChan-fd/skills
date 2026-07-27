import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CHECKS_A } from './checks-a.js'
import { assertWeightsSum } from './checks-common.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = name => JSON.parse(readFileSync(join(HERE, '..', 'fixtures', name), 'utf8'))
const scoreA = m => CHECKS_A.reduce((s, c) => s + c.fn(m) * c.weight, 0)  // local Σ for fixture-level assertions

test('Handoff A weights sum to exactly 100', () => assert.equal(assertWeightsSum(CHECKS_A), true))

// Fixture-level: the clean intake manifest clears the bar, the dirty one is far below it.
test('clean intake fixture scores well above threshold (85)', () => assert.ok(scoreA(fixture('intake-manifest-clean.json')) >= 85))
test('dirty intake fixture scores well below threshold (85)', () => assert.ok(scoreA(fixture('intake-manifest-dirty.json')) < 50))

const byId = (checks, id) => checks.find(c => c.id === id).fn

test('files-populated: L with empty subtask files scores 0 (bug #1)', () => {
  const m = { size: 'L', groups: [{ subtasks: [{ files: [] }, { files: [] }] }] }
  assert.equal(byId(CHECKS_A, 'files-populated')(m), 0)
})
test('files-populated: non-L is vacuously 1 (files deferred to plan)', () => {
  assert.equal(byId(CHECKS_A, 'files-populated')({ size: 'S', files: [] }), 1)
})
test('grounding-evidence-fresh: target present + verified beats absent', () => {
  const strong = { migrationPattern: 'axios → clientFetch', scopePath: 'src/client/clientFetch.ts',
    acList: [{ researchType: 'grep', grepPattern: 'axios', verifiedCount: 12 }] }
  const weak = { migrationPattern: 'axios → clientFetch',
    acList: [{ researchType: 'grep', grepPattern: 'axios', verifiedCount: 0 }] }
  assert.ok(byId(CHECKS_A, 'grounding-evidence-fresh')(strong) > byId(CHECKS_A, 'grounding-evidence-fresh')(weak))
})
test('size-shape-consistency: L requires groups', () => {
  assert.equal(byId(CHECKS_A, 'size-shape-consistency')({ size: 'L', groups: [] }), 0)
  assert.equal(byId(CHECKS_A, 'size-shape-consistency')({ size: 'S' }), 1)
})
