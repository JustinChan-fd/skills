import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repoNameFromPath, slugFromInput, buildTelemetryPath, buildAppendCmd } from './telemetry.js'

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

test('buildTelemetryPath produces correct path with Jira key', () => {
  const p = buildTelemetryPath({
    telemetryDir: '/Users/foo/Desktop/Repos/harness-telemetry',
    repoPath: '/Users/foo/Desktop/Repos/webtarsthree',
    skill: 'harness-intake',
    issueKey: 'TARS-1271',
    timestamp: '20260724T183042Z',
  })
  assert.equal(p, '/Users/foo/Desktop/Repos/harness-telemetry/webtarsthree-harness-intake-TARS-1271-20260724T183042Z.jsonl')
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
  assert.ok(p.includes('myapp-harness-plan-add-dark-mode-to-the-dashboard-'), `path: ${p}`)
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
  assert.ok(p.includes('myapp-harness-plan-greenfield-'))
})

test('buildAppendCmd escapes single quotes', () => {
  const cmd = buildAppendCmd('/tele/file.jsonl', `{"a":"it's alive"}`)
  assert.ok(cmd.includes("echo '"), 'should use echo')
  assert.ok(cmd.includes(">>"), 'should append')
  assert.ok(cmd.includes("mkdir -p"), 'should ensure dir exists')
  assert.ok(!cmd.includes(`"it's alive"`), 'raw single quote should not appear unescaped')
})
