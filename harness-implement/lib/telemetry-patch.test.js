// RED first: this module does not exist yet.
//
// `patchTelemetryRecord` in SKILL.md splits every dotted key on '.' and walks the record as
// if each segment were one level of nesting. That is right for `tokens.total.input` and
// wrong for `cost.nullReasons.tokens.total.input`, because `nullReasons` is a MAP WHOSE KEYS
// CONTAIN DOTS — `cost.js` writes it as `nullReasons['tokens.total.input'] = '...'`, one
// literal key, not three levels.
//
// Reproduced against the real python before writing this file. Patching
// `{'tokens.total.input': 812345, 'cost.nullReasons.tokens.total.input': null}` onto a record
// whose nullReasons carries the flat key yields:
//
//   "nullReasons": {
//     "tokens.total.input": "subagentTokens not yet patched",   <- stale reason SURVIVES
//     "tokens": { "total": {} }                                 <- garbage branch INVENTED
//   }
//
// So the bug is two bugs. The clear-the-reason step silently no-ops, leaving a record that
// reports a null cause for a field that is now populated; and the walk creates the missing
// intermediate objects on its way down, so it writes a nested shape nothing ever reads. Both
// land in the file the dashboard treats as authoritative, and neither raises anything —
// `patchTelemetryRecord` is `try`-swallowed by design.
//
// The fix cannot be "stop using dots in nullReasons keys": those keys are dotted field paths
// on purpose (they name the field the reason is about), and cost.js/cost.test.js already
// assert that shape. The patcher is what has to learn the difference.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitPatchKey, applyPatch, MAP_VALUED_PREFIXES } from './telemetry-patch.js'

test('a plain dotted key splits into one segment per level', () => {
  assert.deepEqual(splitPatchKey('tokens.total.input'), { path: ['tokens', 'total'], leafKey: 'input' })
})

test('a single-segment key has an empty path', () => {
  assert.deepEqual(splitPatchKey('durationMs'), { path: [], leafKey: 'durationMs' })
})

test('a key inside a map-valued field keeps its dots as ONE literal leaf key', () => {
  // The bug. Everything after `cost.nullReasons` is a single map key, not a path.
  assert.deepEqual(
    splitPatchKey('cost.nullReasons.tokens.total.input'),
    { path: ['cost', 'nullReasons'], leafKey: 'tokens.total.input' }
  )
})

test('the map-valued prefix itself is addressable as a whole', () => {
  // Replacing the entire map (or clearing it) must still work.
  assert.deepEqual(splitPatchKey('cost.nullReasons'), { path: ['cost'], leafKey: 'nullReasons' })
})

test('every declared map-valued prefix is honoured, not just cost.nullReasons', () => {
  // agentCount.byModel/byPhase are keyed by model IDs and phase titles. A model ID has no
  // dots today, but a phase title is free-form text and nothing stops one containing a dot.
  assert.ok(MAP_VALUED_PREFIXES.length > 0, 'no map-valued prefixes declared')
  for (const prefix of MAP_VALUED_PREFIXES) {
    const segs = prefix.split('.')
    const { path, leafKey } = splitPatchKey(`${prefix}.a.b`)
    assert.deepEqual(path, segs, `${prefix}: path should stop at the map itself`)
    assert.equal(leafKey, 'a.b', `${prefix}: everything past the map is one key`)
  }
})

test('clearing a stale reason actually removes it', () => {
  // The whole point of the patch: input is now known, so its "why null" reason must go.
  const rec = {
    tokens: { total: { input: null } },
    cost: { nullReasons: { 'tokens.total.input': 'subagentTokens not yet patched' } },
  }
  const out = applyPatch(rec, {
    'tokens.total.input': 812345,
    'cost.nullReasons.tokens.total.input': null,
  })
  assert.equal(out.tokens.total.input, 812345)
  assert.deepEqual(out.cost.nullReasons, {}, 'the stale reason survived the patch')
})

test('patching never invents a nested branch inside a map-valued field', () => {
  // The second half of the bug: the old walk created cost.nullReasons.tokens.total = {} on
  // its way down. A shape nothing reads, in the file the dashboard trusts.
  const rec = { cost: { nullReasons: { 'tokens.total.input': 'x' } } }
  const out = applyPatch(rec, { 'cost.nullReasons.tokens.total.input': null })
  assert.deepEqual(Object.keys(out.cost.nullReasons), [], 'nullReasons has unexpected keys')
  assert.equal(out.cost.nullReasons.tokens, undefined, 'a nested `tokens` branch was invented')
})

test('clearing a reason that was never set is a no-op, not a crash', () => {
  const rec = { cost: { nullReasons: {} } }
  let out
  assert.doesNotThrow(() => { out = applyPatch(rec, { 'cost.nullReasons.tokens.total.input': null }) })
  assert.deepEqual(out.cost.nullReasons, {})
})

test('clearing a reason when cost carries no nullReasons map at all is a no-op', () => {
  // A record written before nullReasons existed, or one whose cost bailed early.
  const rec = { cost: { rateLockedUsd: null } }
  const out = applyPatch(rec, { 'cost.nullReasons.tokens.total.input': null })
  assert.deepEqual(out.cost, { rateLockedUsd: null }, 'a delete should not create the map it deletes from')
})

test('setting a value does create the intermediate objects it needs', () => {
  // Deletes must not vivify; sets must. A record missing tokens.total entirely should still
  // accept a token patch rather than drop it.
  const out = applyPatch({}, { 'tokens.total.input': 5 })
  assert.deepEqual(out.tokens, { total: { input: 5 } })
})

test('a set never clobbers a sibling', () => {
  const rec = { tokens: { total: { output: 100 }, byModel: { 'claude-opus-5': { output: null } } } }
  const out = applyPatch(rec, { 'tokens.total.input': 7 })
  assert.equal(out.tokens.total.output, 100)
  assert.deepEqual(out.tokens.byModel, { 'claude-opus-5': { output: null } })
})

test('a non-object standing where a path segment should be is replaced, not walked into', () => {
  // Defensive: a malformed record must not make the patcher throw and lose every field.
  const out = applyPatch({ tokens: 'unmeasured' }, { 'tokens.total.input': 7 })
  assert.deepEqual(out.tokens, { total: { input: 7 } })
})

test('applyPatch does not mutate the record it was given', () => {
  const rec = { cost: { nullReasons: { 'tokens.total.input': 'x' } } }
  const before = JSON.stringify(rec)
  applyPatch(rec, { 'cost.nullReasons.tokens.total.input': null })
  assert.equal(JSON.stringify(rec), before, 'the input record was edited in place')
})

test('a flat key is set verbatim even when its name contains a dot-free surprise', () => {
  const out = applyPatch({}, { status: 'COMPLETE', outcome: 'success' })
  assert.equal(out.status, 'COMPLETE')
  assert.equal(out.outcome, 'success')
})

test('the whole nullReasons map can be replaced in one patch', () => {
  const rec = { cost: { nullReasons: { 'tokens.total.input': 'x' } } }
  const out = applyPatch(rec, { 'cost.nullReasons': { 'tokens.byModel': 'runtime reports aggregate only' } })
  assert.deepEqual(out.cost.nullReasons, { 'tokens.byModel': 'runtime reports aggregate only' })
})
