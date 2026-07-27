import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampAdjusted, parseHolePoker } from './holepoker.js'

test('clampAdjusted never raises the score', () => {
  assert.equal(clampAdjusted(80, 95), 80) // skeptic tried to raise → held at 80
})
test('clampAdjusted lowers when skeptic is lower', () => {
  assert.equal(clampAdjusted(80, 55), 55)
})
test('clampAdjusted floors at 0', () => {
  assert.equal(clampAdjusted(80, -10), 0)
})
test('parseHolePoker reads a clean JSON object', () => {
  const r = parseHolePoker('{"adjustedScore": 60, "reasons": ["files thin", "grep unverified"]}')
  assert.equal(r.adjustedScore, 60)
  assert.deepEqual(r.reasons, ['files thin', 'grep unverified'])
})
test('parseHolePoker tolerates fenced JSON', () => {
  const r = parseHolePoker('```json\n{"adjustedScore": 42, "reasons": []}\n```')
  assert.equal(r.adjustedScore, 42)
})
test('parseHolePoker returns null score on garbage (caller keeps JS score)', () => {
  const r = parseHolePoker('the plan looks fine to me')
  assert.equal(r.adjustedScore, null)
  assert.deepEqual(r.reasons, [])
})
