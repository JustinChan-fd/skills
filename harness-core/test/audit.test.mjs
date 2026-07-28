import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendAudit, HarnessError } from '../tools/lib/audit.mjs';

const entry = (over = {}) => ({
  ts: '2026-07-24T18:30:12Z', run_id: 'r1', phase: null, agent_id: null, event: 'note', data: {}, ...over,
});

test('appends schema-valid entries as JSONL', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'harness-audit-')), '.harness');
  appendAudit(dir, entry());
  appendAudit(dir, entry({ event: 'run_start' }));
  const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).event, 'run_start');
});

test('auto-stamps ts when the caller omits it', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'harness-audit-')), '.harness');
  const noTs = entry();
  delete noTs.ts;
  appendAudit(dir, noTs);
  const written = JSON.parse(readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim());
  assert.match(written.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('rejects invalid entries without writing', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'harness-audit-')), '.harness');
  assert.throws(() => appendAudit(dir, entry({ event: 'vibes' })), (e) => e instanceof HarnessError && e.code === 'invalid_audit_entry');
});

test('FORCED FAILURE: unwritable path → logging_unavailable', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-audit-'));
  const fileNotDir = join(base, 'blocked');
  writeFileSync(fileNotDir, 'i am a file, not a directory');
  assert.throws(() => appendAudit(fileNotDir, entry()), (e) => e instanceof HarnessError && e.code === 'logging_unavailable');
});

test('spawn event with missing data.task_type → invalid_audit_entry (nothing written)', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'harness-audit-')), '.harness');
  assert.throws(
    () => appendAudit(dir, entry({ event: 'spawn', data: { tier: 'LOW' } })),
    (e) => e instanceof HarnessError && e.code === 'invalid_audit_entry',
  );
  assert.throws(() => readFileSync(join(dir, 'audit.jsonl'), 'utf8'));
});

test('spawn event with empty-string data.task_type → invalid_audit_entry', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'harness-audit-')), '.harness');
  assert.throws(
    () => appendAudit(dir, entry({ event: 'spawn', data: { tier: 'LOW', task_type: '' } })),
    (e) => e instanceof HarnessError && e.code === 'invalid_audit_entry',
  );
});

test('spawn event with a non-empty data.task_type is accepted and written', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'harness-audit-')), '.harness');
  appendAudit(dir, entry({ event: 'spawn', data: { tier: 'HIGH', task_type: 'verifier_implement' } }));
  const written = JSON.parse(readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim());
  assert.equal(written.event, 'spawn');
  assert.equal(written.data.task_type, 'verifier_implement');
});

test('non-spawn event with no task_type is unaffected by the guard', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'harness-audit-')), '.harness');
  appendAudit(dir, entry({ event: 'note', data: {} }));
  const written = JSON.parse(readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim());
  assert.equal(written.event, 'note');
});
