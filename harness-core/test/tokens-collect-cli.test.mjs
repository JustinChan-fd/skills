import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readRecord } from '../tools/lib/record.mjs';

const CLI = fileURLToPath(new URL('../tools/harness.mjs', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
// The dated fixtures span 2026-07-27; pass a window covering them so collection
// isn't filtered by the fresh record's own (real-clock) run window.
const WINDOW = ['--start', '2026-07-26T00:00:00.000Z', '--end', '2026-07-28T00:00:00.000Z'];

function run(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.status, out: err.stdout ? JSON.parse(err.stdout) : null };
  }
}

function freshRunDir() {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-tc-'));
  const init = run(['init-run', '--target', targetDir, '--repo', 'myapp', '--kind', 'implement', '--source', 'adhoc']);
  assert.equal(init.code, 0);
  return { targetDir, runDir: init.out.run_dir };
}

function auditText(targetDir) {
  return readFileSync(join(targetDir, '.harness', 'audit.jsonl'), 'utf8');
}

test('tokens-collect stamps additive tokens_directional without touching tokens_by_tier / tokens_observed', () => {
  const { runDir } = freshRunDir();
  const before = readRecord(runDir);
  const r = run(['tokens-collect', '--run-dir', runDir, '--transcript', fixture('normal-session.jsonl'), ...WINDOW]);
  assert.equal(r.code, 0);
  assert.equal(r.out.ok, true);
  const after = readRecord(runDir);
  // additive field present and well-shaped
  const td = after.tokens_directional;
  assert.ok(td);
  assert.equal(td.format_version, '1');
  assert.equal(typeof td.collected_at, 'string');
  assert.equal(td.complete, true); // claude-opus-4-8 is a recognized model
  assert.equal(td.by_model['claude-opus-4-8'].input, 330);
  // the two raw token snapshots are byte-identical before/after
  assert.deepEqual(after.tokens_by_tier, before.tokens_by_tier);
  assert.deepEqual(after.tokens_observed, before.tokens_observed);
});

test('phase-end persists tokens_directional even if the run is interrupted before run-end', () => {
  const { runDir } = freshRunDir();
  const r = run(['phase-end', '--run-dir', runDir, '--phase', 'implement', '--status', 'succeeded', '--rounds', '1', '--score', '1', '--size', 'L', '--transcript', fixture('normal-session.jsonl'), ...WINDOW]);
  assert.equal(r.code, 0);
  // Simulate a crash before run-end: read record straight off disk.
  const record = readRecord(runDir);
  assert.ok(record.tokens_directional, 'phase-end alone must persist tokens_directional');
  assert.equal(record.tokens_directional.format_version, '1');
  assert.equal(record.tokens_directional.complete, true);
});

test('forced failure: garbage transcript degrades to estimated-with-note, exit 0, still stamps format_version', () => {
  const { targetDir, runDir } = freshRunDir();
  const r = run(['tokens-collect', '--run-dir', runDir, '--transcript', fixture('garbage.jsonl')]);
  assert.equal(r.code, 0);
  const td = readRecord(runDir).tokens_directional;
  assert.equal(td.complete, false);
  assert.equal(td.format_version, '1'); // format version stamped even on failure
  // an estimated-with-note audit event was written (matches isEstimatedTokensNote)
  const audit = auditText(targetDir);
  assert.ok(/"estimated":\s*true/.test(audit));
});

test('forced failure: missing transcript path degrades to estimated, exit 0, no crash', () => {
  const { runDir } = freshRunDir();
  const r = run(['tokens-collect', '--run-dir', runDir, '--transcript', '/no/such/transcript-xyz.jsonl']);
  assert.equal(r.code, 0);
  const td = readRecord(runDir).tokens_directional;
  assert.equal(td.complete, false);
  assert.equal(td.format_version, '1');
});

test('forced failure: unrecognized model id degrades to estimated-with-note, not silently mis-tiered', () => {
  const { targetDir, runDir } = freshRunDir();
  const r = run(['tokens-collect', '--run-dir', runDir, '--transcript', fixture('unknown-model.jsonl'), ...WINDOW]);
  assert.equal(r.code, 0);
  const td = readRecord(runDir).tokens_directional;
  assert.equal(td.complete, false); // unknown model forces estimated
  // the unknown model's tokens are still recorded under its own id (not mis-tiered under a default)
  assert.equal(td.by_model['some-unrecognized-model-99'].input, 70);
  assert.ok(/"estimated":\s*true/.test(auditText(targetDir)));
});

test('privacy: the stamped record contains only sums + metadata, never transcript content', () => {
  const { runDir } = freshRunDir();
  const r = run(['tokens-collect', '--run-dir', runDir, '--transcript', fixture('normal-session.jsonl'), ...WINDOW]);
  assert.equal(r.code, 0);
  const raw = readFileSync(join(runDir, 'record.json'), 'utf8');
  assert.ok(!raw.includes('SENSITIVE_TRANSCRIPT_TEXT'), 'record leaked transcript message content');
  // sums are present (proves it actually collected, not just wrote an empty stub)
  assert.ok(raw.includes('claude-opus-4-8'));
});
