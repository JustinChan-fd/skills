// lib/run.mjs — the eight steps of PLAN.md §2.1, wired. Spawns, waits, observes, gates.
//
// THIS IS THE THIN VERSION ON PURPOSE. The standing call for slices C and D was to write the
// minimum that can run end to end and let real failures name the guards worth having, rather
// than building the fully-guarded version against imagined ones. So `pollWorker`'s stall
// inference, the gh shim, and the symlinked project dir are NOT ported from eval/run-armc.mjs.
// What IS ported is every gap that module found by actually launching something, because those
// were measured rather than anticipated:
//
//   - stdio to a FILE, not a pipe. A child emitting past the 64KB pipe buffer with nothing
//     draining it never exits, and `--output-format json` is far past that.
//   - a launch failure is not a completed run. `spawn` reports ENOENT asynchronously, so
//     `child.pid` is undefined and a naive wait reads a worker that never started as one that
//     finished having delivered nothing.
//   - a wall cap that fires from OUTSIDE the child. A worker that hangs is otherwise unbounded.
//     SIGTERM rather than SIGKILL, so the transcript the run is priced from gets flushed.
//
// THE SEAT ENV IS THE ONE GUARD THAT WAS NOT DEFERRABLE, and it is measured, not theorised.
// `~/.zshrc:42-44` exports the three `ANTHROPIC_DEFAULT_*` seats and there is no `.zshenv`,
// `.zprofile`, or `.zlogin` — so `env -i zsh -l -c 'env'` shows ZERO of them. A tool-spawned
// shell inherits no seats at all. Worse in the other direction: a long-lived process holds
// whatever env it started with, and last session's held `ANTHROPIC_DEFAULT_SONNET_MODEL=
// anthropic.claude-sonnet-4-6` with no OPUS var at all. Either way an inherited seat is
// untestable and silently wrong, so the child env is SET from lib/models.mjs SEATS.
//
// What that env does and does not control, stated exactly, because overstating it is how a
// control comes to be trusted for something it does not do: `--model`, `--fallback-model` and
// the `--agents` payload pin every model Alfred NAMES. The env pins the ones the CLI resolves
// on its own — an alias, its own internal calls — which are precisely the ones no argv can
// reach and no record would show. Measured against the live gateway: `claude-haiku-4-5`,
// `anthropic.claude-haiku-4-5`, and `anthropic.claude-haiku-4-5-20251001-v1:0` all resolve and
// all price, so SEATS' bare ids are valid to hand over verbatim.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { SEATS, normalizeModelId } from '../lib/models.mjs';
import { SOURCE_FILENAME } from '../lib/item.mjs';
import { RECORD_FILENAME } from '../lib/run.mjs';
import {
  SEAT_ENV_VARS,
  executeWork,
  newRunDir,
  observeTree,
  runDirFor,
  seatEnvFrom,
  spawnWorker,
  workerEnv,
} from '../lib/run.mjs';

const NODE = process.execPath;
const temps = [];
const mktemp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), `alfred-run-${prefix}-`));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

// A real git repository with one commit. `observeTree` reads git, so a fake would assert
// against my model of `--numstat` rather than against git's output.
function repoWithCommit() {
  const dir = mktemp('repo');
  git(dir, ['init', '--quiet', '-b', 'main']);
  git(dir, ['config', 'user.email', 'alfred@example.invalid']);
  git(dir, ['config', 'user.name', 'Alfred Test']);
  writeFileSync(join(dir, 'a.js'), 'export const a = 1;\n');
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'test', 'a.test.js'), 'test one\ntest two\ntest three\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'base']);
  return dir;
}

const CONFIG = Object.freeze({
  version: 1,
  repo: 'jarvis',
  source: { kind: 'github', github: { owner: 'acme', repo: 'jarvis' } },
  base: { rules: [{ default: 'main' }] },
  branch_prefix: 'alfred/',
  verify: {},
  delivery: { mode: 'pr', never_merge: true },
  off_limits: [],
});

// --- THE SEAT ENV: the guard the handoff named, and the only one not deferred ---

test('the child env carries every seat family, sourced from SEATS rather than typed', () => {
  // ASSERTED AGAINST THE IMPORTED TABLE. A literal `claude-sonnet-5` here would pass forever
  // while SEATS moved underneath it — the #67 shape (a copy that drifts) in the one place where
  // the drift spends money at the wrong tier.
  const vars = seatEnvFrom(SEATS);

  assert.deepEqual(Object.keys(vars).sort(), [...SEAT_ENV_VARS].sort());
  assert.equal(vars.ANTHROPIC_DEFAULT_SONNET_MODEL, SEATS.worker.model);
  assert.equal(vars.ANTHROPIC_DEFAULT_OPUS_MODEL, SEATS.adjudicator.model);
  assert.equal(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL, SEATS.scan.model);

  // And every family a seat mentions has a var, so a seat added to a fourth family cannot be
  // silently left resolving to whatever the parent shell exported.
  for (const seat of Object.values(SEATS)) {
    const family = normalizeModelId(seat.model).match(/haiku|sonnet|opus/)?.[0];
    assert.ok(family, `seat model ${seat.model} names no known family`);
    assert.ok(
      Object.values(vars).includes(seat.model),
      `no env var carries the ${family} seat model ${seat.model}`,
    );
  }
});

test('a STALE inherited seat is overwritten, not preserved — the measured failure', () => {
  // THE MEASUREMENT, AS A TEST. Last session's process env held
  // `ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic.claude-sonnet-4-6` and no OPUS var at all. A
  // merge that let the inherited value win would run the worker seat a generation back while
  // the record showed the seat SEATS names, and nothing downstream could tell.
  const env = workerEnv({
    env: {
      PATH: '/usr/bin',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic.claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic.claude-haiku-3',
    },
  });

  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, SEATS.worker.model);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, SEATS.scan.model);
  // Absent inherited, present anyway: the other half of the measurement is a var that was
  // never exported at all.
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, SEATS.adjudicator.model);
});

test('an empty env still gets the seats, and PATH is preserved when it is there', () => {
  // `env -i zsh -l -c` showed zero seats. That is the tool-spawned case, and it must not
  // produce a child resolving models by the vendor's default.
  const bare = workerEnv({ env: {} });
  for (const name of SEAT_ENV_VARS) assert.ok(bare[name], `${name} missing from a bare env`);

  // PATH is MERGED, never replaced: the child needs node, git and claude off the inherited
  // path, and a replaced PATH fails for the environment's reason while reading as the run's.
  const kept = workerEnv({ env: { PATH: '/opt/bin:/usr/bin', HOME: '/home/x', TERM: 'dumb' } });
  assert.equal(kept.PATH, '/opt/bin:/usr/bin');
  assert.equal(kept.HOME, '/home/x');
  assert.equal(kept.TERM, 'dumb');
});

test('a seats table whose family disagrees with itself is refused, not silently resolved', () => {
  // One env var per family means two sonnet seats on different ids cannot both be honoured.
  // Picking one would route a seat to a model nobody wrote down — and it would be the kind of
  // wrong that only shows up as an unexplained cost column. Tested through the pure derivation
  // because SEATS itself is frozen, which is the point of taking the table as an argument.
  assert.throws(
    () =>
      seatEnvFrom({
        worker: { model: 'claude-sonnet-5' },
        reason: { model: 'claude-sonnet-4-6' },
        scan: { model: 'claude-haiku-4-5' },
        adjudicator: { model: 'claude-opus-5' },
      }),
    /sonnet/i,
  );
});

test('the spawned child actually receives the seat env — asserted on a real process', () => {
  // THE SEAM, RUN FOR REAL. A test that checked `spawnWorker` passed `env` to a stubbed spawn
  // would be blind to the seam being missing, which is exactly how the four armc launch defects
  // survived sixty green tests. So a real child prints its own env and the file is read back.
  const dir = mktemp('env');
  const log = join(dir, 'child.log');
  const script = `process.stdout.write(JSON.stringify({s:process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,o:process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,h:process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL}))`;

  return spawnWorker(['-e', script], {
    bin: NODE,
    cwd: dir,
    logPath: log,
    env: { PATH: process.env.PATH, ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic.claude-sonnet-4-6' },
  }).then((outcome) => {
    assert.equal(outcome.exit, 0);
    assert.equal(outcome.killed, false);
    const seen = JSON.parse(readFileSync(log, 'utf8'));
    assert.equal(seen.s, SEATS.worker.model, 'the child inherited the stale sonnet seat');
    assert.equal(seen.o, SEATS.adjudicator.model);
    assert.equal(seen.h, SEATS.scan.model);
  });
});

// --- THE SPAWN: the three gaps eval/run-armc.mjs found by launching something ---

test('a launch failure rejects — it is not a run that delivered nothing', async () => {
  // Measured in armc on a PATH with no `claude`: the promise resolved `{killed:false, exit:null}`
  // and the process then died on an unhandled 'error'. A completed-with-no-cost outcome for a
  // run that never started is the false success this races against.
  const dir = mktemp('enoent');
  await assert.rejects(
    () => spawnWorker(['-p', 'x'], { bin: join(dir, 'there-is-no-binary-here'), cwd: dir, logPath: join(dir, 'w.log') }),
    /never launched/i,
  );
});

test('stdio goes to a FILE, so a child past the 64KB pipe buffer still exits', async () => {
  // The measured deadlock: with `stdio: 'pipe'` and nothing draining it, a stub emitting 200KB
  // never exited. Arm C runs `--output-format json`, whose payload is far past 64KB, so every
  // run would have hung to the wall cap and been scored as a slow topology — the launcher's bug
  // reported as a finding about Alfred.
  const dir = mktemp('big');
  const log = join(dir, 'big.log');
  const outcome = await spawnWorker(['-e', "process.stdout.write('x'.repeat(200000))"], {
    bin: NODE,
    cwd: dir,
    logPath: log,
  });
  assert.equal(outcome.exit, 0);
  assert.equal(outcome.killed, false);
  assert.equal(statSync(log).size, 200000, 'the payload did not reach the log file');
});

test('the wall cap fires from outside the child and reports the kill', async () => {
  // A worker that hangs is otherwise unbounded — Alfred's own argv carries no dollar ceiling
  // (see lib/router.mjs's header), so this wall cap is the only thing standing between a
  // stuck worker and an unattended tick that never ends. SIGTERM rather than SIGKILL, because
  // the transcript the run is priced from has to flush.
  const dir = mktemp('cap');
  const outcome = await spawnWorker(['-e', 'setTimeout(() => {}, 60000)'], {
    bin: NODE,
    cwd: dir,
    logPath: join(dir, 'hang.log'),
    wallCapMs: 400,
  });
  assert.equal(outcome.killed, true);
  assert.equal(outcome.signal, 'SIGTERM');
  assert.ok(outcome.wall_ms >= 400);
});

test('a non-zero exit is reported as itself, not as a failure to launch', async () => {
  const dir = mktemp('exit');
  const outcome = await spawnWorker(['-e', 'process.exit(3)'], {
    bin: NODE,
    cwd: dir,
    logPath: join(dir, 'e.log'),
  });
  assert.equal(outcome.exit, 3);
  assert.equal(outcome.killed, false);
});

// --- THE RUN DIRECTORY ---

test('the run directory is NOT inside the repository the gate scores', () => {
  // The experiment's contamination lesson, one layer in. The gate reads the working-tree diff,
  // so a source.json or worker.log written under repoRoot is counted as DELIVERED WORK —
  // scope_violation on a run that did nothing wrong. armc put the log alongside the clone for
  // this reason; the same rule applies to every artifact of the run.
  const repo = mktemp('scored');
  const dir = runDirFor({ repoRoot: repo, itemId: 'acme/jarvis#4', stamp: '20260731T101500Z' });
  assert.ok(!resolve(dir).startsWith(`${resolve(repo)}/`), `run dir ${dir} is inside ${repo}`);

  // Deterministic given a stamp, so the record's path is reproducible and two runs never share
  // a directory (armc: `$TMPDIR/armC1-worker.log` silently replaced the previous run's output).
  assert.equal(dir, runDirFor({ repoRoot: repo, itemId: 'acme/jarvis#4', stamp: '20260731T101500Z' }));
  assert.notEqual(dir, runDirFor({ repoRoot: repo, itemId: 'acme/jarvis#4', stamp: '20260731T101600Z' }));

  // A slug, not the raw id: `acme/jarvis#4` carries a path separator, and joining it unescaped
  // creates `.../acme/jarvis#4/` — a directory tree keyed on someone else's repo name.
  assert.doesNotMatch(dir.slice(resolve(repo).length + 1 || 0), /acme\/jarvis/);
  assert.ok(dir.includes('20260731T101500Z'));
});

test('a long ref does not truncate away the part that DISTINGUISHES two tickets', () => {
  // ADDED after browse URLs became legal refs (`4c00ecf`). `newRunDir` names the directory from
  // the REF, because resolving the item is what writes into the directory and so the directory
  // must exist first — and the comment there asserted "a ticket ref slugs to the same thing its
  // id would". A browse URL made that false.
  //
  // MEASURED: the slug caps at 60 chars, and the key sits at the END of a browse URL, so
  //   https://fandango.atlassian.net/browse/TARS-1351?focusedCommentId=1234567890
  // slugged to `https-fandango.atlassian.net-browse-TARS-1351-focusedComment` — the key gone. The
  // 60 chars that survive are all PREFIX: scheme, host, `/browse/`. So the longer the host, the
  // less of the ticket is left, and past a certain host length nothing distinguishes two tickets
  // at all. That is the collision this function's own comment says it exists to prevent (armc's
  // `$TMPDIR/armC1-worker.log` silently replaced its predecessor's output), reintroduced through
  // the FRONT of the string rather than the back.
  //
  // The assertion is on DISTINGUISHABILITY, not on any particular slug format: whatever the naming
  // rule is, two refs that name different tickets must not land in the same directory.
  const repo = mktemp('longref');
  const stamp = '20260801T220000Z';
  const at = (ref) => runDirFor({ repoRoot: repo, itemId: ref, stamp });

  // A LONG HOST, because that is the pair that actually collides. MEASURED first: the shorter
  // `fandango.atlassian.net` pair keeps its differing digit at char ~45 and stays distinct, so
  // asserting on it would have passed vacuously and pinned nothing.
  const host = 'a-really-quite-long-company-name-goes-here.atlassian.net';
  const a = at(`https://${host}/browse/TARS-1351`);
  const b = at(`https://${host}/browse/TARS-1359`);
  assert.notEqual(a, b, 'two different tickets share a run directory — one run overwrites the other');

  // And the key must be legible in the path. An operator reading `.alfred-runs/` at 3am is the
  // only consumer of this name; a directory they cannot attribute to a ticket is a directory they
  // cannot use, even when it is unique.
  for (const [ref, key] of [
    ['https://fandango.atlassian.net/browse/TARS-1351', 'TARS-1351'],
    ['https://fandango.atlassian.net/browse/TARS-1351?focusedCommentId=1234567890', 'TARS-1351'],
    ['https://a-really-quite-long-company-name-goes-here.atlassian.net/browse/TARS-1351', 'TARS-1351'],
    ['TARS-1351', 'TARS-1351'],
  ]) {
    assert.match(at(ref), new RegExp(key), `run dir for ${ref} does not name ${key}`);
  }
});

test('the run directory NAME stays inside the filesystem limit, however long the ref', () => {
  // A THIRD proposition, split out rather than folded above, and the split is not stylistic:
  // mutation-scored, "drop the cap entirely" SURVIVED both assertions in that test. An untruncated
  // slug is both unique and legible, so nothing there was defending the cap — and the cap is what
  // stops a pathological ref from producing a name the filesystem refuses. Folded together, one
  // green boolean would have covered two claims and the weaker one would be untested. (Same shape
  // as the `unfalsifiable_conjunct` lesson, applied to a test instead of a gate rule.)
  //
  // 255 bytes is the per-component limit on both APFS and ext4. The stamp and its separator ride
  // in the same component, so the budget is the WHOLE basename, not just the slug.
  const repo = mktemp('namecap');
  const stamp = '20260801T220000Z';
  const dir = runDirFor({ repoRoot: repo, itemId: `TARS-${'9'.repeat(400)}`, stamp });
  const name = dir.split('/').pop();
  assert.ok(
    Buffer.byteLength(name) <= 255,
    `run dir basename is ${Buffer.byteLength(name)} bytes; ENAMETOOLONG before anything is written`,
  );

  // And it must still be CREATABLE, not merely short. The byte count is a proxy; mkdir is the
  // actual claim, and a proxy that passes while the syscall fails is the failure this catches.
  const made = newRunDir({ repoRoot: repo, ref: `TARS-${'9'.repeat(400)}`, stamp });
  assert.ok(existsSync(made), `run dir was not created: ${made}`);
});

// --- OBSERVING THE TREE: the difference between clean and unlooked-at ---

test('a clean tree is observed as [] and never as undefined', async () => {
  // #63's shape, and gate.mjs says it in as many words: `undefined` diffstat means UNOBSERVED
  // and `checkEvidence`/`checkInstruments` return without a verdict; `[]` means observed and
  // clean. A runner that forgot to look would silently disable both rules while the record
  // showed a pass — a clause resting on a measurement that never happened.
  const repo = repoWithCommit();
  const seen = await observeTree({ repoRoot: repo });
  assert.ok(Array.isArray(seen.diffstat), 'diffstat is not an array for a clean tree');
  assert.deepEqual(seen.diffstat, []);
  assert.deepEqual(seen.touched, []);
});

test('the diffstat carries added and deleted per file, the keys the gate reads', async () => {
  // `checkEvidence` filters on `Number(entry.deleted) > 0` and `checkInstruments` sums
  // `added + deleted`. A shape carrying `insertions`/`deletions` instead would make both rules
  // read every file as zero-churn and never fire — green, and blind.
  const repo = repoWithCommit();
  writeFileSync(join(repo, 'a.js'), 'export const a = 2;\nexport const b = 3;\n');
  writeFileSync(join(repo, 'test', 'a.test.js'), 'test one\n');

  const seen = await observeTree({ repoRoot: repo });
  const byFile = new Map(seen.diffstat.map((e) => [e.file, e]));

  assert.ok(byFile.has('a.js'), 'a modified file is missing from the diffstat');
  assert.equal(byFile.get('a.js').added, 2);
  assert.equal(byFile.get('a.js').deleted, 1);

  // The one that matters: two deleted lines from a test file is what `evidence_weakened` keys
  // on, and it fired 3/3 prospectively in the gated n=3.
  assert.equal(byFile.get('test/a.test.js').deleted, 2);
  assert.deepEqual([...byFile.keys()].sort(), ['a.js', 'test/a.test.js']);
  assert.deepEqual(seen.touched.sort(), ['a.js', 'test/a.test.js']);
});

test('an untracked new file is touched — a worker delivers by adding, not only by editing', async () => {
  // `git diff --numstat` alone reports nothing for an untracked file, so a runner built on it
  // would let a whole new module land outside the declared scope unseen.
  const repo = repoWithCommit();
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'new.js'), 'export const n = 1;\nexport const m = 2;\n');

  const seen = await observeTree({ repoRoot: repo });
  assert.ok(seen.touched.includes('src/new.js'), 'an untracked file is not reported as touched');
  const entry = seen.diffstat.find((e) => e.file === 'src/new.js');
  assert.ok(entry, 'an untracked file is missing from the diffstat');
  assert.equal(entry.added, 2);
  assert.equal(entry.deleted, 0);
});

// --- #74: COUNTING WHAT SURVIVED, against real git ------------------------------------------
//
// These run against a real repository on purpose. The gate's own tests hand `checkEvidence`
// recorded counts, which proves the RULE but says nothing about whether anything produces those
// counts from an actual `git show` — the mocked-seam shape, where a test injecting a fake at a
// seam cannot see the seam is missing. So the numbers here come from git.
//
// The counting regex is exercised through this path rather than unit-tested in isolation for the
// same reason: what matters is the count for a file as git hands it over, not for a string I
// wrote to match my own regex.

// A repo whose test file has real blocks and real assertions, so the counts have something to
// count. Deliberately includes the shapes the naive regex gets wrong.
function repoWithRealTests() {
  const dir = mktemp('repo-counts');
  git(dir, ['init', '--quiet', '-b', 'main']);
  git(dir, ['config', 'user.email', 'alfred@example.invalid']);
  git(dir, ['config', 'user.name', 'Alfred Test']);
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(
    join(dir, 'test', 'channels.test.js'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      '',
      "test('sms retries three times', () => {",
      '  assert.equal(send("sms"), 3);',
      '  assert.equal(attempts(), 3);',
      '});',
      '',
      "test('push retries three times', () => {",
      '  assert.equal(send("push"), 3);',
      '  assert.equal(attempts(), 3);',
      '});',
      '',
    ].join('\n'),
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'base']);
  return dir;
}

test('#74: counts are attached from real git for an evidence file that lost lines', async () => {
  const repo = repoWithRealTests();
  // The arm-C shape: one whole test deleted, so the surviving assertions halve.
  writeFileSync(
    join(repo, 'test', 'channels.test.js'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      '',
      "test('sms retries three times', () => {",
      '  assert.equal(send("sms"), 3);',
      '});',
      '',
    ].join('\n'),
  );

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  const entry = seen.diffstat.find((e) => e.file === 'test/channels.test.js');
  assert.ok(entry, 'the evidence file is missing from the diffstat');
  assert.equal(entry.tests_before, 2, 'two test blocks before');
  assert.equal(entry.tests_after, 1, 'one after');
  assert.equal(entry.assertions_before, 4);
  assert.equal(entry.assertions_after, 1);
});

test('#74: counts are NOT attached without the flag — the pre-spawn check pays no git calls', async () => {
  // `treeIsDirty` asks a different question and has no `since` to diff against. If the counts
  // were unconditional, every dirty check would shell out per evidence file to compare HEAD with
  // itself, and the pre-spawn path would start failing in repos where a path cannot resolve.
  const repo = repoWithRealTests();
  writeFileSync(join(repo, 'test', 'channels.test.js'), 'test("one", () => {});\n');

  const seen = await observeTree({ repoRoot: repo });
  const entry = seen.diffstat.find((e) => e.file === 'test/channels.test.js');
  assert.equal(entry.tests_before, undefined);
  assert.equal(entry.assertions_after, undefined);
});

test('#74: a pure addition to an evidence file gets no counts — nothing was deleted to explain', async () => {
  // `checkEvidence` never looks at an entry with `deleted === 0`, so counting it would be work
  // whose result nothing reads. Asserted so the gating stays deliberate rather than incidental.
  const repo = repoWithRealTests();
  const src = readFileSync(join(repo, 'test', 'channels.test.js'), 'utf8');
  writeFileSync(
    join(repo, 'test', 'channels.test.js'),
    `${src}\ntest('email retries', () => {\n  assert.equal(send("email"), 3);\n});\n`,
  );

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  const entry = seen.diffstat.find((e) => e.file === 'test/channels.test.js');
  assert.equal(entry.deleted, 0, 'this fixture must be a pure addition or the test proves nothing');
  assert.equal(entry.tests_before, undefined);
});

test('#74: a deleted evidence file counts to zero — an absence measured, not an absence of measurement', async () => {
  // The strongest signal this rule can receive, and it must not arrive as "unobserved". Deleting
  // the file outright is the crudest version of the exploit.
  const repo = repoWithRealTests();
  rmSync(join(repo, 'test', 'channels.test.js'));

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  const entry = seen.diffstat.find((e) => e.file === 'test/channels.test.js');
  assert.ok(entry, 'a deleted file is still a diffstat entry');
  assert.equal(entry.tests_before, 2);
  assert.equal(entry.tests_after, 0);
  assert.equal(entry.assertions_after, 0);
});

test('#74: it.each and test.skip are counted — the bare regex scores them zero', async () => {
  // MEASURED: `/\b(it|test)\s*\(/` matches neither `it.each(` nor `test.skip(`, so converting a
  // suite to `it.each` reads as mass deletion while skipping every test in a file can read as no
  // change at all. Both are wrong in a direction that moves a verdict.
  const repo = repoWithRealTests();
  writeFileSync(
    join(repo, 'test', 'channels.test.js'),
    [
      "test.skip('sms retries three times', () => {",
      '  assert.equal(send("sms"), 3);',
      '});',
      "it.each([1, 2])('push retries %i', (n) => {",
      '  assert.equal(attempts(), n);',
      '});',
      '',
    ].join('\n'),
  );

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  const entry = seen.diffstat.find((e) => e.file === 'test/channels.test.js');
  assert.equal(entry.tests_after, 2, 'test.skip and it.each are both test blocks');
});

test('#74: a commented-out test and a test name inside a string do not inflate the count', async () => {
  // Both inflate a raw-source count, and the second is the one a worker reaches for: comment the
  // assertions out, leave the block, and a naive counter reports the evidence intact.
  const repo = repoWithRealTests();
  writeFileSync(
    join(repo, 'test', 'channels.test.js'),
    [
      "// test('sms retries three times', () => {",
      "//   assert.equal(send('sms'), 3);",
      '// });',
      "const label = \"test('push retries', () => {})\";",
      '/* test("block comment", () => { assert.ok(true); }); */',
      "test('the only real one', () => {",
      '  assert.equal(attempts(), 3);',
      '});',
      '',
    ].join('\n'),
  );

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  const entry = seen.diffstat.find((e) => e.file === 'test/channels.test.js');
  assert.equal(entry.tests_after, 1, 'only the uncommented, unquoted block counts');
  assert.equal(entry.assertions_after, 1);
});

test('#74: a renamed evidence file resolves both sides through the arrow', async () => {
  // MEASURED, and the fixture is what the measurement changed: --numstat only emits
  // `test/{old => new}.test.js` when RENAME DETECTION fires, which needs >50% similarity — not
  // merely a `git mv`. The two-test fixture above renamed-and-cut falls under the threshold and
  // git reports two ordinary entries instead. So this uses a 12-test file with one test removed,
  // which is both over the threshold and the honest-refactor shape the arrow actually shows up
  // for in practice. `git show HEAD:test/{a => b}.test.js` fails `path does not exist`, so
  // unresolved this file arrives with no counts — safe but blind, and rename-plus-gut is real.
  const repo = mktemp('repo-rename');
  git(repo, ['init', '--quiet', '-b', 'main']);
  git(repo, ['config', 'user.email', 'alfred@example.invalid']);
  git(repo, ['config', 'user.name', 'Alfred Test']);
  mkdirSync(join(repo, 'test'), { recursive: true });
  const block = (i) => [`test('case ${i}', () => {`, `  assert.equal(f(${i}), ${i});`, '});'];
  const all = Array.from({ length: 12 }, (_, i) => block(i)).flat();
  writeFileSync(join(repo, 'test', 'channels.test.js'), `${all.join('\n')}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'base']);

  git(repo, ['mv', 'test/channels.test.js', 'test/notify.test.js']);
  writeFileSync(join(repo, 'test', 'notify.test.js'), `${all.slice(0, 33).join('\n')}\n`);
  git(repo, ['add', '-A']);

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  const entry = seen.diffstat.find((e) => /notify\.test\.js/.test(e.file));
  assert.ok(entry, `expected a rename entry, got ${JSON.stringify(seen.diffstat)}`);
  assert.equal(entry.file, 'test/notify.test.js', 'the arrow is RESOLVED, not passed downstream');
  assert.equal(entry.renamed_from, 'test/channels.test.js', 'and the pre-image is not lost');
  assert.equal(entry.tests_before, 12, 'the pre-image is read through the rename arrow');
  assert.equal(entry.tests_after, 11, 'and the post-image from the worktree');
});

test('#74: a below-threshold rename is two entries and the vanished side counts to zero', async () => {
  // The other measured half: under 50% similarity git reports an all-deleted old path and an
  // all-added new one. Nothing needs resolving, and the old path counting to zero is the correct
  // reading of a file that is gone — which is what makes gutting-via-rename visible either way.
  const repo = repoWithRealTests();
  git(repo, ['mv', 'test/channels.test.js', 'test/notify.test.js']);
  writeFileSync(
    join(repo, 'test', 'notify.test.js'),
    ["test('sms retries three times', () => {", '  assert.equal(send("sms"), 3);', '});', ''].join('\n'),
  );
  git(repo, ['add', '-A']);

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  assert.equal(seen.diffstat.length, 2, `expected two entries, got ${JSON.stringify(seen.diffstat)}`);
  const gone = seen.diffstat.find((e) => e.file === 'test/channels.test.js');
  assert.equal(gone.tests_before, 2);
  assert.equal(gone.tests_after, 0, 'the old path is gone from the worktree');
});

test('#74: an unreadable pre-image degrades that file alone and leaves the rest of the diffstat intact', async () => {
  // The failure mode that matters most, because `observeTree`'s post-spawn call site sits inside
  // a try whose catch turns the ENTIRE diffstat to undefined — which would blind
  // evidence_weakened AND instrument_modified for the whole run, not just for this file.
  //
  // The first version of this test passed a nonexistent `since` and failed for the wrong reason:
  // `git diff --numstat <bad-ref>` throws before any `git show` runs, so it proved the diff can
  // fail, not that ONE file's read can. The per-file failure is reproduced instead by a path git
  // reports but cannot show — a submodule gitlink, whose `HEAD:<path>` is a commit object, not a
  // blob. The plain file beside it must keep its counts.
  const repo = repoWithRealTests();
  const inner = mktemp('submodule');
  git(inner, ['init', '--quiet', '-b', 'main']);
  git(inner, ['config', 'user.email', 'alfred@example.invalid']);
  git(inner, ['config', 'user.name', 'Alfred Test']);
  mkdirSync(join(inner, 'test'), { recursive: true });
  writeFileSync(join(inner, 'test', 'inner.test.js'), 'test("a", () => { assert.ok(1); });\n');
  git(inner, ['add', '-A']);
  git(inner, ['commit', '--quiet', '-m', 'one']);

  git(repo, ['-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', inner, 'test/vendor']);
  git(repo, ['commit', '--quiet', '-m', 'add submodule']);
  // Move the submodule's HEAD so the gitlink itself shows as changed in the parent.
  writeFileSync(join(inner, 'test', 'inner.test.js'), 'test("a", () => { assert.ok(1); });\ntest("b", () => { assert.ok(1); });\n');
  git(inner, ['commit', '--quiet', '-am', 'two']);
  git(join(repo, 'test', 'vendor'), ['fetch', '--quiet', 'origin']);
  git(join(repo, 'test', 'vendor'), ['checkout', '--quiet', 'origin/main']);
  // ...and gut the ordinary evidence file in the same tree.
  writeFileSync(join(repo, 'test', 'channels.test.js'), 'test("one", () => { assert.ok(1); });\n');

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  assert.ok(Array.isArray(seen.diffstat), 'the diffstat survived an unreadable pre-image');
  const plain = seen.diffstat.find((e) => e.file === 'test/channels.test.js');
  assert.ok(plain, 'the ordinary evidence file is still reported');
  assert.equal(plain.tests_before, 2, 'and still measured — one bad path costs the others nothing');
  assert.equal(plain.tests_after, 1);
});

test('#74: a rename with NO common part has no braces at all, and still resolves', async () => {
  // FOUND BY RUNNING IT, after the braced form was already handled and believed sufficient. Git
  // factors out a common prefix/suffix, so the braces appear only when there is something to
  // factor: a cross-directory move with nothing shared emits the bare
  // `old/sub/a.test.js => new/deep/b.test.js`. The brace-only parse missed it completely — the
  // whole 50-char string went to `git show`, which failed, and the file arrived unmeasured. The
  // rename that moves furthest is the one that hid best.
  const repo = mktemp('repo-nested');
  git(repo, ['init', '--quiet', '-b', 'main']);
  git(repo, ['config', 'user.email', 'alfred@example.invalid']);
  git(repo, ['config', 'user.name', 'Alfred Test']);
  mkdirSync(join(repo, 'old', 'sub'), { recursive: true });
  const block = (i) => [`test('case ${i}', () => {`, `  assert.equal(f(${i}), ${i});`, '});'];
  const all = Array.from({ length: 12 }, (_, i) => block(i)).flat();
  writeFileSync(join(repo, 'old', 'sub', 'channels.test.js'), `${all.join('\n')}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'base']);

  mkdirSync(join(repo, 'new', 'deep'), { recursive: true });
  git(repo, ['mv', 'old/sub/channels.test.js', 'new/deep/notify.test.js']);
  writeFileSync(join(repo, 'new', 'deep', 'notify.test.js'), `${all.slice(0, 33).join('\n')}\n`);
  git(repo, ['add', '-A']);

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  const entry = seen.diffstat.find((e) => /notify\.test\.js/.test(e.file));
  assert.ok(entry, `expected a rename entry, got ${JSON.stringify(seen.diffstat)}`);
  assert.doesNotMatch(entry.file, /[{}]/, 'this fixture must produce the BRACELESS form');
  assert.equal(entry.tests_before, 12, 'the pre-image resolved from the left of a bare arrow');
  assert.equal(entry.tests_after, 11);
});

test('#74: braces holding whole path segments resolve — one factoring, slashes inside', async () => {
  // The third rename shape, and the one that settled how strict the inner captures need to be.
  // Asked for a move where BOTH an intermediate directory and the filename change, git does not
  // emit two braced groups — it factors once and puts the slashes inside:
  // `a/{b/c/x.test.js => z/c/y.test.js}`. So `[^{}]*` must still match a path containing `/`,
  // which this asserts, and the two-braced-segment hazard the tighter regex was supposed to
  // guard against does not exist in git's output.
  const repo = mktemp('repo-segments');
  git(repo, ['init', '--quiet', '-b', 'main']);
  git(repo, ['config', 'user.email', 'alfred@example.invalid']);
  git(repo, ['config', 'user.name', 'Alfred Test']);
  mkdirSync(join(repo, 'a', 'b', 'c'), { recursive: true });
  const block = (i) => [`test('case ${i}', () => {`, `  assert.equal(f(${i}), ${i});`, '});'];
  const all = Array.from({ length: 12 }, (_, i) => block(i)).flat();
  writeFileSync(join(repo, 'a', 'b', 'c', 'x.test.js'), `${all.join('\n')}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'base']);

  mkdirSync(join(repo, 'a', 'z', 'c'), { recursive: true });
  git(repo, ['mv', 'a/b/c/x.test.js', 'a/z/c/y.test.js']);
  writeFileSync(join(repo, 'a', 'z', 'c', 'y.test.js'), `${all.slice(0, 33).join('\n')}\n`);
  git(repo, ['add', '-A']);

  // Raw git output asserted directly, because the point of the fixture is which SHAPE git emits,
  // and `observeTree` no longer passes that shape on — it resolves it.
  const raw = git(repo, ['diff', '--numstat', 'HEAD', '--']);
  assert.match(raw, /\{a\/b\/c|\{b\/c/, `expected slashes inside the braces, got ${raw}`);

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  const entry = seen.diffstat.find((e) => /y\.test\.js/.test(e.file));
  assert.ok(entry, `expected a rename entry, got ${JSON.stringify(seen.diffstat)}`);
  assert.equal(entry.file, 'a/z/c/y.test.js', 'a braced group spanning path segments resolved');
  assert.equal(entry.renamed_from, 'a/b/c/x.test.js');
  assert.equal(entry.tests_before, 12);
  assert.equal(entry.tests_after, 11);
});

test('#74: a rename OUT of test/ is still evidence — the gate sees a real path either way', async () => {
  // THE DEFECT THIS RESOLUTION EXISTS FOR, and it reached past the rule being fixed. Handed the
  // raw `src/{a.test.js => b.test.js}`, the gate's own `isEvidence` returns FALSE: the last
  // segment is `b.test.js}` — with the brace, so `\.test\.js$` misses — and no segment is
  // `test`. So a renamed test file outside a `test/` directory was invisible to
  // `evidence_weakened` altogether, and `scope_violation`/`off_limits` were globbing the same
  // unreal string. `test/{a => b}.test.js` survived only because its prefix happened to be
  // literally `test`, which is why this was not caught by the first pass of these tests.
  const repo = mktemp('repo-out-of-test');
  git(repo, ['init', '--quiet', '-b', 'main']);
  git(repo, ['config', 'user.email', 'alfred@example.invalid']);
  git(repo, ['config', 'user.name', 'Alfred Test']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  const block = (i) => [`test('case ${i}', () => {`, `  assert.equal(f(${i}), ${i});`, '});'];
  const all = Array.from({ length: 12 }, (_, i) => block(i)).flat();
  writeFileSync(join(repo, 'src', 'channels.test.js'), `${all.join('\n')}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'base']);

  git(repo, ['mv', 'src/channels.test.js', 'src/notify.test.js']);
  writeFileSync(join(repo, 'src', 'notify.test.js'), `${all.slice(0, 33).join('\n')}\n`);
  git(repo, ['add', '-A']);

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  const entry = seen.diffstat.find((e) => /notify\.test\.js/.test(e.file));
  assert.ok(entry, `expected a rename entry, got ${JSON.stringify(seen.diffstat)}`);
  assert.equal(entry.file, 'src/notify.test.js', 'a path the gate can actually match');
  assert.equal(entry.tests_before, 12, 'and one it will measure, with no test/ segment anywhere');
  assert.equal(entry.tests_after, 11);
});

test('#74: a rename that STOPS looking like evidence is still measured — either side counts', async () => {
  // The falsifier for checking both sides, and it needed a fixture the earlier rename tests could
  // not provide: every one of them keeps a `.test.js` suffix, so the post-image alone still
  // satisfies `looksLikeEvidence` and the pre-image check is never load-bearing. Renaming
  // `test/channels.test.js` to `src/channels.js` is the shape that separates them — the file that
  // arrives is ordinary source by every rule, while what LEFT was the suite.
  //
  // This is not hypothetical evasion so much as the honest version of it: "I moved the assertions
  // into the module" is a real refactor, and the counts are how the two are told apart. Measured
  // either way, the operator sees 12 tests became 0.
  const repo = mktemp('repo-unevidence');
  git(repo, ['init', '--quiet', '-b', 'main']);
  git(repo, ['config', 'user.email', 'alfred@example.invalid']);
  git(repo, ['config', 'user.name', 'Alfred Test']);
  mkdirSync(join(repo, 'test'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  const block = (i) => [`test('case ${i}', () => {`, `  assert.equal(f(${i}), ${i});`, '});'];
  const all = Array.from({ length: 12 }, (_, i) => block(i)).flat();
  writeFileSync(join(repo, 'test', 'channels.test.js'), `${all.join('\n')}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'base']);

  git(repo, ['mv', 'test/channels.test.js', 'src/channels.js']);
  writeFileSync(join(repo, 'src', 'channels.js'), `${all.slice(0, 33).join('\n')}\n`);
  git(repo, ['add', '-A']);

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  const entry = seen.diffstat.find((e) => /channels\.js$/.test(e.file));
  assert.ok(entry, `expected a rename entry, got ${JSON.stringify(seen.diffstat)}`);
  assert.equal(entry.file, 'src/channels.js', 'the post-image is plain source by every rule');
  assert.equal(entry.renamed_from, 'test/channels.test.js');
  assert.equal(entry.tests_before, 12, 'measured anyway, because what LEFT was evidence');
  assert.equal(entry.tests_after, 11);
});

test('#74: a literal quote in a filename is decoded — quotePath=false does not cover it', async () => {
  // The measurement that removed `-c core.quotePath=false` rather than adding it. That flag
  // unescapes non-ASCII, but a name holding a literal `"` stays quoted under it regardless
  // (`"test/we\"ird.test.js"`), because raw quotes would make the output unparseable. So the
  // decoder has to exist either way — and with the flag present, the decoder would only ever run
  // for names like this one, leaving the common path untested by anything.
  const repo = mktemp('repo-quote');
  git(repo, ['init', '--quiet', '-b', 'main']);
  git(repo, ['config', 'user.email', 'alfred@example.invalid']);
  git(repo, ['config', 'user.name', 'Alfred Test']);
  mkdirSync(join(repo, 'test'), { recursive: true });
  const name = 'we"ird.test.js';
  writeFileSync(
    join(repo, 'test', name),
    'test("a", () => { assert.ok(1); });\ntest("b", () => { assert.ok(1); });\n',
  );
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'base']);
  writeFileSync(join(repo, 'test', name), 'test("a", () => { assert.ok(1); });\n');

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  const entry = seen.diffstat.find((e) => e.file === `test/${name}`);
  assert.ok(entry, `expected the decoded path, got ${JSON.stringify(seen.touched)}`);
  assert.equal(entry.tests_before, 2, 'the pre-image resolved, so the counts arrived');
  assert.equal(entry.tests_after, 1);
});

test('#74: a non-ASCII path is unescaped, so the gate scores the file that exists on disk', async () => {
  // MEASURED: git C-quotes any path with a byte outside ASCII, so `test/ünï.test.js` arrives from
  // BOTH --numstat and ls-files as `"test/\303\274n\303\257.test.js"` — a literal 30-character
  // string. Left as-is that string is what `isEvidence` matches, what the operator reads in
  // `touched`, and what `git show HEAD:<path>` is handed. All three are wrong at once, and the
  // last one silently: the counts just never arrive.
  const repo = mktemp('repo-utf8');
  git(repo, ['init', '--quiet', '-b', 'main']);
  git(repo, ['config', 'user.email', 'alfred@example.invalid']);
  git(repo, ['config', 'user.name', 'Alfred Test']);
  mkdirSync(join(repo, 'test'), { recursive: true });
  const two = 'test("a", () => { assert.ok(1); });\ntest("b", () => { assert.ok(1); });\n';
  writeFileSync(join(repo, 'test', 'ünï.test.js'), two);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'base']);
  writeFileSync(join(repo, 'test', 'ünï.test.js'), 'test("a", () => { assert.ok(1); });\n');
  writeFileSync(join(repo, 'test', 'nüw.test.js'), two); // untracked, via ls-files

  const seen = await observeTree({ repoRoot: repo, withEvidenceCounts: true });
  const entry = seen.diffstat.find((e) => e.file === 'test/ünï.test.js');
  assert.ok(entry, `expected an unescaped path, got ${JSON.stringify(seen.touched)}`);
  assert.equal(entry.tests_before, 2, 'the pre-image resolved, so the counts arrived');
  assert.equal(entry.tests_after, 1);
  const fresh = seen.diffstat.find((e) => e.file === 'test/nüw.test.js');
  assert.ok(fresh, 'the untracked non-ASCII path is unescaped too');
  assert.equal(fresh.added, 2, 'and its line count resolved, which needs the real filename');
});

// --- executeWork: the eight steps, and what must happen before anything spends ---

const stubSpawn = (impl) => (argv, opts) => Promise.resolve(impl(argv, opts));

// --- #14: A DIRTY TREE IS NOT GRADEABLE ------------------------------------------------------
//
// THE ATTRIBUTION BUG. `observeTree` reports the diff against HEAD and hands it to the gate,
// which reads every entry as work the worker did. Nothing in that path asks when a change
// arrived. So an edit already in the tree when the run starts is scored as the worker's, and it
// fails in BOTH directions at once:
//
//   FALSE FINDING — an operator's half-finished edit to `test/foo.test.js` raises
//   `evidence_weakened` against a worker that never opened the file. That is the #71 shape
//   (`gate failed a correct run`) with a cause the record cannot show, because the diffstat is
//   the only evidence and it looks identical either way.
//
//   FALSE PASS — a pre-existing edit that happens to satisfy a criterion is graded as
//   delivered. `resolveAcs` runs the declared commands against the tree as it stands and
//   reports the pass, which is the same false-green mechanism as #15's inherited ac-map, one
//   layer up: work nobody did this run, credited to this run.
//
// WHICH IS WHY THIS IS A REFUSAL AND NOT A FINDING. A finding is the gate's verdict on a run
// that happened; this must land BEFORE the spawn, because the money is spent producing a
// verdict that cannot mean anything. Exit 2, not 1 — the input is wrong, the run is not.
//
// AND IT MUST NOT AUTO-CLEAN. `git stash`/`git checkout -- .` on an operator's uncommitted work
// is unrecoverable from Alfred's side and the run would proceed as though nothing happened.
// Alfred's whole standing is that it does not silently repair the thing it is measuring.
//
// DIRTY IS DEFINED BY `observeTree`, NOT BY `git status`. The two disagree exactly where it
// matters: `--exclude-standard` skips ignored files, so #15's `.alfred/ac-map.json` is invisible
// to the observer and would be reported dirty by porcelain. A refusal keyed on a wider notion of
// dirty than the gate's would refuse runs whose trees the gate reads as clean.

test('ADDED #14: a tracked modification refuses BEFORE the worker is spawned', async () => {
  const repo = repoWithCommit();
  writeFileSync(join(repo, 'a.js'), 'export const a = 999;\n');
  let spawned = 0;

  const result = await executeWork({
    ref: 'work against a dirty tree',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260801T100000Z',
    spawn: stubSpawn(() => {
      spawned += 1;
      return { exit: 0, killed: false, signal: null, wall_ms: 1, log: null };
    }),
    report: () => null,
  });

  assert.equal(result.ok, false, 'a dirty tree was accepted');
  // THE LOAD-BEARING ASSERTION. `ok: false` alone would be satisfied by a refusal that fired
  // after the spend, which is the case this task exists to prevent.
  assert.equal(spawned, 0, 'the worker was spawned against a tree the gate cannot attribute');
});

test('ADDED #14: the refusal NAMES the dirty paths — an operator cannot act on a count', async () => {
  // The diagnostic is the whole value. "the working tree is dirty" sends someone to `git status`
  // in a repository they may not be sitting in; the paths say what to commit or revert. Two
  // files, so a message built from only the first is caught.
  const repo = repoWithCommit();
  writeFileSync(join(repo, 'a.js'), 'export const a = 999;\n');
  writeFileSync(join(repo, 'untracked-new.js'), 'export const n = 1;\n');

  const result = await executeWork({
    ref: 'name the paths',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260801T100100Z',
    spawn: stubSpawn(() => ({ exit: 0, killed: false, signal: null, wall_ms: 1, log: null })),
    report: () => null,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /a\.js/, 'the modified file is not named');
  // UNTRACKED COUNTS, and this is the half a `git diff`-only check would miss. `observeTree`
  // includes untracked files precisely because a whole new module can land unseen otherwise —
  // so a new file sitting in the tree at spawn time is attributed to the worker just as surely.
  assert.match(result.error, /untracked-new\.js/, 'an untracked file was not treated as dirty');
});

test('ADDED #14: the refusal does NOT clean the tree — the operator’s work survives it', async () => {
  // A refusal that stashed or reverted would make the run possible at the cost of the thing it
  // refused over. Asserted on the CONTENT, not on the file existing: `git checkout -- .` leaves
  // the path in place holding HEAD's version.
  const repo = repoWithCommit();
  writeFileSync(join(repo, 'a.js'), 'export const a = 999;\n');
  writeFileSync(join(repo, 'untracked-new.js'), 'export const n = 1;\n');

  await executeWork({
    ref: 'do not touch my work',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260801T100200Z',
    spawn: stubSpawn(() => ({ exit: 0, killed: false, signal: null, wall_ms: 1, log: null })),
    report: () => null,
  });

  assert.equal(readFileSync(join(repo, 'a.js'), 'utf8'), 'export const a = 999;\n', 'the edit was reverted');
  assert.equal(readFileSync(join(repo, 'untracked-new.js'), 'utf8'), 'export const n = 1;\n', 'the new file was removed');
  // And nothing was stashed away to be "helpfully" restored later.
  const stash = git(repo, ['stash', 'list']).trim();
  assert.equal(stash, '', `the tree was stashed: ${stash}`);
});

test('ADDED #14: a CLEAN tree still runs — the falsifier for all three above', async () => {
  // Without this, `ok: false` for every input satisfies the refusal tests and Alfred never runs
  // again. The §"unfalsifiable conjunct" rule applied to a guard: a check that always fires is
  // indistinguishable from a correct one until something needs to pass.
  const repo = repoWithCommit();
  let spawned = 0;

  const result = await executeWork({
    ref: 'a clean tree is workable',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260801T100300Z',
    spawn: stubSpawn((argv, opts) => {
      spawned += 1;
      return { exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath };
    }),
    report: () => null,
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(spawned, 1, 'a clean tree did not reach the worker');
});

test('ADDED #14: an IGNORED file is not dirty — dirty means what the gate can see', async () => {
  // #15 put `.alfred/ac-map.json` in `.gitignore` so `--exclude-standard` skips it and the
  // marker leaves the diff the gate scores. A refusal keyed on `git status --porcelain` would
  // read that same file as dirty and refuse every run in this repository — a guard stricter than
  // the harm, which is how a correct guard gets turned off.
  const repo = repoWithCommit();
  writeFileSync(join(repo, '.gitignore'), 'ignored-artifact.log\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'ignore rule']);
  writeFileSync(join(repo, 'ignored-artifact.log'), 'noise\n');

  const result = await executeWork({
    ref: 'an ignored file is not the workers doing',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260801T100400Z',
    spawn: stubSpawn((argv, opts) => ({
      exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath,
    })),
    report: () => null,
  });

  assert.equal(result.ok, true, `an ignored file was treated as dirty: ${result.error}`);
});

test('ADDED #14: allowDirty runs anyway, and the refusal is what it overrides', async () => {
  // The escape hatch, because the operator sometimes MEANS to work a tree that already has
  // changes in it — a run resumed by hand, or an eval arm that stages a fixture first. It takes
  // the same input as the refusing test above, so the two together prove the flag is what moved
  // the outcome and not the tree.
  const repo = repoWithCommit();
  writeFileSync(join(repo, 'a.js'), 'export const a = 999;\n');
  let spawned = 0;

  const result = await executeWork({
    ref: 'deliberately dirty',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260801T100500Z',
    allowDirty: true,
    spawn: stubSpawn((argv, opts) => {
      spawned += 1;
      return { exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath };
    }),
    report: () => null,
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(spawned, 1, 'allowDirty did not reach the worker');
});

test('ADDED #14: a refused run leaves the fetched payload, so the refusal is auditable', async () => {
  // WHERE THE CHECK SITS, asserted rather than assumed. It is after `resolveItem` — which
  // §2.1 step 2 calls non-negotiable — so a refused tick still has `source.json` on disk and an
  // operator can see WHICH item was refused. Ordering it before the fetch would make a refused
  // run indistinguishable from one that never started.
  const repo = repoWithCommit();
  writeFileSync(join(repo, 'a.js'), 'export const a = 999;\n');

  const result = await executeWork({
    ref: 'refused but recorded',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260801T100600Z',
    spawn: stubSpawn(() => ({ exit: 0, killed: false, signal: null, wall_ms: 1, log: null })),
    report: () => null,
  });

  assert.equal(result.ok, false);
  assert.ok(result.run_dir, 'a refused run reported no run directory');
  const written = JSON.parse(readFileSync(join(result.run_dir, SOURCE_FILENAME), 'utf8'));
  assert.equal(written.ref, 'refused but recorded');
  // And no record: nothing was graded, so there is no accounting to write. A record here would
  // read as a run that completed.
  assert.ok(
    !readdirSync(result.run_dir).includes(RECORD_FILENAME),
    'a refused run wrote an accounting record for work that never happened',
  );
});

test('the raw payload is on disk BEFORE the worker is spawned', async () => {
  // PLAN.md §2.1 step 2, called non-negotiable there and a bug fix rather than a feature:
  // harness-core persisted a one-line `source.excerpt`, so no run there is replayable. Asserted
  // from INSIDE the spawn, which is the only place that can prove the ordering — checking after
  // the run would pass on a writer that ran last.
  const repo = repoWithCommit();
  let sourceAtSpawnTime = null;

  const result = await executeWork({
    ref: 'make the retry backoff configurable',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T120000Z',
    spawn: (argv, opts) => {
      sourceAtSpawnTime = readFileSync(join(opts.runDir, SOURCE_FILENAME), 'utf8');
      return Promise.resolve({ exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath });
    },
    report: () => null,
  });

  assert.ok(result.ok, result.error);
  const written = JSON.parse(sourceAtSpawnTime);
  assert.equal(written.kind, 'alfred-source');
  assert.equal(written.ref, 'make the retry backoff configurable');
});

test('a work item that cannot be resolved refuses before spawning anything', async () => {
  // The whole point of ordering the steps: a ref naming another repository must cost nothing.
  const repo = repoWithCommit();
  let spawned = 0;

  const result = await executeWork({
    ref: 'https://github.com/other/elsewhere/issues/9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T120100Z',
    spawn: stubSpawn(() => {
      spawned += 1;
      return { exit: 0, killed: false, signal: null, wall_ms: 1, log: null };
    }),
    report: () => null,
  });

  assert.equal(result.ok, false);
  assert.equal(spawned, 0, 'a worker was spawned for an unresolvable item');
  assert.match(result.error, /refusing to resolve a ticket outside the configured repository/);
});

test('the gate is handed the OBSERVED diffstat, so its evidence rules can fire', async () => {
  // The wiring #63 is about. `runGate` takes no default for `diffstat`, so a runner that omits
  // it disables `evidence_weakened` and `instrument_modified` — and the verdict then says
  // nothing about the two rules most likely to matter, while reading exactly like a pass.
  const repo = repoWithCommit();
  let handed;

  const result = await executeWork({
    ref: 'delete some tests',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T120200Z',
    spawn: stubSpawn((argv, opts) => {
      // The worker's "work": two lines out of a test file and nothing else.
      writeFileSync(join(repo, 'test', 'a.test.js'), 'test one\n');
      return { exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath };
    }),
    gate: (args) => {
      handed = args;
      return { pass: true, findings: [], unverified: [], blocked_reason: null };
    },
    report: () => null,
  });

  assert.ok(result.ok, result.error);
  assert.ok(Array.isArray(handed.diffstat), 'the gate was handed no diffstat at all');
  const test1 = handed.diffstat.find((e) => e.file === 'test/a.test.js');
  assert.equal(test1.deleted, 2);
  assert.deepEqual(handed.touched, ['test/a.test.js']);
  assert.equal(handed.repoRoot, repo);
});

test('the real gate runs against the real tree and its verdict is the result', async () => {
  // NOT the injected gate. The stub above proves the wiring; this proves the wiring reaches a
  // gate that decides. `evidence_weakened` on two deleted test lines is the finding the gated
  // n=3 saw fire 3/3, so this is the one rule with a prospective record behind it.
  //
  // THE VERIFY COMMAND HAS TO RUN THE SUITE, and the first draft of this test got that wrong in
  // a way worth keeping: `verify: {test: 'true'}` exits 0 and matches no runner, so
  // `checkEvidence`'s conjunct 2 found nothing the green rests on and correctly declined. The
  // rule takes two separately-observed conjuncts precisely so deleted test lines in a repo whose
  // green does NOT depend on the suite is ordinary work rather than a finding. So the command
  // here names a real runner — `node --test` on a directory with no test files exits 0.
  const repo = repoWithCommit();

  const result = await executeWork({
    ref: 'delete some tests',
    config: { ...CONFIG, verify: { test: 'node --test nonexistent-dir 2>/dev/null || true' } },
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T120300Z',
    spawn: stubSpawn((argv, opts) => {
      writeFileSync(join(repo, 'test', 'a.test.js'), 'test one\n');
      return { exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath };
    }),
    report: () => null,
  });

  assert.ok(result.ok, result.error);
  assert.equal(result.gate.pass, false);
  assert.ok(
    result.gate.findings.some((f) => f.rule === 'evidence_weakened'),
    `expected evidence_weakened, got ${result.gate.findings.map((f) => f.rule).join(', ')}`,
  );
});

test('a worker killed at the wall cap is reported as killed and does not pass', async () => {
  // §2.8's recorded kill-switch failure: a killed run scored as a completed one. The verdict
  // has to distinguish "finished and was graded" from "was stopped mid-sentence".
  const repo = repoWithCommit();

  const result = await executeWork({
    ref: 'hang forever',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T120400Z',
    spawn: stubSpawn((argv, opts) => ({
      exit: null, killed: true, signal: 'SIGTERM', wall_ms: 1500000, log: opts.logPath,
    })),
    report: () => null,
  });

  assert.equal(result.worker.killed, true);
  assert.equal(result.gate.pass, false);
  assert.ok(
    result.gate.findings.some((f) => /killed|wall cap/i.test(f.detail)),
    'a killed worker produced no finding naming the kill',
  );
});

test('a worker that exhausted its budget is not a graded worker', async () => {
  // MEASURED ON THE FIRST REAL JIRA RUN, 2026-08-01, and it is the reason this test exists rather
  // than a hypothesis about one. TARS-1351 spent the whole `--max-budget-usd 8` cap and the CLI
  // terminated it mid-flight. `worker.log` said so in four separate fields — `is_error: true`,
  // `subtype: error_max_budget_usd`, `terminal_reason: budget_exhausted`, and an `errors` array —
  // and `gate: PASS` came back with zero findings on a run that had been cut off.
  //
  // WHY THE EXISTING WALL-CAP GUARD DOES NOT COVER THIS, which is the whole defect. `killed` is
  // set by Alfred's own `setTimeout` (`spawnWorker`), so it means "WE stopped it". A budget kill
  // happens INSIDE the child, which then exits NORMALLY: exit 0, no signal, `killed: false`. So
  // the one branch that distinguishes a stopped worker from a finished one is false exactly when
  // the child stopped for a reason Alfred did not cause. The stub below therefore returns the
  // measured shape — `exit: 0, killed: false` — and NOT a kill, because a stub that set
  // `killed: true` would pass against the old code and pin nothing.
  //
  // §2.8's principle, one case wider: from the tree's side, a worker that ran out of money looks
  // exactly like one that chose to stop. The tree here is deliberately CLEAN and the config has
  // no verify commands, so no other rule can fire and the finding under test is the only thing
  // that can turn the verdict — if this passes for some unrelated reason, it is not measuring.
  const repo = repoWithCommit();

  const result = await executeWork({
    ref: 'audit every handler then write the doc',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T120450Z',
    spawn: stubSpawn((argv, opts) => {
      // The real payload, trimmed to the fields that carry the outcome. Written to the log the
      // run will read, because that file is the only place the reason exists — the exit code is
      // 0 and carries none of it.
      writeFileSync(
        opts.logPath,
        `${JSON.stringify({
          is_error: true,
          subtype: 'error_max_budget_usd',
          terminal_reason: 'budget_exhausted',
          errors: ['Reached maximum budget ($8)'],
          session_id: 'b6ec833a-cc3c-4c5c-9abe-17c7be4e53ae',
          total_cost_usd: 8.022070500000003,
          num_turns: 71,
          type: 'result',
        })}\n`,
      );
      return { exit: 0, killed: false, signal: null, wall_ms: 544109, log: opts.logPath };
    }),
    report: () => null,
  });

  assert.ok(result.ok, result.error);
  // The worker's own report of itself stays what it was: this is not a kill, and relabelling it
  // as one would trade a true finding for a false detail.
  assert.equal(result.worker.killed, false);
  assert.equal(result.gate.pass, false, 'a budget-exhausted run was graded as a pass');
  const finding = result.gate.findings.find((f) => f.rule === 'check_failed');
  assert.ok(
    finding,
    `expected check_failed, got ${result.gate.findings.map((f) => f.rule).join(', ') || '(none)'}`,
  );
  // THE REASON, not just the rule. An operator reading `check_failed` acts differently on "the
  // test suite failed" than on "it ran out of money" — the first is the worker's work, the second
  // is the cap. A finding that fires with the wrong detail sends them at the wrong thing.
  //
  // MATCHED ON THE REASON TOKEN, not on the word "budget", and that is mutation-scored rather
  // than stylistic: `/budget/i` SURVIVED a mutant that replaced `${terminal.reason}` with a
  // generic string, because the `errors` prose this detail also quotes happens to contain
  // "maximum budget". The loose pattern was being satisfied by the vendor's English instead of by
  // the field the finding is supposed to carry.
  assert.match(
    finding.detail,
    /budget_exhausted/,
    `check_failed fired without naming the terminal reason: ${finding.detail}`,
  );
  // And the operator-facing numbers, which are the two things that make the finding actionable:
  // what it cost before it stopped, and how far it got.
  // `8.022071`, not `8.0220705`: the detail rounds to 6dp, which is the precision the record and
  // the vendor already agree at. Asserted at that precision rather than on the raw float, because
  // pinning `8.022070` here would be pinning a rounding bug that does not exist.
  assert.match(finding.detail, /\$8\.022071\b/, `the detail omits what the run spent: ${finding.detail}`);
  assert.match(finding.detail, /71 turns/, `the detail omits how far it got: ${finding.detail}`);
});

test('a terminal reason alone stops the run, without waiting for is_error', async () => {
  // A SECOND PROPOSITION, split out because it is not the one above. Mutation-scored: "read only
  // `is_error` and ignore `terminal_reason`/`subtype`" SURVIVED the budget test, because that
  // fixture is the measured payload and carries BOTH. A guard resting on one field is one vendor
  // rename away from silently passing every truncated run again, and the failure direction is the
  // one this whole finding exists to close.
  //
  // The fixture is therefore the payload MINUS `is_error` — deliberately not a shape I have
  // measured, and that is the point of it: the claim under test is that the check does not depend
  // on which of the three fields survives, so the fixture has to remove one.
  const repo = repoWithCommit();

  const result = await executeWork({
    ref: 'work until something stops you',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T120455Z',
    spawn: stubSpawn((argv, opts) => {
      writeFileSync(
        opts.logPath,
        `${JSON.stringify({
          terminal_reason: 'context_exhausted',
          session_id: 'e0de647e-0000-0000-0000-000000000000',
          total_cost_usd: 3.5,
          num_turns: 40,
          type: 'result',
        })}\n`,
      );
      return { exit: 0, killed: false, signal: null, wall_ms: 200000, log: opts.logPath };
    }),
    report: () => null,
  });

  assert.ok(result.ok, result.error);
  assert.equal(result.gate.pass, false, 'a run terminated for a non-budget reason was graded a pass');
  const finding = result.gate.findings.find((f) => f.rule === 'check_failed');
  assert.ok(finding, `expected check_failed, got ${result.gate.findings.map((f) => f.rule).join(', ') || '(none)'}`);
  // The reason is carried VERBATIM rather than mapped to a category. `context_exhausted` is not a
  // budget kill and must not be reported as one — a finding that renames what happened is how an
  // operator comes to raise the wrong cap.
  assert.match(finding.detail, /context_exhausted/, `the reason was not carried: ${finding.detail}`);
});

test('a clean run is NOT reported as terminated — the guard can tell the difference', async () => {
  // THE FALSIFIER for both tests above, and it is not hypothetical: a guard that raised
  // `check_failed` on every log would satisfy each of them perfectly while failing every honest
  // run. This is the `unfalsifiable_conjunct` lesson — "it has never returned true" and "it cannot
  // return true" are different claims, and only this test separates them.
  //
  // The payload is a SUCCESSFUL result, which is the shape the overwhelming majority of runs
  // write: `is_error: false`, `subtype: success`.
  const repo = repoWithCommit();

  const result = await executeWork({
    ref: 'a job that finishes',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T120458Z',
    spawn: stubSpawn((argv, opts) => {
      writeFileSync(
        opts.logPath,
        `${JSON.stringify({
          is_error: false,
          subtype: 'success',
          stop_reason: 'end_turn',
          session_id: 'aaaaaaaa-0000-0000-0000-000000000000',
          total_cost_usd: 0.42,
          num_turns: 9,
          type: 'result',
        })}\n`,
      );
      return { exit: 0, killed: false, signal: null, wall_ms: 30000, log: opts.logPath };
    }),
    report: () => null,
  });

  assert.ok(result.ok, result.error);
  assert.deepEqual(
    result.gate.findings.filter((f) => /did not finish/.test(f.detail ?? '')),
    [],
    'a completed run was reported as terminated',
  );
  assert.equal(result.gate.pass, true, `a clean run did not pass: ${JSON.stringify(result.gate.findings)}`);
});

test('a real successful run is NOT reported as terminated — terminal_reason is "completed", not "success"', async () => {
  // MEASURED ON THE FIRST REAL JIRA RUN, TARS-1351, 2026-08-01. The falsifier above never
  // exercised this shape because its fixture omits `terminal_reason` entirely, so `reason` falls
  // through to `subtype` and happens to equal `'success'`. The real CLI writes BOTH fields on a
  // genuine finish, and `terminal_reason` is `'completed'` — a different string from `subtype`,
  // preferred by the `??` in terminalErrorFromWorkerLog. The old exemption only recognised the
  // literal string `'success'`, so a fully successful, verified 58-turn run was reported as
  // `check_failed` with detail "the worker did not finish: the CLI reported completed after
  // $7.488232 and 58 turns" — a false positive on a clean tree.
  const repo = repoWithCommit();

  const result = await executeWork({
    ref: 'a job that finishes, reported the way the real CLI reports it',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260801T033853Z',
    spawn: stubSpawn((argv, opts) => {
      writeFileSync(
        opts.logPath,
        `${JSON.stringify({
          is_error: false,
          terminal_reason: 'completed',
          subtype: 'success',
          stop_reason: 'end_turn',
          session_id: 'e0de647e-0000-0000-0000-000000000000',
          total_cost_usd: 7.488232499999999,
          num_turns: 58,
          type: 'result',
        })}\n`,
      );
      return { exit: 0, killed: false, signal: null, wall_ms: 540000, log: opts.logPath };
    }),
    report: () => null,
  });

  assert.ok(result.ok, result.error);
  assert.deepEqual(
    result.gate.findings.filter((f) => /did not finish/.test(f.detail ?? '')),
    [],
    'a completed run reporting terminal_reason:"completed" was reported as terminated',
  );
  assert.equal(result.gate.pass, true, `a clean run did not pass: ${JSON.stringify(result.gate.findings)}`);
});

test('the argv handed to the worker comes from the router and carries the composed prompt', async () => {
  // §2.1 step 4. Asserted on the argv the spawn actually received, because a router called and
  // then ignored is the same as no router — and the flags a run used have to be recoverable
  // from the record rather than from shell history.
  const repo = repoWithCommit();
  let argv;

  await executeWork({
    ref: 'make the retry backoff configurable',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T120500Z',
    spawn: stubSpawn((a, opts) => {
      argv = a;
      return { exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath };
    }),
    report: () => null,
  });

  assert.equal(argv[0], '-p');
  assert.ok(argv[1].includes('make the retry backoff configurable'), 'the prompt is not the ticket');
  assert.ok(argv[1].includes('.alfred/ac-map.json'), 'the ac_map contract did not reach the worker');
  assert.ok(!argv.includes('--max-budget-usd'), 'measured to freeze cache-breakpoint advancement — see lib/router.mjs');
  assert.ok(argv.includes('--fallback-model'), 'an unattended tick has no fallback');
  // The standing rules travel as a system prompt, not folded into the ticket text.
  const at = argv.indexOf('--append-system-prompt');
  assert.ok(at !== -1, 'the standing rules were not handed over');
  assert.match(argv[at + 1], /false premise/i);
});

test('executeWork returns a result and does not throw on a broken repo root', async () => {
  // Same rule as resolveItem and loadConfig: an unusable input is a RESULT, because throwing
  // turns it into a crash inside whatever is looping over ticks at 3am.
  const result = await executeWork({
    ref: 'do something',
    config: CONFIG,
    repoRoot: join(mktemp('gone'), 'not-a-repo'),
    runRoot: mktemp('runs'),
    stamp: '20260731T120600Z',
    spawn: stubSpawn(() => ({ exit: 0, killed: false, signal: null, wall_ms: 1, log: null })),
    report: () => null,
  });
  assert.equal(typeof result.ok, 'boolean');
});

// --- THE RECORD: the run that spent $1.07 and left no trace of having done so ------------

test('a completed run produces an accounting record from the transcript its worker wrote', async () => {
  // THE DEFECT THIS CLOSES. `executeWork` shipped with `report: null` and a comment saying the
  // record "needs a transcript path this slice does not yet know how to find". Consequence,
  // measured: the first real run cost $1.0671732 and produced no record at all. The path was
  // always computable — the CLI prints its own `session_id` into the log we told it to write,
  // and we chose the cwd — so what was missing was the wiring, not the information.
  //
  // NOTHING IS INJECTED AT THE REPORTING SEAM. `report` keeps its real default here; the only
  // substitution is `home`, which is an environment fact rather than a module boundary. So the
  // log is really parsed, the path is really composed, the transcript is really read and priced,
  // and a break anywhere along that chain fails this test — which is the whole lesson of the
  // three defects a suite green on all of them could not see.
  const repo = repoWithCommit();
  const home = mktemp('home');
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  // The transcript where the CLI would have filed it, in the layout measured on this machine:
  // realpath'd cwd, every non-alphanumeric character a dash.
  const projectDir = join(home, '.claude', 'projects', realpathSync(repo).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-31T18:50:38.000Z',
      message: {
        model: 'claude-sonnet-5',
        id: 'msg_recorded',
        usage: { input_tokens: 1000, output_tokens: 200 },
      },
    }) + '\n',
  );

  const result = await executeWork({
    ref: 'share one retry helper across the channels',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T185038Z',
    home,
    // Fixes the id Step 4 generates to the one the fixture's transcript was filed under —
    // exactly what `--session-id` being CLI-honored means in practice: the id is known before
    // the worker runs, not parsed back out afterward.
    newSessionId: () => sessionId,
    spawn: stubSpawn((argv, opts) => {
      // The real `--output-format json` result shape. Written to the log the runner named,
      // because reading it back from there is the step under test.
      writeFileSync(opts.logPath, JSON.stringify({
        type: 'result',
        session_id: sessionId,
        total_cost_usd: 0.0042,
        num_turns: 9,
      }));
      return { exit: 0, killed: false, signal: null, wall_ms: 1234, log: opts.logPath };
    }),
  });

  assert.equal(result.ok, true);
  assert.ok(result.record, 'a completed run produced no record');
  assert.equal(result.record.ok, true, `record failed: ${result.record.error}`);

  // The numbers came from the transcript, which is the only place they exist.
  assert.equal(result.record.tokens.by_model['claude-sonnet-5'].input, 1000);
  assert.ok(result.record.cost.total_usd > 0, 'a priced record reported no cost');

  // The joins a dashboard reads. A record that cannot be tied back to its session or its work
  // item is a number with no row to sit in.
  assert.equal(result.record.session.id, sessionId);
  assert.equal(result.record.session.cwd, repo);
  assert.equal(result.record.work.item_id, result.item.id);
  assert.equal(result.record.gate.pass, result.gate.pass);
});

test('the vendor CLI cost and our own are BOTH recorded, because agreement is the evidence', async () => {
  // Measured on the real run: vendor `total_cost_usd` 1.0671731999999998, ours from the price
  // table 1.067173. Two independent sources for one number, and their agreeing is the only
  // evidence the copied table is right — [[project-otel-bedrock-verified]] found that a
  // CLI-reported CEILING was not ground truth, so a second source is checked, never trusted.
  //
  // Kept as a separate field rather than reconciled into one: collapsing them would destroy the
  // comparison, and a silently preferred winner is the shape `seatEnvFrom` refuses for seats.
  const repo = repoWithCommit();
  const home = mktemp('home');
  const sessionId = 'ffffffff-1111-2222-3333-444444444444';
  const projectDir = join(home, '.claude', 'projects', realpathSync(repo).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-31T18:50:38.000Z',
      message: { model: 'claude-sonnet-5', id: 'm1', usage: { input_tokens: 1000 } },
    }) + '\n',
  );

  const result = await executeWork({
    ref: 'do the thing',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T185039Z',
    home,
    newSessionId: () => sessionId,
    spawn: stubSpawn((argv, opts) => {
      writeFileSync(opts.logPath, JSON.stringify({ session_id: sessionId, total_cost_usd: 7.5 }));
      return { exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath };
    }),
  });

  assert.equal(result.record.cost.vendor_usd, 7.5, 'the vendor figure was dropped');
  assert.ok(result.record.cost.total_usd !== 7.5, 'ours was replaced by the vendor figure');
});

test('the id Step 4 generates is the SAME id the worker receives and the reporter files under', async () => {
  // The whole point of pre-generating the id: one value, two independent confirmations. If the
  // worker got a different id than the report was built with, `--session-id` being CLI-honored
  // would buy nothing — the reporter would be back to parsing the log to find out what happened.
  const repo = repoWithCommit();
  const home = mktemp('home');
  const knownId = 'known-one-id-two-uses-7777-888888888888';
  let argvSeen;

  const result = await executeWork({
    ref: 'do the thing',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T185039Z',
    home,
    newSessionId: () => knownId,
    spawn: stubSpawn((argv, opts) => {
      argvSeen = argv;
      writeFileSync(opts.logPath, JSON.stringify({ session_id: knownId, total_cost_usd: 0.01 }));
      return { exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath };
    }),
  });

  const at = argvSeen.indexOf('--session-id');
  assert.ok(at !== -1, '--session-id never reached the worker argv');
  assert.equal(argvSeen[at + 1], knownId, 'the worker got a different id than the one generated');
  assert.equal(result.record.session.id, knownId, 'the report was filed under a different id');
});

test('a transcript that is not where the formula says is a named gap, not a silent zero', async () => {
  // The failure that matters: the formula is a vendor convention, so it can go stale under us.
  // When it does, every run reports as unmeasurable — and the record must SAY that rather than
  // report $0.00, which is plottable and false (the never-zero-fill rule).
  //
  // The KNOWN id, not the log's, is what the path gets composed from — `run.mjs` generates one at
  // Step 4 whether or not the worker ever echoes it back correctly, so a stale-formula failure now
  // surfaces under the id Alfred actually asked for.
  const repo = repoWithCommit();
  const knownId = 'known-no-transcript-1111-2222-333333333333';
  const result = await executeWork({
    ref: 'do the thing',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T185040Z',
    home: mktemp('empty-home'),
    newSessionId: () => knownId,
    spawn: stubSpawn((argv, opts) => {
      writeFileSync(opts.logPath, JSON.stringify({ session_id: 'no-such-session' }));
      return { exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath };
    }),
  });

  assert.equal(result.ok, true, 'an unreadable transcript failed the run it was reporting on');
  assert.equal(result.record.ok, false);
  assert.equal(result.record.cost.total_usd, null, 'an unread run was priced at zero');
  assert.match(result.record.error, new RegExp(knownId), 'the error does not name what it looked for');
});

test('a worker log with no session id still composes a path, from the id Alfred generated', async () => {
  // Superseded by `--session-id` being CLI-honored: `executeWork` now generates the id at Step 4
  // and hands it to BOTH the worker and the reporter, so "no session id anywhere" is no longer
  // reachable through this path — there is always a known one. What a failed launch (valid JSON,
  // no id in the log) now degrades to is a MISMATCH-proof, not a blackout: the known id still
  // names a transcript, and finding none there is an ordinary unreadable-transcript gap, not the
  // wrong-session defect `<project-dir>/undefined.jsonl` used to risk.
  const repo = repoWithCommit();
  const knownId = 'known-no-log-id-4444-5555-666666666666';
  const result = await executeWork({
    ref: 'do the thing',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T185041Z',
    home: mktemp('home'),
    newSessionId: () => knownId,
    spawn: stubSpawn((argv, opts) => {
      // An error result: valid JSON, no id. The shape a failed launch actually leaves.
      writeFileSync(opts.logPath, JSON.stringify({ type: 'result', is_error: true }));
      return { exit: 1, killed: false, signal: null, wall_ms: 1, log: opts.logPath };
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.record.ok, false);
  assert.equal(result.record.cost.total_usd, null);
  assert.ok(
    !/undefined\.jsonl/.test(result.record.error ?? ''),
    `composed a path from a missing id: ${result.record.error}`,
  );
  assert.match(result.record.error, new RegExp(knownId), 'the composed path did not use the known id');
});

test('reporting cannot fail the run: a reporter that throws is caught and named', async () => {
  // The sidecar rule, at the one seam where it is reachable. Work that landed, a gate that
  // graded it, and then an exception in the accounting must not turn a successful tick into a
  // refusal — `main` reads a throw as exit 2, which a scheduler retries at full price.
  const repo = repoWithCommit();
  const result = await executeWork({
    ref: 'do the thing',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260731T185042Z',
    report: () => {
      throw new Error('the reporter exploded');
    },
    spawn: stubSpawn((argv, opts) => ({
      exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath,
    })),
  });

  assert.equal(result.ok, true, 'a broken reporter failed the run it was reporting on');
  assert.equal(result.record, null);
  assert.match(result.record_error, /the reporter exploded/);
});

// --- step 7b: the record REACHES DISK ---
//
// The fifth instance of this project's recurring defect family (#63, #69, #72, #73): an
// instrument built whose output nobody reads. `buildRecord` computes `cost.by_model`,
// `tokens.peak_context`, `subagents[]`, `gaps[]`, `gate.findings[]` and the suite stamp on every
// production run; `executeWork` returned it in memory, `bin/alfred` printed two lines of it, and
// the process exited. Measured before the fix: a real run dir held `source.json` and
// `worker.log` and nothing else, while the eval path's records — the ones that made #70..#73
// findable at all — are hand-written by the arm C runner and do not exist for `alfred work`.
//
// THREE SEPARATE PROPOSITIONS, deliberately not one. §"unfalsifiable conjunct": a single
// assertion over a written file would pass on a writer that persisted an empty object, and a
// single pass boolean cannot say which half held.

test('the record is written to the run directory, not just returned', async () => {
  const repo = repoWithCommit();
  const runRoot = mktemp('runs');

  const result = await executeWork({
    ref: 'persist the record',
    config: CONFIG,
    repoRoot: repo,
    runRoot,
    stamp: '20260801T090000Z',
    spawn: stubSpawn((argv, opts) => ({
      exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath,
    })),
    report: () => ({ ok: true, error: null, gaps: [], cost: { total_usd: 1.25 } }),
  });

  assert.ok(result.ok, result.error);
  const path = join(result.run_dir, RECORD_FILENAME);
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(onDisk.cost.total_usd, 1.25, 'the file exists but does not carry the record');
  assert.equal(result.record_path, path, 'the run does not say where it wrote the record');
});

test('what reaches disk is the WHOLE record, not a summary of it', async () => {
  // The defect was not "no file" — it was that the only surviving channel was
  // `reportRecord`'s two console lines, which keep `total_usd`, `vendor_usd`, `ok` and the gap
  // codes and drop everything else. A writer that persisted the printed subset would leave the
  // audit gap exactly where it was, so this asserts on the fields the console throws away.
  const repo = repoWithCommit();

  const full = {
    ok: true,
    error: null,
    gaps: [{ code: 'single-context', detail: 'no subagents' }],
    tokens: { by_model: { 'anthropic.claude-sonnet-5': { input: 10 } }, peak_context: 4242 },
    subagents: [{ agent_id: 'a1', by_model: {} }],
    cost: { total_usd: 2.5, vendor_usd: 2.5, by_model: { 'anthropic.claude-sonnet-5': 2.5 } },
    gate: { pass: false, findings: [{ rule: 'evidence_weakened' }], unverified: [] },
    suite: { suite_version: '2026-08-01.1', suite_digest: 'abc' },
  };

  const result = await executeWork({
    ref: 'persist all of it',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260801T090100Z',
    spawn: stubSpawn((argv, opts) => ({
      exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath,
    })),
    report: () => full,
  });

  const onDisk = JSON.parse(readFileSync(join(result.run_dir, RECORD_FILENAME), 'utf8'));
  assert.equal(onDisk.tokens.peak_context, 4242, 'peak_context was dropped');
  assert.deepEqual(onDisk.gate.findings, [{ rule: 'evidence_weakened' }], 'the findings were dropped');
  assert.deepEqual(onDisk.gaps, [{ code: 'single-context', detail: 'no subagents' }], 'the gaps were dropped');
  assert.equal(onDisk.suite.suite_digest, 'abc', 'the suite stamp was dropped');
  assert.equal(onDisk.subagents.length, 1, 'the subagents were dropped');
});

test('a record that cannot be written does not fail the run it was recording', async () => {
  // The same sidecar rule the reporter already obeys, at the new seam. A run that landed and
  // was graded must not become exit 2 — which a scheduler retries at full price — because the
  // accounting could not reach disk. Provoked by making the path unwritable: the run dir is
  // replaced with a FILE, so `writeFileSync` into it raises ENOTDIR.
  const repo = repoWithCommit();
  const runRoot = mktemp('runs');

  const result = await executeWork({
    ref: 'unwritable',
    config: CONFIG,
    repoRoot: repo,
    runRoot,
    stamp: '20260801T090200Z',
    spawn: stubSpawn((argv, opts) => {
      // After source.json is written and the worker "ran", make the directory un-writable by
      // turning it into a file. Nothing later in the run needs to write there except the record.
      rmSync(opts.runDir, { recursive: true, force: true });
      writeFileSync(opts.runDir, 'not a directory\n');
      return { exit: 0, killed: false, signal: null, wall_ms: 1, log: null };
    }),
    report: () => ({ ok: true, error: null, gaps: [], cost: { total_usd: 3 } }),
  });

  assert.equal(result.ok, true, 'an unwritable record failed the run it was recording');
  assert.ok(result.record, 'the record was discarded because it could not be written');
  assert.equal(result.record_path, null, 'claimed a path it did not write');
  // ITS OWN FIELD. Joining this onto `record_error` made `reportRecord` print "FAILED to build"
  // for a record that built fine and suppress the cost line with it — see the cli test.
  assert.match(result.record_write_error, /ENOTDIR|not a directory|could not write/i);
  assert.equal(result.record_error, null, 'blamed the reporter for a filesystem failure');
});

// --- step 7c: the record reaches the telemetry sink ---
//
// Same injection pattern as spawn/gate/report: `sync` defaults to the real `syncRecord`
// (exercised for real in telemetry.test.mjs against a fixture clone), and here a stub proves
// the wiring — that `cfg.telemetry` and the built record actually reach it, and that a throw
// from it cannot fail the run — without touching git.

test('cfg.telemetry reaches syncFn unchanged, alongside the record just built', async () => {
  const repo = repoWithCommit();
  const telemetry = { remote: 'https://example.invalid/x.git', dir: '/tmp/does-not-matter' };
  let received = null;

  const result = await executeWork({
    ref: 'sync wiring',
    config: { ...CONFIG, telemetry },
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T090000Z',
    spawn: stubSpawn((argv, opts) => ({
      exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath,
    })),
    report: () => ({ ok: true, error: null, gaps: [], cost: { total_usd: 1 } }),
    sync: (args) => {
      received = args;
      return { synced: true, path: '/tmp/fake' };
    },
  });

  assert.ok(received, 'syncFn was never called');
  assert.deepEqual(received.telemetry, telemetry, 'cfg.telemetry did not reach syncFn unchanged');
  assert.equal(received.record, result.record, 'syncFn did not receive the same record the run built');
  assert.equal(received.runDir, result.run_dir);
  assert.deepEqual(result.sync, { synced: true, path: '/tmp/fake' });
});

test('a run with no telemetry configured still calls syncFn, with telemetry: null', () => {
  return (async () => {
    const repo = repoWithCommit();
    let received = 'not called';

    const result = await executeWork({
      ref: 'no telemetry configured',
      config: CONFIG,
      repoRoot: repo,
      runRoot: mktemp('runs'),
      stamp: '20260802T090100Z',
      spawn: stubSpawn((argv, opts) => ({
        exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath,
      })),
      report: () => ({ ok: true, error: null, gaps: [], cost: { total_usd: 1 } }),
      sync: (args) => {
        received = args.telemetry;
        return { synced: false, reason: 'telemetry_not_configured' };
      },
    });

    assert.equal(received, null, 'a config with no telemetry block must reach syncFn as null, not undefined-and-skipped');
    assert.deepEqual(result.sync, { synced: false, reason: 'telemetry_not_configured' });
  })();
});

test('syncing cannot fail the run: a syncFn that throws is caught and named on its own field', async () => {
  // The same sidecar rule as record_error/record_write_error, at the third seam. A sink outage
  // must read as "the sync failed", never as "the run failed" — and never blamed on report_error
  // or record_write_error, which is why this asserts a field of its own rather than reusing
  // either of those.
  const repo = repoWithCommit();
  const result = await executeWork({
    ref: 'sync explodes',
    config: { ...CONFIG, telemetry: { remote: 'https://example.invalid/x.git', dir: '/tmp/x' } },
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T090200Z',
    spawn: stubSpawn((argv, opts) => ({
      exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath,
    })),
    report: () => ({ ok: true, error: null, gaps: [], cost: { total_usd: 1 } }),
    sync: () => {
      throw new Error('the sink is unreachable');
    },
  });

  assert.equal(result.ok, true, 'a broken syncFn failed the run it was reporting on');
  assert.ok(result.record, 'the record was discarded because syncing threw');
  assert.equal(result.record_error, null, 'blamed the reporter for a sync failure');
  assert.equal(result.record_write_error, null, 'blamed the record write for a sync failure');
  assert.match(result.sync.reason, /sync_threw.*the sink is unreachable/);
});

test('when there is no record to sync, syncFn is never called at all', async () => {
  // Step 7c reads `if (record)` — a run whose reporter itself threw has nothing to sync, and
  // calling syncFn with `record: null` would either need its own null-guard or silently sync
  // nothing meaningful. Asserting syncFn is uncalled pins which of those two this is.
  const repo = repoWithCommit();
  let called = false;

  const result = await executeWork({
    ref: 'nothing to sync',
    config: { ...CONFIG, telemetry: { remote: 'https://example.invalid/x.git', dir: '/tmp/x' } },
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T090300Z',
    spawn: stubSpawn((argv, opts) => ({
      exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath,
    })),
    report: () => {
      throw new Error('the reporter exploded');
    },
    sync: () => {
      called = true;
      return { synced: true };
    },
  });

  assert.equal(result.record, null);
  assert.equal(called, false, 'syncFn ran with nothing built to sync');
  assert.equal(result.sync, null);
});
