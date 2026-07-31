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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { SEATS, normalizeModelId } from '../lib/models.mjs';
import { SOURCE_FILENAME } from '../lib/item.mjs';
import {
  SEAT_ENV_VARS,
  executeWork,
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
  // A worker that hangs is otherwise unbounded: `--max-budget-usd` is enforced POST-TURN, so it
  // bounds a runaway across turns and bounds nothing at all inside one. SIGTERM rather than
  // SIGKILL, because the transcript the run is priced from has to flush.
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

// --- executeWork: the eight steps, and what must happen before anything spends ---

const stubSpawn = (impl) => (argv, opts) => Promise.resolve(impl(argv, opts));

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
  assert.ok(argv.includes('--max-budget-usd'), 'the one ceiling the CLI honours is absent');
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
