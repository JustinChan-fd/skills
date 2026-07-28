import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_GAP_CAP_MS,
  collectFromText,
  collectFromFile,
  mungeProjectDir,
  projectDirForCwd,
  discoverLoopTranscript,
  discoverStandaloneTranscript,
} from '../tools/lib/tokens-collect.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const readFixture = (name) => readFileSync(fixture(name), 'utf8');

// ---- u1: pure parser ----

test('sums token usage by model x direction across a transcript', () => {
  const r = collectFromText(readFixture('normal-session.jsonl'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.by_model['claude-opus-4-8'], {
    input: 330, // 100 + 200 + 30
    output: 145, // 50 + 80 + 15
    cache_read: 1020, // 20 + 0 + 1000
    cache_creation: 15, // 10 + 5 + 0
  });
});

test('iterations[] sub-entries are summed in addition to top-level message.usage', () => {
  const r = collectFromText(readFixture('iterations.jsonl'));
  assert.equal(r.ok, true);
  const m = r.by_model['claude-opus-4-8'];
  // top-level message.usage alone would give input 10; iterations add 100 + 200.
  assert.equal(m.input, 310);
  assert.ok(m.input > 10, 'summed total must exceed top-level-only usage');
  assert.equal(m.output, 135); // 5 + 50 + 80
  assert.equal(m.cache_read, 30); // 0 + 30 + 0
  assert.equal(m.cache_creation, 12); // 0 + 0 + 12
});

test('slices to a caller-supplied start/end ISO window, excluding out-of-window lines', () => {
  const r = collectFromText(readFixture('normal-session.jsonl'), {
    start: '2026-07-27T00:00:05.000Z',
    end: '2026-07-27T00:00:25.000Z',
  });
  assert.equal(r.ok, true);
  // Only the two assistant lines at :10 and :20 fall in the window.
  assert.deepEqual(r.by_model['claude-opus-4-8'], {
    input: 300, // 100 + 200
    output: 130, // 50 + 80
    cache_read: 20, // 20 + 0
    cache_creation: 15, // 10 + 5
  });
  assert.equal(r.timestamps.min, '2026-07-27T00:00:10.000Z');
  assert.equal(r.timestamps.max, '2026-07-27T00:00:20.000Z');
});

test('reports per-call timestamp min/max and a gap-capped active-time sum', () => {
  const r = collectFromText(readFixture('normal-session.jsonl'));
  assert.equal(r.timestamps.min, '2026-07-27T00:00:00.000Z');
  assert.equal(r.timestamps.max, '2026-07-27T00:10:30.000Z');
  // gaps: 10s, 10s, 610s (capped to the 300s default) => 320s
  assert.equal(r.gap_cap_ms, DEFAULT_GAP_CAP_MS);
  assert.equal(r.active_ms, 320_000);
});

test('the gap cap is a named documented parameter with a sensible default', () => {
  assert.equal(DEFAULT_GAP_CAP_MS, 5 * 60 * 1000);
  // a caller-supplied cap changes the active-time sum
  const r = collectFromText(readFixture('normal-session.jsonl'), { gapCapMs: 5_000 });
  // gaps: 10s->5s, 10s->5s, 610s->5s => 15s
  assert.equal(r.active_ms, 15_000);
  assert.equal(r.gap_cap_ms, 5_000);
});

test('garbage/malformed transcript returns a structured failure result, never throws', () => {
  let r;
  assert.doesNotThrow(() => {
    r = collectFromText(readFixture('garbage.jsonl'));
  });
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(typeof r.error.code, 'string');
  assert.equal(typeof r.error.detail, 'string');
  assert.equal(r.lines_parsed, 0);
});

test('return value contains no raw transcript text anywhere in its object graph', () => {
  for (const name of ['normal-session.jsonl', 'subagent.jsonl', 'iterations.jsonl', 'unknown-model.jsonl']) {
    const r = collectFromText(readFixture(name));
    const serialized = JSON.stringify(r);
    assert.ok(
      !serialized.includes('SENSITIVE_TRANSCRIPT_TEXT'),
      `result for ${name} leaked transcript content`,
    );
  }
});

test('an unrecognized model id is still summed under its own id (tiering happens later)', () => {
  const r = collectFromText(readFixture('unknown-model.jsonl'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.by_model['some-unrecognized-model-99'], {
    input: 70,
    output: 25,
    cache_read: 0,
    cache_creation: 0,
  });
});

test('collectFromFile reads a transcript path and parses it', () => {
  const r = collectFromFile(fixture('subagent.jsonl'));
  assert.equal(r.ok, true);
  assert.equal(r.by_model['claude-sonnet-5'].input, 40);
  assert.equal(r.by_model['claude-haiku-4-5'].input, 8);
});

test('collectFromFile on a missing path returns a structured not-found result, never throws', () => {
  let r;
  assert.doesNotThrow(() => {
    r = collectFromFile(fixture('does-not-exist.jsonl'));
  });
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(r.error.code, 'not_found');
});

// ---- u3: transcript discovery ----

// Write a .jsonl file and stamp it with an explicit mtime (git does not
// preserve mtimes, so checked-in fixtures can't encode "newest").
function writeWithMtime(dir, name, mtimeSeconds) {
  const full = join(dir, name);
  writeFileSync(full, '{"type":"user","message":{}}\n');
  utimesSync(full, mtimeSeconds, mtimeSeconds);
  return full;
}

test('cwd-to-munged-project-dir helper returns the ~/.claude/projects/<munged-cwd> path', () => {
  // Synthetic cwd (real user paths are barred from skill code by portability.test).
  assert.equal(mungeProjectDir('/home/dev/code/myapp'), '-home-dev-code-myapp');
  // "/" and "." both become "-"
  assert.equal(mungeProjectDir('/a/b/.hidden/c'), '-a-b--hidden-c');
  assert.equal(
    projectDirForCwd('/home/dev/code/myapp', { home: '/home/x' }),
    '/home/x/.claude/projects/-home-dev-code-myapp',
  );
  // default home is the real homedir
  assert.ok(projectDirForCwd('/x').startsWith(join(homedir(), '.claude', 'projects')));
});

test('loop-path discovery returns the newest-mtime agent-*.jsonl (ties broken by filename)', () => {
  const subagents = mkdtempSync(join(tmpdir(), 'harness-subagents-'));
  writeWithMtime(subagents, 'agent-aaa.jsonl', 1000);
  writeWithMtime(subagents, 'agent-bbb.jsonl', 3000); // newest
  writeWithMtime(subagents, 'agent-ccc.jsonl', 2000);
  writeWithMtime(subagents, 'not-an-agent.jsonl', 5000); // ignored (no agent- prefix)
  const r = discoverLoopTranscript(subagents);
  assert.equal(r.ok, true);
  assert.equal(r.path, join(subagents, 'agent-bbb.jsonl'));

  // tie on mtime -> lexicographically greatest filename wins (deterministic)
  const tied = mkdtempSync(join(tmpdir(), 'harness-tie-'));
  writeWithMtime(tied, 'agent-aaa.jsonl', 4000);
  writeWithMtime(tied, 'agent-zzz.jsonl', 4000);
  assert.equal(discoverLoopTranscript(tied).path, join(tied, 'agent-zzz.jsonl'));
});

test('standalone-path discovery returns the newest-mtime top-level session .jsonl', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'harness-project-'));
  writeWithMtime(projectDir, 'session-old.jsonl', 1000);
  writeWithMtime(projectDir, 'session-new.jsonl', 9000); // newest
  // a nested subagents/ dir must NOT be picked up by the top-level scan
  const nested = join(projectDir, 'session-new', 'subagents');
  mkdirSync(nested, { recursive: true });
  writeWithMtime(nested, 'agent-xyz.jsonl', 99999);
  const r = discoverStandaloneTranscript(projectDir);
  assert.equal(r.ok, true);
  assert.equal(r.path, join(projectDir, 'session-new.jsonl'));
});

test('both discovery paths degrade to a structured not-found on a missing directory, never throw', () => {
  const missing = join(tmpdir(), 'harness-nope-does-not-exist-xyz');
  for (const r of [discoverLoopTranscript(missing), discoverStandaloneTranscript(missing)]) {
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'not_found');
    assert.equal(r.path, null);
  }
  // present-but-empty directory is also a clean not-found
  const empty = mkdtempSync(join(tmpdir(), 'harness-empty-'));
  assert.equal(discoverLoopTranscript(empty).ok, false);
});
