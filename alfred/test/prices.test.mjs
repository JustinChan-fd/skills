// prices — model id normalization and cost math.
//
// M0 is first in the build order for one reason: it is the only milestone whose bugs
// have already happened. PLAN.md §9 records both of them — a `$NaN` reaching a report,
// and price ids needing normalization because the collector emits
// `claude-haiku-4-5-20251001` while the table has `claude-haiku-4-5`. Neither was
// caught by a test; both were caught by a number that looked wrong.
//
// The governing principle, from PLAN.md §M0: **a zero cost is plottable and false,
// which is worse than a hole.** Every design choice below follows from it. An
// unpriceable model is NAMED, and the total it contributes to is marked incomplete —
// it never quietly contributes $0 and it never poisons the total with NaN.
//
// PROVENANCE OF THESE TEST NAMES, because the distinction is load-bearing for
// Experiment 2's arm C:
//
//   - The first six are the names frozen in PLAN.md §3 M0, verbatim, committed to git
//     2026-07-29. Arm C's comparison depends on the gate and its supporting libraries
//     being built to names that predate the fixture they will be judged on.
//   - The rest are marked ADDED, each with the recorded defect or the real observed
//     model id that motivates it. They are additions of evidence, not of scope: none
//     of them relaxes a frozen proposition, and none was written after seeing a
//     fixture's traps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelId, loadPriceTable, priceTokens } from '../lib/prices.mjs';

// Sonnet 4.6 is the calibration row throughout: in 3, out 15, cache_read 0.3,
// cache_write 3.75, cache_write_1h 6 (USD per Mtok). Chosen because it is the model
// every measured arm actually ran on, so a wrong rate here is a wrong headline figure.
const SONNET = 'claude-sonnet-4-6';

// --- the six frozen names ---

test('price keys are in/out/cache_read/cache_write — not input/output', () => {
  // The table's own column spelling, asserted against the file rather than assumed.
  // This is the shape `priceTokens` reads; if the copied table ever lands with
  // `input`/`output` columns, every non-cache direction silently prices at $0 —
  // which is exactly how arm 0's real transcript came out at $0.96 against a
  // recorded $1.12 while the tests stayed green.
  const table = loadPriceTable();
  const row = table.models[SONNET];

  assert.deepEqual(Object.keys(row).sort(), ['cache_read', 'cache_write', 'cache_write_1h', 'in', 'out']);
  assert.equal(row.input, undefined);
  assert.equal(row.output, undefined);
});

test('a dated model id normalizes by stripping -\\d{8}$ before lookup', () => {
  // The recorded defect: the collector emits dated ids, the table carries base ids,
  // and an unnormalized lookup produces a silent unpriced row.
  assert.equal(normalizeModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(normalizeModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');

  const dated = priceTokens({ 'claude-sonnet-4-5-20250929': { out: 1_000_000 } });
  const base = priceTokens({ 'claude-sonnet-4-5': { out: 1_000_000 } });
  assert.equal(dated.total_usd, base.total_usd);
  assert.deepEqual(dated.unpriced, []);
});

test('an anthropic.-prefixed id normalizes too', () => {
  // Bedrock-shaped ids, all four spellings observed on this machine's own transcripts:
  // the bare prefix, prefix + date, prefix + `-v1`, and prefix + date + `-v1:0`.
  assert.equal(normalizeModelId('anthropic.claude-sonnet-4-6'), SONNET);
  assert.equal(normalizeModelId('anthropic.claude-opus-4-6-v1'), 'claude-opus-4-6');
  assert.equal(normalizeModelId('anthropic.claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(normalizeModelId('anthropic.claude-haiku-4-5-20251001-v1:0'), 'claude-haiku-4-5');

  const priced = priceTokens({ 'anthropic.claude-haiku-4-5-20251001-v1:0': { out: 1_000_000 } });
  assert.equal(priced.total_usd, 5);
  assert.deepEqual(priced.unpriced, []);
});

test('an unknown model id yields a named unpriced result, never NaN and never 0', () => {
  // Three propositions in one frozen name, so all three are asserted separately.
  // The dangerous one is the middle: $0 is indistinguishable from "did no work", so a
  // runaway model absent from the table reads as free and no spend threshold can fire.
  const priced = priceTokens({ 'claude-future-9': { out: 5_000_000 } });

  assert.deepEqual(priced.unpriced, ['claude-future-9'], 'the id must be named');
  assert.equal(priced.by_model['claude-future-9'].usd, null, 'null, not 0 — a hole, not a false zero');
  assert.equal(priced.complete, false);
  assert.equal(Number.isNaN(priced.total_usd), false, 'a NaN total compares false against every threshold');
});

test('cost math uses cache_write (5m TTL) and never cache_write_1h', () => {
  // The two columns differ by 1.6x on sonnet (3.75 vs 6), so reading the wrong one is
  // a plausible-looking figure with no way to tell it is wrong by looking. This
  // session's own gateway pins the TTL at 5 minutes; the 1h column is not reachable
  // and must not be charged for.
  const { total_usd } = priceTokens({ [SONNET]: { cache_creation: 1_000_000 } });
  assert.equal(total_usd, 3.75);
  assert.notEqual(total_usd, 6);
});

test('the loaded table carries a version stamp and the record records it', () => {
  // Two propositions, deliberately both asserted: a stamp on the table is useless if
  // the record does not carry it, because re-pricing a historical figure means
  // knowing which rates produced it. Rates change — sonnet-5 steps up 2026-09-01.
  const table = loadPriceTable();
  assert.match(table.version, /^\d{4}-\d{2}-\d{2}/);

  const priced = priceTokens({ [SONNET]: { out: 1000 } });
  assert.equal(priced.price_table_version, table.version);
});

// --- ADDED: the count-key spelling defect (PLAN.md §9) ---
//
// The frozen names cover the TABLE's columns. They do not cover the counts side, and
// that is where the defect actually landed: armcost.mjs mapped only `in`/`out` while
// the collector emits `input`/`output`, so both non-cache directions priced at $0 on
// a real transcript while every test stayed green — the fixtures used the spelling the
// implementation expected rather than the one the producer emits.
//
// Two tests, because the fix pulls against the bug: accepting both spellings
// introduces the opposite risk of summing them.

test('ADDED: both count-key spellings price identically, so neither producer is dropped', () => {
  const short = priceTokens({ [SONNET]: { in: 1000, out: 2000 } });
  const long = priceTokens({ [SONNET]: { input: 1000, output: 2000 } });
  assert.equal(short.total_usd, long.total_usd);
  assert.ok(long.total_usd > 0, 'a non-zero token count must not price at $0');
});

test('ADDED: a count present under both spellings is not double-billed', () => {
  const both = priceTokens({ [SONNET]: { out: 1_000_000, output: 1_000_000 } });
  assert.equal(both.total_usd, 15);
});

test('ADDED: a legitimate zero under the first spelling does not fall through to the second', () => {
  // First-present-wins, not `??`. `{ in: 0, input: 999999 }` is a contradiction, and
  // resolving it by skipping the zero would invent tokens that were never used.
  const priced = priceTokens({ [SONNET]: { in: 0, input: 1_000_000 } });
  assert.equal(priced.total_usd, 0);
});

// --- ADDED: real observed ids the frozen names do not reach ---

test('ADDED: a [1m] long-context id is unpriced rather than charged at standard rates', () => {
  // `claude-opus-4-8[1m]` and `anthropic.claude-opus-4-6-v1[1m]` are both real ids on
  // this machine. The marker denotes the 1M-context variant, whose rates are NOT in
  // the copied table — long-context calls bill above the standard row past 200k.
  //
  // So there are two wrong answers and one right one. Stripping the marker prices a
  // premium call at the standard rate: a plausible number, quietly too low, no way to
  // tell by looking. Zeroing it is worse. Naming it as unpriced is the M0 principle
  // applied to the case that argues against convenience — the figure is short by a
  // known, listed amount rather than by an invisible one.
  const priced = priceTokens({ 'claude-opus-4-8[1m]': { out: 1_000_000 } });

  assert.deepEqual(priced.unpriced, ['claude-opus-4-8[1m]']);
  assert.equal(priced.complete, false);
  assert.equal(priced.by_model['claude-opus-4-8[1m]'].usd, null);
});

test('ADDED: <synthetic> is priced at zero and is not reported as unpriced', () => {
  // `<synthetic>` is a real recorded model value for assistant entries that carry no
  // model. It is genuinely free, and it is the one id for which $0 is the honest
  // figure — so it must NOT land in `unpriced`, or every run reports incomplete cost
  // forever and the flag stops meaning anything.
  const priced = priceTokens({ '<synthetic>': { in: 500, out: 500 } });
  assert.equal(priced.total_usd, 0);
  assert.deepEqual(priced.unpriced, []);
  assert.equal(priced.complete, true);
});

// --- ADDED: the two ways a total can be zero, kept apart ---

test('ADDED: an empty by_model totals zero and reports complete', () => {
  // Separated from the unpriced-model case on purpose. "Total is 0" is correct here
  // and a bug there; one test covering both would pass a build that conflated them.
  const priced = priceTokens({});
  assert.equal(priced.total_usd, 0);
  assert.equal(priced.complete, true);
  assert.deepEqual(priced.unpriced, []);
});

test('ADDED: a known model beside an unknown one still contributes its real cost', () => {
  // The NaN failure mode from PLAN.md §9, stated as the caller sees it: one unpriceable
  // model must not erase the cost of the models that ARE priceable.
  const priced = priceTokens({
    [SONNET]: { out: 1_000_000 },
    'claude-future-9': { out: 5_000_000 },
  });
  assert.equal(priced.total_usd, 15);
  assert.equal(priced.complete, false);
  assert.deepEqual(priced.unpriced, ['claude-future-9']);
});

test('ADDED: missing directions count as zero rather than throwing', () => {
  // Real by_model entries omit directions that never occurred.
  assert.equal(priceTokens({ [SONNET]: { out: 1_000_000 } }).total_usd, 15);
});

test('ADDED: a non-numeric token count is refused, not coerced into the total', () => {
  // `undefined - 0` and `Number('')` both produce numbers that look plausible. A
  // count that is not a finite number is a broken input, and the total must say so
  // rather than absorb it.
  const priced = priceTokens({ [SONNET]: { out: 'lots' } });
  assert.equal(Number.isNaN(priced.total_usd), false);
  assert.equal(priced.complete, false);
});

// --- ADDED: a scheduled rate change, which the table forces a decision about ---
//
// `claude-sonnet-5` is priced at an introductory $2/$10 until 2026-08-31 and steps up
// to $3/$15 after. That is a 1.5x change, on the model this project routes most seats
// to, arriving in roughly a month.
//
// The trap is that nothing about it looks like a bug from either side of the boundary.
// A figure priced at the introductory rate is exactly right today and exactly 1.5x too
// low in September, with no error, no warning, and no way to tell the two apart by
// looking at the number. That is the same shape as the four green-and-blind guards
// this session already found, so it gets handled now rather than discovered later.
//
// Three propositions, kept separate because they fail independently.

// DECIDED BY THE USER 2026-07-30: price sonnet-5 at the POST-step-up $3/$15 always,
// including during the introductory window. Two reasons, both about comparability:
// every figure stays directly comparable to arm B's recorded $18.483 (measured on
// sonnet-4-6 at $3/$15), and no figure changes meaning when September arrives.
//
// The cost of that choice, stated plainly so nobody later "corrects" it: until
// 2026-09-01 every reported dollar figure is 1.5x ABOVE what was actually billed. That
// is a deliberate conservative bias — a cost estimate that overstates is safe, one that
// flatters is not — and it is the opposite of the failure mode this module was built
// around, where an unpriced model made a run look cheap.

test('ADDED: sonnet-5 prices at the standard $3/$15 during the introductory window', () => {
  // The introductory rate would give $10 here. $15 is the deliberate choice.
  const priced = priceTokens({ 'claude-sonnet-5': { out: 1_000_000 } }, { at: '2026-08-15' });
  assert.equal(priced.total_usd, 15);
});

test('ADDED: sonnet-5 prices at $3/$15 after the step-up date too, so the figure never moves', () => {
  const priced = priceTokens({ 'claude-sonnet-5': { out: 1_000_000 } }, { at: '2026-09-01' });
  assert.equal(priced.total_usd, 15);
});

test('ADDED: an undated sonnet-5 call prices identically to a dated one', () => {
  // The property the conservative choice buys: `at` cannot change a sonnet-5 figure,
  // so a record missing its started_at is not a record with an unknown cost.
  //
  // No wall-clock read inside prices.mjs regardless — a cost function that consults
  // now() is not a pure function of its inputs, and the same historical record would
  // re-price differently tomorrow, which is what the version stamp exists to prevent.
  assert.equal(priceTokens({ 'claude-sonnet-5': { out: 1_000_000 } }).total_usd, 15);
});

test('ADDED: sonnet-5 and sonnet-4-6 price identically, which is what makes arm C comparable', () => {
  // Stated as its own proposition because it is the whole point of the decision. If
  // arm C on sonnet-5 comes in cheaper than arm B's $18.483, this assertion is what
  // rules out "the rates changed" as the explanation.
  const five = priceTokens({ 'claude-sonnet-5': { in: 1000, out: 2000, cache_read: 3000 } });
  const old = priceTokens({ [SONNET]: { in: 1000, out: 2000, cache_read: 3000 } });
  assert.equal(five.total_usd, old.total_usd);
});

test('ADDED: the introductory discount is recorded even though it is not applied', () => {
  // The rate we are NOT charging is still a fact about the world, and dropping it from
  // the table would make the $3/$15 choice indistinguishable from not having noticed
  // the step-up at all. This is the difference between a decision and an oversight.
  const table = loadPriceTable();
  const note = table.rate_changes?.['claude-sonnet-5'];
  assert.ok(note, 'the scheduled change must stay recorded');
  assert.equal(note.introductory.out, 10, 'the unapplied introductory rate is still recorded');
  assert.match(note.policy, /conserv|standard|not applied/i);
});

test('ADDED: no model reports a pending rate change, since none is applied', () => {
  // The caveat field stays in the shape and stays empty. It is the hook for the next
  // scheduled change, and an empty array is the honest value while the policy is to
  // price at the later rate.
  assert.deepEqual(priceTokens({ 'claude-sonnet-5': { out: 10 } }).rate_change_pending, []);
  assert.deepEqual(priceTokens({ [SONNET]: { out: 10 } }).rate_change_pending, []);
});

// --- ADDED: the 1-hour cache column, which I asserted was unreachable and is not ---
//
// The frozen name `cost math uses cache_write (5m TTL) and never cache_write_1h` is
// correct as a DEFAULT and I over-read it into a claim about the world: the first draft
// of config/prices.json said charging that column "would be billing for something that
// cannot happen."
//
// Measured against this gateway on 2026-07-30, that is false. With the
// `anthropic-beta: extended-cache-ttl-2025-04-11` header, a sonnet-5 request carrying
// `cache_control: {type: 'ephemeral', ttl: '1h'}` returned
// `ephemeral_1h_input_tokens: 14775` — a real 1-hour write, really billed.
//
// The narrower true statement, and the limit of what was measured: the gateway HONOURS
// an explicit 1h breakpoint on a direct API call. That does not establish that Claude
// Code's own requests ever set one, and prior evidence in this project was that its
// breakpoints get rejected. So the default stays 5m, and the 1h column becomes
// reachable only when a record's own counts say a 1h write occurred.
//
// Why it matters in dollars: a 1h write bills at 2x input against 1.25x for 5m, so
// pricing a 1h write as 5m understates that column by 1.6x.
//
// THE SEMANTICS, MEASURED RATHER THAN ASSUMED. A 1h write against this gateway returns:
//
//   "cache_creation_input_tokens": 25204,
//   "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 25204 }
//
// The flat field is the TOTAL ACROSS TTL BUCKETS, not the 5-minute portion. That matters
// because the collector maps `cache_creation_input_tokens` straight through to
// `cache_creation`, so a rule of "flat field is 5m, plus a separate 1h column" would
// charge the same 25,204 tokens twice — once at 3.75 and once at 6.
//
// This paragraph replaces a test of mine that asserted exactly that double-billing. It
// was written before the measurement above and encoded the shape that was convenient for
// the implementation rather than the one the producer emits — which is precisely how the
// `in`/`out` defect survived a green suite. So:
//
//   1h portion      priced at cache_write_1h
//   5m portion      explicit count if the record carries one, else total minus the 1h
//                   portion — never a second charge for tokens already counted
//
// A record carrying only the flat field is therefore priced entirely at 5m, which is
// today's behaviour and keeps arm 0's $1.12 anchor exactly where it is.

test('ADDED: a 1h cache write is priced at the 1h column, not the 5m one', () => {
  // sonnet-4-6: cache_write 3.75, cache_write_1h 6. The 1.6x that would otherwise be
  // silently lost.
  const priced = priceTokens({ [SONNET]: { cache_creation_1h: 1_000_000 } });
  assert.equal(priced.total_usd, 6);
});

test('ADDED: the flat cache_creation total is not double-billed against its own 1h portion', () => {
  // The measured payload, scaled: flat total 1M, of which 1M is the 1h bucket and 0 is
  // the 5m bucket. The honest figure is $6. $9.75 — the flat field charged at 5m *plus*
  // the 1h column — is the failure this test exists to make impossible, and it is the
  // one I had written into the suite.
  const priced = priceTokens({
    [SONNET]: { cache_creation: 1_000_000, cache_creation_1h: 1_000_000 },
  });
  assert.equal(priced.total_usd, 6);
  assert.notEqual(priced.total_usd, 3.75 + 6);
});

test('ADDED: a mixed-TTL write prices each portion at its own rate', () => {
  // 1M written, 400k of it at the 1h TTL. 600k at 3.75 = 2.25, 400k at 6 = 2.40.
  // Pricing the whole thing at 5m understates by 0.90; at 1h it overstates by 1.50.
  const priced = priceTokens({
    [SONNET]: { cache_creation: 1_000_000, cache_creation_1h: 400_000 },
  });
  assert.equal(priced.total_usd, 2.25 + 2.4);
});

test('ADDED: the raw usage bucket spellings are read directly when present', () => {
  // `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` are the API's own names,
  // and a producer that forwards the nested object flattened would use them. An
  // explicit 5m count is authoritative — nothing is derived when the record already
  // says what the split was.
  const priced = priceTokens({
    [SONNET]: { ephemeral_5m_input_tokens: 600_000, ephemeral_1h_input_tokens: 400_000 },
  });
  assert.equal(priced.total_usd, 2.25 + 2.4);
});

test('ADDED: a 1h portion larger than the total it belongs to is refused, not clamped', () => {
  // An inconsistent record, and the two convenient responses are both wrong: a negative
  // 5m portion subtracts real money from the total, and clamping to zero reports a
  // confident figure derived from a contradiction. Same rule as a non-numeric count —
  // price what is unambiguous, then say the total is incomplete.
  const priced = priceTokens({
    [SONNET]: { cache_creation: 400_000, cache_creation_1h: 1_000_000 },
  });
  assert.equal(priced.complete, false);
  assert.ok(priced.total_usd >= 6, 'the 1h portion is unambiguous and must still be charged');
});

test('ADDED: a record with no 1h counts is unaffected by the 1h column existing', () => {
  // The regression guard for the change itself: adding a column must not move any
  // existing figure. Arm 0's $1.12 is the anchor that would break first.
  const priced = priceTokens({
    [SONNET]: { input: 32, output: 10_742, cache_read: 2_110_234, cache_creation: 86_397 },
  });
  assert.equal(priced.total_usd.toFixed(2), '1.12');
});

test('ADDED: the table records that a 1h write was observed, not assumed impossible', () => {
  // The correction, written into the artifact rather than left in a commit message. A
  // future reader deciding whether to trust the 1h column needs to know it was measured.
  const table = loadPriceTable();
  assert.match(table.columns.cache_write_1h, /observed|measured|2x/i);
  assert.equal(
    /cannot happen/i.test(table.columns.cache_write_1h),
    false,
    'the disproved claim must not survive in the table',
  );
});

test('ADDED: every model row has the same five columns', () => {
  // The scheduled change is recorded OUTSIDE the rate rows, so no row carries extra
  // keys. A row shaped differently from its neighbours is how the `in`/`out` versus
  // `input`/`output` mismatch survived: a per-row shape means a lookup can be correct
  // on the row the test uses and wrong on the row production hits.
  const table = loadPriceTable();
  const expected = ['cache_read', 'cache_write', 'cache_write_1h', 'in', 'out'];
  for (const [id, row] of Object.entries(table.models)) {
    assert.deepEqual(Object.keys(row).sort(), expected, `${id} has a non-uniform row shape`);
  }
});

// --- ADDED: the copied table is a copy, and says so ---

test('ADDED: the copied table records where it was copied from', () => {
  // PLAN.md §1: values are copied, not linked, because a duplicated 60-line table is
  // cheaper than a coupling. The cost of that choice is drift, and the only defence
  // is provenance recorded in the copy itself — otherwise nobody can tell which
  // upstream revision these rates came from.
  const table = loadPriceTable();
  assert.ok(table.copied_from, 'the copy must name its source');
  assert.match(table.copied_from.version, /^\d{4}-\d{2}-\d{2}/);
});

test('ADDED: loadPriceTable reads no path outside alfred/', async () => {
  // The isolation rule as a property of this module specifically. prices.mjs is the
  // one file whose whole reason for existing is that it does NOT reach
  // harness-core/config/routing.json — eval/armcost.mjs is allowed to, lib/ is not.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../lib/prices.mjs', import.meta.url), 'utf8');
  const executable = src
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.equal(/harness-core|routing\.json/.test(executable), false);
});
