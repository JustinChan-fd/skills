import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { COST_RATES, rateFor, computeCost } from './cost.js'

// Rates sourced from https://platform.claude.com/docs/en/about-claude/pricing (2026-07-24)
describe('COST_RATES', () => {
  it('haiku 4.5 output rate is $5.00/MTok',  () => assert.equal(COST_RATES.haiku.out,  5.00))
  it('sonnet output rate is $15.00/MTok',    () => assert.equal(COST_RATES.sonnet.out, 15.00))
  it('opus 4.5+ output rate is $25.00/MTok', () => assert.equal(COST_RATES.opus.out,   25.00))
})

describe('rateFor', () => {
  it('returns opus rates for opus model ids', () => {
    assert.deepEqual(rateFor('claude-opus-4-8'),           { in: 5,  out: 25 })
    assert.deepEqual(rateFor('anthropic.claude-opus-4-5'), { in: 5,  out: 25 })
  })
  it('returns haiku rates for haiku model ids', () => {
    assert.deepEqual(rateFor('claude-haiku-4-5-20251001'),            { in: 1, out: 5 })
    assert.deepEqual(rateFor('anthropic.claude-haiku-4-5-20251001'),  { in: 1, out: 5 })
  })
  it('returns sonnet rates for sonnet and unknown model ids', () => {
    assert.deepEqual(rateFor('anthropic.claude-sonnet-4-6'), { in: 3, out: 15 })
    assert.deepEqual(rateFor('unknown-model'),               { in: 3, out: 15 })
  })
})

// computeCost(agentCountByModel, outputTokensTotal) splits tokens proportionally by agent count
// and applies output rates. Immune to parallel() budget.spent() race condition.
// Output-only — budget.spent() tracks outputs only. ~4x underestimate but self-contained.
describe('computeCost', () => {
  // 1M output tokens, 1 haiku agent → $5.00
  it('pure haiku: 1M output tokens = $5.00', () => {
    assert.equal(computeCost({ 'claude-haiku-4-5-20251001': 1 }, 1_000_000), 5.0000)
  })

  // 1M output tokens, 1 sonnet agent → $15.00
  it('pure sonnet: 1M output tokens = $15.00', () => {
    assert.equal(computeCost({ 'anthropic.claude-sonnet-4-6': 1 }, 1_000_000), 15.0000)
  })

  // 1M output tokens, 1 opus agent → $25.00
  it('pure opus: 1M output tokens = $25.00', () => {
    assert.equal(computeCost({ 'claude-opus-4-8': 1 }, 1_000_000), 25.0000)
  })

  // Run-26 actuals: 77,884 output tokens, 20 haiku + 6 sonnet (26 total agents)
  // blendedRate = (20/26)*5 + (6/26)*15 = 3.846 + 3.462 = 7.308/26... let's compute
  // = (20*5 + 6*15) / 26 = (100+90)/26 = 7.308 $/MTok
  // cost = 77884 * 7.308 / 1e6 = $0.5692
  it('run-26 actuals (20 haiku + 6 sonnet, 77884 output tokens): ~$0.57', () => {
    const cost = computeCost(
      { 'anthropic.claude-haiku-4-5-20251001': 20, 'anthropic.claude-sonnet-4-6': 6 },
      77_884
    )
    assert.ok(Math.abs(cost - 0.57) < 0.02, `expected ~0.57, got ${cost}`)
  })

  // Mixed: equal haiku/sonnet agents → blended rate = (5+15)/2 = $10/MTok
  it('50/50 haiku+sonnet mix: 1M tokens = $10.00', () => {
    assert.equal(
      computeCost({ 'claude-haiku-4-5-20251001': 1, 'anthropic.claude-sonnet-4-6': 1 }, 1_000_000),
      10.0000
    )
  })

  it('returns 0 for empty agentCountByModel', () => {
    assert.equal(computeCost({}, 1_000_000), 0)
  })

  it('returns 0 for zero outputTokensTotal', () => {
    assert.equal(computeCost({ 'anthropic.claude-sonnet-4-6': 5 }, 0), 0)
  })

  it('returns a number (not a string)', () => {
    assert.equal(typeof computeCost({ 'anthropic.claude-sonnet-4-6': 1 }, 500), 'number')
  })

  it('rounds to 4 decimal places', () => {
    const result = computeCost({ 'anthropic.claude-sonnet-4-6': 1 }, 1)
    assert.equal(result, 0.0000)
  })
})
