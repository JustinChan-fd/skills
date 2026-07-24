import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { downgradeConflictingGroups } from './dag.js'

describe('downgradeConflictingGroups (harness-plan)', () => {
  it('downgrades entire parallel group when two tasks share a file', () => {
    const tasks = [
      { id: 't1', groupId: 'g1', block: 'parallel', files: ['src/a.ts', 'src/shared.ts'] },
      { id: 't2', groupId: 'g1', block: 'parallel', files: ['src/b.ts', 'src/shared.ts'] },
    ]
    downgradeConflictingGroups(tasks)
    assert.equal(tasks[0].block, 'sequential')
    assert.equal(tasks[1].block, 'sequential')
  })

  it('leaves non-conflicting parallel group untouched', () => {
    const tasks = [
      { id: 't1', groupId: 'g1', block: 'parallel', files: ['src/a.ts'] },
      { id: 't2', groupId: 'g1', block: 'parallel', files: ['src/b.ts'] },
    ]
    downgradeConflictingGroups(tasks)
    assert.equal(tasks[0].block, 'parallel')
    assert.equal(tasks[1].block, 'parallel')
  })

  it('leaves single-task group untouched', () => {
    const tasks = [
      { id: 't1', groupId: 'g1', block: 'parallel', files: ['src/a.ts'] },
    ]
    downgradeConflictingGroups(tasks)
    assert.equal(tasks[0].block, 'parallel')
  })

  it('leaves sequential groups untouched', () => {
    const tasks = [
      { id: 't1', groupId: 'g1', block: 'sequential', files: ['src/shared.ts'] },
      { id: 't2', groupId: 'g1', block: 'sequential', files: ['src/shared.ts'] },
    ]
    downgradeConflictingGroups(tasks)
    assert.equal(tasks[0].block, 'sequential')
    assert.equal(tasks[1].block, 'sequential')
  })

  it('handles multiple groups independently', () => {
    const tasks = [
      { id: 't1', groupId: 'g1', block: 'parallel', files: ['src/shared.ts'] },
      { id: 't2', groupId: 'g1', block: 'parallel', files: ['src/shared.ts'] },
      { id: 't3', groupId: 'g2', block: 'parallel', files: ['src/other.ts'] },
      { id: 't4', groupId: 'g2', block: 'parallel', files: ['src/another.ts'] },
    ]
    downgradeConflictingGroups(tasks)
    assert.equal(tasks[0].block, 'sequential')
    assert.equal(tasks[1].block, 'sequential')
    assert.equal(tasks[2].block, 'parallel')
    assert.equal(tasks[3].block, 'parallel')
  })

  it('returns the same tasks array', () => {
    const tasks = [{ id: 't1', groupId: 'g1', block: 'parallel', files: [] }]
    const result = downgradeConflictingGroups(tasks)
    assert.equal(result, tasks)
  })
})
