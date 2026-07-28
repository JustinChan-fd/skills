import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeLoopLine } from '../tools/lib/looprecord.mjs';

// Build a throwaway run dir whose record.json carries (or omits) a
// tokens_observed snapshot, mirroring what record-observed-tokens persists.
function runDirWith(tokensObservedTotal) {
  const dir = mkdtempSync(join(tmpdir(), 'looprec-run-'));
  const record = { run_id: 'rid', tokens_observed: tokensObservedTotal === null ? null : { total: tokensObservedTotal, tier: 'MID', source: 'agent_tool_usage_tag' } };
  writeFileSync(join(dir, 'record.json'), JSON.stringify(record));
  return dir;
}

function anomaliesFixture(findingsCount) {
  const dir = mkdtempSync(join(tmpdir(), 'looprec-anom-'));
  const path = join(dir, 'anomalies-scan.json');
  writeFileSync(path, JSON.stringify({ ok: findingsCount === 0, findings: Array.from({ length: findingsCount }, (_, i) => ({ i })) }));
  return path;
}

test('composeLoopLine (a) extracts the anomalies findings count exactly like the node -e one-liner', () => {
  const line = composeLoopLine({
    issue: 8, actions: ['intake:succeeded'], outcome: 'advanced', prUrl: null,
    anomaliesScanPath: anomaliesFixture(3),
    phaseRuns: [{ phase: 'intake', runDir: runDirWith(61_269) }],
    ts: '2026-07-27T15:00:00Z',
  });
  assert.equal(line.anomalies, 3);
});

test('composeLoopLine (b) reads tokens_observed.total into tokens.total and tokens.by_phase', () => {
  const line = composeLoopLine({
    issue: 8, actions: ['intake:succeeded', 'plan:succeeded'], outcome: 'advanced', prUrl: null,
    anomaliesScanPath: anomaliesFixture(0),
    phaseRuns: [
      { phase: 'intake', runDir: runDirWith(61_269) },
      { phase: 'plan', runDir: runDirWith(233_116) },
    ],
    ts: '2026-07-27T15:00:00Z',
  });
  assert.deepEqual(line.tokens.by_phase, { intake: 61_269, plan: 233_116 });
  assert.equal(line.tokens.total, 294_385);
  assert.deepEqual(line.tokens.unknown_phases, []);
});

test('composeLoopLine (c) sets by_phase null + lists unknown_phases when a run has no tokens_observed (stranded)', () => {
  const line = composeLoopLine({
    issue: 8, actions: ['intake:succeeded', 'plan:succeeded'], outcome: 'advanced', prUrl: null,
    anomaliesScanPath: anomaliesFixture(0),
    phaseRuns: [
      { phase: 'intake', runDir: runDirWith(null) }, // stranded, recovered from a prior tick
      { phase: 'plan', runDir: runDirWith(100_000) },
    ],
    ts: '2026-07-27T15:00:00Z',
  });
  assert.equal(line.tokens.by_phase.intake, null);
  assert.equal(line.tokens.by_phase.plan, 100_000);
  assert.deepEqual(line.tokens.unknown_phases, ['intake']);
  assert.equal(line.tokens.total, 100_000); // only the known phase contributes
});

test('composeLoopLine (d) assembles the exact loop.jsonl line shape and key order', () => {
  const line = composeLoopLine({
    issue: 8, actions: ['intake:succeeded'], outcome: 'delivered', prUrl: 'https://github.com/o/r/pull/9',
    anomaliesScanPath: anomaliesFixture(1),
    phaseRuns: [{ phase: 'implement', runDir: runDirWith(300_000) }],
    ts: '2026-07-27T15:00:00Z',
  });
  assert.equal(JSON.stringify(line),
    '{"ts":"2026-07-27T15:00:00Z","issue":8,"actions":["intake:succeeded"],' +
    '"outcome":"delivered","pr_url":"https://github.com/o/r/pull/9","anomalies":1,' +
    '"tokens":{"total":300000,"by_phase":{"implement":300000},"unknown_phases":[],"source":"agent_tool_usage_tag"}}');
});

test('composeLoopLine: a noop tick (no phase runs) yields null total, empty by_phase, and null pr_url', () => {
  const line = composeLoopLine({
    issue: 8, actions: [], outcome: 'noop', prUrl: null,
    anomaliesScanPath: anomaliesFixture(0),
    phaseRuns: [],
    ts: '2026-07-27T15:00:00Z',
  });
  assert.equal(line.tokens.total, null);
  assert.deepEqual(line.tokens.by_phase, {});
  assert.deepEqual(line.tokens.unknown_phases, []);
  assert.equal(line.pr_url, null);
});
