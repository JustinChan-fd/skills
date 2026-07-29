import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
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

// ---- #17: subtree collection + exact agent-id re-collection ----

/**
 * Create a temp project-dir containing a driver + one child subagent transcript
 * and a matching run dir. Returns { runDir, cwd, sessionId, driverId, transcriptPath, projectDir }.
 *
 * Why --project-dir instead of overriding HOME:
 *   execFileSync's `env` option REPLACES the environment (it does not merge), so
 *   passing env:{ HOME: tmpDir } would strip PATH and break the node spawn outright.
 *   subagentsDirForSession accepts projectDir directly, so passing --project-dir
 *   still exercises the full session-derived path (<projectDir>/<sessionId>/subagents)
 *   without touching HOME.
 *
 * Why fixture timestamps are written AFTER init-run:
 *   init-run sets started_at to the real clock. collectForRun's default window
 *   start is record.started_at, so fixture lines must be dated AFTER started_at.
 *   By calling init-run first and then writing fixtures with timestamps near
 *   Date.now(), we guarantee started_at < fixture_ts < collection_now without
 *   needing explicit --start/--end on every CLI call.
 */
function makeSubtreeRun() {
  // 1. Create the cwd (a plain temp dir — it's just a path, not a real harness repo).
  const cwd = mkdtempSync(join(tmpdir(), 'harness-subtree-cwd-'));

  // 2. Create the project-dir (simulates ~/.claude/projects/<munged>).
  const projectDir = mkdtempSync(join(tmpdir(), 'harness-subtree-proj-'));

  // 3. Create a session + subagents dir.
  const sessionId = randomUUID();
  const driverId = randomUUID().replace(/-/g, '').slice(0, 16);
  const kidId = randomUUID().replace(/-/g, '').slice(0, 16);
  const subagentsDir = join(projectDir, sessionId, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });

  // 4. Create the run dir via init-run FIRST, so started_at is set before fixture
  //    timestamps. Fixture lines are then written with timestamps AFTER started_at.
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-subtree-target-'));
  const init = run(['init-run', '--target', targetDir, '--repo', 'myapp', '--kind', 'implement', '--source', 'adhoc']);
  assert.equal(init.code, 0);
  const { run_dir: runDir } = init.out;

  // 5. Write driver transcript (claude-opus-5: 100 input / 10 output).
  //    Use fixed timestamps inside a known window; the tests pass --start/--end
  //    explicitly so the real-clock window is bypassed entirely. This is the same
  //    pattern as the WINDOW constant used by the existing tests.
  const TS_START = '2026-07-29T10:00:00.000Z';
  const TS_END   = '2026-07-29T10:05:00.000Z';
  const t1 = '2026-07-29T10:01:00.000Z';
  const t2 = '2026-07-29T10:02:00.000Z';
  const driverLines = [
    JSON.stringify({ type: 'user', timestamp: t1, message: { role: 'user', content: 'drive the phase' } }),
    JSON.stringify({ type: 'assistant', timestamp: t2, message: { role: 'assistant', model: 'claude-opus-5', content: 'driving', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  ].join('\n') + '\n';
  const transcriptPath = join(subagentsDir, `agent-${driverId}.jsonl`);
  writeFileSync(transcriptPath, driverLines);

  // 6. Write driver meta.json (spawnDepth: 1 = depth from session root).
  writeFileSync(join(subagentsDir, `agent-${driverId}.meta.json`), JSON.stringify({
    agentType: 'hi-developer', description: 'phase driver',
    toolUseId: 'toolu_driver', parentAgentId: null, spawnDepth: 1, model: 'claude-opus-5',
  }));

  // 7. Write child transcript (claude-sonnet-4-6: 40 input / 4 output).
  const t3 = '2026-07-29T10:03:00.000Z';
  const t4 = '2026-07-29T10:04:00.000Z';
  const kidLines = [
    JSON.stringify({ type: 'user', timestamp: t3, message: { role: 'user', content: 'do the work' } }),
    JSON.stringify({ type: 'assistant', timestamp: t4, message: { role: 'assistant', model: 'claude-sonnet-4-6', content: 'working', usage: { input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  ].join('\n') + '\n';
  writeFileSync(join(subagentsDir, `agent-${kidId}.jsonl`), kidLines);

  // 8. Write child meta.json.
  writeFileSync(join(subagentsDir, `agent-${kidId}.meta.json`), JSON.stringify({
    agentType: 'codebase_analyst', description: 'child agent',
    toolUseId: 'toolu_child', parentAgentId: driverId, spawnDepth: 2, model: 'claude-sonnet-4-6',
  }));

  return { runDir, cwd, sessionId, driverId, transcriptPath, projectDir,
    tsStart: TS_START, tsEnd: TS_END };
}

test('tokens-collect defaults a phase run to subtree mode via the session env', () => {
  // A run whose project-dir contains <session>/subagents with one driver + one child.
  // No --mode, no --subagents-dir: the CLI derives both from CLAUDE_CODE_SESSION_ID
  // and --project-dir. We pass --project-dir instead of overriding HOME because
  // execFileSync env: replacement (not merge) would strip PATH.
  // Explicit --start/--end cover the fixed fixture timestamps (same pattern as WINDOW).
  const { runDir, cwd, sessionId, projectDir, tsStart, tsEnd } = makeSubtreeRun();
  const r = run([
    'tokens-collect', '--run-dir', runDir, '--cwd', cwd, '--project-dir', projectDir,
    '--start', tsStart, '--end', tsEnd,
  ], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } });
  assert.equal(r.code, 0);
  assert.equal(r.out.ok, true);
  assert.equal(r.out.via, 'all_drivers');
  assert.ok(Object.keys(r.out.tokens_directional.by_model).length > 0, 'by_model must not be empty');
});

test('record-observed-tokens --agent-id re-collects that agent subtree exactly', () => {
  const { runDir, cwd, sessionId, driverId, projectDir, tsStart, tsEnd } = makeSubtreeRun();
  const r = run([
    'record-observed-tokens', '--run-dir', runDir, '--total', '110', '--tier', 'HIGH',
    '--agent-id', driverId, '--cwd', cwd, '--project-dir', projectDir,
    '--start', tsStart, '--end', tsEnd,
  ], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } });
  assert.equal(r.code, 0);
  assert.equal(r.out.directional_recollected, true);
  assert.equal(r.out.via, 'subtree');
  assert.equal(r.out.tokens_observed.total, 110);
  const rec = JSON.parse(readFileSync(join(runDir, 'record.json'), 'utf8'));
  // Both the driver's model and its child's model must be present — the whole subtree.
  assert.deepEqual(Object.keys(rec.tokens_directional.by_model).sort(),
    ['claude-opus-5', 'claude-sonnet-4-6']);
  assert.equal(rec.tokens_directional.complete, true);
});

test('record-observed-tokens without --agent-id still records observed tokens', () => {
  const { runDir } = makeSubtreeRun();
  const r = run(['record-observed-tokens', '--run-dir', runDir, '--total', '500', '--tier', 'HIGH']);
  assert.equal(r.code, 0);
  assert.equal(r.out.tokens_observed.total, 500);
  assert.equal(r.out.directional_recollected, false);
});

test('an unresolvable --agent-id leaves an existing good stamp intact', () => {
  const { runDir, cwd, sessionId, driverId, projectDir, tsStart, tsEnd } = makeSubtreeRun();
  // Establish a good stamp first.
  run(['record-observed-tokens', '--run-dir', runDir, '--total', '110', '--tier', 'HIGH',
    '--agent-id', driverId, '--cwd', cwd, '--project-dir', projectDir,
    '--start', tsStart, '--end', tsEnd],
    { env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } });
  const before = JSON.parse(readFileSync(join(runDir, 'record.json'), 'utf8')).tokens_directional;
  // Now a bogus agent id: the clobber guard must protect the good sums.
  run(['record-observed-tokens', '--run-dir', runDir, '--total', '110', '--tier', 'HIGH',
    '--agent-id', 'does-not-exist', '--cwd', cwd, '--project-dir', projectDir,
    '--start', tsStart, '--end', tsEnd],
    { env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } });
  const after = JSON.parse(readFileSync(join(runDir, 'record.json'), 'utf8')).tokens_directional;
  assert.deepEqual(after.by_model, before.by_model, 'good sums must survive a bad re-collect');
});

test('directional_recollected is false when the clobber guard declines the stamp', () => {
  // The companion to the test above: protecting the good sums means the stamp
  // did NOT land, and the caller must be told so. Reporting `true` here says
  // "the record was enriched" about a record that was left untouched — the
  // reader then attributes stale sums to this invocation.
  //
  // This is the ONLY way to reach the declined stamp from the CLI: it needs
  // existing good sums AND an empty incoming by_model. A fresh run dir with a
  // bogus --project-dir degrades but still reports true, correctly — there was
  // nothing to protect, so the empty stamp landed.
  const { runDir, cwd, sessionId, driverId, projectDir, tsStart, tsEnd } = makeSubtreeRun();
  const good = run(['record-observed-tokens', '--run-dir', runDir, '--total', '110', '--tier', 'HIGH',
    '--agent-id', driverId, '--cwd', cwd, '--project-dir', projectDir,
    '--start', tsStart, '--end', tsEnd],
    { env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } });
  assert.equal(good.out.directional_recollected, true, 'a landing stamp still reports true');

  const declined = run(['record-observed-tokens', '--run-dir', runDir, '--total', '110', '--tier', 'HIGH',
    '--agent-id', 'does-not-exist', '--cwd', cwd, '--project-dir', projectDir,
    '--start', tsStart, '--end', tsEnd],
    { env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } });
  assert.equal(declined.code, 0, 'a declined stamp is not an error');
  assert.equal(declined.out.directional_recollected, false);
});

test('an explicit --transcript still overrides subtree defaulting', () => {
  const { runDir, cwd, sessionId, transcriptPath, projectDir, tsStart, tsEnd } = makeSubtreeRun();
  const r = run(['tokens-collect', '--run-dir', runDir, '--cwd', cwd,
    '--transcript', transcriptPath, '--project-dir', projectDir,
    '--start', tsStart, '--end', tsEnd],
    { env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } });
  assert.equal(r.code, 0);
  assert.equal(r.out.via, 'explicit');
});

test('--session-id flag is the sole session source when env var is absent', () => {
  // Pin the flag path independently of the env-var path. parseArgs(strict:true)
  // throws "Unknown option '--session-id'" if the key is ever dropped from
  // TOKENS_COLLECT_OPTS; the env-var path would keep working silently while the
  // flag route regresses. Task 4 wires the orchestrator to pass this flag, so
  // the regression would surface in production integration, not in test.
  const { runDir, cwd, sessionId, projectDir, tsStart, tsEnd } = makeSubtreeRun();
  // Build env without CLAUDE_CODE_SESSION_ID so the flag is the only source.
  const envWithoutSession = { ...process.env };
  delete envWithoutSession.CLAUDE_CODE_SESSION_ID;
  const r = run([
    'tokens-collect', '--run-dir', runDir, '--cwd', cwd, '--project-dir', projectDir,
    '--session-id', sessionId, '--start', tsStart, '--end', tsEnd,
  ], { env: envWithoutSession });
  assert.equal(r.code, 0);
  assert.equal(r.out.ok, true);
  assert.ok(Object.keys(r.out.tokens_directional.by_model).length > 0,
    '--session-id flag path must collect subtree tokens');
});

test('tokens_observed is written before re-collection: it survives a degraded re-collect', () => {
  // What this test pins: tokens_observed reaches disk even when re-collection
  // degrades, i.e. the two writes are decoupled and a failed re-collect cannot
  // silently suppress the cost record. Passing a nonexistent --project-dir makes
  // collectAndStamp degrade (empty by_model) without throwing. The clobber guard
  // does NOT decline here — a fresh run dir has no existing sums to protect, so
  // the empty stamp lands and directional_recollected is true (verified). The
  // declined-stamp case needs existing good sums; see the test above.
  //
  // What this test does NOT pin: the write-BEFORE-re-collect ordering. Moving
  // recordObservedTokens after the re-collect block leaves all tests green
  // (verified). The ordering has no in-process observable effect on the
  // --agent-id path at all: resolveTranscripts' `if (agentId)` branch returns
  // before the `observedTotal` fingerprint branch is ever consulted, and the
  // re-collect block only runs when --agent-id is present. The ordering protects
  // a LATER, SEPARATE tokens-collect invocation on the fingerprint path against a
  // crash between the two disk writes — cross-process, so unreachable from a
  // black-box CLI test without SIGKILL instrumentation. Enforced by review.
  const { runDir } = makeSubtreeRun();
  const r = run([
    'record-observed-tokens', '--run-dir', runDir, '--total', '777', '--tier', 'HIGH',
    '--agent-id', 'some-agent', '--project-dir', '/nonexistent/path/xyz',
  ]);
  assert.equal(r.code, 0);
  // tokens_observed must be present — written before re-collection ran.
  assert.equal(r.out.tokens_observed.total, 777);
  const rec = JSON.parse(readFileSync(join(runDir, 'record.json'), 'utf8'));
  assert.equal(rec.tokens_observed.total, 777,
    'tokens_observed must be on disk even when re-collection degrades');
});
