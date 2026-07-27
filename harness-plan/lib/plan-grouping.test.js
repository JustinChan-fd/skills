import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDecomposeConcernsFromGroups,
  buildManifestDependsOn,
} from './plan-grouping.js'

// ── buildDecomposeConcernsFromGroups ──────────────────────────────────────────

test('empty groups → empty concerns array', () => {
  assert.deepEqual(buildDecomposeConcernsFromGroups([], '/repo', 'axios→fetch'), [])
})

test('single subtask → single concern', () => {
  const groups = [{
    groupId: 'G1',
    subtasks: [{
      title: 'Migrate hooks',
      description: 'Replace api.* with clientFetch',
      files: ['src/a.js', 'src/b.js'],
      scopePath: 'src/hooks',
      migrationPattern: 'axios→fetch',
      groupId: 'G1',
      isDeferred: false,
    }],
  }]
  const concerns = buildDecomposeConcernsFromGroups(groups, '/repo', null)
  assert.equal(concerns.length, 1)
  assert.equal(concerns[0].label, 'Migrate hooks')
  assert.equal(concerns[0].groupId, 'G1')
  assert.equal(concerns[0].isDeferred, false)
  assert.equal(concerns[0].scopePath, 'src/hooks')
  assert.equal(concerns[0].migrationPattern, 'axios→fetch')
})

test('file paths are made absolute using repoPath prefix', () => {
  const groups = [{
    groupId: 'G1',
    subtasks: [{
      title: 'T1',
      files: ['src/a.js'],
      groupId: 'G1',
    }],
  }]
  const concerns = buildDecomposeConcernsFromGroups(groups, '/my/repo', null)
  assert.equal(concerns[0].filesToRead[0], '/my/repo/src/a.js')
})

test('already-absolute file paths are not double-prefixed', () => {
  const groups = [{
    groupId: 'G1',
    subtasks: [{
      title: 'T1',
      files: ['/already/absolute/src/a.js'],
      groupId: 'G1',
    }],
  }]
  const concerns = buildDecomposeConcernsFromGroups(groups, '/repo', null)
  assert.equal(concerns[0].filesToRead[0], '/already/absolute/src/a.js')
})

test('filesToRead is capped at 8 even when subtask has more files', () => {
  const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.js`)
  const groups = [{
    groupId: 'G1',
    subtasks: [{ title: 'T1', files, groupId: 'G1' }],
  }]
  const concerns = buildDecomposeConcernsFromGroups(groups, '/repo', null)
  assert.equal(concerns[0].filesToRead.length, 8)
  assert.equal(concerns[0].fileBudget, 8)
})

test('fileBudget equals file count when under cap', () => {
  const groups = [{
    groupId: 'G1',
    subtasks: [{ title: 'T1', files: ['a.js', 'b.js', 'c.js'], groupId: 'G1' }],
  }]
  const concerns = buildDecomposeConcernsFromGroups(groups, '/repo', null)
  assert.equal(concerns[0].fileBudget, 3)
})

test('subtask migrationPattern overrides global', () => {
  const groups = [{
    groupId: 'G1',
    subtasks: [{
      title: 'T1', files: [], groupId: 'G1',
      migrationPattern: 'local-override',
    }],
  }]
  const concerns = buildDecomposeConcernsFromGroups(groups, '/repo', 'global-pattern')
  assert.equal(concerns[0].migrationPattern, 'local-override')
})

test('falls back to global migrationPattern when subtask has none', () => {
  const groups = [{
    groupId: 'G1',
    subtasks: [{ title: 'T1', files: [], groupId: 'G1' }],
  }]
  const concerns = buildDecomposeConcernsFromGroups(groups, '/repo', 'global-pattern')
  assert.equal(concerns[0].migrationPattern, 'global-pattern')
})

test('isDeferred=true carries through', () => {
  const groups = [{
    groupId: 'G3',
    subtasks: [{ title: 'T1', files: [], groupId: 'G3', isDeferred: true }],
  }]
  const concerns = buildDecomposeConcernsFromGroups(groups, '/repo', null)
  assert.equal(concerns[0].isDeferred, true)
})

test('questions array is non-empty and includes migration pattern reference', () => {
  const groups = [{
    groupId: 'G1',
    subtasks: [{ title: 'T1', files: [], groupId: 'G1', migrationPattern: 'axios→fetch' }],
  }]
  const concerns = buildDecomposeConcernsFromGroups(groups, '/repo', null)
  assert.ok(concerns[0].questions.length >= 2)
  assert.ok(concerns[0].questions[0].includes('axios→fetch'))
})

test('description is appended as a question when present', () => {
  const groups = [{
    groupId: 'G1',
    subtasks: [{ title: 'T1', files: [], groupId: 'G1', description: 'Replace api.get with clientFetch' }],
  }]
  const concerns = buildDecomposeConcernsFromGroups(groups, '/repo', null)
  assert.ok(concerns[0].questions.some(q => q.includes('Replace api.get with clientFetch')))
})

test('multiple groups produce concerns in G1→G2→G3 order', () => {
  const groups = [
    { groupId: 'G1', subtasks: [{ title: 'A', files: [], groupId: 'G1' }, { title: 'B', files: [], groupId: 'G1' }] },
    { groupId: 'G2', subtasks: [{ title: 'C', files: [], groupId: 'G2' }] },
    { groupId: 'G3', subtasks: [{ title: 'D', files: [], groupId: 'G3' }] },
  ]
  const concerns = buildDecomposeConcernsFromGroups(groups, '/repo', null)
  assert.equal(concerns.length, 4)
  assert.equal(concerns[0].label, 'A')
  assert.equal(concerns[1].label, 'B')
  assert.equal(concerns[2].label, 'C')
  assert.equal(concerns[3].label, 'D')
  assert.equal(concerns[0].groupId, 'G1')
  assert.equal(concerns[2].groupId, 'G2')
  assert.equal(concerns[3].groupId, 'G3')
})

test('subtask with no title falls back to groupId-index label', () => {
  const groups = [{
    groupId: 'G1',
    subtasks: [{ files: [], groupId: 'G1' }],
  }]
  const concerns = buildDecomposeConcernsFromGroups(groups, '/repo', null)
  assert.ok(concerns[0].label.startsWith('G1-'))
})

// ── buildManifestDependsOn ────────────────────────────────────────────────────

test('single plan entry → empty dependsOn', () => {
  const entries = [{ suffix: 'p1', concern: { groupId: 'G1' } }]
  const result = buildManifestDependsOn(entries)
  assert.deepEqual(result[0].dependsOn, [])
})

test('two entries same groupId → no dependsOn between them (parallel within group)', () => {
  const entries = [
    { suffix: 'p1', concern: { groupId: 'G1' } },
    { suffix: 'p2', concern: { groupId: 'G1' } },
  ]
  const result = buildManifestDependsOn(entries)
  assert.deepEqual(result[0].dependsOn, [])
  assert.deepEqual(result[1].dependsOn, [])
})

test('G2 depends on last G1 entry (first entry of later group depends on all prior group last entries)', () => {
  const entries = [
    { suffix: 'p1', concern: { groupId: 'G1' } },
    { suffix: 'p2', concern: { groupId: 'G1' } },
    { suffix: 'p3', concern: { groupId: 'G2' } },
  ]
  const result = buildManifestDependsOn(entries)
  assert.deepEqual(result[2].dependsOn, ['p2'])
})

test('G3 first entry depends on last G2 entry', () => {
  const entries = [
    { suffix: 'p1', concern: { groupId: 'G1' } },
    { suffix: 'p2', concern: { groupId: 'G2' } },
    { suffix: 'p3', concern: { groupId: 'G3' } },
  ]
  const result = buildManifestDependsOn(entries)
  assert.deepEqual(result[0].dependsOn, [])
  assert.deepEqual(result[1].dependsOn, ['p1'])
  assert.deepEqual(result[2].dependsOn, ['p2'])
})

test('second entry within same group has no dependsOn (parallel)', () => {
  const entries = [
    { suffix: 'p1', concern: { groupId: 'G1' } },
    { suffix: 'p2', concern: { groupId: 'G1' } },
    { suffix: 'p3', concern: { groupId: 'G1' } },
  ]
  const result = buildManifestDependsOn(entries)
  assert.deepEqual(result[0].dependsOn, [])
  assert.deepEqual(result[1].dependsOn, [])
  assert.deepEqual(result[2].dependsOn, [])
})

test('no groupId on concern → treated as independent (no dependsOn)', () => {
  const entries = [
    { suffix: 'p1', concern: {} },
    { suffix: 'p2', concern: {} },
  ]
  const result = buildManifestDependsOn(entries)
  assert.deepEqual(result[0].dependsOn, [])
  assert.deepEqual(result[1].dependsOn, [])
})

test('returns array same length as input', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ suffix: `p${i + 1}`, concern: { groupId: 'G1' } }))
  const result = buildManifestDependsOn(entries)
  assert.equal(result.length, 5)
})

test('each result entry has suffix, dependsOn, and id fields', () => {
  const entries = [{ suffix: 'p1', concern: { groupId: 'G1' } }]
  const result = buildManifestDependsOn(entries)
  assert.ok('suffix' in result[0])
  assert.ok('dependsOn' in result[0])
  assert.ok('id' in result[0])
  assert.equal(result[0].id, 'p1')
})
