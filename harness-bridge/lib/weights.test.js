import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadWeights, makeWeightChange, applyWeightChange } from './weights.js'
import { CHECKS_A, CHECKS_B } from './confidence.js'

const sum = w => Object.values(w).reduce((s, x) => s + x, 0)
const min = w => Math.min(...Object.values(w))
const max = w => Math.max(...Object.values(w))
function assertInvariants(w, label) {
  assert.equal(sum(w), 100, `${label}: sum must be 100, got ${sum(w)}`)
  assert.ok(min(w) >= 1, `${label}: min must be ≥ 1, got ${min(w)}`)
  assert.ok(max(w) <= 60, `${label}: max must be ≤ 60, got ${max(w)}`)
}

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
  // Use a raw object so grounding-evidence-fresh starts near 60, making +15 bind at ceiling
  const base = { 'grounding-evidence-fresh': 56, 'files-populated': 14, 'ac-research-executable': 13,
    'size-corroboration': 6, 'ac-referenced-files-covered': 4, 'claim-truth-consistency': 4,
    'scope-grounded': 2, 'size-shape-consistency': 1 }
  // requesting +15 from 56 would be 71 → ceiling 60
  const out = applyWeightChange(base, { checkId: 'grounding-evidence-fresh', newWeight: 71 })
  assert.equal(out['grounding-evidence-fresh'], 60, 'ceiling binding: must be exactly 60')
  assert.equal(sum(out), 100)
  // Also test floor: drive size-shape-consistency toward 0 by boosting grounding-evidence-fresh many times
  let w = loadWeights(CHECKS_A, null)
  for (let i = 0; i < 8; i++) {
    const gef = w['grounding-evidence-fresh']
    w = applyWeightChange(w, { checkId: 'grounding-evidence-fresh', newWeight: gef + 15 })
  }
  assert.ok(min(w) >= 1, `floor violated: min is ${min(w)}`)
  assert.equal(sum(w), 100)
})
// ---- Invariant tests: sum=100, min≥1, max≤60 across both check sets ----
for (const [label, CHECKS] of [['CHECKS_A', CHECKS_A], ['CHECKS_B', CHECKS_B]]) {
  test(`invariants: ${label} base defaults`, () => {
    assertInvariants(loadWeights(CHECKS, null), `${label} base`)
  })
  test(`invariants: ${label} huge override`, () => {
    const id = CHECKS[0].id
    assertInvariants(loadWeights(CHECKS, { [id]: 1000 }), `${label} huge`)
  })
  test(`invariants: ${label} negative override`, () => {
    const id = CHECKS[0].id
    assertInvariants(loadWeights(CHECKS, { [id]: -50 }), `${label} negative`)
  })
  test(`invariants: ${label} all-zeros override`, () => {
    const override = Object.fromEntries(CHECKS.map(c => [c.id, 0]))
    assertInvariants(loadWeights(CHECKS, override), `${label} all-zeros`)
  })
  test(`invariants: ${label} unknown-id override (ignored)`, () => {
    assertInvariants(loadWeights(CHECKS, { 'not-a-real-check': 999 }), `${label} unknown-id`)
  })
  test(`invariants: ${label} chain of 8 alternating applyWeightChange calls`, () => {
    let w = loadWeights(CHECKS, null)
    for (let i = 0; i < 8; i++) {
      const checkId = CHECKS[i % CHECKS.length].id
      const cur = w[checkId]
      const delta = i % 2 === 0 ? 15 : -15
      w = applyWeightChange(w, { checkId, newWeight: cur + delta })
      assertInvariants(w, `${label} chain step ${i}`)
    }
  })
}

test('makeWeightChange returns the full audit shape', () => {
  const c = makeWeightChange({ handoff: 'A', checkId: 'x', oldWeight: 10, newWeight: 20, reason: 'y', triggeringRunId: 'r', ts: 't' })
  assert.deepEqual(Object.keys(c).sort(), ['checkId', 'handoff', 'newWeight', 'oldWeight', 'reason', 'triggeringRunId', 'ts'])
})
