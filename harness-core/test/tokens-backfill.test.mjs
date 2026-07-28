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

// ---- discoverSubagentForRun tests ----

test('discovers exactly one spawnDepth=1 agent whose time window overlaps the run', () => {
  const dir = makeSubagentsDir();
  // depth-2 agent (should be ignored)
  writeAgentMeta(dir, 'aaa', { spawnDepth: 2, description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'aaa', [usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);

  // depth-1 agent with matching window and issue key
  writeAgentMeta(dir, 'bbb', { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'bbb', [
    usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
    usageLine('claude-sonnet-4-6', '2026-07-27T02:05:00.000Z', { input_tokens: 60, output_tokens: 25, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }),
  ]);

  const r = discoverSubagentForRun({
    subagentsDir: dir,
    issueKey: 'PROJ-1',
    phase: 'plan',
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, true, `expected ok:true, got error: ${r.error?.detail}`);
  assert.ok(r.path.includes('agent-bbb.jsonl'));
});

test('returns ambiguous when two spawnDepth=1 agents both match', () => {
  const dir = makeSubagentsDir();
  for (const id of ['ccc', 'ddd']) {
    writeAgentMeta(dir, id, { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
    writeAgentTranscript(dir, id, [
      usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      usageLine('claude-sonnet-4-6', '2026-07-27T02:10:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
  }
  const r = discoverSubagentForRun({
    subagentsDir: dir,
    issueKey: 'PROJ-1',
    phase: 'plan',
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ambiguous');
  assert.ok(r.error.detail.includes('multiple matching'));
});

test('returns not_found when no agent overlaps the run window sufficiently', () => {
  const dir = makeSubagentsDir();
  // Agent window is far from the run window (no overlap)
  writeAgentMeta(dir, 'eee', { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'eee', [
    usageLine('claude-sonnet-4-6', '2026-07-27T10:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);
  const r = discoverSubagentForRun({
    subagentsDir: dir,
    issueKey: 'PROJ-1',
    phase: 'plan',
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test('description filtering: agent without issue key in description is excluded', () => {
  const dir = makeSubagentsDir();
  writeAgentMeta(dir, 'fff', { spawnDepth: 1, description: 'Some other run driver' });
  writeAgentTranscript(dir, 'fff', [
    usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    usageLine('claude-sonnet-4-6', '2026-07-27T02:10:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);
  const r = discoverSubagentForRun({
    subagentsDir: dir,
    issueKey: 'PROJ-1',
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, false);
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
  writeAgentMeta(dir, 'ggg', { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
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

test('backfillDirectional flags attribution_suspect when directional sum diverges >10x from observed', () => {
  const { runDir } = freshRunDir();

  // Manually write a record with a high observed total
  const before = readRecord(runDir);
  // Use record-observed-tokens CLI to set a high total
  execFileSync('node', [CLI, 'record-observed-tokens', '--run-dir', runDir, '--total', '1000000', '--tier', 'MID'], { encoding: 'utf8' });

  const dir = makeSubagentsDir();
  writeAgentMeta(dir, 'hhh', { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'hhh', [
    // Only 50 tokens total — wildly mismatched vs 1M observed
    usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 20 }),
    usageLine('claude-sonnet-4-6', '2026-07-27T02:10:00.000Z', { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 }),
  ]);

  const r = backfillDirectional({
    runDir,
    subagentsDir: dir,
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'attribution_suspect');
  assert.ok(r.error.detail.includes('diverges'));
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
  const { runDir } = freshRunDir();
  const dir = makeSubagentsDir();
  writeAgentMeta(dir, 'nousage', { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
  // Transcript has timestamps in range but NO usage fields
  writeAgentTranscript(dir, 'nousage', [
    { type: 'user', timestamp: '2026-07-27T02:00:00.000Z', message: { role: 'user', content: 'x' } },
    { type: 'assistant', timestamp: '2026-07-27T02:05:00.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', content: 'y' } },
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
  writeAgentMeta(dir, 'iii', { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
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

test('CLI backfill-directional exits 0 and reports unresolved when transcript is ambiguous — never crashes', () => {
  const { runDir } = freshRunDir();
  execFileSync('node', [CLI, 'run-end', '--target', join(runDir, '..', '..'), '--run-dir', runDir, '--status', 'succeeded'], { encoding: 'utf8' });

  const dir = makeSubagentsDir();
  for (const id of ['jjj', 'kkk']) {
    writeAgentMeta(dir, id, { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
    writeAgentTranscript(dir, id, [
      usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      usageLine('claude-sonnet-4-6', '2026-07-27T02:10:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
  }

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
