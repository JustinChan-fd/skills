import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanAnomalies } from '../tools/lib/anomalies.mjs';

const ROUTING = {
  sizes: { S: { revision_cap: 3 }, M: { revision_cap: 5 }, L: { revision_cap: 5 } },
  advisory_open_score: 0.9,
  anomalies: { outlier_multiple: 3, min_samples: 3, recent_limit: 50 },
};

function scaffold() {
  return mkdtempSync(join(tmpdir(), 'harness-anomalies-'));
}

let seq = 0;
function makeRecord(over = {}) {
  seq += 1;
  const id = over.run_id ?? `2026-07-25T0000${String(seq).padStart(2, '0')}Z__t__intake__issue-1__a${String(seq).padStart(5, '0')}`;
  return {
    run_id: id,
    repo: 't',
    kind: 'intake',
    size: 'S',
    status: 'succeeded',
    reason: null,
    phases: [{ phase: 'intake', status: 'succeeded', rounds_used: 1, verifier_score: 1, ended_at: '2026-07-25T00:01:00Z', wall_ms: 60000 }],
    tokens_by_tier: { MID: 25000 },
    wall_ms: 60000,
    estimated_cost: null,
    started_at: '2026-07-25T00:00:00Z',
    ended_at: '2026-07-25T00:01:00Z',
    ...over,
  };
}

// The full event skeleton a succeeded single-round intake run should carry.
function skeletonEvents(record) {
  const id = record.run_id;
  return [
    { ts: '2026-07-25T00:00:00Z', run_id: id, event: 'run_start', data: {} },
    { ts: '2026-07-25T00:00:10Z', run_id: id, phase: 'intake', agent_id: 'verifier-intake-r1', event: 'spawn', data: { tier: 'MID', task_type: 'verifier_intake', round: 1 } },
    { ts: '2026-07-25T00:00:50Z', run_id: id, phase: 'intake', agent_id: 'verifier-intake-r1', event: 'verifier_round', data: { round: 1, score: 1, result: 'pass' } },
    { ts: '2026-07-25T00:01:00Z', run_id: id, phase: 'intake', event: 'phase_end', data: { status: 'succeeded', rounds: 1, score: 1 } },
    { ts: '2026-07-25T00:01:01Z', run_id: id, event: 'run_end', data: { status: 'succeeded' } },
  ];
}

function writeRun(dir, record, events = skeletonEvents(record)) {
  const destDir = join(dir, 'log', record.repo);
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, `${record.run_id}.json`), JSON.stringify(record, null, 2));
  if (events !== null) {
    writeFileSync(join(destDir, `${record.run_id}.events.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
}

function checksFor(r, runId) {
  return r.findings.filter((f) => f.run_id === runId).map((f) => f.check);
}

test('clean scan: succeeded run with full skeleton produces no findings', () => {
  const dir = scaffold();
  writeRun(dir, makeRecord());
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
  assert.equal(r.scanned, 1);
});

test('non-succeeded runs and verifier cap hits are flagged', () => {
  const dir = scaffold();
  const rec = makeRecord({
    status: 'failed',
    reason: { code: 'verifier_blocking_cap', detail: 'cap', phase: null, agent: null },
    phases: [{ phase: 'intake', status: 'failed', rounds_used: 3, verifier_score: 0.5, ended_at: '2026-07-25T00:01:00Z', wall_ms: 60000 }],
  });
  writeRun(dir, rec);
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.equal(r.ok, false);
  const checks = checksFor(r, rec.run_id);
  assert.ok(checks.includes('run_not_succeeded'));
  assert.ok(checks.includes('verifier_cap_hit'));
  assert.ok(checks.includes('rounds_at_cap')); // 3 rounds on size S (cap 3)
  assert.ok(checks.includes('low_verifier_score')); // 0.5 < 0.9
});

test('a succeeded run whose score sits below advisory_open_score is flagged', () => {
  const dir = scaffold();
  const rec = makeRecord({
    phases: [{ phase: 'intake', status: 'succeeded', rounds_used: 2, verifier_score: 0.85, ended_at: '2026-07-25T00:01:00Z', wall_ms: 60000 }],
  });
  const events = skeletonEvents(rec);
  events.splice(3, 0, { ts: '2026-07-25T00:00:55Z', run_id: rec.run_id, phase: 'intake', event: 'verifier_round', data: { round: 2, score: 0.85, result: 'pass' } });
  writeRun(dir, rec, events);
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.deepEqual(checksFor(r, rec.run_id), ['low_verifier_score']);
});

test('estimated-token notes are flagged; platform-reported notes are not', () => {
  const dir = scaffold();
  const estimated = makeRecord({});
  const estEvents = skeletonEvents(estimated);
  estEvents.push({ ts: '2026-07-25T00:01:02Z', run_id: estimated.run_id, event: 'note', data: { note: 'tokens_by_tier MID figure is estimated: subagent did not report usage' } });
  writeRun(dir, estimated, estEvents);

  const reported = makeRecord({});
  const repEvents = skeletonEvents(reported);
  repEvents.push({ ts: '2026-07-25T00:01:02Z', run_id: reported.run_id, event: 'note', data: { type: 'tokens', detail: 'HIGH tier figure is the sum of platform-reported subagent_tokens — reported, not estimated.' } });
  writeRun(dir, reported, repEvents);

  const structured = makeRecord({});
  const structEvents = skeletonEvents(structured);
  structEvents.push({ ts: '2026-07-25T00:01:02Z', run_id: structured.run_id, event: 'note', data: { type: 'tokens', estimated: true } });
  writeRun(dir, structured, structEvents);

  // Structured estimated:false wins even though the JSON text contains the
  // substring "estimated" — a real run tripped this as a false positive.
  const structuredFalse = makeRecord({});
  const sfEvents = skeletonEvents(structuredFalse);
  sfEvents.push({ ts: '2026-07-25T00:01:02Z', run_id: structuredFalse.run_id, event: 'note', data: { type: 'tokens', estimated: false, detail: 'verifier tokens platform-reported' } });
  writeRun(dir, structuredFalse, sfEvents);

  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.deepEqual(checksFor(r, estimated.run_id), ['tokens_estimated']);
  assert.deepEqual(checksFor(r, reported.run_id), []);
  assert.deepEqual(checksFor(r, structured.run_id), ['tokens_estimated']);
  assert.deepEqual(checksFor(r, structuredFalse.run_id), []);
});

test('wall and cost outliers vs the same repo+kind median are flagged', () => {
  const dir = scaffold();
  const a = makeRecord({ wall_ms: 100000, estimated_cost: { lo: 1, mid: 2, hi: 3 } });
  const b = makeRecord({ wall_ms: 110000, estimated_cost: { lo: 1, mid: 2.2, hi: 3 } });
  const c = makeRecord({ wall_ms: 900000, estimated_cost: { lo: 5, mid: 30, hi: 60 } });
  for (const rec of [a, b, c]) writeRun(dir, rec);
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.ok(checksFor(r, c.run_id).includes('wall_outlier'));
  assert.ok(checksFor(r, c.run_id).includes('cost_outlier'));
  assert.ok(!checksFor(r, a.run_id).includes('wall_outlier'));
  assert.ok(!checksFor(r, b.run_id).includes('cost_outlier'));
});

test('outliers are not judged below min_samples', () => {
  const dir = scaffold();
  const a = makeRecord({ wall_ms: 100000 });
  const b = makeRecord({ wall_ms: 900000 });
  for (const rec of [a, b]) writeRun(dir, rec);
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.ok(!r.findings.some((f) => f.check === 'wall_outlier'));
});

test('integrity: succeeded run with no events file is flagged', () => {
  const dir = scaffold();
  const rec = makeRecord({});
  writeRun(dir, rec, null);
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.deepEqual(checksFor(r, rec.run_id), ['events_missing']);
});

test('integrity: missing skeleton events are flagged individually', () => {
  const dir = scaffold();
  const rec = makeRecord({
    phases: [{ phase: 'intake', status: 'succeeded', rounds_used: 2, verifier_score: 0.95, ended_at: '2026-07-25T00:01:00Z', wall_ms: 60000 }],
  });
  // Events carry: run_start only — no spawn, one verifier_round for two rounds,
  // no phase_end, no run_end.
  writeRun(dir, rec, [
    { ts: '2026-07-25T00:00:00Z', run_id: rec.run_id, event: 'run_start', data: {} },
    { ts: '2026-07-25T00:00:50Z', run_id: rec.run_id, phase: 'intake', event: 'verifier_round', data: { round: 1, score: 0.7, result: 'advisory-fail' } },
  ]);
  const r = scanAnomalies({ dir, routing: ROUTING });
  const checks = checksFor(r, rec.run_id);
  assert.ok(checks.includes('missing_run_end_event'));
  assert.ok(checks.includes('missing_phase_end_event'));
  assert.ok(checks.includes('verifier_rounds_unaudited')); // 1 event < 2 rounds_used
  assert.ok(checks.includes('verifier_spawn_unaudited'));
});

test('integrity checks only apply to succeeded runs', () => {
  const dir = scaffold();
  const rec = makeRecord({ status: 'abandoned', reason: { code: 'crash', detail: 'x', phase: null, agent: null } });
  writeRun(dir, rec, null);
  const r = scanAnomalies({ dir, routing: ROUTING });
  const checks = checksFor(r, rec.run_id);
  assert.ok(checks.includes('run_not_succeeded'));
  assert.ok(!checks.includes('events_missing'));
});

test('unparseable records are flagged, not thrown', () => {
  const dir = scaffold();
  mkdirSync(join(dir, 'log', 't'), { recursive: true });
  writeFileSync(join(dir, 'log', 't', '2026-07-25T000099Z__t__intake__issue-1__zzz999.json'), '{nope');
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.check === 'record_unparseable'));
});

test('repo filter and limit restrict the scan to the newest matching records', () => {
  const dir = scaffold();
  const old = makeRecord({ run_id: '2026-07-20T000000Z__t__intake__issue-1__old001', status: 'failed', reason: { code: 'crash', detail: 'x', phase: null, agent: null } });
  const fresh = makeRecord({});
  const other = makeRecord({ run_id: '2026-07-25T000098Z__u__intake__issue-1__oth001', repo: 'u', status: 'failed', reason: { code: 'crash', detail: 'x', phase: null, agent: null } });
  writeRun(dir, old, null);
  writeRun(dir, fresh);
  writeRun(dir, other);
  // limit 1 → only the newest record for repo t (the clean one) is scanned
  const r = scanAnomalies({ dir, repo: 't', limit: 1, routing: ROUTING });
  assert.equal(r.scanned, 1);
  assert.deepEqual(r.findings, []);
});

function gitIn(dir, env, ...args) {
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

function commitAll(dir, message, isoDate) {
  const env = { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate };
  gitIn(dir, env, 'add', '-A');
  gitIn(dir, env, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', message);
}

test('dashboard_stale: docs last committed before the latest log commit is flagged', () => {
  const dir = scaffold();
  gitIn(dir, {}, 'init');
  writeRun(dir, makeRecord());
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'index.html'), '<p>dash</p>');
  commitAll(dir, 'run + dash', '2026-07-25T00:00:00Z');
  const r1 = scanAnomalies({ dir, routing: ROUTING });
  assert.ok(!r1.findings.some((f) => f.check === 'dashboard_stale')); // same commit → in step

  writeRun(dir, makeRecord()); // new data, no rebuild
  commitAll(dir, 'run only', '2026-07-25T01:00:00Z');
  const r2 = scanAnomalies({ dir, routing: ROUTING });
  assert.ok(r2.findings.some((f) => f.check === 'dashboard_stale' && f.run_id === null));
});

test('stray non-directory files in log/ (.DS_Store) are ignored', () => {
  const dir = scaffold();
  writeRun(dir, makeRecord());
  writeFileSync(join(dir, 'log', '.DS_Store'), 'junk');
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.equal(r.ok, true);
  assert.equal(r.scanned, 1);
});

test('dashboard_stale is skipped when docs/ does not exist or dir is not a git repo', () => {
  const dir = scaffold();
  writeRun(dir, makeRecord());
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.ok(!r.findings.some((f) => f.check === 'dashboard_stale'));
});

// harness-loop/SKILL.md step 7 documents a two-command sequence for turning a
// telemetry scan into loop.jsonl's `anomalies` count: (1) capture
// `CLI anomalies` stdout to a file with `>`, then (2) JSON.parse that file and
// read `.findings.length`. This test proves that documented CLI-subprocess +
// file-read codepath yields the exact same integer as calling scanAnomalies()
// directly on the same fixture — so the documented mechanical extraction is
// provably correct, not just plausible-looking prose.
const HARNESS_CLI = fileURLToPath(new URL('../tools/harness.mjs', import.meta.url));
// Load the real routing.json the CLI itself resolves, so the direct
// scanAnomalies() call and the CLI subprocess judge the fixture with identical
// config — otherwise the two counts could diverge on a routing edit.
const REAL_ROUTING = JSON.parse(readFileSync(fileURLToPath(new URL('../config/routing.json', import.meta.url)), 'utf8'));

test('documented step-7 extraction (CLI capture + file read) equals a direct scanAnomalies count on a forced-findings fixture', () => {
  const dir = scaffold();
  // A known-bad record engineered to trip real checks (same shape as the
  // 'non-succeeded runs and verifier cap hits are flagged' fixture): a failed
  // run with reason verifier_blocking_cap guarantees a non-empty findings set.
  const rec = makeRecord({
    status: 'failed',
    reason: { code: 'verifier_blocking_cap', detail: 'cap', phase: null, agent: null },
    phases: [{ phase: 'intake', status: 'failed', rounds_used: 3, verifier_score: 0.5, ended_at: '2026-07-25T00:01:00Z', wall_ms: 60000 }],
  });
  writeRun(dir, rec);

  // Direct library call — the source of truth for the expected count.
  const direct = scanAnomalies({ dir, routing: REAL_ROUTING });
  assert.ok(direct.findings.length > 0, 'fixture must force a non-empty findings set');

  // Documented codepath: run the real CLI `anomalies` subcommand against the
  // fixture dir and redirect its stdout into a captured file. The CLI exits 1
  // whenever findings.length > 0 (harness.mjs: emit(r, r.ok ? 0 : 1)), and
  // execFileSync throws on a non-zero child exit, so read err.stdout in that
  // case rather than assuming a clean return.
  let cliStdout;
  try {
    cliStdout = execFileSync(process.execPath, [HARNESS_CLI, 'anomalies', '--dir', dir], { encoding: 'utf8' });
  } catch (err) {
    cliStdout = err.stdout; // non-zero exit is expected when findings exist
  }
  assert.ok(typeof cliStdout === 'string' && cliStdout.length > 0, 'CLI must have produced JSON on stdout');

  // Persist to a file (inside the fixture's own mkdtemp scratch dir, so the
  // suite stays hermetic) and re-read it, exactly as step 7's `>` redirect +
  // second `node -e` command do.
  const capturePath = join(dir, 'cli-anomalies-capture.json');
  writeFileSync(capturePath, cliStdout);
  const extracted = JSON.parse(readFileSync(capturePath, 'utf8')).findings.length;

  // The two independent codepaths must agree exactly.
  assert.equal(extracted, direct.findings.length);
});
