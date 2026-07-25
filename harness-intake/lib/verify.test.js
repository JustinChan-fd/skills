import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeClaimConflict, recomputeClaimConflicts } from './verify.js'

describe('computeClaimConflict', () => {
  it('returns true for 118→1 (98% divergence — TARS-1271 axios AC)', () => {
    assert.equal(computeClaimConflict(1, 118), true)
  })

  it('returns false for 29→26 (12% divergence — TARS-1271 fetch AC)', () => {
    assert.equal(computeClaimConflict(29, 26), false)
  })

  it('returns false when ticketClaimedCount is 0 (no claim, no conflict)', () => {
    assert.equal(computeClaimConflict(0, 0), false)
    assert.equal(computeClaimConflict(5, 0), false)
  })

  it('returns true when verified is 0 and ticket claimed 5 (100% divergence)', () => {
    assert.equal(computeClaimConflict(0, 5), true)
  })

  it('returns false at exactly 20% divergence (threshold is >, not >=)', () => {
    assert.equal(computeClaimConflict(80, 100), false)
  })

  it('returns true just over 20% divergence', () => {
    assert.equal(computeClaimConflict(79, 100), true)
  })

  it('returns false when verified exactly matches claimed', () => {
    assert.equal(computeClaimConflict(10, 10), false)
  })

  it('returns false when ticketClaimedCount is null or undefined', () => {
    assert.equal(computeClaimConflict(5, null), false)
    assert.equal(computeClaimConflict(5, undefined), false)
  })
})

describe('recomputeClaimConflicts', () => {
  it('sets claimConflict=true on the axios AC (118→1)', () => {
    const acList = [
      { bullet: 'Migrate axios', verifiedCount: 1, ticketClaimedCount: 118, claimConflict: false },
    ]
    const result = recomputeClaimConflicts(acList)
    assert.equal(result[0].claimConflict, true)
  })

  it('leaves claimConflict=false on the fetch AC (29→26)', () => {
    const acList = [
      { bullet: 'Replace fetch()', verifiedCount: 29, ticketClaimedCount: 26, claimConflict: false },
    ]
    const result = recomputeClaimConflicts(acList)
    assert.equal(result[0].claimConflict, false)
  })

  it('corrects a false claimConflict that Haiku got wrong', () => {
    const acList = [
      { bullet: 'Migrate axios', verifiedCount: 1, ticketClaimedCount: 118, claimConflict: false },
    ]
    const result = recomputeClaimConflicts(acList)
    assert.equal(result[0].claimConflict, true)
  })

  it('corrects a spurious true claimConflict', () => {
    const acList = [
      { bullet: 'Replace fetch()', verifiedCount: 29, ticketClaimedCount: 26, claimConflict: true },
    ]
    const result = recomputeClaimConflicts(acList)
    assert.equal(result[0].claimConflict, false)
  })

  it('does not mutate the original array', () => {
    const acList = [
      { bullet: 'Migrate axios', verifiedCount: 1, ticketClaimedCount: 118, claimConflict: false },
    ]
    recomputeClaimConflicts(acList)
    assert.equal(acList[0].claimConflict, false)
  })

  it('handles ACs with ticketClaimedCount=0 (no conflict regardless of verifiedCount)', () => {
    const acList = [
      { bullet: 'Remove middleware', verifiedCount: 2, ticketClaimedCount: 0, claimConflict: false },
    ]
    const result = recomputeClaimConflicts(acList)
    assert.equal(result[0].claimConflict, false)
  })

  it('processes mixed list correctly', () => {
    const acList = [
      { bullet: 'Migrate axios',   verifiedCount: 1,  ticketClaimedCount: 118, claimConflict: false },
      { bullet: 'Replace fetch()', verifiedCount: 29, ticketClaimedCount: 26,  claimConflict: false },
      { bullet: 'Remove pkg.json', verifiedCount: 2,  ticketClaimedCount: 0,   claimConflict: false },
    ]
    const result = recomputeClaimConflicts(acList)
    assert.equal(result[0].claimConflict, true)
    assert.equal(result[1].claimConflict, false)
    assert.equal(result[2].claimConflict, false)
  })
})
