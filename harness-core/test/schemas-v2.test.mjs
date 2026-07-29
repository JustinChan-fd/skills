// v2 graft (schema_version 2.0.0): the fields the workplace telemetry MUST track
// that the POC 1.5.0 record did not carry — parent-loop association, cross-phase
// correlation, active time, per-skill perf, and the XS size.
// SOURCE: the v2 field set originally annotated in the harness-telemetry-schema
// skill (now deleted — schemas/run-record.schema.json is the source of truth,
// and this test is what enforces it). Input/output tokens are
// intentionally NOT re-added here — tokens_directional.by_model already carries them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema, validate } from '../tools/lib/validate.mjs';

// A minimal 2.0.0 record carrying every grafted field.
const v2Record = {
  run_id: '2026-07-24T183012Z__myapp__intake__issue-123__a3f9c1',
  parent_run_id: '2026-07-24T183000Z__myapp__pipeline__issue-123__ff0011',
  correlation_id: 'TARS-1271-20260724T183012Z',
  repo: 'myapp',
  repo_path: '/Users/x/Desktop/Repos/myapp',
  branch: 'harness/TARS-1271-intake',
  issue: 'TARS-1271',
  machine: 'test-host',
  harness_sha: 'abc1234',
  skills_commit: 'def5678',
  kind: 'intake',
  input_type: 'issue',
  size: 'XS',
  status: 'succeeded',
  reason: null,
  phases: [{ phase: 'intake', status: 'succeeded', rounds_used: 2, verifier_score: 0.9, reason: null }],
  tokens_by_tier: { LOW: 1000, MID: 5000 },
  wall_ms: 60000,
  active_ms: 41000,
  agent_count: { by_model: { 'claude-haiku-4-5-20251001': 20 }, by_phase: { Intake: 3 } },
  skill_metrics: { intakeManifestPath: 'docs/x.json', size_from_intake: 'XS' },
  started_at: '2026-07-24T18:30:12Z',
  ended_at: '2026-07-24T18:31:12Z',
  synced_at: null,
  schema_version: '2.0.0',
};

test('run-record v2: a full 2.0.0 record with all grafted fields validates', () => {
  assert.deepEqual(validate(loadSchema('run-record'), v2Record), []);
});

test('run-record v2: size accepts XS', () => {
  assert.deepEqual(validate(loadSchema('run-record'), { ...v2Record, size: 'XS' }), []);
});

test('run-record v2: schema_version accepts 2.0.0', () => {
  assert.deepEqual(validate(loadSchema('run-record'), { ...v2Record, schema_version: '2.0.0' }), []);
});

test('run-record v2: correlation_id may be set on a standalone run with no parent', () => {
  const standalone = { ...v2Record, parent_run_id: null, correlation_id: 'TARS-1271-20260724T183012Z' };
  assert.deepEqual(validate(loadSchema('run-record'), standalone), []);
});

test('run-record v2: active_ms must be a number or null', () => {
  assert.ok(validate(loadSchema('run-record'), { ...v2Record, active_ms: 'soon' }).length > 0);
  assert.deepEqual(validate(loadSchema('run-record'), { ...v2Record, active_ms: null }), []);
});

test('run-record v2: a legacy 1.5.0 record (no v2 fields) still validates', () => {
  // Backward compatibility: the grafted fields are all optional, so records
  // written by the POC before the graft keep validating unchanged.
  const legacy = { ...v2Record, schema_version: '1.5.0' };
  delete legacy.correlation_id;
  delete legacy.repo_path;
  delete legacy.skills_commit;
  delete legacy.active_ms;
  delete legacy.agent_count;
  delete legacy.skill_metrics;
  assert.deepEqual(validate(loadSchema('run-record'), legacy), []);
});
