/**
 * Decide which Decompose strategy to use, in priority order:
 *   1. manifest-entry      — the caller named ONE subtask with --entry; plan only that
 *   2. gated-intake-groups — an intake manifest with pre-scoped groups and no entry named
 *   3. llm-decompose       — L or M ticket with no manifest at all (full LLM decompose)
 *   4. skip                — XS or S ticket, single concern, no decompose needed
 *
 * Why manifest-entry is first (2026-07-27): an entry is an explicit narrowing instruction from
 * the caller; a manifest that merely carries groups is not. harness-intake's summary now prints
 * one `--intake <manifest> --entry G1-1` per G1 subtask, so both arrive together on the common
 * path. With groups checked first that command fans out over every group in the manifest and
 * silently ignores `--entry` — an L ticket plans ~20 subtasks instead of the one asked for. It
 * does not fail; it does the wrong work at 20× the cost.
 *
 * The old ordering was not wrong when written: the only source of a manifestEntry was
 * `--manifest` from harness-split (now DEPRECATED), which never carried a gated intake, so the
 * two inputs could not co-occur.
 *
 * @param {object} args - workflow args (args.gatedIntake)
 * @param {string} size - 'XS' | 'S' | 'M' | 'L'
 * @param {object|null} manifestEntry - the single subtask named by --entry, or null
 * @returns {'manifest-entry' | 'gated-intake-groups' | 'llm-decompose' | 'skip'}
 */
export function selectDecomposeStrategy(args, size, manifestEntry) {
  if (manifestEntry) return 'manifest-entry'
  if (args?.gatedIntake?.groups?.length) return 'gated-intake-groups'
  if (size === 'L' || size === 'M') return 'llm-decompose'
  return 'skip'
}
