// Deterministic target + work-item resolution. Fixtures are INLINE on purpose:
// these tests must not break when the user edits their own repo registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTarget } from '../tools/lib/target.mjs';

const USER = {
  repos: {
    webtarsthree: { path: '~/Desktop/Repos/webtarsthree', issue_source: 'jira' },
    jarvis: { path: '~/Desktop/Repos/jarvis', issue_source: 'github', github: 'JustinChan-fd/jarvis' },
  },
  defaultRepo: 'webtarsthree',
};
const PROJECTS = {
  TARS: { repoPath: '/abs/webtarsthree', cloudId: 'x.atlassian.net' },
  PIZZA: { repoPath: '/abs/pizza-pie', cloudId: 'x.atlassian.net' },
};
const BASE = { user: USER, projects: PROJECTS, defaultCloudId: 'x.atlassian.net' };

test('an alias hint resolves to its repo and issue source', () => {
  const r = resolveTarget({ hint: 'jarvis', ...BASE });
  assert.equal(r.ok, true);
  assert.equal(r.target.alias, 'jarvis');
  assert.equal(r.target.issue_source, 'github');
  assert.equal(r.target.github, 'JustinChan-fd/jarvis');
  assert.equal(r.target.resolved_from, 'hint_alias');
  assert.equal(r.target.pinned_issue, null);
});

test('an alias hint is case-insensitive', () => {
  assert.equal(resolveTarget({ hint: 'JARVIS', ...BASE }).target.alias, 'jarvis');
});

test('a Jira key hint resolves via projects.json AND pins the item', () => {
  const r = resolveTarget({ hint: 'TARS-1272', ...BASE });
  assert.equal(r.ok, true);
  assert.equal(r.target.project_key, 'TARS');
  assert.equal(r.target.cloud_id, 'x.atlassian.net');
  assert.equal(r.target.pinned_issue, 'TARS-1272');
  assert.equal(r.target.issue_source, 'jira');
  assert.equal(r.target.resolved_from, 'hint_jira_key');
});

test('a lowercase Jira key is uppercased', () => {
  assert.equal(resolveTarget({ hint: 'tars-1272', ...BASE }).target.pinned_issue, 'TARS-1272');
});

test('a projects.json-only repo gets alias null and defaults to jira', () => {
  // PIZZA has no user.json repos entry. This is real: projects.json has 6
  // prefixes, user.json has 3 aliases. Arriving via a Jira prefix IS the
  // evidence the repo is Jira-tracked.
  const r = resolveTarget({ hint: 'PIZZA-9', ...BASE });
  assert.equal(r.ok, true);
  assert.equal(r.target.alias, null);
  assert.equal(r.target.issue_source, 'jira');
  assert.equal(r.target.project_key, 'PIZZA');
});

test('an unresolvable hint is an ERROR and never falls back to defaultRepo', () => {
  // The load-bearing guard: silently ticking webtarsthree because someone
  // typo'd an alias is the worst available outcome.
  const r = resolveTarget({ hint: 'jarvsi', ...BASE });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unresolvable_hint');
});

test('an unknown Jira prefix is unresolvable, not a default', () => {
  const r = resolveTarget({ hint: 'NOPE-1', ...BASE });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unresolvable_hint');
});

test('no hint falls back to defaultRepo', () => {
  const r = resolveTarget({ ...BASE });
  assert.equal(r.target.alias, 'webtarsthree');
  assert.equal(r.target.resolved_from, 'default');
});

test('cwd inside a registered repo beats defaultRepo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgt-'));
  const repo = join(dir, 'jarvis');
  mkdirSync(repo);
  const user = { repos: { jarvis: { path: repo, issue_source: 'github' } }, defaultRepo: 'webtarsthree' };
  const r = resolveTarget({ cwd: repo, user, projects: {}, defaultCloudId: null });
  assert.equal(r.target.alias, 'jarvis');
  assert.equal(r.target.resolved_from, 'cwd');
});

test('a hint beats a cwd match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgt-'));
  const repo = join(dir, 'jarvis');
  mkdirSync(repo);
  const user = {
    repos: { jarvis: { path: repo, issue_source: 'github' }, other: { path: '~/other', issue_source: 'jira' } },
    defaultRepo: 'jarvis',
  };
  const r = resolveTarget({ hint: 'other', cwd: repo, user, projects: {}, defaultCloudId: null });
  assert.equal(r.target.alias, 'other');
  assert.equal(r.target.resolved_from, 'hint_alias');
});

test('item normalization: bare number, #N, and "issue N" all yield the number', () => {
  for (const item of ['4', '#4', 'issue 4']) {
    assert.equal(resolveTarget({ hint: 'jarvis', item, ...BASE }).target.pinned_issue, '4',
      `failed for ${item}`);
  }
});

// --- URLs ------------------------------------------------------------------
// A pasted link is the natural way to name work, and it carries BOTH a repo and
// an item. Before these tests, `normalizeItem`'s trailing-digit regex scraped
// whatever number ended the string: a comment anchor pinned the comment id, and
// a cross-project Jira link was re-labelled with the hinted repo's prefix. Both
// silently ticked something the user never named.

test('a github issue URL yields its issue number, not its trailing digits', () => {
  const r = resolveTarget({ hint: 'jarvis', item: 'https://github.com/JustinChan-fd/jarvis/issues/4', ...BASE });
  assert.equal(r.ok, true);
  assert.equal(r.target.pinned_issue, '4');
});

test('a github URL with a comment anchor still pins the ISSUE, not the comment id', () => {
  // The regression that prompted all of this: copying a link out of a comment
  // thread is normal, and `3184779201` is not an issue at all.
  const r = resolveTarget({
    hint: 'jarvis',
    item: 'https://github.com/JustinChan-fd/jarvis/issues/4#issuecomment-3184779201',
    ...BASE,
  });
  assert.equal(r.ok, true);
  assert.equal(r.target.pinned_issue, '4');
});

test('a github URL whose number runs into other characters is refused', () => {
  // Pins the boundary group in GITHUB_ITEM_URL. Without it the regex matches the
  // leading digits of `/issues/4abc` and pins `4` — a number the URL does not
  // actually name. Found by perturbation: dropping the boundary broke no test.
  for (const url of [
    'https://github.com/JustinChan-fd/jarvis/issues/4abc',
    'https://github.com/JustinChan-fd/jarvis/issues/4-foo',
  ]) {
    const r = resolveTarget({ hint: 'jarvis', item: url, ...BASE });
    assert.equal(r.ok, false, `expected refusal for ${url}`);
    assert.equal(r.error.code, 'unresolvable_item');
  }
});

test('a github pull URL is accepted the same as an issues URL', () => {
  // GitHub numbers issues and PRs in one sequence, and /pull/N is what you get
  // from a PR page.
  const r = resolveTarget({ hint: 'jarvis', item: 'https://github.com/JustinChan-fd/jarvis/pull/12', ...BASE });
  assert.equal(r.target.pinned_issue, '12');
});

// A hint + Jira URL that AGREE needs a fixture where the alias path and the
// prefix's repoPath are the same repo — as the real configs are. BASE
// deliberately keeps TARS's repoPath apart from webtarsthree's path so the
// no-alias PIZZA case stays reachable.
function agreeingFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tgt-url-'));
  const repo = join(dir, 'wt3');
  mkdirSync(repo);
  return {
    user: { repos: { wt3: { path: repo, issue_source: 'jira' } }, defaultRepo: 'wt3' },
    projects: { TARS: { repoPath: repo, cloudId: 'x.atlassian.net' } },
    defaultCloudId: null,
  };
}

test('a jira browse URL yields the key whole', () => {
  const r = resolveTarget({ hint: 'wt3', item: 'https://x.atlassian.net/browse/TARS-1272', ...agreeingFixture() });
  assert.equal(r.ok, true);
  assert.equal(r.target.pinned_issue, 'TARS-1272');
});

test('a jira URL with query params or a trailing slash still yields the key', () => {
  for (const url of [
    'https://x.atlassian.net/browse/TARS-1272?filter=myfilter',
    'https://x.atlassian.net/browse/TARS-1272/',
  ]) {
    assert.equal(resolveTarget({ hint: 'wt3', item: url, ...agreeingFixture() }).target.pinned_issue,
      'TARS-1272', `failed for ${url}`);
  }
});

test('a jira URL aimed at a repo with no known prefix is a conflict, not a pin', () => {
  // No evidence the repo IS that project, so pinning the key would tick
  // something that may live in a different repo entirely.
  const r = resolveTarget({ hint: 'jarvis', item: 'https://x.atlassian.net/browse/TARS-1272', ...BASE });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'conflicting_target');
});

test('a URL naming a DIFFERENT repo than the hint is a conflict, not a merge', () => {
  // The user chose this: stop and say so. Keeping the hint and scraping the
  // number produced TARS-9 from a PIZZA-9 link — a plausible key for an issue
  // that has nothing to do with what was pasted.
  const r = resolveTarget({ hint: 'webtarsthree', item: 'https://x.atlassian.net/browse/PIZZA-9', ...BASE });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'conflicting_target');
  // The message must name BOTH sides — the whole point is that the user can see
  // which one was wrong.
  assert.match(r.error.detail, /webtarsthree/);
  assert.match(r.error.detail, /PIZZA/);
});

test('a github URL for another repo conflicts with the hint', () => {
  const r = resolveTarget({ hint: 'jarvis', item: 'https://github.com/someone/other/issues/4', ...BASE });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'conflicting_target');
  assert.match(r.error.detail, /someone\/other/);
});

test('a github URL that agrees with the hint is NOT a conflict', () => {
  // Naming the same repo twice is redundant, not contradictory.
  const r = resolveTarget({ hint: 'jarvis', item: 'https://github.com/JustinChan-fd/jarvis/issues/4', ...BASE });
  assert.equal(r.ok, true);
});

test('a jira URL alone resolves the repo from its project prefix', () => {
  // No hint at all: the URL is fully qualified, so it routes the whole tick.
  const r = resolveTarget({ item: 'https://x.atlassian.net/browse/TARS-1272', ...BASE });
  assert.equal(r.ok, true);
  assert.equal(r.target.project_key, 'TARS');
  assert.equal(r.target.pinned_issue, 'TARS-1272');
  assert.equal(r.target.resolved_from, 'item_url');
});

test('a github URL alone resolves the repo from its owner/repo slug', () => {
  const r = resolveTarget({ item: 'https://github.com/JustinChan-fd/jarvis/issues/4', ...BASE });
  assert.equal(r.ok, true);
  assert.equal(r.target.alias, 'jarvis');
  assert.equal(r.target.issue_source, 'github');
  assert.equal(r.target.pinned_issue, '4');
  assert.equal(r.target.resolved_from, 'item_url');
});

test('a URL alone for an unregistered repo is unresolvable, never a default', () => {
  // Same rule as an unresolvable hint: a URL we cannot map to config must not
  // silently become defaultRepo.
  const r = resolveTarget({ item: 'https://github.com/nobody/unknown-repo/issues/4', ...BASE });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unresolvable_item');
});

test('a URL alone whose jira prefix is unknown is unresolvable', () => {
  const r = resolveTarget({ item: 'https://x.atlassian.net/browse/NOPE-1', ...BASE });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unresolvable_item');
});

test('a URL of an unrecognized shape is refused, not digit-scraped', () => {
  // The root cause: "ends in digits" was treated as "is an issue number".
  for (const url of [
    'https://github.com/JustinChan-fd/jarvis',
    'https://github.com/JustinChan-fd/jarvis/releases/tag/v1.2',
    'https://example.com/whatever/12345',
  ]) {
    const r = resolveTarget({ hint: 'jarvis', item: url, ...BASE });
    assert.equal(r.ok, false, `expected refusal for ${url}`);
    assert.equal(r.error.code, 'unresolvable_item', `wrong code for ${url}`);
  }
});

test('an item that is a Jira key is uppercased and kept whole', () => {
  assert.equal(resolveTarget({ hint: 'webtarsthree', item: 'tars-1300', ...BASE }).target.pinned_issue,
    'TARS-1300');
});

test('an explicit item overrides a Jira-key hint that disagrees', () => {
  const r = resolveTarget({ hint: 'TARS-1272', item: 'TARS-1300', ...BASE });
  assert.equal(r.target.pinned_issue, 'TARS-1300');
});

test('an empty item string is treated as absent', () => {
  assert.equal(resolveTarget({ hint: 'jarvis', item: '  ', ...BASE }).target.pinned_issue, null);
});

test('a bare number on a jira repo is qualified with the project key', () => {
  // "tick webtarsthree 1272" must not pin the unqualified "1272": Jira has no
  // such key, and the tick would fetch nothing. Fixture mirrors the REAL
  // configs, where the alias path and the TARS repoPath are the same repo (the
  // top-level BASE fixture deliberately keeps them apart for the PIZZA case).
  const dir = mkdtempSync(join(tmpdir(), 'tgt-'));
  const repo = join(dir, 'wt3');
  mkdirSync(repo);
  const user = { repos: { wt3: { path: repo, issue_source: 'jira' } }, defaultRepo: 'wt3' };
  const projects = { TARS: { repoPath: repo, cloudId: 'x.atlassian.net' } };
  const r = resolveTarget({ hint: 'wt3', item: '1272', user, projects, defaultCloudId: null });
  assert.equal(r.ok, true);
  assert.equal(r.target.pinned_issue, 'TARS-1272');
});

test('a bare number on a jira repo with no project key is an error', () => {
  // Nothing to qualify with, and an unqualified number cannot address Jira.
  const user = { repos: { orphan: { path: '/tmp', issue_source: 'jira' } }, defaultRepo: 'orphan' };
  const r = resolveTarget({ hint: 'orphan', item: '7', user, projects: {}, defaultCloudId: null });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unresolvable_item');
});

test('a bare number on a github repo stays a bare number', () => {
  assert.equal(resolveTarget({ hint: 'jarvis', item: '4', ...BASE }).target.pinned_issue, '4');
});

test('an unparseable item is an ERROR, never a silent drop', () => {
  // Dropping it would fall through to the lowest-actionable scan and tick a
  // DIFFERENT item than the one named — the same failure class as silently
  // falling back to defaultRepo.
  const r = resolveTarget({ hint: 'jarvis', item: 'banana', ...BASE });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unresolvable_item');
});

test('no defaultRepo and no hint is no_target', () => {
  const r = resolveTarget({ user: { repos: {} }, projects: {}, defaultCloudId: null });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_target');
});

test('a defaultRepo naming a repo that is not registered is no_target', () => {
  const r = resolveTarget({ user: { repos: {}, defaultRepo: 'ghost' }, projects: {}, defaultCloudId: null });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_target');
});

test('~/ paths in user.json and absolute paths in projects.json both normalize', () => {
  // The two config files disagree on format; a cwd/path comparison that skips
  // expandHome silently fails to match.
  const r = resolveTarget({ hint: 'webtarsthree', ...BASE });
  assert.ok(r.target.path.startsWith('/'), 'path must be expanded, not ~/');
  assert.ok(!r.target.path.includes('~'));
});

test('an alias whose path a projects.json prefix also names carries the cloud id', () => {
  // Reconciliation in the other direction: alias-first resolution still picks
  // up project_key/cloud_id when a Jira prefix maps to the same path.
  const dir = mkdtempSync(join(tmpdir(), 'tgt-'));
  const repo = join(dir, 'wt3');
  mkdirSync(repo);
  const user = { repos: { wt3: { path: repo, issue_source: 'jira' } }, defaultRepo: 'wt3' };
  const projects = { TARS: { repoPath: repo, cloudId: 'x.atlassian.net' } };
  const r = resolveTarget({ hint: 'wt3', user, projects, defaultCloudId: null });
  assert.equal(r.target.project_key, 'TARS');
  assert.equal(r.target.cloud_id, 'x.atlassian.net');
});

test('a path hint that exists on disk resolves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgt-'));
  const repo = join(dir, 'jarvis');
  mkdirSync(repo);
  const user = { repos: { jarvis: { path: repo, issue_source: 'github' } }, defaultRepo: 'jarvis' };
  const r = resolveTarget({ hint: repo, user, projects: {}, defaultCloudId: null });
  assert.equal(r.target.resolved_from, 'hint_path');
  assert.equal(r.target.alias, 'jarvis');
  assert.equal(r.target.issue_source, 'github');
});

test('a path hint that does not exist is unresolvable', () => {
  const r = resolveTarget({ hint: '/no/such/repo/anywhere', ...BASE });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unresolvable_hint');
});
