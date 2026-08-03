// lib/telemetry.mjs's `syncRecord` — pushes record.json to a git-cloned sink.
//
// A FRESH implementation, not `harness-core`'s `syncRun` under test — see telemetry.mjs's
// header for why. These fixtures never touch the real `~/.harness/telemetry` sink: the bare
// remote and the working clone are both temp dirs, torn down in `after()`, same discipline as
// run.test.mjs's `temps` array and report.test.mjs's documented reason for never reusing the
// real sink in a test (its `git add -A -- log` once swept unrelated staged changes into a
// telemetry commit).

import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syncRecord } from '../lib/telemetry.mjs';

const temps = [];
const mktemp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), `alfred-telemetry-${prefix}-`));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

// A bare repo stands in for the real GitHub remote — `git clone`/`push` both work against it
// with no network, and it is the thing a fresh clone can be read back from to prove the push
// landed.
function bareRemote() {
  const dir = mktemp('remote');
  git(dir, ['init', '--quiet', '--bare', '-b', 'main']);
  return dir;
}

function record(overrides = {}) {
  return {
    session: { repo: 'webtarsthree', run_id: 'run-1', ...overrides.session },
    cost: { total_usd: 1.23 },
    ...overrides,
  };
}

function runDirWithRecord(rec) {
  const dir = mktemp('rundir');
  writeFileSync(join(dir, 'record.json'), JSON.stringify(rec));
  return dir;
}

test('not configured — telemetry null no-ops rather than requiring a call-site guard', () => {
  const runDir = runDirWithRecord(record());
  const result = syncRecord({ runDir, telemetry: null, record: record() });
  assert.deepEqual(result, { synced: false, reason: 'telemetry_not_configured' });
});

test('not configured — remote or dir alone still no-ops', () => {
  const runDir = runDirWithRecord(record());
  assert.equal(
    syncRecord({ runDir, telemetry: { remote: 'x' }, record: record() }).synced,
    false,
  );
  assert.equal(
    syncRecord({ runDir, telemetry: { dir: 'x' }, record: record() }).synced,
    false,
  );
});

test('a record missing session identity is refused, not silently synced under an empty path', () => {
  const remote = bareRemote();
  const dir = mktemp('clone');
  const runDir = runDirWithRecord({ cost: {} });
  const result = syncRecord({ runDir, telemetry: { remote, dir }, record: { cost: {} } });
  assert.deepEqual(result, { synced: false, reason: 'record_missing_session_identity' });
});

test('first sync clones, pushes, and the file is readable back from a fresh clone of the remote', () => {
  const remote = bareRemote();
  const dir = mktemp('clone');
  const rec = record();
  const runDir = runDirWithRecord(rec);

  const result = syncRecord({ runDir, telemetry: { remote, dir }, record: rec });
  assert.equal(result.synced, true, JSON.stringify(result));
  assert.ok(existsSync(result.path));

  const readback = mktemp('readback');
  git(readback, ['clone', '--quiet', remote, '.']);
  const pushed = JSON.parse(readFileSync(join(readback, 'log', 'webtarsthree', 'run-1.json'), 'utf8'));
  assert.deepEqual(pushed, rec);
});

test('a second sync from the same run does not fail — the idempotent path', () => {
  const remote = bareRemote();
  const dir = mktemp('clone');
  const rec = record();
  const runDir = runDirWithRecord(rec);

  const first = syncRecord({ runDir, telemetry: { remote, dir }, record: rec });
  assert.equal(first.synced, true);
  const second = syncRecord({ runDir, telemetry: { remote, dir }, record: rec });
  assert.equal(second.synced, true, JSON.stringify(second));
});

test('a different run_id in the same repo lands as a second file, not an overwrite', () => {
  const remote = bareRemote();
  const dir = mktemp('clone');

  const rec1 = record();
  syncRecord({ runDir: runDirWithRecord(rec1), telemetry: { remote, dir }, record: rec1 });

  const rec2 = record({ session: { repo: 'webtarsthree', run_id: 'run-2' } });
  const result2 = syncRecord({ runDir: runDirWithRecord(rec2), telemetry: { remote, dir }, record: rec2 });
  assert.equal(result2.synced, true);

  const readback = mktemp('readback2');
  git(readback, ['clone', '--quiet', remote, '.']);
  assert.ok(existsSync(join(readback, 'log', 'webtarsthree', 'run-1.json')));
  assert.ok(existsSync(join(readback, 'log', 'webtarsthree', 'run-2.json')));
});

test('the repo name is slugified in the destination path', () => {
  const remote = bareRemote();
  const dir = mktemp('clone');
  const rec = record({ session: { repo: 'Acme/Web Tars Three!', run_id: 'run-1' } });
  const result = syncRecord({ runDir: runDirWithRecord(rec), telemetry: { remote, dir }, record: rec });
  assert.equal(result.synced, true);
  assert.match(result.path, /log[\\/]acme-web-tars-three[\\/]run-1\.json$/);
});

test('commit identity fallback — an unconfigured clone still commits via the harness@local fallback', () => {
  const remote = bareRemote();
  const dir = mktemp('clone');
  const rec = record();
  // No `commit_identity` in telemetry, and the fallback is only reachable when the clone has
  // no identity of its own — which this machine's real ~/.gitconfig would otherwise supply.
  // Isolate git from that global/system config for this call so the fallback path is actually
  // exercised, matching the state a freshly-provisioned CI box would have.
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  let result;
  try {
    result = syncRecord({ runDir: runDirWithRecord(rec), telemetry: { remote, dir }, record: rec });
  } finally {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = prevSystem;
  }
  assert.equal(result.synced, true, JSON.stringify(result));
  const authorLine = git(dir, ['log', '-1', '--format=%an <%ae>']).trim();
  assert.equal(authorLine, 'harness <harness@local>');
});

test('commit identity honors an explicit telemetry.commit_identity over the fallback', () => {
  const remote = bareRemote();
  const dir = mktemp('clone');
  const rec = record();
  const result = syncRecord({
    runDir: runDirWithRecord(rec),
    telemetry: { remote, dir, commit_identity: { name: 'Alfred Bot', email: 'alfred@example.invalid' } },
    record: rec,
  });
  assert.equal(result.synced, true, JSON.stringify(result));
  const authorLine = git(dir, ['log', '-1', '--format=%an <%ae>']).trim();
  assert.equal(authorLine, 'Alfred Bot <alfred@example.invalid>');
});

test('REGRESSION: git add -A -- log never stages a file placed outside log/ in the working clone', () => {
  // The measured incident this guards, carried forward from report.test.mjs's header: a wider
  // `add -A` once swept unrelated staged changes into a telemetry commit. Here: the clone
  // doubles as a working repo with an unrelated staged file sitting outside log/ before the
  // sync runs, and it must still be staged-but-uncommitted afterward, not swept into this commit.
  const remote = bareRemote();
  const dir = mktemp('clone');
  git(dir, ['clone', '--quiet', remote, dir]);
  writeFileSync(join(dir, 'unrelated.txt'), 'not telemetry');
  git(dir, ['add', 'unrelated.txt']);

  const rec = record();
  const result = syncRecord({ runDir: runDirWithRecord(rec), telemetry: { remote, dir }, record: rec });
  assert.equal(result.synced, true, JSON.stringify(result));

  const committedFiles = git(dir, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').filter(Boolean);
  assert.ok(!committedFiles.includes('unrelated.txt'), `unrelated.txt leaked into the commit: ${committedFiles}`);
  // Still staged, untouched by the sync — proving the file survived rather than having been
  // silently dropped some other way.
  const status = git(dir, ['status', '--porcelain']);
  assert.match(status, /^A\s+unrelated\.txt$/m);
});

test('sync_error is returned, not thrown, when the remote is unreachable', () => {
  const dir = mktemp('clone');
  const rec = record();
  const result = syncRecord({
    runDir: runDirWithRecord(rec),
    telemetry: { remote: join(mktemp('nonexistent'), 'does-not-exist'), dir },
    record: rec,
  });
  assert.equal(result.synced, false);
  assert.match(result.reason, /sync_error/);
});

test('a stale lock is reclaimed rather than blocking forever', () => {
  const remote = bareRemote();
  const dir = mktemp('clone');
  mkdirSync(`${dir}.lock`);
  const rec = record();
  const result = syncRecord({
    runDir: runDirWithRecord(rec),
    telemetry: { remote, dir },
    record: rec,
    now: new Date(Date.now() + 10 * 60 * 1000),
  });
  assert.equal(result.synced, true, JSON.stringify(result));
});

test('a fresh (non-stale) lock refuses the sync rather than racing the other holder', () => {
  const remote = bareRemote();
  const dir = mktemp('clone');
  mkdirSync(`${dir}.lock`);
  const rec = record();
  const result = syncRecord({ runDir: runDirWithRecord(rec), telemetry: { remote, dir }, record: rec });
  assert.deepEqual(result, { synced: false, reason: 'locked' });
});
