import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readRecord } from '../tools/lib/record.mjs';
import {
  discoverSubagentForRun,
  backfillDirectional,
  FINGERPRINT_BAND,
} from '../tools/lib/tokens-collect.mjs';

const CLI = fileURLToPath(new URL('../tools/harness.mjs', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// ---- helpers ----

function writeAgentMeta(dir, id, meta) {
  writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
}

function writeAgentTranscript(dir, id, lines) {
  writeFileSync(join(dir, `agent-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function freshRunDir() {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-bf-'));
  const stdout = execFileSync('node', [CLI, 'init-run', '--target', targetDir, '--repo', 'myapp', '--kind', 'plan', '--source', 'issue-PROJ-1', '--issue', 'PROJ-1'], { encoding: 'utf8' });
  return { targetDir, runDir: JSON.parse(stdout).run_dir };
}

function makeSubagentsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-sub-'));
  return dir;
}

// A minimal transcript line with usage and timestamp.
function usageLine(model, ts, usage) {
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', model, content: 'x', usage } };
}

// A transcript whose single largest call has exactly `peak` total context.
// tokens_observed.total is that peak, so this is how a fixture declares
// "I am the transcript for a run that recorded N observed tokens".
function transcriptWithPeak(dir, id, peak, ts = '2026-07-27T02:00:00.000Z') {
  writeAgentMeta(dir, id, { description: 'whatever' });
  writeAgentTranscript(dir, id, [
    usageLine('claude-opus-5', ts, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    usageLine('claude-opus-5', ts, { input_tokens: peak - 500, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);
}

// ---- discoverSubagentForRun tests ----

test('an exact peak-context match wins, and a non-matching transcript is excluded', () => {
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'aaa', 12_000);  // a different run's driver
  transcriptWithPeak(dir, 'bbb', 90_000);  // ours
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 90_000 });
  assert.equal(r.ok, true, `expected a match, got ${r.error?.code}: ${r.error?.detail}`);
  assert.ok(r.path.includes('agent-bbb.jsonl'), `matched the wrong transcript: ${r.path}`);
});

test('spawnDepth and description are no longer consulted', () => {
  // Both were hard filters. A depth-2 agent with a description naming neither the
  // issue nor the phase must now match purely on its fingerprint — this is the
  // combination that silently produced an empty by_model on the live path.
  const dir = makeSubagentsDir();
  writeAgentMeta(dir, 'ccc', { spawnDepth: 2, description: 'unrelated prose' });
  writeAgentTranscript(dir, 'ccc', [
    usageLine('claude-opus-5', '2026-07-27T02:00:00.000Z', { input_tokens: 49_500, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 50_000 });
  assert.equal(r.ok, true, `expected a match, got ${r.error?.code}`);
});

test('a fingerprint match succeeds even when the time windows do not overlap', () => {
  // THE regression this task exists for. The run window here is hours off from
  // the transcript — the old MIN_OVERLAP_MS check rejected exactly this, which is
  // how a correct transcript got thrown away.
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'ddd', 75_000, '2026-07-27T10:00:00.000Z');
  const r = discoverSubagentForRun({
    subagentsDir: dir,
    observedTotal: 75_000,
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, true, `window rejected a fingerprint match: ${r.error?.detail}`);
  assert.ok(r.path.includes('agent-ddd.jsonl'));
});

test('a match inside the tolerance band is accepted at ratio 0.96', () => {
  // The driver can read subagent_tokens before the last streamed usage entry
  // flushes, so the transcript peak lands slightly under the recorded total.
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'eee', 96_000);
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 });
  assert.equal(r.ok, true, `0.96 should be in band, got ${r.error?.code}`);
});

test('a transcript at half the observed total is rejected', () => {
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'fff', 50_000);
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test('a transcript far above the observed total is rejected too', () => {
  // Without an upper bound, the largest transcript in the directory matches every
  // smaller run — a long sibling driver would win every attribution.
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'ggg', 400_000);
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test('two candidates in band: the one closest to the observed total wins', () => {
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'hhh', 96_000);   // ratio 0.96
  transcriptWithPeak(dir, 'iii', 99_500);   // ratio 0.995 — closer
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 });
  assert.equal(r.ok, true, 'in-band candidates must resolve, never return ambiguous');
  assert.ok(r.path.includes('agent-iii.jsonl'), `picked the further candidate: ${r.path}`);
});

test('an exact ratio tie resolves deterministically by path', () => {
  // readdirSync order is not guaranteed stable across filesystems, and a
  // non-deterministic pick makes the same run attribute differently on re-scan.
  // 'jjj' < 'kkk' lexicographically, so jjj must win.
  // Both candidates have identical drift, so the tie-break is the only thing
  // separating them. The test creates jjj after kkk on purpose: any implementation
  // that picks the first candidate in iteration order would return kkk, not jjj.
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'kkk', 80_000);  // written first — wins if we follow readdir order
  transcriptWithPeak(dir, 'jjj', 80_000);  // written second — wins only if tie-break is lexicographic
  const first = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 80_000 });
  const second = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 80_000 });
  assert.equal(first.ok, true);
  assert.equal(first.path, second.path, 'discovery is not deterministic on a tie');
  assert.ok(first.path.includes('agent-jjj.jsonl'), 'tie-break is not lexicographic — expected jjj (smaller path) but got: ' + first.path);
});

test('no observed total means no fingerprint, and no silent fallback', () => {
  // There is deliberately no heuristic fallback: guessing is what produced a
  // wrong-or-empty stamp. Say so in the error instead.
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'lll', 80_000);
  for (const observedTotal of [0, undefined, null]) {
    const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'no_fingerprint', `observedTotal ${observedTotal} took a fallback path`);
  }
});

test('the exported band is what discovery actually enforces', () => {
  // Guards against the constant and the comparison drifting apart.
  // Asserts both the constant values AND that boundary points just outside
  // the band are rejected — pinning lo exclusion, hi exclusion, and the
  // values themselves so a widened constant can't silently swallow these cases.
  assert.equal(FINGERPRINT_BAND.lo, 0.95);
  assert.equal(FINGERPRINT_BAND.hi, 1.05);

  // lo boundary: just at lo is in-band, just below lo is rejected.
  {
    const dir = makeSubagentsDir();
    transcriptWithPeak(dir, 'lo-in', Math.round(100_000 * FINGERPRINT_BAND.lo));
    assert.equal(discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 }).ok, true, 'lo boundary must be in-band');
  }
  {
    const dir = makeSubagentsDir();
    transcriptWithPeak(dir, 'lo-out', Math.round(100_000 * (FINGERPRINT_BAND.lo - 0.01)));
    const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 });
    assert.equal(r.ok, false, 'just below lo must be rejected');
    assert.equal(r.error.code, 'not_found');
  }

  // hi boundary: just at hi is in-band, just above hi is rejected.
  {
    const dir = makeSubagentsDir();
    transcriptWithPeak(dir, 'hi-in', Math.round(100_000 * FINGERPRINT_BAND.hi));
    assert.equal(discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 }).ok, true, 'hi boundary must be in-band');
  }
  {
    const dir = makeSubagentsDir();
    transcriptWithPeak(dir, 'hi-out', Math.round(100_000 * (FINGERPRINT_BAND.hi + 0.01)));
    const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 });
    assert.equal(r.ok, false, 'just above hi must be rejected');
    assert.equal(r.error.code, 'not_found');
  }
});

test('a transcript with no usage entries is not matched even when no real candidate exists', () => {
  // Guard: `peak_context <= 0` at the filter line. Without it, a transcript with
  // peak_context:undefined produces ratio NaN, both band comparisons are false
  // (NaN comparisons), so the band check is skipped and the candidate is selected.
  // collectForRun's inline fallback at line 365 omits peak_context entirely,
  // making this a live hazard on the no-transcript path. The guard is load-bearing.
  const dir = makeSubagentsDir();
  // A transcript with no usage lines: peak_context = 0.
  writeAgentMeta(dir, 'nnn', { description: 'whatever' });
  writeAgentTranscript(dir, 'nnn', [
    { type: 'user', timestamp: '2026-07-27T02:00:00.000Z', message: { role: 'user', content: 'x' } },
  ]);
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 50_000 });
  assert.equal(r.ok, false, 'a zero-peak transcript must not be matched');
  assert.equal(r.error.code, 'not_found');
});

test('returns not_found on a missing subagents directory', () => {
  const r = discoverSubagentForRun({ subagentsDir: '/tmp/harness-nope-xyz-does-not-exist' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

// ---- backfillDirectional tests ----

test('backfillDirectional returns correct by_model sums and does not touch tokens_observed', () => {
  const { runDir } = freshRunDir();

  // Set a run window on the record (simulate a finalized run)
  execFileSync('node', [CLI, 'run-end', '--target', /* doesn't matter, use runDir parent */ join(runDir, '..', '..'), '--run-dir', runDir, '--status', 'succeeded'], { encoding: 'utf8' });

  const dir = makeSubagentsDir();
  // peak = 50 + 20 + 200 + 30 = 300; use 300 as observedTotal by stamping it on the record
  // We need tokens_observed.total to match the transcript peak for fingerprint discovery.
  // Peak of this transcript: max(50+20+200+30, 60+25+300+0) = max(300, 385) = 385
  execFileSync('node', [CLI, 'record-observed-tokens', '--run-dir', runDir, '--total', '385', '--tier', 'MID'], { encoding: 'utf8' });

  writeAgentMeta(dir, 'ggg', { description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'ggg', [
    usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
    usageLine('claude-sonnet-4-6', '2026-07-27T02:05:00.000Z', { input_tokens: 60, output_tokens: 25, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }),
  ]);

  const r = backfillDirectional({
    runDir,
    subagentsDir: dir,
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
    modelTierMap: { 'claude-sonnet-4-6': 'MID' },
    now: new Date('2026-07-28T10:00:00.000Z'),
  });

  assert.equal(r.ok, true, `expected ok:true, got error: ${r.error?.detail}`);
  const m = r.tokens_directional.by_model['claude-sonnet-4-6'];
  assert.equal(m.input, 110);
  assert.equal(m.output, 45);
  assert.equal(m.cache_read, 500);
  assert.equal(m.cache_creation, 30);
  assert.equal(r.tokens_directional.complete, true);
});

test('backfillDirectional returns not_found when subagents dir is missing', () => {
  const { runDir } = freshRunDir();
  const r = backfillDirectional({
    runDir,
    subagentsDir: '/tmp/harness-nope-xyz-does-not-exist',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test('backfillDirectional returns ok:false when transcript has no usage in the run window', () => {
  // The usage line is OUTSIDE the run window (10:00 vs window 02:00-02:30), so the
  // windowed collection returns empty by_model. Discovery succeeds because peak_context
  // is unwindowed (peak = 15 matches observedTotal = 15), but the stamp is refused.
  const { runDir } = freshRunDir();
  execFileSync('node', [CLI, 'record-observed-tokens', '--run-dir', runDir, '--total', '15', '--tier', 'MID'], { encoding: 'utf8' });
  const dir = makeSubagentsDir();
  writeAgentMeta(dir, 'nousage', { description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'nousage', [
    usageLine('claude-sonnet-4-6', '2026-07-27T10:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);
  const r = backfillDirectional({
    runDir,
    subagentsDir: dir,
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_usage');
});

// ---- CLI: backfill-directional subcommand ----

test('CLI backfill-directional stamps tokens_directional.by_model onto record.json', () => {
  const { runDir } = freshRunDir();
  execFileSync('node', [CLI, 'run-end', '--target', join(runDir, '..', '..'), '--run-dir', runDir, '--status', 'succeeded'], { encoding: 'utf8' });

  const dir = makeSubagentsDir();
  // peak = max(50+20+200+30, 60+25+300+0) = max(300, 385) = 385
  execFileSync('node', [CLI, 'record-observed-tokens', '--run-dir', runDir, '--total', '385', '--tier', 'MID'], { encoding: 'utf8' });

  writeAgentMeta(dir, 'iii', { description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'iii', [
    usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
    usageLine('claude-sonnet-4-6', '2026-07-27T02:05:00.000Z', { input_tokens: 60, output_tokens: 25, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }),
  ]);

  // Snapshot the real before-state to verify preservation of untouched fields.
  const before = readRecord(runDir);

  const stdout = execFileSync('node', [CLI, 'backfill-directional',
    '--run-dir', runDir,
    '--subagents-dir', dir,
    '--start', '2026-07-27T02:00:00.000Z',
    '--end', '2026-07-27T02:30:00.000Z',
  ], { encoding: 'utf8' });
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'resolved');

  const record = readRecord(runDir);
  assert.ok(record.tokens_directional, 'tokens_directional must be stamped');
  const m = record.tokens_directional.by_model['claude-sonnet-4-6'];
  assert.ok(m, 'claude-sonnet-4-6 bucket must be present');
  assert.equal(m.input, 110);

  // Invariant: tokens_observed and tokens_by_tier must not be touched
  assert.deepEqual(record.tokens_observed, before.tokens_observed);
  assert.deepEqual(record.tokens_by_tier, before.tokens_by_tier);
});

test('CLI backfill-directional exits 0 and reports unresolved on no_fingerprint — never crashes', () => {
  const { runDir } = freshRunDir();
  execFileSync('node', [CLI, 'run-end', '--target', join(runDir, '..', '..'), '--run-dir', runDir, '--status', 'succeeded'], { encoding: 'utf8' });

  const dir = makeSubagentsDir();
  // Write a transcript with tokens, but do NOT stamp any observedTotal on the record,
  // so tokens_observed.total stays 0/absent — discovery returns no_fingerprint.
  writeAgentMeta(dir, 'jjj', { description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'jjj', [
    usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);

  let code = 0, out;
  try {
    const stdout = execFileSync('node', [CLI, 'backfill-directional',
      '--run-dir', runDir,
      '--subagents-dir', dir,
      '--start', '2026-07-27T02:00:00.000Z',
      '--end', '2026-07-27T02:30:00.000Z',
    ], { encoding: 'utf8' });
    out = JSON.parse(stdout);
  } catch (err) {
    code = err.status;
    out = err.stdout ? JSON.parse(err.stdout) : null;
  }
  assert.equal(code, 0, 'backfill-directional must exit 0 even on unresolved');
  assert.equal(out.status, 'unresolved');
  assert.ok(out.reason, 'must include a reason for unresolved');
});
