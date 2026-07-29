import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmdirSync, utimesSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initRun, finalizeRun, readRecord } from '../tools/lib/record.mjs';
import { syncRun, sweep } from '../tools/lib/telemetry.mjs';

const NOW = new Date('2026-07-24T18:30:12Z');

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'harness-tel-'));
  const remote = join(base, 'remote.git');
  mkdirSync(remote);
  execFileSync('git', ['init', '--bare', remote]);
  const telemetry = { remote, dir: join(base, 'clone') };
  const targetDir = join(base, 'target');
  mkdirSync(targetDir);
  return { base, remote, telemetry, targetDir };
}

test('syncRun pushes record + events, sets synced_at', () => {
  const { telemetry, targetDir, remote } = setup();
  const { runId, runDir } = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });
  const result = syncRun({ runDir, telemetry, now: NOW });
  assert.deepEqual(result, { synced: true });
  assert.ok(readRecord(runDir).synced_at);
  const verify = join(mkdtempSync(join(tmpdir(), 'harness-verify-')), 'v');
  execFileSync('git', ['clone', remote, verify]);
  assert.ok(existsSync(join(verify, 'log', 'myapp', `${runId}.json`)));
  const events = readFileSync(join(verify, 'log', 'myapp', `${runId}.events.jsonl`), 'utf8');
  assert.ok(events.includes('"run_start"'));
  assert.ok(events.includes('"run_end"'));
});

// record.repo was used raw as a path segment, so an owner-qualified repo
// ("Owner-x/myrepo") wrote a NESTED dir. The anomalies scan reads exactly one
// level below log/, so every such record was invisible to it even unfiltered.
// The dest path is slugified now: one flat, predictable directory level.
test('syncRun flattens an owner-qualified repo into a single slugified directory', () => {
  const { telemetry, targetDir, remote } = setup();
  const { runId, runDir } = initRun({ targetDir, repo: 'Owner-x/myrepo', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });
  assert.deepEqual(syncRun({ runDir, telemetry, now: NOW }), { synced: true });
  const verify = join(mkdtempSync(join(tmpdir(), 'harness-verify-')), 'v');
  execFileSync('git', ['clone', remote, verify]);
  assert.deepEqual(readdirSync(join(verify, 'log')), ['owner-x-myrepo']);
  assert.ok(existsSync(join(verify, 'log', 'owner-x-myrepo', `${runId}.json`)));
});

// Case variants of one repo converge. NOTE the deliberate limit: an
// owner-qualified spelling does NOT converge with its bare form —
// "JustinChan-fd/jarvis" slugifies to "justinchan-fd-jarvis", a different slug
// than "jarvis". Flattening fixes scan visibility, not repo IDENTITY; the
// owner-qualified/bare split is a separate open question (which spelling is
// canonical) and is still live in the sink.
test('syncRun converges case variants of the same repo on one directory', () => {
  const { telemetry, targetDir, remote } = setup();
  for (const spelling of ['jarvis', 'Jarvis']) {
    const { runDir } = initRun({ targetDir, repo: spelling, kind: 'intake', source: 'adhoc', now: NOW });
    finalizeRun({ runDir, status: 'succeeded', now: NOW });
    assert.deepEqual(syncRun({ runDir, telemetry, now: NOW }), { synced: true });
  }
  const verify = join(mkdtempSync(join(tmpdir(), 'harness-verify-')), 'v');
  execFileSync('git', ['clone', remote, verify]);
  assert.deepEqual(readdirSync(join(verify, 'log')), ['jarvis']);
  assert.equal(readdirSync(join(verify, 'log', 'jarvis')).filter((f) => f.endsWith('.json')).length, 2);
});

// A repo string is attacker-adjacent input reaching join(): "../.." would have
// escaped log/ entirely and written outside the sink.
test('syncRun cannot be walked out of log/ by a traversal in repo', () => {
  const { telemetry, targetDir, remote } = setup();
  const { runDir } = initRun({ targetDir, repo: '../../escape', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });
  assert.deepEqual(syncRun({ runDir, telemetry, now: NOW }), { synced: true });
  const verify = join(mkdtempSync(join(tmpdir(), 'harness-verify-')), 'v');
  execFileSync('git', ['clone', remote, verify]);
  assert.deepEqual(readdirSync(join(verify, 'log')), ['escape']);
});

test('unconfigured telemetry is a soft no-op', () => {
  const { targetDir } = setup();
  const { runDir } = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });
  assert.deepEqual(syncRun({ runDir, telemetry: null }), { synced: false, reason: 'telemetry_not_configured' });
});

test('sweep pushes unsynced finalized records and abandons stale attempted ones', () => {
  const { telemetry, targetDir } = setup();
  const old = new Date('2026-07-24T01:00:00Z');
  const doneRun = initRun({ targetDir, repo: 'myapp', kind: 'plan', source: 'adhoc', now: old });
  finalizeRun({ runDir: doneRun.runDir, status: 'failed', reason: { code: 'crash', detail: 'x' }, now: old });
  const staleRun = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'file', now: old });
  const freshRun = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: NOW });
  const { swept } = sweep({ targetDir, telemetry, now: NOW, staleMs: 6 * 3600 * 1000 });
  assert.ok(swept.includes(doneRun.runId));
  assert.ok(swept.includes(staleRun.runId));
  assert.ok(!swept.includes(freshRun.runId));
  const abandoned = readRecord(staleRun.runDir);
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(abandoned.reason.code, 'crash');
  assert.equal(readRecord(freshRun.runDir).status, 'attempted');
});

test('sweep skips a run with corrupt record.json instead of aborting', () => {
  const { telemetry, targetDir } = setup();
  const old = new Date('2026-07-24T01:00:00Z');

  // Damaged run: record.json is not valid JSON.
  const corruptRunDir = join(targetDir, '.harness', 'runs', 'corrupt-run-id');
  mkdirSync(corruptRunDir, { recursive: true });
  writeFileSync(join(corruptRunDir, 'record.json'), '{corrupt');

  // Legitimate stale run that should still be abandoned and swept.
  const staleRun = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'file', now: old });

  assert.doesNotThrow(() => {
    const { swept } = sweep({ targetDir, telemetry, now: NOW, staleMs: 6 * 3600 * 1000 });
    assert.ok(swept.includes(staleRun.runId));
    assert.ok(!swept.includes('corrupt-run-id'));
  });

  const abandoned = readRecord(staleRun.runDir);
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(abandoned.reason.code, 'crash');
});

test('syncRun is locked out by a concurrent clone lock, then succeeds once the lock clears', () => {
  const { telemetry, targetDir } = setup();
  const { runDir } = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });

  const lockPath = `${telemetry.dir}.lock`;
  mkdirSync(lockPath, { recursive: true });

  const locked = syncRun({ runDir, telemetry, now: NOW });
  assert.deepEqual(locked, { synced: false, reason: 'locked' });
  assert.equal(readRecord(runDir).synced_at, null);
  assert.ok(existsSync(lockPath), 'a failed locked attempt must not remove a lock it did not create');

  rmdirSync(lockPath);

  const result = syncRun({ runDir, telemetry, now: NOW });
  assert.deepEqual(result, { synced: true });
  assert.ok(readRecord(runDir).synced_at);
});

test('syncRun steals a stale lock (older than 5 minutes) and succeeds', () => {
  const { telemetry, targetDir } = setup();
  const { runDir } = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });

  const lockPath = `${telemetry.dir}.lock`;
  mkdirSync(lockPath, { recursive: true });
  const staleTime = new Date(NOW.getTime() - 6 * 60 * 1000);
  utimesSync(lockPath, staleTime, staleTime);

  const result = syncRun({ runDir, telemetry, now: NOW });
  assert.deepEqual(result, { synced: true });
  assert.ok(readRecord(runDir).synced_at);
});

test('syncRun commits with the configured identity, not a hardcoded one', () => {
  const { telemetry, targetDir, remote } = setup();
  const { runDir } = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });
  const result = syncRun({
    runDir, now: NOW,
    telemetry: { ...telemetry, commit_identity: { name: 'Justin Telemetry', email: 'telemetry@example.test' } },
  });
  assert.equal(result.synced, true);
  const author = execFileSync('git', ['-C', telemetry.dir, 'log', '-1', '--format=%an <%ae>'], { encoding: 'utf8' }).trim();
  assert.equal(author, 'Justin Telemetry <telemetry@example.test>');
});

test('syncRun stages only log/ (and docs/) — unrelated working-tree changes stay out', () => {
  const { telemetry, targetDir } = setup();
  const { runDir } = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });
  // Pre-clone so we can drop an unrelated uncommitted file at the root.
  execFileSync('git', ['clone', telemetry.remote, telemetry.dir]);
  writeFileSync(join(telemetry.dir, 'scratch.txt'), 'work in progress — do not commit');
  const result = syncRun({ runDir, telemetry, now: NOW });
  assert.equal(result.synced, true);
  const stat = execFileSync('git', ['-C', telemetry.dir, 'show', '--stat', '--format=', 'HEAD'], { encoding: 'utf8' });
  assert.ok(!stat.includes('scratch.txt'));
  const status = execFileSync('git', ['-C', telemetry.dir, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.ok(status.includes('scratch.txt')); // still uncommitted, untouched
});

test('syncRun runs the configured build command and commits its docs/ output alongside the record', () => {
  const { telemetry, targetDir, remote } = setup();
  // Seed the remote with a build script (as a real telemetry repo would have).
  const seed = join(mkdtempSync(join(tmpdir(), 'harness-seed-')), 's');
  execFileSync('git', ['clone', remote, seed]);
  mkdirSync(join(seed, 'dashboard'), { recursive: true });
  writeFileSync(join(seed, 'dashboard', 'build.mjs'),
    "import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';\n" +
    "mkdirSync('docs', { recursive: true });\n" +
    "writeFileSync('docs/index.html', 'runs: ' + readdirSync('log', { recursive: true }).length);\n");
  execFileSync('git', ['-C', seed, 'add', '-A']);
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'HEAD']);

  const { runDir } = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });
  const result = syncRun({
    runDir, now: NOW,
    telemetry: { ...telemetry, build: 'node dashboard/build.mjs', commit_identity: { name: 't', email: 't@t' } },
  });
  assert.equal(result.synced, true);
  assert.equal(result.build, 'ok');
  const verify = join(mkdtempSync(join(tmpdir(), 'harness-verify-')), 'v');
  execFileSync('git', ['clone', remote, verify]);
  assert.ok(readFileSync(join(verify, 'docs', 'index.html'), 'utf8').startsWith('runs: '));
});

test('a failing build command does not block the sync', () => {
  const { telemetry, targetDir } = setup();
  const { runDir } = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });
  const result = syncRun({
    runDir, now: NOW,
    telemetry: { ...telemetry, build: 'exit 1', commit_identity: { name: 't', email: 't@t' } },
  });
  assert.equal(result.synced, true);
  assert.ok(result.build.startsWith('failed'));
});

test('sweep-abandoned records carry emit_trigger sweep (the crash-backstop marker)', () => {
  const { telemetry, targetDir } = setup();
  const old = new Date('2026-07-24T01:00:00Z');
  const staleRun = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'file', now: old });
  sweep({ targetDir, telemetry, now: NOW, staleMs: 6 * 3600 * 1000 });
  const abandoned = readRecord(staleRun.runDir);
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(abandoned.emit_trigger, 'sweep');
});

test('atomicWrite lands complete content, leaves no temp file, and never tears an existing dest', async () => {
  const { atomicWrite } = await import('../tools/lib/telemetry.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'harness-atomic-'));
  const dest = join(dir, 'record.json');
  atomicWrite(dest, '{"ok":1}');
  assert.equal(readFileSync(dest, 'utf8'), '{"ok":1}');
  assert.deepEqual(readdirSync(dir), ['record.json']); // no .tmp residue

  // Failure path: make the dir unwritable — the write must throw and the
  // existing dest must remain byte-identical (no partial overwrite). Root
  // bypasses permission checks (common on CI containers), so this
  // assertion only holds under a non-root uid.
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  chmodSync(dir, 0o555);
  try {
    assert.throws(() => atomicWrite(dest, '{"torn":'));
    assert.equal(readFileSync(dest, 'utf8'), '{"ok":1}');
  } finally {
    chmodSync(dir, 0o755);
  }
});

test('syncRun cleans stale .tmp files from a prior crash and never pushes them', () => {
  const { telemetry, targetDir, remote } = setup();
  const { runId, runDir } = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });
  // Simulate a prior crash mid-write: a torn temp file already in the clone.
  const destDir = join(telemetry.dir, 'log', 'myapp');
  execFileSync('git', ['clone', remote, telemetry.dir]);
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, 'dead-run.json.tmp'), '{torn');
  assert.equal(syncRun({ runDir, telemetry, now: NOW }).synced, true);
  assert.ok(!existsSync(join(destDir, 'dead-run.json.tmp')));
  const verify = join(mkdtempSync(join(tmpdir(), 'harness-verify-')), 'v');
  execFileSync('git', ['clone', remote, verify]);
  const pushed = readdirSync(join(verify, 'log', 'myapp'));
  assert.ok(pushed.includes(`${runId}.json`));
  assert.ok(!pushed.some((f) => f.endsWith('.tmp')));
});

test('syncRun purges stale .tmp files across the whole log/ tree, not just the syncing run\'s repo dir', () => {
  // Multi-repo store: a crash stranding a .tmp in repo A's dir must not
  // survive (and get committed) when a later sync is for repo B. staging is
  // `git add -A -- log` across the whole tree, so the purge must match.
  const { telemetry, targetDir, remote } = setup();
  const { runId, runDir } = initRun({ targetDir, repo: 'repoB', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });
  execFileSync('git', ['clone', remote, telemetry.dir]);
  const otherRepoDestDir = join(telemetry.dir, 'log', 'repoA');
  mkdirSync(otherRepoDestDir, { recursive: true });
  writeFileSync(join(otherRepoDestDir, 'dead-run.json.tmp'), '{torn');
  // A stray top-level log/ temp file too, for good measure.
  writeFileSync(join(telemetry.dir, 'log', 'top-level.json.tmp'), '{torn');
  assert.equal(syncRun({ runDir, telemetry, now: NOW }).synced, true);
  const verify = join(mkdtempSync(join(tmpdir(), 'harness-verify-')), 'v');
  execFileSync('git', ['clone', remote, verify]);
  const status = execFileSync('git', ['-C', verify, 'ls-files', 'log'], { encoding: 'utf8' });
  assert.ok(!status.includes('.tmp'), `pushed tree must contain no .tmp files, got:\n${status}`);
});

// Fixture-level stamp comparison (entry-contract criterion 2): two run records
// stamped with different routing_policy values via initRun()'s u2 mechanism,
// each pushed through a REAL syncRun() into a fixture bare-git telemetry
// remote, must land as two synced records distinguishable by routing_policy.
// This is explicitly and ONLY a synthetic/fixture-level demonstration — two
// fixture records, no real intake/plan/implement dispatch and no actual
// production paired MID/HIGH driver arm is run.
test('two routing_policy arms are distinguishable end-to-end through syncRun (fixture, no real arm)', () => {
  const { telemetry, targetDir, remote } = setup();

  const control = initRun({ targetDir, repo: 'myapp', kind: 'implement', source: 'adhoc', routingPolicy: 'control', now: NOW });
  const armB = initRun({ targetDir, repo: 'myapp', kind: 'implement', source: 'adhoc', routingPolicy: 'arm-b', now: new Date(NOW.getTime() + 1000) });

  // The stamp survives finalize on each fixture record.
  assert.equal(readRecord(control.runDir).routing_policy, 'control');
  assert.equal(readRecord(armB.runDir).routing_policy, 'arm-b');

  finalizeRun({ runDir: control.runDir, status: 'succeeded', now: NOW });
  finalizeRun({ runDir: armB.runDir, status: 'succeeded', now: new Date(NOW.getTime() + 1000) });

  assert.equal(syncRun({ runDir: control.runDir, telemetry, now: NOW }).synced, true);
  assert.equal(syncRun({ runDir: armB.runDir, telemetry, now: new Date(NOW.getTime() + 2000) }).synced, true);

  // Clone the remote and read the two synced records back out of log/myapp/.
  const verify = join(mkdtempSync(join(tmpdir(), 'harness-verify-')), 'v');
  execFileSync('git', ['clone', remote, verify]);
  const syncedControl = JSON.parse(readFileSync(join(verify, 'log', 'myapp', `${control.runId}.json`), 'utf8'));
  const syncedArmB = JSON.parse(readFileSync(join(verify, 'log', 'myapp', `${armB.runId}.json`), 'utf8'));

  // The two synced arms are distinguishable purely by routing_policy.
  assert.equal(syncedControl.routing_policy, 'control');
  assert.equal(syncedArmB.routing_policy, 'arm-b');
  assert.notEqual(syncedControl.routing_policy, syncedArmB.routing_policy);
});

test('syncRun creates the telemetry clone dir when its parent does not exist yet (fresh machine)', () => {
  // Regression: the advisory lock did `mkdir('<dir>.lock')` non-recursively
  // before the parent of <dir> existed, so a first sync on a fresh machine
  // (e.g. ~/.harness/telemetry when ~/.harness/ is absent) failed ENOENT and
  // the run never synced. syncRun must ensure the parent chain exists first.
  const { remote, targetDir } = setup();
  const base = mkdtempSync(join(tmpdir(), 'harness-tel-nodir-'));
  // A telemetry dir two levels below a not-yet-created parent.
  const telemetry = { remote, dir: join(base, 'no-such-parent', 'telemetry') };
  const { runId, runDir } = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: NOW });
  finalizeRun({ runDir, status: 'succeeded', now: NOW });
  const result = syncRun({ runDir, telemetry, now: NOW });
  assert.deepEqual(result, { synced: true });
  assert.ok(readRecord(runDir).synced_at);
});
