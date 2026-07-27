import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWorktreeArgs } from './worktree.js'

// resolveWorktreeArgs(args, branchName, baseBranch)
// Returns: { skip: true, worktreePath, branch, baseBranch } when conductor-provisioned
//          { skip: false } when worktree creation is needed

test('returns skip:false when args.worktreePath is absent', () => {
  const result = resolveWorktreeArgs({}, 'implement/plan', 'main')
  assert.equal(result.skip, false)
})

test('returns skip:false when args.worktreePath is null', () => {
  const result = resolveWorktreeArgs({ worktreePath: null }, 'implement/plan', 'main')
  assert.equal(result.skip, false)
})

test('returns skip:false when args.worktreePath is empty string', () => {
  const result = resolveWorktreeArgs({ worktreePath: '' }, 'implement/plan', 'main')
  assert.equal(result.skip, false)
})

test('returns skip:true when args.worktreePath is set', () => {
  const result = resolveWorktreeArgs({ worktreePath: '/wt/path' }, 'implement/plan', 'main')
  assert.equal(result.skip, true)
})

test('worktreePath from args is returned verbatim', () => {
  const result = resolveWorktreeArgs({ worktreePath: '/repo/wt-TARS-1271' }, 'implement/plan', 'main')
  assert.equal(result.worktreePath, '/repo/wt-TARS-1271')
})

test('branch uses args.runBranch when provided', () => {
  const result = resolveWorktreeArgs(
    { worktreePath: '/wt', runBranch: 'harness/TARS-1271-20260727T182326Z' },
    'implement/plan', 'main'
  )
  assert.equal(result.branch, 'harness/TARS-1271-20260727T182326Z')
})

test('branch falls back to branchName when args.runBranch absent', () => {
  const result = resolveWorktreeArgs({ worktreePath: '/wt' }, 'implement/my-plan', 'main')
  assert.equal(result.branch, 'implement/my-plan')
})

test('baseBranch from argument is returned', () => {
  const result = resolveWorktreeArgs({ worktreePath: '/wt' }, 'b', 'feat/migrate-native-fetch')
  assert.equal(result.baseBranch, 'feat/migrate-native-fetch')
})

test('baseBranch falls back to "unknown" when null', () => {
  const result = resolveWorktreeArgs({ worktreePath: '/wt' }, 'b', null)
  assert.equal(result.baseBranch, 'unknown')
})

test('skip:true result has worktreePath, branch, baseBranch — no extra fields required', () => {
  const result = resolveWorktreeArgs({ worktreePath: '/wt', runBranch: 'r' }, 'b', 'base')
  assert.ok('worktreePath' in result)
  assert.ok('branch' in result)
  assert.ok('baseBranch' in result)
})

test('skip:false result has no worktreePath field', () => {
  const result = resolveWorktreeArgs({}, 'b', 'base')
  assert.ok(!('worktreePath' in result))
})
