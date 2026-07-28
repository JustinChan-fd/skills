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
