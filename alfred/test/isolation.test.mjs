// isolation — Alfred stands alone.
//
// The standing constraint: Alfred takes inspiration from `harness-core` and must not
// import from it or be imported by it. `harness-core` is untouched evidence for the
// experiments, and Alfred is meant to be the successor, not a wrapper.
//
// That rule lived in prose (PERSONA.md §8, SANDBOX.md §6) until a reader asked the
// obvious question: if arm B of Experiment 2 runs the four-phase pipeline, does Alfred
// still depend on it? The answer was no, but nothing in the repo proved it — the only
// way to check was to grep, and prose does not fail a build when someone adds an
// import. These tests are that proof, and they are what will catch the regression.
//
// The distinction they encode: `eval/` is experiment scaffolding and MAY reference
// harness-core, because measuring the thing you are replacing requires reaching it.
// `lib/` is Alfred's runtime and MUST NOT. A file that blurs the two is the bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALFRED = fileURLToPath(new URL('..', import.meta.url));

// Any sibling-directory escape, not just harness-core by name. A future
// `harness-plan` or a reach into the repo root would be the same mistake.
const ESCAPES_ALFRED = /(?:from|import|require)\s*\(?\s*['"`]\.\.\/\.\.\//;
const NAMES_HARNESS = /harness-(?:core|plan|implement|loop)/;

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(join(ALFRED, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(join(dir, entry.name))));
    } else if (['.mjs', '.js', '.cjs'].includes(extname(entry.name))) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

async function read(relative) {
  return readFile(join(ALFRED, relative), 'utf8');
}

// --- the runtime boundary ---

test('no file in lib/ imports from outside alfred/', async () => {
  const offenders = [];
  for (const file of await sourceFiles('lib')) {
    const src = await read(file);
    if (ESCAPES_ALFRED.test(src)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    'lib/ is Alfred\'s runtime and must be self-contained. Experiment scaffolding ' +
      'that needs to reach harness-core belongs in eval/.',
  );
});

test('no file in lib/ imports a harness-* module by name', async () => {
  // Separate from the path check: a package-style specifier (`harness-core/x`) would
  // pass a `../../` scan while being exactly the dependency this forbids. One
  // assertion covering both would leave whichever half fired second untested.
  const offenders = [];
  for (const file of await sourceFiles('lib')) {
    for (const line of (await read(file)).split('\n')) {
      const isImport = /^\s*(?:import|export)\s|require\s*\(/.test(line);
      if (isImport && NAMES_HARNESS.test(line)) offenders.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'lib/ must not import any harness-* module');
});

test('no file in lib/ reaches harness-core by filesystem path', async () => {
  // The check the first two miss, and the one that actually mattered. Alfred's real
  // coupling was `new URL('../../harness-core/config/user.json')` — a path, not an
  // import. Both import checks passed with that line sitting in lib/, which is a
  // reminder that a guard aimed at the wrong syntax is indistinguishable from no
  // guard: green, and blind.
  const offenders = [];
  for (const file of await sourceFiles('lib')) {
    for (const [n, line] of (await read(file)).split('\n').entries()) {
      // Comments may discuss harness-core freely — the design history is worth
      // keeping. Only executable references are the violation.
      const isComment = /^\s*(?:\/\/|\*|\/\*)/.test(line);
      if (!isComment && NAMES_HARNESS.test(line)) offenders.push(`${file}:${n + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'lib/ must not resolve a path into harness-core. Move it to eval/.',
  );
});

test('lib/ declares no third-party dependency', async () => {
  // The sidecar (telemetry) is the only external thing an Alfred run hooks up to, and
  // it is reached by writing files, not by importing a package. Anything else here
  // means a new install step for a tool meant to run unattended.
  const offenders = [];
  for (const file of await sourceFiles('lib')) {
    for (const line of (await read(file)).split('\n')) {
      const match = /^\s*import\s[^'"`]*['"`]([^'"`]+)['"`]/.exec(line);
      if (!match) continue;
      const specifier = match[1];
      const bare = !specifier.startsWith('.') && !specifier.startsWith('node:');
      if (bare) offenders.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(offenders, [], 'lib/ may use node: built-ins and relative imports only');
});

// --- the experiment boundary, stated rather than assumed ---

test('eval/ is where the harness-core reference lives, and it is only there', async () => {
  // Positive assertion, deliberately: it would be easy to satisfy every check above by
  // deleting the arm-B scaffolding, which would silently drop the control group. This
  // fails if the reference vanishes as well as if it spreads.
  const evalFiles = await sourceFiles('eval');
  const referencing = [];
  for (const file of evalFiles) {
    if (NAMES_HARNESS.test(await read(file))) referencing.push(file);
  }
  assert.ok(evalFiles.length > 0, 'eval/ should hold the experiment scaffolding');
  assert.ok(
    referencing.length > 0,
    'eval/ should contain the arm-B alias helper. If arm B was retired on purpose, ' +
      'delete this test and record the decision in PLAN.md §2 — do not leave the ' +
      'experiment silently unrunnable.',
  );
});

test('nothing in harness-core references alfred', async () => {
  // The dependency must not run the other way either: harness-core is evidence, and an
  // edit to it invalidates every comparison the experiments make.
  const root = fileURLToPath(new URL('../../harness-core', import.meta.url));
  let entries;
  try {
    entries = await readdir(root);
  } catch {
    // Alfred is meant to survive harness-core being absent — that is the whole point.
    // A missing sibling is a pass, not a skip.
    return;
  }
  assert.ok(entries.length > 0);

  const { execFileSync } = await import('node:child_process');
  let hits = '';
  try {
    hits = execFileSync(
      'grep',
      ['-rli', '--exclude-dir=node_modules', '--exclude-dir=.git', 'alfred', root],
      { encoding: 'utf8' },
    );
  } catch (err) {
    // grep exits 1 on no match, which is the outcome we want.
    if (err.status !== 1) throw err;
  }
  assert.equal(hits.trim(), '', `harness-core must not reference alfred:\n${hits}`);
});
