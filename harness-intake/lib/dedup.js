/**
 * toRelPath — strip an absolute repo-root prefix from a file path.
 * If absPrefix is null/empty or the path doesn't start with it, returns f unchanged.
 * Used to normalize grouper and coordinator output to repo-relative paths before dedup.
 */
export function toRelPath(f, absPrefix) {
  if (!absPrefix || !f) return f
  return f.startsWith(absPrefix) ? f.slice(absPrefix.length) : f
}

/**
 * makeAbsPrefix — build the prefix string from a repoPath for use with toRelPath.
 * Returns null if repoPath is falsy.
 */
export function makeAbsPrefix(repoPath) {
  if (!repoPath) return null
  return String(repoPath).replace(/\/$/, '') + '/'
}

/**
 * dedupeByFileSet — merge subtasks with identical sorted file arrays.
 * Keeps the subtask whose title is shorter (broader scope wins).
 * Subtasks with empty/absent file lists are always kept as-is.
 */
export function dedupeByFileSet(subtasks) {
  const seenKeys = new Map()  // fileKey → index in result
  const result = []
  for (const s of subtasks) {
    const files = s.files || []
    if (files.length === 0) { result.push(s); continue }
    const key = files.slice().sort().join('|')
    if (seenKeys.has(key)) {
      const idx = seenKeys.get(key)
      if (s.title.length < result[idx].title.length) {
        result[idx] = { ...result[idx], title: s.title }
      }
    } else {
      seenKeys.set(key, result.length)
      result.push(s)
    }
  }
  return result
}

/**
 * dedupeByOverlapRatio — drop subtasks whose file set overlaps ≥50% with already-seen files.
 * Sorted by scopePath length desc before processing so the most-specific subtask wins.
 * Optional absPrefix: normalize absolute paths to relative before comparison (handles
 * coordinator emitting absolute paths when grouper input was normalized to relative).
 */
export function dedupeByOverlapRatio(subtasks, absPrefix) {
  const sorted = [...subtasks].sort((a, b) => (b.scopePath || '').length - (a.scopePath || '').length)
  const seen = new Set()
  const result = []
  for (const s of sorted) {
    const rawFiles = s.files || []
    if (rawFiles.length === 0) { result.push(s); continue }
    const files = absPrefix ? rawFiles.map(f => toRelPath(f, absPrefix)) : rawFiles
    const sf = new Set(files)
    const overlap = [...sf].filter(f => seen.has(f)).length / sf.size
    if (overlap < 0.5) {
      // Write normalized paths back so downstream dedup sees consistent relative paths
      result.push(absPrefix ? { ...s, files } : s)
      for (const f of sf) seen.add(f)
    }
  }
  return result
}

/**
 * collapseDeferred — collapse multiple isDeferred grouper chunks into one stub.
 * The grouper's "chunk at 8" rule turns a deferred AC (e.g. AbortController) with many
 * research-found files into dozens of non-overlapping 8-file batches that saturate the
 * coordinator. Deferred ACs describe feature additions, not file-by-file migrations —
 * they need one stub (files=[], needsReview=true) not N chunked batches.
 */
export function collapseDeferred(drafts) {
  const nonDeferred = drafts.filter(s => !s.isDeferred)
  const deferred    = drafts.filter(s => s.isDeferred)
  if (deferred.length === 0) return nonDeferred
  // Pick representative: shortest title (broadest description), preserve all other flags
  const rep = deferred.reduce((a, b) => a.title.length <= b.title.length ? a : b)
  return [...nonDeferred, { ...rep, files: [], estimatedFileCount: 0 }]
}

/**
 * capCoordinatorInput — hard backstop: trim to at most `max` drafts.
 * Sorts by scopePath length desc (most-specific wins) before trimming so the
 * narrowest, highest-confidence subtasks survive.
 * Default cap: 20.
 */
export function capCoordinatorInput(drafts, max = 20) {
  if (drafts.length <= max) return drafts
  return [...drafts]
    .sort((a, b) => (b.scopePath || '').length - (a.scopePath || '').length)
    .slice(0, max)
}

/**
 * categorizeVerifyIssue — reclassify AC UNCOVERED verify issues as ac-gap:
 * so they're clearly ticket-writing gaps, not harness defects.
 */
export function categorizeVerifyIssue(issue) {
  if (issue.startsWith('verify: AC UNCOVERED:')) {
    return 'ac-gap:' + issue.slice('verify:'.length)
  }
  return issue
}
