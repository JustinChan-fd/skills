import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadWeights, makeWeightChange, applyWeightChange } from './weights.js'
import { CHECKS_A } from './confidence.js'

const sum = w => Object.values(w).reduce((s, x) => s + x, 0)

test('loadWeights(null) returns defaults summing to 100', () => {
  const w = loadWeights(CHECKS_A, null)
  assert.equal(sum(w), 100)
  assert.equal(w['grounding-evidence-fresh'], 24)
})
test('loadWeights renormalizes an override to exactly 100', () => {
  const w = loadWeights(CHECKS_A, { 'grounding-evidence-fresh': 40 })
  assert.equal(sum(w), 100)
})
test('applyWeightChange clamps to ±15 per adjustment', () => {
  const base = loadWeights(CHECKS_A, null)
  const out = applyWeightChange(base, { checkId: 'files-populated', newWeight: 90 }) // old 20 → clamped 35
  assert.equal(out['files-populated'], 35)
  assert.equal(sum(out), 100)
})
test('applyWeightChange respects ceiling 60 and floor 1', () => {
  const base = loadWeights(CHECKS_A, { 'grounding-evidence-fresh': 55 })
  // requesting +15 from 55 would be 70 → ceiling 60
  const out = applyWeightChange(base, { checkId: 'grounding-evidence-fresh', newWeight: 70 })
  assert.ok(out['grounding-evidence-fresh'] <= 60)
  assert.equal(sum(out), 100)
})
test('makeWeightChange returns the full audit shape', () => {
  const c = makeWeightChange({ handoff: 'A', checkId: 'x', oldWeight: 10, newWeight: 20, reason: 'y', triggeringRunId: 'r', ts: 't' })
  assert.deepEqual(Object.keys(c).sort(), ['checkId', 'handoff', 'newWeight', 'oldWeight', 'reason', 'triggeringRunId', 'ts'])
})
