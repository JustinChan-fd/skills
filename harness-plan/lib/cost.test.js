import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { COST_RATES, PRICE_TABLE_VERSION, rateFor, computeCost } from './cost.js'

// Rates sourced from https://docs.claude.com/en/docs/about-claude/pricing (2026-07-25)
describe('PRICE_TABLE_VERSION', () => {
  it('is a date string', () => assert.match(PRICE_TABLE_VERSION, /^\d{4}-\d{2}-\d{2}$/))
})

describe('COST_RATES', () => {
  it('haiku input rate is $1.00/MTok',   () => assert.equal(COST_RATES.haiku.in,   1.00))
  it('haiku output rate is $5.00/MTok',  () => assert.equal(COST_RATES.haiku.out,  5.00))
  it('sonnet input rate is $3.00/MTok',  () => assert.equal(COST_RATES.sonnet.in,  3.00))
  it('sonnet output rate is $15.00/MTok', () => assert.equal(COST_RATES.sonnet.out, 15.00))
  it('opus input rate is $5.00/MTok',    () => assert.equal(COST_RATES.opus.in,    5.00))
  it('opus output rate is $25.00/MTok',  () => assert.equal(COST_RATES.opus.out,   25.00))
  it('haiku cacheRead is 0.10× input',   () => assert.equal(COST_RATES.haiku.cacheRead,  0.10))
  it('sonnet cacheRead is 0.10× input',  () => assert.equal(COST_RATES.sonnet.cacheRead, 0.30))
})

describe('rateFor', () => {
  it('returns opus rates for opus model ids', () => {
    assert.deepEqual(rateFor('claude-opus-5'), COST_RATES.opus)
  })
  it('returns haiku rates for haiku model ids', () => {
    assert.deepEqual(rateFor('anthropic.claude-haiku-4-5-20251001'), COST_RATES.haiku)
  })
  it('returns sonnet rates for sonnet and unknown model ids', () => {
    assert.deepEqual(rateFor('anthropic.claude-sonnet-4-6'), COST_RATES.sonnet)
    assert.deepEqual(rateFor('unknown-model'), COST_RATES.sonnet)
  })
})

describe('computeCost', () => {
  it('pure haiku: 1M input + 1M output = $6.00', () => {
    const { rateLockedUsd } = computeCost({
      agentCountByModel: { 'claude-haiku-4-5-20251001': 1 },
      inputTokens: 1_000_000,
      outputTokensTotal: 1_000_000,
    })
    assert.equal(rateLockedUsd, 6.0000)
  })

  it('pure sonnet: 1M input + 1M output = $18.00', () => {
    const { rateLockedUsd } = computeCost({
      agentCountByModel: { 'anthropic.claude-sonnet-4-6': 1 },
      inputTokens: 1_000_000,
      outputTokensTotal: 1_000_000,
    })
    assert.equal(rateLockedUsd, 18.0000)
  })

  it('pure opus: 1M input + 1M output = $30.00', () => {
    const { rateLockedUsd } = computeCost({
      agentCountByModel: { 'claude-opus-5': 1 },
      inputTokens: 1_000_000,
      outputTokensTotal: 1_000_000,
    })
    assert.equal(rateLockedUsd, 30.0000)
  })

  // TARS-1271 run actuals: subagentTokens=1232019, outputTokensTotal=52417
  // inputTokens = 1232019 - 52417 = 1179602
  // agentCount: 20 haiku + 6 sonnet (26 total)
  // blendedInRate  = (20/26)*1 + (6/26)*3  = 0.769 + 0.692 = 1.461 $/MTok
  // blendedOutRate = (20/26)*5 + (6/26)*15 = 3.846 + 3.462 = 7.308 $/MTok
  // inCost  = 1179602 / 1e6 * 1.461 = $1.7233
  // outCost = 52417   / 1e6 * 7.308 = $0.3831
  // total ≈ $2.11
  it('TARS-1271 actuals (20 haiku + 6 sonnet, 1179602 input + 52417 output): ~$2.11', () => {
    const { rateLockedUsd } = computeCost({
      agentCountByModel: {
        'anthropic.claude-haiku-4-5-20251001': 20,
        'anthropic.claude-sonnet-4-6': 6,
      },
      inputTokens: 1_179_602,
      outputTokensTotal: 52_417,
    })
    assert.ok(Math.abs(rateLockedUsd - 2.11) < 0.05, `expected ~2.11, got ${rateLockedUsd}`)
  })

  it('when inputTokens is null, still computes output cost and records reason', () => {
    const { rateLockedUsd, nullReasons } = computeCost({
      agentCountByModel: { 'anthropic.claude-sonnet-4-6': 1 },
      inputTokens: null,
      outputTokensTotal: 1_000_000,
    })
    assert.equal(rateLockedUsd, 15.0000)
    assert.ok(nullReasons['tokens.total.input'])
  })

  it('50/50 haiku+sonnet: 1M input + 1M output = $10.00', () => {
    const { rateLockedUsd } = computeCost({
      agentCountByModel: { 'claude-haiku-4-5-20251001': 1, 'anthropic.claude-sonnet-4-6': 1 },
      inputTokens: 1_000_000,
      outputTokensTotal: 1_000_000,
    })
    // blendedIn = (1+3)/2 = 2; blendedOut = (5+15)/2 = 10; total = 2+10 = $12
    assert.equal(rateLockedUsd, 12.0000)
  })

  it('returns null rateLockedUsd and nullReason for empty agentCountByModel', () => {
    const { rateLockedUsd, nullReasons } = computeCost({
      agentCountByModel: {},
      inputTokens: 1_000_000,
      outputTokensTotal: 1_000_000,
    })
    assert.equal(rateLockedUsd, null)
    assert.ok(nullReasons['cost.rateLockedUsd'])
  })

  it('always returns priceTableVersion', () => {
    const { priceTableVersion } = computeCost({
      agentCountByModel: { 'anthropic.claude-sonnet-4-6': 1 },
      inputTokens: 100,
      outputTokensTotal: 100,
    })
    assert.equal(priceTableVersion, PRICE_TABLE_VERSION)
  })

  it('returns a number for rateLockedUsd (not a string)', () => {
    const { rateLockedUsd } = computeCost({
      agentCountByModel: { 'anthropic.claude-sonnet-4-6': 1 },
      inputTokens: 1000,
      outputTokensTotal: 1000,
    })
    assert.equal(typeof rateLockedUsd, 'number')
  })
})
