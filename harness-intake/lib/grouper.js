// Deterministic replacement for the Haiku grouper agent.
// All rules were already complete and unambiguous in the prompt — no model judgment needed.

const CHUNK_SIZE = 8

export function longestCommonPrefix(files) {
  if (!files.length) return ''
  // Work on directory components only (strip filename)
  const dirs = files.map(f => {
    const parts = f.split('/')
    return parts.length > 1 ? parts.slice(0, -1) : []
  })
  if (!dirs[0].length) return ''
  const minLen = Math.min(...dirs.map(d => d.length))
  let i = 0
  while (i < minLen && dirs.every(d => d[i] === dirs[0][i])) i++
  return dirs[0].slice(0, i).join('/') || ''
}

// Build a human-readable directory label from a file list (e.g. "src/client/hooks")
function _dirLabel(files) {
  const prefix = longestCommonPrefix(files)
  if (prefix) return prefix
  // Fallback: immediate parent of first file
  const parts = files[0].split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '.'
}

// Derive a short verb from the AC bullet (first meaningful word after common prepositions)
function _verbFromAc(acBullet) {
  const s = String(acBullet).trim().toLowerCase()
  // Common leading words to skip
  const skip = new Set(['all', 'the', 'a', 'an', 'in', 'for', 'of', 'and', 'or', 'to'])
  const words = s.split(/\s+/).filter(w => w.length > 0)
  for (const w of words) {
    if (!skip.has(w)) return w.charAt(0).toUpperCase() + w.slice(1)
  }
  return 'Migrate'
}

export function chunkAcFilesIntoSubtasks(acResult, issueKey, migrationPattern) {
  const { acBullet, files = [], isMigration, isCleanup, isValidation, isDeferred } = acResult
  if (!files.length) return []

  const sorted = [...files].sort()
  const chunks = []
  for (let i = 0; i < sorted.length; i += CHUNK_SIZE) {
    chunks.push(sorted.slice(i, i + CHUNK_SIZE))
  }

  const prefix = issueKey ? `${issueKey}: ` : ''
  const verb = _verbFromAc(acBullet)
  const isMulti = chunks.length > 1

  return chunks.map((chunk, idx) => {
    const dir = _dirLabel(chunk)
    const partSuffix = isMulti ? ` (${idx + 1}/${chunks.length})` : ''
    const title = `${prefix}${verb} ${dir} (${chunk.length} files)${partSuffix}`
    const patternNote = migrationPattern ? ` using ${migrationPattern}` : ''
    const description = `${acBullet}. Migrate ${chunk.length} file(s) in ${dir}${patternNote}: ${chunk.join(', ')}`
    return {
      title,
      description,
      scopePath: longestCommonPrefix(chunk) || dir,
      files: chunk,
      estimatedFileCount: chunk.length,
      targetSize: chunk.length <= 4 ? 'XS' : 'S',
      isMigration: !!isMigration,
      isCleanup: !!isCleanup,
      isValidation: !!isValidation,
      isDeferred: !!isDeferred,
      needsReview: false,
    }
  })
}
