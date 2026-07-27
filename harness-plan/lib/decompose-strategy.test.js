import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectDecomposeStrategy } from './decompose-strategy.js'

// selectDecomposeStrategy(args, size, manifestEntry)
// Returns one of: 'gated-intake-groups' | 'llm-decompose' | 'manifest-entry' | 'skip'
//
// Priority order (highest first):
//   1. gated-intake-groups — args.gatedIntake.groups is non-empty
//   2. llm-decompose       — size is L or M and no gated groups
//   3. manifest-entry      — manifestEntry is set (single subtask fast path)
//   4. skip                — XS or S with no special flags (single concern, no decompose)

test('gated-intake-groups when gatedIntake.groups is non-empty', () => {
  const args = { gatedIntake: { groups: [{ subtasks: [{}] }] } }
  assert.equal(selectDecomposeStrategy(args, 'L', null), 'gated-intake-groups')
})

test('gated-intake-groups takes priority over L size (no llm-decompose)', () => {
  const args = { gatedIntake: { groups: [{ subtasks: [{}] }] } }
  assert.equal(selectDecomposeStrategy(args, 'L', null), 'gated-intake-groups')
  assert.notEqual(selectDecomposeStrategy(args, 'L', null), 'llm-decompose')
})

test('gated-intake-groups takes priority even for M size', () => {
  const args = { gatedIntake: { groups: [{ subtasks: [{}] }] } }
  assert.equal(selectDecomposeStrategy(args, 'M', null), 'gated-intake-groups')
})

test('gated-intake-groups NOT selected when groups is empty array', () => {
  const args = { gatedIntake: { groups: [] } }
  assert.notEqual(selectDecomposeStrategy(args, 'L', null), 'gated-intake-groups')
})

test('gated-intake-groups NOT selected when gatedIntake is null', () => {
  assert.notEqual(selectDecomposeStrategy({ gatedIntake: null }, 'L', null), 'gated-intake-groups')
})

test('gated-intake-groups NOT selected when gatedIntake has no groups field', () => {
  const args = { gatedIntake: { size: 'L' } }
  assert.notEqual(selectDecomposeStrategy(args, 'L', null), 'gated-intake-groups')
})

test('llm-decompose for size L with no gated groups', () => {
  assert.equal(selectDecomposeStrategy({}, 'L', null), 'llm-decompose')
})

test('llm-decompose for size M with no gated groups', () => {
  assert.equal(selectDecomposeStrategy({}, 'M', null), 'llm-decompose')
})

test('manifest-entry when manifestEntry is set and size is S', () => {
  assert.equal(selectDecomposeStrategy({}, 'S', { title: 'T1' }), 'manifest-entry')
})

test('manifest-entry when manifestEntry is set and size is XS', () => {
  assert.equal(selectDecomposeStrategy({}, 'XS', { title: 'T1' }), 'manifest-entry')
})

test('skip for size S with no gated groups and no manifestEntry', () => {
  assert.equal(selectDecomposeStrategy({}, 'S', null), 'skip')
})

test('skip for size XS with no gated groups and no manifestEntry', () => {
  assert.equal(selectDecomposeStrategy({}, 'XS', null), 'skip')
})

test('manifest-entry beats llm-decompose even for L size', () => {
  // If we have a manifestEntry for an L ticket (unusual but possible), use manifest-entry
  // not llm-decompose — the entry already scoped the files
  assert.equal(selectDecomposeStrategy({}, 'L', { title: 'T1' }), 'manifest-entry')
})

test('gated-intake-groups beats manifest-entry', () => {
  const args = { gatedIntake: { groups: [{ subtasks: [{}] }] } }
  assert.equal(selectDecomposeStrategy(args, 'S', { title: 'T1' }), 'gated-intake-groups')
})
