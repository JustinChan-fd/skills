// resolve-target CLI. These run against the REAL config/user.json and
// config/projects.json — the only place the config wiring is exercised
// end-to-end — so they assert on structure and on entries this repo's own
// config guarantees, never on values the user is free to change (defaultRepo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../tools/harness.mjs', import.meta.url));

function run(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.status, out: err.stdout ? JSON.parse(err.stdout) : null };
  }
}

test('resolve-target --hint jarvis resolves the alias and its github source', () => {
  const r = run(['resolve-target', '--hint', 'jarvis']);
  assert.equal(r.code, 0);
  assert.equal(r.out.alias, 'jarvis');
  assert.equal(r.out.issue_source, 'github');
  assert.ok(r.out.github, 'expected a github slug for jarvis');
  assert.equal(r.out.resolved_from, 'hint_alias');
});

test('resolve-target --hint TARS-1272 resolves via projects.json and pins the key', () => {
  const r = run(['resolve-target', '--hint', 'TARS-1272']);
  assert.equal(r.code, 0);
  assert.equal(r.out.project_key, 'TARS');
  assert.equal(r.out.pinned_issue, 'TARS-1272');
  assert.equal(r.out.issue_source, 'jira');
  assert.ok(r.out.cloud_id, 'expected a cloud id from projects.json');
});

test('resolve-target --item pins a github issue number', () => {
  const r = run(['resolve-target', '--hint', 'jarvis', '--item', '4']);
  assert.equal(r.code, 0);
  assert.equal(r.out.pinned_issue, '4');
  assert.equal(r.out.alias, 'jarvis');
});

test('a bare number on a jira repo is qualified from the real config', () => {
  // The real user.json alias path and the real projects.json TARS repoPath are
  // the same repo, so a bare 1272 is addressable as TARS-1272.
  const r = run(['resolve-target', '--hint', 'webtarsthree', '--item', '1272']);
  assert.equal(r.code, 0);
  assert.equal(r.out.pinned_issue, 'TARS-1272');
});

test('an unparseable item exits 1 rather than silently dropping the pin', () => {
  const r = run(['resolve-target', '--hint', 'jarvis', '--item', 'banana']);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /unresolvable_item/);
});

test('an unresolvable hint exits 1 with an error, not a default repo', () => {
  const r = run(['resolve-target', '--hint', 'definitely-not-a-repo']);
  assert.equal(r.code, 1);
  assert.equal(typeof r.out.error, 'string');
  assert.match(r.out.error, /unresolvable_hint/);
  // An unknown SUBCOMMAND also exits 1 with an `error` string, so without this
  // the test would pass before resolve-target existed at all.
  assert.equal(r.out.usage, undefined, 'must be a resolution failure, not a usage dump');
  assert.equal(r.out.alias, undefined, 'must not emit a target alongside the error');
});

test('no args resolves the configured default repo', () => {
  // Deliberately does not hardcode which repo that is — the user owns
  // defaultRepo, and pinning its value here would make their config edit
  // look like a test regression.
  const r = run(['resolve-target', '--cwd', '/tmp']);
  assert.equal(r.code, 0);
  assert.equal(r.out.resolved_from, 'default');
  assert.ok(typeof r.out.alias === 'string' && r.out.alias.length > 0);
  assert.ok(r.out.path.startsWith('/'), 'path must be absolute');
  assert.equal(r.out.pinned_issue, null);
});

test('the envelope carries every field a caller routes on', () => {
  const r = run(['resolve-target', '--hint', 'jarvis']);
  assert.equal(r.code, 0);
  for (const key of ['alias', 'path', 'issue_source', 'github', 'cloud_id',
    'project_key', 'pinned_issue', 'resolved_from']) {
    assert.ok(key in r.out, `missing envelope field: ${key}`);
  }
});
