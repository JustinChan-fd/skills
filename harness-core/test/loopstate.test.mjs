import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loopState } from '../tools/lib/loopstate.mjs';

function scaffold() {
  const target = mkdtempSync(join(tmpdir(), 'harness-loop-'));
  mkdirSync(join(target, '.harness', 'runs'), { recursive: true });
  return target;
}

let seq = 0;
function addRun(target, { kind, issue, status, at = null, routingPolicy = null }) {
  seq += 1;
  const ts = at ?? `2026-07-26T0${String(seq).padStart(2, '0')}0000Z`;
  const runId = `${ts}__t__${kind}__issue-${issue}__x${String(seq).padStart(5, '0')}`;
  const runDir = join(target, '.harness', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'record.json'), JSON.stringify({
    run_id: runId, repo: 't', kind, issue: String(issue), status,
    phases: [], started_at: `2026-07-26T00:00:0${seq % 10}Z`,
    routing_policy: routingPolicy,
  }));
  return runId;
}

test('no runs for the issue: next is intake, nothing stranded', () => {
  const target = scaffold();
  addRun(target, { kind: 'intake', issue: 99, status: 'succeeded' }); // other issue
  const s = loopState({ targetDir: target, issue: 3 });
  assert.deepEqual(s, {
    issue: '3', next: 'intake', stranded: null,
    phases: { intake: null, plan: null, implement: null },
  });
});

test('phase ladder: intake succeeded -> plan; plan succeeded -> implement; all -> done', () => {
  const target = scaffold();
  addRun(target, { kind: 'intake', issue: 3, status: 'succeeded' });
  assert.equal(loopState({ targetDir: target, issue: 3 }).next, 'plan');
  addRun(target, { kind: 'plan', issue: 3, status: 'succeeded' });
  assert.equal(loopState({ targetDir: target, issue: 3 }).next, 'implement');
  addRun(target, { kind: 'implement', issue: 3, status: 'succeeded' });
  const s = loopState({ targetDir: target, issue: 3 });
  assert.equal(s.next, 'done');
  assert.equal(s.phases.implement, 'succeeded');
});

test('a failed phase is retried: newest plan failed -> next is plan again', () => {
  const target = scaffold();
  addRun(target, { kind: 'intake', issue: 3, status: 'succeeded' });
  addRun(target, { kind: 'plan', issue: 3, status: 'failed' });
  const s = loopState({ targetDir: target, issue: 3 });
  assert.equal(s.next, 'plan');
  assert.equal(s.phases.plan, 'failed');
});

test('newest record per kind wins: failed intake superseded by succeeded intake', () => {
  const target = scaffold();
  addRun(target, { kind: 'intake', issue: 3, status: 'failed', at: '2026-07-26T010000Z' });
  addRun(target, { kind: 'intake', issue: 3, status: 'succeeded', at: '2026-07-26T020000Z' });
  const s = loopState({ targetDir: target, issue: 3 });
  assert.equal(s.phases.intake, 'succeeded');
  assert.equal(s.next, 'plan');
});

test('an attempted record is reported as stranded and its phase is the next action', () => {
  const target = scaffold();
  addRun(target, { kind: 'intake', issue: 3, status: 'succeeded' });
  const strandedId = addRun(target, { kind: 'plan', issue: 3, status: 'attempted' });
  const s = loopState({ targetDir: target, issue: 3 });
  assert.equal(s.stranded, strandedId);
  assert.equal(s.next, 'plan');
});

test('stranded is scoped to the current ladder phase, not superseded or unrelated runs', () => {
  const target = scaffold();
  // Attempted intake later superseded by a succeeded intake: ladder points
  // at plan, and the stale intake must not be offered for recovery.
  addRun(target, { kind: 'intake', issue: 3, status: 'attempted', at: '2026-07-26T010000Z' });
  addRun(target, { kind: 'intake', issue: 3, status: 'succeeded', at: '2026-07-26T020000Z' });
  const s = loopState({ targetDir: target, issue: 3 });
  assert.equal(s.next, 'plan');
  assert.equal(s.stranded, null);
});

test('corrupt or recordless run dirs are skipped, not fatal', () => {
  const target = scaffold();
  mkdirSync(join(target, '.harness', 'runs', 'no-record-here'), { recursive: true });
  const corrupt = join(target, '.harness', 'runs', '2026-07-26T000001Z__t__intake__issue-3__zz');
  mkdirSync(corrupt, { recursive: true });
  writeFileSync(join(corrupt, 'record.json'), '{nope');
  addRun(target, { kind: 'intake', issue: 3, status: 'succeeded' });
  assert.equal(loopState({ targetDir: target, issue: 3 }).next, 'plan');
});

// Two fixture records for the same target differing ONLY in routing_policy
// (control vs arm-b) both flow through loopState() untouched: the stamped
// experiment-arm field rides through the existing loop-state consumer without
// changing its verdict. No real intake/plan/implement dispatch is run.
test('routing_policy rides through loopState without changing next/phases (control vs arm-b)', () => {
  const target = scaffold();
  function recordFor(runId) {
    const runDir = join(target, '.harness', 'runs', runId);
    return JSON.parse(readFileSync(join(runDir, 'record.json'), 'utf8'));
  }

  // Issue 3 under the default/control arm; issue 4 under experiment arm-b.
  const controlId = addRun(target, { kind: 'intake', issue: 3, status: 'succeeded', routingPolicy: 'control' });
  const armId = addRun(target, { kind: 'intake', issue: 4, status: 'succeeded', routingPolicy: 'arm-b' });

  // The two fixtures differ only in routing_policy...
  assert.equal(recordFor(controlId).routing_policy, 'control');
  assert.equal(recordFor(armId).routing_policy, 'arm-b');

  // ...and loopState resolves each identically to an unstamped record: an
  // intake success advances both to plan, with the field ignored by the ladder.
  const sControl = loopState({ targetDir: target, issue: 3 });
  assert.equal(sControl.next, 'plan');
  assert.equal(sControl.phases.intake, 'succeeded');
  const sArm = loopState({ targetDir: target, issue: 4 });
  assert.equal(sArm.next, 'plan');
  assert.equal(sArm.phases.intake, 'succeeded');
});
