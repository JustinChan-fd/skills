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

// ── An explicit --entry outranks the groups fan-out ──────────────────────────
//
// This ordering is inverted from what it was, and the inversion is the point.
//
// When the priority list was written, the only way to get a manifestEntry was `--manifest`
// from harness-split (now DEPRECATED), so `--intake` and an entry never co-occurred in
// practice and "groups win" was untested by reality.
//
// harness-intake now prints, per G1 subtask:
//
//   /harness-plan --intake <manifest> --entry G1-1
//
// Under the old ordering that command plans ALL 20 subtasks of an L ticket and never looks at
// `--entry` — it does not error, it just quietly does ~20× the requested work under a different
// scope than the one asked for. An explicit entry is a narrowing instruction; a manifest that
// merely *contains* groups is not an instruction at all.

test('an explicit manifest entry beats the gated-intake groups fan-out', () => {
  const args = { gatedIntake: { groups: [{ subtasks: [{}] }] } }
  assert.equal(selectDecomposeStrategy(args, 'S', { title: 'T1' }), 'manifest-entry')
})

test('--intake --entry plans one subtask, not every group in the manifest', () => {
  // The exact command harness-intake's summary box prints.
  const args = { gatedIntake: { size: 'L', groups: [
    { groupId: 'G1', subtasks: [{ id: 'G1-1' }, { id: 'G1-2' }] },
    { groupId: 'G2', subtasks: [{ id: 'G2-1' }] },
  ] } }
  const entry = { id: 'G1-1', title: 'Migrate campaigns', files: ['a.js'] }
  assert.notEqual(
    selectDecomposeStrategy(args, 'L', entry), 'gated-intake-groups',
    'fanning out over all groups ignores --entry and plans the wrong scope'
  )
})

test('the groups fan-out still applies when no entry was named', () => {
  // --intake with no --entry is the whole-ticket path and must be untouched by the above.
  const args = { gatedIntake: { groups: [{ subtasks: [{}] }] } }
  assert.equal(selectDecomposeStrategy(args, 'L', null), 'gated-intake-groups')
})
