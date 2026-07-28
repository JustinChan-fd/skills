import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordResult, buildReport } from '../lib/report.mjs';

// Fixed fixture: 8 defects x 2 tiers = 16 entries.
// HIGH catches 6/8 (misses the 2 synthetic data-loss defects D5/D6).
// MID  catches 3/8 (D1, D2, D7).
const CLASS = {
  D1: 'broken-build',
  D2: 'broken-build',
  D3: 'failing-contract-criterion',
  D4: 'failing-contract-criterion',
  D5: 'data-loss-path',
  D6: 'data-loss-path',
  D7: 'silently-wrong-behavior',
  D8: 'silently-wrong-behavior',
};
const HIGH_CAUGHT = new Set(['D1', 'D2', 'D3', 'D4', 'D7', 'D8']);
const MID_CAUGHT = new Set(['D1', 'D2', 'D7']);

function fixtureResults() {
  const out = [];
  for (const id of Object.keys(CLASS)) {
    for (const tier of ['HIGH', 'MID']) {
      const caught = tier === 'HIGH' ? HIGH_CAUGHT.has(id) : MID_CAUGHT.has(id);
      out.push({
        defect_id: id,
        class: CLASS[id],
        tier,
        gate_result: caught ? 'blocking-fail' : 'pass',
        score: caught ? 0.6 : 0.95,
        caught,
        severity: caught ? 'full' : 'none',
        matched_term: caught ? 'someterm' : null,
      });
    }
  }
  return out;
}

test('buildReport renders a per-tier catch-rate table with correct counts', () => {
  const md = buildReport(fixtureResults());
  assert.match(md, /HIGH/);
  assert.match(md, /MID/);
  // HIGH caught 6/8, MID caught 3/8 somewhere in a tier table.
  assert.match(md, /6\/8/);
  assert.match(md, /3\/8/);
});

test('buildReport renders a per-class catch-rate table with all four classes', () => {
  const md = buildReport(fixtureResults());
  for (const cls of ['broken-build', 'failing-contract-criterion', 'data-loss-path', 'silently-wrong-behavior']) {
    assert.ok(md.includes(cls), `class ${cls} present`);
  }
  // data-loss-path: HIGH 0/2 and MID 0/2.
  const dataLossRow = md.split('\n').find((l) => l.includes('data-loss-path'));
  assert.ok(dataLossRow, 'data-loss-path row exists');
  assert.match(dataLossRow, /0\/2/);
});

test('buildReport contains the N=8 directional-signal disclosure verbatim', () => {
  const md = buildReport(fixtureResults());
  assert.ok(md.includes('At N=8, this is a directional signal, not statistics.'));
});

test('buildReport contains the isolation-context note verbatim', () => {
  const md = buildReport(fixtureResults());
  assert.ok(
    md.includes('This probe exercises the verifier in isolation and not its full post-driver live context.'),
  );
});

test('buildReport states the FLOOR observation in the exact MID/HIGH shape, framed for the operator to arbitrate', () => {
  const md = buildReport(fixtureResults());
  assert.ok(md.includes('MID catches 3/8 vs HIGH catches 6/8'), 'FLOOR shape verbatim');
  assert.ok(
    md.includes('reported observation for the operator to arbitrate, not an adjudicated conclusion'),
    'FLOOR framing present',
  );
});

test('recordResult appends and preserves prior entries across repeated calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-report-'));
  try {
    const file = join(dir, 'probe-report.json');
    assert.ok(!existsSync(file));
    recordResult({ defect_id: 'D1', tier: 'HIGH', caught: true }, file);
    recordResult({ defect_id: 'D1', tier: 'MID', caught: false }, file);
    recordResult({ defect_id: 'D2', tier: 'HIGH', caught: true }, file);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const arr = Array.isArray(data) ? data : data.results;
    assert.equal(arr.length, 3);
    assert.equal(arr[0].defect_id, 'D1');
    assert.equal(arr[0].tier, 'HIGH');
    assert.equal(arr[2].defect_id, 'D2');
    // prior entries preserved, not overwritten
    assert.equal(arr[1].caught, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordResult returns the full running results array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-report-'));
  try {
    const file = join(dir, 'probe-report.json');
    const a = recordResult({ defect_id: 'D1', tier: 'HIGH' }, file);
    assert.equal(a.length, 1);
    const b = recordResult({ defect_id: 'D1', tier: 'MID' }, file);
    assert.equal(b.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
