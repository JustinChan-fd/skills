import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHECKS_B } from './checks-b.js'
import { assertWeightsSum } from './checks-common.js'

test('Handoff B weights sum to exactly 100', () => assert.equal(assertWeightsSum(CHECKS_B), true))

const bId = id => CHECKS_B.find(c => c.id === id).fn
test('task-files-present-bounded: empty=0, 1-3=1, decays >3', () => {
  assert.equal(bId('task-files-present-bounded')({ tasks: [{ files: [] }] }), 0)
  assert.equal(bId('task-files-present-bounded')({ tasks: [{ files: ['a', 'b'] }] }), 1)
  assert.ok(bId('task-files-present-bounded')({ tasks: [{ files: ['a', 'b', 'c', 'd', 'e', 'f'] }] }) < 1)
})
test('task-spec-completeness: full task passes, prose-only fails', () => {
  const full = { tasks: [{ tddRequired: true, description: 'WHAT: x\nWHERE: src/a.ts:12 — the fn\nHOW: mirror this pattern here now\n```js\nx()\n```\nDONE: expect(x()).toBe(1)' }] }
  const thin = { tasks: [{ tddRequired: false, description: 'just do the thing' }] }
  assert.equal(bId('task-spec-completeness')(full), 1)
  assert.equal(bId('task-spec-completeness')(thin), 0)
})
test('manifest-dag-consistency: unresolvable dependsOn fails', () => {
  assert.ok(bId('manifest-dag-consistency')({ plans: [{ id: 'p1', dependsOn: ['pX'] }], execution: 'sequential' }) < 1)
})
