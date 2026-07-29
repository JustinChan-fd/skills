// record.mjs v2 lifecycle graft: initRun stamps parent-loop association +
// correlation + repo_path + skills_commit; finalizeRun persists active_ms,
// agent_count, and skill_metrics. Every written record must stay schema-valid.
// SOURCE: telemetry-v2.jsonc field set grafted onto the POC write-first lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initRun, readRecord, finalizeRun, SCHEMA_VERSION } from '../tools/lib/record.mjs';

const NOW = new Date('2026-07-24T18:30:12Z');

function freshRun(extra = {}) {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-v2-'));
  return { targetDir, ...initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'issue-123', now: NOW, ...extra }) };
}

test('SCHEMA_VERSION is 2.0.0 and initRun stamps it', () => {
  assert.equal(SCHEMA_VERSION, '2.0.0');
  const { runDir } = freshRun();
  assert.equal(readRecord(runDir).schema_version, '2.0.0');
});

test('initRun defaults the v2 association fields to null', () => {
  const { runDir } = freshRun();
  const r = readRecord(runDir);
  assert.equal(r.correlation_id, null);
  assert.equal(r.active_ms, null);
  assert.equal(r.agent_count, null);
  assert.equal(r.skill_metrics, null);
});

test('initRun stamps parent_run_id, correlation_id, repo_path, skills_commit when supplied', () => {
  const { runDir } = freshRun({
    parentRunId: 'LOOP_RUN_ID',
    correlationId: 'TARS-1271-20260724T183012Z',
    repoPath: '/Users/x/Desktop/Repos/myapp',
    skillsCommit: 'deadbee',
  });
  const r = readRecord(runDir);
  assert.equal(r.parent_run_id, 'LOOP_RUN_ID');
  assert.equal(r.correlation_id, 'TARS-1271-20260724T183012Z');
  assert.equal(r.repo_path, '/Users/x/Desktop/Repos/myapp');
  assert.equal(r.skills_commit, 'deadbee');
});

test('finalizeRun persists active_ms, agent_count, and skill_metrics', () => {
  const { runDir } = freshRun();
  const r = finalizeRun({
    runDir, status: 'succeeded', now: NOW,
    activeMs: 41000,
    agentCount: { by_model: { 'claude-haiku-4-5-20251001': 20 }, by_phase: { Intake: 3 } },
    skillMetrics: { intakeManifestPath: 'docs/x.json', size_from_intake: 'XS', splitRequired: false },
  });
  assert.equal(r.active_ms, 41000);
  assert.deepEqual(r.agent_count.by_model, { 'claude-haiku-4-5-20251001': 20 });
  assert.deepEqual(r.skill_metrics, { intakeManifestPath: 'docs/x.json', size_from_intake: 'XS', splitRequired: false });
});

test('a v2-stamped record written by the full lifecycle is schema-valid', async () => {
  const { loadSchema, validate } = await import('../tools/lib/validate.mjs');
  const { runDir } = freshRun({ parentRunId: 'L', correlationId: 'TARS-1-x', repoPath: '/p', skillsCommit: 'c' });
  finalizeRun({ runDir, status: 'succeeded', now: NOW, activeMs: 100, agentCount: { by_model: {}, by_phase: {} }, skillMetrics: { a: 1 } });
  assert.deepEqual(validate(loadSchema('run-record'), readRecord(runDir)), []);
});
