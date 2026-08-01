// report — the accounting record. Joins a parent transcript to its subagents and
// prices the result, as a pure function with the I/O at the edges.
//
// WHERE THESE TEST NAMES COME FROM. The 11 names below plus the arm 0 anchor are
// lifted VERBATIM from PLAN.md §3/M2, frozen 2026-07-29. THE NAMES ARE THE ARM C
// CONTROL — frozen in git before sandbox-b exists, so they cannot have been
// reshaped after seeing a new trap. Anything further carries an `ADDED:` prefix
// and names the measurement that motivated it.
//
// WHAT M2 IS FOR. §2.5: a pure function
// `(transcriptPath, subagentsDir, config, expected) -> record`. No I/O in the
// core; the two entry points (the Stop hook and the backfill script) do the I/O.
// The Stop hook payload carries `transcript_path`, `session_id`, and `cwd`
// directly, which is why the entire discovery layer of the old collector
// (`subagentsDirForSession`, `discoverLoopTranscript`, `discoverSubagentForRun`
// with `observedTotal` fingerprinting and four-strategy `via` widening) is not
// ported: it existed only because nothing told it which transcript was the run's.
//
// THE FIXTURES ARE REAL, REDUCED. Both were privacy-reduced from real transcripts
// on this machine, not hand-authored, because hand-authoring is exactly what let
// the message.id split-block defect ship green past 470 upstream tests. The
// reducer keeps `type`, `timestamp`, and `message.{role,model,id,usage}` and
// replaces every content field with the string `SENSITIVE_TRANSCRIPT_TEXT`. The
// arm 0 transcript went 316KB -> 44KB and reproduces all four of its numbers
// unchanged, which is the proof that the parser reads no content.
//
//   fixtures/arm0-transcript.jsonl              131 lines, the $1.12 anchor
//   fixtures/session-with-subagents/            999-line parent + 4 subagents
//
// FOUR SHAPES THE SUBAGENT FIXTURE CARRIES, all found in the real data rather
// than invented: a plain sonnet subagent; one on a DIFFERENT model (opus-4-6)
// than its siblings, so a per-model split has something to split; one whose
// model is `<synthetic>` with all-zero usage, which is what an API-error 529
// entry records; and one with many distinct message.ids, so dedupe is exercised
// through the subagent path and not only the parent path. The three `<synthetic>`
// failures in the source session are the reason a subagent that cost nothing
// measurable must still appear in the record — it happened, and a record that
// omits it under-reports the spawn count.
//
// TWO DELIBERATE DEVIATIONS FROM §2.5's SCHEMA SKETCH, both to be recorded in
// PLAN.md, because the sketch predates the modules it now has to compose with:
//
//   1. `cost.by_model[id]` is `{usd, unpriced}`, not a bare number. §2.5 sketched
//      `{<id>: usd}`, written before M0 existed. A bare number cannot express
//      `usd: null, unpriced: true` — the entire never-zero-fill rule — so the
//      record carries `priceTokens`' own shape rather than flattening it and then
//      re-inventing a way to say "unknown".
//   2. `tokens.lines` is the record's name for the collector's `lines_parsed`.
//      The schema field name is frozen; the collector's is not renamed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildRecord, recordFromHookPayload } from '../lib/report.mjs';
import { suiteStamp, loadSuiteConfig, computeSuiteDigest } from '../lib/suite.mjs';

// A stamp's `at` is the record's own timestamp, never `now()` — the rule `priceTokens`
// follows, for the same reason: a function that reads the wall clock re-prices the same
// historical record differently tomorrow.
const AT = '2026-07-30T18:00:00.000Z';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const ARM0 = fixture('arm0-transcript.jsonl');
const SESSION = fixture('session-with-subagents');
const SESSION_TRANSCRIPT = join(SESSION, 'transcript.jsonl');
const SESSION_SUBAGENTS = join(SESSION, 'subagents');

// The four real toolUseIds in the subagent fixture, each joining a subagent back to
// the exact parent tool call that spawned it. Verified present in the real parent
// transcript (5 occurrences each) before the fixture was reduced.
const TOOL_USE_IDS = [
  'toolu_bdrk_01H1UwmPDqJFAzRMgNjoXdKH',
  'toolu_bdrk_01R5j3Fc6STKqBqL5RqQZRSt',
  'toolu_bdrk_01W99MkpApc1AsKBb9zHNpo3',
  'toolu_bdrk_012YkK7ixiAGWAP5dovSGnpu',
];

const PARENT_MODEL = 'claude-sonnet-4-5-20250929';
const SUB_ONLY_MODEL = 'claude-opus-4-6';

const tmp = () => mkdtempSync(join(tmpdir(), 'alfred-report-'));
const DIRECTIONS = ['input', 'output', 'cache_read', 'cache_creation'];
const sumByModel = (byModel) =>
  Object.values(byModel ?? {}).reduce(
    (a, v) => a + DIRECTIONS.reduce((b, k) => b + v[k], 0),
    0,
  );

const realSession = () =>
  buildRecord({
    transcriptPath: SESSION_TRANSCRIPT,
    subagentsDir: SESSION_SUBAGENTS,
    session: { id: 'sess-real' },
  });

// --- the 11 frozen names -----------------------------------------------------

test('the Stop hook payload alone locates the transcript — no filesystem discovery', () => {
  // The proposition: given the payload, the reporter reads the transcript it was
  // TOLD about and does not search. Proven by pointing the payload at a transcript
  // in a directory that also holds a DECOY with different numbers. A discovery layer
  // would be free to find the decoy; being told cannot.
  const dir = tmp();
  const real = join(dir, 'real.jsonl');
  const decoy = join(dir, 'decoy.jsonl');
  const line = (id, input) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-27T00:00:00.000Z',
      message: { model: 'claude-sonnet-5', id, usage: { input_tokens: input, output_tokens: 0 } },
    }) + '\n';
  writeFileSync(real, line('msg_real', 111));
  writeFileSync(decoy, line('msg_decoy', 999999));

  const record = recordFromHookPayload({
    session_id: 'sess-hook',
    transcript_path: real,
    cwd: dir,
  });

  assert.equal(record.tokens.by_model['claude-sonnet-5'].input, 111);
  assert.equal(record.session.id, 'sess-hook');
  assert.equal(record.session.cwd, dir);
  rmSync(dir, { recursive: true, force: true });
});

test('subagent files are read from <session>/subagents/ and attributed by toolUseId', () => {
  const record = realSession();
  assert.equal(record.subagents.length, 4);
  assert.deepEqual(record.subagents.map((s) => s.toolUseId).sort(), [...TOOL_USE_IDS].sort());
  // agent_id comes from the filename, so the join is traceable in both directions.
  for (const s of record.subagents) assert.match(s.agent_id, /^agent-a[0-9a-f]+$/);
  // Attribution is per-subagent, not a pooled figure: the four real totals.
  assert.deepEqual(
    record.subagents.map((s) => sumByModel(s.by_model)).sort((a, b) => a - b),
    [0, 140898, 347430, 594754],
  );
});

test('spawnDepth is preserved so nested delegation stays attributable', () => {
  const record = realSession();
  // Assert the value, not just the type — a hardcoded 1 would satisfy a typeof check.
  assert.deepEqual([...new Set(record.subagents.map((s) => s.spawnDepth))], [1]);

  // And a depth-3 meta must survive, which is what makes this about nesting rather
  // than about the number 1 that this fixture happens to carry.
  const dir = tmp();
  const sub = join(dir, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, 'agent-adeep.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-27T00:00:00.000Z',
      message: { model: 'claude-sonnet-5', id: 'm1', usage: { input_tokens: 5 } },
    }) + '\n',
  );
  writeFileSync(
    join(sub, 'agent-adeep.meta.json'),
    JSON.stringify({
      agentType: 'general-purpose',
      description: 'a nested dig',
      toolUseId: 'toolu_nested',
      spawnDepth: 3,
    }),
  );
  const nested = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: sub,
    session: { id: 'sess-nested' },
  });
  assert.equal(nested.subagents[0].spawnDepth, 3);
  rmSync(dir, { recursive: true, force: true });
});

test('a session that spawned nothing yields subagents: [] and still reports totals', () => {
  const record = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: null,
    session: { id: 'sess-arm0' },
  });
  assert.deepEqual(record.subagents, []);
  // The totals must survive. A record that drops them when nothing spawned would
  // silently zero every hand-run session, which is the majority case.
  assert.equal(record.tokens.by_model['claude-sonnet-4-6'].cache_read, 2110234);
  assert.ok(record.cost.total_usd > 0);
});

test('a missing subagents dir is not an error — it is zero subagents', () => {
  const record = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: join(tmpdir(), 'alfred-does-not-exist-' + process.pid),
    session: { id: 'sess-arm0' },
  });
  assert.equal(record.ok, true);
  assert.deepEqual(record.subagents, []);
  // Absent is not the same as unreadable. Absent means nothing spawned, so it records
  // NO gap — otherwise every single-context run carries a permanent hole and the gaps
  // list stops distinguishing anything. The unreadable case is the ADDED test below.
  assert.deepEqual(record.gaps, []);
});

test('parent totals and subagent totals are reported separately, never conflated', () => {
  const record = realSession();
  const parent = sumByModel(record.tokens.by_model);
  const subs = record.subagents.reduce((a, s) => a + sumByModel(s.by_model), 0);

  assert.equal(parent, 13306397);
  assert.equal(subs, 1083082);
  // The load-bearing assertion: the parent figure must NOT already include the
  // subagents. Verified structurally as well as numerically — the opus subagent's
  // model appears in a subagent's by_model and NOT in the parent's, because subagent
  // turns are not in the parent transcript (0 sidechain entries in a session that
  // spawned 28). A conflated parent total would have absorbed that model.
  assert.deepEqual(Object.keys(record.tokens.by_model), [PARENT_MODEL]);
  assert.ok(
    record.subagents.some((s) => Object.keys(s.by_model).includes(SUB_ONLY_MODEL)),
    'the opus subagent must keep its own model',
  );
});

test('cost is computed per model from the copied table and totalled', () => {
  const record = realSession();
  // Cost IS whole-run: "totalled" is the frozen name's own word, and a dashboard needs
  // one spend figure. Separation is preserved where it matters — tokens stay split,
  // and both parent_usd and each subagent's cost_usd are carried — so the split is
  // never unrecoverable from the total.
  assert.equal(record.cost.total_usd, 9.651045);
  assert.ok(record.cost.by_model[PARENT_MODEL].usd > 0);
  // The opus subagent is priced at OPUS rates, not the parent's sonnet rates. The
  // failure this guards is one blended rate applied to every model.
  assert.ok(record.cost.by_model[SUB_ONLY_MODEL].usd > 0);
  assert.equal(record.cost.price_table_version, '2026-07-30.2');
  const summed = Object.values(record.cost.by_model).reduce((a, v) => a + v.usd, 0);
  assert.ok(Math.abs(record.cost.total_usd - summed) < 1e-6);
  // Per-subagent attribution, so "which dig cost what" survives the total.
  const opus = record.subagents.find((s) => Object.keys(s.by_model).includes(SUB_ONLY_MODEL));
  assert.ok(opus.cost_usd > 0);
  assert.ok(record.cost.parent_usd > 0);
  assert.ok(record.cost.parent_usd < record.cost.total_usd);
});

test('a hand-run session with no Alfred work item still produces a valid record', () => {
  // The hook path means sessions you ran by hand get dashboard numbers too. There is
  // no ticket, so `work` must be null-shaped rather than absent or invented.
  const record = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: null,
    session: { id: 'sess-handrun' },
    work: null,
  });
  assert.equal(record.ok, true);
  assert.deepEqual(record.work, { source: null, item_id: null, title: null, ac_count: null });
  assert.ok(record.cost.total_usd > 0);
});

test('by_phase is absent from the record — there are no phases', () => {
  const record = realSession();
  // Absent, not present-and-empty. An empty `by_phase: {}` invites a dashboard panel
  // to render a phase breakdown that will always be blank, which reads as "no phase
  // data captured" rather than "phases do not exist here."
  assert.equal(Object.hasOwn(record, 'by_phase'), false);
  const json = JSON.stringify(record);
  assert.equal(json.includes('by_phase'), false);
  assert.equal(json.includes('phase'), false);
});

test('the sink path is injected; nothing writes to ~/.harness/telemetry in tests', () => {
  // buildRecord is pure: it returns a record and writes nothing at all. The sink is
  // carried as data for the entry points to use, never resolved by the library.
  const dir = tmp();
  const record = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: null,
    session: { id: 'sess-arm0' },
    sink: dir,
  });
  assert.equal(record.ok, true);
  assert.equal(record.sink, dir);
  assert.equal(JSON.stringify(record).includes('.harness/telemetry'), false);

  // THE CASE THAT ACTUALLY MATTERS, and the one the first draft of this test missed:
  // the default when NOTHING is injected. Mutation testing caught it — hardcoding a
  // `.harness/telemetry` default left every test green, because each of them passes a
  // sink or ignores the field, so the default was never once evaluated. Asserting the
  // absence of a literal only works if the code path that could produce it runs.
  //
  // This project's test suite has previously written into the production sink, where
  // `syncRun`'s `git add -A -- log` then absorbed unrelated staged changes. The
  // defence is that there IS no default: absent means absent, and a caller that wants
  // a sink names one.
  const noSink = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: null,
    session: { id: 'sess-arm0' },
  });
  assert.equal(noSink.sink, null);
  assert.equal(JSON.stringify(noSink).includes('.harness'), false);
  assert.equal(JSON.stringify(noSink).includes('telemetry'), false);
  rmSync(dir, { recursive: true, force: true });
});

test('report failure cannot fail the run — it exits 0 and records its own error', () => {
  // The pure-sidecar rule, carried from the OTel constraint: capture failure must
  // never fail a tick. A transcript that does not exist forces the failure path most
  // cheaply.
  const record = buildRecord({
    transcriptPath: join(tmpdir(), 'alfred-no-such-transcript-' + process.pid + '.jsonl'),
    subagentsDir: null,
    session: { id: 'sess-broken' },
  });
  assert.equal(record.ok, false);
  assert.equal(typeof record.error, 'string');
  assert.ok(record.error.length > 0);
  // It must not throw, and it must not report a cost it cannot know. $0.00 here would
  // be a plottable lie — the run happened and spent money we failed to read.
  assert.equal(record.cost.total_usd, null);
  assert.equal(record.cost.complete, false);
});

// --- the arm 0 anchor --------------------------------------------------------

test('arm 0 fixture transcript reports 2,207,405 tokens and $1.12 (+/- rounding)', () => {
  // Worth the whole suite. It fails loudly if any change to dedupe, model
  // normalization, or the price table moves the headline number. This also discharges
  // the §8.2 mitigation: these are the figures upstream `collectFromFile` produces on
  // the same transcript.
  const record = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: null,
    session: { id: 'sess-arm0' },
  });
  assert.equal(sumByModel(record.tokens.by_model), 2207405);
  assert.equal(record.cost.total_usd, 1.118285);
  assert.ok(Math.abs(record.cost.total_usd - 1.12) < 0.005);
  // The composition, not just the sum — 95.6% cache_read is the finding the whole
  // thesis rests on, and a sum can be right while the split is wrong.
  assert.equal(record.tokens.by_model['claude-sonnet-4-6'].cache_read, 2110234);
  assert.equal(record.tokens.by_model['claude-sonnet-4-6'].output, 10742);
  assert.equal(record.tokens.by_model['claude-sonnet-4-6'].input, 32);
  assert.equal(record.tokens.by_model['claude-sonnet-4-6'].cache_creation, 86397);
  assert.equal(record.tokens.peak_context, 86708);
  assert.equal(record.tokens.active_ms, 211281);
  assert.equal(record.tokens.lines, 131);
});

// --- ADDED ------------------------------------------------------------------

test('ADDED: the record carries no transcript text — description is the one exception, named', () => {
  // Re-asserted at the record layer because M2 is the first thing that builds an
  // object destined for a sink, and the sink is a git repo that gets pushed. The
  // parent fixture is a REAL session, so this is not theoretical, and the reduced
  // fixtures carry the literal `SENSITIVE_TRANSCRIPT_TEXT` precisely so this test has
  // something it could find.
  //
  // The asymmetry: agent_id, agentType, toolUseId, and spawnDepth are structural.
  // `description` is model-authored prose, carried because §2.5 asks for it and a
  // dashboard needs a label. So the assertion is not "no prose" but "prose appears
  // ONLY there" — falsifiable, and it documents the exposure instead of hiding it. If
  // publishing that field is ever ruled out, this test names the one line to change.
  const record = realSession();
  const stripped = { ...record, subagents: record.subagents.map(({ description: _d, ...s }) => s) };
  assert.equal(JSON.stringify(stripped).includes('SENSITIVE_TRANSCRIPT_TEXT'), false);
  assert.equal(
    record.subagents.every((s) => s.description === 'SENSITIVE_TRANSCRIPT_TEXT'),
    true,
  );
});

test('ADDED: a subagent that spent nothing measurable still appears in the record', () => {
  // Three of the 28 subagents in the source session recorded `<synthetic>` with
  // all-zero usage — the shape of an API-error 529 entry. They happened. Dropping them
  // because they cost $0 under-reports the spawn count, which is the metric the
  // delegation-cost lesson depends on.
  const record = realSession();
  const zero = record.subagents.filter((s) => sumByModel(s.by_model) === 0);
  assert.equal(zero.length, 1);
  assert.equal(zero[0].cost_usd, 0);
  // And $0 for `<synthetic>` must not poison completeness — it is the one id for which
  // zero is the honest figure, per config/prices.json:53.
  assert.equal(record.cost.complete, true);
  assert.deepEqual(record.cost.unpriced, []);
});

test('ADDED: an unreadable subagents dir is a named gap, not silently zero subagents', () => {
  // The counterpart to the missing-dir test. Missing means nothing spawned; unreadable
  // means we cannot tell, and those two must not produce identical records. A file
  // where a directory is expected forces ENOTDIR without depending on chmod behaviour.
  const dir = tmp();
  const notADir = join(dir, 'subagents');
  writeFileSync(notADir, 'this is a file, not a directory\n');
  const record = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: notADir,
    session: { id: 'sess-unreadable' },
  });
  assert.deepEqual(record.subagents, []);
  assert.equal(record.gaps.length, 1);
  assert.equal(record.gaps[0].code, 'subagents-unreadable');
  assert.ok(record.gaps[0].detail.length > 0);
  // A structural hole names itself and does NOT blunt the record to ok: false — the
  // tokens we did read are still valid.
  assert.equal(record.ok, true);
  assert.ok(record.cost.total_usd > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('ADDED: an absent session id is a named gap, because there is no key to join on', () => {
  const record = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: null,
    session: { id: null },
  });
  assert.equal(record.session.id, null);
  assert.ok(record.gaps.some((g) => g.code === 'session-id-absent'));
  assert.equal(record.ok, true);
});

test('ADDED: the usage tripwire is wired into the record, not only into gaps.mjs', () => {
  // gaps.test.mjs proves usageRefusal's logic. This proves report CALLS it — wiring is
  // where a guard gets forgotten, and an unwired tripwire is the green-and-blind shape
  // this project keeps hitting. Parseable lines carrying no usage at all is the shape a
  // Claude Code transcript-format change would produce.
  const dir = tmp();
  const t = join(dir, 'shapeless.jsonl');
  writeFileSync(
    t,
    [
      JSON.stringify({ type: 'user', timestamp: '2026-07-27T00:00:00.000Z' }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-07-27T00:00:01.000Z', message: {} }),
    ].join('\n') + '\n',
  );
  const record = buildRecord({ transcriptPath: t, subagentsDir: null, session: { id: 's' } });
  assert.ok(record.gaps.some((g) => g.code === 'no-usable-usage'));
  // Refused, not reported as free. $0.00 over two parsed lines is exactly the
  // plottable falsehood the tripwire exists to prevent.
  assert.equal(record.cost.total_usd, null);
  assert.equal(record.cost.complete, false);
  rmSync(dir, { recursive: true, force: true });
});

test('ADDED: the hook derives <dir>/<session-id>/subagents/ from the payload, by formula', () => {
  // Found by mutation testing: rewriting the derivation to `<dir>/subagents` left all
  // 18 tests green. The frozen name above proves subagents are READ from that layout
  // when the path is handed in directly; nothing proved the hook COMPUTES it. That is
  // the one piece of path logic left in the hook path, so it is the one piece that can
  // silently point at nothing and report a subagent-free run as though it were real.
  const dir = tmp();
  const sessionId = 'sess-derived';
  const transcript = join(dir, `${sessionId}.jsonl`);
  writeFileSync(
    transcript,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-27T00:00:00.000Z',
      message: { model: 'claude-sonnet-5', id: 'p1', usage: { input_tokens: 7 } },
    }) + '\n',
  );
  // The real layout: sibling of the transcript, named for the session, then subagents/.
  const sub = join(dir, sessionId, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, 'agent-aderived.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-27T00:00:02.000Z',
      message: { model: 'claude-sonnet-5', id: 's1', usage: { input_tokens: 21 } },
    }) + '\n',
  );
  // A DECOY at the wrong-but-plausible location, so a shortened derivation finds
  // something and reports the wrong subagent rather than none.
  const decoy = join(dir, 'subagents');
  mkdirSync(decoy, { recursive: true });
  writeFileSync(
    join(decoy, 'agent-adecoy.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-27T00:00:03.000Z',
      message: { model: 'claude-sonnet-5', id: 'd1', usage: { input_tokens: 55555 } },
    }) + '\n',
  );

  const record = recordFromHookPayload({
    session_id: sessionId,
    transcript_path: transcript,
    cwd: dir,
  });
  assert.equal(record.subagents.length, 1);
  assert.equal(record.subagents[0].agent_id, 'agent-aderived');
  assert.equal(record.subagents[0].by_model['claude-sonnet-5'].input, 21);
  rmSync(dir, { recursive: true, force: true });
});

test('ADDED: a subagent .jsonl with no sibling meta is reported, not dropped', () => {
  // The meta file is written separately from the transcript, so a session killed
  // between the two writes leaves a .jsonl alone. It spent tokens. Dropping it because
  // its structural fields are unknown under-reports both spend and spawn count; the
  // honest record keeps the spend and nulls what it does not know.
  const dir = tmp();
  const sub = join(dir, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, 'agent-aorphan.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-27T00:00:00.000Z',
      message: { model: 'claude-sonnet-5', id: 'o1', usage: { input_tokens: 99 } },
    }) + '\n',
  );
  const record = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: sub,
    session: { id: 'sess-orphan' },
  });
  assert.equal(record.subagents.length, 1);
  assert.equal(record.subagents[0].by_model['claude-sonnet-5'].input, 99);
  assert.equal(record.subagents[0].toolUseId, null);
  assert.equal(record.subagents[0].spawnDepth, null);
  assert.equal(record.subagents[0].agentType, null);
  rmSync(dir, { recursive: true, force: true });
});

test('ADDED: unparseable lines are counted in tokens.skipped, not silently dropped', () => {
  // §2.5 names `skipped` and both real fixtures have zero of them, so the field would
  // sit at 0 forever with nothing proving it can move. A truncated trailing line is
  // the real case: a transcript appended to while it is read.
  const dir = tmp();
  const t = join(dir, 'truncated.jsonl');
  writeFileSync(
    t,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-27T00:00:00.000Z',
      message: { model: 'claude-sonnet-5', id: 'm1', usage: { input_tokens: 10 } },
    }) +
      '\n' +
      '{"type":"assistant","timestamp":"2026-07-2',
  );
  const record = buildRecord({ transcriptPath: t, subagentsDir: null, session: { id: 's' } });
  assert.equal(record.tokens.lines, 1);
  assert.equal(record.tokens.skipped, 1);
  // The valid line before it still counts — a half-written tail must not void the run.
  assert.equal(record.tokens.by_model['claude-sonnet-5'].input, 10);
  rmSync(dir, { recursive: true, force: true });
});

// --- the suite stamp, wired -------------------------------------------------

test('ADDED: a record carries the suite stamp it was given, and null when it was given none', () => {
  // #42. The scorecard scored result-tagging FAIL: no result in the repo carries a
  // suite version, a model id, or a run date, and arm A's $0.617 was measured on
  // sonnet-4-6 while the seats moved to sonnet-5 the same day. The checker existed in
  // lib/suite.mjs and nothing called it — an unwired tripwire, which is the exact
  // green-and-blind shape report.mjs's own header warns about.
  const stamped = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: null,
    session: { id: 'sess-stamped' },
    suite: suiteStamp({ model: 'claude-sonnet-5', config_sha: 'abc1234', at: AT }),
  });
  assert.equal(stamped.suite.suite_version, loadSuiteConfig().version);
  assert.equal(stamped.suite.suite_digest, computeSuiteDigest());
  assert.equal(stamped.suite.model, 'claude-sonnet-5');
  assert.equal(stamped.suite.at, AT);

  // A hand-run session scored against no rubric gets `suite: null`, and that is NOT a
  // gap. Same rule as an absent subagents dir: if every unscored run carried a
  // permanent hole, the gaps list would stop distinguishing anything.
  const unscored = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: null,
    session: { id: 'sess-hand-run' },
  });
  assert.equal(unscored.suite, null);
  assert.deepEqual(unscored.gaps, []);
});

test('ADDED: a stamp that disagrees with the suite on disk is a named gap, not a silent pass', () => {
  // The half that makes the stamp worth having. A record claiming a digest the repo
  // cannot reproduce was scored against a different rubric+fixture pair than the one
  // present, and comparing it to a current result is the trend line lying.
  const record = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: null,
    session: { id: 'sess-stale-stamp' },
    suite: { ...suiteStamp({ model: 'claude-sonnet-5', at: AT, config_sha: null }), suite_digest: 'f'.repeat(64) },
  });
  const gap = record.gaps.find((g) => g.code === 'suite-stamp-invalid');
  assert.ok(gap, `expected a suite-stamp-invalid gap, got ${JSON.stringify(record.gaps)}`);
  assert.match(gap.detail, /digest/i);
  // The stamp is still carried verbatim. Dropping it would destroy the only evidence
  // of what the run claimed, which is what makes a bad stamp diagnosable at all.
  assert.equal(record.suite.suite_digest, 'f'.repeat(64));
  // A gap does not condemn the record: the tokens were still measured.
  assert.equal(record.ok, true);
});

test('ADDED: a malformed suite stamp is a gap rather than a thrown report', () => {
  // Pure-sidecar: a stamp problem must not fail the run being reported on. A stamp
  // missing its model is the case that matters, because a defaulted model id is
  // precisely what arm A's untagged $0.617 would have produced.
  for (const bad of [{}, { suite_version: '2026-07-30.1' }, 'nope', 7, []]) {
    const record = buildRecord({
      transcriptPath: ARM0,
      subagentsDir: null,
      session: { id: 'sess-bad-stamp' },
      suite: bad,
    });
    assert.equal(record.ok, true, `a bad stamp must not void the record: ${JSON.stringify(bad)}`);
    assert.ok(
      record.gaps.some((g) => g.code === 'suite-stamp-invalid'),
      `no gap for ${JSON.stringify(bad)}`,
    );
  }
});

test('ADDED: the failure path carries the stamp too — an unreadable transcript is still a tagged run', () => {
  // The failure record is built as a whole record so a consumer never branches on
  // which fields exist. A `suite` key missing there would be the one field a reader
  // has to guard, and the run it describes was still scored against a suite.
  const record = buildRecord({
    transcriptPath: join(tmpdir(), 'alfred-no-such-transcript-stamp-' + process.pid + '.jsonl'),
    subagentsDir: null,
    session: { id: 'sess-broken-stamped' },
    suite: suiteStamp({ model: 'claude-sonnet-5', at: AT, config_sha: null }),
  });
  assert.equal(record.ok, false);
  assert.equal(record.suite.model, 'claude-sonnet-5');
  assert.equal(record.cost.total_usd, null);
});

test('ADDED: the failure path carries the GATE VERDICT too — an unreadable transcript was still graded', () => {
  // FOUND BY READING THE FIRST PERSISTED RECORD, not by a test. The e2e run of
  // 2026-08-01 printed `gate: FAIL / check_failed: declared check test failed: npm test`
  // to the console and wrote `"gate": {"pass": null, "findings": []}` to record.json.
  //
  // The cause is the same over-broad default as #63: `failed()` never accepted a `gate`
  // parameter at all, so every transcript-unreadable run persisted an empty verdict. The
  // reasoning already written one field over for `suite` — "a run whose transcript could
  // not be read was still scored against a suite" — is exactly as true of the gate, and
  // the gate is the field the whole architecture exists to produce. Reading the
  // transcript is ACCOUNTING; the gate is JUDGEMENT, and it is reached before this and
  // by a path that does not touch the transcript. One failing does not unmake the other.
  const record = buildRecord({
    transcriptPath: join(tmpdir(), 'alfred-no-such-transcript-gate-' + process.pid + '.jsonl'),
    subagentsDir: null,
    session: { id: 'sess-broken-graded' },
    gate: {
      pass: false,
      findings: [{ rule: 'check_failed', detail: 'declared check test failed: npm test', evidence: 'exit 1' }],
      unverified: ['AC-2'],
    },
  });
  assert.equal(record.ok, false, 'the fixture must exercise the failure path, not the success one');
  // NOT `pass ?? null`. `false` is a verdict and `null` is the absence of one, and the
  // defect turned the first into the second — the difference between "this run was
  // rejected" and "nobody looked".
  assert.equal(record.gate.pass, false, 'a failing verdict was persisted as no verdict');
  assert.equal(record.gate.findings.length, 1, 'the reason for the verdict was dropped');
  assert.equal(record.gate.findings[0].rule, 'check_failed');
  assert.deepEqual(record.gate.unverified, ['AC-2']);
});

test('ADDED: the failure path carries what was DELIVERED — a pushed branch is not unpushed by a bad transcript', () => {
  // A SEPARATE PROPOSITION from the gate above, and separate for a reason: `failed()`
  // omitted both, and one test spanning them would have gone green on a fix to either.
  // This one is the more dangerous omission of the two — a record claiming no commits
  // and no PR for a run that pushed a branch and opened a PR does not merely lose
  // information, it asserts a false negative about work that exists on a remote.
  const record = buildRecord({
    transcriptPath: join(tmpdir(), 'alfred-no-such-transcript-delivery-' + process.pid + '.jsonl'),
    subagentsDir: null,
    session: { id: 'sess-broken-delivered' },
    delivery: { commits: ['abc1234'], pushed_to: 'alfred/some-item', pr_url: 'https://example.invalid/pr/1' },
  });
  assert.equal(record.ok, false);
  assert.deepEqual(record.delivery.commits, ['abc1234']);
  assert.equal(record.delivery.pushed_to, 'alfred/some-item');
  assert.equal(record.delivery.pr_url, 'https://example.invalid/pr/1');
});

test('ADDED #13: the record carries the DISCLOSURE that nothing was graded', () => {
  // A FIELD THE VERDICT CARRIES AND THE RECORD DROPS — #10's shape, at a new field. The gate
  // now reports `graded_criteria` and `ungraded_reason` so a green run graded against zero
  // criteria says so. `buildRecord` projects the verdict to a fixed shape rather than passing
  // it through, so both fields died on the way to disk: the console printed the disclosure and
  // record.json did not have it.
  //
  // That asymmetry is the worse half. The console line is read once by whoever ran it; the
  // record is what an operator, a scheduler, or a later scoring pass reads. A stored verdict
  // whose `pass: true` cannot be distinguished from a run that satisfied real criteria is how
  // "verified" comes to mean "nothing objected" in the artifact that outlives the run.
  //
  // A REAL TRANSCRIPT, so this exercises the SUCCESS projection. `buildRecord` has two — the
  // ordinary one and `failed()` — and a mutant caught the first draft of this test: it passed
  // `transcriptPath: null`, which takes the failure path, so both of these tests graded the
  // same projection and deleting the success one killed nothing. The assertion that this is
  // the success path is below, not implied by the fixture.
  const record = buildRecord({
    transcriptPath: ARM0,
    subagentsDir: null,
    session: { id: 'sess-graded-nothing' },
    gate: {
      pass: true,
      findings: [],
      unverified: [],
      graded_criteria: 0,
      ungraded_reason: 'no acceptance criteria were graded: none were declared',
    },
  });

  assert.equal(record.ok, true, 'the fixture must exercise the SUCCESS path, not failed()');
  assert.equal(record.gate.pass, true);
  assert.equal(record.gate.graded_criteria, 0, 'the record must say how many criteria were graded');
  assert.equal(
    record.gate.ungraded_reason,
    'no acceptance criteria were graded: none were declared',
    'the disclosure was dropped on the way to disk',
  );
});

test('ADDED #13: the FAILURE path carries the disclosure too', () => {
  // BOTH PROJECTIONS, and separately, for the reason the test above this file's gate-verdict
  // test already records: `buildRecord` has two of them, and a fix to one leaves the other
  // silently dropping the field. A run whose transcript could not be read was still graded,
  // and it was still graded against however many criteria it had.
  const record = buildRecord({
    transcriptPath: join(tmpdir(), 'alfred-no-such-transcript-graded-' + process.pid + '.jsonl'),
    subagentsDir: null,
    session: { id: 'sess-broken-graded-nothing' },
    gate: {
      pass: true,
      findings: [],
      unverified: [],
      graded_criteria: 0,
      ungraded_reason: 'no acceptance criteria were graded: none were declared',
    },
  });

  assert.equal(record.ok, false, 'the fixture must exercise the failure path');
  assert.equal(record.gate.graded_criteria, 0, 'the failure path dropped the count');
  assert.ok(record.gate.ungraded_reason, 'the failure path dropped the disclosure');
});
