// Keep the bridge's three axes apart in telemetry.
//
// verdict  — the gate's decision: PROCEED / RE_ASK / EXIT. Bridge-specific vocabulary.
// status   — the lifecycle value: did this skill run to completion? Shared across all skills.
// outcome  — the dashboard's three-way roll-up: success / partial / failed.
//
// workflow.js wrote `status: verdict === 'PROCEED' ? 'COMPLETE' : verdict` and
// `outcome: verdict`, so all three collapsed into two fields. Both halves are on disk in
// harness-telemetry/v2/ right now: a record with `status: 'RE_ASK'` and records with
// `outcome: 'PROCEED'` / `outcome: 'EXIT'`.
//
// Why it matters, per axis:
//
// - A gate that returns a negative verdict has still SUCCEEDED at being a gate. Writing RE_ASK
//   into `status` says the stage did not complete, making "the bridge crashed" and "the bridge
//   said ask again" indistinguishable — the exact ambiguity the v2 schema exists to remove.
// - `outcome` is read by the dashboard's RESULT column and by assembleRunSummary, both of which
//   expect success/partial/failed. 'PROCEED' is none of those, so those rows render as neither.
// - Nothing was gained by the overwrite: `verdict` was already its own field on the record.
//
// The bridge is parked, not deleted — checks-*.js are untouched, awaiting a `--gate` flag — and
// its records are still read by the dashboard. Whoever un-parks it should not have to
// rediscover this.

/** Verdicts `verdictFor` can return. A fourth means both maps below need revisiting. */
export const KNOWN_VERDICTS = ['PROCEED', 'RE_ASK', 'EXIT']

/**
 * The bridge completed whenever it reached a verdict, including a negative one.
 *
 * @returns {string} 'COMPLETE' for any known verdict, 'FAILED' otherwise — an unrecognized
 *   verdict means the gate did not reach a decision, which genuinely is a non-completion.
 */
export function statusForVerdict(verdict) {
  return KNOWN_VERDICTS.includes(verdict) ? 'COMPLETE' : 'FAILED'
}

/**
 * PROCEED advanced the run; RE_ASK and EXIT did not.
 *
 * 'partial' rather than 'failed' for the negative verdicts: the bridge did its job. The run was
 * held back, which is a partial result for the run, not a failure of the stage. Collapsing all
 * three to 'success' (today's `outcome: verdict` after the dashboard coerces it) is what made
 * the RESULT column unable to distinguish a gated run from a clean one.
 */
export function outcomeForVerdict(verdict) {
  if (verdict === 'PROCEED') return 'success'
  if (verdict === 'RE_ASK' || verdict === 'EXIT') return 'partial'
  return 'failed'
}
