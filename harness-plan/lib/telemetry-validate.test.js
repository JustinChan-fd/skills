// RED-first tests for validateV2Record (Phase 1e).
//
// The point of this validator is to make "did this stage actually run?" a checkable
// assertion instead of an inference from a file's existence. Three states, not two —
// the middle one is what the earlier read of this problem missed:
//
//   FULL     every required key present and plausibly measured
//   PARTIAL  record landed, but a measured field the dashboard renders is null
//   STUB     no schemaVersion / too few keys — the fingerprint of a stage that never ran
//
// A PARTIAL record passes any "required keys present" check and still renders dashes in
// DURATION / TOKENS / ~COST. That is precisely the harness-plan TARS-1271 row: append and
// durationMs landed, the token patch did not.
//
// Fixtures here are hand-authored from harness-telemetry-schema/telemetry-v2.jsonc. They are
// deliberately NOT copied from MC-1077: that record was written after the fact because a
// human noticed the log was missing, so its measured fields are unverifiable and it cannot
// serve as ground truth for what a genuine record looks like.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateV2Record, classifyV2Record, pendingFieldsFor, REQUIRED_V2_KEYS } from './telemetry-validate.js'

/** A complete, plausible harness-intake record, built field-by-field from the schema. */
function fullRecord(over = {}) {
  return {
    schemaVersion: '2.0',
    runId: 'TARS-1271-20260727T210000Z',
    skill: 'harness-intake',
    skillsSchemaVersion: 'spec-v8',
    skillsCommit: '7c47d25',
    emitTrigger: 'workflow',
    billingMode: 'api',
    ts: '2026-07-27',
    status: 'COMPLETE',
    outcome: 'success',
    sourceIssue: 'TARS-1271',
    repo: 'webtarsthree',
    repoPath: '/Users/me/Desktop/Repos/webtarsthree',
    durationMs: 442596,
    size: 'L',
    tokens: {
      byModel: { 'claude-haiku-4-5-20251001': { output: null } },
      total: { input: 390768, output: 51828, subagentTokens: 442596, cacheRead: null, cacheCreation: null },
    },
    agentCount: {
      byModel: { 'claude-haiku-4-5-20251001': 20, 'claude-sonnet-4-6': 6 },
      byPhase: { Triage: 3, Research: 14, Debrief: 3 },
    },
    cost: { rateLockedUsd: 1.0210, priceTableVersion: '2026-07-25', nullReasons: {} },
    ...over,
  }
}

test('a hand-authored FULL record validates clean', () => {
  assert.deepEqual(validateV2Record(fullRecord()), [])
})

test('classifyV2Record calls the clean record FULL', () => {
  assert.equal(classifyV2Record(fullRecord()).state, 'FULL')
})

test('every required key is flagged by name when missing', () => {
  for (const key of REQUIRED_V2_KEYS) {
    const rec = fullRecord()
    delete rec[key]
    const problems = validateV2Record(rec)
    assert.ok(
      problems.some(p => p.includes(key)),
      `removing ${key} produced no problem naming it: ${JSON.stringify(problems)}`
    )
  }
})

test('a missing or wrong schemaVersion is a STUB, not merely a problem', () => {
  const noVersion = fullRecord()
  delete noVersion.schemaVersion
  assert.equal(classifyV2Record(noVersion).state, 'STUB')
  assert.equal(classifyV2Record(fullRecord({ schemaVersion: '1.0' })).state, 'STUB')
})

// ── PARTIAL: the state a presence check cannot see ───────────────────────────

test('a null durationMs is PARTIAL — the record is there, the dashboard shows a dash', () => {
  const c = classifyV2Record(fullRecord({ durationMs: null }))
  assert.equal(c.state, 'PARTIAL')
  assert.ok(c.dashes.includes('durationMs'), `expected durationMs in dashes: ${JSON.stringify(c.dashes)}`)
})

test('a null tokens.total.output is PARTIAL — this is the observed harness-plan row', () => {
  const rec = fullRecord()
  rec.tokens.total.output = null
  const c = classifyV2Record(rec)
  assert.equal(c.state, 'PARTIAL')
  assert.ok(c.dashes.includes('tokens.total.output'))
})

test('a null cost.rateLockedUsd is PARTIAL', () => {
  const rec = fullRecord()
  rec.cost.rateLockedUsd = null
  assert.equal(classifyV2Record(rec).state, 'PARTIAL')
})

test('PARTIAL is distinct from STUB — it has every required key', () => {
  const rec = fullRecord({ durationMs: null })
  assert.deepEqual(validateV2Record(rec).filter(p => /^missing required key/.test(p)), [])
  assert.equal(classifyV2Record(rec).state, 'PARTIAL')
})

test('nulls the schema declares permanently unavailable do NOT make a record PARTIAL', () => {
  // cacheRead/cacheCreation are not exposed by the runtime at all, and per-model output has
  // no split to report. Flagging them would make every honest record PARTIAL forever.
  const rec = fullRecord()
  rec.tokens.total.cacheRead = null
  rec.tokens.total.cacheCreation = null
  rec.tokens.byModel['claude-haiku-4-5-20251001'].output = null
  assert.equal(classifyV2Record(rec).state, 'FULL')
})

// ── outcome must not collapse into status ────────────────────────────────────

test('outcome inconsistent with status is flagged', () => {
  assert.ok(validateV2Record(fullRecord({ status: 'FAILED', outcome: 'success' })).some(p => /outcome/.test(p)))
  assert.ok(validateV2Record(fullRecord({ status: 'PARTIAL', outcome: 'success' })).some(p => /outcome/.test(p)))
})

test('each status maps to exactly one acceptable outcome', () => {
  const OK = [
    ['COMPLETE', 'success'],
    ['COMPLETE_FRAMING_CORRECTED', 'success'],
    ['COMPLETE_WITH_STUBS', 'success'],
    ['PROPOSED_WITH_GAPS', 'partial'],
    ['PARTIAL', 'partial'],
    ['FAILED', 'failed'],
    ['CRASHED', 'failed'],
  ]
  for (const [status, outcome] of OK) {
    assert.deepEqual(validateV2Record(fullRecord({ status, outcome })), [], `${status}/${outcome} should be clean`)
  }
})

test('an outcome that is a verbatim status value is flagged — the two axes must not collapse', () => {
  assert.ok(validateV2Record(fullRecord({ outcome: 'COMPLETE' })).some(p => /outcome/.test(p)))
})

// ── The two real stub records, verbatim from harness-telemetry/v2/ ────────────
//
// These are the records the conductor's agent() path improvised when it told a subagent to
// "invoke the skill" — a subagent cannot nest Workflow, so the child workflow.js never ran
// and the subagent hand-wrote a plausible-looking manifest and record. Their fingerprint:
// no schemaVersion, few keys, null tokens, and camelCase keys the real builder never emits
// (issueKey/runTs/startTs rather than sourceIssue/ts, agentCountByModel rather than
// agentCount). They are the shape the validator exists to reject.

const STUB_INTAKE = {
  runId: 'TARS-1271-20260727T194141Z', skill: 'harness-intake', runTs: '20260727T195027Z',
  startTs: 1769547027000, issueKey: 'TARS-1271', repoPath: '/Users/me/Desktop/Repos/wt-TARS-1271-20260727T194141Z',
  size: 'M', splitRequired: false, intakeManifestPath: 'docs/manifests/x__manifest.json',
  outcome: 'success', skillsCommit: '96ca774',
  tokens: { total: { input: null, output: null } }, cost: { rateLockedUsd: null },
}

const STUB_PLAN = {
  runId: 'TARS-1271-20260727T194141Z', skill: 'harness-plan', runTs: '20260727T201311Z',
  startTs: 1769548391000, sourceIssue: 'TARS-1271', repoPath: '/Users/me/Desktop/Repos/wt-TARS-1271-20260727T194141Z',
  size: 'M', status: 'COMPLETE', workType: 'migration', durationMs: 517048,
  manifestPath: 'docs/manifests/x.json', p1MdPath: 'docs/manifests/x-p1.md', p1JsonPath: 'docs/manifests/x-p1.json',
  gatedIntakeManifest: 'docs/manifests/x__manifest.json', agentCountByModel: null,
  tokens: { total: { input: null, output: null } }, cost: { rateLockedUsd: null },
  skillsCommit: '96ca774',
}

test('the real 13-key intake stub classifies as STUB', () => {
  const c = classifyV2Record(STUB_INTAKE)
  assert.equal(c.state, 'STUB')
  assert.ok(c.reasons.some(r => /schemaVersion/.test(r)), `expected a schemaVersion reason: ${JSON.stringify(c.reasons)}`)
})

test('the real 18-key plan stub classifies as STUB despite a populated durationMs', () => {
  // It carries a real-looking durationMs and status, so a "has the fields I render" check
  // would pass it. Only the schemaVersion/key-count fingerprint catches it.
  const c = classifyV2Record(STUB_PLAN)
  assert.equal(c.state, 'STUB')
})

test('a stub is reported with its missing required keys, so the diagnosis is actionable', () => {
  const problems = validateV2Record(STUB_INTAKE)
  for (const key of ['schemaVersion', 'emitTrigger', 'billingMode', 'agentCount', 'ts', 'status']) {
    assert.ok(problems.some(p => p.includes(key)), `no problem naming ${key}`)
  }
})

test('key count alone flags a record that somehow carries schemaVersion but little else', () => {
  const c = classifyV2Record({ schemaVersion: '2.0', skill: 'harness-plan', runId: 'x', status: 'COMPLETE' })
  assert.equal(c.state, 'STUB')
  assert.ok(c.reasons.some(r => /key/.test(r)))
})

// ── The validator must not reject what the fixed writer produces ─────────────

test('validateV2Record never fails a record on a field the schema permits to be null', () => {
  // worktree/branch are null on a direct invocation and populated only under the conductor;
  // size is null for skills that do not size. None of these is a defect.
  const rec = fullRecord({ size: null, worktree: null, branch: null })
  assert.deepEqual(validateV2Record(rec).filter(p => /worktree|branch|size/.test(p)), [])
})

test('validateV2Record returns strings, always, so callers can log() them directly', () => {
  for (const problems of [validateV2Record(fullRecord()), validateV2Record(STUB_INTAKE), validateV2Record({})]) {
    assert.ok(Array.isArray(problems))
    for (const p of problems) assert.equal(typeof p, 'string')
  }
})

test('validateV2Record survives garbage input without throwing', () => {
  for (const junk of [null, undefined, 'a string', 42, [], { tokens: 'not an object' }]) {
    assert.ok(Array.isArray(validateV2Record(junk)), `threw or returned non-array for ${JSON.stringify(junk)}`)
  }
})

test('classifyV2Record survives garbage input without throwing', () => {
  for (const junk of [null, undefined, 'a string', 42, []]) {
    assert.equal(classifyV2Record(junk).state, 'STUB')
  }
})

// ── The stub floor is a boundary, so pin it ──────────────────────────────────
//
// The first version of the validator hardcoded the floor at 20 because genuine records
// observed on disk run 28-37 keys. That rejected the minimum legal record: a record carrying
// exactly REQUIRED_V2_KEYS is complete by definition. These two tests exist so the floor can
// never drift back above the contract.

test('a record of exactly the required keys and nothing else is not a STUB', () => {
  const minimal = {}
  for (const key of REQUIRED_V2_KEYS) minimal[key] = 'x'
  minimal.schemaVersion = '2.0'
  minimal.status = 'COMPLETE'
  minimal.outcome = 'success'
  minimal.durationMs = 1000
  minimal.tokens = { total: { output: 10 } }
  minimal.cost = { rateLockedUsd: 0.5 }
  const c = classifyV2Record(minimal)
  assert.equal(c.state, 'FULL', `minimal legal record misclassified: ${JSON.stringify(c.reasons)}`)
})

test('one key below the required count is a STUB, and says so by count', () => {
  const minimal = {}
  for (const key of REQUIRED_V2_KEYS) minimal[key] = 'x'
  minimal.schemaVersion = '2.0'
  delete minimal.repo
  const c = classifyV2Record(minimal)
  assert.equal(c.state, 'STUB')
  assert.ok(c.reasons.some(r => /keys/.test(r)), `expected a key-count reason: ${JSON.stringify(c.reasons)}`)
})

// ── Fields a later stage is contracted to supply are pending, not dashes ──────
//
// The grader runs INSIDE the workflow, before the write agent's STEP 2 stamps durationMs
// onto the file. So the in-memory record it sees always has durationMs === null, and a naive
// classify calls every healthy run PARTIAL while the file on disk is FULL. The log and
// audit-telemetry.mjs then disagree on every single run.
//
// A grader that cries PARTIAL unconditionally teaches you to ignore it — the same failure as
// a green test asserting the wrong thing. So a caller that KNOWS a field is still coming can
// declare it pending. Nothing is suppressed: pending fields are reported separately, and a
// field is only pending if something is actually going to supply it.

test('a field declared pending does not make the record PARTIAL', () => {
  const c = classifyV2Record(fullRecord({ durationMs: null }), { pending: ['durationMs'] })
  assert.equal(c.state, 'FULL')
  assert.deepEqual(c.dashes, [])
})

test('a pending field is still reported, so it is never silently dropped', () => {
  const c = classifyV2Record(fullRecord({ durationMs: null }), { pending: ['durationMs'] })
  assert.deepEqual(c.pending, ['durationMs'])
})

test('a pending field that is already populated is not reported as pending', () => {
  const c = classifyV2Record(fullRecord({ durationMs: 1234 }), { pending: ['durationMs'] })
  assert.equal(c.state, 'FULL')
  assert.deepEqual(c.pending, [])
})

test('declaring one field pending does not excuse the others', () => {
  const rec = fullRecord({ durationMs: null })
  rec.cost.rateLockedUsd = null
  const c = classifyV2Record(rec, { pending: ['durationMs'] })
  assert.equal(c.state, 'PARTIAL')
  assert.deepEqual(c.dashes, ['cost.rateLockedUsd'])
  assert.deepEqual(c.pending, ['durationMs'])
})

test('with no options, every dash field still counts — the audit script must see the truth', () => {
  // audit-telemetry.mjs reads records off disk, where nothing further is coming. It passes no
  // options, so a null durationMs there is a real dash and must stay one.
  const c = classifyV2Record(fullRecord({ durationMs: null }))
  assert.equal(c.state, 'PARTIAL')
  assert.deepEqual(c.dashes, ['durationMs'])
  assert.deepEqual(c.pending, [])
})

test('an unrecognized pending field name is ignored rather than trusted', () => {
  // Guards a typo in the caller: 'duration' must not silently excuse 'durationMs'.
  const c = classifyV2Record(fullRecord({ durationMs: null }), { pending: ['duration'] })
  assert.equal(c.state, 'PARTIAL')
  assert.deepEqual(c.dashes, ['durationMs'])
})

test('pending survives garbage options without throwing', () => {
  for (const opts of [null, undefined, {}, { pending: null }, { pending: 'durationMs' }, { pending: [null, 42] }, 'nope']) {
    const c = classifyV2Record(fullRecord({ durationMs: null }), opts)
    assert.equal(c.state, 'PARTIAL', `options ${JSON.stringify(opts)} should not excuse anything`)
    assert.ok(Array.isArray(c.pending))
  }
})

test('a STUB reports pending as an empty array, not undefined', () => {
  const c = classifyV2Record(STUB_INTAKE, { pending: ['durationMs'] })
  assert.equal(c.state, 'STUB')
  assert.deepEqual(c.pending, [])
})

// ── The pending DECISION must be testable, not just present in the text ───────
//
// An earlier version of this fix left the startTs condition inline in _gradeAuditRecord, where
// the only possible assertion was "the source text mentions startTs". Mutating the condition
// away (`startTs ? [...] : []` → `[...]`) then failed nothing: the word was still in the
// signature. Extracting the decision is what makes it assertable — otherwise "pending" could
// quietly become an unconditional excuse, which is worse than the false PARTIAL it replaced.

test('durationMs is pending only when a startTs exists to measure it from', () => {
  assert.deepEqual(pendingFieldsFor({ startTs: '1769500000000' }), ['durationMs'])
  assert.deepEqual(pendingFieldsFor({ startTs: 1769500000000 }), ['durationMs'])
})

test('with no startTs nothing is pending — the dash is real and must be reported', () => {
  // Without startTs the write agent has nothing to subtract, so durationMs will never be
  // stamped. Calling it "pending" there would hide a permanent gap behind a temporary word.
  for (const startTs of [null, undefined, '', 0]) {
    assert.deepEqual(pendingFieldsFor({ startTs }), [], `startTs ${JSON.stringify(startTs)} should not defer anything`)
  }
})

test('pendingFieldsFor survives garbage without throwing', () => {
  for (const arg of [null, undefined, {}, 'nope', 42]) {
    assert.ok(Array.isArray(pendingFieldsFor(arg)), `non-array for ${JSON.stringify(arg)}`)
  }
})

test('every name pendingFieldsFor can return is a real dash field', () => {
  // A name outside DASH_FIELDS would be silently ignored by classifyV2Record, so this catches
  // the two drifting apart rather than waiting for a run to under-report.
  const c = classifyV2Record(fullRecord({ durationMs: null }), { pending: pendingFieldsFor({ startTs: '1' }) })
  assert.deepEqual(c.pending, ['durationMs'])
  assert.deepEqual(c.dashes, [])
})
