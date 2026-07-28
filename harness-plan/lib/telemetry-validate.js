// Record-shape validator (Phase 1e).
//
// Makes "did this stage actually run, and were its numbers measured?" a checkable assertion
// rather than an inference from a file existing on disk. Run it in Debrief before the append
// and log() what it says — never fail a run over telemetry.
//
// Source of truth for the field list and the null policy:
//   harness-telemetry-schema/telemetry-v2.jsonc
//
// KEEP IN SYNC with the inline mirror in workflow.js (inline-mirror.test.js enforces it).

/**
 * Keys every v2 record must carry regardless of skill. Skill-specific fields
 * (intakeManifestPath, planCount, tasksPassed, …) are deliberately not here — this is the
 * shared contract, and a skill adding its own fields must not be able to drop these.
 */
export const REQUIRED_V2_KEYS = [
  'schemaVersion', 'runId', 'skill', 'skillsSchemaVersion', 'skillsCommit',
  'emitTrigger', 'billingMode', 'ts', 'status', 'outcome', 'sourceIssue',
  'repo', 'repoPath', 'durationMs', 'tokens', 'agentCount', 'cost',
]

/**
 * status → the single acceptable outcome. Two axes, never conflated: status is the
 * lifecycle value, outcome is the three-way roll-up the dashboard's RESULT column and
 * assembleRunSummary read. Collapsing them is what made RESULT unreadable.
 */
const OUTCOME_FOR_STATUS = {
  COMPLETE: 'success',
  COMPLETE_FRAMING_CORRECTED: 'success',
  COMPLETE_WITH_STUBS: 'success',
  PROPOSED_WITH_GAPS: 'partial',
  PARTIAL: 'partial',
  FAILED: 'failed',
  CRASHED: 'failed',
}

/** The three fields the dashboard renders as a dash when null. See flagCell in index.html. */
const DASH_FIELDS = [
  ['durationMs', r => r?.durationMs],
  ['tokens.total.output', r => r?.tokens?.total?.output],
  ['cost.rateLockedUsd', r => r?.cost?.rateLockedUsd],
]

/**
 * Below this key count a record is a stub regardless of what it contains.
 *
 * Derived from the contract, NOT from observed key counts. An earlier version hardcoded 20
 * on the reasoning that the two known stubs are 13 and 18 keys while genuine records run
 * 28-37 — but that conflates two independent signals and sets the floor above the minimum
 * legal record. A record carrying exactly REQUIRED_V2_KEYS and nothing else is complete by
 * definition; below that count it cannot be, whatever it contains. Both real stubs are
 * caught by the schemaVersion check regardless (neither has one), so this floor exists only
 * for the residual case: a valid schemaVersion on a nearly empty record.
 */
const STUB_KEY_FLOOR = REQUIRED_V2_KEYS.length

export function deriveOutcome(status) {
  return OUTCOME_FOR_STATUS[status] || 'failed'
}

/**
 * @returns {string[]} human-readable problems, [] when clean. Never throws — a validator
 *   that can crash the Debrief phase is worse than no validator.
 */
export function validateV2Record(record) {
  const problems = []
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return ['not an object — no record to validate']
  }

  if (record.schemaVersion !== '2.0') {
    problems.push(`schemaVersion is ${JSON.stringify(record.schemaVersion)}, expected "2.0"`)
  }
  for (const key of REQUIRED_V2_KEYS) {
    if (!(key in record)) problems.push(`missing required key: ${key}`)
  }

  // outcome consistency. A record whose outcome is a verbatim status value has collapsed the
  // two axes — flag it even when the value looks reasonable.
  const { status, outcome } = record
  if (outcome != null && String(outcome) in OUTCOME_FOR_STATUS) {
    problems.push(`outcome "${outcome}" is a status value — status and outcome are separate axes`)
  } else if (status != null && outcome != null) {
    const expected = OUTCOME_FOR_STATUS[status]
    if (!expected) problems.push(`unrecognized status "${status}" — cannot check outcome`)
    else if (outcome !== expected) problems.push(`outcome "${outcome}" inconsistent with status "${status}" (expected "${expected}")`)
  }

  if ('tokens' in record && (!record.tokens || typeof record.tokens !== 'object')) {
    problems.push('tokens is present but not an object')
  }
  if ('cost' in record && (!record.cost || typeof record.cost !== 'object')) {
    problems.push('cost is present but not an object')
  }

  return problems
}

/**
 * FULL / PARTIAL / STUB.
 *
 * The middle state is the one a presence check cannot see: a PARTIAL record has every
 * required key and still renders dashes, because the append landed and a later patch did
 * not. The observed harness-plan TARS-1271 row is exactly this.
 *
 * Nulls the schema declares permanently unavailable (cacheRead, cacheCreation, per-model
 * output) are NOT counted — they are honest, and counting them would make every record
 * PARTIAL forever.
 *
 * @returns {{state: 'FULL'|'PARTIAL'|'STUB', dashes: string[], reasons: string[], problems: string[]}}
 */
export function classifyV2Record(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { state: 'STUB', dashes: [], reasons: ['not an object'], problems: validateV2Record(record) }
  }

  const problems = validateV2Record(record)
  const reasons = []
  const keyCount = Object.keys(record).length

  if (record.schemaVersion !== '2.0') {
    reasons.push(`no v2 schemaVersion (got ${JSON.stringify(record.schemaVersion)}) — fingerprint of a stage that never ran its own workflow`)
  }
  if (keyCount < STUB_KEY_FLOOR) {
    reasons.push(`only ${keyCount} keys, fewer than the ${STUB_KEY_FLOOR} required — cannot be a complete record`)
  }
  if (reasons.length) return { state: 'STUB', dashes: [], reasons, problems }

  const dashes = DASH_FIELDS.filter(([, get]) => get(record) == null).map(([name]) => name)
  return { state: dashes.length ? 'PARTIAL' : 'FULL', dashes, reasons, problems }
}
