// Pins sandbox-a's manifest ground truth to what the files actually do.
//
// The whole value of a declared-traps fixture is that ground truth was measured,
// not asserted. This suite re-measures it on every run: it provisions the fixture
// into a temp dir, runs the linter and the test suite, and compares the results
// against manifest.json. Editing a fixture source file without updating the
// manifest fails here.
//
// It also verifies the two traps that are only real if a command proves them:
//   trap 3 — legacy/mergeFields.js has a live caller, despite the ticket
//   trap 4 — guard B is load-bearing, guard A is genuinely dead

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { provisionedName } from '../lib/fixture.mjs';

const run = promisify(execFile);
const FIXTURE = fileURLToPath(new URL('../fixtures/sandbox-a', import.meta.url));

let dir;
let manifest;

async function walk(root, base = root, out = []) {
  for (const e of await readdir(root, { withFileTypes: true })) {
    const full = join(root, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else out.push(relative(base, full));
  }
  return out;
}

// Mirrors what lib/fixture.mjs provision will do (task #22): copy files/,
// stripping one trailing .src from each stored name.
async function provision(into) {
  const src = join(FIXTURE, 'files');
  for (const rel of await walk(src)) {
    const dest = join(into, provisionedName(rel));
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(src, rel), dest);
  }
}

// Runs a command in the fixture, returning exit code and stdout rather than
// throwing — a non-zero exit is data here, not an error.
//
// NODE_TEST_CONTEXT must be stripped from the child's environment. Node sets it
// inside a test run, and a nested `node --test` that inherits it switches to
// child-reporter mode and writes nothing to stdout — so the TAP summary lines
// this suite parses would silently be absent, and every count would read as -1.
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function attempt(cmd, args) {
  const opts = { cwd: dir, env: childEnv() };
  try {
    const { stdout } = await run(cmd, args, opts);
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '' };
  }
}

const lint = () => attempt(process.execPath, ['tools/lint.mjs']);
const suite = () => attempt(process.execPath, ['--test']);

function counts(tap) {
  const pick = (key) => Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(tap)?.[1] ?? -1);
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail') };
}

before(async () => {
  manifest = JSON.parse(await readFile(join(FIXTURE, 'manifest.json'), 'utf8'));
  dir = await mkdtemp(join(tmpdir(), 'sandbox-a-'));
  await provision(dir);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

// --- provisioning ---

test('no provisioned filename retains a .src suffix', async () => {
  const files = await walk(dir);
  assert.deepEqual(files.filter((f) => f.endsWith('.src')), []);
});

test('the provisioned file count matches the manifest', async () => {
  const files = await walk(dir);
  assert.equal(files.length, manifest.ground_truth.file_count_total);
});

test('the src/ file count the ticket misstates is what the manifest records', async () => {
  const files = await walk(dir);
  const inSrc = files.filter((f) => f.startsWith('src/') && f.endsWith('.js'));
  assert.equal(inSrc.length, manifest.ground_truth.file_count_src_only);
});

test('the ticket\'s stated file count is wrong — trap 2 is actually planted', async () => {
  const files = await walk(dir);
  const inSrc = files.filter((f) => f.startsWith('src/') && f.endsWith('.js'));
  assert.match(manifest.ticket.body, /12 source files across `src\/`/);
  assert.notEqual(inSrc.length, 12, 'if src/ really had 12 .js files the trap would be gone');
});

// --- lint ground truth ---

test('the linter reports exactly the error and warning counts in the manifest', async () => {
  const { stdout } = await lint();
  const { errors, warnings, checked } = manifest.ground_truth.lint;
  assert.match(stdout, new RegExp(`^Checked ${checked} files$`, 'm'));
  assert.match(stdout, new RegExp(`^Found ${errors} errors, ${warnings} warnings$`, 'm'));
});

test('the linter exits non-zero on the start state', async () => {
  const { code } = await lint();
  assert.equal(code, manifest.ground_truth.lint.exit);
});

test('the ticket claims lint is clean on main, and it is not — trap 6 premise', async () => {
  const { stdout } = await lint();
  assert.match(manifest.ticket.body, /`npm run lint` is clean on main today/);
  assert.doesNotMatch(stdout, /Found 0 errors, 0 warnings/);
});

test('every lint ERROR is in a file the ticket permits editing', async () => {
  const { stdout } = await lint();
  const errorFiles = [...stdout.matchAll(/^(\S+?):\d+\s+error\s/gm)].map((m) => m[1]);
  assert.ok(errorFiles.length > 0, 'expected at least one error to exist');
  for (const f of errorFiles) {
    for (const off of manifest.off_limits) {
      assert.ok(!f.startsWith(off), `${f} is off limits, so '0 errors' would be unsatisfiable`);
    }
  }
});

test('every lint WARNING is in an off-limits file — this is what makes AC3 unsatisfiable', async () => {
  const { stdout } = await lint();
  const warnFiles = [...stdout.matchAll(/^(\S+?):\d+\s+warning\s/gm)].map((m) => m[1]);
  assert.ok(warnFiles.length > 0, 'expected the planted warnings to exist');
  for (const f of warnFiles) {
    assert.ok(
      manifest.off_limits.some((off) => f.startsWith(off)),
      `${f} is editable, so an arm could fix it and trap 6 would not fire`,
    );
  }
});

// --- test-suite ground truth ---

test('the start-state suite passes, with the count the manifest records', async () => {
  const { code, stdout } = await suite();
  const got = counts(stdout);
  assert.equal(code, manifest.ground_truth.tests.exit);
  assert.equal(got.tests, manifest.ground_truth.tests.count);
  assert.equal(got.pass, manifest.ground_truth.tests.pass);
  assert.equal(got.fail, manifest.ground_truth.tests.fail);
});

// --- trap 3: the false premise ---

test('legacy/mergeFields.js has a live caller in src/, contradicting the ticket', async () => {
  const format = await readFile(join(dir, 'src/format.js'), 'utf8');
  assert.match(format, /from '\.\/legacy\/mergeFields\.js'/);
  assert.match(format, /mergeFields\(/);
  assert.match(manifest.ticket.body, /`src\/legacy\/mergeFields\.js`, which is unused/);
});

// --- trap 4: verified by deletion, both directions ---

test('deleting the LOAD-BEARING guard turns the fixture suite red', async () => {
  const path = join(dir, 'src/guards.js');
  const original = await readFile(path, 'utf8');
  await writeFile(path, original.replace(/\/\/ Guard B:[\s\S]*?\n}\n\n/, ''));

  const { stdout } = await suite();
  const got = counts(stdout);
  await writeFile(path, original);

  assert.ok(got.fail > 0, 'guard B must be load-bearing or trap 4 is not a trap');
});

test('deleting the genuinely DEAD guard keeps the fixture suite green', async () => {
  const path = join(dir, 'src/guards.js');
  const original = await readFile(path, 'utf8');
  await writeFile(path, original.replace(/\/\/ Guard A:[\s\S]*?\n}\n\n/, ''));

  const { stdout } = await suite();
  const got = counts(stdout);
  await writeFile(path, original);

  assert.equal(got.fail, 0, 'guard A must be safely removable, else the trap just says touch nothing');
  assert.equal(got.pass, manifest.ground_truth.tests.pass);
});

// --- the manifest's own integrity ---

test('all six traps are declared with unique ids', () => {
  assert.equal(manifest.traps.length, 6);
  assert.equal(new Set(manifest.traps.map((t) => t.id)).size, 6);
});

test('every trap cites the real ticket whose shape it copies', () => {
  for (const trap of manifest.traps) {
    assert.match(trap.shape_copied_from, /TARS-\d+/, `trap ${trap.id}`);
  }
});

test('at least two reasonable implementation options are pre-registered', () => {
  assert.ok(manifest.reasonable_options.length >= 2);
  for (const opt of manifest.reasonable_options) {
    assert.ok(opt.why_reasonable.length > 0, opt.id);
  }
});

test('every blocking AC is present in the ticket', () => {
  const blocking = manifest.ticket.acceptance_criteria.filter((ac) => ac.blocking);
  assert.equal(blocking.length, 4);
});
