import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toOutcome, VALID_STATUSES } from './status.js'

describe('toOutcome — harness-implement', () => {
  it('COMPLETE maps to success', () => {
    assert.equal(toOutcome('COMPLETE'), 'success')
  })

  it('PARTIAL maps to partial', () => {
    assert.equal(toOutcome('PARTIAL'), 'partial')
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

describe('VALID_STATUSES — harness-implement', () => {
  it('includes the three shared base statuses', () => {
    assert.ok(VALID_STATUSES.includes('COMPLETE'))
    assert.ok(VALID_STATUSES.includes('CRASHED'))
    assert.ok(VALID_STATUSES.includes('FAILED'))
  })

  it('includes implement-specific PARTIAL', () => {
    assert.ok(VALID_STATUSES.includes('PARTIAL'))
  })
})
