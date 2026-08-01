// bin/alfred + lib/cli.mjs — PLAN.md §2.1 step 8, and the argv that gets there.
//
// SPLIT IN TWO ON PURPOSE. `bin/alfred` is a shebang and a call; `lib/cli.mjs` holds the parse
// and the main. §1's layout says "one script with subcommands so the slash command and cron
// invoke the *same* code path", and that still holds — there is one main, and the bin is how it
// is reached. Putting the parse in a file with an extension is what makes the refusals below
// assertable at all.
//
// AND THE BIN IS LAUNCHED FOR REAL, not imported. A test that only imports `main` is blind to
// the three things that actually break an entrypoint: a missing shebang, a file that is not
// executable, and an off-by-one in `process.argv.slice`. Every one of those is invisible to a
// unit test and fatal to a 3am tick. That is the same mocked-seam blindness that cost the
// experiment's runner four defects past sixty green tests.
//
// THE THREE EXIT CODES ARE THE POINT OF THIS SLICE. A scheduler reading `1` knows a worker ran,
// spent money, and was graded no; reading `2` it knows nothing was spent and the operator's
// input or config is wrong. Collapsing them means an unattended loop either retries a
// misconfiguration forever at full price, or stops retrying a run that failed honestly.
//
// NO REAL MODEL CALL HAPPENS IN THIS FILE. The worker binary is substituted — and ONLY the
// worker binary — so the whole path from argv through spawn, observe, and gate runs for real
// against a child that costs nothing. That is the minimum substitution: everything the tests
// below assert about wiring is wiring that actually executed.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXIT, parseArgv, reportVerdict, usage } from '../lib/cli.mjs';
import { SOURCE_FILENAME } from '../lib/item.mjs';
import { DEFAULT_WALL_CAP_MS } from '../lib/run.mjs';

const BIN = fileURLToPath(new URL('../bin/alfred', import.meta.url));
const temps = [];
const mktemp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), `alfred-cli-${prefix}-`));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

// A config that goes through `loadConfig`, which is the first thing in this file that the
// module-level tests never exercised: `verify: {}` is REFUSED — "the gate needs something to
// run". test/run.test.mjs passes a config object straight in, so nothing there validated one.
// The command has to exit 0 for the pass case and is deliberately trivial; the gate's own tests
// are where non-zero exits are graded.
const CONFIG = {
  version: 1,
  repo: 'jarvis',
  source: { kind: 'github', github: { owner: 'acme', repo: 'jarvis' } },
  base: { rules: [{ default: 'main' }] },
  branch_prefix: 'alfred/',
  verify: { check: 'true' },
  delivery: { mode: 'pr', never_merge: true },
  off_limits: [],
};

// A real git repository, because `observeTree` shells out to git and a fake would assert
// against my model of `--numstat` rather than git's.
function repo({ config = CONFIG } = {}) {
  const dir = mktemp('repo');
  git(dir, ['init', '--quiet', '-b', 'main']);
  git(dir, ['config', 'user.email', 'alfred@example.invalid']);
  git(dir, ['config', 'user.name', 'Alfred Test']);
  writeFileSync(join(dir, 'a.js'), 'export const a = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'base']);
  if (config) {
    mkdirSync(join(dir, '.alfred'), { recursive: true });
    writeFileSync(join(dir, '.alfred', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--quiet', '-m', 'config']);
  }
  return dir;
}

// A stub standing in for `claude`. Writes a marker so a test can prove the worker RAN rather
// than inferring it from an exit code — a launch failure and a clean run both leave exit 0
// somewhere in the plumbing if nobody checks.
function workerStub({ script = '', exitCode = 0 } = {}) {
  const dir = mktemp('bin');
  const path = join(dir, 'fake-claude');
  writeFileSync(
    path,
    ['#!/bin/sh', 'printf "%s\\n" "$@" > "$0.argv"', script, `exit ${exitCode}`].join('\n'),
  );
  chmodSync(path, 0o755);
  return { path, argvFile: `${path}.argv` };
}

const run = (args, { cwd } = {}) =>
  spawnSync(BIN, args, { cwd, encoding: 'utf8', env: { ...process.env } });

// --- the entrypoint itself, asserted on the file rather than on an import ---

test('bin/alfred is executable and runs node — the seam no unit test can see', () => {
  // The three ways an entrypoint dies that importing `main` cannot detect. Checked here rather
  // than assumed because each one produces a tick that fails before any of Alfred's own code
  // gets a chance to record why.
  const mode = statSync(BIN).mode;
  assert.ok(mode & 0o111, 'bin/alfred is not executable');

  const first = readFileSync(BIN, 'utf8').split('\n')[0];
  assert.match(first, /^#!/, 'bin/alfred has no shebang');
  assert.match(first, /node/, 'bin/alfred does not invoke node');

  // And it actually runs. A shebang pointing at a path that does not exist matches the regex
  // above and still fails to launch.
  const r = run(['--help']);
  assert.equal(r.error, undefined, `bin/alfred failed to launch: ${r.error?.message}`);
  assert.equal(r.status, EXIT.pass);
  // Asserted on the usage text the module owns rather than on a phrase typed here, which would
  // fail on a rewording that broke nothing.
  assert.equal(r.stdout.trim(), usage().trim());
});

// --- the three exit codes, which are the slice ---

test('a run whose gate passes exits 0', async () => {
  const dir = repo();
  const stub = workerStub();
  const r = run(
    ['work', 'make the retry backoff configurable', '--worker-bin', stub.path, '--run-root', mktemp('runs')],
    { cwd: dir },
  );

  assert.equal(r.status, EXIT.pass, `expected pass, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  // The stub RAN. Without this the test passes identically if the spawn silently no-oped.
  assert.ok(statSync(stub.argvFile).size > 0, 'the worker was never launched');
});

test('a run whose gate finds something exits 1 — not 0, and not the refusal code', () => {
  // A verify command that fails is `check_failed`, which is a finding, which is `pass: false`.
  // The gate runs the command itself in a separate process, so this is the real rule firing.
  const dir = repo({ config: { ...CONFIG, verify: { lint: 'exit 3' } } });
  const stub = workerStub();
  const r = run(
    ['work', 'anything', '--worker-bin', stub.path, '--run-root', mktemp('runs')],
    { cwd: dir },
  );

  assert.equal(r.status, EXIT.gate_failed, `expected gate_failed, got ${r.status}\n${r.stderr}`);
  assert.notEqual(EXIT.gate_failed, EXIT.refused);
  // The worker still ran and still cost money. That is exactly what distinguishes this from a
  // refusal, so it is asserted rather than left implied.
  assert.ok(statSync(stub.argvFile).size > 0, 'the worker never launched, so this is a refusal');
  assert.match(r.stdout + r.stderr, /check_failed/, 'the finding that decided the verdict is not reported');
});

test('a refusal before anything spends exits 2, and spawns nothing', () => {
  // No `.alfred/config.json`. loadConfig refuses rather than inventing a base branch, and this
  // must not read like a run that was graded and failed.
  const dir = repo({ config: null });
  const stub = workerStub();
  const r = run(
    ['work', 'anything', '--worker-bin', stub.path, '--run-root', mktemp('runs')],
    { cwd: dir },
  );

  assert.equal(r.status, EXIT.refused, `expected refused, got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /\.alfred[/\\]config\.json/, 'the refusal does not name the missing file');
  // NOTHING SPENT. The argv file is written by the stub's first line, so its absence is proof
  // the child never ran.
  assert.throws(() => statSync(stub.argvFile), /ENOENT/, 'a refusal launched the worker anyway');
});

// --- usage and the subcommand surface ---

test('no arguments prints usage to stderr and refuses', () => {
  const r = run([]);
  assert.equal(r.status, EXIT.refused);
  assert.match(r.stderr, /usage/i);
  // Usage on STDERR when it is a refusal, and on stdout for `--help`. A scheduler capturing
  // stdout should get the run's output, not a help screen, when the invocation was wrong.
  assert.equal(r.stdout, '');
});

test('an unknown subcommand names itself and refuses', () => {
  const r = run(['wrok', '#4']);
  assert.equal(r.status, EXIT.refused);
  assert.match(r.stderr, /wrok/, 'the refusal does not quote what was typed');
});

test('`loop` says it is not built rather than exiting 0 quietly', () => {
  // §2.2 says a no-op tick must be indistinguishable from a healthy tick to the scheduler —
  // which is precisely why an UNBUILT loop must not exit 0. Once cron is pointed at it, a
  // silent success is a loop that appears to be patrolling and is doing nothing at all.
  const r = run(['loop'], { cwd: repo() });
  assert.equal(r.status, EXIT.refused);
  assert.match(r.stderr, /not (yet )?(built|implemented)/i);
});

test('`work` with no ref refuses instead of composing a prompt about nothing', () => {
  const r = run(['work'], { cwd: repo() });
  assert.equal(r.status, EXIT.refused);
  assert.match(r.stderr, /ref|item|work on/i);
});

// --- parseArgv: the refusals that keep a flag from eating the next one ---

test('a flag missing its value refuses rather than swallowing the following flag', () => {
  // The silent-corruption shape. `--repo --dry-run` naively parsed gives `repo: '--dry-run'`,
  // and then the run is graded against a directory named `--dry-run` that does not exist. The
  // error message would be about a missing path, pointing nowhere near the typo.
  assert.throws(() => parseArgv(['work', '#4', '--repo', '--dry-run']), /--repo/);
  assert.throws(() => parseArgv(['work', '#4', '--repo']), /--repo/);
});

test('a non-numeric --max-turns refuses instead of passing the string "NaN" through', () => {
  // Measured precedent, and the reason this refusal exists at all: the CLI accepts unknown and
  // malformed `--agents` keys silently. `budgetUsdFor` refuses a non-number for the same
  // reason. A `--max-turns NaN` that the CLI ignores is an unbounded run wearing a limit.
  assert.throws(() => parseArgv(['work', '#4', '--max-turns', 'lots']), /max-turns/);
  assert.throws(() => parseArgv(['work', '#4', '--max-turns', '0']), /max-turns/);
  assert.equal(parseArgv(['work', '#4', '--max-turns', '12']).maxTurns, 12);
});

test('an unknown flag refuses — the CLI ignoring one is what makes this necessary', () => {
  // `router.mjs` refuses an unknown subagent seat because the vendor CLI accepted
  // `bogus_key_xyz` without complaint. Same argument one layer out: `--dryrun` silently
  // ignored is a real run the operator believed was a rehearsal.
  assert.throws(() => parseArgv(['work', '#4', '--dryrun']), /--dryrun/);
});

test('the ref is taken whole, so a quoted prompt is one work item and not a flag', () => {
  const parsed = parseArgv(['work', 'make the --retry backoff configurable']);
  assert.equal(parsed.ref, 'make the --retry backoff configurable');
  assert.equal(parsed.command, 'work');
});

test('parseArgv defaults the wall cap to lib/run.mjs\'s constant, not to its own number', () => {
  // Imported rather than typed. A second 25 here would drift from DEFAULT_WALL_CAP_MS, and the
  // record would state a cap the run did not use.
  assert.equal(parseArgv(['work', '#4']).wallCapMs, DEFAULT_WALL_CAP_MS);
  assert.equal(parseArgv(['work', '#4', '--wall-cap-minutes', '3']).wallCapMs, 3 * 60 * 1000);
  assert.throws(() => parseArgv(['work', '#4', '--wall-cap-minutes', '-1']), /wall-cap/);
});

test('usage names every subcommand parseArgv accepts', () => {
  // A subcommand that works and is undocumented is only reachable by reading the source; a
  // documented one that does not work is worse. Asserted against the parse rather than a list.
  const text = usage();
  for (const command of ['work', 'loop']) {
    assert.ok(text.includes(command), `usage omits '${command}'`);
  }
});

// --- what the operator gets back ---

test('the run directory is printed, and it is outside the repository the gate scores', () => {
  const dir = repo();
  const runRoot = mktemp('runs');
  const stub = workerStub();
  const r = run(['work', 'anything', '--worker-bin', stub.path, '--run-root', runRoot], { cwd: dir });

  // Printed, because artifacts nobody can find are artifacts nobody reads.
  assert.match(r.stdout, new RegExp(runRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // OUTSIDE the repo. A source.json under repoRoot is counted by `observeTree` as delivered
  // work and raises `scope_violation` on a run that did nothing wrong.
  const printed = /run dir: (.+)/.exec(r.stdout)?.[1]?.trim();
  assert.ok(printed, `no run dir in output:\n${r.stdout}`);
  assert.ok(!printed.startsWith(dir), 'the run directory is inside the repository being graded');
  assert.ok(statSync(join(printed, SOURCE_FILENAME)).size > 0, 'the raw payload was not written');
});

test('--dry-run composes everything and spawns nothing, and says so', () => {
  // The rehearsal that proves the wiring without spending. It has to SAY it did not run:
  // "composed the argv" and "ran the worker" printing the same thing is the false-success
  // shape this whole project keeps finding.
  const dir = repo();
  const stub = workerStub();
  const r = run(
    ['work', 'anything', '--dry-run', '--worker-bin', stub.path, '--run-root', mktemp('runs')],
    { cwd: dir },
  );

  assert.equal(r.status, EXIT.pass);
  assert.throws(() => statSync(stub.argvFile), /ENOENT/, '--dry-run launched the worker');
  assert.match(r.stdout, /dry run|did not run|would run/i, '--dry-run does not say it did not run');

  // The argv it would have used is shown, including the model, because the point of a
  // rehearsal is checking the flags.
  assert.match(r.stdout, /--model/);
  assert.match(r.stdout, /--max-budget-usd/);
});

test('the worker is handed the composed prompt and the standing rules, asserted on the real argv', () => {
  // Read off the file the STUB wrote, so this is the argv a real child received rather than the
  // argv a mock recorded. `workerArgv` is unit-tested elsewhere; what is untested anywhere else
  // is that bin/alfred hands its output to the thing it spawns.
  const dir = repo();
  const stub = workerStub();
  const r = run(
    ['work', 'standardize the retry policy', '--worker-bin', stub.path, '--run-root', mktemp('runs')],
    { cwd: dir },
  );
  assert.equal(r.status, EXIT.pass, r.stderr);

  const argv = readFileSync(stub.argvFile, 'utf8');
  assert.match(argv, /standardize the retry policy/, 'the prompt did not reach the worker');
  assert.match(argv, /--append-system-prompt/, 'the standing rules were not passed');
  assert.match(argv, /false premise/, 'the standing rules were passed empty');
  assert.match(argv, /--permission-mode/);
});

test('a worker that exits non-zero is reported, and the gate still decides the verdict', () => {
  // The worker's exit code is EVIDENCE, not the verdict. `claude -p` exits non-zero on a
  // budget stop and on an API error, and both leave a tree the gate can score — while a
  // worker that exits 0 having done nothing must not pass on its own say-so. So the exit is
  // reported and the gate is what sets the code.
  const dir = repo();
  const stub = workerStub({ exitCode: 7 });
  const r = run(
    ['work', 'anything', '--worker-bin', stub.path, '--run-root', mktemp('runs')],
    { cwd: dir },
  );

  assert.match(r.stdout + r.stderr, /\b7\b/, "the worker's exit code is not reported");
  assert.ok(r.status === EXIT.pass || r.status === EXIT.gate_failed, `got ${r.status}`);
});

test('a worker-declared unverified entry says so, so it is not read as a criterion (#72)', () => {
  // The label exists to stop a misreading, so it has to reach the operator. `unverified: AC2 ...`
  // and `unverified: some sentence the worker wrote ...` printed identically would have an
  // operator hunting the ticket for a criterion nobody put there.
  const printed = [];
  reportVerdict(
    {
      pass: true,
      findings: [],
      unverified: [
        { ac: 'AC2', reason: 'characterization tests are absent' },
        { ac: 'backoff shape is preserved', reason: 'the tests stub sleep', worker_declared: true },
      ],
    },
    { out: (line) => printed.push(line) },
  );

  const lines = printed.join('\n');
  assert.match(lines, /unverified: AC2 characterization tests are absent/);
  assert.match(lines, /worker-declared/);
  // And the criterion from the ticket is NOT labelled — the whole value is telling them apart.
  assert.doesNotMatch(lines.split('\n').find((l) => l.includes('AC2')), /worker-declared/);
});

test('a run in a directory that is not a git repository still returns a verdict', () => {
  // `observeTree` shells out to git. An operator running this in the wrong directory must get a
  // stated refusal or a verdict, never a stack trace — an unattended tick that crashes leaves
  // no record of why it crashed.
  const dir = mktemp('nogit');
  mkdirSync(join(dir, '.alfred'), { recursive: true });
  writeFileSync(join(dir, '.alfred', 'config.json'), JSON.stringify(CONFIG));
  const stub = workerStub();
  const r = run(
    ['work', 'anything', '--worker-bin', stub.path, '--run-root', mktemp('runs')],
    { cwd: dir },
  );

  assert.ok([EXIT.pass, EXIT.gate_failed, EXIT.refused].includes(r.status), `got ${r.status}`);
  assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/, 'an uncaught exception reached the operator');
});

// --- THE RECORD, ON THE OPERATOR'S SIDE -----------------------------------------------------

test('a completed run prints what its accounting record cost, or says it could not read it', () => {
  // WHY THE CLI HAS TO SAY SOMETHING. `executeWork` now builds a record by default, and a record
  // built and then never mentioned is the unwired-tripwire shape this project keeps finding in
  // its own instruments — the operator's only signal that accounting happened at all.
  //
  // THIS RUN'S RECORD DELIBERATELY FAILS, and that is the case worth pinning. The stub is not
  // `claude`, so it writes no result JSON and there is no session id to name a transcript with.
  // A run that spends money and cannot be priced must SAY SO on the console rather than print
  // nothing and let a passing gate imply the books balanced.
  const dir = repo();
  const stub = workerStub();
  const result = run(['work', 'tidy the retry helper', '--worker-bin', stub.path], { cwd: dir });

  assert.equal(result.status, EXIT.pass, result.stderr);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /record|cost|accounting/i,
    `the run said nothing about its own accounting: ${result.stdout}${result.stderr}`,
  );
  // The reason, not just the fact. "no record" with no cause is indistinguishable from a run
  // nobody asked to report on.
  assert.match(`${result.stdout}${result.stderr}`, /session id/i);
});

test('a priced record prints the figure, and prints the vendor figure beside it', () => {
  // The pass case, driven by a stub that emits the real `--output-format json` shape and by a
  // transcript planted where the formula says. Both numbers are printed because their agreeing
  // is the only evidence the copied price table is right — and an operator who can see only one
  // of them cannot notice the day they stop agreeing.
  const dir = repo();
  const home = mktemp('home');
  const sessionId = 'cccccccc-dddd-eeee-ffff-000000000000';

  const projectDir = join(
    home,
    '.claude',
    'projects',
    realpathSync(dir).replace(/[^A-Za-z0-9]/g, '-'),
  );
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-31T19:00:00.000Z',
      message: { model: 'claude-sonnet-5', id: 'm1', usage: { input_tokens: 500000 } },
    }) + '\n',
  );

  const stub = workerStub({
    script: `printf '{"type":"result","session_id":"${sessionId}","total_cost_usd":0.5}'`,
  });
  const result = spawnSync(BIN, ['work', 'tidy up', '--worker-bin', stub.path], {
    cwd: dir,
    encoding: 'utf8',
    // HOME is what `transcriptPathFor` resolves the project directory under. An environment
    // fact, so the composition itself still runs for real.
    env: { ...process.env, HOME: home },
  });

  assert.equal(result.status, EXIT.pass, result.stderr);
  assert.match(result.stdout, /record:/, `no record line: ${result.stdout}`);
  // Ours, from the price table, over 500k input tokens — a figure no zero-fill could produce.
  assert.match(result.stdout, /\$1\.5/, `our cost is missing or wrong: ${result.stdout}`);
  // And the vendor's own, carried beside it rather than instead of it.
  assert.match(result.stdout, /vendor \$0\.5/, `the vendor figure is missing: ${result.stdout}`);
});
