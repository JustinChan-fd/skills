import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFileConflicts } from './conflict.js'

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
