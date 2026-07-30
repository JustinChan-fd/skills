// The `user.json` sandbox alias — the last piece arm B needs.
//
// SANDBOX.md §6 pre-cleared this as *configuration, not a code change*, so it
// does not invalidate the arm-A-vs-arm-B comparison. But the file it edits is
// `harness-core/config/user.json`, which is gitignored (machine-local) and holds
// the live pointers to three real repos plus the telemetry sink. So the bar here
// is not "does it add a key" — it is "can it touch that file without collateral
// damage."
//
// Every test writes to a scratch copy. Nothing here touches the real user.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withAlias, writeAlias, SANDBOX_ALIAS } from '../lib/sandbox-alias.mjs';

// Shaped like the real user.json, including the parts that must survive.
const USER = {
  repos: {
    webtarsthree: { path: '~/Desktop/Repos/webtarsthree', issue_source: 'jira' },
    jarvis: {
      path: '~/Desktop/Repos/jarvis',
      issue_source: 'github',
      github: 'JustinChan-fd/jarvis',
    },
  },
  defaultRepo: 'webtarsthree',
  billing_mode: 'api',
  telemetry: { repo: 'JustinChan-fd/harness-telemetry', dir: '~/.harness/telemetry' },
};

const PROVISIONED = {
  slug: 'sandbox-a',
  repo: '/tmp/alfred-eval/sandbox-a',
  github: 'JustinChan-fd/skills',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function scratchUser(contents = USER) {
  const dir = await mkdtemp(join(tmpdir(), 'sandbox-alias-'));
  const path = join(dir, 'user.json');
  await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`);
  return { dir, path };
}

// --- the pure transform ---

test('the alias points at the provisioned repo with issue_source github', () => {
  const next = withAlias(USER, PROVISIONED);
  const entry = next.repos[SANDBOX_ALIAS];
  assert.equal(entry.path, PROVISIONED.repo);
  assert.equal(entry.issue_source, 'github');
  assert.equal(entry.github, PROVISIONED.github);
});

test('the alias path is the working clone, not the provision root', () => {
  // `provision` returns both. Pointing harness-core at the root would give it a
  // directory that is not a git repo at all.
  assert.equal(withAlias(USER, PROVISIONED).repos[SANDBOX_ALIAS].path, PROVISIONED.repo);
});

test('code path and issue host are allowed to differ, and both are recorded', () => {
  // This is the whole point of the alias, and the open risk SANDBOX.md §6 logged:
  // the code lives in a temp dir, the issue lives in JustinChan-fd/skills.
  const entry = withAlias(USER, PROVISIONED).repos[SANDBOX_ALIAS];
  assert.ok(entry.path.startsWith('/tmp/'));
  assert.equal(entry.github, 'JustinChan-fd/skills');
  assert.notEqual(entry.path, entry.github);
});

test('every existing repo entry survives untouched', () => {
  const next = withAlias(USER, PROVISIONED);
  assert.deepEqual(next.repos.webtarsthree, USER.repos.webtarsthree);
  assert.deepEqual(next.repos.jarvis, USER.repos.jarvis);
});

test('defaultRepo is never changed to the sandbox', () => {
  // If it were, a later real `init-run` with no --repo would silently target a
  // throwaway temp clone.
  assert.equal(withAlias(USER, PROVISIONED).defaultRepo, 'webtarsthree');
});

test('telemetry and billing config are preserved', () => {
  const next = withAlias(USER, PROVISIONED);
  assert.deepEqual(next.telemetry, USER.telemetry);
  assert.equal(next.billing_mode, USER.billing_mode);
});

test('the transform does not mutate the input', () => {
  const input = clone(USER);
  withAlias(input, PROVISIONED);
  assert.deepEqual(input, USER);
});

test('applying it twice is identical to applying it once', () => {
  const once = withAlias(USER, PROVISIONED);
  assert.deepEqual(withAlias(once, PROVISIONED), once);
});

test('a stale alias path is updated to the new provision', () => {
  // Each arm provisions fresh, so the path moves. A stale path is the failure
  // mode this helper exists to prevent.
  const stale = withAlias(USER, { ...PROVISIONED, repo: '/tmp/old-run/sandbox-a' });
  const fresh = withAlias(stale, PROVISIONED);
  assert.equal(fresh.repos[SANDBOX_ALIAS].path, PROVISIONED.repo);
});

test('an alias colliding with a real repo entry is refused', () => {
  // Guards a slug typo like `jarvis` from redirecting a real repo at a temp dir.
  const collision = { ...PROVISIONED, slug: 'jarvis' };
  assert.throws(() => withAlias(USER, collision), /jarvis/);
});

test('a user.json with no repos map at all is handled', () => {
  const next = withAlias({ defaultRepo: 'x' }, PROVISIONED);
  assert.equal(next.repos[SANDBOX_ALIAS].github, PROVISIONED.github);
  assert.equal(next.defaultRepo, 'x');
});

// --- writing the file ---

test('writeAlias edits user.json in place and leaves it valid JSON', async () => {
  const { dir, path } = await scratchUser();
  await writeAlias({ userFile: path, provisioned: PROVISIONED });

  const written = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(written.repos[SANDBOX_ALIAS].path, PROVISIONED.repo);
  assert.deepEqual(written.repos.webtarsthree, USER.repos.webtarsthree);
  assert.equal(written.defaultRepo, 'webtarsthree');
  await rm(dir, { recursive: true, force: true });
});

test('the written file keeps two-space indent and a trailing newline', async () => {
  // It is a hand-edited file. Reformatting it would make every eval run show up
  // as a diff in the user's editor.
  const { dir, path } = await scratchUser();
  await writeAlias({ userFile: path, provisioned: PROVISIONED });

  const raw = await readFile(path, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.match(raw, /^ {2}"repos": \{$/m);
  await rm(dir, { recursive: true, force: true });
});

test('writeAlias reports what it did, and reports a noop as a noop', async () => {
  const { dir, path } = await scratchUser();
  const first = await writeAlias({ userFile: path, provisioned: PROVISIONED });
  assert.equal(first.changed, true);
  assert.equal(first.alias, SANDBOX_ALIAS);

  const second = await writeAlias({ userFile: path, provisioned: PROVISIONED });
  assert.equal(second.changed, false);
  await rm(dir, { recursive: true, force: true });
});

test('a noop leaves the file byte-for-byte identical', async () => {
  const { dir, path } = await scratchUser();
  await writeAlias({ userFile: path, provisioned: PROVISIONED });
  const before = await readFile(path, 'utf8');
  await writeAlias({ userFile: path, provisioned: PROVISIONED });
  assert.equal(await readFile(path, 'utf8'), before);
  await rm(dir, { recursive: true, force: true });
});

test('a missing user.json fails loudly rather than creating one', async () => {
  // Writing a fresh user.json would produce a file with a sandbox alias and no
  // real repos — which reads as a working config and is not one.
  const dir = await mkdtemp(join(tmpdir(), 'sandbox-alias-missing-'));
  await assert.rejects(
    () => writeAlias({ userFile: join(dir, 'user.json'), provisioned: PROVISIONED }),
    /user\.json/,
  );
  await rm(dir, { recursive: true, force: true });
});

test('a malformed user.json is not overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandbox-alias-bad-'));
  const path = join(dir, 'user.json');
  await writeFile(path, '{ this is not json');
  await assert.rejects(() => writeAlias({ userFile: path, provisioned: PROVISIONED }));
  assert.equal(await readFile(path, 'utf8'), '{ this is not json');
  await rm(dir, { recursive: true, force: true });
});

test('writeAlias accepts a provision result directly', async () => {
  // What `provision` returns has `slug` and `repo` but no `github` — the github
  // slug comes from the fixture manifest's eval_issue.repo, so callers must not
  // be required to hand-assemble the shape.
  const { dir, path } = await scratchUser();
  const result = await writeAlias({
    userFile: path,
    provisioned: { slug: 'sandbox-a', repo: '/tmp/x/sandbox-a' },
    github: 'JustinChan-fd/skills',
  });
  assert.equal(result.changed, true);
  const written = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(written.repos[SANDBOX_ALIAS].github, 'JustinChan-fd/skills');
  await rm(dir, { recursive: true, force: true });
});

test('a provisioned repo with no github slug anywhere is refused', async () => {
  // Without it, harness-core would resolve issue_source github and then have no
  // repo to query — a confusing mid-run failure instead of a clear setup one.
  const { dir, path } = await scratchUser();
  await assert.rejects(
    () => writeAlias({ userFile: path, provisioned: { slug: 'sandbox-a', repo: '/tmp/x' } }),
    /github/i,
  );
  await rm(dir, { recursive: true, force: true });
});
