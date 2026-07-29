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
