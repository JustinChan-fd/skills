// The CLI surface for wall-clock accounting: spawn-end, pipeline-phase, the
// run-end PR flags, and the `timing` report. Skills only ever reach these
// through the CLI, so a lib that works and a subcommand that doesn't is the
// same as nothing working — these tests drive the real binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readRecord } from '../tools/lib/record.mjs';

const CLI = fileURLToPath(new URL('../tools/harness.mjs', import.meta.url));

function run(args) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [CLI, ...args], { encoding: 'utf8' })) };
  } catch (err) {
    return { code: err.status, out: err.stdout ? JSON.parse(err.stdout) : null, stderr: String(err.stderr ?? '') };
  }
}

function openRun(kind = 'implement') {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-timing-cli-'));
  const init = run(['init-run', '--target', targetDir, '--repo', 'myapp', '--kind', kind, '--source', 'adhoc']);
  assert.equal(init.code, 0);
  return { targetDir, runDir: init.out.run_dir, runId: init.out.run_id };
}

test('spawn-end closes a spawn and reports the computed wall_ms', () => {
  const { targetDir, runDir, runId } = openRun();
  const spawn = run(['audit', '--target', targetDir, '--event', JSON.stringify({
    ts: '2026-07-29T18:13:59.710Z', run_id: runId, phase: 'implement', agent_id: 'a1',
    event: 'spawn', data: { task_type: 'verifier_implement', tier: 'HIGH', round: 1 },
  })]);
  assert.equal(spawn.code, 0);
  const end = run(['spawn-end', '--run-dir', runDir, '--agent-id', 'a1', '--task-type', 'verifier_implement']);
  assert.equal(end.code, 0);
  assert.equal(end.out.matched, true);
  assert.ok(end.out.wall_ms > 0, 'a closed span has a positive duration');
  const events = readFileSync(join(targetDir, '.harness', 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const written = events.find((e) => e.event === 'spawn_end');
  assert.equal(written.data.tier, 'HIGH', 'tier carries over from the spawn');
  assert.equal(written.data.round, 1);
});

test('spawn-end on an unmatched agent id exits 1 with matched:false', () => {
  const { runDir } = openRun();
  const end = run(['spawn-end', '--run-dir', runDir, '--agent-id', 'ghost', '--task-type', 'discovery']);
  assert.equal(end.code, 1, 'a bookkeeping bug must be visible to the driver, not silent');
  assert.equal(end.out.matched, false);
});

test('pipeline-phase closes a span on the pipeline record with the child run id', () => {
  const { runDir } = openRun('pipeline');
  const r = run(['pipeline-phase', '--run-dir', runDir, '--phase', 'intake', '--status', 'succeeded', '--child-run-id', 'child-1']);
  assert.equal(r.code, 0);
  const record = readRecord(runDir);
  assert.equal(record.phases.length, 1);
  assert.equal(record.phases[0].child_run_id, 'child-1');
  assert.ok(record.phases[0].started_at, 'span carries its own start');
  assert.ok(typeof record.phases[0].wall_ms === 'number');
});

test('run-end accepts --pr-url and --pr-created-at and stamps both', () => {
  const { targetDir, runDir } = openRun();
  const r = run([
    'run-end', '--target', targetDir, '--run-dir', runDir, '--status', 'succeeded',
    '--pr-url', 'https://github.com/o/r/pull/349', '--pr-created-at', '2026-07-29T18:44:24Z',
  ]);
  assert.equal(r.code, 0);
  const record = readRecord(runDir);
  assert.equal(record.pr_url, 'https://github.com/o/r/pull/349');
  assert.equal(record.pr_created_at, '2026-07-29T18:44:24Z');
});

test('timing reports phase spans, the sum, the tolerance and a verdict', () => {
  const { targetDir, runDir } = openRun('pipeline');
  run(['pipeline-phase', '--run-dir', runDir, '--phase', 'intake', '--status', 'succeeded', '--child-run-id', 'c1']);
  run(['pipeline-phase', '--run-dir', runDir, '--phase', 'plan', '--status', 'succeeded', '--child-run-id', 'c2']);
  run(['run-end', '--target', targetDir, '--run-dir', runDir, '--status', 'succeeded']);
  const r = run(['timing', '--run-dir', runDir]);
  assert.equal(r.code, 0);
  assert.equal(r.out.phases.length, 2);
  assert.ok(typeof r.out.phase_sum_ms === 'number');
  assert.ok(typeof r.out.tolerance_ms === 'number');
  assert.equal(typeof r.out.reconciled, 'boolean');
});

test('timing exits 1 when spans do not account for wall clock', () => {
  // A pipeline that finalizes with NO phase spans is exactly the TARS-1272
  // shape: a full hour of wall clock with no internal structure.
  const { targetDir, runDir } = openRun('pipeline');
  run(['run-end', '--target', targetDir, '--run-dir', runDir, '--status', 'succeeded']);
  const r = run(['timing', '--run-dir', runDir]);
  assert.equal(r.code, 1, 'an unreconciled timeline is a finding, and the exit code says so');
  assert.equal(r.out.reconciled, false);
});

test('timing folds in subagent spans from the audit log', () => {
  const { targetDir, runDir, runId } = openRun();
  run(['audit', '--target', targetDir, '--event', JSON.stringify({
    run_id: runId, phase: 'implement', agent_id: 'a1', event: 'spawn',
    data: { task_type: 'read_only_discovery', tier: 'LOW' },
  })]);
  run(['spawn-end', '--run-dir', runDir, '--agent-id', 'a1', '--task-type', 'read_only_discovery']);
  run(['phase-end', '--run-dir', runDir, '--phase', 'implement', '--status', 'succeeded']);
  run(['run-end', '--target', targetDir, '--run-dir', runDir, '--status', 'succeeded']);
  const r = run(['timing', '--run-dir', runDir]);
  assert.equal(r.out.subagents.length, 1);
  assert.equal(r.out.subagents[0].task_type, 'read_only_discovery');
  assert.equal(r.out.spawns_unclosed, 0);
});

test('timing does not double-count when --events-from names the log it already reads', () => {
  // Found end-to-end: `timing --run-dir <rd>` already reads <target>/.harness/
  // audit.jsonl, and a driver passing that same path via --events-from counted
  // every span twice — the pipeline reported subagent_sum_ms at 2x. The default
  // path is built with '..' segments so it is not string-equal to the path a
  // caller types; dedupe has to be on the RESOLVED path.
  const { targetDir, runDir, runId } = openRun();
  run(['audit', '--target', targetDir, '--event', JSON.stringify({
    run_id: runId, phase: 'implement', agent_id: 'a1', event: 'spawn',
    data: { task_type: 'verifier_implement', tier: 'HIGH' },
  })]);
  run(['spawn-end', '--run-dir', runDir, '--agent-id', 'a1', '--task-type', 'verifier_implement']);
  run(['phase-end', '--run-dir', runDir, '--phase', 'implement', '--status', 'succeeded']);
  run(['run-end', '--target', targetDir, '--run-dir', runDir, '--status', 'succeeded']);
  const r = run(['timing', '--run-dir', runDir, '--events-from', join(targetDir, '.harness', 'audit.jsonl')]);
  assert.equal(r.out.subagents.length, 1, 'one spawn/spawn_end pair is one span, however many times its log is named');
  assert.equal(r.out.subagent_sum_ms, r.out.subagents[0].wall_ms);
});

test('timing reports an unclosed spawn so a missing spawn-end is visible', () => {
  const { targetDir, runDir, runId } = openRun();
  run(['audit', '--target', targetDir, '--event', JSON.stringify({
    run_id: runId, agent_id: 'a1', event: 'spawn', data: { task_type: 'discovery' },
  })]);
  run(['phase-end', '--run-dir', runDir, '--phase', 'implement', '--status', 'succeeded']);
  run(['run-end', '--target', targetDir, '--run-dir', runDir, '--status', 'succeeded']);
  const r = run(['timing', '--run-dir', runDir]);
  assert.equal(r.out.spawns_unclosed, 1);
});
