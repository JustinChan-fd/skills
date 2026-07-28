// RED first: this module does not exist yet.
//
// The workflow picks which object it trusts for `size` and `files` with one inline expression:
//
//   const sizingSource = args.gatedIntake || manifestEntry || null
//
// That is correct for the two cases it was written for and wrong for the case that is now the
// common one. `--intake <manifest> --entry G1-1` supplies BOTH, and gatedIntake wins — so a run
// asked to plan one subtask sizes itself off the whole ticket: size L instead of the subtask's
// S, and the manifest's full 92-file scope instead of the subtask's 8.
//
// The consequence is not a crash. size drives model selection and the file budget, so the run
// spends opus-tier planning on an S-sized concern and hands the researcher a file list four
// times the size of the one it was scoped to. Both look like ordinary output.
//
// Manifest supremacy is not in tension with this. Supremacy is about a *verified* manifest
// outranking *ticket prose* — it never meant a manifest's aggregate outranks a specific subtask
// drawn from that same manifest. The subtask is the more specific statement, and it came from
// the manifest in the first place.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectSizingSource } from './sizing-source.js'

const GATED = { size: 'L', files: Array.from({ length: 92 }, (_, i) => `f${i}.js`), acList: ['a', 'b'] }
const ENTRY = { id: 'G1-1', size: 'S', files: ['a.js', 'b.js'], title: 'Migrate campaigns' }

test('an entry outranks the manifest it came from', () => {
  // The bug. Both present is the normal --intake --entry case, not an edge case.
  const src = selectSizingSource({ gatedIntake: GATED }, ENTRY)
  assert.equal(src.size, 'S', 'sized off the whole ticket instead of the named subtask')
  assert.equal(src.files.length, 2, 'took the manifest-wide file scope, not the subtask scope')
})

test('the gated manifest is used when no entry was named', () => {
  // --intake alone: the whole-ticket path, and the one manifest supremacy was written for.
  const src = selectSizingSource({ gatedIntake: GATED }, null)
  assert.equal(src.size, 'L')
  assert.equal(src.files.length, 92)
})

test('a bare entry with no manifest is used as-is', () => {
  assert.equal(selectSizingSource({}, ENTRY).size, 'S')
})

test('the manifest fills in fields the entry lacks', () => {
  // A subtask carries no size of its own in most manifests — harness-intake emits `targetSize`.
  // Falling back to the manifest beats defaulting to 'S' silently, because the manifest value
  // is at least a measured one.
  const thin = { id: 'G1-1', files: ['a.js'] }
  const src = selectSizingSource({ gatedIntake: GATED }, thin)
  assert.equal(src.size, 'L', 'no size on the entry: the manifest is the next best statement')
  assert.equal(src.files.length, 1, 'but its own files[] still wins — an empty-ish entry is not an empty scope')
})

test('an entry targetSize is honoured as its size', () => {
  // harness-intake's subtask schema names the field targetSize, not size. Reading only `size`
  // means every real intake subtask falls through to the manifest's L.
  const src = selectSizingSource({ gatedIntake: GATED }, { id: 'G1-1', targetSize: 'XS', files: ['a.js'] })
  assert.equal(src.size, 'XS')
})

test('an entry size wins over its own targetSize', () => {
  const src = selectSizingSource({}, { size: 'M', targetSize: 'XS', files: [] })
  assert.equal(src.size, 'M')
})

test('an entry with an empty files[] does not fall back to the manifest scope', () => {
  // A validation or config subtask legitimately touches no files. Inheriting 92 files there
  // would hand a researcher the entire ticket to read for a subtask that reads nothing.
  const src = selectSizingSource({ gatedIntake: GATED }, { id: 'G2-1', size: 'XS', files: [] })
  assert.deepEqual(src.files, [], 'an explicit empty scope is a scope, not a missing value')
})

test('an entry with no files key at all inherits the manifest scope', () => {
  // Distinct from the case above: absent is unknown, [] is known-empty.
  const src = selectSizingSource({ gatedIntake: GATED }, { id: 'G1-1', size: 'S' })
  assert.equal(src.files.length, 92)
})

test('acList comes from whichever source has one, entry first', () => {
  assert.deepEqual(selectSizingSource({ gatedIntake: GATED }, ENTRY).acList, ['a', 'b'])
  assert.deepEqual(selectSizingSource({ gatedIntake: GATED }, { ...ENTRY, acList: ['own'] }).acList, ['own'])
})

test('neither source present yields null, not a throw', () => {
  for (const [a, e] of [[{}, null], [null, null], [undefined, undefined], [{ gatedIntake: null }, null]]) {
    let src
    assert.doesNotThrow(() => { src = selectSizingSource(a, e) }, `threw on ${JSON.stringify([a, e])}`)
    assert.equal(src, null)
  }
})

test('never mutates either input', () => {
  const g = JSON.stringify(GATED), e = JSON.stringify(ENTRY)
  selectSizingSource({ gatedIntake: GATED }, ENTRY)
  assert.equal(JSON.stringify(GATED), g, 'the manifest object was edited in place')
  assert.equal(JSON.stringify(ENTRY), e, 'the entry object was edited in place')
})

test('always returns size and files, so callers need no further guards', () => {
  // The workflow does `sizingSource.size || 'S'` and `(sizingSource.files || []).length`. Those
  // guards stay harmless, but nothing downstream should depend on them.
  for (const src of [
    selectSizingSource({ gatedIntake: { size: 'M' } }, null),
    selectSizingSource({}, { id: 'G1-1' }),
  ]) {
    assert.ok(src.size, 'no size on the result')
    assert.ok(Array.isArray(src.files), 'files is not an array')
  }
})
