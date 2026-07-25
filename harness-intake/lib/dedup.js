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
 * categorizeVerifyIssue — reclassify AC UNCOVERED verify issues as ac-gap:
 * so they're clearly ticket-writing gaps, not harness defects.
 */
export function categorizeVerifyIssue(issue) {
  if (issue.startsWith('verify: AC UNCOVERED:')) {
    return 'ac-gap:' + issue.slice('verify:'.length)
  }
  return issue
}
