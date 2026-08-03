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

test('not configured — a remote with no dir still no-ops', () => {
  // ASYMMETRIC WITH `dir` ALONE, on purpose (A4). A `remote` with nowhere to clone it can only
  // ever sync nothing, so it stays a no-op; a `dir` with no remote is a deliberate local-only
  // sink and now works (see the git-init tests below). One of these is a typo, the other is a
  // configuration, and treating them alike is what made the local sink unreachable.
  const runDir = runDirWithRecord(record());
  assert.equal(
    syncRecord({ runDir, telemetry: { remote: 'x' }, record: record() }).synced,
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

// ---------------------------------------------------------------------------
// A4: a LOCAL sink — `dir` with no `remote`.
//
// The sink this project is actually about to write into (~/Desktop/Repos/alfred-telemetry) has
// no remote and is not going to get one today. Before this, `dir`-without-`remote` was refused
// at two layers: `loadConfig` rejected the config outright, and this module's own guard turned
// it into `telemetry_not_configured`. So the sink existed and nothing could reach it.
// ---------------------------------------------------------------------------

test('A4: a dir with no remote initializes a repo and commits — no clone, no push attempted', () => {
  const dir = join(mktemp('local'), 'sink');
  const rec = record();
  const result = syncRecord({ runDir: runDirWithRecord(rec), telemetry: { dir }, record: rec });

  assert.equal(result.synced, true, JSON.stringify(result));
  assert.ok(existsSync(join(dir, '.git')), 'no repo was initialized at the local sink');
  // THE DISTINGUISHING FIELD, not a boolean nothing reads. `{synced: true}` alone cannot tell an
  // operator that these records exist on exactly one machine.
  assert.equal(result.remote, null);
  // A local sink has no origin at all — the falsifier for "it quietly cloned from somewhere".
  assert.throws(() => git(dir, ['remote', 'get-url', 'origin']));
  // And the record is really a commit, not just a file sitting in a worktree: a `git show` of
  // HEAD is what a later reader (or a push, once a remote arrives) would actually carry.
  const committed = git(dir, ['show', `HEAD:log/webtarsthree/run-1.json`]);
  assert.deepEqual(JSON.parse(committed), rec);
  // `main`, explicitly, not whatever `init.defaultBranch` this machine has. A sink whose branch
  // name depends on who initialized it needs a merge nobody asked for the first time it is
  // shared. Asserted because otherwise `-b main` is a line no test could contradict.
  assert.equal(git(dir, ['branch', '--show-current']).trim(), 'main');
});

test('A4: no push is attempted against a remote-less sink — a failed push must not read as push_failed', () => {
  // The specific wrong outcome this guards: leaving the push loop in place would run
  // `git push -u origin HEAD` against a repo with no origin, fail 3 times, and return
  // `{synced: false, reason: 'push_failed'}` — a *successfully committed* record reported as
  // unsynced. Asserting `synced: true` above is half of it; this asserts the branch did not run,
  // by proving no upstream was ever configured on the branch.
  const dir = join(mktemp('local'), 'sink');
  const rec = record();
  const result = syncRecord({ runDir: runDirWithRecord(rec), telemetry: { dir }, record: rec });
  assert.equal(result.synced, true, JSON.stringify(result));
  // `push -u` is what sets branch.<name>.remote. Absent means it never ran.
  const branch = git(dir, ['branch', '--show-current']).trim();
  assert.throws(
    () => git(dir, ['config', '--get', `branch.${branch}.remote`]),
    'an upstream was configured, so `push -u` ran against a sink that has no remote',
  );
});

test('A4: a second run into the same local sink lands as a second commit, not an overwrite', () => {
  const dir = join(mktemp('local'), 'sink');
  const rec1 = record();
  assert.equal(syncRecord({ runDir: runDirWithRecord(rec1), telemetry: { dir }, record: rec1 }).synced, true);
  const rec2 = record({ session: { repo: 'webtarsthree', run_id: 'run-2' } });
  const second = syncRecord({ runDir: runDirWithRecord(rec2), telemetry: { dir }, record: rec2 });
  assert.equal(second.synced, true, JSON.stringify(second));

  assert.ok(existsSync(join(dir, 'log', 'webtarsthree', 'run-1.json')));
  assert.ok(existsSync(join(dir, 'log', 'webtarsthree', 'run-2.json')));
  assert.equal(git(dir, ['rev-list', '--count', 'HEAD']).trim(), '2');
});

test('A4: an EXISTING local sink dir that is not yet a repo is initialized in place, not refused', () => {
  // The real shape of the sink on this machine: the directory exists (with content), and has no
  // .git. `ensureClone`'s `git clone` into a non-empty dir fails outright, so "init when there is
  // no remote" has to work against a populated directory, not only a fresh one.
  const dir = mktemp('local-existing');
  writeFileSync(join(dir, 'README.md'), '# sink\n');
  const rec = record();
  const result = syncRecord({ runDir: runDirWithRecord(rec), telemetry: { dir }, record: rec });
  assert.equal(result.synced, true, JSON.stringify(result));
  assert.ok(existsSync(join(dir, '.git')));
  // Scoped commit, same rule as the remote case: README.md was never asked for.
  const committedFiles = git(dir, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').filter(Boolean);
  assert.deepEqual(committedFiles, ['log/webtarsthree/run-1.json']);
});

test('A4: adding a remote LATER reconciles origin and pushes — the init is not a permanent dead end', () => {
  // REPRODUCED BEFORE IT WAS FIXED. `ensureClone` clones only `if (!existsSync(dir/.git))`, so
  // after a `git init` it is a no-op forever, and nothing in this module ever ran `git remote
  // add`. Adding `remote` to config later therefore failed with `'origin' does not appear to be a
  // git repository`, 3 retries, `push_failed`, permanently. A local sink that can never become a
  // shared one is a different product than the one the config implies.
  const dir = join(mktemp('local-then-remote'), 'sink');
  const rec1 = record();
  assert.equal(syncRecord({ runDir: runDirWithRecord(rec1), telemetry: { dir }, record: rec1 }).synced, true);

  const remote = bareRemote();
  const rec2 = record({ session: { repo: 'webtarsthree', run_id: 'run-2' } });
  const result = syncRecord({ runDir: runDirWithRecord(rec2), telemetry: { remote, dir }, record: rec2 });
  assert.equal(result.synced, true, JSON.stringify(result));
  assert.equal(result.remote, remote, 'a push that really happened still reported remote: null');
  assert.equal(git(dir, ['remote', 'get-url', 'origin']).trim(), remote);

  // BOTH records reach the remote, including the one committed while the sink was local-only.
  // That is the whole value of committing rather than merely writing during the local phase.
  const readback = mktemp('readback-local-then-remote');
  git(readback, ['clone', '--quiet', remote, '.']);
  assert.ok(existsSync(join(readback, 'log', 'webtarsthree', 'run-1.json')), 'the local-era record never left the machine');
  assert.ok(existsSync(join(readback, 'log', 'webtarsthree', 'run-2.json')));
});

test('A4: a DISAGREEING origin is reported as a gap, never silently rewritten', () => {
  // A sink already pointed at remote A, config now naming remote B. Rewriting the url would push
  // this machine's records into a repo its operator did not aim at, and silence would make the
  // divergence unobservable. Neither: refuse this sync and say which two urls disagree.
  const remoteA = bareRemote();
  const remoteB = bareRemote();
  const dir = join(mktemp('origin-conflict'), 'sink');
  const rec = record();
  assert.equal(syncRecord({ runDir: runDirWithRecord(rec), telemetry: { remote: remoteA, dir }, record: rec }).synced, true);

  const rec2 = record({ session: { repo: 'webtarsthree', run_id: 'run-2' } });
  const result = syncRecord({ runDir: runDirWithRecord(rec2), telemetry: { remote: remoteB, dir }, record: rec2 });
  assert.equal(result.synced, false, JSON.stringify(result));
  assert.match(result.reason, /origin_mismatch/);
  // Both urls named, because "they disagree" is not actionable without knowing which is which.
  assert.ok(result.reason.includes(remoteA), `configured-vs-actual not named: ${result.reason}`);
  assert.ok(result.reason.includes(remoteB), `configured-vs-actual not named: ${result.reason}`);
  // And the existing origin survives — the point of refusing.
  assert.equal(git(dir, ['remote', 'get-url', 'origin']).trim(), remoteA);
});

test('A4: config DROPPING remote stops the push, even though the clone still has an origin', () => {
  // A DEFECT IN THE FIRST DRAFT OF THIS FIX, found by writing the case down rather than by
  // reasoning about it. `ensureSink` returned the repo's *existing* origin when config named no
  // remote, so a sink that had once been a clone kept pushing after its config was deliberately
  // retargeted local-only — which is precisely the retarget B5 performs on webtarsthree's config.
  // Config is the authority on where records go; the leftover git remote is not.
  const remote = bareRemote();
  const dir = mktemp('clone-then-local');
  const rec1 = record();
  assert.equal(syncRecord({ runDir: runDirWithRecord(rec1), telemetry: { remote, dir }, record: rec1 }).synced, true);

  const rec2 = record({ session: { repo: 'webtarsthree', run_id: 'run-2' } });
  const result = syncRecord({ runDir: runDirWithRecord(rec2), telemetry: { dir }, record: rec2 });
  assert.equal(result.synced, true, JSON.stringify(result));
  assert.equal(result.remote, null, 'reported a remote for a sync that config asked to keep local');

  // The load-bearing half: run-2 committed locally and did NOT reach the remote.
  const readback = mktemp('readback-clone-then-local');
  git(readback, ['clone', '--quiet', remote, '.']);
  assert.ok(existsSync(join(readback, 'log', 'webtarsthree', 'run-1.json')), 'the pre-retarget record should still be there');
  assert.ok(
    !existsSync(join(readback, 'log', 'webtarsthree', 'run-2.json')),
    'a record pushed off-machine after config asked for local-only',
  );
  // Still committed locally, so a later re-added remote carries it — not silently dropped.
  assert.ok(existsSync(join(dir, 'log', 'webtarsthree', 'run-2.json')));
  // The origin itself survives untouched; this refuses to push, it does not tear config down.
  assert.equal(git(dir, ['remote', 'get-url', 'origin']).trim(), remote);
});

test('A4: a successful remote sync reports the remote it pushed to, not null', () => {
  // The falsifier for `remote: null` above. If this field were hardcoded, an off-machine sync and
  // a local-only one would be indistinguishable in exactly the direction that matters.
  const remote = bareRemote();
  const dir = mktemp('clone-remote-field');
  const rec = record();
  const result = syncRecord({ runDir: runDirWithRecord(rec), telemetry: { remote, dir }, record: rec });
  assert.equal(result.synced, true, JSON.stringify(result));
  assert.equal(result.remote, remote);
});
