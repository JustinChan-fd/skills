// Jira project resolution grafted from Desktop config.js:resolveProject.
// Maps a Jira issue key prefix (TARS-1271 → TARS) to a repo path + cloud id,
// so SKILL.md wrappers resolve the target repo deterministically instead of
// guessing from git remotes.
// SOURCE: ~/Desktop/Repos/skills/config.js (PROJECTS map + resolveProject).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject, loadProjects } from '../tools/lib/config.mjs';

test('loadProjects returns the projects.json map with a default cloud id', () => {
  const { projects, defaultCloudId } = loadProjects();
  assert.equal(typeof projects, 'object');
  assert.ok('TARS' in projects, 'TARS must be a known project prefix');
  assert.equal(defaultCloudId, 'fandango.atlassian.net');
});

test('resolveProject maps a Jira issue key prefix to repoPath + cloudId', () => {
  const r = resolveProject('TARS-1271');
  assert.equal(r.cloudId, 'fandango.atlassian.net');
  assert.ok(r.repoPath.endsWith('/webtarsthree'), `expected webtarsthree, got ${r.repoPath}`);
});

test('resolveProject is case-insensitive on the prefix', () => {
  assert.deepEqual(resolveProject('tars-9'), resolveProject('TARS-9'));
});

test('resolveProject maps multiple prefixes to the same repo (TARS and RTFE)', () => {
  assert.equal(resolveProject('RTFE-5').repoPath, resolveProject('TARS-5').repoPath);
});

test('resolveProject returns null for an unknown prefix or empty input', () => {
  assert.equal(resolveProject('ZZZ-1'), null);
  assert.equal(resolveProject(''), null);
  assert.equal(resolveProject(null), null);
});
