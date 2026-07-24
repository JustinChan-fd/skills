import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { downgradeConflictingGroups as planImpl } from '../../harness-plan/lib/dag.js'
import { downgradeConflictingGroups as implementImpl } from './dag.js'

// Shared fixture — used to assert both skills' functions return identical output
function makeConflictingTasks() {
  return [
    { id: 't1', groupId: 'g1', block: 'parallel', files: ['src/a.ts', 'src/shared.ts'] },
    { id: 't2', groupId: 'g1', block: 'parallel', files: ['src/b.ts', 'src/shared.ts'] },
    { id: 't3', groupId: 'g2', block: 'parallel', files: ['src/c.ts'] },
    { id: 't4', groupId: 'g2', block: 'parallel', files: ['src/d.ts'] },
  ]
}

describe('downgradeConflictingGroups (harness-implement)', () => {
  it('downgrades entire parallel group when two tasks share a file', () => {
    const tasks = makeConflictingTasks()
    implementImpl(tasks)
    assert.equal(tasks[0].block, 'sequential')
    assert.equal(tasks[1].block, 'sequential')
  })

  it('leaves non-conflicting parallel group untouched', () => {
    const tasks = makeConflictingTasks()
    implementImpl(tasks)
    assert.equal(tasks[2].block, 'parallel')
    assert.equal(tasks[3].block, 'parallel')
  })

  it('leaves single-task group untouched', () => {
    const tasks = [{ id: 't1', groupId: 'g1', block: 'parallel', files: ['src/a.ts'] }]
    implementImpl(tasks)
    assert.equal(tasks[0].block, 'parallel')
  })

  it('returns the same tasks array', () => {
    const tasks = makeConflictingTasks()
    const result = implementImpl(tasks)
    assert.equal(result, tasks)
  })
})

describe('cross-skill DAG parity', () => {
  it('plan and implement return identical block values on shared fixture', () => {
    const t1 = makeConflictingTasks()
    const t2 = makeConflictingTasks()
    planImpl(t1)
    implementImpl(t2)
    for (let i = 0; i < t1.length; i++) {
      assert.equal(t1[i].block, t2[i].block, `task index ${i} block mismatch`)
    }
  })
})
