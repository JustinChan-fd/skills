import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { COST_RATES, rateFor, computeCost } from './cost.js'

describe('COST_RATES', () => {
  it('has correct rates', () => {
    assert.equal(COST_RATES.opus, 75)
    assert.equal(COST_RATES.haiku, 1.25)
    assert.equal(COST_RATES.default, 15)
  })
})

describe('rateFor', () => {
  it('returns opus rate for opus model ids', () => {
    assert.equal(rateFor('claude-opus-4-8'), 75)
  })

  it('returns haiku rate for haiku model ids', () => {
    assert.equal(rateFor('claude-haiku-4-5-20251001'), 1.25)
  })

  it('returns default rate for sonnet model ids', () => {
    assert.equal(rateFor('anthropic.claude-sonnet-4-6'), 15)
  })
})

describe('computeCost', () => {
  it('sums tokens × rate / 1e6', () => {
    assert.equal(computeCost({ 'claude-opus-4-8': 1_000_000, 'claude-haiku-4-5-20251001': 1_000_000 }), 76.25)
  })

  it('returns 0 for empty object', () => {
    assert.equal(computeCost({}), 0)
  })

  it('returns a number', () => {
    assert.equal(typeof computeCost({ 'claude-sonnet': 500 }), 'number')
  })
})
