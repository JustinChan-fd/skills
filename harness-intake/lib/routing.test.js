import { describe, test, it } from 'node:test'
import assert from 'node:assert/strict'
import { ROUTING, routingFor } from './routing.js'

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

describe('routingFor(size)', () => {
  it('returns an object with concurrency and skipLayerResearch for each valid size', () => {
    for (const size of ['XS', 'S', 'M', 'L']) {
      const r = routingFor(size)
      assert.ok('concurrency'        in r, `${size} missing concurrency`)
      assert.ok('skipLayerResearch'  in r, `${size} missing skipLayerResearch`)
    }
  })

  it('does not include effort — effort belongs in ROUTING per label, not here', () => {
    for (const size of ['XS', 'S', 'M', 'L']) {
      assert.ok(!('effort' in routingFor(size)), `${size} should not have effort`)
    }
  })

  it('XS skips layer research — no structural layer research needed for tiny tickets', () => {
    assert.equal(routingFor('XS').skipLayerResearch, true)
  })

  it('S, M, L do not skip layer research', () => {
    assert.equal(routingFor('S').skipLayerResearch, false)
    assert.equal(routingFor('M').skipLayerResearch, false)
    assert.equal(routingFor('L').skipLayerResearch, false)
  })

  it('XS and S use concurrency 3 — small fan-out, avoids rate-limit pressure', () => {
    assert.equal(routingFor('XS').concurrency, 3)
    assert.equal(routingFor('S').concurrency, 3)
  })

  it('M and L use concurrency 5 — larger fan-out matches current batch size', () => {
    assert.equal(routingFor('M').concurrency, 5)
    assert.equal(routingFor('L').concurrency, 5)
  })

  it('L returns the same routing as current hardcoded behavior (concurrency 5, no skip)', () => {
    const r = routingFor('L')
    assert.equal(r.concurrency, 5)
    assert.equal(r.skipLayerResearch, false)
  })

  it('unknown size throws a clear error', () => {
    assert.throws(() => routingFor('XXL'), /unknown size/)
    assert.throws(() => routingFor(''),    /unknown size/)
    assert.throws(() => routingFor(null),  /unknown size/)
  })
})
