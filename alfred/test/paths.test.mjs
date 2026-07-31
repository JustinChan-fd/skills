// paths — one path matcher, because there were two and they agreed by luck.
//
// WHY THIS MODULE EXISTS (#69). `lib/gate.mjs`'s `checkScope` and `lib/config.mjs`'s
// `isOffLimits` each called bare `matchesGlob` on operator-written patterns. Measured:
//
//   matchesGlob('src/vendor/legacy.js', 'src/vendor/')  === false
//   matchesGlob('src/vendor/legacy.js', 'src/vendor')   === false
//   matchesGlob('src/vendor/legacy.js', 'src/vendor/**') === true
//
// `**` is the form `test/gate.test.mjs`'s CONFIG uses. `src/vendor/` is the form BOTH
// fixture manifests ship. So the off-limits rule was green against a pattern the real input
// never carries and silent on the two forms an operator writes by hand — a rule that cannot
// fire on its own input, the same defect class as #63 and #67, failing in the PERMITTING
// direction.
//
// THE ASYMMETRY IS THE DESIGN, and it is why this is one function with a flag rather than
// one behavior. Widening `off_limits` fails SAFE: more writes are caught, and a false
// positive costs a run. Widening `declaredScope` fails OPEN: more writes are permitted, and
// a false negative costs the protection. The same matcher serves both, so the direction has
// to be a parameter the caller states rather than a default either side inherits.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchesPathPattern } from '../lib/paths.mjs';

// --- what an explicit glob does: nothing new ---

test('an operator-written glob is honoured exactly as before', () => {
  // The frozen gate tests all use `**`. If this module changed what a glob means, thirteen
  // frozen names would be measuring something other than what they were frozen against.
  assert.equal(matchesPathPattern('src/vendor/legacy.js', 'src/vendor/**'), true);
  assert.equal(matchesPathPattern('src/vendor/deep/a.js', 'src/vendor/**'), true);
  assert.equal(matchesPathPattern('src/index.js', 'src/vendor/**'), false);
  // One segment only, which is what `*` means and must keep meaning.
  assert.equal(matchesPathPattern('src/vendor/legacy.js', 'src/vendor/*'), true);
  assert.equal(matchesPathPattern('src/vendor/deep/a.js', 'src/vendor/*'), false);
  assert.equal(matchesPathPattern('src/__tests__/a.snap', '**/*.snap'), true);
});

// --- the trailing slash: a directory, in either direction ---

test('a trailing slash names a subtree, whichever direction the caller is matching', () => {
  // Unambiguous: nobody writes a trailing slash to mean one file. So it needs no flag, and
  // both callers get it — including `declaredScope`, where the old behavior FAILED A RUN for
  // editing `src/channels/sms.js` under a declared scope of `src/channels/`.
  for (const opts of [{}, { bareNameIsSubtree: true }]) {
    assert.equal(matchesPathPattern('src/vendor/legacy.js', 'src/vendor/', opts), true);
    assert.equal(matchesPathPattern('src/vendor/dist/bundle/x.min.js', 'src/vendor/', opts), true);
  }
});

test('a trailing slash matches the directory entry itself, not only things under it', () => {
  // `git diff --name-only` names files, but a submodule pointer or a deleted directory can
  // surface as the bare path, and reading that as "not off limits" permits the write.
  assert.equal(matchesPathPattern('src/vendor', 'src/vendor/'), true);
});

// --- the bare name: the flag is the whole point ---

test('a bare directory name is a subtree only when the caller asks for it', () => {
  // `off_limits: ["src/vendor"]` means the subtree — an operator naming a directory in a
  // deny list is not naming one inode. `declaredScope: ["src/retry.js"]` means that file:
  // treating it as a prefix would make `src/retry.js/nested.js` in-scope, which is granting
  // permission nobody wrote down.
  assert.equal(matchesPathPattern('src/vendor/legacy.js', 'src/vendor', { bareNameIsSubtree: true }), true);
  assert.equal(matchesPathPattern('src/vendor/legacy.js', 'src/vendor', { bareNameIsSubtree: false }), false);
  assert.equal(matchesPathPattern('src/vendor/legacy.js', 'src/vendor'), false, 'the permissive reading is not the default');
});

test('an exact path matches itself in both directions', () => {
  // The case the flag must not touch. A declared file has to admit itself or every scoped
  // run is a scope violation.
  for (const opts of [{}, { bareNameIsSubtree: true }]) {
    assert.equal(matchesPathPattern('src/retry.js', 'src/retry.js', opts), true);
  }
});

// --- the constraint that stops this from being startsWith ---

test('a sibling whose name merely starts the same is not a match', () => {
  // The false-positive this fix must not introduce. `off_limits` is the one rule whose value
  // is being trusted when it fires; a rule that fails runs for editing an unrelated
  // directory gets ignored, and an ignored rule protects nothing.
  for (const pattern of ['src/vendor', 'src/vendor/', 'src/vendor/**']) {
    for (const file of ['src/vendorish/x.js', 'src/vendor-utils.js', 'src/vendors/x.js']) {
      assert.equal(
        matchesPathPattern(file, pattern, { bareNameIsSubtree: true }),
        false,
        `${file} must not match ${pattern}`,
      );
    }
  }
});

test('a partial segment prefix is not a match even at the root', () => {
  assert.equal(matchesPathPattern('srcx/a.js', 'src', { bareNameIsSubtree: true }), false);
  assert.equal(matchesPathPattern('src/a.js', 'src', { bareNameIsSubtree: true }), true);
});

// --- path form, the thing the old normalize already got right ---

test('forms that mean the same file match the same way, on both sides', () => {
  // Kept from the behavior `normalize` already had in both call sites: `git diff` output and
  // a hand-written pattern do not agree on form, and an unnormalized compare reads
  // "not off limits" and PERMITS the write.
  for (const file of ['src/vendor/legacy.js', './src/vendor/legacy.js', 'src\\vendor\\legacy.js']) {
    assert.equal(matchesPathPattern(file, 'src/vendor/'), true, `file form ${file}`);
  }
  for (const pattern of ['src/vendor/', './src/vendor/', 'src\\vendor\\']) {
    assert.equal(matchesPathPattern('src/vendor/legacy.js', pattern), true, `pattern form ${pattern}`);
  }
});

test('a repeated slash does not defeat the match', () => {
  assert.equal(matchesPathPattern('src/vendor/legacy.js', 'src/vendor//'), true);
});

// --- degenerate input ---

test('nothing matches nothing, and no input throws', () => {
  // Same rule as `readAcMap` and `readMarker`: this runs inside code scoring a run that has
  // already been paid for, and an empty pattern reaching a `startsWith` would match EVERY
  // file — declaring the whole tree off limits, or the whole tree in scope, depending on the
  // caller. Both are silent and total.
  for (const bad of [null, undefined, '', '   ', 0, {}, [], '/', '//', '.', './']) {
    assert.doesNotThrow(() => matchesPathPattern('src/a.js', bad), `pattern ${JSON.stringify(bad)} threw`);
    assert.doesNotThrow(() => matchesPathPattern(bad, 'src/'), `file ${JSON.stringify(bad)} threw`);
    assert.equal(
      matchesPathPattern('src/a.js', bad, { bareNameIsSubtree: true }),
      false,
      `pattern ${JSON.stringify(bad)} must match nothing, not everything`,
    );
  }
});

test('a pattern that is only a glob star is not silently a match-nothing', () => {
  // `**` genuinely means everything, and an operator who writes it in off_limits means it.
  // Asserted so the degenerate-input guard above cannot grow to swallow this case.
  assert.equal(matchesPathPattern('src/a.js', '**'), true);
});
