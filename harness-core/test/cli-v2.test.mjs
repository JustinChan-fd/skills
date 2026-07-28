// CLI v2 graft: resolve-project subcommand + init-run/run-end accept the
// parent-loop-association, correlation, provenance, and perf flags and stamp
// them onto the run record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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
  assert.equal(r.loop_run_id, 'LOOP_RUN_ID');
  assert.equal(r.correlation_id, 'TARS-1271-20260727T090000Z');
  assert.equal(r.repo_path, '/Users/x/Desktop/Repos/webtarsthree');
  assert.equal(r.skills_commit, 'abc1234');
});

test('run-end persists active-ms, agent-count, and skill-metrics', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-cliv2-'));
  const offlineEnv = { ...process.env, HARNESS_TELEMETRY_REMOTE: join(targetDir, 'no.git'), HARNESS_TELEMETRY_DIR: join(targetDir, 'clone') };
  const init = run(['init-run', '--target', targetDir, '--repo', 'myapp', '--kind', 'intake', '--source', 'adhoc']);
  const end = run(['run-end', '--target', targetDir, '--run-dir', init.out.run_dir, '--status', 'succeeded',
    '--active-ms', '41000',
    '--agent-count', JSON.stringify({ by_model: { 'claude-haiku-4-5-20251001': 20 }, by_phase: { Intake: 3 } }),
    '--skill-metrics', JSON.stringify({ intakeManifestPath: 'docs/x.json', size_from_intake: 'S', splitRequired: false })],
    { env: offlineEnv });
  assert.equal(end.code, 0);
  const r = readRecord(init.out.run_dir);
  assert.equal(r.active_ms, 41000);
  assert.deepEqual(r.agent_count.by_model, { 'claude-haiku-4-5-20251001': 20 });
  assert.equal(r.skill_metrics.size_from_intake, 'S');
});
