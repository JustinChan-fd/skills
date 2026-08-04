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

test('the hook carries the last call timestamp forward, so cache_state survives a window boundary', () => {
  // A window that opens ON the invocation has no in-window predecessor. Without
  // a carried timestamp its cache_state is permanently `unknown` — and that is
  // the common shape for a skill invoked as the first act of a turn.
  const { sessionId, transcript, logDir } = setup();
  const payload = { session_id: sessionId, transcript_path: transcript, cwd: '/home/user/x', hook_event_name: 'Stop', stop_hook_active: false };
  const t0 = '2026-08-04T14:00:00.000Z';
  const t1 = '2026-08-04T14:00:12.000Z';
  const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 };
  const prev = JSON.stringify({
    type: 'assistant', uuid: 'p1', sessionId, timestamp: t0, version: '1.0.0', gitBranch: 'main',
    message: { role: 'assistant', id: 'm-prev', model: 'claude-opus-5', usage },
  });
  const skill = JSON.stringify({
    type: 'assistant', uuid: 's1', sessionId, timestamp: t1, version: '1.0.0', gitBranch: 'main',
    message: { role: 'assistant', id: 'm-skill', model: 'claude-opus-5', usage,
      content: [{ type: 'tool_use', id: 'tu-1', name: 'Skill', input: { skill: 'research-this' } }] },
  });

  // Firing 1 consumes the plain turn (no skill => no record, but the cursor and
  // the carried timestamp advance). Firing 2's window opens at the skill line.
  writeFileSync(transcript, `${prev}\n`);
  runHook(payload, logDir);
  writeFileSync(transcript, `${prev}\n${skill}\n`);
  runHook(payload, logDir);

  const files = recordFiles(logDir);
  assert.equal(files.length, 1, 'only the skill firing wrote a record');
  const record = JSON.parse(readFileSync(files[0], 'utf8'));
  assert.deepEqual(record.run.skills, ['research-this']);
  const at = record.computed.attribution;
  assert.equal(at.invocation_line, 0, 'the window opened on the invocation itself');
  assert.equal(at.idle_ms_before_invocation, 12_000, 'measured against the carried timestamp');
  assert.equal(at.cache_state, 'warm');
  assert.equal(at.marginal_comparable, true);
});

test('the tail of a flushed-late turn names the previous RECORD, across an unlogged firing', () => {
  // Root cause, measured on session 51e8fb3d 2026-08-04: this hook reads the
  // transcript BEFORE the turn's own final assistant message is flushed to it
  // (record mtime equalled the excluded line's timestamp to the second on 5 of
  // 5 records). So each window ends one API call short and that call opens the
  // NEXT window as pre-invocation tail — up to 57.6% of a record's marginal
  // tokens belonged to the previous run.
  //
  // Cursor retreat was rejected: simulated over the real firings it re-enters a
  // window and re-detects an already-recorded invocation, writing two records
  // for one run. So the tail is reported where it lands and made joinable.
  //
  // The unlogged firing in the middle is the point: last_run_id must NOT be
  // overwritten by a firing that wrote no record, or the tail would point at a
  // record that does not exist. That is a surviving mutant otherwise.
  const { sessionId, transcript, logDir } = setup();
  const payload = { session_id: sessionId, transcript_path: transcript, cwd: '/home/user/x', hook_event_name: 'Stop', stop_hook_active: false };
  const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 };
  const asst = (uuid, id, ts, content) => JSON.stringify({
    type: 'assistant', uuid, sessionId, timestamp: ts, version: '1.0.0', gitBranch: 'main',
    message: { role: 'assistant', id, model: 'claude-opus-5', usage, ...(content ? { content } : {}) },
  });
  const slash = (uuid, ts, name) => JSON.stringify({
    type: 'user', uuid, sessionId, timestamp: ts, version: '1.0.0', gitBranch: 'main',
    message: { role: 'user', content: `<command-name>${name}</command-name>` },
  });

  // Firing 1: run A. Its invoking line plus one answer call.
  const a1 = slash('a1', '2026-08-04T14:00:00.000Z', '/research-this');
  const a2 = asst('a2', 'm-a-work', '2026-08-04T14:00:05.000Z');
  writeFileSync(transcript, `${a1}\n${a2}\n`);
  runHook(payload, logDir);
  const first = recordFiles(logDir);
  assert.equal(first.length, 1, 'run A recorded');
  const runIdA = JSON.parse(readFileSync(first[0], 'utf8')).run.run_id;

  // Firing 2: a plain turn with NO skill and NO usage — writes no record, so it
  // must leave last_run_id alone.
  const filler = JSON.stringify({ type: 'system', uuid: 'f1', sessionId, timestamp: '2026-08-04T14:00:06.000Z' });
  appendFileSync(transcript, `${filler}\n`);
  runHook(payload, logDir);
  assert.equal(recordFiles(logDir).length, 1, 'the unlogged firing wrote nothing');

  // Firing 3: run A's tail flushes late and lands ahead of run B's invocation.
  const aTail = asst('a3', 'm-a-tail', '2026-08-04T14:00:07.000Z');
  const b1 = slash('b1', '2026-08-04T14:00:11.000Z', '/research-this');
  appendFileSync(transcript, `${aTail}\n${b1}\n`);
  runHook(payload, logDir);

  const files = recordFiles(logDir).sort();
  assert.equal(files.length, 2, 'run B recorded, and run A was not re-recorded');
  const b = JSON.parse(readFileSync(files[1], 'utf8')).computed.attribution;
  assert.ok(b.unattributed.api_calls > 0, "run A's tail landed in run B's window");
  assert.equal(b.unattributed_belongs_to_run_id, runIdA,
    'and it points at run A, not at the unlogged firing and not at run B');
  // The same tail is what makes B's gap measurable at all on the slash path.
  assert.equal(b.idle_ms_before_invocation, 4_000, '14:00:11 back to the 14:00:07 tail');
  assert.equal(b.cache_state, 'warm');
});

test('two records written in the same second do not overwrite each other', () => {
  // FOUND while building the flushed-late fixture above. The filename stamp is
  // second-resolution, so two firings inside one second produced ONE file — the
  // second clobbered the first — while index.jsonl appended both lines and
  // claimed two records existed. Silent data loss plus an index that lies.
  //
  // Latent in the field only because the real runs were 12s apart. The run_id
  // already carries the window (`<session>-<from>-<to>`), which is unique per
  // record by construction, so the filename carries it too.
  const { sessionId, transcript, logDir } = setup();
  const payload = { session_id: sessionId, transcript_path: transcript, cwd: '/home/user/x', hook_event_name: 'Stop', stop_hook_active: false };
  const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 };
  const slash = (uuid, ts) => JSON.stringify({
    type: 'user', uuid, sessionId, timestamp: ts,
    message: { role: 'user', content: '<command-name>/research-this</command-name>' },
  });
  const asst = (uuid, id, ts) => JSON.stringify({
    type: 'assistant', uuid, sessionId, timestamp: ts,
    message: { role: 'assistant', id, model: 'claude-opus-5', usage },
  });

  writeFileSync(transcript, `${slash('a1', '2026-08-04T14:00:00.000Z')}\n${asst('a2', 'm-a', '2026-08-04T14:00:05.000Z')}\n`);
  runHook(payload, logDir);
  appendFileSync(transcript, `${slash('b1', '2026-08-04T14:00:11.000Z')}\n${asst('b2', 'm-b', '2026-08-04T14:00:16.000Z')}\n`);
  runHook(payload, logDir);

  const files = recordFiles(logDir);
  const indexLines = readFileSync(join(logDir, 'index.jsonl'), 'utf8').trim().split('\n');
  assert.equal(indexLines.length, 2, 'two records were indexed');
  assert.equal(files.length, 2, 'and two record files exist — the index does not lie');
  // Every indexed file must be openable, which is the property that actually broke.
  for (const line of indexLines) {
    const rel = JSON.parse(line).file;
    const found = files.find((f) => f.endsWith(rel.split('/').pop()));
    assert.ok(found, `indexed record ${rel} is on disk`);
  }
  const runIds = files.map((f) => JSON.parse(readFileSync(f, 'utf8')).run.run_id);
  assert.equal(new Set(runIds).size, 2, 'and they are distinct runs');
});

// The index line is the MACHINE surface: `index.jsonl` is what a dashboard
// loads, and every field missing from it forces a reader to open every record
// on disk to answer a question. Four questions could not be answered from the
// index at all — which repo, which invocation shape, which branch/version, and
// whether a run's marginal cost is even comparable — and that last one is the
// whole point of the attribution work: a KPI computed over the index was
// silently averaging cold runs in with warm ones at 8x the marginal cost.
test('the index line answers repo, shape, environment, and comparability without opening a record', () => {
  const { sessionId, transcript, logDir } = setup();
  const payload = { session_id: sessionId, transcript_path: transcript, cwd: '/home/user/my-repo', hook_event_name: 'Stop', stop_hook_active: false };
  runHook(payload, logDir);

  const summary = JSON.parse(readFileSync(join(logDir, 'index.jsonl'), 'utf8').trim());

  // Cross-repo grouping: cwd is the raw truth, repo is its basename so a
  // group-by does not need to parse paths in every consumer.
  assert.equal(summary.cwd, '/home/user/my-repo');
  assert.equal(summary.repo, 'my-repo');

  // The shape distinction that hid a defect for 93 tests: a slash line carries
  // no usage of its own, a Skill tool_use is emitted BY an API call. A reader
  // filtering on skills alone cannot tell the two paths apart.
  assert.deepEqual(summary.invocation_kinds.sort(), ['skill_tool', 'slash_command']);

  // Which code was running, for regressions across versions/branches.
  assert.equal(summary.claude_code_version, '2.1.221');
  assert.equal(summary.git_branch, 'main');

  // Comparability, the field a cost KPI must filter on before averaging.
  assert.equal(summary.cache_state, 'cold', "session's first call");
  assert.equal(summary.marginal_comparable, false);

  // Every index field must be a scalar or a flat array of scalars — an index
  // line holding a nested object invites readers to depend on record shape.
  for (const [k, v] of Object.entries(summary)) {
    const flat = v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => typeof x !== 'object'));
    assert.ok(flat, `index field ${k} is a scalar or flat array`);
  }
});

test('index fields that have no answer are null, never absent', () => {
  // A missing key and a null are the same thing to `jq`, but not to a reader
  // building a table: absent columns silently shrink the schema, and a
  // dashboard that group-bys an absent field drops those rows instead of
  // bucketing them. The fixture carries no entrypoint-less lines, so this
  // drives the case where the payload itself is thin.
  const { sessionId, transcript, logDir } = setup();
  runHook({ session_id: sessionId, transcript_path: transcript, hook_event_name: 'Stop' }, logDir);
  const summary = JSON.parse(readFileSync(join(logDir, 'index.jsonl'), 'utf8').trim());
  for (const k of ['cwd', 'repo', 'git_branch', 'claude_code_version', 'cache_state', 'marginal_comparable', 'invocation_kinds']) {
    assert.ok(k in summary, `${k} is present even with nothing to report`);
  }
  assert.equal(summary.cwd, null, 'no cwd in the payload');
  assert.equal(summary.repo, null, 'and so no repo to derive');
});
