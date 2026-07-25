import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chunkAcFilesIntoSubtasks, longestCommonPrefix } from './grouper.js'

// Fixtures
const ISSUE_KEY = 'TARS-1271'
const MIGRATION_PATTERN = 'axios → clientFetch'
const SCOPE_PATH = 'src/client'

const BASE_FLAGS = {
  isMigration: true,
  isCleanup: false,
  isValidation: false,
  isDeferred: false,
}

describe('longestCommonPrefix', () => {
  it('returns common prefix for files in same directory', () => {
    assert.equal(
      longestCommonPrefix(['src/client/foo/a.ts', 'src/client/foo/b.ts', 'src/client/foo/c.ts']),
      'src/client/foo'
    )
  })

  it('returns parent when files span subdirectories', () => {
    assert.equal(
      longestCommonPrefix(['src/client/api/a.ts', 'src/client/hooks/b.ts']),
      'src/client'
    )
  })

  it('returns empty string for single file', () => {
    assert.equal(longestCommonPrefix(['src/client/foo/a.ts']), 'src/client/foo')
  })

  it('returns empty string for empty array', () => {
    assert.equal(longestCommonPrefix([]), '')
  })

  it('does not include the filename in the prefix', () => {
    const prefix = longestCommonPrefix(['src/a.ts', 'src/b.ts'])
    assert.equal(prefix, 'src')
    assert.ok(!prefix.includes('.ts'))
  })
})

describe('chunkAcFilesIntoSubtasks — basic chunking', () => {
  it('returns empty array for empty file list', () => {
    const result = chunkAcFilesIntoSubtasks({
      acBullet: 'Migrate files',
      files: [],
      ...BASE_FLAGS,
    }, ISSUE_KEY, MIGRATION_PATTERN)
    assert.deepEqual(result, [])
  })

  it('produces one subtask for ≤8 files', () => {
    const files = Array.from({ length: 6 }, (_, i) => `src/client/hooks/file${i}.ts`)
    const result = chunkAcFilesIntoSubtasks({
      acBullet: 'Replace axios in hooks',
      files,
      ...BASE_FLAGS,
    }, ISSUE_KEY, MIGRATION_PATTERN)
    assert.equal(result.length, 1)
    assert.deepEqual(result[0].files, files)
  })

  it('produces multiple subtasks for >8 files, max 8 per subtask', () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/client/api/file${String(i).padStart(2,'0')}.ts`)
    const result = chunkAcFilesIntoSubtasks({
      acBullet: 'Replace axios in api',
      files,
      ...BASE_FLAGS,
    }, ISSUE_KEY, MIGRATION_PATTERN)
    assert.equal(result.length, 3)
    assert.ok(result.every(s => s.files.length <= 8))
    assert.equal(result[0].files.length, 8)
    assert.equal(result[1].files.length, 8)
    assert.equal(result[2].files.length, 4)
  })

  it('sorts files alphabetically before chunking', () => {
    const files = ['src/c.ts', 'src/a.ts', 'src/b.ts']
    const result = chunkAcFilesIntoSubtasks({
      acBullet: 'Replace axios',
      files,
      ...BASE_FLAGS,
    }, ISSUE_KEY, MIGRATION_PATTERN)
    assert.deepEqual(result[0].files, ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })
})

describe('chunkAcFilesIntoSubtasks — subtask shape', () => {
  const files = Array.from({ length: 5 }, (_, i) => `src/client/hooks/file${i}.ts`)

  it('targetSize is XS for ≤4 files', () => {
    const f4 = files.slice(0, 4)
    const result = chunkAcFilesIntoSubtasks({ acBullet: 'Replace axios', files: f4, ...BASE_FLAGS }, ISSUE_KEY, MIGRATION_PATTERN)
    assert.equal(result[0].targetSize, 'XS')
  })

  it('targetSize is S for 5-8 files', () => {
    const result = chunkAcFilesIntoSubtasks({ acBullet: 'Replace axios', files, ...BASE_FLAGS }, ISSUE_KEY, MIGRATION_PATTERN)
    assert.equal(result[0].targetSize, 'S')
  })

  it('estimatedFileCount matches files.length', () => {
    const result = chunkAcFilesIntoSubtasks({ acBullet: 'Replace axios', files, ...BASE_FLAGS }, ISSUE_KEY, MIGRATION_PATTERN)
    assert.equal(result[0].estimatedFileCount, files.length)
  })

  it('scopePath is longest common directory prefix', () => {
    const f = ['src/client/hooks/a.ts', 'src/client/hooks/b.ts']
    const result = chunkAcFilesIntoSubtasks({ acBullet: 'Replace axios', files: f, ...BASE_FLAGS }, ISSUE_KEY, MIGRATION_PATTERN)
    assert.equal(result[0].scopePath, 'src/client/hooks')
  })

  it('copies isMigration/isCleanup/isValidation/isDeferred exactly', () => {
    const flags = { isMigration: false, isCleanup: true, isValidation: false, isDeferred: false }
    const result = chunkAcFilesIntoSubtasks({ acBullet: 'Clean up', files, ...flags }, ISSUE_KEY, MIGRATION_PATTERN)
    assert.equal(result[0].isMigration, false)
    assert.equal(result[0].isCleanup, true)
    assert.equal(result[0].isValidation, false)
    assert.equal(result[0].isDeferred, false)
  })

  it('needsReview defaults to false for normal migration chunks', () => {
    const result = chunkAcFilesIntoSubtasks({ acBullet: 'Replace axios', files, ...BASE_FLAGS }, ISSUE_KEY, MIGRATION_PATTERN)
    assert.equal(result[0].needsReview, false)
  })

  it('title includes issueKey and file count', () => {
    const result = chunkAcFilesIntoSubtasks({ acBullet: 'Replace axios', files, ...BASE_FLAGS }, ISSUE_KEY, MIGRATION_PATTERN)
    assert.ok(result[0].title.includes(ISSUE_KEY))
    assert.ok(result[0].title.includes('(' + files.length + ' files)'))
  })

  it('title works without issueKey', () => {
    const result = chunkAcFilesIntoSubtasks({ acBullet: 'Replace axios', files, ...BASE_FLAGS }, null, MIGRATION_PATTERN)
    assert.ok(!result[0].title.startsWith('null'))
    assert.ok(result[0].title.includes('(' + files.length + ' files)'))
  })

  it('title uses part N/M suffix for multi-chunk ACs', () => {
    const manyFiles = Array.from({ length: 16 }, (_, i) => `src/client/api/f${i}.ts`)
    const result = chunkAcFilesIntoSubtasks({ acBullet: 'Replace axios in api', files: manyFiles, ...BASE_FLAGS }, ISSUE_KEY, MIGRATION_PATTERN)
    assert.equal(result.length, 2)
    assert.ok(result[0].title.includes('(1/2)') || result[0].title.includes('part 1'))
    assert.ok(result[1].title.includes('(2/2)') || result[1].title.includes('part 2'))
  })
})

describe('chunkAcFilesIntoSubtasks — multi-directory', () => {
  it('splits into per-directory chunks when files span multiple subdirs', () => {
    const files = [
      ...Array.from({ length: 5 }, (_, i) => `src/client/api/a${i}.ts`),
      ...Array.from({ length: 5 }, (_, i) => `src/client/hooks/b${i}.ts`),
    ]
    const result = chunkAcFilesIntoSubtasks({
      acBullet: 'Replace axios across client',
      files,
      ...BASE_FLAGS,
    }, ISSUE_KEY, MIGRATION_PATTERN)
    // All files covered
    const allOut = result.flatMap(s => s.files)
    assert.deepEqual([...allOut].sort(), [...files].sort())
    // No chunk exceeds 8
    assert.ok(result.every(s => s.files.length <= 8))
  })
})
