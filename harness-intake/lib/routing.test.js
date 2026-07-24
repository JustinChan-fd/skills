import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROUTING } from './routing.js'

const VALID_MODELS  = new Set(['opus', 'sonnet', 'haiku'])
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

test('ROUTING is a non-empty object', () => {
  assert.equal(typeof ROUTING, 'object')
  assert.ok(Object.keys(ROUTING).length > 0)
})

test('every ROUTING entry has model and effort', () => {
  for (const [key, val] of Object.entries(ROUTING)) {
    assert.ok('model'  in val, `${key} missing model`)
    assert.ok('effort' in val, `${key} missing effort`)
  }
})

test('every ROUTING model is a valid tier', () => {
  for (const [key, val] of Object.entries(ROUTING)) {
    assert.ok(VALID_MODELS.has(val.model), `${key} has unknown model: ${val.model}`)
  }
})

test('every ROUTING effort is a valid level', () => {
  for (const [key, val] of Object.entries(ROUTING)) {
    assert.ok(VALID_EFFORTS.has(val.effort), `${key} has unknown effort: ${val.effort}`)
  }
})

test('design:coordinator uses opus/high (most expensive, highest-stakes)', () => {
  assert.equal(ROUTING['design:coordinator'].model, 'opus')
  assert.equal(ROUTING['design:coordinator'].effort, 'high')
})
