// RED first: this module does not exist yet.
//
// TARS-1271's T05 read `Migrate all remaining src/client/pages/ source files (~76 files)` against
// a 102-entry files[]. The architect stated a count in prose and never compared it to the array
// it had just written.
//
// 3e closed that for OVERSIZED tasks only: splitOversizedTasks builds each chunk title from
// `chunkList.length`, so a split task cannot lie. But a task at or under the cap keeps whatever
// title the architect wrote, unchecked. `T03 | 7 files | Migrate src/client/hooks/ (7 source
// files)` from that same plan happens to agree — and nothing in the tree would notice if it did
// not. The 102-file case was loud because it was extreme, not because it was detected.
//
// So the remaining defect is narrow and worth stating precisely: a count in a task title is
// model-authored, and the array is ground truth. Reconcile them in code.
//
// NOT in scope, and deliberately: `fileCountEstimate` (workflow.js:898, :902, :1063, :1250) is
// produced by the intake sizing agent, which runs BEFORE any files[] exists. There is no array
// to count there, so "estimated" is the honest word and it stays. Conflating the two is how this
// task would turn into inventing a derivation for a number that has no source.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileTitleCounts, COUNT_RE } from './title-counts.js'

/** T05 as it actually shipped: a stated count of 76 against 102 real entries. */
const t05 = () => ({
  id: 'T05',
  title: 'Migrate all remaining src/client/pages/ source files (~76 files)',
  files: Array.from({ length: 102 }, (_, i) => `src/client/pages/p${i}.js`),
})

test('a title whose count matches the array passes through by identity', () => {
  // Identity for the same reason splitOversizedTasks uses it: the overwhelmingly common case is
  // "nothing to fix", and churning object references there would make a downstream `===` stop
  // matching for no gain.
  const t = { id: 'T03', title: 'Migrate src/client/hooks/ (7 source files)', files: Array.from({ length: 7 }, (_, i) => `h${i}.js`) }
  const out = reconcileTitleCounts([t])
  assert.equal(out.length, 1)
  assert.equal(out[0], t, 'a correct title was rebuilt instead of passed through')
})

test('a title with no count at all passes through by identity', () => {
  // Most titles state no number. Appending one uninvited would be a rewrite, not a correction.
  const t = { id: 'T01', title: 'Enhance clientFetch with AbortController timeout support', files: ['src/client/clientFetch.js'] }
  assert.equal(reconcileTitleCounts([t])[0], t)
})

test('the T05 case: a wrong count is corrected to files.length', () => {
  const [out] = reconcileTitleCounts([t05()])
  assert.match(out.title, /\b102 files\b/, `count not corrected: ${out.title}`)
  assert.ok(!/76/.test(out.title), `the fabricated count survives: ${out.title}`)
})

test('correcting a count does not mutate the input task', () => {
  // The caller holds the architect's own output and may log or compare against it.
  const t = t05()
  reconcileTitleCounts([t])
  assert.match(t.title, /~76 files/, 'the input task was mutated in place')
})

test('the approximation marker is dropped when the count becomes exact', () => {
  // `~102 files` would be false in a new way: the number is now derived, not estimated.
  const [out] = reconcileTitleCounts([t05()])
  assert.ok(!/~\s*102/.test(out.title), `tilde retained on an exact count: ${out.title}`)
})

test('everything else in the title is preserved', () => {
  const [out] = reconcileTitleCounts([t05()])
  assert.ok(out.title.startsWith('Migrate all remaining src/client/pages/ source files'), `title text lost: ${out.title}`)
})

test('all other task fields survive untouched', () => {
  const t = { ...t05(), groupId: 'G3', block: 'parallel', description: 'WHAT: x', acceptanceCriteria: ['a'], tddRequired: true }
  const [out] = reconcileTitleCounts([t])
  for (const k of ['id', 'groupId', 'block', 'description', 'tddRequired']) {
    assert.deepEqual(out[k], t[k], `${k} changed`)
  }
  assert.deepEqual(out.files, t.files, 'files changed')
  assert.deepEqual(out.acceptanceCriteria, t.acceptanceCriteria, 'acceptanceCriteria changed')
})

test('a fileless task is never given a count', () => {
  // The XS fast path hardcodes files: []. "(0 files)" is worse than silence.
  for (const files of [[], null, undefined]) {
    const t = { id: 'T1', title: 'Do the thing', files }
    assert.equal(reconcileTitleCounts([t])[0], t, `files=${JSON.stringify(files)} was rewritten`)
  }
})

test('a stated count of zero on a fileless task is left alone, not "corrected" to 0', () => {
  const t = { id: 'T1', title: 'Cleanup (0 files)', files: [] }
  assert.equal(reconcileTitleCounts([t])[0], t)
})

test('a fileless task with a NONZERO stated count is still left alone', () => {
  // The case that makes the zero guard load-bearing rather than decorative. harness-plan's XS
  // fast path hardcodes `files: []` — the empty array means "scope not enumerated", not "zero
  // files". Reconciling against it would rewrite an honest `(3 files)` into a false `(0 files)`
  // and call it a derivation. A guard on `!files` alone lets exactly this through, because every
  // other fileless case in this file happens to have no count or a matching one.
  const t = { id: 'T1', title: 'Migrate the three api helpers (3 files)', files: [] }
  const out = reconcileTitleCounts([t])
  assert.equal(out[0], t, `a fileless task was reconciled against its empty array: ${out[0].title}`)
  const { corrections } = reconcileTitleCounts.withReport([t])
  assert.deepEqual(corrections, [], 'a fileless task was reported as a correction')
})

test('the several phrasings an architect actually uses are all recognized', () => {
  // If the regex only matches one phrasing, the check silently passes on the others — the same
  // failure shape as a green test asserting the wrong path.
  const cases = [
    ['Migrate pages (~76 files)', '(9 files)'],
    ['Migrate pages (76 files)', '(9 files)'],
    ['Migrate pages (76 source files)', '(9 source files)'],
    ['Convert 76 MockAdapter test files', '9 MockAdapter test files'],
    ['Migrate pages — 76 files', '9 files'],
  ]
  for (const [title, expectFragment] of cases) {
    const [out] = reconcileTitleCounts([{ id: 'T', title, files: Array.from({ length: 9 }, (_, i) => `f${i}.js`) }])
    assert.ok(out.title.includes(expectFragment), `phrasing not reconciled: ${title} → ${out.title}`)
  }
})

test('a number that is not a file count is not touched', () => {
  // The regex must be anchored to the word "files", or version numbers, ticket ids and API
  // versions become corruption targets.
  for (const title of [
    'Migrate to fetch API v2',
    'Fix TARS-1271 timeout handling',
    'Bump axios from 0.21 to 1.6',
    'Add 3 retries to clientFetch',
  ]) {
    const t = { id: 'T', title, files: ['a.js', 'b.js'] }
    assert.equal(reconcileTitleCounts([t])[0], t, `a non-count number was rewritten: ${title}`)
  }
})

test('COUNT_RE is exported and matches only file-count phrasings', () => {
  // Exported because the workflow logs what it corrected, and the log line and the correction
  // must agree on what a count is.
  assert.ok(COUNT_RE.test('(~76 files)'))
  assert.ok(COUNT_RE.test('76 source files'))
  assert.ok(!COUNT_RE.test('fetch API v2'))
  assert.ok(!COUNT_RE.test('TARS-1271'))
})

test('COUNT_RE is not stateful across calls', () => {
  // A /g regex reused via .test() carries lastIndex between calls, so every second identical
  // check returns false. That would make the reconciler correct alternating tasks and skip the
  // rest — passing tests, half-done work.
  const s = '(76 files)'
  assert.equal(COUNT_RE.test(s), COUNT_RE.test(s), 'COUNT_RE.test is order-dependent — it carries lastIndex')
})

test('multiple tasks are reconciled independently and order is preserved', () => {
  const tasks = [
    { id: 'A', title: 'ok (2 files)', files: ['a.js', 'b.js'] },
    t05(),
    { id: 'C', title: 'no count here', files: ['c.js'] },
  ]
  const out = reconcileTitleCounts(tasks)
  assert.deepEqual(out.map(t => t.id), ['A', 'T05', 'C'])
  assert.equal(out[0], tasks[0], 'a correct task lost identity')
  assert.equal(out[2], tasks[2], 'a countless task lost identity')
  assert.match(out[1].title, /\b102 files\b/)
})

test('non-array and malformed input degrade quietly', () => {
  // This runs inside the plan pipeline. A throw here would fail a whole concern over a cosmetic
  // title, which is a strictly worse outcome than a stale count.
  assert.deepEqual(reconcileTitleCounts(null), [])
  assert.deepEqual(reconcileTitleCounts(undefined), [])
  assert.deepEqual(reconcileTitleCounts('nope'), [])
  const weird = [null, { id: 'X' }, { title: 'no id (5 files)', files: ['a.js'] }]
  const out = reconcileTitleCounts(weird)
  assert.equal(out.length, 3)
  assert.equal(out[0], null)
})

test('a non-string title is passed through rather than coerced', () => {
  const t = { id: 'T', title: undefined, files: ['a.js', 'b.js'] }
  assert.equal(reconcileTitleCounts([t])[0], t)
})

test('the reconciler reports what it changed', () => {
  // Silent correction is the failure mode this whole task is about: a number stated in prose
  // that nothing reconciled against the array. Correcting it silently just moves the silence.
  const { tasks, corrections } = reconcileTitleCounts.withReport([
    { id: 'A', title: 'fine (2 files)', files: ['a.js', 'b.js'] },
    t05(),
  ])
  assert.equal(tasks.length, 2)
  assert.equal(corrections.length, 1, 'exactly one task had a wrong count')
  assert.deepEqual(corrections[0], { id: 'T05', stated: 76, actual: 102 })
})

test('withReport returns an empty corrections list when nothing is wrong', () => {
  const { corrections } = reconcileTitleCounts.withReport([{ id: 'A', title: 'fine (2 files)', files: ['a.js', 'b.js'] }])
  assert.deepEqual(corrections, [])
})

// ── the synthesizer's counts ──────────────────────────────────────────────────────────────────
//
// reconcileTitleCounts fixes counts the ARCHITECT stated. The SYNTHESIZER states counts too — the
// Summary paragraph and the Files in Scope table — and it has no array to count from: its prompt
// passes `research.filesInScope` sliced to 20 entries, and nothing else. So on any plan touching
// more than 20 files, a synthesizer asked how many files are in scope can only estimate. That is
// the same defect as T05's title, one stage later and structurally guaranteed rather than
// occasional.
//
// The fix is to compute the numbers and hand them over, so "derive from the array" is true of the
// document a human actually reads.

import { fileCountSummary } from './title-counts.js'

test('fileCountSummary counts distinct files across all tasks', () => {
  const summary = fileCountSummary([
    { id: 'A', files: ['src/a.js', 'src/b.js'] },
    { id: 'B', files: ['src/c.js'] },
  ])
  assert.equal(summary.totalFiles, 3)
  assert.equal(summary.taskCount, 2)
})

test('a file touched by two tasks is counted once in the total', () => {
  // Otherwise the plan claims more files than the repo has, which is how a count stops being a
  // count and becomes a sum of task sizes.
  const summary = fileCountSummary([
    { id: 'A', files: ['src/shared.js', 'src/a.js'] },
    { id: 'B', files: ['src/shared.js'] },
  ])
  assert.equal(summary.totalFiles, 2, 'a shared file was double-counted')
})

test('per-task counts come back keyed by id, from the array', () => {
  const summary = fileCountSummary([
    { id: 'T05a', files: ['a.js', 'b.js'] },
    { id: 'T05b', files: ['c.js'] },
  ])
  assert.deepEqual(summary.byTask, { T05a: 2, T05b: 1 })
})

test('fileless tasks contribute zero and are still listed', () => {
  // Listed, because a task absent from byTask reads as "not counted yet" rather than "touches no
  // files", and the synthesizer would fill the gap with a guess.
  const summary = fileCountSummary([{ id: 'X', files: [] }, { id: 'Y' }])
  assert.deepEqual(summary.byTask, { X: 0, Y: 0 })
  assert.equal(summary.totalFiles, 0)
})

test('the summary renders as a prompt block naming every number', () => {
  const text = fileCountSummary([
    { id: 'A', files: ['src/a.js', 'src/b.js'] },
    { id: 'B', files: ['src/b.js'] },
  ]).promptBlock
  assert.match(text, /\b2\b/, 'the distinct total is absent')
  assert.match(text, /A: 2/, "task A's count is absent")
  assert.match(text, /B: 1/, "task B's count is absent")
})

test('the prompt block says these numbers are authoritative', () => {
  // A number handed over without that instruction is just another input the model may round. The
  // whole point is that it must not be re-derived.
  const text = fileCountSummary([{ id: 'A', files: ['a.js'] }]).promptBlock
  assert.match(text, /authoritative|do not|exact/i, 'nothing tells the synthesizer to use these verbatim')
})

test('fileCountSummary degrades quietly on malformed input', () => {
  for (const bad of [null, undefined, 'tasks', [null]]) {
    const s = fileCountSummary(bad)
    assert.equal(typeof s.promptBlock, 'string', `threw or returned junk for ${JSON.stringify(bad)}`)
    assert.equal(typeof s.totalFiles, 'number')
  }
})
