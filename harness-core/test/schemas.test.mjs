import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema, validate } from '../tools/lib/validate.mjs';

const validRecord = {
  run_id: '2026-07-24T183012Z__myapp__intake__issue-123__a3f9c1',
  parent_run_id: null,
  repo: 'myapp',
  branch: 'main',
  issue: '123',
  machine: 'test-host',
  kind: 'intake',
  input_type: 'issue',
  size: 'M',
  status: 'succeeded',
  reason: null,
  phases: [{ phase: 'intake', status: 'succeeded', rounds_used: 2, verifier_score: 0.9, reason: null }],
  tokens_by_tier: { LOW: 1000, MID: 5000 },
  wall_ms: 60000,
  estimated_cost: 0.5,
  started_at: '2026-07-24T18:30:12Z',
  ended_at: '2026-07-24T18:31:12Z',
  synced_at: null,
  schema_version: '1.0.0',
};

test('run-record: valid record passes', () => {
  assert.deepEqual(validate(loadSchema('run-record'), validRecord), []);
});

test('run-record: unknown status fails validation', () => {
  const bad = { ...validRecord, status: 'exploded' };
  assert.ok(validate(loadSchema('run-record'), bad).length > 0);
});

test('run-record: reason requires a known code', () => {
  const withReason = {
    ...validRecord,
    status: 'failed',
    reason: { code: 'cost_ceiling', detail: 'ceiling 15 exceeded at 16.2', phase: 'implement', agent: null },
  };
  assert.deepEqual(validate(loadSchema('run-record'), withReason), []);
  const badCode = { ...withReason, reason: { code: 'gremlins', detail: 'x' } };
  assert.ok(validate(loadSchema('run-record'), badCode).length > 0);
});

test('audit-entry: valid entry passes, unknown event fails, extra keys fail', () => {
  const entry = { ts: '2026-07-24T18:30:12Z', run_id: 'r', phase: 'intake', agent_id: null, event: 'run_start', data: {} };
  assert.deepEqual(validate(loadSchema('audit-entry'), entry), []);
  assert.ok(validate(loadSchema('audit-entry'), { ...entry, event: 'vibes' }).length > 0);
  assert.ok(validate(loadSchema('audit-entry'), { ...entry, extra: 1 }).length > 0);
});

test('manifest: valid passes, missing size fails', () => {
  const manifest = {
    run_id: 'r',
    source: { type: 'issue', ref: '123', excerpt: null },
    requirement: { summary: 'Add login', details: null, acceptance_criteria: ['user can log in'] },
    size: { value: 'M', rationale: 'touches auth + UI' },
    repo_scan: { stack: 'node', key_paths: ['src/auth.mjs'], notes: null },
    constraints: [],
    schema_version: '1.0.0',
  };
  assert.deepEqual(validate(loadSchema('manifest'), manifest), []);
  const { size, ...noSize } = manifest;
  assert.ok(validate(loadSchema('manifest'), noSize).length > 0);
});

test('handoff: valid passes, bad tag fails', () => {
  const handoff = {
    run_id: 'r',
    from_phase: 'intake',
    to_phase: 'plan',
    entry_contract: [{ criterion: 'login works end-to-end', tag: 'blocking' }],
    artifacts: [{ path: '.harness/runs/r/manifest.json', description: 'the manifest' }],
    notes: null,
    schema_version: '1.0.0',
  };
  assert.deepEqual(validate(loadSchema('handoff'), handoff), []);
  const bad = { ...handoff, entry_contract: [{ criterion: 'x', tag: 'optional' }] };
  assert.ok(validate(loadSchema('handoff'), bad).length > 0);
});

test('brief: valid passes, self-selected tier model fails', () => {
  const brief = {
    objective: 'List files under src/ relevant to auth',
    output: { path: '.harness/runs/r/findings/auth-files.json', schema: null },
    tools: { allowed: ['Read', 'Glob', 'Grep'], forbidden: ['Write', 'Edit', 'Bash'] },
    boundaries: ['read-only', 'do not leave src/'],
    done_when: 'output file exists and lists paths with one-line relevance notes',
    tier: { level: 'LOW', model: 'haiku' },
    reasoning: { budget: 'MINIMAL', needs_decision_directive: 'On any uncovered decision, write a needs-decision file and stop.' },
  };
  assert.deepEqual(validate(loadSchema('brief'), brief), []);
  assert.ok(validate(loadSchema('brief'), { ...brief, tier: { level: 'LOW', model: 'gpt' } }).length > 0);
});

test('needs-decision: valid passes', () => {
  const nd = {
    run_id: 'r',
    agent_id: 'reader-1',
    decision_needed: 'Two auth modules exist; which is canonical?',
    options: ['src/auth.mjs', 'src/legacy/auth.mjs'],
    blocking: true,
    ts: '2026-07-24T18:30:12Z',
  };
  assert.deepEqual(validate(loadSchema('needs-decision'), nd), []);
});

test('run-record: schema_version 1.5.0 is accepted and 1.0.0..1.4.0 still validate', () => {
  const schema = loadSchema('run-record');
  for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0']) {
    assert.deepEqual(validate(schema, { ...validRecord, schema_version: v }), [], `version ${v} should validate`);
  }
});

test('run-record: optional routing_policy validates and does not change existing required fields', () => {
  const schema = loadSchema('run-record');
  // Absent routing_policy (all prior records) still validates.
  assert.deepEqual(validate(schema, { ...validRecord, schema_version: '1.5.0' }), []);
  // Present as a string (a stamped experiment arm) validates.
  assert.deepEqual(validate(schema, { ...validRecord, schema_version: '1.5.0', routing_policy: 'arm-b' }), []);
  // Present as explicit null (unstamped default) validates.
  assert.deepEqual(validate(schema, { ...validRecord, schema_version: '1.5.0', routing_policy: null }), []);
  // A non-string, non-null routing_policy fails.
  assert.ok(validate(schema, { ...validRecord, schema_version: '1.5.0', routing_policy: 42 }).length > 0);
});

test('run-record: optional tokens_directional validates and does not change existing required fields', () => {
  const schema = loadSchema('run-record');
  // Absent tokens_directional (all prior records) still validates.
  assert.deepEqual(validate(schema, { ...validRecord, schema_version: '1.4.0' }), []);
  // Present, well-formed tokens_directional validates.
  const withDirectional = {
    ...validRecord,
    schema_version: '1.4.0',
    tokens_directional: {
      by_model: { 'claude-opus-4-8': { input: 100, output: 50, cache_read: 20, cache_creation: 10 } },
      format_version: '1',
      collected_at: '2026-07-27T00:00:00.000Z',
      complete: true,
    },
  };
  assert.deepEqual(validate(schema, withDirectional), []);
  // A malformed tokens_directional (missing a required sub-field) fails.
  const bad = { ...withDirectional, tokens_directional: { by_model: {}, format_version: '1' } };
  assert.ok(validate(schema, bad).length > 0);
});

test('run-record rejects wrong schema_version', () => {
  const schema = loadSchema('run-record');
  const bad = structuredClone(validRecord);
  bad.schema_version = '9.9.9';
  const errors = validate(schema, bad);
  assert.ok(errors.length > 0);
});

test('brief accepts optional schema_version 1.0.0 and rejects other values', () => {
  const schema = loadSchema('brief');
  const brief = {
    objective: 'List files under src/ relevant to auth',
    output: { path: '.harness/runs/r/findings/auth-files.json', schema: null },
    tools: { allowed: ['Read', 'Glob', 'Grep'], forbidden: ['Write', 'Edit', 'Bash'] },
    boundaries: ['read-only', 'do not leave src/'],
    done_when: 'output file exists and lists paths with one-line relevance notes',
    tier: { level: 'LOW', model: 'haiku' },
    reasoning: { budget: 'MINIMAL', needs_decision_directive: 'On any uncovered decision, write a needs-decision file and stop.' },
  };
  const withVersion = { ...brief, schema_version: '1.0.0' };
  assert.deepEqual(validate(schema, withVersion), []);
  const wrongVersion = { ...brief, schema_version: '2.0.0' };
  assert.ok(validate(schema, wrongVersion).length > 0);
});
