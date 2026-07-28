import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repoNameFromPath, slugFromInput, buildTelemetryPath, buildAppendCmd, recordExtras } from './telemetry.js'

test('repoNameFromPath extracts last segment', () => {
  assert.equal(repoNameFromPath('/Users/foo/Desktop/Repos/webtarsthree'), 'webtarsthree')
  assert.equal(repoNameFromPath('/some/path/my-repo/'), 'my-repo')
  assert.equal(repoNameFromPath(''), 'unknown-repo')
  assert.equal(repoNameFromPath(null), 'unknown-repo')
})

test('slugFromInput converts first line to kebab slug', () => {
  assert.equal(slugFromInput('Add payment gateway support'), 'add-payment-gateway-support')
  assert.equal(slugFromInput('  Migrate auth layer! (critical)\nmore text'), 'migrate-auth-layer-critical')
  assert.equal(slugFromInput(''), 'greenfield')
  assert.equal(slugFromInput(null), 'greenfield')
  assert.equal(slugFromInput('   \n  \n'), 'greenfield')
})

test('slugFromInput truncates to 40 chars', () => {
  const long = 'this is a very long first line that exceeds the forty character limit easily'
  const slug = slugFromInput(long)
  assert.ok(slug.length <= 40, `slug too long: ${slug.length}`)
  assert.ok(!slug.endsWith('-'), 'should not end with hyphen')
})

// The dashboard reads ONLY {telemetryDir}/v2/. `logs/` does not exist on disk — this
// assertion was green for the whole bridge era while encoding a path nothing writes to,
// because buildTelemetryPath was dead code (buildAppendCmd was never called from any
// workflow.js). Keep the directory name literal here; a computed one hides the drift.
test('buildTelemetryPath produces __ separated path in /v2/', () => {
  const p = buildTelemetryPath({
    telemetryDir: '/Users/foo/Desktop/Repos/harness-telemetry',
    repoPath: '/Users/foo/Desktop/Repos/webtarsthree',
    skill: 'harness-intake',
    issueKey: 'TARS-1271',
    timestamp: '20260724T183042Z',
  })
  assert.equal(p, '/Users/foo/Desktop/Repos/harness-telemetry/v2/webtarsthree__harness-intake__TARS-1271__20260724T183042Z.jsonl')
})

test('buildTelemetryPath never emits the legacy logs/ directory', () => {
  const p = buildTelemetryPath({
    telemetryDir: '/tele', repoPath: '/repos/webtarsthree', skill: 'harness-intake',
    issueKey: 'TARS-1', timestamp: '20260101T000000Z',
  })
  assert.ok(!p.includes('/logs/'), `still writing to the legacy dir: ${p}`)
})

test('buildTelemetryPath filename splits cleanly on __', () => {
  const p = buildTelemetryPath({
    telemetryDir: '/tele',
    repoPath: '/repos/webtarsthree',
    skill: 'harness-plan',
    issueKey: 'TARS-1271',
    timestamp: '20260724T120000Z',
  })
  const file = p.split('/v2/')[1].replace('.jsonl', '')
  const parts = file.split('__')
  assert.equal(parts.length, 4)
  assert.equal(parts[0], 'webtarsthree')
  assert.equal(parts[1], 'harness-plan')
  assert.equal(parts[2], 'TARS-1271')
  assert.equal(parts[3], '20260724T120000Z')
})

test('buildTelemetryPath falls back to slugFromInput when no issueKey', () => {
  const p = buildTelemetryPath({
    telemetryDir: '/tele',
    repoPath: '/repos/myapp',
    skill: 'harness-plan',
    issueKey: null,
    rawText: 'Add dark mode to the dashboard',
    timestamp: '20260101T000000Z',
  })
  assert.ok(p.includes('/v2/myapp__harness-plan__add-dark-mode-to-the-dashboard__'), `path: ${p}`)
})

test('buildTelemetryPath uses greenfield when both issueKey and rawText are empty', () => {
  const p = buildTelemetryPath({
    telemetryDir: '/tele',
    repoPath: '/repos/myapp',
    skill: 'harness-plan',
    issueKey: null,
    rawText: null,
    timestamp: '20260101T000000Z',
  })
  assert.ok(p.includes('/v2/myapp__harness-plan__greenfield__'))
})

test('buildAppendCmd escapes single quotes and ensures dir exists', () => {
  const cmd = buildAppendCmd('/tele/v2/file.jsonl', `{"a":"it's alive"}`)
  assert.ok(cmd.includes('mkdir -p'))
  assert.ok(cmd.includes('>>'))
  assert.ok(!cmd.match(/'[^'\\]*'[^'\\]*it's/), 'raw single quote should be escaped')
})

test('recordExtras defaults retries=0 and errorLog=[]', () => {
  assert.deepEqual(recordExtras(), { retries: 0, errorLog: [] })
})

test('recordExtras passes through provided values', () => {
  assert.deepEqual(recordExtras({ retries: 2, errorLog: [{ phase: 'x', message: 'y', ts: 't' }] }),
    { retries: 2, errorLog: [{ phase: 'x', message: 'y', ts: 't' }] })
})
