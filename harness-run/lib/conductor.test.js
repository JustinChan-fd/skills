import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEQUENCE, actionForVerdict, assembleRunSummary, weightEvolutionReport } from './conductor.js'

test('SEQUENCE is intake → bridgeA → plan → bridgeB → implement', () => {
  assert.deepEqual(SEQUENCE.map(s => s.skill),
    ['harness-intake', 'harness-bridge', 'harness-plan', 'harness-bridge', 'harness-implement'])
})
test('actionForVerdict routes PROCEED/RE_ASK/EXIT', () => {
  assert.equal(actionForVerdict('PROCEED', 0).next, 'advance')
  assert.equal(actionForVerdict('RE_ASK', 0).next, 'refine')
  assert.equal(actionForVerdict('EXIT', 1).next, 'stop')
})
test('actionForVerdict RE_ASK with retriesUsed=1 stops (not refine)', () => {
  assert.equal(actionForVerdict('RE_ASK', 1).next, 'stop')
})
test('assembleRunSummary sums cost + duration and reports final status', () => {
  const recs = [
    { skill: 'harness-intake', cost: { rateLockedUsd: 0.5 }, durationMs: 1000, outcome: 'COMPLETE' },
    { skill: 'harness-bridge', confidence: 90, durationMs: 500, outcome: 'PROCEED' },
    { skill: 'harness-implement', cost: { rateLockedUsd: 2.0 }, durationMs: 3000, outcome: 'COMPLETE' },
  ]
  const s = assembleRunSummary(recs)
  assert.equal(s.totalCostUsd, 2.5)
  assert.equal(s.totalDurationMs, 4500)
  assert.equal(s.finalStatus, 'COMPLETE')
  assert.equal(s.stages.length, 3)
})
test('assembleRunSummary finalStatus is EXIT if any bridge exited', () => {
  const recs = [{ skill: 'harness-bridge', outcome: 'EXIT', durationMs: 10 }]
  assert.equal(assembleRunSummary(recs).finalStatus, 'EXIT')
})
// ---- finalStatus case-sensitivity and vocabulary coverage ----
test('assembleRunSummary: lowercase failed → FAILED', () => {
  const recs = [{ skill: 'harness-implement', outcome: 'failed', durationMs: 0 }]
  assert.equal(assembleRunSummary(recs).finalStatus, 'FAILED')
})
test('assembleRunSummary: lowercase crashed → FAILED', () => {
  const recs = [{ skill: 'harness-implement', outcome: 'crashed', durationMs: 0 }]
  assert.equal(assembleRunSummary(recs).finalStatus, 'FAILED')
})
test('assembleRunSummary: lowercase partial → FAILED', () => {
  const recs = [{ skill: 'harness-implement', outcome: 'partial', durationMs: 0 }]
  assert.equal(assembleRunSummary(recs).finalStatus, 'FAILED')
})
test('assembleRunSummary: EXIT wins over failed', () => {
  const recs = [
    { skill: 'harness-bridge', outcome: 'EXIT', durationMs: 0 },
    { skill: 'harness-implement', outcome: 'failed', durationMs: 0 },
  ]
  assert.equal(assembleRunSummary(recs).finalStatus, 'EXIT')
})
test('assembleRunSummary: all-null outcomes → UNKNOWN', () => {
  const recs = [
    { skill: 'harness-intake', durationMs: 0 },
    { skill: 'harness-plan', durationMs: 0 },
  ]
  assert.equal(assembleRunSummary(recs).finalStatus, 'UNKNOWN')
})
test('assembleRunSummary: all success → COMPLETE', () => {
  const recs = [
    { skill: 'harness-intake', outcome: 'success', durationMs: 0 },
    { skill: 'harness-plan', outcome: 'success', durationMs: 0 },
  ]
  assert.equal(assembleRunSummary(recs).finalStatus, 'COMPLETE')
})

test('weightEvolutionReport shows initial → final and each change', () => {
  const initial = { A: { 'files-populated': 20 }, B: { 'task-spec-completeness': 30 } }
  const changes = [{ handoff: 'A', checkId: 'files-populated', oldWeight: 20, newWeight: 30, reason: 'empty subtask files kept slipping', triggeringRunId: 'r1', ts: 't' }]
  const out = weightEvolutionReport(initial, changes)
  assert.match(out, /files-populated/)
  assert.match(out, /20 → 30/)
  assert.match(out, /empty subtask files/)
})
