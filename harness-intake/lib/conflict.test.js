import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFileConflicts, isAcFilesCoveredByExisting, propagateManifestFields } from './conflict.js'

describe('resolveFileConflicts', () => {
  it('passes through non-overlapping subtasks unchanged', () => {
    const drafts = [
      { title: 'Migrate src/client/api.js', scopePath: 'src/client', files: ['src/client/api.js', 'src/client/fetch.js'], estimatedFileCount: 2, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
      { title: 'Migrate src/server/api.js', scopePath: 'src/server', files: ['src/server/api.js', 'src/server/fetch.js'], estimatedFileCount: 2, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
    ]
    const result = resolveFileConflicts(drafts)
    assert.equal(result.length, 2)
    assert.equal(result[0].files.length, 2)
    assert.equal(result[1].files.length, 2)
    assert.deepEqual(result.flatMap(s => s.files).sort(), ['src/client/api.js', 'src/client/fetch.js', 'src/server/api.js', 'src/server/fetch.js'])
  })

  it('assigns a conflicting file to the subtask with the longer scopePath (more specific)', () => {
    const drafts = [
      { title: 'Migrate src/client/middleware', scopePath: 'src/client/middleware', files: ['src/client/middleware/auth.js', 'src/client/middleware/index.js'], estimatedFileCount: 2, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
      { title: 'Migrate src/client', scopePath: 'src/client', files: ['src/client/middleware/auth.js', 'src/client/api.js'], estimatedFileCount: 2, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
    ]
    const result = resolveFileConflicts(drafts)
    // auth.js conflicts — middleware (longer scopePath) wins
    const middleware = result.find(s => s.scopePath === 'src/client/middleware')
    const client     = result.find(s => s.scopePath === 'src/client')
    assert.ok(middleware.files.includes('src/client/middleware/auth.js'), 'specific subtask keeps auth.js')
    assert.ok(!client.files.includes('src/client/middleware/auth.js'), 'broad subtask loses auth.js')
    // non-conflicting files unchanged
    assert.ok(middleware.files.includes('src/client/middleware/index.js'))
    assert.ok(client.files.includes('src/client/api.js'))
  })

  it('adjusts estimatedFileCount after removing a conflicting file', () => {
    const drafts = [
      { title: 'Specific', scopePath: 'src/client/middleware', files: ['src/client/middleware/auth.js'], estimatedFileCount: 1, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
      { title: 'Broad',    scopePath: 'src/client',           files: ['src/client/middleware/auth.js', 'src/client/api.js'], estimatedFileCount: 2, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
    ]
    const result = resolveFileConflicts(drafts)
    const broad = result.find(s => s.title === 'Broad')
    assert.equal(broad.estimatedFileCount, 1)  // one file removed
    assert.equal(broad.files.length, 1)
  })

  it('drops a subtask that becomes empty after conflict resolution', () => {
    const drafts = [
      { title: 'Specific', scopePath: 'src/client/middleware', files: ['src/client/middleware/auth.js', 'src/client/middleware/index.js'], estimatedFileCount: 2, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
      // All files of Broad are already claimed by Specific
      { title: 'Broad',    scopePath: 'src/client',           files: ['src/client/middleware/auth.js', 'src/client/middleware/index.js'], estimatedFileCount: 2, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
    ]
    const result = resolveFileConflicts(drafts)
    assert.equal(result.length, 1)
    assert.equal(result[0].title, 'Specific')
  })

  it('keeps empty-file stubs (isDeferred/isValidation) regardless of file conflicts', () => {
    const drafts = [
      { title: 'Add AbortController', scopePath: 'src/client', files: [], estimatedFileCount: 0, isMigration: false, isCleanup: false, isValidation: false, isDeferred: true },
      { title: 'Verify npm install',  scopePath: '',            files: [], estimatedFileCount: 0, isMigration: false, isCleanup: false, isValidation: true, isDeferred: false },
    ]
    const result = resolveFileConflicts(drafts)
    assert.equal(result.length, 2)
  })

  it('tie-breaks on fewer files (less greedy) when scopePathLengths are equal', () => {
    const drafts = [
      { title: 'Small', scopePath: 'src/a', files: ['src/a/shared.js', 'src/a/one.js'], estimatedFileCount: 2, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
      { title: 'Large', scopePath: 'src/b', files: ['src/a/shared.js', 'src/b/two.js', 'src/b/three.js', 'src/b/four.js'], estimatedFileCount: 4, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
    ]
    // Same scopePath length (5 chars each: 'src/a' vs 'src/b') — tie-break on fewer files wins
    const result = resolveFileConflicts(drafts)
    const small = result.find(s => s.title === 'Small')
    const large = result.find(s => s.title === 'Large')
    assert.ok(small.files.includes('src/a/shared.js'), 'smaller subtask keeps shared.js')
    assert.ok(!large.files.includes('src/a/shared.js'), 'larger subtask loses shared.js')
  })

  it('merges two subtasks with >80% file overlap into one', () => {
    const drafts = [
      { title: 'Migrate axios in src/client (8 files)', scopePath: 'src/client', files: ['a.js','b.js','c.js','d.js','e.js','f.js','g.js','h.js'], estimatedFileCount: 8, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
      // 7/8 files = 87.5% overlap — should merge
      { title: 'Migrate axios in src/client (continued)', scopePath: 'src/client', files: ['a.js','b.js','c.js','d.js','e.js','f.js','g.js','x.js'], estimatedFileCount: 8, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
    ]
    const result = resolveFileConflicts(drafts)
    assert.equal(result.length, 1)
    // Union of files: a-h + x = 9 files
    assert.equal(result[0].files.length, 9)
    assert.equal(result[0].estimatedFileCount, 9)
  })

  it('does NOT merge two subtasks with 80% or less file overlap', () => {
    const drafts = [
      { title: 'A', scopePath: 'src/a', files: ['f1.js','f2.js','f3.js','f4.js','f5.js'], estimatedFileCount: 5, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
      // 4/5 = 80% — at threshold, should NOT merge
      { title: 'B', scopePath: 'src/b', files: ['f1.js','f2.js','f3.js','f4.js','g1.js'], estimatedFileCount: 5, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
    ]
    const result = resolveFileConflicts(drafts)
    // 80% is not > 80%, so no merge — but conflict resolution still assigns f1-f4 to one
    // (A has shorter scopePath length here — both equal so tie-break on file count — both equal — first wins)
    assert.equal(result.length, 2)
  })

  it('preserves all non-file fields on survivors', () => {
    const drafts = [
      { title: 'A', scopePath: 'src/client/middleware', files: ['auth.js'], estimatedFileCount: 1, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false, needsReview: false, targetSize: 'XS', description: 'desc A' },
      { title: 'B', scopePath: 'src/client',           files: ['auth.js', 'api.js'], estimatedFileCount: 2, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false, needsReview: true, targetSize: 'S', description: 'desc B' },
    ]
    const result = resolveFileConflicts(drafts)
    const a = result.find(s => s.title === 'A')
    const b = result.find(s => s.title === 'B')
    assert.equal(a.isMigration, true)
    assert.equal(a.needsReview, false)
    assert.equal(a.description, 'desc A')
    assert.equal(b.isMigration, true)
    assert.equal(b.needsReview, true)
    assert.equal(b.description, 'desc B')
  })

  it('passes through empty input', () => {
    assert.deepEqual(resolveFileConflicts([]), [])
  })

  it('single subtask passes through unchanged', () => {
    const drafts = [
      { title: 'Only', scopePath: 'src/client', files: ['a.js', 'b.js'], estimatedFileCount: 2, isMigration: true, isCleanup: false, isValidation: false, isDeferred: false },
    ]
    const result = resolveFileConflicts(drafts)
    assert.equal(result.length, 1)
    assert.deepEqual(result[0].files, ['a.js', 'b.js'])
  })
})

describe('isAcFilesCoveredByExisting', () => {
  const sub = (files) => ({ files })

  it('returns true when all AC files are in existing subtasks (100% overlap)', () => {
    const acFiles = ['a.js', 'b.js', 'c.js']
    const existing = [sub(['a.js', 'b.js']), sub(['c.js', 'd.js'])]
    assert.equal(isAcFilesCoveredByExisting(acFiles, existing), true)
  })

  it('returns true when exactly 50% of AC files are covered (at threshold)', () => {
    const acFiles = ['a.js', 'b.js']
    const existing = [sub(['a.js', 'x.js'])]
    assert.equal(isAcFilesCoveredByExisting(acFiles, existing), true)
  })

  it('returns false when fewer than 50% of AC files are covered', () => {
    const acFiles = ['a.js', 'b.js', 'c.js', 'd.js']
    const existing = [sub(['a.js'])]  // 1/4 = 25%
    assert.equal(isAcFilesCoveredByExisting(acFiles, existing), false)
  })

  it('returns false for empty acFiles (no files → not covered)', () => {
    const existing = [sub(['a.js', 'b.js'])]
    assert.equal(isAcFilesCoveredByExisting([], existing), false)
  })

  it('returns false for null acFiles', () => {
    const existing = [sub(['a.js'])]
    assert.equal(isAcFilesCoveredByExisting(null, existing), false)
  })

  it('returns false when existing subtasks have no files', () => {
    const acFiles = ['a.js', 'b.js']
    const existing = [sub([]), sub([])]
    assert.equal(isAcFilesCoveredByExisting(acFiles, existing), false)
  })

  it('returns false when existing subtasks list is empty', () => {
    const acFiles = ['a.js', 'b.js']
    assert.equal(isAcFilesCoveredByExisting(acFiles, []), false)
  })

  it('handles subtasks with missing files field gracefully', () => {
    const acFiles = ['a.js', 'b.js']
    const existing = [{ title: 'no files field' }]
    assert.equal(isAcFilesCoveredByExisting(acFiles, existing), false)
  })

  it('correctly models the run-14 failure: bare-fetch files titled as axios subtasks', () => {
    // The grouper titled the subtask "Replace axios with clientFetch" but the files
    // are actually bare-fetch files. AC verify flags "Replace bare fetch() calls" as
    // missing. Without the overlap check, 4 duplicate stubs get injected.
    const bareFetchFiles = ['src/client/hooks/useCelebritySearch.js', 'src/client/pages/ems/_shared/hooks/useEditorArray.js']
    const existing = [
      sub(['src/client/hooks/useCelebritySearch.js', 'src/client/pages/ems/_shared/hooks/useEditorArray.js', 'src/client/api.js']),
    ]
    // Both bare-fetch files already exist in the mislabeled subtask → covered
    assert.equal(isAcFilesCoveredByExisting(bareFetchFiles, existing), true)
  })
})

describe('propagateManifestFields', () => {
  it('sets migrationPattern on subtasks that are missing it', () => {
    const subtasks = [{ groupId: 'G1', targetSize: 'S', isMigration: true }]
    propagateManifestFields(subtasks, 'axios → clientFetch', 'L')
    assert.equal(subtasks[0].migrationPattern, 'axios → clientFetch')
  })

  it('sets size from targetSize when size is missing', () => {
    const subtasks = [{ groupId: 'G1', targetSize: 'S' }]
    propagateManifestFields(subtasks, 'axios → clientFetch', 'L')
    assert.equal(subtasks[0].size, 'S')
  })

  it('falls back to top-level size when targetSize is also missing', () => {
    const subtasks = [{ groupId: 'G1' }]
    propagateManifestFields(subtasks, 'axios → clientFetch', 'L')
    assert.equal(subtasks[0].size, 'L')
  })

  it('does not overwrite migrationPattern already set on a subtask', () => {
    const subtasks = [{ groupId: 'G1', targetSize: 'S', migrationPattern: 'existing' }]
    propagateManifestFields(subtasks, 'axios → clientFetch', 'L')
    assert.equal(subtasks[0].migrationPattern, 'existing')
  })

  it('does not overwrite size already set on a subtask', () => {
    const subtasks = [{ groupId: 'G1', size: 'XS', targetSize: 'S' }]
    propagateManifestFields(subtasks, 'axios → clientFetch', 'L')
    assert.equal(subtasks[0].size, 'XS')
  })

  it('handles empty subtasks array without error', () => {
    assert.doesNotThrow(() => propagateManifestFields([], 'axios → clientFetch', 'L'))
  })

  it('propagates across all subtasks in one call', () => {
    const subtasks = [
      { groupId: 'G1', targetSize: 'S' },
      { groupId: 'G1', targetSize: 'XS' },
      { groupId: 'G2', targetSize: 'S' },
    ]
    propagateManifestFields(subtasks, 'axios → clientFetch', 'L')
    assert.ok(subtasks.every(s => s.migrationPattern === 'axios → clientFetch'))
    assert.deepEqual(subtasks.map(s => s.size), ['S', 'XS', 'S'])
  })
})
