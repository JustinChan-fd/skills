// One path matcher for operator-written patterns, because there were two and they agreed
// only by accident.
//
// `node:path`'s `matchesGlob` is a glob matcher, and a glob is not what an operator writes.
// Measured (#69):
//
//   matchesGlob('src/vendor/legacy.js', 'src/vendor/')   === false
//   matchesGlob('src/vendor/legacy.js', 'src/vendor')    === false
//   matchesGlob('src/vendor/legacy.js', 'src/vendor/**') === true
//
// Only the last form works, and it is the form the gate's own test config uses — while both
// fixture manifests declare `off_limits: ["src/vendor/"]`. So the off-limits rule was green
// against a pattern its real input never carries, and silent on the two forms a human writes
// by hand. Both live call sites were affected, in opposite directions:
//
//   off_limits    ["src/vendor/"]   permitted every write under src/vendor/
//   declaredScope ["src/channels/"] failed a run for editing src/channels/sms.js
//
// The second was measured the same way and is the more embarrassing of the two: a scope
// declaration that rejects the file it declares.
//
// THE ASYMMETRY IS WHY THIS TAKES A FLAG rather than one behavior. A trailing slash is
// unambiguous — nobody writes `src/vendor/` to mean one file — so both callers get the
// subtree reading for free. A BARE name is genuinely ambiguous, and the two callers need
// opposite defaults:
//
//   off_limits: ["src/vendor"]      an operator naming a directory in a DENY list means the
//                                   subtree. Reading it as one inode permits the writes.
//   declaredScope: ["src/retry.js"] a declared file means that file. Reading it as a prefix
//                                   admits `src/retry.js/nested.js`, granting permission
//                                   nobody wrote down.
//
// Widening a deny list fails SAFE (more caught, and a false positive costs one run).
// Widening an allow list fails OPEN (more permitted, and a false negative costs the
// protection). So the direction is a parameter the caller states, never a default either
// side inherits — and `bareNameIsSubtree` defaults to the conservative reading, so a new
// call site that forgets to think about it gets the allow-list behavior.

import { matchesGlob } from 'node:path';

// Backslashes to forward, `./` prefix dropped, repeated and trailing slashes collapsed.
// `git diff --name-only` output and a hand-written pattern do not agree on form, and an
// unnormalized compare reads "not off limits" and PERMITS the write.
//
// Returns '' for anything that normalizes to nothing — `''`, `'/'`, `'.'`, `'./'` — and
// every caller below treats '' as matching nothing. An empty pattern reaching a prefix
// compare would match EVERY file, silently declaring the whole tree off limits or the whole
// tree in scope depending on which caller asked.
function normalizePath(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .split('\\')
    .join('/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .trim();
  return cleaned === '.' || cleaned === '/' ? '' : cleaned;
}

const hasGlob = (pattern) => /[*?[\]{}]/.test(pattern);

// Does `file` fall under the directory `dir`? Segment-boundary aware, which is the whole
// reason this is not `startsWith`: `src/vendorish/x.js` starts with `src/vendor` and is a
// different directory. A rule that fails runs for editing an unrelated directory gets
// ignored, and an ignored rule protects nothing.
const underDirectory = (file, dir) => file === dir || file.startsWith(`${dir}/`);

export function matchesPathPattern(file, pattern, { bareNameIsSubtree = false } = {}) {
  // A trailing slash is the operator SAYING "directory", so it is read before normalizing
  // it away. Checked on the raw string because normalizePath strips it.
  const declaresDirectory = typeof pattern === 'string' && /[/\\]\s*$/.test(pattern);

  const target = normalizePath(file);
  const raw = typeof pattern === 'string' ? pattern.trim() : '';

  // A glob is honoured exactly as before, ahead of any normalization that would mangle it.
  // Thirteen frozen gate names use `**`, and changing what a glob means would leave them
  // measuring something other than what they were frozen against.
  if (hasGlob(raw)) return matchesGlob(normalizePath(file), raw.split('\\').join('/').replace(/^\.\//, ''));

  const dir = normalizePath(pattern);
  if (!target || !dir) return false;

  if (declaresDirectory || bareNameIsSubtree) return underDirectory(target, dir);
  return target === dir;
}
