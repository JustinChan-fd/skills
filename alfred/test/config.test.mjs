// config — `.alfred/config.json`, the per-repo source of truth.
//
// THE TEN NAMES BELOW ARE LIFTED VERBATIM from PLAN.md §3/M3, frozen 2026-07-29,
// before this file or `lib/config.mjs` existed. They are arm C's experimental
// control: frozen in git before sandbox-b is authored, so they cannot have been
// reshaped after seeing a new trap. Anything beyond them carries an `ADDED:` prefix
// and names the measurement it protects, per M1's rule.
//
// WHY CONFIG IS A MODULE AND NOT A PHASE. §4: "it replaces what a phase used to
// re-derive every run, at zero tokens." Arm B spent four phases and $18.483 partly
// re-deriving facts a committed file could have stated — the base branch, the verify
// commands, what is off limits. So the whole point is that reading this file is
// deterministic and free. That forces two properties the frozen names encode:
//
//   1. NO INVENTED DEFAULTS for anything that affects the repo. A guessed base branch
//      opens a PR against the wrong tree; a guessed verify command grades a run on a
//      check the repo does not use. Both are silent. So a missing config REFUSES.
//   2. AN UNKNOWN KEY IS AN ERROR. A typo'd key in a file that is the source of truth
//      is otherwise a setting that reads as applied and is not. `off_limit` for
//      `off_limits` would silently permit writes to node_modules.
//
// The one field that DOES default is `loop.poll_interval_minutes`, and §3 is explicit
// that it is three propositions rather than one — the default exists, config beats the
// default, and a nonsense value is refused. A single "interval is 30" test would pass
// a build in which config was ignored entirely, which is this project's recurring
// green-and-blind shape.
//
// FIXTURES ARE WRITTEN TO A TEMP DIR, not committed. Unlike M2's transcripts there is
// no measurement to preserve here — a config is a handful of literal fields, and a
// committed `.alfred/config.json` under `test/fixtures/` would additionally be found
// by any real `loadConfig` walking up from the test file. Built per-test in
// `os.tmpdir()` and removed after, so no test can see another's file.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig, resolveBase, isOffLimits, DEFAULT_POLL_INTERVAL_MINUTES } from '../lib/config.mjs';
import { BLOCKED_LABEL } from '../lib/blocked.mjs';
// Imported into the CONFIG test on purpose: the defect below is that each module was right
// on its own. See the #70 test at the bottom of this file.
import { budgetUsdFor } from '../lib/router.mjs';

// A minimal config that VALIDATES — every required field and nothing more. Tests that
// probe one field spread this and override, so a test about the poll interval cannot
// accidentally be passing because of an unrelated missing field.
const VALID = {
  version: 1,
  repo: 'webtarsthree',
  source: { kind: 'jira', jira: { cloud: 'x.atlassian.net', project: 'TARS', epic: 'TARS-1271' } },
  base: { rules: [{ when_epic: 'TARS-1271', branch: 'feat/migrate-native-fetch-from-axios' }, { default: 'master' }] },
  branch_prefix: 'alfred/',
  verify: { test: 'npm test' },
  delivery: { mode: 'pr', never_merge: true },
  off_limits: ['node_modules/**', '.husky/**', '**/*.snap'],
};

const dirs = [];

// Writes `.alfred/config.json` into a fresh temp repo root and returns that root.
// `undefined` writes NO file, which is the missing-config case.
function repoWith(config) {
  const root = mkdtempSync(join(tmpdir(), 'alfred-config-'));
  dirs.push(root);
  if (config !== undefined) {
    mkdirSync(join(root, '.alfred'), { recursive: true });
    writeFileSync(
      join(root, '.alfred', 'config.json'),
      typeof config === 'string' ? config : JSON.stringify(config, null, 2),
    );
  }
  return root;
}

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The ten frozen names, verbatim from PLAN.md §3/M3.
// ---------------------------------------------------------------------------

test('a valid .alfred/config.json loads and every field is typed', () => {
  const result = loadConfig(repoWith(VALID));

  assert.equal(result.ok, true);
  assert.equal(result.error, null);

  const c = result.config;
  assert.equal(c.version, 1);
  assert.equal(c.repo, 'webtarsthree');
  assert.equal(c.source.kind, 'jira');
  assert.equal(c.source.jira.epic, 'TARS-1271');
  assert.equal(c.branch_prefix, 'alfred/');
  assert.equal(c.delivery.mode, 'pr');
  assert.equal(c.delivery.never_merge, true);

  // Typed, not merely present. A string "1" where a number belongs is the shape that
  // survives JSON round-trips and breaks a comparison three modules downstream.
  assert.equal(typeof c.version, 'number');
  assert.equal(typeof c.repo, 'string');
  assert.equal(typeof c.delivery.never_merge, 'boolean');
  assert.equal(Array.isArray(c.base.rules), true);
  assert.equal(Array.isArray(c.off_limits), true);
  assert.equal(typeof c.verify, 'object');
  assert.equal(typeof c.loop.poll_interval_minutes, 'number');
});

test('a missing config is a named refusal, not a set of invented defaults', () => {
  const result = loadConfig(repoWith(undefined));

  assert.equal(result.ok, false);
  assert.equal(result.config, null);
  assert.match(result.error, /config/i);

  // The load must not hand back a usable-looking object. A default base branch or a
  // default verify command is worse than no config: it produces a PR against the
  // wrong tree, or grades a run on a check this repo does not run.
  assert.equal(result.config, null);
});

test('an unknown top-level key is a validation error, not ignored', () => {
  const result = loadConfig(repoWith({ ...VALID, off_limit: ['node_modules/**'] }));

  assert.equal(result.ok, false);
  assert.equal(result.config, null);
  // The offending key is NAMED. "validation failed" sends an operator to read the
  // whole file; naming the key sends them to the line.
  assert.match(result.error, /off_limit\b/);
});

test('base-branch resolution returns the configured epic branch, not master', () => {
  const { config } = loadConfig(repoWith(VALID));

  assert.equal(resolveBase(config, { epic: 'TARS-1271' }), 'feat/migrate-native-fetch-from-axios');
  // Not master, stated as its own assertion because that is the actual defect: on
  // TARS-1271 the base was the epic feature branch, and resolving to master produces
  // a PR against the wrong tree.
  assert.notEqual(resolveBase(config, { epic: 'TARS-1271' }), 'master');
});

test('base-branch resolution falls back only when config says it may', () => {
  const withDefault = loadConfig(repoWith(VALID)).config;
  assert.equal(resolveBase(withDefault, { epic: 'TARS-9999' }), 'master');

  // No `{ default: ... }` rule: an unmatched epic has NO base. Returning master here
  // would be inventing the one value the previous test exists to protect.
  const noDefault = loadConfig(
    repoWith({ ...VALID, base: { rules: [{ when_epic: 'TARS-1271', branch: 'feat/x' }] } }),
  ).config;
  assert.equal(resolveBase(noDefault, { epic: 'TARS-9999' }), null);
  assert.equal(resolveBase(noDefault, { epic: 'TARS-1271' }), 'feat/x');
});

test('off-limits paths are globs and are resolved relative to repo root', () => {
  const { config } = loadConfig(repoWith(VALID));

  assert.equal(isOffLimits(config, 'node_modules/lodash/index.js'), true);
  assert.equal(isOffLimits(config, '.husky/pre-commit'), true);
  assert.equal(isOffLimits(config, 'src/__tests__/a.snap'), true);
  assert.equal(isOffLimits(config, 'src/index.js'), false);

  // Repo-root-relative, so an absolute path or a ./ prefix — both of which
  // `git diff --name-only` and a caller's own bookkeeping produce — match the same
  // rule. A prefix mismatch here reads as "not off limits" and permits the write.
  assert.equal(isOffLimits(config, './node_modules/lodash/index.js'), true);
  assert.equal(isOffLimits(config, '/abs/repo/node_modules/lodash/index.js', '/abs/repo'), true);

  // A sibling checkout's node_modules is NOT this repo's off-limits path. Reporting it
  // as off-limits would be a scope finding against a file the run never touched.
  assert.equal(isOffLimits(config, '/abs/other/node_modules/lodash/index.js', '/abs/repo'), false);
  // An absolute path with no root to resolve against cannot be judged, so it is not
  // claimed as off-limits.
  assert.equal(isOffLimits(config, '/abs/repo/node_modules/lodash/index.js'), false);
});

test('ADDED: an escaping glob cannot match outside the root, on the unvalidated surface', () => {
  // WHY THIS TEST EXISTS, stated because the honest version is not obvious.
  //
  // Mutation testing removed the `..`-escape check inside `isOffLimits` and all 21
  // tests stayed green. Through `loadConfig` the check cannot fire: validation already
  // refuses `../**` and `/etc/**` as off_limits entries, so no LOADED config can carry
  // a glob that reaches outside the tree. Two guards cover one hazard, and the outer
  // one hides the inner one — the same unfalsifiable-conjunct shape as the epic guard
  // in resolveBase.
  //
  // `isOffLimits` takes a config object, not a load result, so the unvalidated surface
  // is real. Proven there, against a hand-built config the loader would have refused.
  const handBuilt = { off_limits: ['../**'] };

  assert.equal(isOffLimits(handBuilt, '/abs/other/x.js', '/abs/repo'), false);
  // And the loader does refuse it, so both layers are asserted rather than assumed.
  assert.equal(loadConfig(repoWith({ ...VALID, off_limits: ['../**'] })).ok, false);
});

test('a config declaring no verification commands is invalid — the gate needs at least one', () => {
  const empty = loadConfig(repoWith({ ...VALID, verify: {} }));
  assert.equal(empty.ok, false);
  assert.match(empty.error, /verify/);

  const absent = loadConfig(repoWith({ ...VALID, verify: undefined }));
  assert.equal(absent.ok, false);
  assert.match(absent.error, /verify/);
});

test('loop.poll_interval_minutes defaults to 30 when the loop block is absent', () => {
  const { config } = loadConfig(repoWith({ ...VALID, loop: undefined }));

  assert.equal(config.loop.poll_interval_minutes, 30);
  assert.equal(DEFAULT_POLL_INTERVAL_MINUTES, 30);
});

test('an explicit poll interval overrides the default', () => {
  const { config } = loadConfig(repoWith({ ...VALID, loop: { poll_interval_minutes: 5 } }));

  assert.equal(config.loop.poll_interval_minutes, 5);
  // Distinct from the default, so a build that ignored config entirely and always
  // returned 30 fails here. That build passes the previous test.
  assert.notEqual(config.loop.poll_interval_minutes, DEFAULT_POLL_INTERVAL_MINUTES);
});

test('a zero or negative poll interval is a validation error, not a hot loop', () => {
  for (const bad of [0, -1, -30]) {
    const result = loadConfig(repoWith({ ...VALID, loop: { poll_interval_minutes: bad } }));
    assert.equal(result.ok, false, `interval ${bad} must be refused`);
    assert.match(result.error, /poll_interval_minutes/);
  }

  // Refused, NOT silently corrected to the default. A zero coerced to 30 is a config
  // that reads as applied and is not — and the operator who typed 0 never learns.
  const zero = loadConfig(repoWith({ ...VALID, loop: { poll_interval_minutes: 0 } }));
  assert.equal(zero.config, null);
});

// ---------------------------------------------------------------------------
// ADDED — each names the measurement or defect it protects.
// ---------------------------------------------------------------------------

test('ADDED: unparseable JSON is a refusal naming the file, not a crash', () => {
  const result = loadConfig(repoWith('{ "version": 1, '));

  // Reported, never thrown. Same pure-sidecar rule report.mjs runs under: the loader
  // is called at the top of an unattended tick, and an exception there kills the tick
  // without a record of why.
  assert.equal(result.ok, false);
  assert.equal(result.config, null);
  assert.match(result.error, /\.alfred\/config\.json/);
});

test('ADDED: a wrongly-typed field is refused, because JSON has no schema of its own', () => {
  // "1" is what a hand-edited config or a templating step produces. It is truthy, so
  // every presence check passes and only a type check catches it.
  const strVersion = loadConfig(repoWith({ ...VALID, version: '1' }));
  assert.equal(strVersion.ok, false);
  assert.match(strVersion.error, /version/);

  const strInterval = loadConfig(repoWith({ ...VALID, loop: { poll_interval_minutes: '30' } }));
  assert.equal(strInterval.ok, false);
  assert.match(strInterval.error, /poll_interval_minutes/);

  const badOffLimits = loadConfig(repoWith({ ...VALID, off_limits: 'node_modules/**' }));
  assert.equal(badOffLimits.ok, false);
  assert.match(badOffLimits.error, /off_limits/);
});

test('ADDED: an unknown key nested inside a block is refused too, with its path', () => {
  // The frozen name covers TOP-LEVEL keys only. A validator that checks depth 1 and
  // waves through depth 2 leaves `delivery.never_merged` — a typo on the standing
  // never-merge rule — reading as applied while merging is permitted.
  const result = loadConfig(
    repoWith({ ...VALID, delivery: { mode: 'pr', never_merged: true } }),
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /delivery\.never_merged/);
});

test('ADDED: an unknown delivery mode is refused — the closed set is the point', () => {
  // §4 gives two modes and arm 0 is why: it opened no PR CORRECTLY, because AC #4
  // said commit to the epic branch. A third mode reaching a caller that switches on
  // two silently takes whichever branch is the else.
  const result = loadConfig(repoWith({ ...VALID, delivery: { mode: 'rebase', never_merge: true } }));

  assert.equal(result.ok, false);
  assert.match(result.error, /mode/);
  assert.match(result.error, /rebase/);

  for (const mode of ['pr', 'push']) {
    assert.equal(loadConfig(repoWith({ ...VALID, delivery: { mode, never_merge: true } })).ok, true);
  }
});

test('ADDED: never_merge: false is refused — the standing rule is not configurable', () => {
  // "Harness never merges its own PRs" is a standing constraint, not a preference.
  // Accepting `false` makes it a per-repo opinion that one commit can flip.
  const result = loadConfig(repoWith({ ...VALID, delivery: { mode: 'pr', never_merge: false } }));

  assert.equal(result.ok, false);
  assert.match(result.error, /never_merge/);
});

test('ADDED: source.kind must match the block that is present', () => {
  // `kind: 'github'` with only a `jira` block is a half-finished edit. Every field
  // the source layer reads comes back undefined, and the tick fails somewhere far
  // from the cause.
  const mismatch = loadConfig(repoWith({ ...VALID, source: { kind: 'github', jira: VALID.source.jira } }));
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /github/);

  const gh = loadConfig(
    repoWith({ ...VALID, source: { kind: 'github', github: { owner: 'o', repo: 'r', labels: ['ready'] } } }),
  );
  assert.equal(gh.ok, true);
  assert.equal(gh.config.source.github.owner, 'o');
});

test('ADDED: off_limits cannot escape the repo root', () => {
  // A rule that matches outside the tree cannot protect anything inside it, and an
  // absolute rule silently stops matching the relative paths git reports.
  for (const bad of ['../secrets/**', '/etc/**']) {
    const result = loadConfig(repoWith({ ...VALID, off_limits: [bad] }));
    assert.equal(result.ok, false, `${bad} must be refused`);
    assert.match(result.error, /off_limits/);
  }
});

test('ADDED: every malformed-shape refusal is reachable and names its field', () => {
  // SIX GUARDS THAT MUTATION TESTING FOUND UNTESTED. Each was already implemented and
  // correct; inverting any of them left all 22 tests green, which means the suite could
  // not tell a working validator from one that waved these through. A guard nothing
  // exercises is indistinguishable from a guard that does not work.
  //
  // They are grouped in one test because they are one proposition — a structurally
  // well-typed config can still be semantically unusable — and each case names the
  // field it must refuse on, so a failure points at the guard rather than the group.
  const cases = [
    // A JSON array parses fine and has none of the keys, so without this the first
    // required-field error is what an operator sees instead of "this is not an object".
    { label: 'top-level array', raw: '[]', expect: /JSON object/ },
    // base.rules: [] passes the array type check and leaves resolveBase with nothing
    // to match, so EVERY item resolves to a null base. Config-shaped, unusable.
    { label: 'no base rules', config: { ...VALID, base: { rules: [] } }, expect: /base\.rules/ },
    // A rule with neither when_epic nor default is dead weight that reads as coverage.
    { label: 'rule with neither key', config: { ...VALID, base: { rules: [{ branch: 'x' }] } }, expect: /base\.rules\[0\]/ },
    // An empty default branch name would have `git` resolve HEAD or error obscurely.
    { label: 'empty default branch', config: { ...VALID, base: { rules: [{ default: '' }] } }, expect: /base\.rules\[0\]\.default/ },
    // A non-string verify command is not runnable. The gate would try to spawn it.
    { label: 'non-string verify cmd', config: { ...VALID, verify: { test: 42 } }, expect: /verify\.test/ },
    // An empty glob matches nothing, so an off_limits entry that reads as protection
    // protects nothing — the silent-permission failure the whole field exists to stop.
    { label: 'empty off_limits glob', config: { ...VALID, off_limits: ['  '] }, expect: /off_limits\[0\]/ },
  ];

  for (const { label, raw, config, expect } of cases) {
    const result = loadConfig(repoWith(raw ?? config));
    assert.equal(result.ok, false, `${label} must be refused`);
    assert.equal(result.config, null, `${label} must yield no config`);
    assert.match(result.error, expect, `${label} must name its field`);
  }
});

test('ADDED: the loaded config is frozen, so a later caller cannot rewrite the rules', () => {
  const { config } = loadConfig(repoWith(VALID));

  // The gate reads `off_limits` and `verify` to decide pass/fail. If any caller can
  // mutate them mid-run, the record says a run was graded against rules that are no
  // longer the ones in the file — and nothing in the artifact shows the swap.
  assert.throws(() => { config.off_limits.push('src/**'); }, TypeError);
  assert.throws(() => { config.verify.test = 'true'; }, TypeError);
  assert.throws(() => { config.delivery.never_merge = false; }, TypeError);
  assert.throws(() => { config.base.rules.push({ default: 'main' }); }, TypeError);
});

test('ADDED: loadConfig reads the given root only — it never walks up to a parent repo', () => {
  // A loader that searched upward would find THIS repo's config when run against a
  // sandbox that has none, and grade the sandbox against skills' verify commands.
  // The refusal has to depend on the directory it was given.
  const parent = repoWith(VALID);
  const child = join(parent, 'nested');
  mkdirSync(child, { recursive: true });

  const result = loadConfig(child);
  assert.equal(result.ok, false);
  assert.equal(result.config, null);
});

test('ADDED: base rules are first-match-wins, in declared order', () => {
  // §4: "in order; first match wins." A validator that reorders, or a resolver that
  // scans for the most specific rule, changes the answer for an epic named twice —
  // and both readings look correct in isolation.
  const { config } = loadConfig(
    repoWith({
      ...VALID,
      base: { rules: [{ when_epic: 'TARS-1271', branch: 'first' }, { when_epic: 'TARS-1271', branch: 'second' }, { default: 'master' }] },
    }),
  );

  assert.equal(resolveBase(config, { epic: 'TARS-1271' }), 'first');
  // Declared order survives validation. The two rule shapes are distinct — a matcher
  // carries `branch`, the fallback carries `default` — so reading only one of them
  // here would have compared against undefined and asserted nothing.
  assert.deepEqual(config.base.rules.map((r) => r.branch ?? r.default), ['first', 'second', 'master']);
});

test('ADDED: resolveBase with no epic uses the default rule rather than the first branch', () => {
  // A prompt-sourced item has no epic. Falling through to `rules[0].branch` would
  // silently base it on whatever epic happens to be listed first.
  const { config } = loadConfig(repoWith(VALID));

  assert.equal(resolveBase(config, {}), 'master');
  assert.equal(resolveBase(config, { epic: null }), 'master');

  // ON THE UNVALIDATED SURFACE, which is the only place this can be proven.
  //
  // Mutation testing found that dropping the truthiness guard on `epic` left all 21
  // tests green. The reason is worth recording rather than papering over: through
  // `loadConfig` the guard CANNOT fire, because validation already refuses a rule
  // whose `when_epic` is not a non-empty string, so `null === null` never arises.
  // That is the unfalsifiable-conjunct shape — a guard whose test passes because the
  // condition is unreachable, not because the guard works.
  //
  // `resolveBase` is exported separately, so the unvalidated surface is real: any
  // caller can hand it an object it did not load. There, null-matches-null resolves
  // to a branch chosen by coincidence.
  const handBuilt = { base: { rules: [{ when_epic: null, branch: 'WRONG' }, { default: 'master' }] } };
  assert.equal(resolveBase(handBuilt, {}), 'master');
  assert.equal(resolveBase(handBuilt, { epic: null }), 'master');
});

test('ADDED: loadConfig returns a refusal for a non-path root — it never throws', () => {
  // Mutation testing bypassed the repoRoot type guard and all 23 tests stayed green,
  // because every test passes a real temp dir. What the mutation exposed is not a
  // cosmetic gap: with the guard removed, `loadConfig()` THROWS a TypeError out of
  // `path.join`, and the module's contract is that it never throws. That contract is
  // load-bearing — this runs at the top of an unattended tick, where an exception
  // kills the tick with no record of why. A caller that read a root from a payload
  // field and got undefined is exactly how it arrives here.
  for (const bad of [undefined, null, '', 42, {}]) {
    let result;
    assert.doesNotThrow(() => { result = loadConfig(bad); }, `loadConfig(${JSON.stringify(bad)}) must not throw`);
    assert.equal(result.ok, false);
    assert.equal(result.config, null);
    assert.match(result.error, /repo root/);
  }
});

test('ADDED: an explicit null on an optional block is skipped, not type-refused', () => {
  // Mutation testing removed the `nullish(sub)` skip in validateBlock and all 23 tests
  // stayed green — nothing ever supplied an explicit null. The skip is what makes
  // `"telemetry": null` mean "not configured" rather than "must be object, got null",
  // which matters because a null is what a templating step emits for an unset value.
  for (const key of ['telemetry', 'loop', 'models']) {
    const result = loadConfig(repoWith({ ...VALID, [key]: null }));
    assert.equal(result.ok, true, `${key}: null must be accepted as absent — ${result.error}`);
  }
  // But a null on a REQUIRED field is still refused: the skip must not become a way to
  // omit the fields the no-invented-defaults rule exists to protect.
  for (const key of ['branch_prefix', 'base', 'verify', 'off_limits']) {
    const result = loadConfig(repoWith({ ...VALID, [key]: null }));
    assert.equal(result.ok, false, `${key}: null must be refused`);
    assert.match(result.error, new RegExp(`${key} is required`));
  }
  // And an explicit null loop still yields the default interval, not a crash.
  assert.equal(
    loadConfig(repoWith({ ...VALID, loop: null })).config.loop.poll_interval_minutes,
    DEFAULT_POLL_INTERVAL_MINUTES,
  );
});

test('ADDED: the blocked_label default agrees with blocked.mjs BLOCKED_LABEL', () => {
  // Mutation testing deleted the blocked_label default line and all 23 tests stayed
  // green: nothing read the field. It is worth a test for a reason beyond coverage —
  // the default is a string literal in `config.mjs` while `blocked.mjs` is what
  // actually applies and matches the label. Two literals that must agree, with nothing
  // asserting they do, is how the loop comes to label an item with one name and skip
  // on another, and neither side looks wrong on its own.
  //
  // Asserted against the import rather than against `'alfred:blocked'`, so the test
  // fails if EITHER side drifts. Both directions were verified by mutation: changing
  // the config literal kills it, and changing BLOCKED_LABEL kills it too. That is what
  // makes the duplicated literal safe to leave in place — the binding is in the test.
  assert.equal(loadConfig(repoWith(VALID)).config.loop.blocked_label, BLOCKED_LABEL);
  // An operator override still wins — the default is a default, not a constant.
  const overridden = loadConfig(repoWith({ ...VALID, loop: { blocked_label: 'wip:hold' } }));
  assert.equal(overridden.config.loop.blocked_label, 'wip:hold');
});

test('ADDED: a directory-prefix off_limits entry catches the files under it (#69)', () => {
  // MEASURED DEFECT, not a hypothetical. `matchesGlob('src/vendor/legacy.js', 'src/vendor/')`
  // is false, and both fixture manifests declare `off_limits: ["src/vendor/"]`. So did every
  // config written by hand in the shape a human reaches for. The rule read as protection and
  // permitted every write beneath the directory.
  //
  // Both spellings, because an operator writing a deny list means the subtree either way.
  for (const pattern of ['src/vendor/', 'src/vendor', 'src/vendor/**']) {
    const config = { off_limits: [pattern] };
    assert.equal(isOffLimits(config, 'src/vendor/legacy.js'), true, `${pattern} → immediate child`);
    assert.equal(isOffLimits(config, 'src/vendor/dist/deep/x.min.js'), true, `${pattern} → deep child`);
  }
});

test('ADDED: the directory-prefix reading does not catch a same-prefix sibling', () => {
  // The false positive the fix must not introduce. `src/vendorish/` is a different directory,
  // and off_limits is the one rule whose value is being trusted when it fires — a rule that
  // fails runs for editing unrelated code gets ignored, and an ignored rule protects nothing.
  const config = { off_limits: ['src/vendor'] };
  assert.equal(isOffLimits(config, 'src/vendorish/x.js'), false);
  assert.equal(isOffLimits(config, 'src/vendor-utils.js'), false);
});

test('ADDED: the escape check survives the shared matcher (#69)', () => {
  // The guard above proves `../**` cannot escape. That guard lives in `isOffLimits` and NOT
  // in the shared matcher, so replacing the matcher could have moved the check out from under
  // it silently — a glob form and a bare form both need to stay refused.
  for (const pattern of ['../**', '../../secrets', '..']) {
    assert.equal(
      isOffLimits({ off_limits: [pattern] }, '/abs/other/x.js', '/abs/repo'),
      false,
      `${pattern} must not reach outside the root`,
    );
  }
  // And a `..` inside a relative path still cannot be laundered into a match.
  assert.equal(isOffLimits({ off_limits: ['src/../../etc'] }, '/abs/other/etc/passwd', '/abs/repo'), false);
});

test('ADDED: budget_usd is a settable key, because lib/router.mjs already reads it (#70)', () => {
  // TWO MODULES EACH CORRECT ALONE, PRODUCING A SETTING THAT CANNOT BE SET. `budgetUsdFor`
  // reads `config.budget_usd` and hands it to `--max-budget-usd` — the one ceiling the CLI was
  // MEASURED to enforce, and half of what the $11.98 lesson rests on. test/router.test.mjs
  // asserts a config of `{ budget_usd: 7.5 }` reaches the flag as 7.5. But that test passes a
  // bare object; nothing put one through `loadConfig`, whose SCHEMA never listed the key and
  // whose unknown-key rule therefore REFUSED it. So the only budget any real run could use was
  // the hardcoded default, and an operator writing a cap into their config got a refusal
  // instead of a cap — the drift shape of #67, one layer out, found by validating a real
  // fixture rather than by a test of either module.
  //
  // Asserted as a ROUND TRIP through both modules on purpose. A test that only checked
  // `loadConfig` accepted the key would pass a build in which the router had renamed it.
  const loaded = loadConfig(repoWith({ ...VALID, budget_usd: 2 }));
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.config.budget_usd, 2);
  assert.equal(budgetUsdFor(loaded.config), 2);

  // And the type check still applies. `budgetUsdFor` throws on a non-number, which at the top
  // of a tick is an exception where a reported refusal belongs — so the loader must catch it
  // first, before any run directory exists.
  const bad = loadConfig(repoWith({ ...VALID, budget_usd: '2' }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /budget_usd/);

  // A NEGATIVE NUMBER IS A NUMBER, so the type check alone leaves it to the router to throw.
  // Zero matters for its own reason: `--max-budget-usd 0` is a run that aborts having spent
  // nothing, which reads in a log as a broken worker rather than as the config it is.
  for (const value of [0, -3]) {
    const nonPositive = loadConfig(repoWith({ ...VALID, budget_usd: value }));
    assert.equal(nonPositive.ok, false, `budget_usd: ${value}`);
    assert.match(nonPositive.error, /budget_usd/);
  }
});

// ---------------------------------------------------------------------------
// #21 — epics as URLs, statuses as a gate, and array ELEMENTS validated.
//
// WHY URLS AND NOT KEYS. The operator's instruction was "setting a list of epics as
// urls ... if alfred can just call to those every n minutes, we can simplify and not
// have to do mental gymnastics." A browse URL carries the host AND the key in one
// string the operator can paste from a browser, so `cloud` stops being a second field
// that can disagree with the thing it describes.
//
// WHY ELEMENT VALIDATION IS PART OF THE SAME TASK. MEASURED before writing any of this:
// `source.github.labels: [1, 2, 3]` and `labels: [{}]` BOTH loaded ok. `typeOf` reports
// `array` and the walk never looks inside, so every array in the schema — `off_limits`
// and `base.rules` excepted, which have their own semantic loops — accepts any contents
// at all. Adding two more array keys without fixing that would trade one silent setting
// for three.
// ---------------------------------------------------------------------------

const EPIC_URL = 'https://fandango.atlassian.net/browse/TARS-1350';

const jiraSource = (jira) => ({ source: { kind: 'jira', jira } });

test('#21: source.jira.epics takes browse URLs, and the key and host are parsed out of each', () => {
  const result = loadConfig(repoWith({ ...VALID, ...jiraSource({ epics: [EPIC_URL] }) }));
  assert.equal(result.ok, true, result.error);

  // The raw string is preserved — it is what the operator wrote and what a record should
  // show — and the parse is exposed alongside it rather than replacing it.
  assert.deepEqual(result.config.source.jira.epics, [EPIC_URL]);
  assert.deepEqual(result.config.source.jira.epic_keys, ['TARS-1350']);
  assert.equal(result.config.source.jira.host, 'fandango.atlassian.net');
});

test('#21: a URL that is not an epic browse URL is refused, and the refusal names it', () => {
  // ANCHORED, because a half-match is the failure that looks like success: a string with
  // a browse URL inside it resolves to the wrong key or to a key with trailing junk, and
  // then every fetch 404s at 3am against a ticket nobody named.
  for (const bad of [
    'TARS-1350',                                            // a bare key: no host, so nothing to fetch from
    'https://fandango.atlassian.net/browse/TARS-1350/extra', // trailing path
    'https://fandango.atlassian.net/jira/software/c/TARS',   // a board, not an epic
    'see https://fandango.atlassian.net/browse/TARS-1350',   // prose around a URL
    'http://fandango.atlassian.net/browse/TARS-1350',        // plaintext: a token would go over the wire
    '',
  ]) {
    const r = loadConfig(repoWith({ ...VALID, ...jiraSource({ epics: [bad] }) }));
    assert.equal(r.ok, false, `accepted a bad epic URL: ${JSON.stringify(bad)}`);
    assert.match(r.error, /source\.jira\.epics\[0\]/, `refusal did not name the element: ${r.error}`);
  }
});

test('#21: epics on DIFFERENT hosts are refused — one config authenticates against one site', () => {
  // A single credential is resolved per run. Two hosts in one list reads as supported and
  // is not: whichever host is not the authenticated one returns 401 for every ticket, and
  // an auth failure at poll time is indistinguishable from an empty backlog.
  const r = loadConfig(
    repoWith({
      ...VALID,
      ...jiraSource({ epics: [EPIC_URL, 'https://other.atlassian.net/browse/AB-1'] }),
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /host/);
});

test('#21: source.jira.cloud must agree with the epic URLs when both are given', () => {
  // Two fields naming the same site is the drift shape this project keeps meeting. The
  // fix is not to pick a winner silently — it is to refuse, because whichever one loses
  // was written by an operator who believes it applies.
  const r = loadConfig(
    repoWith({ ...VALID, ...jiraSource({ cloud: 'elsewhere.atlassian.net', epics: [EPIC_URL] }) }),
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /cloud/);

  // Agreeing is fine, and the parse still comes from the URL.
  const ok = loadConfig(
    repoWith({ ...VALID, ...jiraSource({ cloud: 'fandango.atlassian.net', epics: [EPIC_URL] }) }),
  );
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.config.source.jira.host, 'fandango.atlassian.net');
});

test('#21: statuses declares which statuses are workable, and defaults to nothing invented', () => {
  const r = loadConfig(repoWith({ ...VALID, ...jiraSource({ epics: [EPIC_URL], statuses: ['To Do'] }) }));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.config.source.jira.statuses, ['To Do']);

  // ABSENT IS NOT "ALL". A poll that treats a missing `statuses` as every status picks up
  // In Progress and Done tickets and re-does work someone already shipped. There is no
  // default, so the absence is visible to the poller rather than filled in here.
  const none = loadConfig(repoWith({ ...VALID, ...jiraSource({ epics: [EPIC_URL] }) }));
  assert.equal(none.ok, true, none.error);
  assert.equal(none.config.source.jira.statuses, undefined);

  // An empty list is refused rather than read as "all" or as "none": one means a poll that
  // never works anything, the other a poll that works everything, and the operator who
  // typed `[]` cannot be assumed to have meant either.
  const empty = loadConfig(repoWith({ ...VALID, ...jiraSource({ epics: [EPIC_URL], statuses: [] }) }));
  assert.equal(empty.ok, false);
  assert.match(empty.error, /statuses/);
});

test('#21: jql is gone — a config carrying one is refused rather than silently ignored', () => {
  // MEASURED: `jql` loaded fine before this. It was in the §4 sketch and nothing ever read
  // it, which is the worst state for a config key — an operator writes a query, the file
  // validates, and the poll uses the epic list instead. Removing the key turns that into
  // an error naming the line to delete.
  const r = loadConfig(repoWith({ ...VALID, ...jiraSource({ epics: [EPIC_URL], jql: 'project = TARS' }) }));
  assert.equal(r.ok, false);
  assert.match(r.error, /jql/);
});

test('#21: array ELEMENTS are type-checked — labels: [1,2,3] was accepted before this', () => {
  // The probe that motivated this, run against the pre-change loader: both of these
  // returned ok: true. `typeOf` reports `array` and the recursive walk descends into
  // objects only, so array contents were never looked at.
  for (const labels of [[1, 2, 3], [{}], ['ok', 2]]) {
    const r = loadConfig(
      repoWith({ ...VALID, source: { kind: 'github', github: { owner: 'a', repo: 'b', labels } } }),
    );
    assert.equal(r.ok, false, `accepted labels: ${JSON.stringify(labels)}`);
    assert.match(r.error, /source\.github\.labels\[\d\]/, r.error);
  }

  // And the valid form still loads — the falsifier for the three above, which a loader
  // that refused every array would also satisfy.
  const ok = loadConfig(
    repoWith({ ...VALID, source: { kind: 'github', github: { owner: 'a', repo: 'b', labels: ['ready'] } } }),
  );
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.config.source.github.labels, ['ready']);
});

test('#21: a jira config still needs SOMETHING to poll — epic or epics, not neither', () => {
  // `source.kind: jira` with an empty jira block validated before, because every field in
  // it was optional. That is a config that declares a source and names nothing to fetch
  // from, and the poll it produces is an empty loop that reports no work rather than a
  // misconfiguration.
  const r = loadConfig(repoWith({ ...VALID, ...jiraSource({ project: 'TARS' }) }));
  assert.equal(r.ok, false);
  assert.match(r.error, /epic/);
});
