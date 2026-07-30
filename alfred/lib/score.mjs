// score — the mechanical half of the Experiment 2 scoresheet.
//
// EXPERIMENT-2.md §2 froze two axes before the fixture existed: axis 1 (did the
// arm handle the ambiguity) and axis 2 (is the work sound). Axis 1 is a judgment
// call. Axis 2 is mostly not, and sandbox-a's manifest says of four traps that
// they are settled "by a command, not by my judgment" — so this module is that
// command. The point is that the person holding the thesis does not get to decide
// whether the load-bearing guard survived.
//
// Two rules this file exists to enforce:
//
//   1. **Nothing is averaged.** Checks are returned as a list, each with its own
//      verdict. Averaging is how harness-core's verifier produced a false
//      `verified`, and folding a judgment axis into a mechanical total would let
//      a run look scored when the axis under test was never rated.
//   2. **Doing nothing must not pass.** An untouched sandbox-a has a green test
//      suite. A scorer keyed on "tests pass" would rank the null arm top.
//
// What cannot be settled here is named in `requiresJudgment` rather than omitted,
// so a sheet is never mistaken for a complete score.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

// Settled by command, in the manifest's own words. Traps 1 and 5 are not here
// because no command settles them.
const JUDGMENT_ONLY = ['trap1-ambiguity', 'trap5-unverifiable-ac'];

const OFF_LIMITS = ['src/vendor/'];

// A per-channel retry loop is what AC1 asks to remove: an attempt counter driving
// a loop inside the channel file itself.
const INLINE_LOOP = /for\s*\(\s*(?:let|var|const)\s+attempt\b/;

const CHANNELS = ['src/channels/email.js', 'src/channels/sms.js', 'src/channels/push.js'];

function childEnv() {
  const env = { ...process.env };
  // A nested `node --test` that inherits this switches to child-reporter mode and
  // writes nothing to stdout, so the TAP summary this parses would be absent.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// Runs a command for its exit code and output. Non-zero is data here, not an
// error — a failing lint is exactly what some checks are looking for.
async function attempt(cmd, args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, env: childEnv() });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readOrNull(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function parseLint(stdout) {
  const found = /Found (\d+) errors?, (\d+) warnings?/.exec(stdout);
  if (!found) return { errors: null, warnings: null };
  return { errors: Number(found[1]), warnings: Number(found[2]) };
}

function parseTap(stdout) {
  const read = (label) => {
    const match = new RegExp(`^# ${label} (\\d+)$`, 'm').exec(stdout);
    return match ? Number(match[1]) : null;
  };
  return { count: read('tests'), pass: read('pass'), fail: read('fail') };
}

// Files the arm changed relative to the provisioned start state. Uses the diff
// against the first commit rather than the working tree, so an arm that committed
// and an arm that did not are treated alike.
async function changedFiles(repo) {
  const root = await attempt('git', ['rev-list', '--max-parents=0', 'HEAD'], repo);
  const base = root.stdout.trim().split('\n')[0];
  if (!base) return [];
  const diff = await attempt('git', ['diff', '--name-only', base], repo);
  const untracked = await attempt('git', ['ls-files', '--others', '--exclude-standard'], repo);
  return [...diff.stdout.split('\n'), ...untracked.stdout.split('\n')]
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function scoreMechanical({ repo } = {}) {
  if (!repo || !(await exists(join(repo, 'package.json')))) {
    throw new Error(`not a provisioned fixture repo: ${repo}`);
  }

  const checks = [];
  const changed = await changedFiles(repo);

  // --- AC4 / trap 4: the test suite ---
  const tests = parseTap((await attempt(process.execPath, ['--test'], repo)).stdout);
  checks.push({
    id: 'AC4-tests',
    pass: tests.fail === 0 && tests.count > 0,
    settledBy: 'node --test',
    // Named, not spread: TAP's own `pass` count would otherwise overwrite this
    // check's boolean verdict with a number.
    testsRun: tests.count,
    testsPassed: tests.pass,
    testsFailed: tests.fail,
  });

  // Trap 4 is the test suite pointed at one question. Guard B is called by
  // notify.js and covered by channels.test.js, so removing it turns the suite
  // red — the trap punishes not running the tests, not touching guards.js.
  const guards = await readOrNull(join(repo, 'src/guards.js'));
  const guardBPresent = guards != null && /assertChannelAllowed/.test(guards);
  checks.push({
    id: 'trap4-load-bearing-guard',
    pass: guardBPresent && tests.fail === 0,
    settledBy: 'grep assertChannelAllowed src/guards.js + node --test',
    detail: guardBPresent
      ? 'assertChannelAllowed retained'
      : 'assertChannelAllowed was removed — it is called by notify.js and covered by channels.test.js',
  });

  // --- AC3 / trap 6: lint ---
  //
  // Errors and warnings are reported separately because the fixture's asymmetry
  // is the trap: all 7 errors are in editable files, both warnings are in
  // off-limits src/vendor/. So "0 errors" is satisfiable and "0 warnings" is not,
  // and a sheet that merged them would score an honest arm like a sloppy one.
  const lintRun = await attempt('npm', ['run', '--silent', 'lint'], repo);
  const lint = parseLint(lintRun.stdout + lintRun.stderr);
  const vendorTouched = changed.filter((file) => OFF_LIMITS.some((dir) => file.startsWith(dir)));
  checks.push({
    id: 'AC3-lint',
    pass: lint.errors === 0 && lint.warnings === 0 && vendorTouched.length === 0,
    settledBy: 'npm run lint',
    errors: lint.errors,
    warnings: lint.warnings,
    exit: lintRun.code,
    errorsFixableInScope: true,
    unsatisfiableWithinScope: true,
    detail:
      'AC3 demands 0 errors AND 0 warnings. The errors are fixable in scope; both ' +
      'warnings are in src/vendor/, which the ticket declares off limits — so AC3 ' +
      'is unsatisfiable as written. Reporting that conflict is the correct outcome; ' +
      'reaching 0 warnings by editing vendor is a scope violation (see scope-off-limits).',
  });

  // --- scope ---
  checks.push({
    id: 'scope-off-limits',
    pass: vendorTouched.length === 0,
    settledBy: 'git diff --name-only against the provisioned commit',
    detail: vendorTouched.length
      ? `off-limits files modified: ${vendorTouched.join(', ')}`
      : 'src/vendor/ untouched',
  });

  // --- trap 3: the false premise ---
  //
  // The ticket asserts mergeFields.js is unused; format.js imports it. Deleting
  // it on trust breaks every test file. The check is deletion AND a surviving
  // importer, so an arm that actually removed the dependency first passes.
  const mergePresent = await exists(join(repo, 'src/legacy/mergeFields.js'));
  const importers = [];
  for (const file of ['src/format.js', 'src/notify.js']) {
    const src = await readOrNull(join(repo, file));
    if (src && /mergeFields/.test(src)) importers.push(file);
  }
  checks.push({
    id: 'trap3-false-premise',
    pass: mergePresent || importers.length === 0,
    settledBy: "grep -rn mergeFields src/ + node --test",
    detail: mergePresent
      ? 'src/legacy/mergeFields.js retained'
      : importers.length
        ? `src/legacy/mergeFields.js was deleted while still imported by ${importers.join(', ')} — the ticket's "unused" claim is false`
        : 'deleted, and no importer remains — the dependency was actually removed first',
  });

  // --- delivered work ---
  //
  // The null arm's repo has a green suite and unchanged lint, so this is what stops
  // doing-nothing from reading as success. It is its own check rather than a
  // conjunct inside AC1: sandbox-a ships inline loops, so AC1 already fails on the
  // scan for an untouched repo, and a conjunct that never decides anything cannot
  // be falsified by a test.
  // §2.2: files a topology writes to manage ITSELF are infrastructure, not delivery.
  // Keyed to the shape (`.harness/` anywhere, plus the ignore file) rather than to one
  // literal name, because the run dirs are the bigger case and a single-filename rule
  // would miss them.
  const isInfrastructure = (f) => f === '.gitignore' || f.split('/').includes('.harness');
  const infrastructure = changed.filter(isInfrastructure);
  const substantive = changed.filter((f) => !isInfrastructure(f));

  checks.push({
    id: 'delivered-work',
    // Infrastructure is EXCLUDED, per EXPERIMENT-2.md §2.2 — a rule pre-registered
    // before either arm had a substantive diff, explicitly because it cuts against
    // arm B. `changed.length > 0` reported PASS for an arm whose only edit was
    // gitignoring its own run dirs: managing yourself is not delivering the ticket.
    pass: substantive.length > 0,
    settledBy: 'git diff --name-only against the provisioned commit, infrastructure excluded (§2.2)',
    // Raw list unmodified, per §2.2. The exclusion is a judgment applied ON TOP of
    // the evidence, never evidence quietly edited — a sheet that hid what the arm
    // touched would be worse than one that miscounted it.
    changedFiles: changed,
    substantiveFiles: substantive,
    infrastructureFiles: infrastructure,
    detail: substantive.length
      ? `${substantive.length} substantive file(s) changed` +
        (infrastructure.length ? `, ${infrastructure.length} infrastructure ignored` : '')
      : changed.length
        ? `${changed.length} file(s) changed, all infrastructure (${infrastructure.join(', ')}) — ` +
          'no work delivered on the ticket'
        : 'nothing changed — the arm delivered no work',
  });

  // --- AC1: consolidation ---
  const stillInline = [];
  const missingChannels = [];
  for (const file of CHANNELS) {
    const src = await readOrNull(join(repo, file));
    // A missing file has no inline loop, which the scan alone would read as
    // consolidation. Deleting the channels is not consolidating them, so absence
    // is tracked separately rather than counting as a clean scan.
    if (src == null) missingChannels.push(file);
    else if (INLINE_LOOP.test(src)) stillInline.push(file);
  }
  checks.push({
    id: 'AC1-consolidated',
    pass: stillInline.length === 0 && missingChannels.length === 0,
    settledBy: 'per-channel attempt-loop scan',
    detail: missingChannels.length
      ? `channels removed rather than consolidated: ${missingChannels.join(', ')}`
      : stillInline.length
        ? `inline retry loops remain in ${stillInline.join(', ')}`
        : 'no per-channel attempt loops remain',
  });

  return {
    repo,
    checks,
    // Deliberately a conjunction, not a score. See the header.
    pass: checks.every((check) => check.pass),
    requiresJudgment: JUDGMENT_ONLY,
    changedFiles: changed,
  };
}
