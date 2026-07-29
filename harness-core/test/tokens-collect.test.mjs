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
  buildTokensDirectional,
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

test('collectFromFile on subagent-driver fixture returns correct per-model sums', () => {
  const r = collectFromFile(fixture('subagent-driver.jsonl'));
  assert.equal(r.ok, true);
  assert.equal(r.by_model['claude-sonnet-4-6'].input, 110);
  assert.equal(r.by_model['claude-sonnet-4-6'].output, 45);
  assert.equal(r.by_model['claude-sonnet-4-6'].cache_read, 500);
  assert.equal(r.by_model['claude-sonnet-4-6'].cache_creation, 30);
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
  // Any non-alphanumeric that isn't a dash becomes "-" too — notably "@" in a
  // username-shaped home dir (Claude's own munging does this; a "/.-only" regex
  // silently mislocates the transcript and degrades directional tokens to
  // estimated). Existing dashes are preserved.
  assert.equal(mungeProjectDir('/home/dev@corp.com/code'), '-home-dev-corp-com-code');
  assert.equal(mungeProjectDir('/a/b-c/phase-0-foundation'), '-a-b-c-phase-0-foundation');
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

// ---- peak_context: the single-call context fingerprint ----
//
// tokens_observed.total on a record is the Agent tool's subagent_tokens tag,
// which is the PEAK single-call context of that subagent — not a sum. Matching
// a transcript to a run by that number is an identity check; matching by
// spawnDepth + description + a 60s window overlap is three guesses ANDed
// together, and it landed TARS-1271 with an empty by_model.

const usageLine = (ts, model, u) =>
  JSON.stringify({ timestamp: ts, message: { model, usage: u } });

test('peak_context is the largest single call context, not the sum and not the last call', () => {
  // The biggest call is deliberately in the MIDDLE: a bug that returns the last
  // call's total, or a running sum, both pass a fixture where max is last.
  const text = [
    usageLine('2026-07-27T00:00:10.000Z', 'claude-opus-5', {
      input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }),
    usageLine('2026-07-27T00:00:20.000Z', 'claude-opus-5', {
      input_tokens: 5_000, output_tokens: 800, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 2_000,
    }),
    usageLine('2026-07-27T00:00:30.000Z', 'claude-opus-5', {
      input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0,
    }),
  ].join('\n');
  const r = collectFromText(text);
  assert.equal(r.ok, true);
  assert.equal(r.peak_context, 67_800, 'peak is 5000 + 800 + 60000 + 2000');
  const summed = r.by_model['claude-opus-5'];
  const sumTotal = summed.input + summed.output + summed.cache_read + summed.cache_creation;
  assert.ok(r.peak_context < sumTotal, 'peak must not be the sum across calls');
});

test('peak_context ignores the start/end window that sums honour', () => {
  // The whole point: a wrong run window is what breaks time-based attribution,
  // so the fingerprint must survive one. The peak call here is OUTSIDE the
  // window, and must still be reported.
  const text = [
    usageLine('2026-07-27T00:00:10.000Z', 'claude-opus-5', {
      input_tokens: 90_000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }),
    usageLine('2026-07-27T00:05:00.000Z', 'claude-opus-5', {
      input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }),
  ].join('\n');
  const r = collectFromText(text, {
    start: '2026-07-27T00:04:00.000Z',
    end: '2026-07-27T00:06:00.000Z',
  });
  assert.equal(r.ok, true);
  assert.equal(r.peak_context, 90_500, 'the out-of-window peak call was dropped');
  assert.equal(r.by_model['claude-opus-5'].input, 100, 'sums must stay windowed');
});

test('peak_context counts iterations[] sub-entries as their own calls', () => {
  // usagesFromLine flattens iterations[]; each is a real API call with its own
  // context, so the peak may live in a sub-entry rather than message.usage.
  const text = JSON.stringify({
    timestamp: '2026-07-27T00:00:10.000Z',
    message: { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 } },
    iterations: [
      { usage: { input_tokens: 40_000, output_tokens: 300, cache_read_input_tokens: 1_000 } },
      { message: { usage: { input_tokens: 20, output_tokens: 2 } } },
    ],
  });
  const r = collectFromText(text);
  assert.equal(r.peak_context, 41_300);
});

test('missing cache keys coerce to 0 rather than NaN', () => {
  // Older transcript lines carry only input_tokens/output_tokens. A NaN peak
  // makes every fingerprint comparison false, which is the silent-empty failure
  // this whole phase is fixing.
  const text = usageLine('2026-07-27T00:00:10.000Z', 'claude-opus-5', {
    input_tokens: 700, output_tokens: 40,
  });
  const r = collectFromText(text);
  assert.equal(r.peak_context, 740);
  assert.ok(Number.isFinite(r.peak_context), 'peak_context is not finite');
});

test('a transcript with no usage entries reports peak_context 0, not -Infinity', () => {
  const text = JSON.stringify({ timestamp: '2026-07-27T00:00:10.000Z', type: 'user', message: { content: 'hi' } });
  const r = collectFromText(text);
  assert.equal(r.ok, true);
  assert.equal(r.peak_context, 0);
});

test('an empty or unparseable transcript still carries a numeric peak_context', () => {
  // Both early-return paths build from `base`; a field added only to the success
  // path would leave `undefined` here, and Task 3 compares it numerically.
  assert.equal(collectFromText('').peak_context, 0);
  assert.equal(collectFromText('not json at all').peak_context, 0);
});

test('collectFromFile surfaces peak_context, including on the not_found path', () => {
  // Discovery calls collectFromFile, never collectFromText directly.
  const dir = mkdtempSync(join(tmpdir(), 'peak-'));
  const p = join(dir, 't.jsonl');
  writeFileSync(p, usageLine('2026-07-27T00:00:10.000Z', 'claude-opus-5', {
    input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 25,
  }));
  assert.equal(collectFromFile(p).peak_context, 1_175);
  assert.equal(collectFromFile(join(dir, 'nope.jsonl')).peak_context, 0);
});

// ---- buildTokensDirectional: `complete` must never be vacuously true ----

// A helper matching the parser's success shape closely enough for the builder,
// which only reads `.ok` and `.by_model`.
const okResult = (by_model) => ({ ok: true, by_model, error: null });
const sums = { input: 100, output: 50, cache_read: 20, cache_creation: 10 };
const NOW = new Date('2026-07-28T10:00:00.000Z');

test('an empty by_model is never complete — a transcript that produced nothing has nothing to be complete about', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({}),
    modelTierMap: { 'claude-opus-4-8': 'HIGH' },
    now: NOW,
  });
  // This is the shape the live TARS-1271 record landed in: ok collect, zero
  // models, zero unknowns -> the old code stamped complete:true over {}.
  assert.deepEqual(tokens_directional.by_model, {});
  assert.equal(tokens_directional.complete, false);
  assert.equal(tokens_directional.format_version, '1');
  assert.equal(tokens_directional.collected_at, '2026-07-28T10:00:00.000Z');
  // The note is the only channel that distinguishes "collected nothing" from
  // "collected something but saw an unknown model" (no field is added to the
  // record — the schema's tokens_directional is additionalProperties:false).
  assert.equal(note.code, 'empty_collection');
  assert.match(note.detail, /no model usage/i);
});

test('a populated by_model with every model tiered is complete — the empty-guard does not invert the normal path', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({ 'claude-opus-4-8': { ...sums } }),
    modelTierMap: { 'claude-opus-4-8': 'HIGH' },
    now: NOW,
  });
  assert.equal(tokens_directional.complete, true);
  assert.equal(note, null);
  assert.equal(tokens_directional.by_model['claude-opus-4-8'].input, 100);
});

test('a populated by_model containing an unknown model id is still not complete, and says so distinctly', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({
      'claude-opus-4-8': { ...sums },
      'some-unrecognized-model-99': { input: 70, output: 5, cache_read: 0, cache_creation: 0 },
    }),
    modelTierMap: { 'claude-opus-4-8': 'HIGH' },
    now: NOW,
  });
  assert.equal(tokens_directional.complete, false);
  assert.equal(note.code, 'unknown_model');
  assert.notEqual(note.code, 'empty_collection'); // the two degradations stay tellable apart
  // the unknown model's tokens survive under its own id, never mis-tiered
  assert.equal(tokens_directional.by_model['some-unrecognized-model-99'].input, 70);
});

test('a failed collect keeps its own error code and is not relabelled empty_collection', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: { ok: false, by_model: {}, error: { code: 'not_found', detail: 'no such transcript' } },
    modelTierMap: {},
    now: NOW,
  });
  assert.equal(tokens_directional.complete, false);
  assert.equal(note.code, 'not_found'); // parse/discovery failure wins over emptiness
  assert.equal(tokens_directional.format_version, '1'); // stamped even on failure
});

test('a dated model id resolves through normalization and stays complete', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({ 'claude-sonnet-4-5-20250929': { ...sums } }),
    modelTierMap: { 'claude-sonnet-4-5': 'MID' },
    now: NOW,
  });
  // 1,739 usage lines in the sampled local transcripts carry exactly this id.
  // Before normalization this was an unknown_model degradation on a perfect capture.
  assert.equal(tokens_directional.complete, true);
  assert.equal(note, null);
  // The tokens stay filed under the id the transcript actually used — normalization
  // is a lookup convenience, never a rewrite of captured data.
  assert.equal(tokens_directional.by_model['claude-sonnet-4-5-20250929'].input, 100);
  assert.equal(tokens_directional.by_model['claude-sonnet-4-5'], undefined);
});

test('an anthropic.-prefixed id resolves through normalization too', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({ 'anthropic.claude-sonnet-4-6': { ...sums } }),
    modelTierMap: { 'claude-sonnet-4-6': 'MID' },
    now: NOW,
  });
  assert.equal(tokens_directional.complete, true);
  assert.equal(note, null);
});

test('a genuinely unrecognized id is still incomplete — normalization is not family guessing', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({ 'claude-sonnet-9': { ...sums } }),
    modelTierMap: { 'claude-sonnet-4-6': 'MID' },
    now: NOW,
  });
  // A future flagship must still degrade loudly. If this ever passes as complete,
  // normalization has grown a substring fallback and is mis-pricing new models.
  assert.equal(tokens_directional.complete, false);
  assert.equal(note.code, 'unknown_model');
  assert.match(note.detail, /claude-sonnet-9/);
});

test('a non-Anthropic vendor id is reported unknown, not silently tiered', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({ 'qwen.qwen3-coder-30b-a3b-v1:0': { ...sums } }),
    modelTierMap: { 'claude-sonnet-4-6': 'MID' },
    now: NOW,
  });
  assert.equal(tokens_directional.complete, false);
  assert.equal(note.code, 'unknown_model');
});
