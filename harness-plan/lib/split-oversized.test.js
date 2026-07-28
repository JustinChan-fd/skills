// RED first: this module does not exist yet.
//
// Nothing bounds per-task file count. The rule exists as prompt prose —
// `task-files-present-bounded → every task carries 1–3 concrete files[]` — but it lives in
// `refineBlock`, injected at one site behind a `refine` flag that has been falsy at every call
// since the bridge was removed. So it is dead text, and a regression the bridge removal
// introduced rather than an architect defying a live rule.
//
// What that cost, measured: TARS-1271's T05 was one hi-developer agent grinding a 102-entry
// files[] one Read+Edit at a time — 27 files in ~25 min before it abandoned per-file edits for
// improvised Python regex batch-rewriters and shipped a res.data-vs-res bug the conversion
// table states verbatim. Its title said "~76 files" against 102 entries; it was not counting
// its own array.
//
// Prompt text alone cannot fix this: an architect facing 102 files rationalizes past a flat
// "1–3 files" that gives no reason and no method. Schema-level maxItems was rejected too — it
// makes the agent retry blind with no instruction on HOW to split. So the enforcement is
// deterministic and post-hoc: split the array in code, after the architect returns.
//
// The leverage is already in harness-implement: it runs same-group tasks concurrently
// (workflow.js:638), downgrades to sequential only on shared files, and lands ONE commit per
// group. So N same-groupId, block:'parallel' siblings with disjoint files[] need no new
// orchestration. This is not a token-limit fallback — it is 1 agent doing 102 sequential edits
// versus 10 doing ~10 each.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitOversizedTasks } from './split-oversized.js'

/** A task with n files under one directory, plus the fields the splitter must carry over. */
const taskWith = (n, dir = 'src/client', extra = {}) => ({
  id: 'T05',
  title: 'Migrate axios to fetch',
  description: 'WHAT: migrate\nWHERE: src/client/api.js:12\nHOW: ```js\nfetch()\n```\nDONE: grep -r axios src/ returns nothing',
  block: 'sequential',
  groupId: 'G3',
  files: Array.from({ length: n }, (_, i) => `${dir}/f${i}.js`),
  tddRequired: true,
  acceptanceCriteria: ['no axios imports remain'],
  ...extra,
})

test('a task at or under the cap passes through by identity', () => {
  // Identity, not a copy: anything else churns object references for no reason and would make
  // a downstream `===` check silently stop matching.
  for (const n of [1, 2, 3, 7, 8]) {
    const t = taskWith(n)
    const out = splitOversizedTasks([t])
    assert.equal(out.length, 1, `${n} files should not split`)
    assert.equal(out[0], t, `${n} files: task was rebuilt instead of passed through`)
  }
})

test('an empty files[] task is untouched', () => {
  // Guards harness-plan's XS fast path, which hardcodes files: [] with groupId G1 and
  // block:'sequential'. A splitter that treated 0 as "unknown, split anyway" would rewrite the
  // one task shape that is deliberately fileless.
  const t = taskWith(0)
  const out = splitOversizedTasks([t])
  assert.equal(out.length, 1)
  assert.equal(out[0], t)
})

test('a task with no files key at all is untouched', () => {
  const t = { id: 'T1', title: 'x', description: 'y', groupId: 'G1', block: 'sequential' }
  assert.deepEqual(splitOversizedTasks([t]), [t])
})

test('the cap is inclusive — 8 passes, 9 splits', () => {
  // The boundary is the thing most likely to be got wrong, and it must match the two other
  // places this number already lives: _FILE_BUDGET_CAP = 8 in harness-plan/workflow.js and
  // intake's noOversized check (">8 files"). One number, not a third threshold.
  assert.equal(splitOversizedTasks([taskWith(8)]).length, 1)
  assert.ok(splitOversizedTasks([taskWith(9)]).length > 1)
})

test('102 files split into at least 13 chunks, none over the cap', () => {
  const out = splitOversizedTasks([taskWith(102)])
  assert.ok(out.length >= 13, `expected >=13 chunks, got ${out.length}`)
  for (const c of out) assert.ok(c.files.length <= 8, `chunk ${c.id} has ${c.files.length} files`)
})

test('the parent task is dropped, not kept alongside its chunks', () => {
  const out = splitOversizedTasks([taskWith(20)])
  assert.ok(!out.some(c => c.id === 'T05'), 'the oversized parent survived — its files would be done twice')
})

test('chunk files are the parent files exactly: no drops, no duplicates', () => {
  const parent = taskWith(102)
  const out = splitOversizedTasks([parent])
  const all = out.flatMap(c => c.files)
  assert.equal(all.length, 102, 'file count changed')
  assert.equal(new Set(all).size, 102, 'a file appears in more than one chunk')
  assert.deepEqual([...all].sort(), [...parent.files].sort())
})

test('chunks are disjoint, so the DAG guard never downgrades them', () => {
  // downgradeConflictingGroups flips a whole group to sequential when two parallel tasks in it
  // share a file. Overlapping chunks would silently undo the entire point of splitting.
  const out = splitOversizedTasks([taskWith(50)])
  const seen = new Set()
  for (const c of out) for (const f of c.files) {
    assert.ok(!seen.has(f), `${f} is in two chunks — the group will downgrade to sequential`)
    seen.add(f)
  }
})

test('every chunk inherits the parent groupId and is parallel', () => {
  // Inheriting groupId is what puts the chunks on harness-implement's group-parallel path and
  // keeps them landing as ONE commit.
  const out = splitOversizedTasks([taskWith(30)])
  for (const c of out) {
    assert.equal(c.groupId, 'G3', `chunk ${c.id} left its group`)
    assert.equal(c.block, 'parallel', `chunk ${c.id} is not parallel`)
  }
})

test('chunk ids are the parent id suffixed a, b, c…', () => {
  const out = splitOversizedTasks([taskWith(30)])
  assert.equal(out[0].id, 'T05a')
  assert.equal(out[1].id, 'T05b')
  assert.equal(new Set(out.map(c => c.id)).size, out.length, 'duplicate chunk ids')
})

test('chunk ids stay unique past 26 chunks', () => {
  // 102 files at 8 per chunk is 13, but a smaller cap or a bigger array reaches the end of the
  // alphabet, and a duplicate id makes harness-implement's findIndex(t => t.id === …) patch the
  // wrong task.
  const out = splitOversizedTasks([taskWith(300)], 1)
  assert.equal(out.length, 300)
  assert.equal(new Set(out.map(c => c.id)).size, 300, 'chunk ids collide past z')
  // Uniqueness alone is too weak to pin the suffix scheme: a naive
  // String.fromCharCode(97 + n) also yields 300 distinct strings — they are just not letters
  // (T05ǅ). Ids land in commit messages, log lines and the plan doc, so the suffix must stay
  // inside the alphabet it advertises.
  for (const c of out) {
    assert.match(c.id, /^T05[a-z]+$/, `chunk id left the a-z alphabet: ${c.id}`)
  }
  assert.equal(out[25].id, 'T05z', 'the 26th chunk should be the last single letter')
  assert.equal(out[26].id, 'T05aa', 'the 27th chunk should roll over to two letters')
})

test('several tasks in one array split independently and keep their order', () => {
  const small = { ...taskWith(2), id: 'T01', groupId: 'G1' }
  const big = taskWith(20)
  const out = splitOversizedTasks([small, big])
  assert.equal(out[0], small, 'the small task moved or was rebuilt')
  assert.ok(out.slice(1).every(c => c.id.startsWith('T05')))
})

test('never mutates the input tasks', () => {
  const parent = taskWith(102)
  const before = JSON.stringify(parent)
  splitOversizedTasks([parent])
  assert.equal(JSON.stringify(parent), before, 'the parent task was edited in place')
})

test('a non-array argument returns an empty array rather than throwing', () => {
  for (const bad of [null, undefined, 'tasks', {}]) {
    assert.deepEqual(splitOversizedTasks(bad), [], `threw or mishandled ${JSON.stringify(bad)}`)
  }
})

// ── Split axis: directory-coherent, then packed to cap ────────────────────────
// Not an even N-way split. Files in one directory share imports and call shapes, so a
// directory-coherent chunk lets one agent amortize what it learns; an even split scatters
// campaigns/ across three agents that each rediscover the same pattern.

test('files are grouped by directory before packing', () => {
  const t = {
    ...taskWith(0),
    files: [
      'src/campaigns/a.js', 'src/campaigns/b.js', 'src/campaigns/c.js',
      'src/admin/x.js', 'src/admin/y.js',
      'src/reports/r.js', 'src/reports/s.js', 'src/reports/t.js', 'src/reports/u.js',
    ],
  }
  const out = splitOversizedTasks([t], 4)
  for (const c of out) {
    const dirs = new Set(c.files.map(f => f.slice(0, f.lastIndexOf('/'))))
    assert.equal(dirs.size, 1, `chunk ${c.id} mixes directories: ${c.files.join(', ')}`)
  }
})

test('one directory exceeding the cap falls back to index splitting within it', () => {
  const t = { ...taskWith(0), files: Array.from({ length: 19 }, (_, i) => `src/client/f${i}.js`) }
  const out = splitOversizedTasks([t], 8)
  assert.equal(out.length, 3, `19 files at cap 8 should be 3 chunks, got ${out.length}`)
  assert.deepEqual(out.map(c => c.files.length), [8, 8, 3])
})

test('small directories pack together rather than each becoming its own chunk', () => {
  // Otherwise 12 one-file directories become 12 agents, each paying full context setup to edit
  // a single file — the opposite failure from the one being fixed.
  const t = { ...taskWith(0), files: Array.from({ length: 12 }, (_, i) => `src/d${i}/only.js`) }
  const out = splitOversizedTasks([t], 8)
  assert.ok(out.length <= 2, `12 single-file dirs should pack into <=2 chunks, got ${out.length}`)
})

test('chunk titles carry the scope and a count derived from the array', () => {
  // T05's title claimed "~76 files" for a 102-entry array. Counts come from files.length or
  // they are wrong again.
  const out = splitOversizedTasks([taskWith(20)])
  for (const c of out) {
    assert.match(c.title, new RegExp(`\\b${c.files.length}\\b`), `chunk ${c.id} title omits its real count: ${c.title}`)
    assert.ok(c.title.startsWith('Migrate axios to fetch'), 'parent title lost')
  }
})

test('description, rules, table and snippets are copied verbatim to every chunk', () => {
  // A chunk whose criteria cite "Rule D" without the table is what made T05 burn 16 Bash calls
  // reverse-engineering the contract from an earlier commit.
  const t = taskWith(20, 'src/client', {
    conversionRules: { D: 'return res, not res.data' },
    conversionTable: [['axios.get', 'fetch']],
    snippets: '```js\nawait fetch(u)\n```',
  })
  const out = splitOversizedTasks([t])
  for (const c of out) {
    assert.equal(c.description, t.description)
    assert.deepEqual(c.conversionRules, t.conversionRules)
    assert.deepEqual(c.conversionTable, t.conversionTable)
    assert.equal(c.snippets, t.snippets)
    assert.equal(c.tddRequired, true)
  }
})

test('absent optional fields are not invented on the chunks', () => {
  const out = splitOversizedTasks([taskWith(20)])
  for (const c of out) {
    assert.ok(!('conversionRules' in c), 'conversionRules invented')
    assert.ok(!('snippets' in c), 'snippets invented')
  }
})

test('dependsOn is inherited from the parent and siblings do not depend on each other', () => {
  // Sibling dependencies would serialize the chunks and undo the split.
  const out = splitOversizedTasks([taskWith(20, 'src/client', { dependsOn: ['T04'] })])
  for (const c of out) {
    assert.deepEqual(c.dependsOn, ['T04'], `chunk ${c.id} lost or gained a dependency`)
    for (const sib of out) assert.ok(!(c.dependsOn || []).includes(sib.id), 'sibling dependency introduced')
  }
})

// ── The DONE rewrite ─────────────────────────────────────────────────────────
// Load-bearing. T05's DONE was a repo-wide grep that cannot pass until all 102 files convert,
// so no chunk could verify itself and every chunk's assertion would fail until the last one
// finished — verifying nothing intermediate.

test('a scoped path in the parent DONE is replaced by the chunk files', () => {
  const t = { ...taskWith(0), files: Array.from({ length: 12 }, (_, i) => `src/client/f${i}.js`),
    acceptanceCriteria: ['grep -r "axios" src/ returns nothing'] }
  const out = splitOversizedTasks([t], 8)
  const first = out[0].acceptanceCriteria.join('\n')
  assert.ok(!/\bsrc\/\s/.test(first + ' '), `chunk 1 still asserts over the whole tree: ${first}`)
  assert.ok(out[0].files.some(f => first.includes(f)), 'chunk 1 DONE names none of its own files')
})

test('each chunk DONE names only its own files, never a sibling\'s', () => {
  const out = splitOversizedTasks([{ ...taskWith(0),
    files: Array.from({ length: 16 }, (_, i) => `src/client/f${i}.js`),
    acceptanceCriteria: ['grep -r "axios" src/client returns nothing'] }], 8)
  out.forEach((c, i) => {
    const text = c.acceptanceCriteria.join('\n')
    for (const sib of out) {
      if (sib === c) continue
      for (const f of sib.files) {
        if (c.files.includes(f)) continue
        assert.ok(!text.includes(f), `chunk ${i + 1} asserts over sibling file ${f}`)
      }
    }
  })
})

test('an unsubstitutable DONE becomes a per-file loop over the chunk files', () => {
  // No path to swap, so the assertion has to be synthesized rather than left repo-wide.
  const out = splitOversizedTasks([{ ...taskWith(0),
    files: ['src/a/x.js', 'src/a/y.js', 'src/a/z.js'],
    acceptanceCriteria: ['no axios imports remain anywhere'] }], 2)
  const first = out[0].acceptanceCriteria.join('\n')
  assert.ok(out[0].files.some(f => first.includes(f)), `chunk DONE mentions no chunk file: ${first}`)
})

test('the parent repo-wide assertion is retained exactly once, on the last chunk', () => {
  // The closure check: something must still prove the whole concern landed, and it can only
  // pass once every sibling is done — which is true only for the last chunk.
  const parentDone = 'grep -r "axios" src/ returns nothing'
  const out = splitOversizedTasks([{ ...taskWith(0),
    files: Array.from({ length: 24 }, (_, i) => `src/client/f${i}.js`),
    acceptanceCriteria: [parentDone] }], 8)
  const carriers = out.filter(c => c.acceptanceCriteria.includes(parentDone))
  assert.equal(carriers.length, 1, `parent assertion appears on ${carriers.length} chunks, want exactly 1`)
  assert.equal(carriers[0], out[out.length - 1], 'the closure check is not on the last chunk')
})

test('a task with no acceptanceCriteria still splits and gets an array', () => {
  const t = { id: 'T9', title: 'x', description: 'd', groupId: 'G1', block: 'sequential',
    files: Array.from({ length: 10 }, (_, i) => `src/z/f${i}.js`) }
  const out = splitOversizedTasks([t], 4)
  assert.ok(out.length > 1)
  for (const c of out) assert.ok(Array.isArray(c.acceptanceCriteria))
})
