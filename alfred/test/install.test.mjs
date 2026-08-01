// WHAT THIS FILE GUARDS. `~/.claude/skills/alfred` is the path the skill loads from when someone
// types `/alfred work #21`. `alfred/` in this repository is the tree the suite grades. This file
// asserts they are the SAME TREE — so a green suite is a statement about the bytes that actually
// run.
//
// THEY ARE ALREADY THE SAME, AND THE MECHANISM IS ONE LEVEL UP. `~/.claude/skills` is itself a
// symlink to this repository, so every skill in it is the repo's own directory reached by a second
// path. Nothing is copied and nothing needs syncing.
//
// WRITTEN AFTER GETTING THIS EXACTLY BACKWARDS. The belief that the install was a stale COPY was
// checked with `diff -rq <repo>/alfred ~/.claude/skills/alfred`, which printed nothing — read as
// "identical, so it is a freshly-synced copy". It printed nothing because it was comparing a
// directory to ITSELF: a comparison that cannot fail is not evidence, and this one was chosen
// because it agreed with a conclusion already reached. `ls -ld` on the PARENT would have shown the
// symlink immediately. Acting on that reading moved the real tree aside and left a self-referential
// link in its place, which made every file under `alfred/` unreadable until it was restored.
//
// SO THE ASSERTION IS RESOLVED IDENTITY, NOT MECHANISM. `realpath` both sides and compare: true
// whether the link is at `skills/`, at `skills/alfred`, or absent because the repo IS the skills
// directory. A test asserting "is a symlink" would encode today's layout and fail on a rearrangement
// that is perfectly correct — and, worse, would have PASSED on the self-referential link that broke
// everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const INSTALL = join(homedir(), '.claude', 'skills', 'alfred');

// PRESENCE, NOT RESOLVABILITY. `existsSync` FOLLOWS the link, so a dangling or self-referential
// install reports false and would take the "no install" skip below — the test going silent on
// exactly the breakage it exists to catch. MEASURED: mutants M2 (self-referential) and M3
// (dangling) both skipped instead of failing until this was split out. `lstat` answers "is there an
// entry here", which is the question the skip should be gated on.
function installEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// `readlink` throws EINVAL on a path that is not a link, so building a FAILURE MESSAGE with it
// crashes exactly when the assertion was about to fail — the test then reports EINVAL instead of
// the diagnosis, which is how a test comes to fail for a reason nobody can act on.
function linkTarget(path) {
  try {
    return readlinkSync(path);
  } catch {
    return '(not a symlink)';
  }
}

test('the installed skill resolves to THIS tree, so the suite grades the code that runs', (t) => {
  // ABSENT IS FINE, DIVERGENT IS NOT. A checkout on a machine that has never installed the skill
  // is not broken, and a suite that failed there would be one people learn to run with a filter.
  if (!installEntryExists(INSTALL)) {
    t.skip(`no install at ${INSTALL} — nothing to keep in step`);
    return;
  }

  // ELOOP-SAFE. `realpath` on a self-referential link THROWS, which would make this test error
  // with a filesystem code instead of failing with a diagnosis — and would mask the next test.
  // Resolved to null so the reachability test below is the one that speaks.
  let resolved = null;
  try {
    resolved = realpathSync(INSTALL);
  } catch {
    t.skip(`${INSTALL} cannot be resolved (it points at ${linkTarget(INSTALL)}) — see the next test`);
    return;
  }

  assert.equal(
    resolved,
    realpathSync(SKILL_DIR),
    `${INSTALL} resolves to a different tree than this repository, so /alfred would run code this ` +
      `suite does not grade. It points at ${linkTarget(INSTALL)}. Either symlink ` +
      `~/.claude/skills (or ~/.claude/skills/alfred) at this checkout, or delete the divergent copy.`,
  );
});

test('and the install is not a self-referential or dangling link', (t) => {
  if (!installEntryExists(INSTALL)) {
    t.skip('no install');
    return;
  }

  // THE FALSIFIER FOR THE TEST ABOVE, and it is not hypothetical — it is the exact state this file
  // was written in response to. `realpath` on a link that points at its own path throws ELOOP, so
  // the identity assertion above would ERROR rather than fail, reporting a filesystem code instead
  // of a diagnosis. These three checks name the breakage in the operator's terms.
  //
  // `existsSync` follows links, so a dangling link fails here too. Both cases pass an
  // "is a symlink" check while the skill is completely unloadable, which is why that is not the
  // check this file makes.
  for (const rel of ['SKILL.md', 'bin/alfred', 'lib/cli.mjs']) {
    assert.ok(
      existsSync(join(INSTALL, rel)),
      `${rel} is unreachable through ${INSTALL} (it points at ${linkTarget(INSTALL)}) — the skill ` +
        `cannot load. A link pointing at its own path produces exactly this.`,
    );
  }

  // And the link, if there is one, does not name its own containing path — the specific mistake.
  if (lstatSync(INSTALL).isSymbolicLink()) {
    assert.notEqual(
      readlinkSync(INSTALL),
      INSTALL,
      `${INSTALL} is a symlink to itself; nothing under it can be read`,
    );
  }
});
