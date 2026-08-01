// webtarsthree-config — the TARGET repo's `.alfred/config.json`, tested as a claim.
//
// Same reasoning as `repo-config.test.mjs`: a config is data, and TDD's data exception
// covers its FORM, not its CLAIMS. Every `off_limits` entry asserts "writes here are
// denied", and this project has already shipped one that was not true — `dc72473`,
// `off_limits "src/vendor/" matched nothing, so the deny rule was silent`. A pattern
// matching no path in the target tree is indistinguishable from an absent one at runtime,
// and the failure direction is silent permission.
//
// WHY THIS FILE EXISTS SEPARATELY, and why it is not `repo-config.test.mjs` with a
// parameter. That file derives its root from its own location (`../..`), which is correct
// for skills and cannot express a second repository. The claims here are about a tree
// this suite does not contain, so the root is discovered and the whole file SKIPS when it
// is absent. A checkout on a machine without webtarsthree is not broken, and a suite that
// failed there is one people learn to run with a filter.
//
// WHAT MAKES THIS WORTH RUNNING AT ALL. `off_limits` is the only scope control that is
// live on the run path: MEASURED at `lib/run.mjs:472`, the gate call passes `config`,
// `repoRoot`, `acs`, `acMap`, `touched` and `diffstat` — and no `declaredScope`. So
// `checkScope` returns early on it and `scope_violation` cannot fire on a real run. The
// nine `off_limits` patterns below are therefore not defence in depth; they are the
// defence. (Recorded as its own task — the rule must not be left looking enforced.)
//
// NOT A SUBSTITUTE FOR THE GATE. Nothing here makes the filesystem read-only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, isOffLimits, resolveBase } from '../lib/config.mjs';
import { AC_MAP_PATH } from '../lib/acmap.mjs';
import { MARKER_PATH } from '../lib/blocked.mjs';

// A SIBLING of the skills checkout, not an absolute path in anyone's home directory. The
// suite must stay runnable on another machine; a hardcoded `/Users/...` would make this
// file pass only here and skip everywhere else, which reads as coverage.
const TARGET = join(fileURLToPath(new URL('../../..', import.meta.url)), 'webtarsthree');

// Present means the CONFIG is present, not merely the directory. A checkout of the repo
// with no config would otherwise fail every test below for a reason this file is not about
// — `loadConfig` refusing is its own tested behaviour.
const present = existsSync(join(TARGET, '.alfred', 'config.json'));
const loaded = () => loadConfig(TARGET);

const skipIfAbsent = (t) => {
  if (!present) {
    t.skip(`no webtarsthree config at ${TARGET} — nothing to check`);
    return true;
  }
  return false;
};

test('webtarsthree has a config that LOADS — the one alfred work refuses without', (t) => {
  if (skipIfAbsent(t)) return;
  const result = loaded();
  // The error, not just `ok`: a refusal names the key it refused for, and that is the
  // whole diagnostic.
  assert.equal(result.error ?? null, null, `config refused: ${result.error}`);
  assert.equal(result.config.repo, 'webtarsthree');
});

test('the epic is TARS-1350 on fandango.atlassian.net, parsed from the URL the operator pasted', (t) => {
  if (skipIfAbsent(t)) return;
  const { config } = loaded();
  const jira = config.source.jira;
  assert.equal(config.source.kind, 'jira');
  // The RAW url is asserted alongside the parse. A test that checked only `epic_keys`
  // would pass a config whose URL pointed at a different site with the right key in it.
  assert.deepEqual(jira.epics, ['https://fandango.atlassian.net/browse/TARS-1350']);
  assert.deepEqual(jira.epic_keys, ['TARS-1350']);
  assert.equal(jira.host, 'fandango.atlassian.net');
  // Only To Do is workable. Absent would mean the poller has no list — and picking up an
  // In Progress or Done ticket redoes work someone already shipped.
  assert.deepEqual(jira.statuses, ['To Do']);
});

test('verify is `npm test` and NOT `npm run lint` — lint is red on a clean checkout', (t) => {
  if (skipIfAbsent(t)) return;
  // MEASURED on a clean tree of this branch: `npm run lint` exits 1 with 6 errors, 4
  // warnings and 4 infos, and there is ZERO overlap between the files it flags and the
  // files any doc ticket touches. Declaring it would raise `check_failed` on every run
  // for a reason no worker caused — a gate that fails everything discriminates as poorly
  // as one that passes everything.
  const { config } = loaded();
  assert.equal(config.verify.test, 'npm test');
  for (const cmd of Object.values(config.verify)) {
    assert.doesNotMatch(cmd, /\blint\b/, `verify declares a lint command: ${cmd}`);
  }
  // And the script must EXIST, or the check fails for a third unrelated reason.
  const pkg = JSON.parse(
    spawnSync('cat', [join(TARGET, 'package.json')], { encoding: 'utf8' }).stdout,
  );
  assert.ok(pkg.scripts.test, 'package.json declares no test script');
});

test('every off_limits pattern covers a path that EXISTS in webtarsthree — no rule is inert', (t) => {
  if (skipIfAbsent(t)) return;
  // The `dc72473` lesson as a standing check, applied to the tree the patterns are ABOUT
  // rather than to this one. It is also why `**/*.snap` is not in the list: webtarsthree
  // has zero `.snap` files, so copying skills' deny list wholesale would have shipped a
  // pattern that denies nothing while reading in review as protection.
  const { config } = loaded();
  assert.ok(config.off_limits.length > 0, 'a config with no deny list denies nothing');
  for (const pattern of config.off_limits) {
    const target = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    assert.ok(
      existsSync(join(TARGET, target)),
      `off_limits "${pattern}" names nothing in webtarsthree — it would deny nothing`,
    );
    // Existing is not enough: the matcher must agree the pattern covers it.
    assert.ok(
      isOffLimits(config, target, TARGET),
      `off_limits "${pattern}" does not match its own target ${target}`,
    );
  }
});

test('src/ is denied to a DEPTH — every ticket says "any change under src/" is out of scope', (t) => {
  if (skipIfAbsent(t)) return;
  // Asserted on files DEEP in the subtree, not on the directory name. A bare pattern read
  // as one inode passes a directory check and permits every write underneath — the
  // `bareNameIsSubtree` failure direction, and it is silent.
  //
  // This is the deny that carries the doc tickets. All nine were written against a tree
  // whose route counts and h2 lists were measured from `src/`; a worker that edits `src/`
  // to satisfy a criterion has changed the thing the criterion describes.
  const { config } = loaded();
  for (const inside of [
    'src/server/app.js',
    'src/server/customer-service/router.js',
    'src/client/App.jsx',
    'src/client/utils/constants.js',
  ]) {
    assert.ok(existsSync(join(TARGET, inside)), `fixture path moved: ${inside}`);
    assert.ok(isOffLimits(config, inside, TARGET), `a worker could edit ${inside}`);
    // The absolute form too: a tool hands over an absolute path, and an unnormalized
    // compare answers "not off limits" and permits it.
    assert.ok(isOffLimits(config, join(TARGET, inside), TARGET), `absolute form permitted: ${inside}`);
  }
});

test('the config denies edits to ITSELF — the deny list is not self-amendable', (t) => {
  if (skipIfAbsent(t)) return;
  // Otherwise every rule above is advisory: a worker that can edit `off_limits` grants
  // itself any path in one move, and the gate scores the diff against rules the worker
  // just wrote. Same shape as `instrument_modified`, one level up.
  if (skipIfAbsent(t)) return;
  const { config } = loaded();
  assert.ok(isOffLimits(config, '.alfred/config.json', TARGET), 'the rules could rewrite themselves');
});

test('the DOCS are writable — the deny list has not denied the work itself', (t) => {
  if (skipIfAbsent(t)) return;
  // THE FALSIFIER for every test above, and it is not hypothetical: `isOffLimits`
  // returning true for everything would satisfy all of them. A worker with no writable
  // path cannot produce a diff, and a run with no diff can never be a gate_pass.
  //
  // These nine files are exactly what TARS-1351..1359 are graded on.
  const { config } = loaded();
  for (const mod of [
    'placements', 'uploader', 'hasher', 'redis-cache', 'rotten-tomatoes',
    'user-ratings', 'ems', 'campaigns', 'customer-service',
  ]) {
    const doc = `docs/modules/${mod}.md`;
    assert.ok(existsSync(join(TARGET, doc)), `${doc} is missing — a ticket grades a file that is not there`);
    assert.equal(isOffLimits(config, doc, TARGET), false, `${doc} is denied — the ticket cannot be satisfied`);
  }
  // And the marker the worker must write, which lives under the same `.alfred/` as the
  // config that IS denied. A directory-wide deny would take the ac-map with it and raise
  // `ac_unmapped` on every run.
  assert.equal(isOffLimits(config, AC_MAP_PATH, TARGET), false, 'the worker cannot write its own ac-map');
});

test('base resolves to master for TARS-1350 and for an item with no epic', (t) => {
  if (skipIfAbsent(t)) return;
  // master is webtarsthree's real default (`origin/HEAD -> origin/master`, measured), and
  // TARS-1350 is a doc epic with no feature branch of its own — unlike TARS-1271, whose
  // base was `feat/migrate-native-fetch-from-axios` and where guessing master would have
  // opened a PR against the wrong tree. The explicit `when_epic` rule is here so that
  // when the epic DOES get a branch, one line changes and nothing has to be re-derived.
  const { config } = loaded();
  assert.equal(resolveBase(config, { epic: 'TARS-1350' }), 'master');
  assert.equal(resolveBase(config), 'master');
});

test('delivery opens a PR and never merges', (t) => {
  if (skipIfAbsent(t)) return;
  const { config } = loaded();
  assert.equal(config.delivery.never_merge, true);
  assert.equal(config.delivery.mode, 'pr');
  assert.equal(config.branch_prefix, 'alfred/');
});

// ---------------------------------------------------------------------------
// The #15 markers, in the target repo. MEASURED there before this was written: neither
// marker was ignored, so both were committable — the same state that produced the
// original defect here.
//
// `--no-index` is load-bearing. `git check-ignore` consults the index by default, so a
// TRACKED file reports "not ignored" even when a pattern matches it. That is exactly the
// state the config assertion below exists to reject, and without the flag it passes.
// ---------------------------------------------------------------------------

const gitCheckIgnore = (path) => {
  const r = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', path], { cwd: TARGET });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`git check-ignore failed on ${path}: status=${r.status} ${r.stderr}`);
  }
  return r.status === 0;
};

test('the per-run markers are gitignored in webtarsthree — a run cannot inherit its predecessor’s map', (t) => {
  if (skipIfAbsent(t)) return;
  // The constants, not literals: a rename in acmap.mjs or blocked.mjs must break this
  // rather than leave it asserting a path nothing writes any more.
  assert.ok(gitCheckIgnore(AC_MAP_PATH), `${AC_MAP_PATH} is committable in webtarsthree`);
  assert.ok(gitCheckIgnore(MARKER_PATH), `${MARKER_PATH} is committable in webtarsthree`);
});

// AMENDED 2026-08-01. This test asserted `gitCheckIgnore('.alfred/config.json') === false` — that
// the config must stay committable — and it FAILED when the operator deliberately gitignored it,
// having decided webtarsthree's config stays local for now. The assertion was wrong in kind: whether
// this particular repo commits its config is the operator's call about their repository, not a
// property of Alfred that a test here should pin.
//
// WHAT IS NOT NEGOTIABLE IS THE FALSIFIER IT WAS CARRYING, and that survives unchanged: the ignore
// rules must name FILES, never bare `.alfred/`. The tempting one-liner sweeps in every future file
// under that directory, and because git keeps honouring an already-tracked path, the breakage stays
// invisible locally and lands on a FRESH CLONE where the config is absent and Alfred refuses to run.
// A local-by-choice config is fine; a directory-wide rule that silently captures the next file
// someone adds is not.
//
// The consequence the operator accepted is stated rather than tested, because it is true either way:
// a fresh clone of webtarsthree has no config, so `alfred work` there exits 2 until one is written.
test('the ignore rules name FILES, not the .alfred directory — a fresh clone must not lose future files', (t) => {
  if (skipIfAbsent(t)) return;
  const gitignore = readFileSync(join(TARGET, '.gitignore'), 'utf8');
  const rules = gitignore
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('.alfred'));

  // The extraction is asserted before it is trusted: zero matched rules would make the loop below
  // vacuous, passing on a .gitignore that says nothing about .alfred at all.
  assert.ok(rules.length > 0, `no .alfred rules found in webtarsthree/.gitignore: ${gitignore}`);

  for (const rule of rules) {
    assert.ok(
      /\.alfred\/.+/.test(rule),
      `"${rule}" ignores the whole .alfred directory; name the file instead, or a future ` +
        'per-run artifact is silently ignored and a fresh clone loses it',
    );
  }
});
