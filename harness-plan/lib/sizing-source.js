// Which object the run trusts for `size` and `files[]`.
//
// This was one inline expression in workflow.js:
//
//   const sizingSource = args.gatedIntake || manifestEntry || null
//
// Correct for the two cases it was written for — a gated manifest alone, or a harness-split
// subtask alone — and wrong for the case that is now the common one. harness-intake's summary
// prints `/harness-plan --intake <manifest> --entry G1-1` per G1 subtask, so both inputs arrive
// together, and the manifest won: a run asked to plan one subtask sized itself off the whole
// ticket. Not a crash — `size` picks the architect model and the file budget, so the run spends
// opus-tier planning on an S concern and hands the researcher the full 92-file scope. Both
// outputs look ordinary.
//
// Manifest supremacy is not in tension with this. Supremacy means a *verified manifest* outranks
// *ticket prose*; it never meant a manifest's aggregate outranks a subtask drawn from that same
// manifest. The subtask is the more specific statement and it came from the manifest.
//
// KEEP IN SYNC with the inline `_selectSizingSource` mirror in workflow.js
// (inline-mirror.test.js enforces it).

/**
 * Merge the named entry and the gated manifest into one sizing view, entry first.
 *
 * Field-by-field rather than whole-object, because the two carry different amounts of detail:
 * an intake subtask has a precise `files[]` and often no size at all, while the manifest has a
 * verified size and the ticket-wide file list. Picking one object wholesale means taking its
 * gaps along with its strengths.
 *
 * @param {object|null} args - workflow args; only `args.gatedIntake` is read
 * @param {object|null} manifestEntry - the subtask named by --entry, or null
 * @returns {{size: string, files: string[], acList: any[]}|null} null when neither is present
 */
export function selectSizingSource(args, manifestEntry) {
  const gated = args && typeof args === 'object' ? args.gatedIntake : null
  const entry = manifestEntry && typeof manifestEntry === 'object' ? manifestEntry : null
  if (!gated && !entry) return null

  // `targetSize` is what harness-intake's subtask schema actually names the field; `size` is the
  // manifest-level and harness-split name. Reading only one of them sends every real intake
  // subtask through to the manifest's ticket-wide size.
  const size = entry?.size || entry?.targetSize || gated?.size || 'S'

  // Absent files[] means unknown — inherit. An explicit [] means known-empty, which is a real
  // answer for a validation or config subtask; inheriting there would hand a researcher the
  // whole ticket to read for a subtask that reads nothing.
  const files = Array.isArray(entry?.files) ? [...entry.files]
    : Array.isArray(gated?.files) ? [...gated.files]
    : []

  const acList = Array.isArray(entry?.acList) ? [...entry.acList]
    : Array.isArray(gated?.acList) ? [...gated.acList]
    : []

  return { size, files, acList }
}
