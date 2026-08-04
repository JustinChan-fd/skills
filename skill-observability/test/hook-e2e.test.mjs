// End-to-end: run the real hook binary against a fixture transcript laid out
// exactly like ~/.claude/projects/<slug>/<session>.jsonl (+ subagents dir),
// feed it a Stop payload on stdin, and assert on the written record, index
// line, and cursor behavior across repeated firings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGGER = join(HERE, '..', 'hooks', 'skill-run-logger.mjs');
const FIXTURE = join(HERE, 'fixtures', 'session.jsonl');

function runHook(payload, logDir) {
  execFileSync(process.execPath, [LOGGER], {
    input: JSON.stringify(payload),
    env: { ...process.env, SKILL_OBS_DIR: logDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'skill-obs-'));
  const projectDir = join(root, 'projects', '-home-user-x');
  const sessionId = 'e2e-session-0001';
  const transcript = join(projectDir, `${sessionId}.jsonl`);
  mkdirSync(projectDir, { recursive: true });
  copyFileSync(FIXTURE, transcript);
  // one subagent transcript + meta
  const subDir = join(projectDir, sessionId, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(
    join(subDir, 'agent-abc.jsonl'),
    JSON.stringify({
      type: 'assistant', uuid: 'sa1', sessionId, timestamp: '2026-08-04T10:00:30.000Z', isSidechain: true,
      message: { role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 40, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + '\n',
  );
  writeFileSync(join(subDir, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'probe', spawnDepth: 1, toolUseId: 'toolu_task' }));
  const logDir = join(root, 'logs');
  return { root, projectDir, sessionId, transcript, logDir };
}

function recordFiles(logDir) {
  const out = [];
  let days = [];
  try {
    days = readdirSync(logDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch {
    return out;
  }
  for (const d of days) for (const f of readdirSync(join(logDir, d))) out.push(join(logDir, d, f));
  return out;
}

test('e2e: Stop firing writes a record with raw + computed, then a second firing is a no-op', () => {
  const { sessionId, transcript, logDir } = setup();
  const payload = { session_id: sessionId, transcript_path: transcript, cwd: '/home/user/x', hook_event_name: 'Stop', stop_hook_active: false };

  runHook(payload, logDir);

  const files = recordFiles(logDir);
  assert.equal(files.length, 1, 'exactly one record written');
  const record = JSON.parse(readFileSync(files[0], 'utf8'));

  assert.equal(record.schema_version, '1');
  assert.deepEqual(record.run.skills.sort(), ['/gh-issue-create', 'gh-issue-create']);
  assert.equal(record.raw.hook_payload.hook_event_name, 'Stop');
  // raw session usage verbatim
  assert.equal(record.raw.usage_entries.length, 2);
  assert.equal(record.raw.usage_entries[0].usage.cache_creation.ephemeral_1h_input_tokens, 1500);
  // subagent captured with meta
  assert.equal(record.raw.subagents.length, 1);
  assert.equal(record.raw.subagents[0].meta.agentType, 'Explore');
  // join table: agent first seen in this logged window => owned by this run
  assert.ok(record.run.run_id, 'record has a run_id');
  assert.equal(record.computed.subagent_runs.length, 1);
  assert.equal(record.computed.subagent_runs[0].spawned_by_run_id, record.run.run_id);
  assert.equal(record.computed.subagent_runs[0].spawned_this_run, true);
  assert.equal(record.computed.subagent_runs[0].tool_use_id, 'toolu_task');
  assert.equal(record.computed.subagent_runs[0].tokens_grand_total, 100);
  // raw stays pure: no derived join key inside raw.subagents
  assert.equal(record.raw.subagents[0].spawned_by_run_id, undefined);
  // computed totals include subagent tokens
  assert.equal(record.computed.counts.subagent_tokens_grand_total, 100);
  assert.ok(record.computed.tokens.by_model['claude-fable-5']);
  assert.ok(record.computed.tokens.by_model['claude-haiku-4-5']);
  assert.equal(record.computed.cost.complete, true);
  assert.ok(record.computed.cost.total_usd > 0);
  // boundary = last session line: 5 + 150 + 52000 + 100
  assert.equal(record.computed.tokens.boundary_total, 52255);

  // index.jsonl has one computed-only summary line
  const index = readFileSync(join(logDir, 'index.jsonl'), 'utf8').trim().split('\n');
  assert.equal(index.length, 1);
  assert.equal(JSON.parse(index[0]).session_id, sessionId);

  // second firing with no new transcript lines: cursor prevents double-count
  runHook(payload, logDir);
  assert.equal(recordFiles(logDir).length, 1, 'no duplicate record');
});

test('e2e: a later turn without a skill writes nothing but advances the cursor', () => {
  const { sessionId, transcript, logDir, projectDir } = setup();
  const payload = { session_id: sessionId, transcript_path: transcript, cwd: '/x', hook_event_name: 'Stop' };
  runHook(payload, logDir);
  assert.equal(recordFiles(logDir).length, 1);
  const firstRunId = JSON.parse(readFileSync(recordFiles(logDir)[0], 'utf8')).run.run_id;

  // Append a plain (non-skill) turn, fire again — no new record.
  appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: 'u9', timestamp: '2026-08-04T10:05:00Z', message: { role: 'user', content: 'thanks' } }) + '\n');
  appendFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: 'a9', timestamp: '2026-08-04T10:05:05Z', message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'np' }], usage: { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } }) + '\n');
  runHook(payload, logDir);
  assert.equal(recordFiles(logDir).length, 1, 'non-skill turn not logged by default');

  // The long-lived subagent from run 1 keeps working in the background...
  appendFileSync(
    join(projectDir, sessionId, 'subagents', 'agent-abc.jsonl'),
    JSON.stringify({
      type: 'assistant', uuid: 'sa2', sessionId, timestamp: '2026-08-04T10:05:50.000Z', isSidechain: true,
      message: { role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 7, output_tokens: 13, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + '\n',
  );

  // Then a slash-command turn — a second record appears, windowed to the new lines only.
  appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: 'u10', timestamp: '2026-08-04T10:06:00Z', message: { role: 'user', content: '<command-name>/simplify</command-name>' } }) + '\n');
  appendFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: 'a10', timestamp: '2026-08-04T10:06:30Z', message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } } }) + '\n');
  runHook(payload, logDir);
  const files = recordFiles(logDir);
  assert.equal(files.length, 2);
  const second = JSON.parse(readFileSync(files.sort()[1], 'utf8'));
  assert.deepEqual(second.run.skills, ['/simplify']);
  assert.equal(second.raw.usage_entries.length, 1, 'window contains only the new turn');
  assert.equal(second.computed.tokens.by_model['claude-fable-5'].output, 9);
  // THE JOIN: the agent's later spend lands in record 2, but joins back to
  // the run that spawned it — record 1's run_id, not record 2's.
  assert.equal(second.computed.subagent_runs.length, 1);
  assert.equal(second.computed.subagent_runs[0].spawned_by_run_id, firstRunId);
  assert.equal(second.computed.subagent_runs[0].spawned_this_run, false);
  assert.equal(second.computed.subagent_runs[0].tokens_grand_total, 20, 'delta only: 7+13');
  assert.notEqual(second.run.run_id, firstRunId);
});

test('e2e: malformed stdin and missing transcript never produce a non-zero exit', () => {
  const { logDir } = setup();
  // malformed json on stdin
  execFileSync(process.execPath, [LOGGER], { input: '{{{nope', env: { ...process.env, SKILL_OBS_DIR: logDir } });
  // missing transcript
  runHook({ session_id: 's', transcript_path: '/nonexistent/t.jsonl', hook_event_name: 'SessionEnd' }, logDir);
  // both are best-effort: reaching here without throwing IS the assertion
  assert.ok(true);
});
