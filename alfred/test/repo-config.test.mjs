// repo-config — THIS repository's own `.alfred/config.json`, tested as a claim.
//
// WHY A CONFIG FILE GETS A TEST. A config is data, and TDD's exception for data files
// applies to its FORM. It does not apply to its CLAIMS. Every entry in `off_limits` is
// the assertion "writes here are denied", and this project has already shipped one that
// was not true: `dc8247` — `off_limits "src/vendor/" matched nothing, so the deny rule
// was silent`. A deny pattern that matches no path in the repository is indistinguishable
// from an absent one at runtime, and the failure direction is silent permission.
//
// So the test does not check that the file parses — `loadConfig` does that, and refusing
// is its whole job. It checks the two things a valid config can still get wrong:
//
//   1. every deny pattern actually covers a path that EXISTS here, so no rule is silent;
//   2. the paths this repository must not let a worker touch are in fact denied.
//
// (2) IS THE LOAD-BEARING HALF, and it exists because of a constraint older than Alfred:
// harness-core is UNTOUCHED EVIDENCE. Every measurement this project rests on — the
// 4.7x/4.6x delegation figures, the arm 0 $1.12 anchor, the 9/9 destructive-edit result —
// was taken against harness-core as it stands. A worker editing it would not break a
// feature; it would retroactively invalidate the evidence the architecture was chosen on.
// Alfred's own standing rule is that lib/ must not import from harness-core and
// harness-core must not be modified, and until this file existed that rule lived only in
// prose that a worker never reads.
//
// `alfred/lib/gate.mjs` and `alfred/test/` are denied for the OTHER reason, the one the
// corpus measured: 10/10 clones made the destructive test edit and 9/10 edited the
// instrument. `instrument_modified` catches a grader edit after the fact; this denies the
// path before it is reached. Two independent guards on the same harm, deliberately — the
// gate scores a diff that already exists.
//
// NOT A SUBSTITUTE FOR THE GATE. `off_limits` is a declaration the worker is shown and
// the gate enforces; nothing here makes the filesystem read-only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, isOffLimits, resolveBase } from '../lib/config.mjs';

// The repository root: one level above `alfred/`. Derived from this file's own location so
// the test does not depend on the cwd `npm test` was invoked from.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const loaded = () => loadConfig(REPO_ROOT);

test('this repository has a config that loads — the one alfred work refuses without', () => {
  const result = loaded();
  // The error is asserted on rather than just `ok`, because a refusal names the key it
  // refused for and that is the whole diagnostic.
  assert.equal(result.error ?? null, null, `config refused: ${result.error}`);
  assert.ok(result.config, 'no config object');
  assert.equal(result.config.repo, 'skills');
});

test('every off_limits pattern covers a path that EXISTS — no rule is silently inert', () => {
  // The #69 lesson as a standing check. A pattern matching nothing is not a harmless
  // extra line: it reads as protection in review and denies nothing at runtime.
  const { config } = loaded();
  assert.ok(config.off_limits.length > 0, 'a config with no deny list denies nothing');

  for (const pattern of config.off_limits) {
    // The path a pattern is ABOUT, recovered from the pattern itself. A trailing slash
    // means a subtree; anything else is taken as a literal path. Both must exist.
    const target = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    assert.ok(
      existsSync(join(REPO_ROOT, target)),
      `off_limits "${pattern}" names nothing in this repository — it would deny nothing`,
    );
    // And existing is not enough: the matcher must agree the pattern covers it. A
    // trailing-slash form that `matchesGlob` alone would miss is exactly #69.
    assert.ok(
      isOffLimits(config, target, REPO_ROOT),
      `off_limits "${pattern}" does not match its own target ${target}`,
    );
  }
});

test('harness-core is denied — it is untouched evidence, not code with a feature to add', () => {
  // Asserted on a file DEEP inside the subtree, not on the directory name. A pattern read
  // as one inode rather than a subtree passes the directory check and permits every write
  // underneath it, which is the `bareNameIsSubtree` failure direction.
  const { config } = loaded();
  const inside = 'harness-core/tools/lib/record.mjs';
  assert.ok(existsSync(join(REPO_ROOT, inside)), 'fixture path moved; pick another real file');
  assert.ok(isOffLimits(config, inside, REPO_ROOT), 'a worker could rewrite the evidence base');
  // The absolute form too. Callers produce three shapes for one file and a tool hands over
  // an absolute path; an unnormalized comparison answers "not off limits" and permits it.
  assert.ok(isOffLimits(config, join(REPO_ROOT, inside), REPO_ROOT), 'absolute form was permitted');
});

test('the gate and its tests are denied — the two edits the corpus measured', () => {
  // 10/10 clones made the destructive test edit; 9/10 edited the instrument. This denies
  // the path; `instrument_modified` and `evidence_weakened` score the diff. Both, because
  // the gate can only judge a change that has already been made.
  const { config } = loaded();
  assert.ok(isOffLimits(config, 'alfred/lib/gate.mjs', REPO_ROOT), 'the grader was writable');
  assert.ok(isOffLimits(config, 'alfred/test/gate.test.mjs', REPO_ROOT), 'the gate tests were writable');
  assert.ok(isOffLimits(config, 'alfred/test/report.test.mjs', REPO_ROOT), 'the report tests were writable');
});

test('the config denies edits to ITSELF — the deny list is not self-amendable', () => {
  // Otherwise every rule above is advisory: a worker that can edit `off_limits` can grant
  // itself any path in one move, and the gate would score the resulting diff against the
  // rules the worker had just written. Same shape as instrument_modified, one level up.
  const { config } = loaded();
  assert.ok(isOffLimits(config, '.alfred/config.json', REPO_ROOT), 'the rules could rewrite themselves');
});

test('ordinary source is NOT denied — a deny list that stops everything grades nothing', () => {
  // The falsifier for the five tests above. `isOffLimits` returning true for everything
  // would satisfy all of them, and this is the assertion that rules that out. A worker
  // with no writable path cannot produce a diff, and a run that produces no diff can
  // never be the gate_pass: true this project has not yet observed.
  const { config } = loaded();
  for (const allowed of ['alfred/lib/run.mjs', 'alfred/lib/report.mjs', 'alfred/SKILL.md', 'README.md']) {
    assert.equal(
      isOffLimits(config, allowed, REPO_ROOT),
      false,
      `${allowed} is denied — a worker has nothing left to change`,
    );
  }
});

test('the base branch resolves to main, and to main for an item with no epic', () => {
  // A single `{default: "main"}` rule. `resolveBase` returns null when nothing matches,
  // and null is what a branch would be cut from — so the absence of a default is not a
  // fallback, it is a run with no base.
  const { config } = loaded();
  assert.equal(resolveBase(config), 'main');
  assert.equal(resolveBase(config, { epic: 'no-such-epic' }), 'main');
});

test('delivery never merges, and the declared check is the command this repo actually runs', () => {
  const { config } = loaded();
  // The standing rule, asserted on the config rather than trusted from prose: PRs are
  // drafts and nothing merges. `loadConfig` requires the key; this pins the VALUE.
  assert.equal(config.delivery.never_merge, true);
  assert.equal(config.delivery.mode, 'pr');
  // `npm test` is what the gate will shell out to, and it is graded by exit code. A check
  // naming a script that does not exist would fail every run for the wrong reason.
  assert.equal(config.verify.test, 'npm test');
  assert.equal(config.branch_prefix, 'alfred/');
});
