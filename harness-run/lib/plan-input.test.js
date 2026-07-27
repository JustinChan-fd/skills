import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPlanInput, MIN_PLAN_INPUT_CHARS } from './plan-input.js'

const XS_MANIFEST = {
  skill: 'harness-intake',
  sourceIssue: 'TARS-1271',
  sourceTitle: 'Migrate native fetch from axios',
  size: 'S',
  workType: 'migration',
  migrationPattern: 'axios → native fetch',
  scopePath: 'src/lib/api',
  acList: [
    { bullet: 'All axios calls in src/lib/api use native fetch' },
    { bullet: 'Existing tests still pass' },
  ],
  files: [],
  groundedReality: null,
}

const L_MANIFEST = {
  ...XS_MANIFEST,
  size: 'L',
  files: ['a.ts', 'b.ts', 'c.ts'],
  groundedReality: {
    summary: 'Forty-one call sites across the api and hooks layers still construct axios instances.',
    actualFileCount: 41,
    actualScope: 'src/lib/api + src/hooks',
    ticketClaimsToIgnore: ['ticket says 118 files', 'ticket says the hooks layer is untouched'],
    keyFiles: ['src/lib/api/client.ts'],
    migrationNotes: 'test files mock axios with a different helper than prod files',
  },
}

// ---- the defect this module exists to prevent ----
test('never returns a bare issue key — the old ticketSummary/summary lookup produced exactly that', () => {
  // Neither field exists on a real intake manifest; the old expression yielded 'TARS-1271\n\n'
  assert.equal(XS_MANIFEST.ticketSummary, undefined)
  assert.equal(XS_MANIFEST.summary, undefined)
  const out = buildPlanInput(XS_MANIFEST, { issueKey: 'TARS-1271' })
  assert.ok(out.length > MIN_PLAN_INPUT_CHARS, `expected substantive input, got ${out.length} chars`)
  assert.notEqual(out.trim(), 'TARS-1271')
})

test('throws when manifest is missing', () => {
  assert.throws(() => buildPlanInput(null), /manifest is required/)
})

// ---- heading ----
test('heading carries the issue key so harness-plan can regex it back out', () => {
  const out = buildPlanInput(XS_MANIFEST, { issueKey: 'TARS-1271' })
  assert.match(out.split('\n')[0], /^TARS-1271 — Migrate native fetch from axios$/)
  assert.match(out, /\bTARS-1271\b/)
})
test('heading falls back to sourceTitle when no issue key', () => {
  const out = buildPlanInput(XS_MANIFEST)
  assert.equal(out.split('\n')[0], 'Migrate native fetch from axios')
})
test('heading falls back to the issue key when sourceTitle is absent', () => {
  const out = buildPlanInput({ ...XS_MANIFEST, sourceTitle: null }, { issueKey: 'TARS-1271' })
  assert.equal(out.split('\n')[0], 'TARS-1271 — TARS-1271')
})

// ---- groundedReality precedence ----
test('groundedReality wins over ticket text when present', () => {
  const out = buildPlanInput(L_MANIFEST, { issueKey: 'TARS-1271', ticketInput: 'RAW TICKET BODY' })
  assert.match(out, /GROUNDED REALITY/)
  assert.match(out, /Forty-one call sites/)
  assert.doesNotMatch(out, /RAW TICKET BODY/)
})
test('groundedReality renders count, scope, notes and refuted claims', () => {
  const out = buildPlanInput(L_MANIFEST, { issueKey: 'TARS-1271' })
  assert.match(out, /Verified file count: 41/)
  assert.match(out, /Verified scope: src\/lib\/api \+ src\/hooks/)
  assert.match(out, /Migration notes: test files mock axios/)
  assert.match(out, /ticket says 118 files; ticket says the hooks layer is untouched/)
})
test('actualFileCount falls back to files[].length when absent', () => {
  const m = { ...L_MANIFEST, groundedReality: { ...L_MANIFEST.groundedReality, actualFileCount: undefined } }
  assert.match(buildPlanInput(m), /Verified file count: 3/)
})
test('actualFileCount of 0 is preserved, not coerced to files[].length', () => {
  const m = { ...L_MANIFEST, groundedReality: { ...L_MANIFEST.groundedReality, actualFileCount: 0 } }
  assert.match(buildPlanInput(m), /Verified file count: 0/)
})
test('a groundedReality with no summary is treated as absent', () => {
  const m = { ...XS_MANIFEST, groundedReality: { actualFileCount: 5 } }
  const out = buildPlanInput(m, { ticketInput: 'RAW TICKET BODY' })
  assert.doesNotMatch(out, /GROUNDED REALITY/)
  assert.match(out, /RAW TICKET BODY/)
})

// ---- ticket text fallback (XS/S/M) ----
test('falls back to raw ticket text when groundedReality is null', () => {
  const out = buildPlanInput(XS_MANIFEST, { issueKey: 'TARS-1271', ticketInput: 'Replace axios with fetch everywhere.' })
  assert.match(out, /Replace axios with fetch everywhere\./)
  assert.doesNotMatch(out, /GROUNDED REALITY/)
})

// ---- ACs and scope ----
test('AC bullets are rendered as a list', () => {
  const out = buildPlanInput(XS_MANIFEST, { issueKey: 'TARS-1271' })
  assert.match(out, /Acceptance criteria:\n- All axios calls in src\/lib\/api use native fetch\n- Existing tests still pass/)
})
test('AC entries without a bullet are dropped, not rendered as undefined', () => {
  const m = { ...XS_MANIFEST, acList: [{ bullet: 'real one' }, { notBullet: 'x' }, {}] }
  const out = buildPlanInput(m, { issueKey: 'TARS-1271' })
  assert.match(out, /- real one/)
  assert.doesNotMatch(out, /undefined/)
})
test('an empty acList omits the section header entirely', () => {
  const out = buildPlanInput({ ...XS_MANIFEST, acList: [] }, { issueKey: 'TARS-1271', ticketInput: 'body text here' })
  assert.doesNotMatch(out, /Acceptance criteria/)
})
test('migrationPattern and scopePath are carried through', () => {
  const out = buildPlanInput(XS_MANIFEST, { issueKey: 'TARS-1271' })
  assert.match(out, /Migration pattern: axios → native fetch/)
  assert.match(out, /Scope path: src\/lib\/api/)
})

// ---- formatting ----
test('absent optional fields leave no blank-line runs or stray separators', () => {
  const bare = { sourceTitle: 'Some title', acList: [], files: [] }
  const out = buildPlanInput(bare, { issueKey: 'TARS-1', ticketInput: 'ticket body' })
  assert.doesNotMatch(out, /\n\n\n/)
  assert.doesNotMatch(out, /: *$/m)
  assert.equal(out, out.trim())
})
test('a manifest with nothing usable yields output below the floor so the conductor can stop', () => {
  const out = buildPlanInput({ sourceTitle: null, acList: [], files: [] }, { issueKey: 'TARS-1' })
  assert.ok(out.length < MIN_PLAN_INPUT_CHARS, `expected < ${MIN_PLAN_INPUT_CHARS}, got ${out.length}: ${JSON.stringify(out)}`)
})
