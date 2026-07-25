// Status vocabulary for harness-implement.
// Shared base: COMPLETE, CRASHED, FAILED (identical across all three skills).
// Implement-specific addition: PARTIAL.

export const VALID_STATUSES = [
  'COMPLETE',
  'PARTIAL',
  'CRASHED',
  'FAILED',
]

const OUTCOME_MAP = {
  COMPLETE: 'success',
  PARTIAL:  'partial',
  CRASHED:  'failed',
  FAILED:   'failed',
}

export function toOutcome(status) {
  return OUTCOME_MAP[status] ?? 'failed'
}
