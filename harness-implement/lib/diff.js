// Diff helpers — verbatim from harness-implement/workflow.js:236-262
// Split an accumulated diff into per-file chunks, then sub-chunk each file by
// hunk boundaries (never mid-hunk). Single oversized hunks pass through whole.

export function splitDiffByFile(rawDiff) {
  return rawDiff.split(/(?=^diff --git )/m).filter(s => s.trim().length > 0)
}

export function splitFileIntoChunks(fileDiff, maxLines = 300) {
  const lines = fileDiff.split('\n')
  // Separate file header (diff --git, index, ---, +++) from hunk bodies
  const firstHunkIdx = lines.findIndex(l => l.startsWith('@@'))
  const header = firstHunkIdx > 0 ? lines.slice(0, firstHunkIdx).join('\n') + '\n' : ''
  const body = firstHunkIdx > 0 ? lines.slice(firstHunkIdx).join('\n') : fileDiff

  const hunks = body.split(/(?=^@@ )/m).filter(s => s.trim().length > 0)
  const chunks = []
  let current = header

  for (const hunk of hunks) {
    const projected = current + hunk
    if (current !== header && projected.split('\n').length > maxLines) {
      chunks.push(current)
      current = header + hunk  // re-attach file header so reviewer has context
    } else {
      current = projected
    }
  }
  if (current !== header) chunks.push(current)
  return chunks.length > 0 ? chunks : [fileDiff]
}
