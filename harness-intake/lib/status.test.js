import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toOutcome, VALID_STATUSES } from './status.js'

describe('toOutcome — harness-intake', () => {
  it('COMPLETE maps to success', () => {
    assert.equal(toOutcome('COMPLETE'), 'success')
  })

  it('COMPLETE_FRAMING_CORRECTED maps to success', () => {
    assert.equal(toOutcome('COMPLETE_FRAMING_CORRECTED'), 'success')
  })

  it('COMPLETE_WITH_STUBS maps to partial', () => {
    assert.equal(toOutcome('COMPLETE_WITH_STUBS'), 'partial')
  })

  it('PROPOSED_WITH_GAPS maps to partial', () => {
    assert.equal(toOutcome('PROPOSED_WITH_GAPS'), 'partial')
  })

  it('CRASHED maps to failed', () => {
    assert.equal(toOutcome('CRASHED'), 'failed')
  })

  it('FAILED maps to failed', () => {
    assert.equal(toOutcome('FAILED'), 'failed')
  })

  it('unknown status maps to failed', () => {
    assert.equal(toOutcome('SOMETHING_UNKNOWN'), 'failed')
  })
})

describe('VALID_STATUSES — harness-intake', () => {
  it('includes the three shared base statuses', () => {
    assert.ok(VALID_STATUSES.includes('COMPLETE'))
    assert.ok(VALID_STATUSES.includes('CRASHED'))
    assert.ok(VALID_STATUSES.includes('FAILED'))
  })

  it('includes intake-specific statuses', () => {
    assert.ok(VALID_STATUSES.includes('COMPLETE_FRAMING_CORRECTED'))
    assert.ok(VALID_STATUSES.includes('COMPLETE_WITH_STUBS'))
    assert.ok(VALID_STATUSES.includes('PROPOSED_WITH_GAPS'))
  })
})
