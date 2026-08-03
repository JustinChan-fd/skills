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
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { SEATS, normalizeModelId } from '../lib/models.mjs';
import { SOURCE_FILENAME } from '../lib/item.mjs';
import { ARMS } from '../lib/gaps.mjs';
import { PREFLIGHT_REFUSALS } from '../lib/preflight.mjs';
import { ARM, RECORD_FILENAME } from '../lib/run.mjs';
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

// THE BACKSTOP CAP FOR THE WATCH TESTS, AND WHY IT IS NOT 20 SECONDS ANY MORE.
//
// Three of the B2 watch tests below want the WATCH to stop the child; the wall cap is only there so
// a broken watch fails the run instead of hanging the suite. At `wallCapMs: 20000` the top one
// failed roughly once per full-suite run and passed every time in isolation, which read like a
// timing margin and was not. MEASURED, with a diagnostic that printed what the watch had actually
// seen at the moment the cap fired:
//
//   killed: true, signal: SIGTERM, wall_ms: 20003, logExists: true, logLen: 0
//
// Zero bytes in twenty seconds, from a `node -e` whose FIRST STATEMENT is a write. The event loop
// was healthy — the cap itself fired 3ms late — so the 25ms poll had run some 800 times against a
// file that was still empty. The child had not reached its first line.
//
// Then measuring `node -e "write"` time-to-first-byte directly, against the same file-fd stdio, while
// a full suite ran: 8 concurrent → 104ms max; 16 → 207ms; 24 → **26,060ms**. At 24 the numbers
// clustered inside 75ms of each other (min 25985, max 26060), so all of them were blocked on one
// shared resource and released together rather than scheduled independently. A later repeat of the
// same n=24 came back at 126ms. The cliff tracks TOTAL MACHINE LOAD, not this suite's concurrency.
//
// SO A THRESHOLD CANNOT BE DERIVED, and that is the point: process startup latency here is unbounded
// under contention, so there is no "safe" cap, only one far enough from the interesting number that
// the test asks its own question. 120s is ~4.6x the worst startup observed. It costs nothing on a
// passing run — the watch fires in 54ms idle, 108ms under CPU load — and a genuinely broken watch
// still fails rather than hanging forever.
//
// THE WALL CAP'S OWN TESTS ARE NOT TOUCHED. They use `wallCapMs: 400` against a child that only
// sleeps, and they ASSERT the kill, so slow startup can only ever make them more true. Raising the
// number here weakens no coverage of the cap; it stops three tests about the WATCH from being
// silently converted into tests about how fast this machine can fork node.
const WATCH_BACKSTOP_MS = 120_000;

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

// --- A5: the arm reaches the record ------------------------------------------
//
// WHY THE ARM IS A CONSTANT IN `run.mjs` AND NOT A CONFIG KEY. The arm names the CODE that
// performed the run. A repo config saying `alfred-thin` while the multi-agent runner executed
// would be a lie the record carries forever, and configs outlive the code they were written
// against — webtarsthree's has already survived two rewrites of this runner. So `executeWork`
// states its own identity, and the only caller allowed to override it is Phase C's backfill,
// which is reconstructing a run some OTHER code performed.

test('A5: executeWork stamps its own arm onto the record it asks for', async () => {
  // The wiring assertion. `buildRecord` accepting `provenance` proves nothing about a live run
  // being labelled: `executeWork` composes the reporter's argument object itself, and a field
  // dropped there is the computed-and-discarded defect this project keeps finding in its own
  // instruments (#63, #69, #72, #73).
  const repo = repoWithCommit();
  let seen = null;

  await executeWork({
    ref: 'stamp the arm',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T100000Z',
    spawn: stubSpawn((argv, opts) => ({
      exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath,
    })),
    report: (args) => {
      seen = args;
      return { ok: true, error: null, gaps: [], cost: { total_usd: 1 } };
    },
  });

  assert.ok(seen, 'the reporter was never called');
  assert.equal(seen.provenance.arm, ARM, 'the runner did not tell the reporter which arm it is');
  assert.equal(seen.provenance.backfilled, false, 'a live run is not a backfill');
  // ASSERTED AGAINST THE IMPORTED CONSTANT, not a literal. A `'alfred-thin'` typed here would
  // keep passing while ARM moved underneath it — the #67 drift shape, in the field whose whole
  // purpose is telling two versions of this runner apart.
  assert.ok(ARMS.includes(ARM), `ARM ${JSON.stringify(ARM)} is not in the closed set ${ARMS.join(', ')}`);
});

test('A5: the arm is NOT read from config — a stale config cannot mislabel the code that ran', async () => {
  // The distinguishing assertion, and the reason this is a constant. A config key would let a
  // record claim an arm its code never was. Here the config asserts the wrong arm loudly and is
  // ignored.
  const repo = repoWithCommit();
  let seen = null;

  await executeWork({
    ref: 'config lies about the arm',
    config: { ...CONFIG, provenance: { arm: 'single-agent' }, arm: 'single-agent' },
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T100100Z',
    spawn: stubSpawn((argv, opts) => ({
      exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath,
    })),
    report: (args) => {
      seen = args;
      return { ok: true, error: null, gaps: [], cost: { total_usd: 1 } };
    },
  });

  assert.equal(seen.provenance.arm, ARM, 'a config key overrode the running code’s own identity');
  assert.notEqual(seen.provenance.arm, 'single-agent');
});

test('A5: an explicit provenance argument wins — the seam Phase C backfills through', async () => {
  // Phase C reconstructs four records from historical transcripts, produced by code that is not
  // this code. Without this override the backfill would either stamp every historical run as the
  // current arm — silently merging three cohorts into one — or hand-write JSON, which the plan
  // refuses because a hand-written record proves nothing about the path real records take.
  const repo = repoWithCommit();
  let seen = null;

  await executeWork({
    ref: 'backfill',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T100200Z',
    spawn: stubSpawn((argv, opts) => ({
      exit: 0, killed: false, signal: null, wall_ms: 1, log: opts.logPath,
    })),
    report: (args) => {
      seen = args;
      return { ok: true, error: null, gaps: [], cost: { total_usd: 1 } };
    },
    provenance: { arm: 'single-agent', backfilled: true, notes: 'rescued transcript' },
  });

  assert.equal(seen.provenance.arm, 'single-agent');
  assert.equal(seen.provenance.backfilled, true);
  assert.equal(seen.provenance.notes, 'rescued transcript');
});

// --- B2: STOPPING A WORKER IN FLIGHT, on what it said in its first turn ---
//
// WHY THIS IS A REAL CHILD AND NOT A STUB. The whole mechanism is a race between a file being
// appended to by one process and polled by another, and a test that hands `spawnWorker` a fake
// child cannot observe that race — it is the mocked-seam blindness this project has already paid
// for twice (nine defects past 1148 green tests). So every test below launches `node` for real,
// writes real bytes to a real log, and reads the real outcome.
//
// AND WHY THE MECHANISM EXISTS AT ALL. `lib/preflight.mjs` checks an attestation the worker writes
// before it touches anything, and that check is only worth its cost if it can act WHILE the worker
// runs. A refusal computed after a 25-minute run has paid the full price of the thing it prevents.

test('ADDED B2: a watch that returns a stop reason kills the worker and reports the reason', async () => {
  // The load-bearing case. The child announces itself, then hangs for a minute; the watch sees the
  // announcement and stops it. Without this the refusal is post-hoc and costs a whole run.
  const dir = mktemp('watch-stop');
  const log = join(dir, 'w.log');
  const outcome = await spawnWorker(
    ['-e', "process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'REFUSE ME'}]}})+'\\n'); setTimeout(()=>{},60000)"],
    {
      bin: NODE,
      cwd: dir,
      logPath: log,
      wallCapMs: WATCH_BACKSTOP_MS,
      pollMs: 25,
      watch: (text) => (text.includes('REFUSE ME') ? { reason: 'quote-not-in-body', detail: 'AC2 was confabulated' } : null),
    },
  );

  assert.equal(outcome.stopped.reason, 'quote-not-in-body');
  assert.equal(outcome.stopped.detail, 'AC2 was confabulated');
  assert.equal(outcome.signal, 'SIGTERM', 'SIGTERM so the transcript flushes, as with the wall cap');
  // AND IT IS NOT `killed`. `killed` means the WALL CAP fired — a worker that ran out of time —
  // and `run.mjs` raises a `check_failed` finding from it saying exactly that. A preflight refusal
  // that set the same flag would be reported to the operator as a timeout, which is a different
  // diagnosis with a different fix.
  assert.equal(outcome.killed, false, 'a watch stop is not a wall-cap kill');
  // THE CAP WAS NOT WHAT STOPPED IT. Written against the constant rather than a literal, because
  // this line used to read `< 20000` and would have gone on passing unexamined once the cap moved to
  // 120s — a bound 4.6x looser than the one the author checked, still green, and no longer testing
  // anything. `killed: false` above already proves the WATCH fired; this proves the RACE was not
  // close, which is the part a moving cap can quietly invalidate.
  assert.ok(
    outcome.wall_ms < WATCH_BACKSTOP_MS,
    `the wall cap fired instead of the watch (wall_ms=${outcome.wall_ms})`,
  );
});

test('ADDED B2: a watch that never fires leaves the worker completely alone', async () => {
  // The falsifier. Without it, a watch that killed everything unconditionally would pass the test
  // above — and every run would refuse. A false refusal costs a spawn and teaches the operator to
  // route around the mechanism, which is worse than having no mechanism.
  const dir = mktemp('watch-quiet');
  const outcome = await spawnWorker(['-e', "process.stdout.write('working\\n'); process.exit(0)"], {
    bin: NODE,
    cwd: dir,
    logPath: join(dir, 'w.log'),
    pollMs: 25,
    watch: () => null,
  });

  assert.equal(outcome.exit, 0);
  assert.equal(outcome.killed, false);
  assert.equal(outcome.stopped, null, 'nothing was stopped, so `stopped` must be null and not a shape');
});

test('ADDED B2: no watch at all behaves exactly as before — the default is unchanged', async () => {
  // Every existing caller passes no `watch`. If the default polled, or wrapped the outcome
  // differently, this would be a rewrite of the spawn path disguised as an addition.
  const dir = mktemp('watch-none');
  const outcome = await spawnWorker(['-e', 'process.exit(0)'], { bin: NODE, cwd: dir, logPath: join(dir, 'w.log') });
  assert.equal(outcome.exit, 0);
  assert.equal(outcome.stopped, null);
});

test('ADDED B2: a watch that THROWS does not kill the worker or the run', async () => {
  // The mechanism that reports a problem must not become the problem — the rule `readMarker`,
  // `buildRecord` and `parseAttestation` all follow. This one runs on a timer inside a promise, so
  // an unhandled throw here would not merely mis-grade the run: it would take down the process that
  // was supervising a worker already costing money.
  const dir = mktemp('watch-throw');
  const outcome = await spawnWorker(['-e', "process.stdout.write('hi\\n'); setTimeout(()=>process.exit(0), 250)"], {
    bin: NODE,
    cwd: dir,
    logPath: join(dir, 'w.log'),
    pollMs: 25,
    watch: () => {
      throw new Error('the watch is broken');
    },
  });

  assert.equal(outcome.exit, 0, 'a broken watch must not stop a working worker');
  assert.equal(outcome.stopped, null);
});

test('ADDED B2: the watch sees the log GROWING, not one snapshot of it', async () => {
  // The reason this polls a file rather than reading it once. The attestation is not on disk when
  // the child starts; it arrives some hundreds of milliseconds later. A watch called once at spawn
  // time would read an empty file, conclude nothing, and the mechanism would be nominal — present,
  // green, and incapable of ever firing. Here the trigger text is written only on the second write.
  const dir = mktemp('watch-grow');
  const script = [
    "process.stdout.write('first\\n');",
    "setTimeout(() => { process.stdout.write('THE TRIGGER\\n'); }, 200);",
    'setTimeout(() => {}, 60000);',
  ].join('');

  const seen = [];
  const outcome = await spawnWorker(['-e', script], {
    bin: NODE,
    cwd: dir,
    logPath: join(dir, 'w.log'),
    wallCapMs: WATCH_BACKSTOP_MS,
    pollMs: 25,
    watch: (text) => {
      seen.push(text.length);
      return text.includes('THE TRIGGER') ? { reason: 'low-confidence', detail: 'stopped on a later write' } : null;
    },
  });

  assert.equal(outcome.stopped.reason, 'low-confidence');
  assert.ok(seen.length >= 2, `the watch ran ${seen.length} time(s) — it must poll, not sample once`);
  assert.ok(Math.max(...seen) > Math.min(...seen), 'the watch never saw the log grow');
});

test('ADDED B2: the wall cap still fires when a watch is armed and never triggers', async () => {
  // The two stop paths coexist. A watch that polls forever must not disarm the only bound on a
  // hung worker — and the flags must stay distinguishable: this outcome is `killed: true` with
  // `stopped: null`, the exact inverse of the first test.
  const dir = mktemp('watch-cap');
  const outcome = await spawnWorker(['-e', 'setTimeout(() => {}, 60000)'], {
    bin: NODE,
    cwd: dir,
    logPath: join(dir, 'w.log'),
    wallCapMs: 400,
    pollMs: 25,
    watch: () => null,
  });

  assert.equal(outcome.killed, true);
  assert.equal(outcome.signal, 'SIGTERM');
  assert.equal(outcome.stopped, null);
});

test('ADDED B2: a watch fires at most ONCE, even on a child that ignores SIGTERM', async () => {
  // A stopped worker is not necessarily a dead worker: SIGTERM is a request. A child that ignores
  // it keeps writing, the poll keeps matching, and without a latch the run would signal it every
  // `pollMs` and — worse — overwrite `stopped` with each later read. The first reason is the true
  // one; a later poll may match a different rule against more text.
  const dir = mktemp('watch-once');
  const script = [
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('FIRST REASON\\n');",
    'setTimeout(() => process.exit(0), 400);',
  ].join('');

  // MATCHES, NOT CALLS, and the difference is the whole test. An earlier draft counted every watch
  // invocation and asserted the stop carried `call 1` — it failed with `call 2`, because the first
  // poll at 25ms ran before the child's write reached disk and correctly returned null. That is the
  // watch working, and the assertion was measuring the wrong thing: what must happen at most once is
  // a MATCH being acted on, not the predicate being consulted.
  let matches = 0;
  const outcome = await spawnWorker(['-e', script], {
    bin: NODE,
    cwd: dir,
    logPath: join(dir, 'w.log'),
    wallCapMs: WATCH_BACKSTOP_MS,
    pollMs: 25,
    watch: (text) => {
      if (!text.includes('FIRST REASON')) return null;
      matches += 1;
      return { reason: 'attestation-absent', detail: `match ${matches}` };
    },
  });

  assert.equal(outcome.stopped.reason, 'attestation-absent');
  assert.equal(outcome.stopped.detail, 'match 1', 'the stop reason was overwritten by a later poll');
  // The child ignores SIGTERM and keeps living for 400ms at a 25ms poll, so without the latch the
  // predicate would have matched ~15 more times and signalled the child on each one.
  assert.equal(matches, 1, `the watch matched ${matches} times — the latch did not hold`);
});


// --- B2: the preflight, COMPOSED and CARRIED --------------------------------------------------
//
// `spawnWorker` takes a predicate; `checkAttestation` grades an attestation; neither proves the two
// were ever joined. This project's named recurring defect is a value computed correctly and carried
// nowhere (#63, #69, #72, #73), and a preflight module with no caller was exactly that for one
// commit. So these run through `executeWork` — the path a real run takes — and the criteria come
// out of `item.mjs`'s own extractor via the injected `gh`, never hand-written. A test asserting
// against `{id: 'AC1'}` it wrote itself agrees with the extractor only until the extractor changes,
// and the ids are what the gate keys on.

const AC_BODY =
  '## Acceptance Criteria\n' +
  '- retries are uniform across every channel\n' +
  '- the suite passes under npx vitest run\n';

const ghIssue = (body) => async () =>
  JSON.stringify({
    number: 9,
    title: 'uniform retries',
    body,
    url: 'https://github.com/acme/jarvis/issues/9',
  });

// A worker log whose first turn is an attestation, in the real stream-json shape measured on
// `.alfred-runs/20260802T142320Z-7/worker.log`: a `thinking` block, then `text`, then a `user`
// event closing the turn.
const attestLog = (criteria) =>
  [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: 'reading the ticket', signature: 'sig' },
          { type: 'text', text: '```json\n' + JSON.stringify({ criteria }) + '\n```' },
        ],
      },
    }),
    JSON.stringify({ type: 'user', message: { content: [] } }),
  ].join('\n') + '\n';

test('ADDED B2: a CONFABULATED quote stops the worker in flight and refuses the run', async () => {
  // The mechanism end to end. AC2's quote is not in the body, the watch sees it on the growing log,
  // and the worker is stopped — before it has done any work. That is the whole argument for reading
  // the first turn rather than the result: the refusal costs one turn instead of a 25-minute run.
  const repo = repoWithCommit();
  let stoppedWith = null;

  const result = await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T120000Z',
    gh: ghIssue(AC_BODY),
    spawn: stubSpawn((argv, opts) => {
      const log = attestLog([
        { id: 'AC1', quote: 'retries are uniform across every channel', confidence: 0.9 },
        { id: 'AC2', quote: 'I will rewrite the entire retry subsystem from scratch', confidence: 0.9 },
      ]);
      // The stub decides nothing. It hands the predicate `executeWork` composed a log and reports
      // what the predicate said, so what is under test is the composition, not this callback.
      stoppedWith = opts.watch(log);
      return { exit: 0, killed: false, signal: 'SIGTERM', stopped: stoppedWith, wall_ms: 4000, log: opts.logPath };
    }),
    report: () => null,
    sync: () => null,
  });

  assert.equal(result.ok, true, result.error);
  assert.ok(stoppedWith, 'executeWork armed no watch, so the preflight can never fire');
  assert.equal(stoppedWith.reason, 'quote-not-in-body');
  assert.equal(result.preflight.refused, true);
  assert.equal(result.preflight.reason, 'quote-not-in-body');
  // The detail names WHICH criterion, because a refusal an operator cannot locate is a refusal they
  // will route around rather than investigate.
  assert.match(result.preflight.detail, /AC2/);
});

test('ADDED B2: a TRUTHFUL attestation is not stopped — the falsifier', async () => {
  // Without this, a predicate that refused everything would pass the test above and every run would
  // refuse. `preflight.mjs`'s header names the cost of that: a false refusal teaches the operator to
  // route around the mechanism, which is worse than not having one.
  const repo = repoWithCommit();
  let stoppedWith = 'not called';

  const result = await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T120100Z',
    gh: ghIssue(AC_BODY),
    spawn: stubSpawn((argv, opts) => {
      stoppedWith = opts.watch(
        attestLog([
          { id: 'AC1', quote: 'retries are uniform across every channel', confidence: 0.9 },
          { id: 'AC2', quote: 'the suite passes under npx vitest run', confidence: 0.8 },
        ]),
      );
      return { exit: 0, killed: false, signal: null, stopped: null, wall_ms: 5, log: opts.logPath };
    }),
    report: () => null,
    sync: () => null,
  });

  assert.equal(stoppedWith, null, 'a verbatim attestation was refused');
  assert.equal(result.preflight.refused, false);
  assert.equal(result.preflight.reason, null);
  assert.equal(result.gate.findings.filter((f) => /preflight/i.test(f.detail ?? '')).length, 0);

  // `attested` IS null HERE, NOT 0, and a mutant collapsing the two survived until this line. The
  // pair with the no-criteria test below is what makes the field mean anything: 0 there is a
  // MEASUREMENT (nothing was declared, so nothing was attested), null here is an ADMISSION (two
  // criteria were checked and the count was consumed by the predicate rather than threaded back).
  // Collapsed to 0, a reader summing `attested` across the sink would count every checked run as
  // having checked nothing and conclude the mechanism was never armed — absent read as zero, which
  // is the rule this project keeps re-learning.
  assert.equal(result.preflight.attested, null, 'a checked run reported a count nobody counted');
});

test('ADDED B2: an INCOMPLETE first turn is not refused — the worker is still writing', async () => {
  // The `in_progress` state, and the reason `firstTurnFromWorkerLog` has three states rather than
  // two. A poll landing 200ms in sees a half-written fence; refusing there would fire on a worker
  // about to answer correctly. Absent is not wrong — it is unobserved.
  const repo = repoWithCommit();
  let verdict = 'not called';

  await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T120200Z',
    gh: ghIssue(AC_BODY),
    spawn: stubSpawn((argv, opts) => {
      // A torn fence: the turn has begun, no `user` event has arrived, and the JSON inside is not
      // yet parseable. Both halves of "still writing" at once.
      verdict = opts.watch(
        JSON.stringify({
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: '```json\n{"criteria":[{"id":"AC1",' }] },
        }) + '\n',
      );
      return { exit: 0, killed: false, signal: null, stopped: null, wall_ms: 5, log: opts.logPath };
    }),
    report: () => null,
    sync: () => null,
  });

  assert.equal(verdict, null, 'a worker still writing its first turn was refused mid-sentence');
});

test('ADDED B2: an EMPTY log is not refused, but a FINISHED turn of PROSE is', async () => {
  // Two things on the same predicate, and the pair is the point.
  //
  // An empty log is the poll that ran before the child wrote a byte. Every run passes through it, so
  // refusing there would refuse every run at the first tick, forever.
  //
  // A COMPLETE first turn with no fenced block IS a refusal — the worker read the contract and
  // answered around it — and it is only knowable once the turn is over. That is precisely what the
  // third state buys, and asserting both here is what stops "never refuses" and "always refuses"
  // from both passing.
  //
  // AND THE CODE IS `attestation-unreadable`, NOT `attestation-absent`. This test asserted the
  // latter and was wrong about the code rather than the code being wrong — but the frozen set reads
  // as though the two were distinct ("attested to none of them" versus "answered, but not in a shape
  // that can be checked"), so the collapse is worth stating. `parseAttestation` falls back to
  // treating the WHOLE turn as the JSON candidate when it finds no fence, so prose reaches
  // `JSON.parse`, throws, and comes back `invalid`. That is deliberate there: a worker that writes
  // `{"criteria": [...]}` with no fence around it has attested, and reading the raw turn is what
  // catches it. The cost is that "ignored the contract" and "fenced malformed JSON" arrive under one
  // code. Acceptable — both are refusals, the `detail` distinguishes them for a human — and NOT
  // papered over by re-classifying here, because a second classifier in run.mjs would be free to
  // disagree with the first.
  const repo = repoWithCommit();
  const seen = {};

  await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T120300Z',
    gh: ghIssue(AC_BODY),
    spawn: stubSpawn((argv, opts) => {
      seen.empty = opts.watch('');
      seen.prose = opts.watch(
        JSON.stringify({
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: 'Sure, I will get started on this now.' }] },
        }) +
          '\n' +
          JSON.stringify({ type: 'user', message: { content: [] } }) +
          '\n',
      );
      return { exit: 0, killed: false, signal: null, stopped: null, wall_ms: 5, log: opts.logPath };
    }),
    report: () => null,
    sync: () => null,
  });

  assert.equal(seen.empty, null, 'an empty log refused a worker that had not spoken yet');
  assert.ok(seen.prose, 'a finished first turn with no attestation was let through');
  assert.equal(seen.prose.reason, 'attestation-unreadable');
  assert.match(seen.prose.detail, /could not be parsed as JSON/);
});

test('ADDED B2: an EMPTY text block on a finished turn refuses as ABSENT', async () => {
  // The only input that reaches `preflightWatch`'s `absent` branch, and without this test that branch
  // is unreachable-looking code — the shape [[feedback-unfalsifiable-conjunct]] names, where a green
  // suite means the guard cannot fire rather than that it works.
  //
  // The path is narrow and worth writing down: `firstTurnFromWorkerLog` returns `absent` whenever it
  // collected no text parts, so a `user`-terminated turn with NO text blocks never reaches
  // `complete`. The one way to be complete AND empty is a text block whose `text` is the empty
  // string — the turn exists, the worker committed to nothing in it.
  //
  // UNMEASURED AS A VENDOR SHAPE. The real 301-line log has no empty text block. So this is a
  // synthetic fixture, kept for the same reason as transcript.test.mjs's three: the branch is one
  // line, the alternative is deleting it and having the next empty block arrive at `checkAttestation`
  // as a JSON parse error blamed on the worker's formatting.
  const repo = repoWithCommit();
  let verdict = null;

  await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T120320Z',
    gh: ghIssue(AC_BODY),
    spawn: stubSpawn((argv, opts) => {
      verdict = opts.watch(
        JSON.stringify({
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: '' }] },
        }) +
          '\n' +
          JSON.stringify({ type: 'user', message: { content: [] } }) +
          '\n',
      );
      return { exit: 0, killed: false, signal: null, stopped: null, wall_ms: 5, log: opts.logPath };
    }),
    report: () => null,
    sync: () => null,
  });

  assert.ok(verdict, 'a finished turn that committed to nothing was let through');
  assert.equal(verdict.reason, 'attestation-absent');
});

test('ADDED B2: every reason the runner can emit is a key in the FROZEN refusal set', async () => {
  // A code outside `PREFLIGHT_REFUSALS` would not throw. It would land in the record, and a reader
  // grouping runs by refusal reason would have a bucket matching no documented reason — a value
  // computed correctly and carried into a shape nothing can read. The first draft of `preflightWatch`
  // did exactly this, inventing `attestation-unparseable` for the invalid branch.
  const repo = repoWithCommit();
  const reasons = [];

  await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T120350Z',
    gh: ghIssue(AC_BODY),
    spawn: stubSpawn((argv, opts) => {
      const collect = (log) => {
        const v = opts.watch(log);
        if (v) reasons.push(v.reason);
      };
      // One log per branch the predicate can refuse on.
      collect(attestLog([{ id: 'AC1', quote: 'not in the body at all whatsoever', confidence: 0.9 }]));
      collect(
        JSON.stringify({
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: '```json\nthis is not json\n```' }] },
        }) +
          '\n' +
          JSON.stringify({ type: 'user', message: { content: [] } }) +
          '\n',
      );
      collect(
        JSON.stringify({
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: 'no fence here' }] },
        }) +
          '\n' +
          JSON.stringify({ type: 'user', message: { content: [] } }) +
          '\n',
      );
      collect(attestLog([{ id: 'AC1', quote: 'retries are uniform across every channel', confidence: 0.1 }]));
      collect(attestLog([{ id: 'AC1', quote: 'retries are uniform', confidence: 0.9 }]));
      return { exit: 0, killed: false, signal: null, stopped: null, wall_ms: 5, log: opts.logPath };
    }),
    report: () => null,
    sync: () => null,
  });

  assert.ok(reasons.length >= 4, `only ${reasons.length} refusal branches were reached: ${reasons}`);
  for (const reason of reasons) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(PREFLIGHT_REFUSALS, reason),
      `"${reason}" is not a key in PREFLIGHT_REFUSALS — an undocumented code reached the record`,
    );
  }
  // The invalid-JSON branch specifically, since that is the one that was wrong.
  assert.ok(reasons.includes('attestation-unreadable'), `no unreadable refusal among ${reasons}`);
});

test('ADDED B2: NO criteria means NO watch is armed at all', async () => {
  // `alfred work "fix the flaky test"` is a supported invocation and `item.mjs` refuses to invent
  // criteria for it. There is nothing to attest to, so arming a poll would read a growing log every
  // two seconds for a whole run to reach a conclusion that was foregone before the spawn.
  const repo = repoWithCommit();
  let armed = 'unset';

  const result = await executeWork({
    ref: 'fix the flaky test',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T120400Z',
    spawn: stubSpawn((argv, opts) => {
      armed = opts.watch ?? null;
      return { exit: 0, killed: false, signal: null, stopped: null, wall_ms: 5, log: opts.logPath };
    }),
    report: () => null,
    sync: () => null,
  });

  assert.deepEqual(result.item.acceptance_criteria, [], 'the prompt path invented criteria');
  assert.equal(armed, null, 'a watch was armed for an item with no criteria to check');
  assert.equal(result.preflight.refused, false);
  // ZERO IS A MEASUREMENT HERE, and null is not. Nothing was declared, so nothing was attested —
  // that is known, unlike the count on a run that WAS checked, where the verdict was consumed by
  // the predicate and `null` correctly says "not observed".
  assert.equal(result.preflight.attested, 0, 'zero attested must be recorded, not omitted');
});

test('ADDED B2: a preflight refusal raises a gate finding, so the verdict is not PASS', async () => {
  // §2.8's recorded failure, at a new site. A worker stopped at 4 seconds has touched nothing — and
  // from the TREE's side that is indistinguishable from a worker that finished and correctly changed
  // nothing, which is a clean diff, zero findings, and `pass = findings.length === 0` is TRUE. The
  // gate cannot see the refusal; the runner has to tell it, exactly as it already does for a kill.
  const repo = repoWithCommit();

  const result = await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T120500Z',
    gh: ghIssue(AC_BODY),
    spawn: stubSpawn((argv, opts) => {
      const stopped = opts.watch(attestLog([{ id: 'AC1', quote: 'a quote I invented wholesale', confidence: 0.9 }]));
      return { exit: 0, killed: false, signal: 'SIGTERM', stopped, wall_ms: 4000, log: opts.logPath };
    }),
    // A gate that would otherwise PASS: no findings at all. Without the injection the ac_unmapped
    // findings would mask the one under test, and the test would pass for the wrong reason.
    gate: () => ({ pass: true, findings: [], unverified: [], graded_criteria: 0, ungraded_reason: null, gate_sha: 'x' }),
    report: () => null,
    sync: () => null,
  });

  assert.equal(result.gate.pass, false, 'a refused run was graded PASS');
  const finding = result.gate.findings.find((f) => f.rule === 'check_failed');
  assert.ok(finding, 'the refusal raised no finding');
  assert.match(finding.detail, /preflight/i);
  assert.match(finding.detail, /quote-not-in-body/);
});

test('ADDED B2: the preflight verdict reaches the RECORD, not just the result', async () => {
  // The computed-and-discarded falsifier. `result.preflight` being right proves nothing about what a
  // reader sees a week from now, and the record is the only thing that outlives the console line.
  // Asserted on the arguments the reporter is actually called with.
  const repo = repoWithCommit();
  let reported = null;

  await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T120600Z',
    gh: ghIssue(AC_BODY),
    spawn: stubSpawn((argv, opts) => {
      const stopped = opts.watch(attestLog([{ id: 'AC1', quote: 'not in the body either, plainly', confidence: 0.9 }]));
      return { exit: 0, killed: false, signal: 'SIGTERM', stopped, wall_ms: 4000, log: opts.logPath };
    }),
    report: (args) => {
      reported = args;
      return { ok: true, gaps: [] };
    },
    sync: () => null,
  });

  assert.ok(reported, 'the reporter was never called');
  assert.ok(reported.preflight, 'the record was built without the preflight verdict');
  assert.equal(reported.preflight.refused, true);
  assert.equal(reported.preflight.reason, 'quote-not-in-body');
});

// --- B3: DELIVERY IS WIRED --------------------------------------------------------------------
//
// WHY THESE TESTS EXIST AT ALL, given `test/delivery.test.mjs` covers the module. Adding the
// `deliver` call to `executeWork` did not turn a single one of the 81 tests below red — they all
// passed before the wiring and all passed after it, because none of them looks at delivery. That is
// the `feedback_unfalsifiable_conjunct` shape: green here was never evidence the call was made, the
// arguments were right, or the result went anywhere. So these assert the WIRING, which is the only
// thing the module's own tests cannot see.
//
// THE FIRST ONE USES THE REAL `deliver`. A stub would confirm that `executeWork` calls whatever it
// was handed; only the real module against a real remote confirms the composed call works.

// A repo with a real bare remote, so real delivery can really push. `repoWithCommit` has no remote
// by design — most tests want none — so this wraps it rather than changing it.
function repoWithRemote() {
  const dir = repoWithCommit();
  const bare = mktemp('remote');
  git(bare, ['init', '--quiet', '--bare']);
  git(dir, ['remote', 'add', 'origin', `file://${bare}`]);
  git(dir, ['push', '--quiet', 'origin', 'main']);
  return { dir, bare };
}

// A worker that actually edits the tree, so there is something to commit. Every delivery assertion
// downstream is vacuous against a worker that changed nothing — `deliver` correctly does nothing.
const workerThatWrites = (repo, file = 'src/delivered.js') =>
  stubSpawn((argv, opts) => {
    mkdirSync(join(repo, dirname(file)), { recursive: true });
    writeFileSync(join(repo, file), 'export const delivered = true;\n');
    return { exit: 0, killed: false, signal: null, wall_ms: 1200, log: opts.logPath };
  });

// `mode: 'push'` FOR THE REAL-DELIVER TESTS, AND WHY THAT IS NOT A DODGE. A first draft of the test
// below ran the real `deliver` under `mode: 'pr'` and failed with the real `gh`'s real complaint:
// "none of the git remotes configured for this repository point to a known GitHub host". That is
// correct behaviour from every component — a `file://` bare repo is not GitHub — and it exposed that
// `executeWork` has TWO DIFFERENT `gh` SEAMS that are easy to confuse: its own `gh` param is the
// ITEM FETCHER, while `deliver`'s `gh` is the CLI, and `run.mjs` deliberately does not thread the
// latter through. So at this level the honest proposition is "the composed call really reaches a
// real remote", which `push` mode tests completely. The `--draft` argv proposition is argv-shaped
// and belongs where it is already asserted: `delivery.test.mjs`, against an injected recorder, plus
// the `bin/alfred` end-to-end below with a `gh` shim on PATH.
const PUSH_CONFIG = Object.freeze({ ...CONFIG, delivery: { mode: 'push', never_merge: true } });

test('ADDED B3: a PASSING run reaches the remote through the REAL deliver, and the record says where', async () => {
  const { dir: repo, bare } = repoWithRemote();
  let reported = null;

  const result = await executeWork({
    ref: '#9',
    config: PUSH_CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T130000Z',
    gh: ghIssue(AC_BODY),
    spawn: workerThatWrites(repo),
    gate: () => ({ pass: true, findings: [], unverified: [], graded_criteria: 1, ungraded_reason: null, gate_sha: 'x' }),
    // `deliver` IS NOT INJECTED. It is left at its real default, so the real module runs against the
    // real repo and a real remote. A stub here would only prove `executeWork` calls what it was
    // handed — see the seam caveat in `run.mjs`'s param list.
    report: (args) => {
      reported = args;
      return { ok: true, gaps: [] };
    },
    sync: () => null,
  });

  assert.ok(result.delivery, 'the result carries no delivery block');
  assert.equal(result.delivery.error, null, `delivery failed: ${result.delivery.error}`);
  assert.equal(result.delivery.committed, true);
  assert.equal(result.delivery.pushed, true);
  assert.equal(result.delivery.base, 'main', 'the base came from config.base.rules');

  // OBSERVED ON THE REMOTE, not read back from the return value. This is the assertion that a stub
  // could never make and the one that proves the composed call actually delivers.
  assert.notEqual(git(bare, ['branch', '--list', result.delivery.branch]).trim(), '', 'nothing reached the remote');
  assert.match(git(bare, ['show', '--name-only', '--format=', result.delivery.branch]), /src\/delivered\.js/);

  // AND IT REACHED THE RECORD. `report.mjs`'s delivery block has been three empty fields on every
  // record ever written; this is the falsifier for that.
  assert.ok(reported, 'the reporter was never called');
  assert.deepEqual(reported.delivery.commits, [result.delivery.head], 'the commit sha is in the record');
  assert.equal(reported.delivery.pushed_to, result.delivery.branch);

  // --- D4: AND SO DO `steps` AND `error`, which this test used to stop just short of.
  //
  // MEASURED 2026-08-03 on all three records that ever ran delivery, including jarvis#11 whose
  // commit 56162bc demonstrably exists: `delivery.steps` is `[]` on every one. `buildRecord`
  // carries both fields and says so in a comment about this exact failure mode — but `run.mjs`
  // hand-built a THREE-KEY object (`commits`/`pushed_to`/`pr_url`) to pass it, so the other two
  // were dropped one layer above the code that was careful about them.
  //
  // The same defect as the backfill tool emptying `preflight` and `sink` earlier today, and the
  // same one as #63/#69/#72/#73: a value computed, printed to the console, and never persisted.
  // Enumerating keys by hand is the shape that keeps producing it.
  //
  // `error` IS THE HALF THAT MATTERS MOST. Null there means "delivery raised nothing", so a run
  // whose push FAILED persisted a record byte-identical to one whose push was skipped for a
  // failed gate — and the console said so at the time, so the information existed and was thrown
  // away. Asserted below on the succeeding path (null, honestly) and at B3 on the failing one.
  assert.ok(Array.isArray(reported.delivery.steps), 'steps must be an array in the record');
  assert.ok(reported.delivery.steps.length > 0, 'a delivery that committed and pushed recorded no steps');
  assert.deepEqual(
    reported.delivery.steps,
    result.delivery.steps,
    'the record must carry the SAME sequence deliver() returned, not a rebuilt one',
  );
  // Named steps, not just a non-empty array: a length check passes on `[{}]`.
  const names = reported.delivery.steps.map((s) => s.step);
  assert.ok(names.includes('commit'), `no commit step in ${JSON.stringify(names)}`);
  assert.ok(names.includes('push'), `no push step in ${JSON.stringify(names)}`);
  assert.equal(reported.delivery.error, null, 'a clean delivery records no error');
});

test('ADDED B3: when the PUSH lands and the PR does NOT, the run says the branch is out there', async () => {
  // THIS TEST IS THE FIRST DRAFT'S FAILURE, KEPT. Running the real `deliver` in `pr` mode against a
  // `file://` remote makes the real `gh` fail after a successful push, which is the exact partial
  // state an operator most needs told: the bytes ARE on the remote. Reporting `pushed: false` here
  // — or letting the gh error stand unrewritten as "gh: HTTP 422" — would leave a pushed branch
  // that the record denies exists. Not a mock of that scenario; the scenario.
  const { dir: repo, bare } = repoWithRemote();
  let reported = null;

  const result = await executeWork({
    ref: '#9',
    config: CONFIG, // mode: 'pr', and `gh pr create` cannot succeed against file://
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T130800Z',
    gh: ghIssue(AC_BODY),
    spawn: workerThatWrites(repo),
    gate: () => ({ pass: true, findings: [], unverified: [], graded_criteria: 1, ungraded_reason: null, gate_sha: 'x' }),
    report: (args) => {
      reported = args;
      return { ok: true, gaps: [] };
    },
    sync: () => null,
  });

  assert.equal(result.ok, true, 'a missing PR must not fail a graded run');
  assert.equal(result.delivery.pushed, true, 'the push happened and must be reported as such');
  assert.equal(result.delivery.pr_url, null);
  assert.match(result.delivery.error, /branch was pushed but no PR was opened/);
  // And the remote agrees with the claim, which is the point of asserting on it rather than the
  // return value: `pushed_to` names a ref an operator can actually go and look at.
  assert.equal(reported.delivery.pushed_to, result.delivery.branch);
  assert.notEqual(git(bare, ['branch', '--list', result.delivery.branch]).trim(), '');
});

test('ADDED B3: a FAILING run commits locally, pushes NOTHING, and the record does not claim a push', async () => {
  const { dir: repo, bare } = repoWithRemote();
  let reported = null;

  const result = await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T130100Z',
    gh: ghIssue(AC_BODY),
    spawn: workerThatWrites(repo),
    gate: () => ({ pass: false, findings: [{ rule: 'test_failed', detail: 'npm test exited 1' }], unverified: [], graded_criteria: 1, ungraded_reason: null, gate_sha: 'x' }),
    report: (args) => {
      reported = args;
      return { ok: true, gaps: [] };
    },
    sync: () => null,
  });

  assert.equal(result.delivery.committed, true, 'the work must be committed — the diff is its only copy');
  assert.equal(result.delivery.pushed, false);
  assert.equal(result.delivery.error, null, 'a failed gate is not a delivery failure');
  assert.equal(git(bare, ['branch', '--list', result.delivery.branch]).trim(), '', 'a failed run reached the remote');

  // `pushed_to: null` WHILE `commits` IS NON-EMPTY. The two fields disagreeing is the point: a
  // record that named the local branch under `pushed_to` would make this look like a push.
  assert.deepEqual(reported.delivery.commits, [result.delivery.head]);
  assert.equal(reported.delivery.pushed_to, null, 'a local branch is not somewhere anything was pushed');
  assert.equal(reported.delivery.pr_url, null);
});

test('ADDED B3: the tree is CLEAN after a run, so the next tick is not refused by its own predecessor', async () => {
  // The consequence that makes "commit always" load-bearing rather than tidy. `executeWork` refuses
  // a dirty tree at Step 2b, so a run that left its edits uncommitted would block the NEXT tick —
  // and the operator would see a refusal naming files they never touched.
  const { dir: repo } = repoWithRemote();

  await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T130200Z',
    gh: ghIssue(AC_BODY),
    spawn: workerThatWrites(repo),
    gate: () => ({ pass: false, findings: [{ rule: 'test_failed', detail: 'x' }], unverified: [], graded_criteria: 1, ungraded_reason: null, gate_sha: 'x' }),
    report: () => ({ ok: true, gaps: [] }),
    sync: () => null,
  });

  assert.equal(git(repo, ['status', '--porcelain']).trim(), '', 'the worker’s edits were left uncommitted');
  // And the proof that this is what Step 2b cares about: a second run is not refused.
  const second = await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T130300Z',
    gh: ghIssue(AC_BODY),
    spawn: stubSpawn((argv, opts) => ({ exit: 0, killed: false, signal: null, wall_ms: 10, log: opts.logPath })),
    gate: () => ({ pass: true, findings: [], unverified: [], graded_criteria: 1, ungraded_reason: null, gate_sha: 'x' }),
    report: () => ({ ok: true, gaps: [] }),
    sync: () => null,
  });
  assert.equal(second.ok, true, `the second tick was refused: ${second.error}`);
});

test('ADDED B3: a delivery failure does NOT fail the graded run — it is a sidecar', async () => {
  // §7's rule at a new site, and the one with the most money behind it: the worker ran, the tokens
  // are spent, the gate graded the tree. A `gh` outage turning that into `ok: false` would reach
  // `cli.mjs` as exit 2, which a scheduler retries at full price for a run that already happened.
  const repo = repoWithCommit();

  const result = await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T130400Z',
    gh: ghIssue(AC_BODY),
    spawn: workerThatWrites(repo),
    gate: () => ({ pass: true, findings: [], unverified: [], graded_criteria: 1, ungraded_reason: null, gate_sha: 'x' }),
    deliver: async () => { throw new Error('the remote refused the connection'); },
    report: () => ({ ok: true, gaps: [] }),
    sync: () => null,
  });

  assert.equal(result.ok, true, 'a delivery failure must not fail a graded run');
  assert.equal(result.gate.pass, true, 'and must not change the verdict');
  assert.match(result.delivery.error, /deliver threw.*refused the connection/);
  assert.equal(result.delivery.committed, false);
});

test('ADDED B3: delivery runs BEFORE the record, or the record could never carry it', async () => {
  // An ordering test, because the ordering is the defect that was already latent: `report.mjs` has
  // held a `delivery` block since M2 and it was `{commits: [], pushed_to: null, pr_url: null}` on
  // every record ever written. Delivering after Step 7 would leave it that way forever, and no
  // assertion on the final result would notice.
  const repo = repoWithCommit();
  const order = [];

  await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T130500Z',
    gh: ghIssue(AC_BODY),
    spawn: workerThatWrites(repo),
    gate: () => ({ pass: true, findings: [], unverified: [], graded_criteria: 1, ungraded_reason: null, gate_sha: 'x' }),
    deliver: async () => {
      order.push('deliver');
      return { committed: true, branch: 'alfred/x', base: 'main', pushed: true, pr_url: 'https://x.invalid/pr/1', head: 'abc1234', steps: [], error: null };
    },
    report: () => {
      order.push('report');
      return { ok: true, gaps: [] };
    },
    sync: () => {
      order.push('sync');
      return null;
    },
  });

  assert.deepEqual(order, ['deliver', 'report', 'sync']);
});

test('ADDED B3: a run that changed nothing delivers nothing, and says so rather than erroring', async () => {
  const { dir: repo, bare } = repoWithRemote();
  let reported = null;

  const result = await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T130600Z',
    gh: ghIssue(AC_BODY),
    spawn: stubSpawn((argv, opts) => ({ exit: 0, killed: false, signal: null, wall_ms: 900, log: opts.logPath })),
    gate: () => ({ pass: true, findings: [], unverified: [], graded_criteria: 1, ungraded_reason: null, gate_sha: 'x' }),
    report: (args) => {
      reported = args;
      return { ok: true, gaps: [] };
    },
    sync: () => null,
  });

  assert.equal(result.delivery.committed, false);
  assert.equal(result.delivery.branch, null, 'no branch litter for a run that did nothing');
  assert.equal(result.delivery.error, null, 'nothing to do is not an error');
  assert.deepEqual(reported.delivery.commits, [], 'and NOT [null] — a one-element array reads as one commit');
  assert.equal(git(bare, ['branch', '--list', 'alfred/*']).trim(), '');
});

test('ADDED B3: a preflight-refused run delivers nothing to the remote', async () => {
  // The two B-slice guards meeting. A worker stopped in its first turn has touched nothing, so
  // there is nothing to commit — but the path that matters is the verdict: the refusal raises a
  // `check_failed` finding, the gate fails, and a failed gate does not push. Asserted rather than
  // assumed, because the two mechanisms are independent and either could be removed alone.
  const { dir: repo, bare } = repoWithRemote();

  const result = await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T130700Z',
    gh: ghIssue(AC_BODY),
    spawn: stubSpawn((argv, opts) => {
      // The worker writes BEFORE being stopped, so "nothing to commit" is not what makes this pass.
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'half-done.js'), 'export const partial = true;\n');
      const stopped = opts.watch(attestLog([{ id: 'AC1', quote: 'a quote I invented wholesale', confidence: 0.9 }]));
      return { exit: 0, killed: false, signal: 'SIGTERM', stopped, wall_ms: 4000, log: opts.logPath };
    }),
    gate: () => ({ pass: true, findings: [], unverified: [], graded_criteria: 0, ungraded_reason: null, gate_sha: 'x' }),
    report: () => ({ ok: true, gaps: [] }),
    sync: () => null,
  });

  assert.equal(result.preflight.refused, true);
  assert.equal(result.gate.pass, false, 'the refusal must fail the gate');
  assert.equal(result.delivery.pushed, false, 'a refused run reached the remote');
  assert.equal(git(bare, ['branch', '--list', 'alfred/*']).trim(), '', 'and the remote confirms it');
  // COMMITTED, THOUGH. The half-finished edit is preserved locally, which is both how an operator
  // sees what the worker managed to do before it was stopped and how the next tick gets a clean tree.
  assert.equal(result.delivery.committed, true);
});

test('ADDED B2: a quote is checked against the TICKET BODY, not against the prompt', async () => {
  // The subtlest way this could be wrong and still look right. If the predicate were handed the
  // composed prompt instead of `item.body`, then Alfred's own contract text would become a place a
  // quote could be found — and a worker echoing the contract's example, or quoting the standing
  // rules, would attest successfully to something the ticket never said.
  const repo = repoWithCommit();
  let stoppedWith = null;

  await executeWork({
    ref: '#9',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: '20260802T120700Z',
    gh: ghIssue(AC_BODY),
    spawn: stubSpawn((argv, opts) => {
      // A phrase that IS in the prompt Alfred composed and is nowhere in the issue body. THIS LINE
      // WAS WRONG ONCE and the mutant caught it: the first version quoted the off-limits preamble,
      // but this test's CONFIG declares `off_limits: []`, so that block is never emitted and the
      // phrase was in neither the body NOR the prompt — the test passed while proving nothing, and
      // swapping `item.body` for the composed prompt did not fail it. The seat brief below is
      // unconditional in `composeWorkerPrompt`, so it is genuinely present in the prompt and
      // genuinely absent from the body, which is what makes the two sources distinguishable.
      stoppedWith = opts.watch(
        attestLog([
          { id: 'AC1', quote: 'You may delegate to a subagent for part of this work', confidence: 0.9 },
        ]),
      );
      return { exit: 0, killed: false, signal: 'SIGTERM', stopped: stoppedWith, wall_ms: 100, log: opts.logPath };
    }),
    report: () => null,
    sync: () => null,
  });

  assert.ok(stoppedWith, "a quote lifted from Alfred's own prompt was accepted as a quote of the ticket");
  assert.equal(stoppedWith.reason, 'quote-not-in-body');
});
