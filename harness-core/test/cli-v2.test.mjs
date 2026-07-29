// CLI v2 graft: resolve-project subcommand + init-run/run-end accept the
// parent-loop-association, correlation, provenance, and perf flags and stamp
// them onto the run record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readRecord } from '../tools/lib/record.mjs';

const CLI = fileURLToPath(new URL('../tools/harness.mjs', import.meta.url));

function run(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.status, out: err.stdout ? JSON.parse(err.stdout) : null };
  }
}

test('resolve-project maps a Jira issue key to repoPath + cloudId', () => {
  const r = run(['resolve-project', '--issue', 'TARS-1271']);
  assert.equal(r.code, 0);
  assert.equal(r.out.cloudId, 'fandango.atlassian.net');
  assert.ok(r.out.repoPath.endsWith('/webtarsthree'));
});

test('resolve-project exits 1 on an unknown prefix', () => {
  const r = run(['resolve-project', '--issue', 'ZZZ-9']);
  assert.equal(r.code, 1);
});

test('init-run stamps the v2 association + provenance flags onto the record', () => {
  // Source-format for Jira keys (issue-TARS-1271) is an M1 concern (runid + jira.mjs);
  // this M0 test uses adhoc so it exercises only the v2 stamping, not source parsing.
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-cliv2-'));
  const init = run(['init-run', '--target', targetDir, '--repo', 'webtarsthree', '--kind', 'intake',
    '--source', 'adhoc', '--issue', 'TARS-1271',
    '--parent-run-id', 'LOOP_RUN_ID', '--correlation-id', 'TARS-1271-20260727T090000Z',
    '--repo-path', '/Users/x/Desktop/Repos/webtarsthree', '--skills-commit', 'abc1234']);
  assert.equal(init.code, 0);
  const r = readRecord(init.out.run_dir);
  assert.equal(r.parent_run_id, 'LOOP_RUN_ID');
  assert.equal(r.correlation_id, 'TARS-1271-20260727T090000Z');
  assert.equal(r.repo_path, '/Users/x/Desktop/Repos/webtarsthree');
  assert.equal(r.skills_commit, 'abc1234');
});

// `--repo` reads identically on `init-run` and on `gh issue view --repo
// <owner/repo>`, so callers passed the github slug and record.repo was wrong at
// BIRTH — it became the run-id stem and the telemetry directory name, splitting
// one local repo across two identities in the sink. init-run canonicalizes
// against user.json so the identity is decided in code, not per caller.
// Depends on the real config/user.json registering jarvis → JustinChan-fd/jarvis.
test('init-run canonicalizes a github slug to its user.json repo key', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-canon-'));
  const init = run(['init-run', '--target', targetDir, '--repo', 'JustinChan-fd/jarvis',
    '--kind', 'intake', '--source', 'adhoc']);
  assert.equal(init.code, 0);
  assert.equal(readRecord(init.out.run_dir).repo, 'jarvis');
  // The run-id stem carries the canonical repo too, not the owner-qualified slug.
  assert.match(init.out.run_id, /^\d{4}-\d{2}-\d{2}T\d{6}Z__jarvis__intake__adhoc__[0-9a-f]{6}$/);
});

// An unregistered repo must still work: adhoc targets have no user.json entry.
test('init-run leaves an unregistered repo name alone', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-canon2-'));
  const init = run(['init-run', '--target', targetDir, '--repo', 'myapp',
    '--kind', 'intake', '--source', 'adhoc']);
  assert.equal(init.code, 0);
  assert.equal(readRecord(init.out.run_dir).repo, 'myapp');
});

test('jira-normalize reads a getJiraIssue JSON file and prints the neutral intake shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-jira-'));
  const file = join(dir, 'issue.json');
  writeFileSync(file, JSON.stringify({
    key: 'TARS-1271',
    fields: { summary: 'Clear button bug', description: 'stays selected', issuetype: { name: 'Bug' }, project: { key: 'TARS' } },
  }));
  const r = run(['jira-normalize', '--file', file]);
  assert.equal(r.code, 0);
  assert.equal(r.out.key, 'TARS-1271');
  assert.equal(r.out.change_type, 'fix');
  assert.equal(r.out.project_key, 'TARS');
  assert.ok(r.out.input.includes('Clear button bug'));
});

test('jira-normalize exits 1 on a malformed issue (no summary)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-jira-'));
  const file = join(dir, 'bad.json');
  writeFileSync(file, JSON.stringify({ key: 'TARS-1', fields: {} }));
  assert.equal(run(['jira-normalize', '--file', file]).code, 1);
});

test('plan-order topologically orders a plan manifest by dependsOn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-planord-'));
  const file = join(dir, 'plan-manifest.json');
  writeFileSync(file, JSON.stringify({ plans: [
    { id: 'p2', jsonPath: 'b.json', dependsOn: ['p1'] },
    { id: 'p1', jsonPath: 'a.json', dependsOn: [] },
  ] }));
  const r = run(['plan-order', '--manifest', file]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.order.map((p) => p.id), ['p1', 'p2']);
});

test('plan-order exits 1 on a circular dependency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-planord-'));
  const file = join(dir, 'plan-manifest.json');
  writeFileSync(file, JSON.stringify({ plans: [
    { id: 'p1', jsonPath: 'a.json', dependsOn: ['p2'] },
    { id: 'p2', jsonPath: 'b.json', dependsOn: ['p1'] },
  ] }));
  assert.equal(run(['plan-order', '--manifest', file]).code, 1);
});

test('split-tasks splits an oversized task into same-group parallel chunks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-split-'));
  const file = join(dir, 'plan.json');
  const locations = Array.from({ length: 20 }, (_, i) => `src/client/f${i}.js`);
  writeFileSync(file, JSON.stringify({
    run_id: 'R1',
    units: [
      { id: 'T05', title: 'migrate', group_id: 'G3', block: 'sequential', locations, done_criteria: ['no axios'] },
    ],
    order: ['T05'],
    schema_version: '1.0.0',
  }));
  const r = run(['split-tasks', '--plan', file]);
  assert.equal(r.code, 0);
  assert.ok(r.out.units.length > 1, 'oversized unit should split');
  for (const t of r.out.units) {
    assert.ok(t.locations.length <= 8, `chunk ${t.id} over cap`);
    assert.equal(t.block, 'parallel');
    assert.equal(t.group_id, 'G3');
  }
});

test('run-end persists active-ms, agent-count, and skill-metrics', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-cliv2-'));
  const offlineEnv = { ...process.env, HARNESS_TELEMETRY_REMOTE: join(targetDir, 'no.git'), HARNESS_TELEMETRY_DIR: join(targetDir, 'clone') };
  const init = run(['init-run', '--target', targetDir, '--repo', 'myapp', '--kind', 'intake', '--source', 'adhoc']);
  const end = run(['run-end', '--target', targetDir, '--run-dir', init.out.run_dir, '--status', 'succeeded',
    '--active-ms', '41000',
    '--agent-count', JSON.stringify({ by_model: { 'claude-haiku-4-5-20251001': 20 }, by_phase: { Intake: 3 } }),
    '--skill-metrics', JSON.stringify({ intakeManifestPath: 'docs/x.json', size_from_intake: 'S' })],
    { env: offlineEnv });
  assert.equal(end.code, 0);
  const r = readRecord(init.out.run_dir);
  assert.equal(r.active_ms, 41000);
  assert.deepEqual(r.agent_count.by_model, { 'claude-haiku-4-5-20251001': 20 });
  assert.equal(r.skill_metrics.size_from_intake, 'S');
});

// resolve-target base_branch: the CLI half of the epic-base fix. target.mjs is
// unit tested against injected fixtures; these pin the wiring — real
// projects.json, real git-backed branchExists, real exit codes — because the
// bug being closed lived in the seam between resolution and the caller, not in
// either one alone.
test('resolve-target derives base_branch from a mapped epic', () => {
  const r = run(['resolve-target', '--hint', 'TARS-1272', '--epic', 'TARS-1135']);
  assert.equal(r.code, 0);
  assert.equal(r.out.base_branch, 'feat/migrate-native-fetch-from-axios');
  assert.equal(r.out.base_resolved_from, 'epic');
});

test('resolve-target falls back to the project default branch with no epic', () => {
  const r = run(['resolve-target', '--hint', 'TARS-1272']);
  assert.equal(r.code, 0);
  assert.equal(r.out.base_branch, 'master');
  assert.equal(r.out.base_resolved_from, 'default');
});

test('resolve-target exits 1 on a base branch that does not exist', () => {
  // The guard that stops a silent retarget to master. Exit code matters as much
  // as the payload: the calling skill branches on it.
  const r = run(['resolve-target', '--hint', 'TARS-1272', '--base', 'no/such/branch']);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /missing_base_branch/);
});

test('resolve-target lets an explicit base outrank a mapped epic', () => {
  const r = run(['resolve-target', '--hint', 'TARS-1272', '--epic', 'TARS-1135', '--base', 'master']);
  assert.equal(r.code, 0);
  assert.equal(r.out.base_branch, 'master');
  assert.equal(r.out.base_resolved_from, 'flag');
});
