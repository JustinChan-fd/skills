// The two outcome derivations must agree, for every status this skill can emit.
//
// There are two of them, both live, and they disagreed:
//
//   lib/status.js         toOutcome(status)     → what gets WRITTEN into the record
//   lib/telemetry-validate.js deriveOutcome(status) → what the validator EXPECTS to find
//
// On harness-intake, COMPLETE_WITH_STUBS mapped to 'partial' in the first and 'success' in the
// second. That status is reachable — workflow.js sets it whenever `hasStubs` — so every run with
// stubs wrote a correct record and then had its own validator log
// `outcome "partial" inconsistent with status "COMPLETE_WITH_STUBS" (expected "success")`.
//
// The failure mode is worse than a wrong field. It is a validator disagreeing with the writer,
// which makes the Phase 1e grade untrustworthy exactly when a run is degraded — the case the
// grade exists to report. A spurious problem line trains you to ignore problem lines.
//
// Neither map is checked against the other anywhere, and each has its own passing unit tests, so
// both were green while contradicting each other. That is the whole reason this file compares
// them rather than testing either one again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toOutcome, VALID_STATUSES } from './status.js'
import { deriveOutcome } from './telemetry-validate.js'

test('every status this skill can emit derives the same outcome on both paths', () => {
  for (const status of VALID_STATUSES) {
    assert.equal(
      deriveOutcome(status), toOutcome(status),
      `${status}: the record is written outcome "${toOutcome(status)}" but the validator expects ` +
      `"${deriveOutcome(status)}" — the grade will report a problem that is not one`
    )
  }
})

test('VALID_STATUSES is non-empty, so the comparison cannot pass vacuously', () => {
  assert.ok(Array.isArray(VALID_STATUSES) && VALID_STATUSES.length >= 3, 'VALID_STATUSES is missing or too small to be real')
})

test('an unknown status fails closed to failed on both paths', () => {
  for (const bogus of ['NOT_A_STATUS', '', null, undefined, 42]) {
    assert.equal(toOutcome(bogus), 'failed', `toOutcome(${JSON.stringify(bogus)}) does not fail closed`)
    assert.equal(deriveOutcome(bogus), 'failed', `deriveOutcome(${JSON.stringify(bogus)}) does not fail closed`)
  }
})

test('no status derives an outcome that is itself a status value', () => {
  // The two axes must not collapse. `outcome` is a three-way roll-up; if it ever equals a
  // lifecycle value the dashboard's RESULT column starts showing statuses.
  const statuses = new Set(VALID_STATUSES)
  for (const status of VALID_STATUSES) {
    const out = toOutcome(status)
    assert.ok(['success', 'partial', 'failed'].includes(out), `${status} → "${out}" is not one of the three outcomes`)
    assert.ok(!statuses.has(out), `${status} → "${out}" is a status value — the axes have collapsed`)
  }
})
