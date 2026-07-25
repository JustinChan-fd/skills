import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toOutcome, VALID_STATUSES } from './status.js'

describe('toOutcome — harness-plan', () => {
  it('COMPLETE maps to success', () => {
    assert.equal(toOutcome('COMPLETE'), 'success')
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

describe('VALID_STATUSES — harness-plan', () => {
  it('includes the three shared base statuses', () => {
    assert.ok(VALID_STATUSES.includes('COMPLETE'))
    assert.ok(VALID_STATUSES.includes('CRASHED'))
    assert.ok(VALID_STATUSES.includes('FAILED'))
  })

  it('includes plan-specific PROPOSED_WITH_GAPS', () => {
    assert.ok(VALID_STATUSES.includes('PROPOSED_WITH_GAPS'))
  })
})
