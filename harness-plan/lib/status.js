// Status vocabulary for harness-plan.
// Shared base: COMPLETE, CRASHED, FAILED (identical across all three skills).
// Plan-specific addition: PROPOSED_WITH_GAPS.

export const VALID_STATUSES = [
  'COMPLETE',
  'PROPOSED_WITH_GAPS',
  'CRASHED',
  'FAILED',
]

const OUTCOME_MAP = {
  COMPLETE:           'success',
  PROPOSED_WITH_GAPS: 'partial',
  CRASHED:            'failed',
  FAILED:             'failed',
}

export function toOutcome(status) {
  return OUTCOME_MAP[status] ?? 'failed'
}
