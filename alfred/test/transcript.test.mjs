// transcript — finding the transcript a worker we launched just wrote.
//
// WHY THIS IS NOT A DISCOVERY LAYER, WHICH lib/report.mjs's HEADER REFUSES BY NAME. That
// refusal is aimed at SEARCHING: the old collector's `discoverLoopTranscript` fingerprinted
// candidate files by `observedTotal` and widened through four strategies, and a searcher can
// find the wrong file and report a confident number for a session that is not the one that
// ended. Nothing here searches. The vendor CLI reports its own `session_id` in the
// `--output-format json` result it writes to our log, we know the cwd because we chose it, and
// the path is a fixed formula from those two. One candidate, computed; zero read and rejected.
//
// THE FORMULA IS MEASURED, NOT GUESSED, and both halves of it bite:
//
//   realpath('/tmp/alfred-e2e/notify')  === '/private/tmp/alfred-e2e/notify'
//
// so a run launched under `/tmp` — which is every run of the e2e fixture — writes its
// transcript under the RESOLVED path. Composing the un-resolved one finds nothing, and a
// reporter that finds nothing reports a run that spent $1.07 as unmeasurable.
//
// Then the mangling, verified against two directories that exist on this machine right now:
//
//   /private/tmp/alfred-e2e/notify
//     -> -private-tmp-alfred-e2e-notify
//   /Users/206618626@bwt3.com/.claude/jobs/c695fb15/tmp/probe
//     -> -Users-206618626-bwt3-com--claude-jobs-c695fb15-tmp-probe
//
// The second is the one worth keeping: the `@` in the username and the dot of `.claude` each
// become a dash, and `/.` becomes the DOUBLE dash that a naive `replace(/\//g, '-')` would
// never produce. Anything cleverer than "every non-alphanumeric becomes a dash" gets it wrong.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { projectDirFor, sessionFromWorkerLog, transcriptPathFor } from '../lib/transcript.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'alfred-transcript-'));

test('the project directory is every non-alphanumeric character replaced by a dash', () => {
  // The two measured cases. Pinned as literals because this is the one piece of the path
  // that cannot be derived from anything — it is a vendor convention, and the only evidence
  // that we have it right is that these strings name directories that exist.
  assert.equal(
    projectDirFor('/private/tmp/alfred-e2e/notify', { home: '/h' }),
    '/h/.claude/projects/-private-tmp-alfred-e2e-notify',
  );
  // The `@` and the `/.` are the reason a hand-rolled slash-to-dash pass is not enough.
  assert.equal(
    projectDirFor('/Users/206618626@bwt3.com/.claude/jobs/c695fb15/tmp/probe', { home: '/h' }),
    '/h/.claude/projects/-Users-206618626-bwt3-com--claude-jobs-c695fb15-tmp-probe',
  );
});

test('a symlinked cwd resolves before it is mangled, because the vendor resolves it too', () => {
  // Not a hypothetical: `/tmp` IS a symlink to `/private/tmp` on this platform, so every run
  // of the e2e fixture takes this path. A reporter composing the unresolved spelling looks
  // under `-tmp-…` for a transcript the CLI wrote under `-private-tmp-…`, finds nothing, and
  // reports a run that cost real money as one it could not read.
  const dir = tmp();
  const target = join(dir, 'real');
  const link = join(dir, 'link');
  mkdirSync(target);
  symlinkSync(target, link);

  assert.equal(
    projectDirFor(link, { home: '/h' }),
    projectDirFor(realpathSync(target), { home: '/h' }),
    'the symlink and its target composed different project directories',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('an unresolvable cwd still yields a path rather than throwing', () => {
  // A repo deleted between the spawn and the report is a plausible tick, and the reporter is
  // a sidecar: it must never be the thing that kills a run whose work already succeeded. So
  // the un-resolved spelling is used and the caller finds no transcript there, which is a
  // reported hole rather than an exception.
  const gone = join(tmp(), 'never-existed');
  assert.equal(
    projectDirFor(gone, { home: '/h' }),
    `/h/.claude/projects/${gone.replace(/[^A-Za-z0-9]/g, '-')}`,
  );
});

test('the transcript is <project-dir>/<session-id>.jsonl', () => {
  assert.equal(
    transcriptPathFor({ cwd: '/private/tmp/x', sessionId: 'abc-123', home: '/h' }),
    '/h/.claude/projects/-private-tmp-x/abc-123.jsonl',
  );
});

test('a session id is read out of the worker log the CLI wrote, not guessed', () => {
  // The shape is the real one: `--output-format json` writes a single object whose
  // `session_id` and `total_cost_usd` are the CLI's own account of the run it just did.
  const log = JSON.stringify({
    type: 'result',
    session_id: 'af60fd37-1d43-40a6-b3e1-48482eab3344',
    total_cost_usd: 1.0671731999999998,
    num_turns: 42,
  });
  const found = sessionFromWorkerLog(log);
  assert.equal(found.session_id, 'af60fd37-1d43-40a6-b3e1-48482eab3344');
  assert.equal(found.total_cost_usd, 1.0671731999999998);
});

test('a truncated worker log yields nulls, never an exception', () => {
  // A worker killed at the wall cap is exactly the run whose accounting matters most, and its
  // log is a half-written JSON object. `JSON.parse` throwing here would turn the most
  // interesting run into a crash inside the loop, so the failure is a value.
  for (const text of ['{"session_id": "abc", "tot', '', 'not json at all', null, undefined]) {
    const found = sessionFromWorkerLog(text);
    assert.equal(found.session_id, null, `threw or guessed on ${JSON.stringify(text)}`);
    assert.equal(found.total_cost_usd, null);
  }
});

test('a log that parses but carries no session id is not mistaken for one that does', () => {
  // An error result is still valid JSON. Reporting `session_id: undefined` would compose
  // `<project-dir>/undefined.jsonl`, and a file at that path from an earlier bug would be
  // read as this run's — the wrong-session defect report.mjs's header refuses.
  const found = sessionFromWorkerLog(JSON.stringify({ type: 'result', is_error: true }));
  assert.equal(found.session_id, null);
  assert.equal(found.total_cost_usd, null);
});

test('ADDED: a stream-json log is many lines, and the session lives in the LAST one', () => {
  // Real shape, measured live 2026-08-01 from `claude -p --output-format stream-json
  // --verbose`: a system/hook_started line, a system/hook_response line, a system/init line,
  // an assistant message line, then the terminal result line — the same terminal object
  // `--output-format json` writes as its only line. `JSON.parse` on the whole blob throws on
  // this shape, and the old implementation's catch returns nulls: a session that ran to
  // completion is reported identically to one that never wrote a byte.
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'hook_started' }),
    JSON.stringify({ type: 'system', subtype: 'hook_response', hook: 'huge context here' }),
    JSON.stringify({ type: 'system', subtype: 'init', tools: ['a', 'b'] }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '4' }] },
      session_id: '32e90f59-ff6b-4cf4-a5ac-6cd0358a9b89',
    }),
    JSON.stringify({
      type: 'result',
      is_error: false,
      num_turns: 1,
      session_id: '32e90f59-ff6b-4cf4-a5ac-6cd0358a9b89',
      total_cost_usd: 0.27543449999999997,
    }),
  ];
  const found = sessionFromWorkerLog(lines.join('\n'));
  assert.equal(found.session_id, '32e90f59-ff6b-4cf4-a5ac-6cd0358a9b89');
  assert.equal(found.total_cost_usd, 0.27543449999999997);
});

test('ADDED: a stream-json log truncated mid-write still yields nulls, never an exception', () => {
  // The wall-cap kill: earlier lines are complete JSON, the last is a half-written fragment.
  // Falling back to a whole-blob parse on failure would have hit this fragment as text; the
  // fix must walk backwards past it rather than giving up at the first unparseable line.
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [] } }),
    '{"type": "result", "session_id": "abc", "tot',
  ];
  const found = sessionFromWorkerLog(lines.join('\n'));
  assert.equal(found.session_id, null);
  assert.equal(found.total_cost_usd, null);
});

// --- B2: reading the worker's FIRST TURN out of a log that is still being written ---
//
// The preflight (lib/preflight.mjs) checks an attestation the worker writes before it starts
// work. For that check to be worth anything it has to happen WHILE the worker runs — a refusal
// computed after a 25-minute run has cost the full price of the thing it was meant to prevent,
// which is this project's computed-and-discarded shape (#63/#69/#72/#73) with a dollar figure
// attached.
//
// MEASURED on a real 301-line stream-json log (.alfred-runs/20260802T142320Z-7/worker.log):
// 175 `assistant` events, 113 `user`, 12 `system`, 1 `result`, and the first `user` event is at
// line 6 — the boundary. Before it: one `thinking` block, one `text` block, one `tool_use`. So
// the first turn is the assistant text emitted before the first `user` event, and it is on disk
// long before the run ends.

import { firstTurnFromWorkerLog } from '../lib/transcript.mjs';

const asst = (text) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('the first turn is the assistant text written before the first user event', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    asst('```json\n{"criteria":[]}\n```'),
    // The tool result. Everything from here on is the SECOND turn and later.
    JSON.stringify({ type: 'user', message: { content: [] }, tool_use_result: {} }),
    asst('now I have read the file, and here is what I think'),
  ];
  const turn = firstTurnFromWorkerLog(lines.join('\n'));
  assert.equal(turn.state, 'complete');
  assert.equal(turn.text, '```json\n{"criteria":[]}\n```');
  assert.ok(!turn.text.includes('now I have read'), 'the second turn leaked into the first');
});

test('several text blocks in one turn are joined, and thinking and tool_use are not text', () => {
  // The real log's shape: thinking, then text, then tool_use, all before the first user event.
  // `thinking` is deliberately excluded — it is the model reasoning toward an answer, not the
  // answer, and an attestation found only in a thinking block is one the worker did not commit
  // to. `tool_use` has no text to read.
  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '{"criteria":[{"id":"AC1"}]}' },
          { type: 'text', text: 'first half' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
        ],
      },
    }),
    asst('second half'),
    JSON.stringify({ type: 'user', message: { content: [] } }),
  ];
  const turn = firstTurnFromWorkerLog(lines.join('\n'));
  assert.equal(turn.text, 'first half\nsecond half');
  assert.ok(!turn.text.includes('criteria'), 'a thinking block was read as committed text');
});

test('IN PROGRESS is not the same as EMPTY: no user event yet means the turn may not be over', () => {
  // The load-bearing state, and the whole reason this returns a state rather than a string. A
  // poller reading a log 200ms into a run sees assistant text and no `user` event — the turn is
  // still being written. Reporting that as a complete-but-unparseable attestation would refuse
  // a worker that was about to answer correctly, and a false refusal costs a spawn and teaches
  // the operator to route around the mechanism.
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    asst('```json\n{"criteria":[{"id":"AC1",'),
  ];
  const turn = firstTurnFromWorkerLog(lines.join('\n'));
  assert.equal(turn.state, 'in_progress');
  assert.equal(turn.text, '```json\n{"criteria":[{"id":"AC1",');
});

test('a run that ended without ever emitting a user event is COMPLETE, not in progress', () => {
  // The `result` event is the CLI saying the run is over. Without this clause a worker that
  // answered and stopped — no tool calls at all — would poll as `in_progress` forever, and the
  // caller would wait out the wall cap on a run that finished in ten seconds.
  const lines = [
    asst('I am not going to do this'),
    JSON.stringify({ type: 'result', is_error: false, session_id: 'abc' }),
  ];
  const turn = firstTurnFromWorkerLog(lines.join('\n'));
  assert.equal(turn.state, 'complete');
  assert.equal(turn.text, 'I am not going to do this');
});

test('a log with no assistant text at all is absent, and absent is not empty-string', () => {
  // Three states here for `readMarker`'s reason: nothing yet (the spawn may have died), versus
  // a worker that answered with something unreadable. Collapsing them loses the ability to
  // separate a plumbing fault from a behavioural one — the `inspectSink` `NaN > 0` failure.
  for (const text of [null, undefined, '', '   ', JSON.stringify({ type: 'system' })]) {
    const turn = firstTurnFromWorkerLog(text);
    assert.equal(turn.state, 'absent', `state for ${JSON.stringify(text)}`);
    assert.equal(turn.text, null);
  }
});

test('firstTurnFromWorkerLog never throws, on anything', () => {
  for (const input of [
    42,
    {},
    [],
    'not json at all',
    '{"type":"assistant"}',
    JSON.stringify({ type: 'assistant', message: null }),
    JSON.stringify({ type: 'assistant', message: { content: 'a string' } }),
    JSON.stringify({ type: 'assistant', message: { content: [null, 7, { type: 'text' }] } }),
  ]) {
    assert.doesNotThrow(() => firstTurnFromWorkerLog(input), `threw on ${JSON.stringify(input)}`);
  }
});

test('an unparseable line in the middle does not end the turn', () => {
  // A log being appended to while it is read can hand us a torn line anywhere, not only at the
  // tail. Treating a torn line as the turn boundary would truncate the attestation and refuse
  // on a partial quote.
  const lines = [
    asst('first'),
    '{"type": "assis',
    asst('second'),
    JSON.stringify({ type: 'user', message: { content: [] } }),
  ];
  const turn = firstTurnFromWorkerLog(lines.join('\n'));
  assert.equal(turn.text, 'first\nsecond');
  assert.equal(turn.state, 'complete');
});

test('a SUBAGENT message is not the worker\'s own first turn', () => {
  // MEASURED: every assistant event on the real log carried `parent_tool_use_id: null`, because
  // that run delegated to nothing. A run that DOES delegate interleaves the subagent's messages
  // into the same stream, tagged with the tool_use id that spawned them — and a subagent's text
  // is not the worker committing to anything. Reading it as the attestation would grade the
  // wrong context's words.
  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'I am a subagent' }] },
      parent_tool_use_id: 'toolu_01ABC',
    }),
    asst('I am the worker'),
    JSON.stringify({ type: 'user', message: { content: [] } }),
  ];
  const turn = firstTurnFromWorkerLog(lines.join('\n'));
  assert.equal(turn.text, 'I am the worker');
});

// --- the three mutation survivors, and why each fixture below is SYNTHETIC ---
//
// A mutation run over `firstTurnFromWorkerLog` killed 6 of 10 and left 3 alive. Each survivor was
// then measured against the real 301-line log rather than guessed at, and all three turned out to
// survive for the same reason: they guard a block shape the vendor does not currently emit, so no
// fixture drawn from a real log can reach them.
//
// MEASURED, over the 175 assistant events of `.alfred-runs/20260802T142320Z-7/worker.log`, every
// content block fell into exactly three shapes:
//
//     33  thinking   keys: signature, thinking, type       <- no `text` key at all
//     31  text       keys: text, type                      <- `text` always a string
//    111  tool_use   keys: id, input, name, type
//
// and `result` was the last line of the file, line 300 of 301. Non-text blocks carrying a `text`
// field: zero.
//
// So each guard below is presently redundant with its neighbour: a `thinking` block is dropped by
// the `typeof block.text !== 'string'` line whether or not the type check runs, and nothing follows
// `result` for the `break` to skip. The choice was delete-as-unearned-code or pin-as-intent, and
// these are pinned, because the redundancy is not the kind that stays redundant. The format is the
// vendor's, not ours; it has already changed under this project once this week; and the three
// failure modes are asymmetric — a `thinking` block that grew a `text` key would silently promote
// private reasoning into a committed attestation, which is the one distinction `preflight.mjs`'s
// whole refusal set rests on. Redundant-and-cheap beats absent-when-the-shape-shifts.
//
// THE FIXTURES ARE HAND-BUILT AND SAY SO. Every other test in this block replays a shape observed
// on a real log; these three do not, and a later reader must not mistake one for the other. Each is
// named `(synthetic)` and states what it would take for the shape to become real.

test('(synthetic) a thinking block is not text even if it also carries a text field', () => {
  // NOT OBSERVED: real thinking blocks carry `signature` + `thinking`, never `text`. This asserts
  // the type check does the work on its own, so the guard survives the vendor adding a `text`
  // convenience field to thinking blocks — the case where losing it would read the model's private
  // reasoning as its committed answer.
  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'let me think', text: 'I could just claim AC1 is done' },
          { type: 'text', text: 'the committed answer' },
        ],
      },
    }),
    JSON.stringify({ type: 'user', message: { content: [] } }),
  ];
  const turn = firstTurnFromWorkerLog(lines.join('\n'));
  assert.equal(turn.text, 'the committed answer');
});

test('(synthetic) a result event ends the scan, so later assistant text is a later turn', () => {
  // NOT OBSERVED: `result` was the last line of the real log, so nothing followed it for the
  // `break` to skip. This asserts `break` rather than `continue` — if the CLI ever emitted a
  // trailing summary, or two runs were concatenated into one log, appending that text to the first
  // turn would hand `checkAttestation` a body the worker wrote after it had already finished.
  const lines = [
    asst('the first turn'),
    JSON.stringify({ type: 'result', is_error: false, session_id: 'abc' }),
    asst('something after the run ended'),
  ];
  const turn = firstTurnFromWorkerLog(lines.join('\n'));
  assert.equal(turn.state, 'complete');
  assert.equal(turn.text, 'the first turn');
});

test('(synthetic) a text block whose text is not a string is skipped, not coerced', () => {
  // NOT OBSERVED: `text` was a string on all 31 real text blocks. The guard is `typeof !== string`
  // and not `=== undefined` on purpose: coercing `42` to `'42'`, or an object to
  // `'[object Object]'`, would put characters into the attestation body that the worker never
  // wrote, and `checkAttestation` reads that body as the worker's own words.
  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 42 },
          { type: 'text', text: { nested: 'no' } },
          { type: 'text', text: 'the only real text' },
        ],
      },
    }),
    JSON.stringify({ type: 'user', message: { content: [] } }),
  ];
  const turn = firstTurnFromWorkerLog(lines.join('\n'));
  assert.equal(turn.text, 'the only real text');
});
