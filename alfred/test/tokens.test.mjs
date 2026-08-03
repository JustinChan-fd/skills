// tokens — the transcript parser. Sums, windows, the context fingerprint, and the
// deduplication that every dollar figure in this project depends on.
//
// WHERE THESE TEST NAMES COME FROM. The 20 names below are lifted VERBATIM from
// `harness-core/test/tokens-collect.test.mjs`, frozen into PLAN.md §3/M1 on
// 2026-07-29. Each one encodes a bug found the expensive way. PLAN.md §8.2 decided
// to port the CASES and write the code fresh (~80 lines) rather than port the
// implementation, because the Stop hook payload eliminates the discovery two-thirds
// of the old collector and a wholesale port would carry that dead code past its own
// passing tests.
//
// THE NAMES ARE THE ARM C CONTROL. They were frozen in git before sandbox-b exists,
// so they cannot have been reshaped after seeing a new trap. Anything added carries
// an `ADDED:` prefix and names the measurement that motivated it — additions are
// evidence, reshaping a frozen name would be scope creep wearing a test's clothes.
//
// THE DEFECT THE DEDUPE SEVEN EXIST FOR. Claude Code writes ONE JSONL LINE PER
// CONTENT BLOCK of an assistant response (thinking / text / tool_use / tool_use…),
// repeating the SAME `message.usage` on every line under a single `message.id`.
// Summing per line bills one API call two, three, or four times. Measured
// independently on THIS machine's data on 2026-07-30, across 322 transcripts:
// 53,841 usage rows carrying 27,522 distinct message.ids, repeats up to 28x, for an
// inflation factor of 1.956. That reproduces harness-core's ~2.2x finding on a
// different corpus, which is why the figure is treated as a defect and not a fluke.
//
// It shipped green past 470 upstream tests because no fixture had the shape — the
// hand-authored iterations fixture carries a null id on every row. So
// `fixtures/split-blocks.jsonl` is REDUCED FROM A REAL TRANSCRIPT (content replaced
// by block-type names) rather than hand-authored, because hand-authoring is exactly
// what missed it.
//
// PRIVACY. The parser reads no message content, only `usage` and `timestamp`. That
// is what makes committing fixtures at all permissible, and the last test in this
// file is the standing guard on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { DEFAULT_GAP_CAP_MS, collectFromText, collectFromFile } from '../lib/tokens.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const readFixture = (name) => readFileSync(fixture(name), 'utf8');

// One usage line with no message.id — the shape older transcripts and every
// synthetic fixture here carry.
const usageLine = (ts, model, u) =>
  JSON.stringify({ timestamp: ts, message: { model, usage: u } });

// One usage line WITH an explicit message.id.
const idLine = (id, ts, model, u) =>
  JSON.stringify({ timestamp: ts, message: { id, model, usage: u } });

// --- 1. sums and windows ---

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
  // A hard-coded cap is the wall-clock defect in another costume: a run measured
  // with an undisclosed cap cannot be compared to one measured with a different
  // one, and nothing in the number says which was used.
  assert.equal(DEFAULT_GAP_CAP_MS, 5 * 60 * 1000);
  const r = collectFromText(readFixture('normal-session.jsonl'), { gapCapMs: 5_000 });
  // gaps: 10s->5s, 10s->5s, 610s->5s => 15s
  assert.equal(r.active_ms, 15_000);
  assert.equal(r.gap_cap_ms, 5_000);
});

test('an unrecognized model id is still summed under its own id (tiering happens later)', () => {
  // The parser must not be the component that decides a model is unknown. Dropping
  // an unrecognized id here would produce a total that is short by an invisible
  // amount; carrying it forward lets lib/prices.mjs report it as `unpriced` BY
  // NAME, which is M0's governing rule.
  const r = collectFromText(readFixture('unknown-model.jsonl'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.by_model['some-unrecognized-model-99'], {
    input: 70,
    output: 25,
    cache_read: 0,
    cache_creation: 0,
  });
});

// --- 2. peak_context: the single-call context fingerprint ---
//
// `tokens_observed.total` on a record is the Agent tool's subagent_tokens tag, which
// is the PEAK SINGLE-CALL context of that subagent — not a sum. Matching a
// transcript to a run by that number is an identity check; matching by spawnDepth +
// description + a 60s window overlap is three guesses ANDed together, and that is
// what landed TARS-1271 with an empty by_model.

test('peak_context is the largest single call context, not the sum and not the last call', () => {
  // The biggest call is deliberately in the MIDDLE: a bug returning the last call's
  // total, and a bug returning a running sum, both pass a fixture where max is last.
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
  // The whole point: a wrong run window is what breaks time-based attribution, so
  // the fingerprint has to survive one. The peak call here is OUTSIDE the window and
  // must still be reported, while the sums stay windowed.
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
  // Each sub-entry is a real API call with its own context, so the peak may live in
  // a sub-entry rather than in message.usage.
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
  // Older transcript lines carry only input_tokens/output_tokens. A NaN peak makes
  // every fingerprint comparison false — the silent-empty failure this phase fixes,
  // and a NaN that reaches a threshold comparison always compares as "under".
  const text = usageLine('2026-07-27T00:00:10.000Z', 'claude-opus-5', {
    input_tokens: 700, output_tokens: 40,
  });
  const r = collectFromText(text);
  assert.equal(r.peak_context, 740);
  assert.ok(Number.isFinite(r.peak_context), 'peak_context is not finite');
});

test('a transcript with no usage entries reports peak_context 0, not -Infinity', () => {
  // `Math.max()` of an empty list is -Infinity, which is the natural implementation
  // and a number no context window ever had.
  const text = JSON.stringify({
    timestamp: '2026-07-27T00:00:10.000Z', type: 'user', message: { content: 'hi' },
  });
  const r = collectFromText(text);
  assert.equal(r.ok, true);
  assert.equal(r.peak_context, 0);
});

test('an empty or unparseable transcript still carries a numeric peak_context', () => {
  // Both early-return paths must build from the same base shape. A field added only
  // to the success path leaves `undefined` here, and downstream compares it
  // numerically — `undefined < n` is false, so the comparison silently stops working.
  assert.equal(collectFromText('').peak_context, 0);
  assert.equal(collectFromText('not json at all').peak_context, 0);
});

// --- 3. degradation: never throw, always structured ---

test('garbage/malformed transcript returns a structured failure result, never throws', () => {
  // A throw here fails a whole unattended tick over a file the parser was only ever
  // reading for telemetry. Cost accounting is a side-car; it must not be able to
  // take down the run it is measuring.
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

test('a missing path returns a structured not-found result, never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alfred-tokens-'));
  let r;
  assert.doesNotThrow(() => {
    r = collectFromFile(join(dir, 'does-not-exist.jsonl'));
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
  assert.equal(r.peak_context, 0, 'the not_found path carries the numeric field too');
});

// --- 4. the dedupe seven ---

test('two lines sharing one message.id count that API call once', () => {
  // The minimal real shape: a text block and a tool_use block from one response,
  // 2ms apart, carrying identical usage.
  const u = {
    input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 40,
  };
  const text = [
    idLine('msg_a', '2026-07-29T00:00:10.000Z', 'claude-opus-5', u),
    idLine('msg_a', '2026-07-29T00:00:10.002Z', 'claude-opus-5', u),
  ].join('\n');
  const r = collectFromText(text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.by_model['claude-opus-5'], {
    input: 100, output: 20, cache_read: 5_000, cache_creation: 40,
  });
});

test('four lines sharing one message.id count that API call once (real split-block shape)', () => {
  // fixtures/split-blocks.jsonl: 7 lines, 3 distinct message.ids at 4x / 2x / 1x.
  const r = collectFromText(readFixture('split-blocks.jsonl'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.by_model['claude-opus-5'], {
    input: 8_926, // 2 + 8922 + 2
    output: 610, // 426 + 71 + 113
    cache_read: 138_576, // 67992 + 0 + 70584
    cache_creation: 49_941, // 2592 + 45135 + 2214
  });
  // Per-line summing gives 17,854 input — a 2.0x on this fixture, the same defect
  // that inflated the real run. Pinned as a NUMBER so a partial fix still fails.
  assert.notEqual(r.by_model['claude-opus-5'].input, 17_854, 'per-line summing is back');
});

test('usage rows with no message.id are each counted, never collapsed together', () => {
  // The trap inside the obvious fix: `seen.add(msg.id)` treats `undefined` as one
  // key and folds every id-less row into a single call, swapping a 2x overcount for
  // a silent undercount. Independently confirmed on this machine: 0 of 53,841 real
  // rows lack an id, so every row exercising this path is synthetic — which is
  // exactly why it needs a test rather than a sample.
  const u = {
    input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  };
  const text = [
    usageLine('2026-07-29T00:00:10.000Z', 'claude-opus-5', u),
    usageLine('2026-07-29T00:00:20.000Z', 'claude-opus-5', u),
    usageLine('2026-07-29T00:00:30.000Z', 'claude-opus-5', u),
  ].join('\n');
  const r = collectFromText(text);
  assert.equal(r.by_model['claude-opus-5'].input, 30, 'id-less rows collapsed into one');
  assert.equal(r.by_model['claude-opus-5'].output, 3);
});

test('id-less iterations[] sub-entries still all count under a deduplicated parent line', () => {
  // The two rules meet on one line: the parent's message.usage is deduped by id,
  // while its iterations[] sub-entries carry no id and must each be added.
  const line = (uuid) => JSON.stringify({
    timestamp: '2026-07-29T00:00:10.000Z',
    uuid,
    message: {
      id: 'msg_it',
      model: 'claude-opus-5',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    iterations: [
      { usage: { input_tokens: 100, output_tokens: 50 } },
      { message: { usage: { input_tokens: 200, output_tokens: 80 } } },
    ],
  });
  const r = collectFromText([line('a'), line('b')].join('\n'));
  assert.equal(r.by_model['claude-opus-5'].input, 10 + (100 + 200) * 2);
});

test('peak_context is unchanged by deduplication — the fingerprint must not move', () => {
  // peak_context is a MAX, so it is structurally immune to duplicate rows: this is
  // why the #17/#18 fingerprint work passed cleanly over an inflated sum and lent it
  // false confidence. Pinned because a dedupe that also gated the peak loop would
  // break transcript identity matching silently.
  const raw = readFixture('split-blocks.jsonl');
  const deduped = collectFromText(firstPerMessageId(raw));
  const r = collectFromText(raw);
  assert.equal(r.peak_context, 72_913, 'largest single call: 2 + 113 + 70584 + 2214');
  assert.equal(r.peak_context, deduped.peak_context);
  const m = r.by_model['claude-opus-5'];
  assert.ok(r.peak_context < m.input + m.output + m.cache_read + m.cache_creation);
});

test('two distinct message.ids in one file are both counted — dedupe must not over-collapse', () => {
  const text = [
    idLine('msg_a', '2026-07-29T00:00:10.000Z', 'claude-opus-5', { input_tokens: 100, output_tokens: 10 }),
    idLine('msg_b', '2026-07-29T00:00:20.000Z', 'claude-opus-5', { input_tokens: 200, output_tokens: 20 }),
  ].join('\n');
  const r = collectFromText(text);
  assert.equal(r.by_model['claude-opus-5'].input, 300);
  assert.equal(r.by_model['claude-opus-5'].output, 30);
});

test('active_ms and timestamps are unchanged by deduplication', () => {
  // The fix gates TOKEN ATTRIBUTION ONLY. Split-block lines are the same call
  // milliseconds apart, so their stamps add ~2ms of active time — dropping them
  // would silently shorten every measured run. Timestamps stay per-line.
  const r = collectFromText(readFixture('split-blocks.jsonl'));
  assert.equal(r.timestamps.min, '2026-07-29T07:03:21.138Z');
  assert.equal(r.timestamps.max, '2026-07-29T07:03:52.002Z');
  // gaps over the 7 sorted stamps: 2 + 22979 + 2 + 2 + 5 + 7874 ms, none capped
  assert.equal(r.active_ms, 30_864);
  assert.equal(r.lines_parsed, 7, 'every line is still parsed and stamped');
});

// An independently-computed "keep the first line per message.id", used to pin
// invariants the parser must satisfy whichever way it dedupes. Deliberately NOT the
// parser's own rule — see the ADDED section below for why the parser uses a
// different, order-independent one.
function firstPerMessageId(text) {
  const seen = new Set();
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .filter((l) => {
      const id = JSON.parse(l)?.message?.id;
      if (id == null) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .join('\n');
}

// --- 5. privacy, carried forward as a hard rule ---

test('return value contains no raw transcript text anywhere in its object graph', () => {
  // The parser reads `usage` and `timestamp` and nothing else. This is the property
  // that makes committing fixtures permissible at all, so it is asserted over the
  // whole serialized object graph rather than over a field list — a leak would most
  // likely arrive in a new diagnostic field nobody thought to check.
  for (const name of ['normal-session.jsonl', 'iterations.jsonl', 'unknown-model.jsonl']) {
    const r = collectFromText(readFixture(name));
    assert.ok(
      !JSON.stringify(r).includes('SENSITIVE_TRANSCRIPT_TEXT'),
      `result for ${name} leaked transcript content`,
    );
  }
});

// --- 6. ADDED: what the real-transcript survey earned ---
//
// Nothing here relaxes a frozen proposition. Each test names the measurement that
// motivated it, taken on 2026-07-30 across 322 transcripts and 53,950 usage rows in
// ~/.claude/projects — the same discipline that caught the `in`/`out` defect, which
// survived green tests because its fixtures used the spelling the implementation
// expected rather than the one the producer emits.

test('ADDED: dedupe keeps the max per direction, so the result does not depend on line order', () => {
  // WHY THIS IS NOT COVERED BY A FROZEN NAME. "Two lines sharing one message.id
  // count that API call once" does not say WHICH row's numbers survive, and every
  // group in split-blocks.jsonl carries identical rows — so that fixture cannot tell
  // first-wins from max-wins.
  //
  // MEASURED: real duplicate rows are NOT always identical. id ...7re4umvq carries 4
  // rows: two at line 3770-3771 with {input 2, flat 5502}, and two at line 4123-4124
  // — ~350 lines later — with every top-level count ZEROED. Across 17,330 multi-row
  // groups, 2 groups disagree on each direction.
  //
  // First-wins happens to be right on all of them today (in 0 of 17,330 is the first
  // row not the max), so this is not a live undercount — it is order-dependence. A
  // rule whose answer changes if the producer ever emits the zeroed row first is a
  // rule that will be wrong quietly. Max-per-direction is order-independent and is
  // the correct recovery: one API call has one true value per direction, and a zeroed
  // duplicate is a truncated record of it, never a second call that cost nothing.
  const rows = [
    idLine('msg_z', '2026-07-29T00:00:10.000Z', 'claude-opus-5', {
      input_tokens: 2, output_tokens: 1_354, cache_read_input_tokens: 160_247, cache_creation_input_tokens: 5_502,
    }),
    idLine('msg_z', '2026-07-29T00:00:20.000Z', 'claude-opus-5', {
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }),
  ];
  const expected = { input: 2, output: 1_354, cache_read: 160_247, cache_creation: 5_502 };
  // Both orders, because the ordering is the whole proposition.
  assert.deepEqual(collectFromText(rows.join('\n')).by_model['claude-opus-5'], expected);
  assert.deepEqual(
    collectFromText([rows[1], rows[0]].join('\n')).by_model['claude-opus-5'],
    expected,
    'the zeroed duplicate arriving first must not erase the call',
  );
});

test('ADDED: a nested cache_creation bucket is read when the flat field is zero', () => {
  // MEASURED: 10 real rows report `cache_creation_input_tokens: 0` while their nested
  // `cache_creation.ephemeral_5m_input_tokens` is NONZERO — in 3 distinct message.id
  // groups where EVERY row has flat 0, so no sibling row can supply the number. The
  // largest is 241,475 tokens, which is ~$0.90 of cache write at sonnet-5's $3.75/Mtok
  // silently reported as free.
  //
  // The frozen names cannot catch this: split-blocks.jsonl was privacy-reduced
  // upstream in a way that STRIPPED the nested block entirely, while all 53,950 real
  // rows carry one. So a parser reading only the flat field passes every frozen test
  // and loses real money.
  //
  // Reading flat-first and falling back is safe: when flat is nonzero it agreed with
  // 5m+1h on all 53,950 rows (0 mismatches), so the fallback cannot contradict it.
  const text = idLine('msg_n', '2026-07-29T00:00:10.000Z', 'claude-opus-5', {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 241_475, ephemeral_1h_input_tokens: 0 },
  });
  const r = collectFromText(text);
  assert.equal(r.by_model['claude-opus-5'].cache_creation, 241_475, 'the write was reported free');
});

test('ADDED: a nested 1h bucket is counted alongside the 5m one, not instead of it', () => {
  // The mixed-TTL shape. `cache_creation` is ONE direction in this result — the TTL
  // split is lib/prices.mjs's job (M0), and it prices 5m and 1h at different rates.
  // The parser's obligation is to lose neither bucket, so the total it reports is
  // 5m + 1h and not whichever it happened to read first.
  const text = idLine('msg_m', '2026-07-29T00:00:10.000Z', 'claude-opus-5', {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 400 },
  });
  assert.equal(collectFromText(text).by_model['claude-opus-5'].cache_creation, 1_400);
});

test('ADDED: the flat field wins when present, so a populated record is never double-counted', () => {
  // The other half of the fallback, and the failure it prevents. FLAT IS THE TOTAL
  // ACROSS TTL BUCKETS — measured against this gateway on 2026-07-30, a write with an
  // explicit 1h breakpoint reported flat 25204 alongside {5m: 0, 1h: 25204}. So
  // adding the flat field TO its own nested buckets bills the same tokens twice.
  //
  // This is the mirror of the dedupe defect: an over-permissive read that accepts two
  // spellings of one count and sums them. Pinned as a number so the fix cannot drift
  // into the double-count while still passing the fallback test above.
  const text = idLine('msg_f', '2026-07-29T00:00:10.000Z', 'claude-opus-5', {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 2_592,
    cache_creation: { ephemeral_5m_input_tokens: 2_592, ephemeral_1h_input_tokens: 0 },
  });
  const r = collectFromText(text);
  assert.equal(r.by_model['claude-opus-5'].cache_creation, 2_592);
  assert.notEqual(r.by_model['claude-opus-5'].cache_creation, 5_184, 'flat added to its own buckets');
});

test('ADDED: the dedupe collapses this machine\'s measured inflation, not just the fixture\'s', () => {
  // MEASURED INDEPENDENTLY on 322 local transcripts: 53,841 usage rows carrying
  // 27,522 distinct message.ids — an inflation factor of 1.956, reproducing
  // harness-core's ~2.2x finding on a different corpus. Reconstructed here at the
  // measured multiplicity rather than asserted against live files, because a test
  // that reads ~/.claude/projects would pass or fail on whatever the machine did
  // yesterday.
  //
  // The frozen 4x/2x/1x fixture covers the shape; this covers the SCALE, which is
  // what makes the defect a 2x error on a dollar figure rather than a rounding note.
  const u = {
    input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 100,
  };
  // 28 ids, repeat counts summing to ~1.956x — the measured histogram's shape:
  // mostly 2x, a long tail to 4x, a few singletons.
  const multiplicity = [1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4];
  const lines = [];
  multiplicity.forEach((count, i) => {
    for (let n = 0; n < count; n += 1) {
      lines.push(idLine(`msg_${i}`, `2026-07-29T00:00:${String(i).padStart(2, '0')}.00${n}Z`, 'claude-opus-5', u));
    }
  });
  const rowCount = multiplicity.reduce((a, b) => a + b, 0);
  const idCount = multiplicity.length;
  assert.ok(rowCount / idCount > 1.9, 'the fixture must actually carry the measured inflation');
  const r = collectFromText(lines.join('\n'));
  // One count per distinct id — not per line.
  assert.equal(r.by_model['claude-opus-5'].input, idCount * 10);
  assert.notEqual(r.by_model['claude-opus-5'].input, rowCount * 10, 'per-line summing is back');
  // And the per-line stamps all survive, since dedupe gates attribution only.
  assert.equal(r.lines_parsed, rowCount);
});

test('ADDED: dedupe is scoped per model, so one id cannot mask another model\'s call', () => {
  // Not a shape observed in the wild — a guard on the implementation's key choice. A
  // `Set` keyed on the bare id would drop the second row here, attributing zero to
  // sonnet while opus keeps its full cost. That is the dedupe defect inverted: an
  // undercount that reads as a model simply not having been used, which is
  // indistinguishable from a correct result in a per-model dashboard.
  const text = [
    idLine('msg_same', '2026-07-29T00:00:10.000Z', 'claude-opus-5', { input_tokens: 100, output_tokens: 10 }),
    idLine('msg_same', '2026-07-29T00:00:20.000Z', 'claude-sonnet-5', { input_tokens: 200, output_tokens: 20 }),
  ].join('\n');
  const r = collectFromText(text);
  assert.equal(r.by_model['claude-opus-5'].input, 100);
  assert.equal(r.by_model['claude-sonnet-5'].input, 200, 'the second model was masked by a shared id');
});

test('ADDED: a partially-malformed transcript reports ok with the lines it could read', () => {
  // Distinct from the all-garbage case above, and the common real one: a transcript
  // being appended to while it is read, whose last line is half-written. Refusing the
  // whole file would discard every valid line before it; reporting ok with a silent
  // drop would hide it. So: ok, the sums that parsed, and a countable lines_parsed.
  const text = [
    idLine('msg_a', '2026-07-29T00:00:10.000Z', 'claude-opus-5', { input_tokens: 100, output_tokens: 10 }),
    '{"timestamp":"2026-07-29T00:00:20.000Z","message":{"id":"msg_b","usa',
  ].join('\n');
  const r = collectFromText(text);
  assert.equal(r.ok, true);
  assert.equal(r.by_model['claude-opus-5'].input, 100);
  assert.equal(r.lines_parsed, 1, 'the half-written line must not count as parsed');
});
