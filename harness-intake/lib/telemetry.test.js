import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repoNameFromPath, buildTelemetryPath, buildAppendCmd } from './telemetry.js'

test('repoNameFromPath extracts last segment', () => {
  assert.equal(repoNameFromPath('/Users/foo/Desktop/Repos/webtarsthree'), 'webtarsthree')
  assert.equal(repoNameFromPath('/some/path/my-repo/'), 'my-repo')
  assert.equal(repoNameFromPath(''), 'unknown-repo')
  assert.equal(repoNameFromPath(null), 'unknown-repo')
})

test('buildTelemetryPath produces correct path', () => {
  const p = buildTelemetryPath({
    telemetryDir: '/Users/foo/Desktop/Repos/harness-telemetry',
    repoPath: '/Users/foo/Desktop/Repos/webtarsthree',
    skill: 'harness-intake',
    issueKey: 'TARS-1271',
    timestamp: '20260724T183042Z',
  })
  assert.equal(p, '/Users/foo/Desktop/Repos/harness-telemetry/webtarsthree-harness-intake-TARS-1271-20260724T183042Z.jsonl')
})

test('buildTelemetryPath uses no-ticket when issueKey is null', () => {
  const p = buildTelemetryPath({
    telemetryDir: '/tele',
    repoPath: '/repos/myapp',
    skill: 'harness-plan',
    issueKey: null,
    timestamp: '20260101T000000Z',
  })
  assert.ok(p.includes('myapp-harness-plan-no-ticket-'))
})

test('buildAppendCmd escapes single quotes', () => {
  const cmd = buildAppendCmd('/tele/file.jsonl', `{"a":"it's alive"}`)
  assert.ok(cmd.includes("echo '"), 'should use echo')
  assert.ok(cmd.includes(">>"), 'should append')
  assert.ok(cmd.includes("mkdir -p"), 'should ensure dir exists')
  assert.ok(!cmd.includes(`"it's alive"`), 'raw single quote should not appear unescaped')
})
