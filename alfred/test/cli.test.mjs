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

import { AC_MAP_KIND } from '../lib/acmap.mjs';
import { EXIT, parseArgv, reportDelivery, reportRecord, reportSync, reportVerdict, usage } from '../lib/cli.mjs';
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
  // malformed `--agents` keys silently. A `--max-turns NaN` that the CLI ignores is an
  // unbounded run wearing a limit.
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

// --- #14: the dirty-tree refusal, on the operator's side ---

test('ADDED #14: --allow-dirty parses, and defaults to false so an unattended tick is guarded', () => {
  // Registered in BOTH places or it is not a flag: the switch that sets it and the `parsed`
  // literal that declares it. Missing from the literal, `parsed.allowDirty` is `undefined` —
  // which is falsy, so the guard would appear to work while the flag silently did nothing.
  assert.equal(parseArgv(['work', '#4']).allowDirty, false);
  assert.equal(parseArgv(['work', '#4', '--allow-dirty']).allowDirty, true);
});

test('ADDED #14: a dirty tree exits 2 and never launches the worker', () => {
  // EXIT 2, NOT 1. Nothing was graded and nothing was spent — the operator's input is wrong, the
  // run is not. A scheduler reading this as a failed run would retry it at full price forever
  // against a tree that stays dirty; reading a failed run as this would stop retrying honest
  // work. That is the distinction the three codes exist for.
  const dir = repo();
  writeFileSync(join(dir, 'a.js'), 'export const a = 999;\n');
  const stub = workerStub();
  const r = run(
    ['work', 'anything', '--worker-bin', stub.path, '--run-root', mktemp('runs')],
    { cwd: dir },
  );

  assert.equal(r.status, EXIT.refused, `expected refused, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.throws(() => statSync(stub.argvFile), /ENOENT/, 'the worker was launched against a dirty tree');
  // The path, on stderr where refusals go, and the override named so the message is actionable.
  assert.match(r.stderr, /a\.js/, 'the refusal does not name the dirty path');
  assert.match(r.stderr, /--allow-dirty/, 'the refusal does not name its own override');
});

test('ADDED #14: --allow-dirty on the same dirty tree runs the worker', () => {
  // Same repository state as the test above; only the flag differs. Together they establish that
  // the flag moved the outcome — a pair of tests on different trees could not.
  const dir = repo();
  writeFileSync(join(dir, 'a.js'), 'export const a = 999;\n');
  const stub = workerStub();
  const r = run(
    ['work', 'anything', '--allow-dirty', '--worker-bin', stub.path, '--run-root', mktemp('runs')],
    { cwd: dir },
  );

  assert.notEqual(r.status, EXIT.refused, `--allow-dirty still refused:\n${r.stderr}`);
  assert.ok(statSync(stub.argvFile).size > 0, '--allow-dirty did not launch the worker');
});

test('ADDED #14: the dirty tree is unchanged after the refusal', () => {
  // Asserted through the real entrypoint, because the auto-clean this must not do would be a
  // convenience someone adds at the CLI layer — "refuse, but tidy up first" — where the unit
  // test on executeWork cannot see it.
  const dir = repo();
  writeFileSync(join(dir, 'a.js'), 'export const a = 999;\n');
  const stub = workerStub();
  run(['work', 'anything', '--worker-bin', stub.path, '--run-root', mktemp('runs')], { cwd: dir });

  assert.equal(readFileSync(join(dir, 'a.js'), 'utf8'), 'export const a = 999;\n', 'the CLI cleaned the tree');
});

test('usage names every subcommand parseArgv accepts', () => {
  // A subcommand that works and is undocumented is only reachable by reading the source; a
  // documented one that does not work is worse. Asserted against the parse rather than a list.
  const text = usage();
  for (const command of ['work', 'loop']) {
    assert.ok(text.includes(command), `usage omits '${command}'`);
  }
});

test('ADDED #14: every flag the parser accepts is in usage AND in SKILL.md', () => {
  // MEASURED ON THIS TASK. `--allow-dirty` was parsed, threaded, tested and shipped through a
  // green suite while SKILL.md still described seven flags — because nothing checked. SKILL.md is
  // the file a reader of this skill actually gets, and a refusal an operator has not been told
  // about is indistinguishable from a bug at 3am.
  //
  // THE FLAG LIST COMES FROM THE PARSER, not from a list typed here. A literal array would have
  // to be edited by the same person who forgot to edit the docs, which is no check at all. The
  // switch's `case '--x':` lines are the authoritative set: the parse refuses anything absent
  // from them, so a flag that works is a flag that appears there.
  const source = readFileSync(fileURLToPath(new URL('../lib/cli.mjs', import.meta.url)), 'utf8');
  const flags = [...source.matchAll(/case '(--[a-z-]+)':/g)].map((m) => m[1]);

  // The extraction itself is asserted before it is trusted. A regex that silently matched
  // nothing would make the loop below vacuous — the §"unfalsifiable conjunct" shape, where a
  // green result means the check could not fire rather than that it passed.
  assert.ok(flags.length >= 7, `only ${flags.length} flags found in the parser: ${flags}`);
  assert.ok(flags.includes('--allow-dirty'), 'the flag extraction missed a known flag');

  const usageText = usage();
  const skill = readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf8');
  for (const flag of flags) {
    // `-h` and `--help` share a case; `--help` is the documented spelling and the shorthand is
    // not load-bearing.
    assert.ok(usageText.includes(flag), `--help does not document '${flag}'`);
    assert.ok(skill.includes(flag), `SKILL.md does not document '${flag}'`);
  }
});

// SKILL.md's REF TABLE IS EXECUTED, not merely read. Same reasoning as the flag test above and the
// same measured cause: SKILL.md said "anything else is a prompt-sourced item" for a full commit
// after the jira path landed, which is precisely backwards under a jira config — there is no prompt
// path there, and following the doc would predict `ok: true` on a run the gate cannot grade.
//
// So every ref shape the doc ADVERTISES is resolved here, and every shape it says is REFUSED is
// refused. The fetcher is a stub: this asserts the parse, not the network.
test('ADDED: every ref shape SKILL.md advertises resolves, and every one it refuses is refused', async () => {
  const { resolveItem } = await import('../lib/item.mjs');
  const skill = readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf8');

  // The doc must still be making these claims — otherwise this test passes by describing a file
  // that no longer says any of it, which is the vacuous-green shape the flag test warns about.
  assert.match(skill, /browse\/TARS-1353/, 'SKILL.md no longer documents the browse-URL shape');
  assert.match(skill, /but only the docs part/, 'SKILL.md no longer documents the ref-alone refusal');

  const config = {
    source: { kind: 'jira', jira: { project: 'TARS', host: 'fandango.atlassian.net' } },
  };
  const issue = {
    key: 'TARS-1353',
    fields: { summary: 'Module runbook', description: '## Acceptance Criteria\n\n* it works\n' },
  };
  const runDir = mkdtempSync(join(tmpdir(), 'alfred-refdoc-'));
  const jiraFetch = async () => issue;

  for (const ref of ['TARS-1353', 'https://fandango.atlassian.net/browse/TARS-1353']) {
    const out = await resolveItem({ ref, config, runDir, jiraFetch });
    assert.equal(out.ok, true, `SKILL.md advertises ${JSON.stringify(ref)} but it was refused: ${out.error}`);
    assert.equal(out.item.id, 'TARS-1353');
  }

  for (const ref of [
    'TARS-1353 but only the docs part',
    'https://fandango.atlassian.net/browse/TARS-1353 but only the docs part',
    'https://someoneelse.atlassian.net/browse/TARS-1353',
  ]) {
    const out = await resolveItem({ ref, config, runDir, jiraFetch });
    assert.equal(out.ok, false, `SKILL.md says ${JSON.stringify(ref)} is refused, but it resolved`);
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
  assert.doesNotMatch(r.stdout, /--max-budget-usd/);
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
  // `claude`, so it writes no result JSON — but `executeWork` now generates a session id itself
  // and hands it to the worker via `--session-id` before the run starts, so there IS a known id,
  // and the failure this run hits is an unreadable transcript under that id, not a missing one.
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
  assert.match(`${result.stdout}${result.stderr}`, /transcript/i);
});

test('a priced record prints the figure, and prints the vendor figure beside it', () => {
  // The pass case, driven by a stub that emits the real `--output-format json` shape and by a
  // transcript planted where the formula says. Both numbers are printed because their agreeing
  // is the only evidence the copied price table is right — and an operator who can see only one
  // of them cannot notice the day they stop agreeing.
  //
  // THE ID IS NOT KNOWN UNTIL THE WORKER IS SPAWNED — `executeWork` generates it and hands it to
  // the worker via `--session-id`, so this test cannot plant a transcript under a hardcoded id in
  // advance. The stub reads its OWN `--session-id` argument back out of argv and writes the
  // transcript and its own result JSON under that id, the same way the real CLI's `session_id`
  // in its result JSON is the id it was told to use, not one it invented.
  const dir = repo();
  const home = mktemp('home');

  const projectDir = join(
    home,
    '.claude',
    'projects',
    realpathSync(dir).replace(/[^A-Za-z0-9]/g, '-'),
  );
  mkdirSync(projectDir, { recursive: true });

  const stub = workerStub({
    script: [
      'sid=""',
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--session-id" ]; then sid="$a"; fi',
      '  prev="$a"',
      'done',
      `cat > '${projectDir}/'"$sid"'.jsonl' <<'JSONL'`,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-31T19:00:00.000Z',
        message: { model: 'claude-sonnet-5', id: 'm1', usage: { input_tokens: 500000 } },
      }),
      'JSONL',
      'printf \'{"type":"result","session_id":"%s","total_cost_usd":0.5}\' "$sid"',
    ].join('\n'),
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

test('the record says where it landed, so an operator can go read it', () => {
  // The other half of #10. Persisting the record is worth nothing if the run's output does not
  // name the file: the whole defect was that everything except four printed fields reached
  // nothing, and an artifact an operator cannot find is the same audit gap one directory over.
  //
  // NOT asserted as "some line mentions the run dir" — the run dir is already printed. The path
  // to the record itself is the new information.
  const printed = [];
  reportRecord(
    { ok: true, error: null, gaps: [], cost: { total_usd: 1.5, vendor_usd: 1.5 } },
    { out: (line) => printed.push(line), recordPath: '/runs/20260801T090000Z-fix-the-thing/record.json' },
  );

  assert.match(printed.join('\n'), /\/runs\/20260801T090000Z-fix-the-thing\/record\.json/);
});

test('a record that could not be written says so AND still prints the cost', () => {
  // The falsifier for the line above, and it caught a defect in the first draft of this feature.
  //
  // A writer that printed the path it INTENDED to write would send an operator to a file that is
  // not there. But the first fix routed the write failure through `recordError`, which
  // early-returns with "FAILED to build" — so a record that built perfectly and merely could not
  // reach disk printed a false cause and SUPPRESSED THE COST LINE. That is the worst possible
  // response: an unwritten record makes the console the only surviving copy of the figures.
  //
  // A mutant found this, not this test. `out(\`saved to ${recordPath ?? 'record.json'}\`)` — the
  // unconditional print — survived, because the early return meant neither branch was reached.
  const printed = [];
  reportRecord(
    { ok: true, error: null, gaps: [], cost: { total_usd: 1.5, vendor_usd: 1.5 } },
    {
      out: (line) => printed.push(line),
      recordPath: null,
      recordWriteError: 'could not write record.json: ENOTDIR',
    },
  );

  const lines = printed.join('\n');
  assert.doesNotMatch(lines, /saved to/i, 'sent an operator to a file that was never written');
  assert.match(lines, /NOT SAVED — could not write record\.json/);
  // The load-bearing half: the figures survive the write failure.
  assert.match(lines, /\$1\.500000/, 'a failed write suppressed the only surviving copy of the cost');
  assert.doesNotMatch(lines, /FAILED to build/, 'blamed the reporter for a filesystem failure');
});

// ---------------------------------------------------------------------------
// A4: the sink's answer reaches the operator.
//
// `executeWork` has returned `result.sync` since the sink was wired, and `main` printed NONE of
// it. So a sync that silently failed — locked, push_failed, origin_mismatch — looked on the
// console exactly like one that landed, which is this project's recurring defect (#63/#69/#72/#73:
// computed and discarded) in the one field that says whether the accounting left the machine.
// ---------------------------------------------------------------------------

test('A4: a local-only sync SAYS it is local-only, rather than reading as an off-machine push', () => {
  const printed = [];
  reportSync({ synced: true, path: '/sink/log/skills/run-1.json', remote: null }, { out: (l) => printed.push(l) });
  const lines = printed.join('\n');
  assert.match(lines, /\/sink\/log\/skills\/run-1\.json/, 'the operator was not told where it landed');
  // The distinction, in words. `remote: null` is representable in the record; it has to be
  // legible on the console too, or "synced" is read as "safe off this machine".
  assert.match(lines, /local only|no remote/i, `a local-only sync read as a push: ${lines}`);
});

test('A4: a pushed sync names the remote, so the two outcomes are not one word', () => {
  const printed = [];
  reportSync(
    { synced: true, path: '/sink/log/skills/run-1.json', remote: 'https://example.invalid/x.git' },
    { out: (l) => printed.push(l) },
  );
  const lines = printed.join('\n');
  assert.match(lines, /https:\/\/example\.invalid\/x\.git/);
  assert.doesNotMatch(lines, /local only/i, 'a real push was labelled local-only');
});

test('A4: a FAILED sync says so with its reason — the outcome this most needs to stop hiding', () => {
  const printed = [];
  reportSync({ synced: false, reason: 'origin_mismatch: the sink at /sink has origin A' }, { out: (l) => printed.push(l) });
  const lines = printed.join('\n');
  assert.match(lines, /origin_mismatch/);
  assert.match(lines, /NOT SYNCED|failed/i, `a failed sync did not say it failed: ${lines}`);
});

test('A4: telemetry_not_configured is quiet — an unconfigured sink is not a failure to report', () => {
  // The falsifier for the line above. Most repos have no telemetry block at all; printing
  // "NOT SYNCED" on every one of those runs trains an operator to ignore the line that matters.
  const printed = [];
  reportSync({ synced: false, reason: 'telemetry_not_configured' }, { out: (l) => printed.push(l) });
  assert.deepEqual(printed, []);
  // And no sync at all (no record to sync) is likewise silent, not a phantom failure.
  reportSync(null, { out: (l) => printed.push(l) });
  assert.deepEqual(printed, []);
});

// --- B2: the preflight, through the ENTRYPOINT -------------------------------------------------
//
// run.test.mjs already asserts the composition with an injected spawn. This is the seam that
// injection cannot see, and [[feedback-mocked-seam-blindness]] is why it is written: the exit code
// is decided in `main`, printed by a real process, and read by whatever schedules a tick. Every
// piece here is real — a real `git` repo, a real `gh` on PATH, a real child writing a real
// stream-json log, and `bin/alfred` launched as a subprocess.
//
// A REFUSAL IS EXIT 1, NOT 2, and that is the whole point of the test. Exit 2 means "refused before
// spending" — a dirty tree, an unresolvable ref, a bad flag — and a scheduler is free to retry it.
// A preflight refusal happens AFTER the spawn: money was spent, a worker really ran, and it was
// stopped for what it said. Coded 2, an unattended loop would retry it at full price every tick.

// A `gh` on PATH that answers `issue view` with a body carrying real acceptance criteria. The
// criteria are EXTRACTED by lib/item.mjs from this body rather than written here, for the reason
// run.test.mjs gives: the AC1..ACn ids are that module's, and a hand-written id agrees with it only
// until it changes.
function ghStub(body) {
  const dir = mktemp('ghbin');
  const path = join(dir, 'gh');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" >> "$0.argv"',
      `cat <<'JSON'`,
      JSON.stringify({
        number: 9,
        title: 'uniform retries',
        body,
        url: 'https://github.com/acme/jarvis/issues/9',
      }),
      'JSON',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return { dir, path, argvFile: `${path}.argv` };
}

const AC_ISSUE_BODY =
  '## Acceptance Criteria\n' +
  '- retries are uniform across every channel\n' +
  '- the suite passes under npx vitest run\n';

// A worker that writes a stream-json first turn and then SLEEPS, so the poll has time to read the
// log and the SIGTERM has something to land on. `--session-id` is honoured by ignoring it: the stub
// is not the CLI, and what is under test is Alfred's reaction to the log, not the CLI's argv.
//
// THE TURN GOES IN A SIDECAR FILE AND THE STUB `cat`s IT, and the first draft did not — it inlined
// each line as `printf '%s\n' "<json>"`. `JSON.stringify` produces a DOUBLE-quoted shell string, and
// backticks are live command substitution inside double quotes in sh, so ```json ran as a command,
// `jsonn{"criteria":...` came back "command not found", and the text block reached the log EMPTY.
// The run then refused as `attestation-absent`, which is the correct verdict on the log the stub
// actually wrote — a passing-looking refusal for entirely the wrong reason, and the falsifier below
// is what exposed it. A `cat` of a file written by Node cannot be reinterpreted by a shell.
//
// `cat` also solves flushing for free: the stub does not need to `sync`, because `cat` is a separate
// process that exits, and the bytes are on disk before `sleep` begins. Without that the turn can sit
// in a builtin's stdio buffer for the whole sleep and the poll reads nothing.
function attestingWorkerStub({ criteria, sleep = 30 }) {
  const dir = mktemp('bin');
  const path = join(dir, 'fake-claude');
  // The real stream-json shape, same as run.test.mjs's `attestLog`: thinking, then text, then a
  // `user` event closing the turn. `spawnWorker` redirects the child's STDOUT to the log, so the
  // stub does not need to know the log path.
  const turn =
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
  writeFileSync(`${path}.turn`, turn);
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$0.argv"',
      'cat "$0.turn"',
      `sleep ${sleep}`,
      'exit 0',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return { path, argvFile: `${path}.argv` };
}

test('ADDED B2: a confabulated quote exits 1 through the real entrypoint, and says why', () => {
  const gh = ghStub(AC_ISSUE_BODY);
  const dir = repo();
  // AC1 is verbatim from the body; AC2 is invented. One true quote and one false one, so a
  // mechanism that refused on ANY attestation could not be told from one that reads the quotes.
  const stub = attestingWorkerStub({
    criteria: [
      { id: 'AC1', quote: 'retries are uniform across every channel', confidence: 0.9 },
      { id: 'AC2', quote: 'I will rewrite the whole retry subsystem from scratch', confidence: 0.9 },
    ],
  });

  const started = Date.now();
  const r = spawnSync(BIN, ['work', '#9', '--worker-bin', stub.path, '--run-root', mktemp('runs')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH}` },
  });
  const elapsed = Date.now() - started;

  // EXIT 1, AND IT IS OVER-DETERMINED HERE — measured, not assumed. Mutating the refusal's finding
  // rule to one the gate does not fail on kills `run.test.mjs`'s "a preflight refusal raises a gate
  // finding" and SURVIVES this test, because this worker also delivers nothing and `ac_unmapped`
  // fails the run on its own. So what this line pins is the exit CODE an operator and a scheduler
  // see; the causal link from the refusal to the verdict is pinned there, against an injected spawn,
  // where nothing else can fail the run. Making it causal here would need a stub that otherwise
  // PASSES — a real diff plus an ac_map — which is a test of the gate wearing a preflight costume.
  //
  // Not 2, and that is NOT over-determined: exit 2 is the pre-spawn refusal path, and no finding of
  // any kind can produce it.
  assert.equal(r.status, EXIT.gate_failed, `expected gate_failed, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.notEqual(r.status, EXIT.refused);

  // THE WORKER REALLY LAUNCHED. Without this the test passes identically if the spawn no-oped and
  // the refusal came from somewhere else entirely.
  assert.ok(statSync(stub.argvFile).size > 0, 'the worker never launched, so this is not a preflight refusal');

  // AND IT WAS STOPPED EARLY. The stub sleeps 30s; the wall cap is 25 MINUTES. Finishing well under
  // the sleep is the only proof that something killed it rather than that it ran to completion —
  // and it is the entire value proposition, since the alternative is paying for the full run.
  assert.ok(elapsed < 25_000, `the run took ${elapsed}ms — the worker was not stopped in flight`);

  // The operator can see the cause without opening the record.
  assert.match(r.stderr, /preflight REFUSED/i);
  assert.match(r.stderr, /quote-not-in-body/);
  assert.match(r.stderr, /AC2/);
});

test('ADDED B2: a truthful attestation is NOT stopped through the real entrypoint', () => {
  // The falsifier for the above, and the one that matters most here: if the watch fired on every
  // run, the test above would pass and Alfred would refuse every ticket it was ever given. A short
  // sleep because this worker is expected to run to completion.
  const gh = ghStub(AC_ISSUE_BODY);
  const dir = repo();
  const stub = attestingWorkerStub({
    criteria: [
      { id: 'AC1', quote: 'retries are uniform across every channel', confidence: 0.9 },
      { id: 'AC2', quote: 'the suite passes under npx vitest run', confidence: 0.85 },
    ],
    sleep: 3,
  });

  const r = spawnSync(BIN, ['work', '#9', '--worker-bin', stub.path, '--run-root', mktemp('runs')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH}` },
  });

  assert.ok(statSync(stub.argvFile).size > 0, 'the worker never launched');
  assert.doesNotMatch(r.stderr, /preflight REFUSED/i, 'a verbatim attestation was refused');
  // The exit code is NOT asserted to be 0. This worker attested honestly and then did no work, so
  // `ac_unmapped` fires and the gate correctly fails it — asserting 0 here would require a stub
  // that also delivers, which would be testing the gate rather than the preflight. What is asserted
  // is the thing under test: no refusal, and the run was allowed to finish.
});

// --- B3: DELIVERY, THROUGH THE ENTRYPOINT ------------------------------------------------------
//
// run.test.mjs asserts the wiring with the real `deliver` but against a `file://` remote, where the
// real `gh` correctly refuses to open a PR ("none of the git remotes point to a known GitHub host").
// That leaves exactly one proposition unproven anywhere: that the argv Alfred hands `gh pr create`
// carries `--draft` when the whole path runs for real. `delivery.test.mjs` asserts it against an
// injected recorder, which proves the module composes the flag but not that the flag survives the
// composed run — [[feedback-mocked-seam-blindness]] is about precisely that gap.
//
// SO THE SHIM HERE IS A RECORDER, NOT A REFUSER. `eval/gh-shim.sh` REFUSES `pr create` (it exists to
// keep sandbox code off real repositories), which means it cannot be reused: a refusal proves nothing
// about the argv that was refused. This one records the argv and answers with a plausible URL.
//
// WHAT THIS STILL DOES NOT PROVE, stated so the green is not read as more than it is: that GitHub
// honours `--draft`. Nothing local can establish that. What it establishes is that the flag is in the
// argv of a real subprocess, which is the entire part Alfred controls.
function ghDeliveryStub({ body, prUrl = 'https://github.com/acme/jarvis/pull/41' }) {
  const dir = mktemp('ghbin');
  const path = join(dir, 'gh');
  const argvFile = `${path}.argv`;
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      // EVERY invocation is appended, one argv per line with a blank line between calls, so a test
      // can tell "pr create was never called" from "pr create was called without --draft". A shim
      // that only recorded the last call could not.
      `printf '%s\\n' "$@" >> "${argvFile}"`,
      `printf '\\n' >> "${argvFile}"`,
      'if [ "$1 $2" = "pr create" ]; then',
      `  printf '%s\\n' '${prUrl}'`,
      '  exit 0',
      'fi',
      `cat <<'JSON'`,
      JSON.stringify({
        number: 9,
        title: 'uniform retries',
        body,
        url: 'https://github.com/acme/jarvis/issues/9',
      }),
      'JSON',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return { dir, path, argvFile };
}

// A repo with a REAL bare remote, so `git push` in the real `deliver` really has somewhere to go.
// `repo()` above deliberately has none — most tests want none — so this wraps it.
function repoWithRemote(opts) {
  const dir = repo(opts);
  const bare = mktemp('remote');
  git(bare, ['init', '--quiet', '--bare']);
  git(dir, ['remote', 'add', 'origin', `file://${bare}`]);
  git(dir, ['push', '--quiet', 'origin', 'main']);
  return { dir, bare };
}

// A worker that does the whole job: edits a file AND files the ac_map that lets the gate grade it.
// Every earlier stub in this file skips the ac_map, which is why none of them can produce a PASS —
// `ac_unmapped` fires on each criterion. A delivery test needs a real pass, because "pushes only on
// pass" is untestable end-to-end against a worker that can never pass.
function deliveringWorkerStub({ acs }) {
  const dir = mktemp('bin');
  const path = join(dir, 'fake-claude');
  const mapFile = join(dir, 'ac-map.json');
  // Written by Node and `cat`ed by the shell, for the reason `attestingWorkerStub` gives at length:
  // JSON inside a double-quoted sh string is reinterpreted by the shell.
  //
  // `kind` IS IMPORTED, NOT TYPED, and the first draft omitted it entirely — the map was filed, the
  // gate reported `ac_unmapped` on every criterion, and the run failed. That is `readAcMap` working
  // exactly as designed ("an unstamped object is not counted, so unrelated state under .alfred/
  // cannot read as a map"), and the failure is worth recording here because it also means the FAILING
  // test below initially passed for the wrong reason: no push, but because nothing could ever pass.
  // A literal 'alfred.ac-map' here would drift the same way #67 did.
  writeFileSync(mapFile, `${JSON.stringify({ kind: AC_MAP_KIND, entries: acs }, null, 2)}\n`);
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$0.argv"',
      // The work. `$PWD` is the repo — `spawnWorker` runs the child there.
      'mkdir -p src .alfred',
      'printf "%s\\n" "export const backoff = (n) => 2 ** n;" > src/backoff.js',
      `cat "${mapFile}" > .alfred/ac-map.json`,
      'exit 0',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return { path, argvFile: `${path}.argv` };
}

// AN ac_map THAT CAN ACTUALLY PASS, and getting here took two failures worth recording, because both
// were the gate correctly refusing to be fooled by a stub:
//
//   1. `{entries: [...]}` with no `kind` → `ac_unmapped` on every criterion. An unstamped object is
//      deliberately not counted (see `deliveringWorkerStub`).
//   2. `command: 'true'` → `mapping_implausible` x2 AND `unverified` x2. §8.1: a command that does not
//      mention the AC's subject at all is a finding, and `true` mentions nothing. The gate is telling
//      me my map is a rubber stamp, which it was.
//
// So each command NAMES ITS CRITERION and exits 0 on a real check of the tree. `grep -q` against the
// file the worker wrote is a genuine exit code over real bytes, not a `true` in costume — and it
// carries the subject words, so the plausibility rule is satisfied by substance rather than by
// padding the string.
const PASSING_AC_MAP = [
  { ac: 'AC1', command: 'grep -q backoff src/backoff.js # retries uniform across every channel' },
  { ac: 'AC2', command: 'test -f src/backoff.js # the suite passes under npx vitest run' },
];

test('ADDED B3: a PASSING run through bin/alfred pushes for real and opens a DRAFT pr', () => {
  const gh = ghDeliveryStub({ body: AC_ISSUE_BODY });
  const { dir, bare } = repoWithRemote();
  const stub = deliveringWorkerStub({ acs: PASSING_AC_MAP });

  const r = spawnSync(BIN, ['work', '#9', '--worker-bin', stub.path, '--run-root', mktemp('runs')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH}` },
  });

  assert.equal(r.status, EXIT.pass, `expected pass, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(statSync(stub.argvFile).size > 0, 'the worker never launched');

  // THE BYTES REACHED THE REMOTE. Read off the bare repo, not off Alfred's own output, because the
  // proposition is "somebody else can now fetch this" and only the remote can answer it.
  const branches = git(bare, ['branch', '--list', 'alfred/*']).trim();
  assert.notEqual(branches, '', `nothing reached the remote\n${r.stdout}\n${r.stderr}`);
  const branch = branches.replace(/^\*?\s*/, '');
  assert.match(git(bare, ['show', '--name-only', '--format=', branch]), /src\/backoff\.js/);

  // AND `--draft` IS IN THE REAL ARGV. The whole reason this test exists.
  const calls = readFileSync(gh.argvFile, 'utf8').split('\n\n').filter((c) => c.trim());
  const prCall = calls.find((c) => c.startsWith('pr\ncreate\n'));
  assert.ok(prCall, `gh pr create was never invoked\n${r.stdout}\n${r.stderr}`);
  const prArgs = prCall.split('\n');
  assert.ok(prArgs.includes('--draft'), `the PR was not opened as a draft: ${JSON.stringify(prArgs)}`);
  assert.ok(prArgs.includes('--base'), 'no base was named');
  assert.equal(prArgs[prArgs.indexOf('--base') + 1], 'main');
  assert.equal(prArgs[prArgs.indexOf('--head') + 1], branch);
  // NO MERGE, EVER — asserted on the argv of every call the shim recorded, not just the pr one.
  assert.ok(!calls.some((c) => c.startsWith('pr\nmerge\n')), 'the harness tried to merge its own PR');

  // The operator is told where it went without opening the record.
  assert.match(r.stdout + r.stderr, /https:\/\/github\.com\/acme\/jarvis\/pull\/41/);
});

test('ADDED B3: a FAILING run through bin/alfred pushes NOTHING and opens no pr', () => {
  // The falsifier, and the one with real consequences: if delivery ignored the verdict, Alfred would
  // push every run it ever made. The worker still does real work — so there IS something to push,
  // and it must not be pushed.
  //
  // THE FAILING RULE CHANGED ON 2026-08-03, AND THE VACUITY HAZARD DID NOT. This used to fail via
  // `ac_failed`: a worker-declared ac_map command exiting non-zero. That rule was deleted with the
  // AC join, so the failure is now sourced from `config.verify` — the rule that survived and is the
  // primary signal. `check_failed` is exactly what the ORIGINAL comment here predicted the wrong
  // rule would be, which is worth stating plainly rather than quietly reversing: it was the wrong
  // rule then because a different one was under test, and it is the right one now because it is the
  // only one left that can fail a run for its work rather than its paperwork.
  //
  // WHAT MUST NOT BE LOST is the reason that comment existed. The first draft of this test passed
  // for a vacuous reason — both criteria came back `ac_unmapped`, so nothing was pushed by a run
  // that could never have passed under any circumstances. A no-push test whose subject cannot pass
  // proves nothing about delivery reading the verdict. So the positive assertion below names the
  // rule, and the passing sibling test above proves this same wiring CAN push.
  const gh = ghDeliveryStub({ body: AC_ISSUE_BODY });
  // A verify command that exits non-zero over real bytes: it greps the file the worker writes for a
  // symbol the worker never puts there. `false` would fail too, but a check that cannot succeed
  // regardless of the tree is the rubber stamp inverted, and it would keep passing this test if the
  // gate stopped running verify commands at all.
  const { dir, bare } = repoWithRemote({
    config: { ...CONFIG, verify: { check: 'grep -q vitest src/backoff.js' } },
  });
  const stub = deliveringWorkerStub({ acs: PASSING_AC_MAP });

  const r = spawnSync(BIN, ['work', '#9', '--worker-bin', stub.path, '--run-root', mktemp('runs')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH}` },
  });

  assert.equal(r.status, EXIT.gate_failed, `expected gate_failed, got ${r.status}\n${r.stdout}\n${r.stderr}`);

  // IT FAILED FOR THE REASON THIS TEST IS ABOUT, and names the check so a gate that failed for any
  // other reason cannot satisfy this. The deleted rules are asserted absent too — if one is ever
  // reinstated and fires here, this test would otherwise keep passing while measuring something else.
  assert.match(r.stdout + r.stderr, /check_failed/, 'the run failed for some other reason than the check');
  for (const gone of ['ac_unmapped', 'ac_failed', 'mapping_implausible']) {
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(gone), `${gone} was deleted 2026-08-03`);
  }

  assert.equal(git(bare, ['branch', '--list', 'alfred/*']).trim(), '', 'a FAILED run reached the remote');

  const calls = readFileSync(gh.argvFile, 'utf8').split('\n\n').filter((c) => c.trim());
  assert.ok(!calls.some((c) => c.startsWith('pr\ncreate\n')), 'a failed run opened a pull request');

  // BUT THE WORK IS COMMITTED LOCALLY, which is the other half of the rule and the half that is easy
  // to lose: the run directory holds the log and the record, and the DIFF exists nowhere but here.
  // A branch is also what leaves the tree clean, so the next tick is not refused by this one.
  assert.notEqual(git(dir, ['branch', '--list', 'alfred/*']).trim(), '', 'the work was not committed anywhere');
  assert.equal(git(dir, ['status', '--porcelain']).trim(), '', 'the tree was left dirty for the next tick');
});

test('ADDED B3: never_merge: false REFUSES before the worker is ever launched', () => {
  // The refusal at its real point of use, through the real entrypoint. `config.mjs` checks
  // `never_merge` once at load; `delivery.mjs` checks it again because every caller in between holds
  // a plain object anything could have edited. This asserts the operator-visible consequence.
  //
  // EXIT 2, NOT 1: nothing was spent. And the worker's argv file must not exist — that is the proof.
  const gh = ghDeliveryStub({ body: AC_ISSUE_BODY });
  const { dir, bare } = repoWithRemote({
    config: { ...CONFIG, delivery: { mode: 'pr', never_merge: false } },
  });
  const stub = deliveringWorkerStub({ acs: [{ ac: 'AC1', command: 'true' }] });

  const r = spawnSync(BIN, ['work', '#9', '--worker-bin', stub.path, '--run-root', mktemp('runs')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH}` },
  });

  assert.equal(r.status, EXIT.refused, `expected refused, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.throws(() => statSync(stub.argvFile), /ENOENT/, 'a never_merge refusal spent money anyway');
  assert.equal(git(bare, ['branch', '--list', 'alfred/*']).trim(), '');
  assert.match(r.stderr, /never_merge/, 'the refusal does not name the key that caused it');
});

// --- B3: reportDelivery's four outcomes ---------------------------------------------------------
//
// Unit-level because the e2e above can only reach two of the four (pushed-with-pr, and committed-but-
// not-pushed). The other two — a delivery that failed outright, and a push whose PR did not open —
// are states a local test cannot produce against a working shim, and they are the two an operator is
// most likely to misread. Asserted on the STRINGS because the strings are the whole interface here.
const lines = (fn) => {
  const acc = [];
  fn((s) => acc.push(s));
  return acc.join('\n');
};

test('ADDED B3: nothing delivered and nothing wrong prints NOTHING', () => {
  // Same argument as `reportSync`'s unconfigured sink: a line on every no-op teaches the operator to
  // skip the line that means something.
  const out = lines((o) =>
    reportDelivery({ committed: false, branch: null, pushed: false, pr_url: null, error: null }, { out: o }),
  );
  assert.equal(out, '');
  // And a null delivery — a run from before B3, or one where the step never reached — is also silent.
  assert.equal(lines((o) => reportDelivery(null, { out: o })), '');
});

test('ADDED B3: a delivery that FAILED before committing says so, because the diff may exist nowhere', () => {
  const out = lines((o) =>
    reportDelivery(
      { committed: false, branch: null, pushed: false, pr_url: null, error: 'not a git repository' },
      { out: o },
    ),
  );
  assert.match(out, /NOT DELIVERED/);
  assert.match(out, /not a git repository/, 'the reason is not printed');
});

test('ADDED B3: committed-but-not-pushed names the branch AND says the verdict is why', () => {
  // The line an operator reads after a failed run. It must not look like delivery broke — the branch
  // is where the only copy of the work is, and the absent push is the rule working.
  const out = lines((o) =>
    reportDelivery(
      { committed: true, branch: 'alfred/tars-1351-abc', pushed: false, pr_url: null, error: null },
      { out: o },
    ),
  );
  assert.match(out, /alfred\/tars-1351-abc/, 'the branch holding the only copy is not named');
  assert.match(out, /gate did not pass/, 'nothing says WHY it was not pushed');
  assert.doesNotMatch(out, /NOT DELIVERED/, 'a committed run reads as undelivered');
});

test('ADDED B3: a PUSH whose pr FAILED still says the branch is on the remote', () => {
  // THE MOST IMPORTANT OF THE FOUR. The bytes are published; a line that led with the `gh` failure
  // would read as "nothing happened" when in fact a branch is out there for anyone to fetch.
  const out = lines((o) =>
    reportDelivery(
      {
        committed: true,
        branch: 'alfred/tars-1351-abc',
        pushed: true,
        pr_url: null,
        error: 'the branch was pushed but no PR was opened: gh: HTTP 422',
      },
      { out: o },
    ),
  );
  assert.match(out, /pushed/, 'a pushed branch does not say it was pushed');
  assert.match(out, /alfred\/tars-1351-abc/);
  assert.match(out, /pr was NOT opened/, 'nothing says the pr is missing');
  assert.match(out, /422/, 'the underlying reason is dropped');
});

test('ADDED B3: a pushed run with a pr prints the url and calls it a DRAFT', () => {
  const out = lines((o) =>
    reportDelivery(
      {
        committed: true,
        branch: 'alfred/tars-1351-abc',
        pushed: true,
        pr_url: 'https://github.com/acme/jarvis/pull/41',
        error: null,
      },
      { out: o },
    ),
  );
  assert.match(out, /https:\/\/github\.com\/acme\/jarvis\/pull\/41/);
  // "DRAFT" IN THE OPERATOR'S OUTPUT, not only in the argv and the PR body. The one-word summary of
  // the whole delivery policy, at the one place a human actually reads.
  assert.match(out, /DRAFT/i, 'the output does not say the pr is a draft');
});

test('ADDED B3: mode push with no pr wanted does not read as a failure', () => {
  // The falsifier for the test above it: `pushed: true, pr_url: null, error: null` is a SUCCESS under
  // `mode: 'push'`, and printing "NO pr" there would report a healthy run as a broken one.
  const out = lines((o) =>
    reportDelivery(
      { committed: true, branch: 'alfred/x', pushed: true, pr_url: null, error: null },
      { out: o },
    ),
  );
  assert.match(out, /pushed alfred\/x/);
  // ASSERTED ON THE FAILURE PHRASE, not on `/no pr/i`. The first draft used the latter and failed
  // against "(no pr requested)" — which was the assertion doing its job: the healthy string and the
  // failure string were one case-insensitive match apart, so `lib/cli.mjs` now says "the pr was NOT
  // opened" for the failure. A reader skimming the output can tell the two apart, and so can this.
  assert.doesNotMatch(out, /NOT opened/, 'a run that wanted no pr is reported as missing one');
  assert.doesNotMatch(out, /NOT DELIVERED/);
});

test('ADDED 2026-08-03: a run stopped short says so on the console, and a clean one stays silent', () => {
  // THE OPERATOR HALF of the `stop` field. `record: ok cost $6.030214` was the entire console
  // summary of `20260803T141200Z-7` — a run killed at the wall cap with 12 edits half-applied.
  // `ok` is correct there: it reports on the ACCOUNTING, and the accounting of a truncated run
  // succeeds. So the one line an operator reads said nothing about the run being cut off.
  //
  // NOT COVERED BY THE GATE'S FINDINGS, which do carry the prose: they print further down, and the
  // question "was this run complete?" should not require reading a rule name to answer.
  const capped = [];
  reportRecord(
    {
      ok: true, error: null, gaps: [], cost: { total_usd: 6.030214, vendor_usd: 6.352074599999998 },
      stop: { killed: true, reason: 'wall_cap', signal: 'SIGTERM', at_ms: 1500264 },
    },
    { out: (line) => capped.push(line) },
  );
  const lines = capped.join('\n');
  assert.match(lines, /STOPPED SHORT/, 'a capped run printed as an ordinary success');
  assert.match(lines, /wall_cap/);
  assert.match(lines, /1500s/, 'the operator is not told WHEN — a 4s stop and a 25min stop read alike');
  // The cost line survives, for `NOT SAVED`'s reason directly above: this is added information, not
  // a replacement, and a truncated run's spend is exactly the figure that must not be suppressed.
  assert.match(lines, /\$6\.030214/, 'the stop line suppressed the cost of the run that was cut off');

  // SILENT ON A CLEAN RUN — the falsifier, and the rule `reportSync`'s unconfigured sink follows: a
  // line printed on every tick is a line an operator learns to skip.
  const clean = [];
  reportRecord(
    {
      ok: true, error: null, gaps: [], cost: { total_usd: 1.5, vendor_usd: 1.5 },
      stop: { killed: false, reason: null, signal: null, at_ms: null },
    },
    { out: (line) => clean.push(line) },
  );
  assert.doesNotMatch(clean.join('\n'), /STOPPED SHORT/, 'a completed run was announced as stopped short');

  // AND A CLI-SIDE STOP IS ANNOUNCED TOO, though `killed` is false. This is the case a reader of the
  // boolean alone would miss: measured on TARS-1351, the CLI spent the whole budget and exited 0.
  const budget = [];
  reportRecord(
    {
      ok: true, error: null, gaps: [], cost: { total_usd: 8, vendor_usd: 8 },
      stop: { killed: false, reason: 'budget_exhausted', signal: null, at_ms: null },
    },
    { out: (line) => budget.push(line) },
  );
  assert.match(budget.join('\n'), /STOPPED SHORT: budget_exhausted/, 'a CLI-side truncation printed as a clean run');
});
