const FILE_BUDGET_CAP = 8

/**
 * Convert gated-intake manifest groups into decompose concerns.
 * Each subtask becomes one concern — files pre-scoped, questions derived from description.
 * Called in harness-plan Decompose when args.gatedIntake.groups is present.
 *
 * @param {Array} groups - gatedIntake.groups from the intake manifest
 * @param {string} repoPath - absolute path to repo (for prefixing relative file paths)
 * @param {string|null} globalMigrationPattern - fallback when subtask.migrationPattern absent
 * @returns {Array} decomposeConcerns[]
 */
export function buildDecomposeConcernsFromGroups(groups, repoPath, globalMigrationPattern) {
  const concerns = []
  for (const group of groups) {
    for (const subtask of (group.subtasks || [])) {
      const pattern = subtask.migrationPattern || globalMigrationPattern || 'this change'
      const rawFiles = subtask.files || []
      const absFiles = rawFiles.map(f => f.startsWith('/') ? f : `${repoPath}/${f}`)

      const questions = [
        `What is the exact before/after pattern for "${pattern}"? Show a concrete 3-5 line code snippet for BEFORE and AFTER.`,
        `For each file in the list, confirm the pattern exists (grep first) and list every call site by line number.`,
        `Are there any files in the list with unusual call shapes that don't fit the main migration pattern (extra args, different error handling, multiple call sites with different shapes)?`,
      ]
      if (subtask.description) {
        questions.push(`Context from intake: ${subtask.description}`)
      }

      const totalFiles = absFiles.length
      concerns.push({
        label:            subtask.title || `${subtask.groupId || group.groupId}-${concerns.length + 1}`,
        filesToRead:      absFiles.slice(0, FILE_BUDGET_CAP),
        fileBudget:       Math.min(totalFiles, FILE_BUDGET_CAP),
        questions,
        scopePath:        subtask.scopePath || null,
        migrationPattern: pattern,
        groupId:          subtask.groupId || group.groupId || null,
        isDeferred:       subtask.isDeferred || false,
      })
    }
  }
  return concerns
}

/**
 * Build the dependsOn wiring for manifest plan entries based on groupId boundaries.
 * Within a group: all entries are parallel (dependsOn: []).
 * Across groups: the first entry of each new group depends on the last entry of the prior group.
 *
 * @param {Array} entries - planEntries with { suffix, concern: { groupId? } }
 * @returns {Array} - same entries annotated with { id, suffix, dependsOn: string[] }
 */
export function buildManifestDependsOn(entries) {
  if (!entries.length) return []

  // Track last suffix seen per group so next group can depend on it
  const lastSuffixByGroup = {}
  // Track which group each entry belongs to
  const entryGroups = entries.map(e => e.concern?.groupId || null)

  // Find the unique ordered sequence of groups
  const seenGroups = []
  for (const g of entryGroups) {
    if (g !== null && !seenGroups.includes(g)) seenGroups.push(g)
  }

  // Build result: for each entry, find the last suffix of the immediately preceding group
  const result = []
  const groupLastSuffix = {}  // groupId → last suffix written into that group so far

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const groupId = entryGroups[i]
    const groupIdx = groupId !== null ? seenGroups.indexOf(groupId) : -1

    let dependsOn = []
    if (groupId !== null && groupIdx > 0) {
      // This entry belongs to a group that is not the first group.
      // Only the first entry of this group gets a dep on the prior group.
      // Subsequent entries within the same group are parallel (no dep).
      const isFirstEntryOfGroup = !groupLastSuffix[groupId]
      if (isFirstEntryOfGroup) {
        const priorGroupId = seenGroups[groupIdx - 1]
        const priorLastSuffix = groupLastSuffix[priorGroupId]
        if (priorLastSuffix) dependsOn = [priorLastSuffix]
      }
    }

    // Update the last suffix seen for this group
    if (groupId !== null) groupLastSuffix[groupId] = e.suffix

    result.push({ ...e, id: e.suffix, dependsOn })
  }

  return result
}
