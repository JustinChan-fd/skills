// Status vocabulary for harness-intake.
// Shared base: COMPLETE, CRASHED, FAILED (identical across all three skills).
// Intake-specific additions: COMPLETE_FRAMING_CORRECTED, COMPLETE_WITH_STUBS, PROPOSED_WITH_GAPS.

export const VALID_STATUSES = [
  'COMPLETE',
  'COMPLETE_FRAMING_CORRECTED',
  'COMPLETE_WITH_STUBS',
  'PROPOSED_WITH_GAPS',
  'CRASHED',
  'FAILED',
]

const OUTCOME_MAP = {
  COMPLETE:                   'success',
  COMPLETE_FRAMING_CORRECTED: 'success',
  COMPLETE_WITH_STUBS:        'partial',
  PROPOSED_WITH_GAPS:         'partial',
  CRASHED:                    'failed',
  FAILED:                     'failed',
}

export function toOutcome(status) {
  return OUTCOME_MAP[status] ?? 'failed'
}
