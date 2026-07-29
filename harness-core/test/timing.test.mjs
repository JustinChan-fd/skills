// Wall-clock accounting: the fields and events that make "how long did this
// take, and where did the time go" answerable from the telemetry sink ALONE,
// with no `gh` join and no inference.
//
// Three gaps this closes, all found on the live TARS-1272 run:
//   1. A subagent's duration was only measurable when its return happened to
//      coincide with a `verifier_round` event. Discovery agents emitted a
//      `spawn` and nothing else, so their wall time was indistinguishable from
//      the driver's own work in the same window. `spawn_end` closes the span.
//   2. "Pipeline start → PR submitted" required `gh pr view` because the record
//      carried the branch but never the PR. `pr_url`/`pr_created_at` fix that.
//   3. The pipeline record's `phases` array was EMPTY, so its 59m59s wall clock
//      had no internal structure at all: the three phase runs summed to 54m23s
//      and the missing 5m36s of dispatcher overhead was invisible. Pipeline
//      phase spans make the parts sum to the whole, within a stated tolerance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendAudit, HarnessError } from '../tools/lib/audit.mjs';
import { loadSchema, validate } from '../tools/lib/validate.mjs';
import { initRun, phaseEnd, finalizeRun, readRecord, spawnEnd, pipelinePhase } from '../tools/lib/record.mjs';
import { reconcileTiming } from '../tools/lib/timing.mjs';

const auditDir = () => join(mkdtempSync(join(tmpdir(), 'harness-timing-')), '.harness');
const entry = (over = {}) => ({ ts: '2026-07-29T18:13:59.710Z', run_id: 'r1', event: 'note', data: {}, ...over });
const target = () => mkdtempSync(join(tmpdir(), 'harness-timing-t-'));

// ---- schema: the audit event ----

test('audit-entry: spawn_end is an accepted event value', () => {
  const errors = validate(loadSchema('audit-entry'), entry({
    event: 'spawn_end', data: { task_type: 'verifier_implement', wall_ms: 611192 },
  }));
  assert.deepEqual(errors, []);
});

test('audit-entry: spawn_end without data.task_type → invalid_audit_entry, nothing written', () => {
  const dir = auditDir();
  assert.throws(
    () => appendAudit(dir, entry({ event: 'spawn_end', data: { wall_ms: 500 } })),
    (e) => e instanceof HarnessError && e.code === 'invalid_audit_entry',
  );
  assert.throws(() => readFileSync(join(dir, 'audit.jsonl'), 'utf8'));
});

test('audit-entry: spawn_end without a numeric data.wall_ms → invalid_audit_entry', () => {
  const dir = auditDir();
  assert.throws(
    () => appendAudit(dir, entry({ event: 'spawn_end', data: { task_type: 'verifier_plan' } })),
    (e) => e instanceof HarnessError && e.code === 'invalid_audit_entry',
  );
  // A string that looks like a number is still not a number — the whole point
  // is that the duration arrives machine-readable.
  assert.throws(
    () => appendAudit(dir, entry({ event: 'spawn_end', data: { task_type: 'verifier_plan', wall_ms: '500' } })),
    (e) => e instanceof HarnessError && e.code === 'invalid_audit_entry',
  );
});

// ---- schema: the record fields ----

test('run-record: pr_url and pr_created_at validate as string-or-null', () => {
  const dir = target();
  const { runDir } = initRun({ targetDir: dir, repo: 'myapp', kind: 'implement', source: 'issue-1' });
  const record = readRecord(runDir);
  record.pr_url = 'https://github.com/o/r/pull/349';
  record.pr_created_at = '2026-07-29T18:44:24Z';
  assert.deepEqual(validate(loadSchema('run-record'), record), []);
  record.pr_url = null;
  record.pr_created_at = null;
  assert.deepEqual(validate(loadSchema('run-record'), record), []);
});

test('run-record: a phase span may carry started_at and child_run_id', () => {
  const dir = target();
  const { runDir } = initRun({ targetDir: dir, repo: 'myapp', kind: 'pipeline', source: 'issue-1' });
  const record = readRecord(runDir);
  record.phases = [{
    phase: 'intake', status: 'succeeded',
    started_at: '2026-07-29T17:46:24.962Z', ended_at: '2026-07-29T18:00:11.989Z',
    wall_ms: 827027, child_run_id: '2026-07-29T174810Z__webtarsthree__intake__issue-tars-1272__7bb85e',
  }];
  assert.deepEqual(validate(loadSchema('run-record'), record), []);
});

test('run-record: pipeline is an accepted phase name (the pipeline record has phases too)', () => {
  const schema = loadSchema('run-record');
  assert.ok(schema.properties.phases.items.properties.phase.enum.includes('intake'));
});

// ---- spawnEnd: the harness does the arithmetic, not the driver ----

test('spawnEnd computes wall_ms from the matching spawn, so the driver never subtracts timestamps', () => {
  const dir = target();
  const { runDir, harnessDir } = initRun({ targetDir: dir, repo: 'myapp', kind: 'implement', source: 'issue-1' });
  const runId = readRecord(runDir).run_id;
  appendAudit(harnessDir, {
    ts: '2026-07-29T18:13:59.710Z', run_id: runId, phase: 'implement', agent_id: 'a1',
    event: 'spawn', data: { task_type: 'verifier_implement', tier: 'HIGH', round: 1 },
  });
  const result = spawnEnd({
    runDir, agentId: 'a1', taskType: 'verifier_implement',
    now: new Date('2026-07-29T18:24:10.902Z'),
  });
  assert.equal(result.wall_ms, 611192);
  const written = readFileSync(join(harnessDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const end = written.find((e) => e.event === 'spawn_end');
  assert.equal(end.data.wall_ms, 611192);
  assert.equal(end.data.task_type, 'verifier_implement');
  assert.equal(end.agent_id, 'a1');
});

test('spawnEnd matches the LATEST open spawn for an agent id, not the first', () => {
  const dir = target();
  const { runDir, harnessDir } = initRun({ targetDir: dir, repo: 'myapp', kind: 'implement', source: 'issue-1' });
  const runId = readRecord(runDir).run_id;
  for (const [ts, round] of [['2026-07-29T18:13:59.000Z', 1], ['2026-07-29T18:27:28.000Z', 2]]) {
    appendAudit(harnessDir, {
      ts, run_id: runId, phase: 'implement', agent_id: 'a1',
      event: 'spawn', data: { task_type: 'verifier_implement', round },
    });
  }
  const result = spawnEnd({ runDir, agentId: 'a1', taskType: 'verifier_implement', now: new Date('2026-07-29T18:39:25.000Z') });
  assert.equal(result.wall_ms, 717000); // from 18:27:28, the second spawn
});

test('spawnEnd with no matching spawn returns matched:false and writes nothing', () => {
  const dir = target();
  const { runDir, harnessDir } = initRun({ targetDir: dir, repo: 'myapp', kind: 'implement', source: 'issue-1' });
  const before = readFileSync(join(harnessDir, 'audit.jsonl'), 'utf8');
  const result = spawnEnd({ runDir, agentId: 'ghost', taskType: 'verifier_implement', now: new Date() });
  assert.equal(result.matched, false);
  assert.equal(result.wall_ms, null);
  assert.equal(readFileSync(join(harnessDir, 'audit.jsonl'), 'utf8'), before);
});

test('spawnEnd ignores a spawn already closed by an earlier spawn_end', () => {
  const dir = target();
  const { runDir, harnessDir } = initRun({ targetDir: dir, repo: 'myapp', kind: 'implement', source: 'issue-1' });
  const runId = readRecord(runDir).run_id;
  appendAudit(harnessDir, {
    ts: '2026-07-29T18:00:00.000Z', run_id: runId, agent_id: 'a1',
    event: 'spawn', data: { task_type: 'discovery' },
  });
  const first = spawnEnd({ runDir, agentId: 'a1', taskType: 'discovery', now: new Date('2026-07-29T18:05:00.000Z') });
  assert.equal(first.wall_ms, 300000);
  const second = spawnEnd({ runDir, agentId: 'a1', taskType: 'discovery', now: new Date('2026-07-29T18:09:00.000Z') });
  assert.equal(second.matched, false);
});

test('spawnEnd scopes matching to this run, not another run in the same audit log', () => {
  const dir = target();
  const a = initRun({ targetDir: dir, repo: 'myapp', kind: 'intake', source: 'issue-1' });
  const b = initRun({ targetDir: dir, repo: 'myapp', kind: 'plan', source: 'issue-1' });
  appendAudit(a.harnessDir, {
    ts: '2026-07-29T18:00:00.000Z', run_id: readRecord(a.runDir).run_id, agent_id: 'a1',
    event: 'spawn', data: { task_type: 'discovery' },
  });
  const result = spawnEnd({ runDir: b.runDir, agentId: 'a1', taskType: 'discovery', now: new Date('2026-07-29T18:05:00.000Z') });
  assert.equal(result.matched, false);
});

// ---- pr_url / pr_created_at through finalizeRun ----

test('finalizeRun stamps pr_url and pr_created_at so start-to-PR needs no gh join', () => {
  const dir = target();
  const { runDir } = initRun({ targetDir: dir, repo: 'myapp', kind: 'implement', source: 'issue-1' });
  finalizeRun({
    runDir, status: 'succeeded',
    prUrl: 'https://github.com/o/r/pull/349', prCreatedAt: '2026-07-29T18:44:24Z',
  });
  const record = readRecord(runDir);
  assert.equal(record.pr_url, 'https://github.com/o/r/pull/349');
  assert.equal(record.pr_created_at, '2026-07-29T18:44:24Z');
});

test('finalizeRun leaves pr_url null when no PR was opened (a failed run opens none)', () => {
  const dir = target();
  const { runDir } = initRun({ targetDir: dir, repo: 'myapp', kind: 'implement', source: 'issue-1' });
  finalizeRun({ runDir, status: 'failed' });
  const record = readRecord(runDir);
  assert.equal(record.pr_url, null);
  assert.equal(record.pr_created_at, null);
});

// ---- pipelinePhase: spans on the parent record ----

test('pipelinePhase closes a span on the pipeline record with started_at, ended_at and child_run_id', () => {
  const dir = target();
  const { runDir } = initRun({
    targetDir: dir, repo: 'myapp', kind: 'pipeline', source: 'issue-1',
    now: new Date('2026-07-29T17:46:24.962Z'),
  });
  pipelinePhase({
    runDir, phase: 'intake', status: 'succeeded',
    childRunId: 'child-intake', now: new Date('2026-07-29T18:00:11.989Z'),
  });
  const record = readRecord(runDir);
  assert.equal(record.phases.length, 1);
  assert.equal(record.phases[0].phase, 'intake');
  assert.equal(record.phases[0].child_run_id, 'child-intake');
  assert.equal(record.phases[0].started_at, '2026-07-29T17:46:24.962Z');
  assert.equal(record.phases[0].ended_at, '2026-07-29T18:00:11.989Z');
  assert.equal(record.phases[0].wall_ms, 827027);
});

test('pipelinePhase spans are contiguous: the next span starts where the previous ended', () => {
  const dir = target();
  const { runDir } = initRun({
    targetDir: dir, repo: 'myapp', kind: 'pipeline', source: 'issue-1',
    now: new Date('2026-07-29T17:46:24.962Z'),
  });
  pipelinePhase({ runDir, phase: 'intake', status: 'succeeded', childRunId: 'c1', now: new Date('2026-07-29T18:00:11.989Z') });
  pipelinePhase({ runDir, phase: 'plan', status: 'succeeded', childRunId: 'c2', now: new Date('2026-07-29T18:04:11.519Z') });
  const record = readRecord(runDir);
  assert.equal(record.phases[1].started_at, record.phases[0].ended_at);
  assert.equal(record.phases[1].wall_ms, 239530);
});

test('pipelinePhase does not touch token fields (spans are pure timing)', () => {
  const dir = target();
  const { runDir } = initRun({ targetDir: dir, repo: 'myapp', kind: 'pipeline', source: 'issue-1' });
  const before = readRecord(runDir);
  pipelinePhase({ runDir, phase: 'intake', status: 'succeeded', childRunId: 'c1' });
  const after = readRecord(runDir);
  assert.deepEqual(after.tokens_directional, before.tokens_directional);
  assert.deepEqual(after.tokens_by_tier, before.tokens_by_tier);
});

// ---- reconcileTiming: the instrument that proves the parts sum to the whole ----

const pipelineRecord = {
  run_id: 'pipe-1', kind: 'pipeline', repo: 'webtarsthree',
  started_at: '2026-07-29T17:46:24.962Z', ended_at: '2026-07-29T18:46:23.863Z', wall_ms: 3598901,
  pr_url: 'https://github.com/o/r/pull/349', pr_created_at: '2026-07-29T18:44:24Z',
  phases: [
    { phase: 'intake', status: 'succeeded', started_at: '2026-07-29T17:46:24.962Z', ended_at: '2026-07-29T18:00:11.989Z', wall_ms: 827027, child_run_id: 'c-intake' },
    { phase: 'plan', status: 'succeeded', started_at: '2026-07-29T18:00:11.989Z', ended_at: '2026-07-29T18:04:11.519Z', wall_ms: 239530, child_run_id: 'c-plan' },
    { phase: 'implement', status: 'succeeded', started_at: '2026-07-29T18:04:11.519Z', ended_at: '2026-07-29T18:45:06.013Z', wall_ms: 2454494, child_run_id: 'c-implement' },
  ],
};

test('reconcileTiming: contiguous spans covering the run reconcile', () => {
  const out = reconcileTiming({ record: pipelineRecord, events: [] });
  assert.equal(out.wall_ms, 3598901);
  assert.equal(out.phase_sum_ms, 827027 + 239530 + 2454494);
  assert.equal(out.reconciled, true);
  assert.ok(out.unaccounted_ms >= 0);
});

test('reconcileTiming: tolerance is 5% of wall with a 60s floor', () => {
  const out = reconcileTiming({ record: pipelineRecord, events: [] });
  assert.equal(out.tolerance_ms, Math.max(60000, Math.round(3598901 * 0.05)));
  const short = reconcileTiming({
    record: { ...pipelineRecord, wall_ms: 120000, phases: [] },
    events: [],
  });
  assert.equal(short.tolerance_ms, 60000); // 5% of 120s is 6s; the floor wins
});

test('reconcileTiming: the TARS-1272 shape (empty phases on the pipeline) does NOT reconcile', () => {
  const out = reconcileTiming({ record: { ...pipelineRecord, phases: [] }, events: [] });
  assert.equal(out.phase_sum_ms, 0);
  assert.equal(out.unaccounted_ms, 3598901);
  assert.equal(out.reconciled, false);
});

test('reconcileTiming: start-to-PR is derived from the record, no gh join', () => {
  const out = reconcileTiming({ record: pipelineRecord, events: [] });
  assert.equal(out.start_to_pr_ms, Date.parse('2026-07-29T18:44:24Z') - Date.parse('2026-07-29T17:46:24.962Z'));
});

test('reconcileTiming: start_to_pr_ms is null when the run opened no PR', () => {
  const out = reconcileTiming({ record: { ...pipelineRecord, pr_url: null, pr_created_at: null }, events: [] });
  assert.equal(out.start_to_pr_ms, null);
  assert.equal(out.pr_precedes_run, false, 'no PR is not a bad PR timestamp');
});

test('reconcileTiming: a pr_created_at before the run start is flagged, not returned as a negative duration', () => {
  // Surfaced by the end-to-end check, where a fixture's pr_created_at predated
  // the run and start_to_pr_ms came back -6525609 — a negative "duration" a
  // dashboard would happily plot. It cannot happen from GitHub (a PR is not
  // created before the run that opens it), so it always means a wrong value
  // reached run-end. Name the bad input rather than returning nonsense or
  // clamping to zero, which would hide it.
  const out = reconcileTiming({
    record: { ...pipelineRecord, pr_created_at: '2026-07-29T16:00:00.000Z' },
    events: [],
  });
  assert.equal(out.start_to_pr_ms, null);
  assert.equal(out.pr_precedes_run, true);
});

test('reconcileTiming: a normal PR timestamp leaves pr_precedes_run false', () => {
  const out = reconcileTiming({ record: pipelineRecord, events: [] });
  assert.ok(out.start_to_pr_ms > 0);
  assert.equal(out.pr_precedes_run, false);
});

test('reconcileTiming: subagent spans come from spawn_end, with tier and task_type', () => {
  const events = [
    { ts: '2026-07-29T18:13:59.710Z', run_id: 'c-implement', event: 'spawn', agent_id: 'a1', data: { task_type: 'verifier_implement', tier: 'HIGH', round: 1 } },
    { ts: '2026-07-29T18:24:10.902Z', run_id: 'c-implement', event: 'spawn_end', agent_id: 'a1', data: { task_type: 'verifier_implement', tier: 'HIGH', wall_ms: 611192 } },
  ];
  const out = reconcileTiming({ record: pipelineRecord, events });
  assert.equal(out.subagents.length, 1);
  assert.equal(out.subagents[0].task_type, 'verifier_implement');
  assert.equal(out.subagents[0].tier, 'HIGH');
  assert.equal(out.subagents[0].wall_ms, 611192);
  assert.equal(out.subagent_sum_ms, 611192);
});

test('reconcileTiming: an unclosed spawn is reported, not silently dropped', () => {
  const events = [
    { ts: '2026-07-29T18:06:32.000Z', run_id: 'c-implement', event: 'spawn', agent_id: 'a9', data: { task_type: 'read_only_discovery', tier: 'LOW' } },
  ];
  const out = reconcileTiming({ record: pipelineRecord, events });
  assert.equal(out.spawns_unclosed, 1);
  assert.equal(out.subagent_sum_ms, 0);
});

test('reconcileTiming: a run with no ended_at yet reports reconciled:false, never throws', () => {
  const out = reconcileTiming({ record: { ...pipelineRecord, ended_at: null, wall_ms: null }, events: [] });
  assert.equal(out.reconciled, false);
  assert.equal(out.wall_ms, null);
});
