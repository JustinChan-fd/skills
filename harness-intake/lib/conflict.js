/**
 * resolveFileConflicts — deterministic file conflict resolution for grouper drafts.
 *
 * Replaces the Opus design:coordinator agent for the mechanical part of its job:
 * assigning conflicting files to the "most specific" subtask.
 *
 * Rules (applied in order):
 *   1. Empty-file stubs (isDeferred/isValidation) pass through unchanged.
 *   2. Merge pairs where both sides share >80% of the LARGER set's files —
 *      i.e. intersection / max(|A|, |B|) > 0.8 (near-duplicate grouper batches).
 *      Must run BEFORE conflict resolution so shared files haven't been stripped yet.
 *   3. Sort by specificity descending: scopePath length desc, then file count asc (tie-break).
 *   4. First-seen subtask claims a file; all later subtasks that contain the same file lose it.
 *   5. Adjust estimatedFileCount after removals.
 *   6. Drop subtasks whose file list became empty (unless they were already empty stubs).
 */
export function resolveFileConflicts(drafts) {
  if (drafts.length === 0) return []

  // Separate stubs (no files) from real subtasks — stubs always survive
  const stubs = drafts.filter(s => (s.files || []).length === 0)
  const real  = drafts.filter(s => (s.files || []).length > 0)

  if (real.length === 0) return stubs

  // Step 1: merge near-duplicate pairs on ORIGINAL file lists (before any files are stripped)
  const merged = _mergeHighOverlap(real)

  // Step 2: sort by specificity: longer scopePath wins; tie-break on fewer files (less greedy)
  const sorted = [...merged].sort((a, b) => {
    const lenDiff = (b.scopePath || '').length - (a.scopePath || '').length
    if (lenDiff !== 0) return lenDiff
    return (a.files || []).length - (b.files || []).length
  })

  // Step 3: claim files in specificity order — first claimer wins
  const claimed = new Set()
  const resolved = sorted.map(s => {
    const kept = (s.files || []).filter(f => !claimed.has(f))
    for (const f of kept) claimed.add(f)
    return { ...s, files: kept, estimatedFileCount: kept.length }
  })

  // Step 4: drop subtasks that became empty after conflict resolution
  const nonEmpty = resolved.filter(s => s.files.length > 0)

  return [...nonEmpty, ...stubs]
}

function _mergeHighOverlap(subtasks) {
  const result = []
  const absorbed = new Set()

  for (let i = 0; i < subtasks.length; i++) {
    if (absorbed.has(i)) continue
    let current = subtasks[i]

    for (let j = i + 1; j < subtasks.length; j++) {
      if (absorbed.has(j)) continue
      const a = new Set(current.files)
      const b = new Set(subtasks[j].files)
      const intersection = [...a].filter(f => b.has(f)).length
      const union = new Set([...a, ...b]).size
      // Ratio: intersection over max(|A|, |B|) — both sides must be >80% shared.
      // intersection/union skews toward 1 only when sets are nearly identical in size,
      // which would silently skip A ⊂ B cases we do want to merge.
      const maxSize = Math.max(a.size, b.size)
      const overlapRatio = maxSize === 0 ? 0 : intersection / maxSize
      if (overlapRatio > 0.8) {
        // Merge: union of files, longer title (more descriptive), preserve flags from current
        const unionFiles = [...new Set([...current.files, ...subtasks[j].files])]
        const title = current.title.length >= subtasks[j].title.length ? current.title : subtasks[j].title
        current = { ...current, title, files: unionFiles, estimatedFileCount: unionFiles.length }
        absorbed.add(j)
      }
    }

    result.push(current)
  }

  return result
}

/**
 * isAcFilesCoveredByExisting — returns true when ≥50% of acFiles are already
 * assigned to existing subtasks.
 *
 * Used by post-verify stub injection to prevent duplicate-file stubs when the
 * grouper mislabeled a subtask (e.g. bare-fetch files titled as "axios" subtasks)
 * and AC verify flags the AC as missing even though its files are already covered.
 *
 * Returns false when acFiles is empty (no files → not covered, stub may still be warranted).
 */
export function isAcFilesCoveredByExisting(acFiles, existingSubtasks) {
  if (!acFiles || acFiles.length === 0) return false
  const existingFileSet = new Set(existingSubtasks.flatMap(s => s.files || []))
  const covered = acFiles.filter(f => existingFileSet.has(f)).length
  return covered / acFiles.length >= 0.5
}

// propagateManifestFields — ensures each subtask carries migrationPattern and size
// directly, so harness-plan's manifestEntry fast path gets them without reading
// the top-level splitManifest. Does not overwrite values already set on the subtask.
export function propagateManifestFields(subtasks, migrationPattern, size) {
  for (const s of subtasks) {
    if (!s.migrationPattern && migrationPattern) s.migrationPattern = migrationPattern
    if (!s.size) s.size = s.targetSize || size
  }
}
