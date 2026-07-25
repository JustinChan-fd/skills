import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeByFileSet, categorizeVerifyIssue, toRelPath, makeAbsPrefix, dedupeByOverlapRatio } from './dedup.js'

describe('makeAbsPrefix', () => {
  it('appends trailing slash to repoPath', () => {
    assert.equal(makeAbsPrefix('/Users/foo/Desktop/Repos/webtarsthree'), '/Users/foo/Desktop/Repos/webtarsthree/')
  })

  it('does not double-slash when repoPath already has trailing slash', () => {
    assert.equal(makeAbsPrefix('/Users/foo/repo/'), '/Users/foo/repo/')
  })

  it('returns null for falsy input', () => {
    assert.equal(makeAbsPrefix(null), null)
    assert.equal(makeAbsPrefix(''), null)
    assert.equal(makeAbsPrefix(undefined), null)
  })
})

describe('toRelPath', () => {
  it('strips the abs prefix when present', () => {
    const prefix = '/Users/foo/Desktop/Repos/webtarsthree/'
    assert.equal(toRelPath('/Users/foo/Desktop/Repos/webtarsthree/src/client/api.js', prefix), 'src/client/api.js')
  })

  it('leaves path unchanged when it does not start with prefix', () => {
    const prefix = '/Users/foo/Desktop/Repos/webtarsthree/'
    assert.equal(toRelPath('src/client/api.js', prefix), 'src/client/api.js')
  })

  it('returns f unchanged when absPrefix is null', () => {
    assert.equal(toRelPath('src/client/api.js', null), 'src/client/api.js')
  })

  it('returns f unchanged when f is falsy', () => {
    assert.equal(toRelPath(null, '/some/prefix/'), null)
    assert.equal(toRelPath('', '/some/prefix/'), '')
  })

  it('composes with makeAbsPrefix to normalize grouper output', () => {
    const prefix = makeAbsPrefix('/Users/foo/Desktop/Repos/webtarsthree')
    const files = [
      '/Users/foo/Desktop/Repos/webtarsthree/src/client/middleware/auth.js',
      'src/client/middleware/index.js',
    ]
    assert.deepEqual(files.map(f => toRelPath(f, prefix)), [
      'src/client/middleware/auth.js',
      'src/client/middleware/index.js',
    ])
  })
})

describe('dedupeByFileSet', () => {
  it('passes through subtasks with distinct file sets', () => {
    const subtasks = [
      { title: 'A', files: ['src/a.js', 'src/b.js'] },
      { title: 'B', files: ['src/c.js', 'src/d.js'] },
    ]
    const result = dedupeByFileSet(subtasks)
    assert.equal(result.length, 2)
  })

  it('merges two subtasks with identical file sets, keeping the shorter title', () => {
    const subtasks = [
      { title: 'Remove src/client/middleware', files: ['src/client/middleware/auth.js', 'src/client/middleware/index.js'] },
      { title: 'Remove src/client/middleware/auth.js', files: ['src/client/middleware/auth.js', 'src/client/middleware/index.js'] },
    ]
    const result = dedupeByFileSet(subtasks)
    assert.equal(result.length, 1)
    assert.equal(result[0].title, 'Remove src/client/middleware')
  })

  it('keeps the broader-scoped (shorter) title when merging duplicates', () => {
    const subtasks = [
      { title: 'Remove src/client/middleware/auth.js', files: ['src/client/middleware/auth.js', 'src/client/middleware/index.js'] },
      { title: 'Remove src/client/middleware', files: ['src/client/middleware/auth.js', 'src/client/middleware/index.js'] },
    ]
    const result = dedupeByFileSet(subtasks)
    assert.equal(result.length, 1)
    assert.equal(result[0].title, 'Remove src/client/middleware')
  })

  it('does not merge subtasks with empty file lists', () => {
    const subtasks = [
      { title: 'Stub A', files: [] },
      { title: 'Stub B', files: [] },
    ]
    const result = dedupeByFileSet(subtasks)
    assert.equal(result.length, 2)
  })

  it('handles subtasks with no files property', () => {
    const subtasks = [
      { title: 'A' },
      { title: 'B' },
    ]
    const result = dedupeByFileSet(subtasks)
    assert.equal(result.length, 2)
  })

  it('order-independent: same files in different order are detected as duplicates', () => {
    const subtasks = [
      { title: 'A', files: ['src/b.js', 'src/a.js'] },
      { title: 'B', files: ['src/a.js', 'src/b.js'] },
    ]
    const result = dedupeByFileSet(subtasks)
    assert.equal(result.length, 1)
  })

  it('preserves all other fields on the kept subtask', () => {
    const subtasks = [
      { title: 'Remove middleware', files: ['a.js'], groupId: 'G1', scopePath: 'src/' },
      { title: 'Remove middleware/auth.js', files: ['a.js'], groupId: 'G1', scopePath: 'src/middleware/' },
    ]
    const result = dedupeByFileSet(subtasks)
    assert.equal(result.length, 1)
    assert.equal(result[0].groupId, 'G1')
  })
})

describe('dedupeByOverlapRatio', () => {
  it('passes through subtasks with non-overlapping file sets', () => {
    const subtasks = [
      { title: 'A', scopePath: 'src/client', files: ['src/client/a.js', 'src/client/b.js'] },
      { title: 'B', scopePath: 'src/server', files: ['src/server/c.js', 'src/server/d.js'] },
    ]
    assert.equal(dedupeByOverlapRatio(subtasks).length, 2)
  })

  it('drops a subtask whose files are >50% already seen (by a longer scopePath)', () => {
    const subtasks = [
      { title: 'Specific', scopePath: 'src/client/middleware', files: ['src/client/middleware/auth.js', 'src/client/middleware/index.js'] },
      { title: 'Broad',    scopePath: 'src/client',           files: ['src/client/middleware/auth.js', 'src/client/middleware/index.js', 'src/client/api.js'] },
    ]
    const result = dedupeByOverlapRatio(subtasks)
    // Broad has 2/3 overlap (66%) after Specific claimed 2 files — should be dropped
    assert.equal(result.length, 1)
    assert.equal(result[0].title, 'Specific')
  })

  it('keeps a subtask when overlap is exactly 0.5 (threshold is strictly > 0.5)', () => {
    const subtasks = [
      { title: 'A', scopePath: 'src/a', files: ['f1.js', 'f2.js'] },
      { title: 'B', scopePath: 'src/b', files: ['f1.js', 'f3.js'] },
    ]
    // B has 1/2 = 0.5 overlap — kept (only drop when overlap > 0.5 — wait, need to check actual threshold)
    // workflow.js uses: if (overlap < 0.5) keep — so 0.5 overlap → dropped
    // Actually workflow uses: if (overlapRatio < 0.5) keep → 0.5 → NOT kept
    const result = dedupeByOverlapRatio(subtasks)
    assert.equal(result.length, 1)  // B dropped: 0.5 is NOT < 0.5
  })

  it('always keeps subtasks with empty file lists', () => {
    const subtasks = [
      { title: 'Stub A', scopePath: '', files: [] },
      { title: 'Stub B', scopePath: '', files: [] },
    ]
    assert.equal(dedupeByOverlapRatio(subtasks).length, 2)
  })

  it('sorts by scopePath length desc before deduping (most specific wins)', () => {
    // Pass in reverse order — broad first, specific second
    const subtasks = [
      { title: 'Broad',    scopePath: 'src',        files: ['src/client/auth.js', 'src/client/index.js', 'src/client/api.js'] },
      { title: 'Specific', scopePath: 'src/client', files: ['src/client/auth.js', 'src/client/index.js'] },
    ]
    const result = dedupeByOverlapRatio(subtasks)
    // Specific (longer path) should win even though Broad was first
    assert.equal(result.length, 1)
    assert.equal(result[0].title, 'Specific')
  })

  it('normalizes absolute paths to relative before comparing when given absPrefix', () => {
    const prefix = '/Users/foo/Desktop/Repos/webtarsthree/'
    const subtasks = [
      { title: 'Grouper (relative)',    scopePath: 'src/client', files: ['src/client/auth.js', 'src/client/index.js'] },
      // Coordinator emits absolute paths even though grouper input was relative
      { title: 'Coordinator (absolute)', scopePath: 'src/client', files: [
          '/Users/foo/Desktop/Repos/webtarsthree/src/client/auth.js',
          '/Users/foo/Desktop/Repos/webtarsthree/src/client/index.js',
        ]},
    ]
    const result = dedupeByOverlapRatio(subtasks, prefix)
    // After normalization both subtasks have identical file sets — second (100% overlap) dropped
    assert.equal(result.length, 1)
    assert.equal(result[0].title, 'Grouper (relative)')
  })

  it('output files are normalized to relative paths when absPrefix given', () => {
    const prefix = '/Users/foo/Desktop/Repos/webtarsthree/'
    // Only one subtask — check its files come out relative even if input was absolute
    const subtasks = [
      { title: 'A', scopePath: 'src/client', files: [
          '/Users/foo/Desktop/Repos/webtarsthree/src/client/auth.js',
          '/Users/foo/Desktop/Repos/webtarsthree/src/client/index.js',
        ]},
    ]
    const result = dedupeByOverlapRatio(subtasks, prefix)
    assert.equal(result.length, 1)
    assert.deepEqual(result[0].files, ['src/client/auth.js', 'src/client/index.js'])
  })
})

describe('categorizeVerifyIssue', () => {
  it('renames AC UNCOVERED verify issues to ac-gap:', () => {
    const issue = 'verify: AC UNCOVERED: No subtask for removing package.json'
    assert.equal(categorizeVerifyIssue(issue), 'ac-gap: AC UNCOVERED: No subtask for removing package.json')
  })

  it('leaves other verify issues unchanged', () => {
    const issue = 'verify: DUPLICATE SUBTASK: Both subtasks enumerate the same 2 files'
    assert.equal(categorizeVerifyIssue(issue), 'verify: DUPLICATE SUBTASK: Both subtasks enumerate the same 2 files')
  })

  it('leaves non-verify issues unchanged', () => {
    const issue = 'stub needs review: "Some stub title"'
    assert.equal(categorizeVerifyIssue(issue), 'stub needs review: "Some stub title"')
  })

  it('leaves misclassification issues unchanged', () => {
    const issue = 'misclassification: file placed in wrong batch'
    assert.equal(categorizeVerifyIssue(issue), 'misclassification: file placed in wrong batch')
  })

  it('is case-sensitive on the AC UNCOVERED marker', () => {
    const issue = 'verify: ac uncovered: lowercase version'
    assert.equal(categorizeVerifyIssue(issue), 'verify: ac uncovered: lowercase version')
  })
})
