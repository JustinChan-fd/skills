import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

test('init-run → validate → phase-end → run-end round trip (telemetry unconfigured)', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  const init = run(['init-run', '--target', targetDir, '--repo', 'myapp', '--kind', 'intake', '--source', 'adhoc']);
  assert.equal(init.code, 0);
  const { run_id, run_dir } = init.out;
  assert.ok(run_id.includes('__myapp__intake__adhoc__'));

  const manifest = {
    run_id,
    source: { type: 'adhoc', ref: 'inline', excerpt: null },
    requirement: { summary: 'x', details: null, acceptance_criteria: ['y'] },
    size: { value: 'S', rationale: 'tiny' },
    repo_scan: { stack: null, key_paths: [], notes: null },
    constraints: [],
    schema_version: '1.0.0',
  };
  const manifestPath = join(run_dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(run(['validate', '--schema', 'manifest', '--file', manifestPath]).code, 0);

  const bad = run(['validate', '--schema', 'manifest', '--file', join(run_dir, 'record.json')]);
  assert.equal(bad.code, 1);
  assert.ok(bad.out.errors.length > 0);

  assert.equal(run(['phase-end', '--run-dir', run_dir, '--phase', 'intake', '--status', 'succeeded', '--rounds', '1', '--score', '0.9', '--size', 'S']).code, 0);
  // Point telemetry at a nonexistent local path so the test never touches the
  // developer's real user.json remote (offline + deterministic: sync fails soft).
  const offlineEnv = {
    ...process.env,
    HARNESS_TELEMETRY_REMOTE: join(targetDir, 'no-such-remote.git'),
    HARNESS_TELEMETRY_DIR: join(targetDir, 'tel-clone'),
  };
  const end = run(['run-end', '--target', targetDir, '--run-dir', run_dir, '--status', 'succeeded'], { env: offlineEnv });
  assert.equal(end.code, 0);
  assert.equal(end.out.synced, false);

  const q = run(['quality', '--run-dir', run_dir]);
  assert.equal(q.code, 0);
  assert.equal(q.out.score, 0.9);

  // record-observed-tokens adds the orchestrator-observed total ALONGSIDE
  // run-end's own tokens_by_tier (offline env: sync fails soft, same as above).
  const before = readRecord(run_dir).tokens_by_tier;
  const observe = run(['record-observed-tokens', '--run-dir', run_dir, '--total', '42000', '--tier', 'MID'], { env: offlineEnv });
  assert.equal(observe.code, 0);
  assert.deepEqual(observe.out.tokens_observed, {
    total: 42000, tier: 'MID', source: 'agent_tool_usage_tag',
    observed_at: observe.out.tokens_observed.observed_at,
  });
  assert.equal(observe.out.synced, false);
  const after = readRecord(run_dir);
  assert.deepEqual(after.tokens_by_tier, before); // untouched, additive only
  assert.equal(after.tokens_observed.total, 42000);
});

test('init-run --routing-policy stamps routing_policy onto the run record', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  const init = run(['init-run', '--target', targetDir, '--repo', 'myapp', '--kind', 'implement', '--source', 'adhoc', '--routing-policy', 'arm-b']);
  assert.equal(init.code, 0);
  assert.equal(readRecord(init.out.run_dir).routing_policy, 'arm-b');
});

test('init-run without --routing-policy leaves routing_policy null (every existing caller unaffected)', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  const init = run(['init-run', '--target', targetDir, '--repo', 'myapp', '--kind', 'intake', '--source', 'adhoc']);
  assert.equal(init.code, 0);
  assert.equal(readRecord(init.out.run_dir).routing_policy, null);
});

test('record-observed-tokens exits 1 against a run that never finalized (still attempted)', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  const init = run(['init-run', '--target', targetDir, '--repo', 'myapp', '--kind', 'intake', '--source', 'adhoc']);
  const observe = run(['record-observed-tokens', '--run-dir', init.out.run_dir, '--total', '1000', '--tier', 'MID']);
  assert.equal(observe.code, 1);
});

test('gate reads caps from routing config; shut exits 1', () => {
  const open = run(['gate', '--size', 'S', '--rounds', '1', '--result', 'pass']);
  assert.deepEqual(open.out, { decision: 'open', record: null });
  const shut = run(['gate', '--size', 'S', '--rounds', '3', '--result', 'blocking-fail']);
  assert.equal(shut.code, 1);
  assert.deepEqual(shut.out, { decision: 'shut', record: 'escalation' });
});

test('audit exits 2 on unwritable path (fatal logging guard)', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  const blocked = join(base, 'target');
  writeFileSync(blocked, 'file, not dir'); // .harness cannot be created under a file
  const entry = JSON.stringify({ ts: '2026-07-24T18:30:12Z', run_id: 'r', event: 'note', data: {} });
  const result = run(['audit', '--target', blocked, '--event', entry]);
  assert.equal(result.code, 2);
});

test('config prints resolved routing', () => {
  const cfg = run(['config']);
  assert.equal(cfg.code, 0);
  assert.equal(cfg.out.routing.tier_models.HIGH, 'opus');
});
