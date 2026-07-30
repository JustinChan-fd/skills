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

test('ADDED: sonnet-5 before its step-up date prices at the introductory rate', () => {
  const priced = priceTokens({ 'claude-sonnet-5': { out: 1_000_000 } }, { at: '2026-08-15' });
  assert.equal(priced.total_usd, 10);
});

test('ADDED: sonnet-5 after its step-up date prices at the standard rate', () => {
  // The assertion that would have caught a September figure reported as August's.
  const priced = priceTokens({ 'claude-sonnet-5': { out: 1_000_000 } }, { at: '2026-09-01' });
  assert.equal(priced.total_usd, 15);
});

test('ADDED: an undated call names the models whose rate is scheduled to change', () => {
  // No wall-clock read inside prices.mjs — a cost function that consults `now()` is
  // not a pure function of its inputs, and the same record would re-price differently
  // tomorrow. So an undated call uses the current-as-of-table rates and CARRIES ITS
  // OWN CAVEAT: the affected ids are listed, so a stale figure is self-identifying
  // instead of merely plausible.
  const priced = priceTokens({ 'claude-sonnet-5': { out: 1_000_000 } });
  assert.equal(priced.total_usd, 10);
  assert.deepEqual(priced.rate_change_pending, ['claude-sonnet-5']);
});

test('ADDED: a model with no scheduled change reports no pending caveat', () => {
  // Otherwise the caveat appears on every run and stops carrying information.
  assert.deepEqual(priceTokens({ [SONNET]: { out: 10 } }).rate_change_pending, []);
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
