import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEQUENCE, GATED_SEQUENCE, actionForVerdict, assembleRunSummary, weightEvolutionReport, parseAgentJson } from './conductor.js'

// ---- parseAgentJson (agent() returns null on terminal API error) ----

test('parseAgentJson: null → {} (agent died; typeof null is "object", which defeats a bare ternary)', () => {
  // This is the crash: `typeof prResult === "object" ? prResult : JSON.parse(...)`
  // assigns null through, then `prParsed.prUrl` throws and the whole run dies with
  // no summary box and no state file — even though the real failure was upstream.
  assert.deepEqual(parseAgentJson(null), {})
})

test('parseAgentJson: undefined → {}', () => {
  assert.deepEqual(parseAgentJson(undefined), {})
})

test('parseAgentJson: an object passes through by identity', () => {
  const o = { prUrl: 'https://x/pull/1', testsPassed: true }
  assert.equal(parseAgentJson(o), o)
})

test('parseAgentJson: an array is not a result object → {}', () => {
  assert.deepEqual(parseAgentJson([1, 2]), {})
})

test('parseAgentJson: extracts a JSON object embedded in prose', () => {
  const got = parseAgentJson('Here you go:\n{"prUrl": "https://x/pull/2", "testsPassed": false}\nDone.')
  assert.equal(got.prUrl, 'https://x/pull/2')
  assert.equal(got.testsPassed, false)
})

test('parseAgentJson: handles a fenced code block', () => {
  const got = parseAgentJson('```json\n{"prUrl": null, "noCommits": true}\n```')
  assert.equal(got.noCommits, true)
  assert.equal(got.prUrl, null)
})

test('parseAgentJson: malformed JSON → {} rather than throwing', () => {
  assert.deepEqual(parseAgentJson('{not valid json at all'), {})
})

test('parseAgentJson: a string with no JSON at all → {}', () => {
  assert.deepEqual(parseAgentJson('Please run /login · API Error: 403 Access Denied'), {})
})

test('parseAgentJson: empty string → {}', () => {
  assert.deepEqual(parseAgentJson(''), {})
})

test('parseAgentJson: a JSON scalar is not a result object → {}', () => {
  assert.deepEqual(parseAgentJson('42'), {})
})

test('parseAgentJson: result of a died agent is safe to property-access', () => {
  // The actual invariant the PR phase needs: never throw on .prUrl
  assert.equal(parseAgentJson(null).prUrl, undefined)
  assert.equal(parseAgentJson(null).noCommits, undefined)
})

test('SEQUENCE is intake → plan → implement (no bridge — manifest-as-gospel)', () => {
  assert.deepEqual(SEQUENCE.map(s => s.skill),
    ['harness-intake', 'harness-plan', 'harness-implement'])
})
test('GATED_SEQUENCE keeps the bridge shape for the --gate path', () => {
  assert.deepEqual(GATED_SEQUENCE.map(s => s.skill),
    ['harness-intake', 'harness-bridge', 'harness-plan', 'harness-bridge', 'harness-implement'])
})
test('actionForVerdict routes PROCEED/RE_ASK/EXIT', () => {
  assert.equal(actionForVerdict('PROCEED', 0).next, 'advance')
  assert.equal(actionForVerdict('RE_ASK', 0).next, 'refine')
  assert.equal(actionForVerdict('EXIT', 1).next, 'stop')
})
test('actionForVerdict RE_ASK with retriesUsed=1 stops (not refine)', () => {
  assert.equal(actionForVerdict('RE_ASK', 1).next, 'stop')
})
test('assembleRunSummary sums cost + duration and reports final status', () => {
  const recs = [
    { skill: 'harness-intake', cost: { rateLockedUsd: 0.5 }, durationMs: 1000, outcome: 'COMPLETE' },
    { skill: 'harness-bridge', confidence: 90, durationMs: 500, outcome: 'PROCEED' },
    { skill: 'harness-implement', cost: { rateLockedUsd: 2.0 }, durationMs: 3000, outcome: 'COMPLETE' },
  ]
  const s = assembleRunSummary(recs)
  assert.equal(s.totalCostUsd, 2.5)
  assert.equal(s.totalDurationMs, 4500)
  assert.equal(s.finalStatus, 'COMPLETE')
  assert.equal(s.stages.length, 3)
})
test('assembleRunSummary finalStatus is EXIT if any bridge exited', () => {
  const recs = [{ skill: 'harness-bridge', outcome: 'EXIT', durationMs: 10 }]
  assert.equal(assembleRunSummary(recs).finalStatus, 'EXIT')
})
// ---- finalStatus case-sensitivity and vocabulary coverage ----
test('assembleRunSummary: lowercase failed → FAILED', () => {
  const recs = [{ skill: 'harness-implement', outcome: 'failed', durationMs: 0 }]
  assert.equal(assembleRunSummary(recs).finalStatus, 'FAILED')
})
test('assembleRunSummary: lowercase crashed → FAILED', () => {
  const recs = [{ skill: 'harness-implement', outcome: 'crashed', durationMs: 0 }]
  assert.equal(assembleRunSummary(recs).finalStatus, 'FAILED')
})
test('assembleRunSummary: lowercase partial → FAILED', () => {
  const recs = [{ skill: 'harness-implement', outcome: 'partial', durationMs: 0 }]
  assert.equal(assembleRunSummary(recs).finalStatus, 'FAILED')
})
test('assembleRunSummary: EXIT wins over failed', () => {
  const recs = [
    { skill: 'harness-bridge', outcome: 'EXIT', durationMs: 0 },
    { skill: 'harness-implement', outcome: 'failed', durationMs: 0 },
  ]
  assert.equal(assembleRunSummary(recs).finalStatus, 'EXIT')
})
test('assembleRunSummary: all-null outcomes → UNKNOWN', () => {
  const recs = [
    { skill: 'harness-intake', durationMs: 0 },
    { skill: 'harness-plan', durationMs: 0 },
  ]
  assert.equal(assembleRunSummary(recs).finalStatus, 'UNKNOWN')
})
test('assembleRunSummary: all success → COMPLETE', () => {
  const recs = [
    { skill: 'harness-intake', outcome: 'success', durationMs: 0 },
    { skill: 'harness-plan', outcome: 'success', durationMs: 0 },
  ]
  assert.equal(assembleRunSummary(recs).finalStatus, 'COMPLETE')
})

test('assembleRunSummary never falls back to status — a record with only status is null-outcome', () => {
  const recs = [
    { skill: 'harness-intake', status: 'COMPLETE_FRAMING_CORRECTED', durationMs: 0 },
  ]
  const s = assembleRunSummary(recs)
  assert.equal(s.stages[0].outcome, null)
  assert.equal(s.finalStatus, 'UNKNOWN')
})

test('weightEvolutionReport shows initial → final and each change', () => {
  const initial = { A: { 'files-populated': 20 }, B: { 'task-spec-completeness': 30 } }
  const changes = [{ handoff: 'A', checkId: 'files-populated', oldWeight: 20, newWeight: 30, reason: 'empty subtask files kept slipping', triggeringRunId: 'r1', ts: 't' }]
  const out = weightEvolutionReport(initial, changes)
  assert.match(out, /files-populated/)
  assert.match(out, /20 → 30/)
  assert.match(out, /empty subtask files/)
})

// ── Stage telemetry is patch-only as of 2026-07-27 (Phase 1a) ────────────────
//
// Children now write their own audit record from inside their own Debrief phase, so the
// conductor must NOT append it again — the dashboard reads `v2/*.jsonl` line by line, so a
// second append is a second run in every aggregate. What the conductor still uniquely knows
// is the measured wall-clock around the `workflow()` call and the output-token delta, so it
// keeps the patch and drops the append.
//
// This guard is a source-text check on harness-run/workflow.js, the same shape as each
// child's debrief-write.test.js. It cannot prove the agent ran; it proves the instruction
// still says patch and no longer says append.

import { readFileSync as _readFileSync } from 'node:fs'
const RUN_SRC = _readFileSync(new URL('../workflow.js', import.meta.url), 'utf8')

function finalizeBody(src) {
  const i = src.indexOf('async function finalizeStageTelemetry')
  assert.ok(i > -1, 'finalizeStageTelemetry is gone — has stage telemetry moved?')
  return src.slice(i, src.indexOf('\n}\n', i))
}

test('finalizeStageTelemetry no longer instructs an append', () => {
  const body = finalizeBody(RUN_SRC)
  assert.ok(
    !/append each record/i.test(body),
    'the conductor still tells the agent to append — the child already did, so this doubles the row'
  )
  assert.ok(!/Append, never overwrite/i.test(body), 'append instruction still present')
})

test('finalizeStageTelemetry still patches the measured fields it alone knows', () => {
  const body = finalizeBody(RUN_SRC)
  assert.match(body, /durationMs/, 'wall-clock around the workflow() call is conductor-only')
  assert.match(body, /tokens\.total\.output/, 'the budget.spent() delta is conductor-only')
  assert.match(body, /lines\[-1\]/, 'must patch the record the child just appended')
})

test('the conductor passes startTs down so a child can measure its own duration', () => {
  // Without it the child's write agent skips its duration step and the field arrives null,
  // which is then only rescued by the conductor patch — one failure away from a dash.
  const i = RUN_SRC.indexOf('const childTelemetryArgs')
  const block = RUN_SRC.slice(i, RUN_SRC.indexOf('}', i))
  assert.match(block, /startTs/, 'childTelemetryArgs must carry startTs')
})
