import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gatedPathFor, stampManifest } from './gated.js'

test('gatedPathFor inserts -gated before .json', () => {
  assert.equal(gatedPathFor('/x/2026-07-27-TARS-1271-intake-manifest.json'),
    '/x/2026-07-27-TARS-1271-intake-manifest-gated.json')
})
test('gatedPathFor is idempotent', () => {
  assert.equal(gatedPathFor('/x/a-gated.json'), '/x/a-gated.json')
})
test('stampManifest adds fields without mutating the original', () => {
  const orig = { size: 'S', acList: [] }
  const stamped = stampManifest(orig, { confidence: 88, verdict: 'PROCEED', flags: [], probeResults: [] })
  assert.equal(stamped.gated, true)
  assert.equal(stamped.confidence, 88)
  assert.equal(stamped.verdict, 'PROCEED')
  assert.equal(orig.gated, undefined) // original untouched
})
