import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderPlansByDeps, extractPlanEntries, planPathFor } from './plan-sequencer.js'

// ── planPathFor ───────────────────────────────────────────────────────────────

test('planPathFor prefers the markdown path so implement can fall back to it', () => {
  // harness-implement derives the .json itself; handing it jsonPath makes both
  // resolve to the same file and kills its markdown fallback.
  const plan = { id: 'p1', path: 'docs/manifests/2026-07-27-slug.md', jsonPath: 'docs/manifests/2026-07-27-slug.json', dependsOn: [] }
  assert.equal(planPathFor(plan), 'docs/manifests/2026-07-27-slug.md')
})
test('planPathFor falls back to jsonPath when path is absent', () => {
  assert.equal(planPathFor({ id: 'p1', jsonPath: 'docs/p1.json' }), 'docs/p1.json')
})
test('planPathFor returns a repo-relative path, never an absolute one', () => {
  // implement joins it onto repoPath itself — an absolute path doubles the prefix
  assert.doesNotMatch(planPathFor({ id: 'p1', path: 'docs/manifests/x.md' }), /^\//)
})
test('planPathFor throws when the entry carries neither path', () => {
  assert.throws(() => planPathFor({ id: 'p9', dependsOn: [] }), /neither path nor jsonPath/)
  assert.throws(() => planPathFor(null), /plan entry is required/)
})

// ── extractPlanEntries ────────────────────────────────────────────────────────

test('extractPlanEntries returns plans array from manifest', () => {
  const manifest = {
    plans: [
      { id: 'p1', jsonPath: 'docs/p1.json', dependsOn: [] },
      { id: 'p2', jsonPath: 'docs/p2.json', dependsOn: ['p1'] },
    ],
  }
  const entries = extractPlanEntries(manifest)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].id, 'p1')
  assert.equal(entries[1].id, 'p2')
})

test('extractPlanEntries returns empty array when plans missing', () => {
  assert.deepEqual(extractPlanEntries({}), [])
  assert.deepEqual(extractPlanEntries({ plans: [] }), [])
})

test('extractPlanEntries throws when manifest is null', () => {
  assert.throws(() => extractPlanEntries(null), /manifest/)
})

// ── orderPlansByDeps ──────────────────────────────────────────────────────────

test('single plan → returned as-is', () => {
  const plans = [{ id: 'p1', jsonPath: 'a.json', dependsOn: [] }]
  assert.deepEqual(orderPlansByDeps(plans).map(p => p.id), ['p1'])
})

test('linear chain p1→p2→p3 → topological order p1, p2, p3', () => {
  const plans = [
    { id: 'p1', jsonPath: 'a.json', dependsOn: [] },
    { id: 'p2', jsonPath: 'b.json', dependsOn: ['p1'] },
    { id: 'p3', jsonPath: 'c.json', dependsOn: ['p2'] },
  ]
  assert.deepEqual(orderPlansByDeps(plans).map(p => p.id), ['p1', 'p2', 'p3'])
})

test('parallel plans (no deps) → all returned, p1 first (input order stable)', () => {
  const plans = [
    { id: 'p1', jsonPath: 'a.json', dependsOn: [] },
    { id: 'p2', jsonPath: 'b.json', dependsOn: [] },
    { id: 'p3', jsonPath: 'c.json', dependsOn: [] },
  ]
  const ordered = orderPlansByDeps(plans).map(p => p.id)
  assert.deepEqual(ordered, ['p1', 'p2', 'p3'])
})

test('two parallel G1 plans both precede G2 plan', () => {
  const plans = [
    { id: 'p1', jsonPath: 'a.json', dependsOn: [] },
    { id: 'p2', jsonPath: 'b.json', dependsOn: [] },
    { id: 'p3', jsonPath: 'c.json', dependsOn: ['p2'] },
  ]
  const ordered = orderPlansByDeps(plans).map(p => p.id)
  assert.ok(ordered.indexOf('p2') < ordered.indexOf('p3'))
  assert.ok(ordered.includes('p1'))
})

test('missing dependency id throws with descriptive error', () => {
  const plans = [
    { id: 'p1', jsonPath: 'a.json', dependsOn: ['p-ghost'] },
  ]
  assert.throws(() => orderPlansByDeps(plans), /p-ghost/)
})

test('circular dependency throws', () => {
  const plans = [
    { id: 'p1', jsonPath: 'a.json', dependsOn: ['p2'] },
    { id: 'p2', jsonPath: 'b.json', dependsOn: ['p1'] },
  ]
  assert.throws(() => orderPlansByDeps(plans), /circular|cycle/i)
})

test('empty plans array → empty result', () => {
  assert.deepEqual(orderPlansByDeps([]), [])
})

test('G1×2 → G2×1 → G3×1 produces correct order with all deps resolved', () => {
  // G1a and G1b are parallel; G2 depends on G1b; G3 depends on G2
  const plans = [
    { id: 'p1', jsonPath: 'a.json', dependsOn: [] },         // G1a
    { id: 'p2', jsonPath: 'b.json', dependsOn: [] },         // G1b
    { id: 'p3', jsonPath: 'c.json', dependsOn: ['p2'] },    // G2
    { id: 'p4', jsonPath: 'd.json', dependsOn: ['p3'] },    // G3
  ]
  const ordered = orderPlansByDeps(plans).map(p => p.id)
  assert.ok(ordered.indexOf('p2') < ordered.indexOf('p3'))
  assert.ok(ordered.indexOf('p3') < ordered.indexOf('p4'))
  assert.equal(ordered.length, 4)
})

test('result entries preserve jsonPath field', () => {
  const plans = [{ id: 'p1', jsonPath: 'docs/p1.json', dependsOn: [] }]
  const ordered = orderPlansByDeps(plans)
  assert.equal(ordered[0].jsonPath, 'docs/p1.json')
})
