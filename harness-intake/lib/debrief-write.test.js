// Structural guard: the audit write cannot silently vanish from the Debrief phase.
//
// This is a source-text search, and it is deliberately crude. It proves a write call
// *exists* between each trackPhase('Debrief') and the return that follows it — not that it
// executed. That limit is worth stating plainly, because the bug this whole phase fixes was
// a green test asserting the wrong thing: lib/telemetry.js pointed at a `logs/` directory
// that has never existed on disk, and the assertion passed for the entire bridge era
// because the function had zero callers.
//
// So this test is not proof the write works. It is proof that the *call site* is still
// there — the one thing an automated check can establish about an agent() invocation, and
// the exact regression that produced zero harness-implement records in ~9 months. The real
// proof is running the skill and watching a record appear untouched by hand.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../workflow.js', import.meta.url), 'utf8')

/**
 * Every `trackPhase('Debrief')` and the text from it to the next top-level `return {`.
 *
 * harness-plan has two of these (the XS fast path returns early, the main path returns at
 * the end) and both must write — the XS path is the one most likely to be forgotten, since
 * it skips almost everything else.
 */
function debriefRegions(src) {
  const regions = []
  const re = /trackPhase\(\s*'Debrief'\s*\)/g
  let m
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index)
    const end = rest.search(/\n\s*return \{/)
    regions.push(rest.slice(0, end === -1 ? rest.length : end))
  }
  return regions
}

test('workflow.js has at least one Debrief phase', () => {
  assert.ok(debriefRegions(SRC).length > 0, 'no trackPhase(\'Debrief\') — has the phase been renamed?')
})

test('every Debrief region calls the audit write before returning', () => {
  const regions = debriefRegions(SRC)
  regions.forEach((region, i) => {
    assert.match(
      region,
      /_writeAuditRecord\(/,
      `Debrief region ${i + 1}/${regions.length} returns without calling _writeAuditRecord() — ` +
      `this is the regression that left harness-implement with zero telemetry records`
    )
  })
})

test('the write goes through the mirrored prompt builder, not an ad-hoc inline string', () => {
  // If a future edit hand-rolls the prompt, the quoting and duration logic stop being the
  // tested ones and the inline mirror check stops covering the write.
  assert.match(SRC, /function _writeAuditRecord\s*\(/, 'no inline _writeAuditRecord definition')
  assert.match(SRC, /_buildWriteAgentPrompt\(/, '_writeAuditRecord must use the mirrored prompt builder')
})

test('the write agent is cheap and labelled, so it is visible in the progress tree', () => {
  const fn = SRC.slice(SRC.indexOf('function _writeAuditRecord'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1)
  assert.match(body, /claude-haiku/, 'the write is mechanical — it must not burn a reasoning seat')
  assert.match(body, /label:/, 'must carry its own label')
  assert.match(body, /phase:\s*'Debrief'/, 'must be pinned to Debrief so it groups correctly')
})

test('_writeAuditRecord swallows its own failures — telemetry must never fail a run', () => {
  const fn = SRC.slice(SRC.indexOf('function _writeAuditRecord'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1)
  assert.match(body, /try\s*\{/, 'the agent call must be wrapped in try/catch')
  assert.match(body, /catch/, 'a telemetry failure must not throw out of Debrief')
})

test('the crash path still carries telemetryPath and the audit record out with the error', () => {
  // The in-workflow write may never have run when the workflow throws, so the SKILL.md
  // crash-path write stays the only writer there and needs its payload.
  assert.match(SRC, /throw Object\.assign\(err, \{[^}]*telemetryPath/s, 'crash path lost its telemetry payload')
})

// ── The validator must be consulted, not merely present (Phase 1e) ────────────
//
// Mirroring _classifyV2Record into the PURE block accomplishes nothing on its own: an
// unreferenced function is exactly the shape of the `logs/` bug this suite exists to prevent.
// These assert the grade is computed and logged at the point where it can still be acted on.

test('the grade happens inside the write, so no call site can skip it', () => {
  // Deliberately NOT asserted per-Debrief-region. Grading lives inside _writeAuditRecord,
  // which means every present and future write site inherits it — a per-site assertion would
  // pass while a newly added write site silently graded nothing.
  const fn = SRC.slice(SRC.indexOf('async function _writeAuditRecord'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1)
  assert.match(
    body,
    /_gradeAuditRecord\(/,
    '_writeAuditRecord writes a record it never graded — a mirrored validator with no caller ' +
    'is the logs/ bug in a new costume'
  )
  // …and it must grade BEFORE the agent runs, so the log explains a bad record rather than
  // trailing it.
  assert.ok(
    body.indexOf('_gradeAuditRecord(') < body.indexOf('await agent('),
    'grade the record before writing it, not after'
  )
})

test('the grade is logged, and never throws or fails the run', () => {
  const fn = SRC.slice(SRC.indexOf('function _gradeAuditRecord'))
  assert.ok(fn.startsWith('function _gradeAuditRecord'), 'no inline _gradeAuditRecord definition')
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1)
  assert.match(body, /log\(/, 'the grade must reach the user — an unlogged grade changes nothing')
  assert.match(body, /try\s*\{/, 'grading must be wrapped: a validator that crashes Debrief is worse than none')
  assert.match(body, /catch/, 'grading must not throw')
  assert.doesNotMatch(body, /throw\s/, 'grading must never fail a run over telemetry')
})

test('a STUB or PARTIAL grade is called out by name, so the log is diagnosable', () => {
  const fn = SRC.slice(SRC.indexOf('function _gradeAuditRecord'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1)
  for (const state of ['STUB', 'PARTIAL', 'FULL']) {
    assert.ok(body.includes(state), `the grade log never mentions ${state}`)
  }
})
