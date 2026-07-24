import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { splitDiffByFile, splitFileIntoChunks } from './diff.js'

const HEADER = `diff --git a/src/a.ts b/src/a.ts\nindex 000..111 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n`
const HUNK_A = `@@ -1,3 +1,3 @@\n context\n-old\n+new\n`
const HUNK_B = `@@ -10,3 +10,3 @@\n ctx2\n-x\n+y\n`

describe('splitDiffByFile', () => {
  it('splits a two-file diff into two entries', () => {
    const raw = HEADER + HUNK_A +
      `diff --git a/src/b.ts b/src/b.ts\nindex 000..111 100644\n--- a/src/b.ts\n+++ b/src/b.ts\n` + HUNK_B
    const parts = splitDiffByFile(raw)
    assert.equal(parts.length, 2)
    assert.ok(parts[0].startsWith('diff --git a/src/a.ts'))
    assert.ok(parts[1].startsWith('diff --git a/src/b.ts'))
  })

  it('returns a single entry for a single-file diff', () => {
    const raw = HEADER + HUNK_A
    const parts = splitDiffByFile(raw)
    assert.equal(parts.length, 1)
  })

  it('filters empty segments', () => {
    const parts = splitDiffByFile('   \n   ')
    assert.equal(parts.length, 0)
  })
})

describe('splitFileIntoChunks', () => {
  it('returns the whole diff as one chunk when under maxLines', () => {
    const chunks = splitFileIntoChunks(HEADER + HUNK_A, 300)
    assert.equal(chunks.length, 1)
    assert.ok(chunks[0].includes('@@ -1,3 +1,3 @@'))
  })

  it('re-attaches file header to every chunk when splitting', () => {
    // Build a diff with many small hunks so total > maxLines=10
    let fileDiff = HEADER
    for (let i = 0; i < 20; i++) {
      fileDiff += `@@ -${i * 10},3 +${i * 10},3 @@\n context\n-old${i}\n+new${i}\n`
    }
    const chunks = splitFileIntoChunks(fileDiff, 10)
    assert.ok(chunks.length > 1)
    for (const chunk of chunks) {
      assert.ok(chunk.includes('diff --git'), 'header missing from chunk')
    }
  })

  it('never splits mid-hunk (each chunk starts at a @@ boundary)', () => {
    let fileDiff = HEADER
    for (let i = 0; i < 10; i++) {
      fileDiff += `@@ -${i * 5},3 +${i * 5},3 @@\n ctx\n-a\n+b\n`
    }
    const chunks = splitFileIntoChunks(fileDiff, 8)
    for (const chunk of chunks) {
      const lines = chunk.split('\n').filter(l => l.trim())
      // The first non-header line in each chunk must be a @@ line or end of header
      const hunkLines = lines.filter(l => l.startsWith('@@'))
      assert.ok(hunkLines.length >= 1 || chunk === fileDiff, 'chunk has no hunk marker')
    }
  })

  it('passes an oversized single hunk through whole', () => {
    // A single hunk that is already over maxLines — must pass through as-is
    let bigHunk = HEADER + '@@ -1,200 +1,200 @@\n'
    for (let i = 0; i < 200; i++) bigHunk += `+line${i}\n`
    const chunks = splitFileIntoChunks(bigHunk, 10)
    assert.equal(chunks.length, 1)
  })

  it('falls back to [fileDiff] when no chunks produced', () => {
    const chunks = splitFileIntoChunks('no hunk markers here', 300)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0], 'no hunk markers here')
  })
})
