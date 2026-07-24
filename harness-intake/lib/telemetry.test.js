import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repoNameFromPath, slugFromInput, buildTelemetryPath, buildAppendCmd, ejectTestFiles } from './telemetry.js'

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

test('buildTelemetryPath produces __ separated path in /logs/', () => {
  const p = buildTelemetryPath({
    telemetryDir: '/Users/foo/Desktop/Repos/harness-telemetry',
    repoPath: '/Users/foo/Desktop/Repos/webtarsthree',
    skill: 'harness-intake',
    issueKey: 'TARS-1271',
    timestamp: '20260724T183042Z',
  })
  assert.equal(p, '/Users/foo/Desktop/Repos/harness-telemetry/logs/webtarsthree__harness-intake__TARS-1271__20260724T183042Z.jsonl')
})

test('buildTelemetryPath filename splits cleanly on __', () => {
  const p = buildTelemetryPath({
    telemetryDir: '/tele',
    repoPath: '/repos/webtarsthree',
    skill: 'harness-plan',
    issueKey: 'TARS-1271',
    timestamp: '20260724T120000Z',
  })
  const file = p.split('/logs/')[1].replace('.jsonl', '')
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
  assert.ok(p.includes('/logs/myapp__harness-plan__add-dark-mode-to-the-dashboard__'), `path: ${p}`)
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
  assert.ok(p.includes('/logs/myapp__harness-plan__greenfield__'))
})

test('buildAppendCmd escapes single quotes and ensures dir exists', () => {
  const cmd = buildAppendCmd('/tele/logs/file.jsonl', `{"a":"it's alive"}`)
  assert.ok(cmd.includes('mkdir -p'))
  assert.ok(cmd.includes('>>'))
  assert.ok(!cmd.match(/'[^'\\]*'[^'\\]*it's/), 'raw single quote should be escaped')
})

test('ejectTestFiles removes test files from migration subtasks', () => {
  const subtasks = [
    { isMigration: true,  files: ['src/a.js', 'src/a.test.js', 'src/b.spec.ts'], estimatedFileCount: 3 },
    { isMigration: false, files: ['src/c.test.js'], estimatedFileCount: 1 },
  ]
  const injected = ejectTestFiles(subtasks, 'TARS-1271', 'src')
  assert.deepEqual(subtasks[0].files, ['src/a.js'])
  assert.equal(subtasks[0].estimatedFileCount, 1)
  // non-migration subtask untouched
  assert.deepEqual(subtasks[1].files, ['src/c.test.js'])
  assert.equal(injected.length, 1)
  assert.ok(injected[0].title.includes('TARS-1271'))
  assert.ok(injected[0].isCleanup)
  assert.equal(injected[0].isMigration, false)
  assert.ok(injected[0].files.includes('src/a.test.js'))
  assert.ok(injected[0].files.includes('src/b.spec.ts'))
})

test('ejectTestFiles deduplicates test files across subtasks', () => {
  const subtasks = [
    { isMigration: true, files: ['src/a.test.js', 'src/b.js'], estimatedFileCount: 2 },
    { isMigration: true, files: ['src/a.test.js', 'src/c.js'], estimatedFileCount: 2 },
  ]
  const injected = ejectTestFiles(subtasks, '', '')
  // a.test.js appears only once in the injected subtask
  assert.equal(injected[0].files.filter(f => f === 'src/a.test.js').length, 1)
})

test('ejectTestFiles returns empty array when no test files in migration batches', () => {
  const subtasks = [
    { isMigration: true,  files: ['src/a.js', 'src/b.jsx'], estimatedFileCount: 2 },
    { isMigration: false, files: ['src/a.test.js'],          estimatedFileCount: 1 },
  ]
  const injected = ejectTestFiles(subtasks, 'TARS-99', 'src')
  assert.equal(injected.length, 0)
  assert.deepEqual(subtasks[0].files, ['src/a.js', 'src/b.jsx'])
})

test('ejectTestFiles chunks at 8 files', () => {
  const testFiles = Array.from({ length: 10 }, (_, i) => `src/f${i}.test.js`)
  const subtasks = [{ isMigration: true, files: ['src/prod.js', ...testFiles], estimatedFileCount: 11 }]
  const injected = ejectTestFiles(subtasks, 'TARS-1', 'src')
  assert.equal(injected.length, 2)
  assert.equal(injected[0].files.length, 8)
  assert.equal(injected[1].files.length, 2)
})
