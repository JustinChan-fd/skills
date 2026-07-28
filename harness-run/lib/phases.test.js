// Every phase an agent claims must be declared in meta.phases, and bookkeeping must not
// borrow a pipeline phase's name.
//
// checkpoint-*, stamp-*, and telemetry-* all tagged `phase: 'Summary'`. Summary is also the
// pipeline's terminal phase, so the progress tree showed the run's last row completing
// seconds in — the plan→implement checkpoint fires before Implement starts. Nothing executed
// out of order; the display just said the run had finished while it was still working, which
// is the one thing a progress tree exists to tell you.
//
// A phase string that matches no meta.phases entry silently gets its own group box, so a typo
// is invisible too. Both are checked here by reading workflow.js as text — the same approach
// as debrief-write.test.js, and for the same reason: this is a claim about the source, and the
// source is the only thing available to assert against without running a workflow.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../workflow.js', import.meta.url), 'utf8')

/** Titles declared in the `meta.phases` literal. */
function declaredPhases(src) {
  const start = src.indexOf('phases:')
  const end = src.indexOf('}', src.indexOf('],', start))
  return [...src.slice(start, end).matchAll(/title:\s*'([^']+)'/g)].map(m => m[1])
}

/** Every `phase: '...'` an agent() call passes, with the label it belongs to. */
function claimedPhases(src) {
  return [...src.matchAll(/label:\s*(?:`([^`]*)`|'([^']*)')\s*,\s*phase:\s*'([^']+)'/g)]
    .map(m => ({ label: m[1] ?? m[2], phase: m[3] }))
}

test('meta.phases parses and is non-empty', () => {
  assert.ok(declaredPhases(SRC).length >= 5, 'could not read meta.phases — has the literal moved?')
})

test('at least one agent claims a phase', () => {
  // Guards the regex itself: if the call shape changes, these tests must fail loudly rather
  // than pass over an empty list.
  assert.ok(claimedPhases(SRC).length >= 8, 'phase-claim regex matched almost nothing')
})

test('every phase an agent claims is declared in meta.phases', () => {
  const declared = new Set(declaredPhases(SRC))
  for (const { label, phase } of claimedPhases(SRC)) {
    assert.ok(declared.has(phase), `agent "${label}" claims undeclared phase '${phase}' — it will render in its own unlabelled group box`)
  }
})

test('bookkeeping agents do not claim a pipeline phase', () => {
  // The bug. These three run between stages and after them; putting them in a pipeline phase
  // makes that phase report complete before the work it names has started.
  const BOOKKEEPING = /^(checkpoint|stamp|telemetry)-/
  for (const { label, phase } of claimedPhases(SRC)) {
    if (!BOOKKEEPING.test(label)) continue
    assert.equal(
      phase, 'Bookkeeping',
      `bookkeeping agent "${label}" claims '${phase}' — a checkpoint firing between stages ` +
      `marks that phase done while the run is still going`
    )
  }
});

test('all three bookkeeping label families are present and accounted for', () => {
  // If a family is renamed, the check above stops covering it and passes vacuously.
  const labels = claimedPhases(SRC).map(c => c.label)
  for (const family of ['checkpoint-', 'stamp-', 'telemetry-']) {
    assert.ok(labels.some(l => l.startsWith(family)), `no agent labelled ${family}* — renamed?`)
  }
})

test('Bookkeeping is declared last, after the pipeline phases', () => {
  // Ordering is display order. Bookkeeping interleaves with everything, so it reads best as a
  // trailing group rather than wedged between two stages it sits either side of.
  const declared = declaredPhases(SRC)
  assert.equal(declared[declared.length - 1], 'Bookkeeping')
})

test('Summary remains a declared phase and keeps its pipeline meaning', () => {
  // The fix is to move bookkeeping OUT of Summary, not to delete Summary.
  assert.ok(declaredPhases(SRC).includes('Summary'))
})
