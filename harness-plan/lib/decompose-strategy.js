/**
 * Decide which Decompose strategy to use, in priority order:
 *   1. gated-intake-groups — bridge-verified manifest has pre-scoped groups/subtasks
 *   2. llm-decompose       — L or M ticket with no verified manifest (full LLM decompose)
 *   3. manifest-entry      — single subtask entry from a split manifest (harness-split path)
 *   4. skip                — XS or S ticket, single concern, no decompose needed
 *
 * @param {object} args - workflow args (args.gatedIntake)
 * @param {string} size - 'XS' | 'S' | 'M' | 'L'
 * @param {object|null} manifestEntry - single subtask entry or null
 * @returns {'gated-intake-groups' | 'llm-decompose' | 'manifest-entry' | 'skip'}
 */
export function selectDecomposeStrategy(args, size, manifestEntry) {
  if (args?.gatedIntake?.groups?.length) return 'gated-intake-groups'
  if (manifestEntry) return 'manifest-entry'
  if (size === 'L' || size === 'M') return 'llm-decompose'
  return 'skip'
}
