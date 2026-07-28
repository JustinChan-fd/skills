// The five structural invariants must reach the architect on EVERY run, not only a refine pass.
//
// This is the regression the bridge removal introduced. All five live inside `refineBlock`
// (workflow.js), which is `refine ? '...' : ''`. `refine` comes from `args.refine`, set only by
// the bridge's Handoff-B refine loop — and the bridge has been parked since 2026-07-27. So the
// block has evaluated to the empty string at every call since, and the architect has been
// planning without ever being told that a task carries 1–3 files, that WHERE must resolve to a
// file in files[], or that a companion edit must be in someone's scope.
//
// That reframes TARS-1271's T05: a 102-entry files[] was not an architect defying a live rule,
// it was an architect that was never given one.
//
// Four of the five bullets are unconditional structural facts about a well-formed task — they
// are true on a first pass and a refine pass alike. Only the "weak checks / skeptic notes"
// preamble is refine-specific, because only a refine pass has flags to report. So the fix is to
// split them: STRUCTURAL_INVARIANTS injected always, refineBlock holding just the preamble.
//
// Tested by reading workflow.js as text, for the same reason as phases.test.js and
// inline-mirror.test.js: the claim is about what the source unconditionally contains, and
// running the workflow to find out is not available to a unit test.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../workflow.js', import.meta.url), 'utf8')

/** The five invariant ids, exactly as the architect prompt names them. */
const INVARIANTS = [
  'task-spec-completeness',
  'task-files-present-bounded',
  'where-resolves-to-files',
  'companion-edit-closure',
  'concern-atomicity',
]

/** Slice the `const NAME = ...` initialiser, balancing backticks for a template literal. */
function declOf(src, name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*`))
  if (!m) return null
  const start = m.index + m[0].length
  if (src[start] !== '`') return null
  const end = src.indexOf('`', start + 1)
  return end === -1 ? null : src.slice(start + 1, end)
}

test('STRUCTURAL_INVARIANTS exists as its own declaration', () => {
  assert.ok(declOf(SRC, 'STRUCTURAL_INVARIANTS'), 'no STRUCTURAL_INVARIANTS template literal — the invariants are still inside refineBlock')
})

test('all five invariants live in STRUCTURAL_INVARIANTS', () => {
  const block = declOf(SRC, 'STRUCTURAL_INVARIANTS') || ''
  for (const id of INVARIANTS) {
    assert.ok(block.includes(id), `${id} is not in STRUCTURAL_INVARIANTS`)
  }
})

test('STRUCTURAL_INVARIANTS is not conditional on refine', () => {
  // The bug in one assertion. A `refine ?` anywhere in this declaration reintroduces exactly the
  // gating that made the whole block dead code.
  const m = SRC.match(/const STRUCTURAL_INVARIANTS\s*=\s*([^\n]*)/)
  assert.ok(m, 'STRUCTURAL_INVARIANTS not found')
  assert.ok(!/refine/.test(m[1]), `STRUCTURAL_INVARIANTS is gated: ${m[1].trim()}`)
})

test('the architect prompt interpolates STRUCTURAL_INVARIANTS', () => {
  // Declaring it and not injecting it is the same class of failure as computing a split and not
  // assigning it — the constant exists, the tests pass, the architect never sees it.
  const promptSite = SRC.indexOf('${STRUCTURAL_INVARIANTS}')
  assert.ok(promptSite !== -1, 'STRUCTURAL_INVARIANTS is declared but never interpolated into a prompt')
  // And it must be in the architect call, not somewhere incidental: the nearest following
  // `label:` should be the architect's.
  const label = SRC.slice(promptSite, promptSite + 2000).match(/label:\s*`([^`]+)`/)
  assert.ok(label, 'could not find the agent call that receives STRUCTURAL_INVARIANTS')
  assert.match(label[1], /architect/, `injected into '${label[1]}' rather than the architect`)
})

test('refineBlock keeps the refine-only preamble and nothing structural', () => {
  // refineBlock should still exist — a refine pass genuinely has flags and skeptic notes to
  // report. It just must not be the only carrier of the always-true rules.
  const m = SRC.match(/const refineBlock\s*=\s*refine\s*\?/)
  assert.ok(m, 'refineBlock is gone or no longer gated on refine — a refine pass needs its flags')
  const block = SRC.slice(m.index, SRC.indexOf("` : ''", m.index))
  for (const id of INVARIANTS) {
    assert.ok(!block.includes(id), `${id} is still inside refineBlock, where refine=null makes it dead text`)
  }
  assert.match(block, /Weak checks|Skeptic notes/, 'refineBlock lost its refine-specific content')
})

test('the file bound in the prompt is interpolated from the enforced constant', () => {
  // Three copies of this number already exist in the tree. A prompt that hardcodes a literal can
  // drift from what _splitOversizedTasks enforces, and then the architect is told one bound
  // while a different one silently rewrites its output — so the prompt must READ the constant,
  // not restate it.
  const block = declOf(SRC, 'STRUCTURAL_INVARIANTS') || ''
  const capM = SRC.match(/const _FILE_BUDGET_CAP\s*=\s*(\d+)/)
  assert.ok(capM, 'no _FILE_BUDGET_CAP')
  assert.match(
    block, /\$\{_FILE_BUDGET_CAP\}/,
    'STRUCTURAL_INVARIANTS states the file bound as a literal instead of interpolating _FILE_BUDGET_CAP'
  )
  // And the rendered text must actually carry the number, so the interpolation is not merely
  // present but in a position the architect reads as the bound.
  const rendered = block.replace(/\$\{_FILE_BUDGET_CAP\}/g, capM[1])
  assert.ok(
    rendered.includes(`exceed ${capM[1]}`),
    `the rendered bound does not read as a maximum: ${rendered.slice(0, 200)}`
  )
})

test('the invariants tell the architect HOW to split, not just that it must', () => {
  // A flat "1–3 files" gives no method, which is what an architect facing 102 files rationalizes
  // past. The instruction has to name the mechanism that actually exists downstream: same
  // groupId, block parallel, disjoint files.
  const block = declOf(SRC, 'STRUCTURAL_INVARIANTS') || ''
  assert.match(block, /groupId/, 'no mention of groupId — the architect cannot know how to split')
  assert.match(block, /parallel/, 'no mention of block: parallel')
  assert.match(block, /disjoint|do not overlap|non-overlapping/i, 'nothing tells the architect the file sets must not overlap')
})

test('the invariants require each parallel sibling DONE to be self-scoped', () => {
  // The other half of the T05 failure: a repo-wide grep as DONE cannot pass until every sibling
  // finishes, so it verifies nothing intermediate.
  const block = declOf(SRC, 'STRUCTURAL_INVARIANTS') || ''
  assert.match(block, /scoped|its own files/i, 'nothing requires a sibling DONE to be scoped to its own files')
})
