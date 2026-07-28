// The bridge has THREE axes, and its telemetry record collapsed all three into two fields.
//
// verdict  — the gate's decision: PROCEED / RE_ASK / EXIT. Bridge-specific.
// status   — the lifecycle value: did this skill run to completion? Shared vocabulary.
// outcome  — the dashboard's three-way roll-up: success / partial / failed.
//
// workflow.js wrote `status: verdict === 'PROCEED' ? 'COMPLETE' : verdict` and
// `outcome: verdict`. Both are on disk right now in harness-telemetry/v2/:
//
//   status 'RE_ASK'   outcome 'RE_ASK'    ← a verdict in the lifecycle field
//   status 'COMPLETE' outcome 'PROCEED'   ← a verdict in the roll-up field
//   status 'COMPLETE' outcome 'EXIT'      ← ditto, and EXIT is not a failure of the bridge
//
// The consequences are distinct, which is why this is one bug and not a style nit:
//
// 1. `outcome: 'PROCEED'` is not one of the three values the dashboard's RESULT column and
//    assembleRunSummary read, so those rows render as neither success nor failure.
// 2. `status: 'RE_ASK'` says the bridge did not complete. It did — it ran fine and decided to
//    ask again. A gate that returns a negative verdict has still succeeded at being a gate.
//    Conflating them means "the stage crashed" and "the stage said no" are indistinguishable,
//    which is exactly the ambiguity the v2 schema exists to remove.
// 3. The verdict itself was already stored separately as `verdict`, so nothing was gained by
//    overwriting the other two — the information was duplicated into fields that then lied.
//
// The bridge is parked, not deleted (its checks-*.js are untouched on disk, awaiting a --gate
// flag). Its records are still in v2/ and still read by the dashboard, and whoever un-parks it
// should not have to rediscover this. So it is fixed and tested now.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { verdictFor } from './verdict.js'
import { statusForVerdict, outcomeForVerdict, KNOWN_VERDICTS } from './verdict-axes.js'

const SRC = readFileSync(new URL('../workflow.js', import.meta.url), 'utf8')

const VERDICTS = ['PROCEED', 'RE_ASK', 'EXIT']

test('verdictFor still returns only the three known verdicts', () => {
  // Anchors everything below: if a fourth verdict appears, the maps must be revisited rather
  // than silently falling through to a default.
  const seen = new Set()
  for (const score of [0, 50, 69, 70, 90, 100]) for (const retries of [0, 1, 2]) {
    seen.add(verdictFor(score, retries).verdict)
  }
  for (const v of seen) assert.ok(VERDICTS.includes(v), `unknown verdict ${v} — update the axis maps`)
})

test('every verdict maps to a lifecycle status that means "the gate ran"', () => {
  // A gate that says no has still completed. Only a crash is a non-completion.
  for (const v of VERDICTS) {
    assert.equal(statusForVerdict(v), 'COMPLETE', `${v} → status "${statusForVerdict(v)}"; the bridge completed regardless of its verdict`)
  }
})

test('no verdict value ever appears as a status', () => {
  for (const v of VERDICTS) {
    assert.ok(!VERDICTS.includes(statusForVerdict(v)), `status "${statusForVerdict(v)}" is a verdict value — the axes have collapsed`)
  }
})

test('every verdict maps to one of the three dashboard outcomes', () => {
  const OK = ['success', 'partial', 'failed']
  for (const v of VERDICTS) {
    assert.ok(OK.includes(outcomeForVerdict(v)), `${v} → outcome "${outcomeForVerdict(v)}" is not one of ${OK.join('/')}`)
  }
})

test('the outcome distinguishes advancing from being held back', () => {
  // PROCEED is an unqualified success. RE_ASK and EXIT are not bridge failures — the gate
  // worked — but the run did not advance, so the honest roll-up is partial, not success and not
  // failed. Collapsing all three to success is what made the RESULT column meaningless.
  assert.equal(outcomeForVerdict('PROCEED'), 'success')
  assert.equal(outcomeForVerdict('RE_ASK'), 'partial')
  assert.equal(outcomeForVerdict('EXIT'), 'partial')
})

test('an unrecognized verdict fails closed on both axes', () => {
  for (const bogus of ['NOPE', '', null, undefined, 42]) {
    assert.equal(statusForVerdict(bogus), 'FAILED', `statusForVerdict(${JSON.stringify(bogus)}) does not fail closed`)
    assert.equal(outcomeForVerdict(bogus), 'failed', `outcomeForVerdict(${JSON.stringify(bogus)}) does not fail closed`)
  }
})

test('the record no longer assigns a verdict to status or outcome', () => {
  // The exact expression that shipped, asserted against directly so a revert is caught rather
  // than merely made unlikely.
  assert.ok(
    !/status:\s*verdict\s*===/.test(SRC),
    'workflow.js still derives status from a verdict comparison'
  )
  assert.ok(!/\boutcome:\s*verdict\b/.test(SRC), 'workflow.js still assigns outcome: verdict')
  assert.match(SRC, /status:\s*_statusForVerdict\(/, 'the record does not use the status map')
  assert.match(SRC, /outcome:\s*_outcomeForVerdict\(/, 'the record does not use the outcome map')
})

test('the verdict is still recorded on its own axis', () => {
  // The fix must not lose the decision — it was the one thing the old record got right.
  assert.match(SRC, /^\s*verdict,?\s*$|verdict:\s*verdict/m, 'the record no longer carries the verdict itself')
})

// ── The inline mirror ─────────────────────────────────────────────────────────
//
// harness-bridge has no inline-mirror.test.js of its own (the other four skills do), so this
// mirror would otherwise be the only unguarded one in the tree — and it is a mirror of the
// function that decides what two telemetry fields say. Checked here rather than left for a
// future inline-mirror.test.js that may never be written.

test('the inline _statusForVerdict and _outcomeForVerdict match their lib originals', () => {
  const decls = ['_KNOWN_VERDICTS', '_statusForVerdict', '_outcomeForVerdict'].map(name => {
    const m = SRC.match(new RegExp(`(?:function|const) ${name}\\b[\\s\\S]*?\\n(?=\\n|// --)`))
    assert.ok(m, `workflow.js has no inline ${name} — the mirror is missing, not merely drifted`)
    return m[0]
  })
  const fns = new Function(`${decls.join('\n')}\nreturn { _statusForVerdict, _outcomeForVerdict }`)()
  for (const v of [...VERDICTS, 'NOPE', '', null, undefined, 42]) {
    assert.equal(fns._statusForVerdict(v), statusForVerdict(v), `status mirror drift for ${JSON.stringify(v)}`)
    assert.equal(fns._outcomeForVerdict(v), outcomeForVerdict(v), `outcome mirror drift for ${JSON.stringify(v)}`)
  }
})

test('the inline verdict list matches lib KNOWN_VERDICTS', () => {
  // The list is what makes a negative verdict COMPLETE rather than FAILED. A mirror missing an
  // entry would report the bridge as crashed on exactly the runs it gated.
  const m = SRC.match(/const _KNOWN_VERDICTS = (\[[^\]]*\])/)
  assert.ok(m, 'no inline _KNOWN_VERDICTS')
  assert.deepEqual(new Function(`return ${m[1]}`)(), KNOWN_VERDICTS)
})
