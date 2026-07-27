import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL } from './models.js'

test('MODEL has opus, sonnet, haiku keys', () => {
  assert.ok('opus'   in MODEL)
  assert.ok('sonnet' in MODEL)
  assert.ok('haiku'  in MODEL)
})

test('MODEL values are non-empty strings', () => {
  for (const [key, val] of Object.entries(MODEL)) {
    assert.equal(typeof val, 'string', `${key} should be a string`)
    assert.ok(val.length > 0, `${key} should be non-empty`)
  }
})

test('MODEL.opus is not the stale claude-opus-4-6-v1 id', () => {
  assert.ok(!MODEL.opus.includes('4-6'), `stale opus id still present: ${MODEL.opus}`)
})

test('opus seat points at claude-opus-5', () => {
  assert.equal(MODEL.opus, 'claude-opus-5')
})

test('sonnet and haiku seats unchanged', () => {
  assert.equal(MODEL.sonnet, 'anthropic.claude-sonnet-4-6')
  assert.equal(MODEL.haiku, 'claude-haiku-4-5-20251001')
})
