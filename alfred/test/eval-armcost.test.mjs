// armcost — price a transcript mid-flight so a runaway arm can be killed on evidence.
//
// This is eval scaffolding (eval/, not lib/): it reaches harness-core for the price
// table and the already-tested collector, because re-deriving either would mean the
// kill decision rests on a second, unvalidated implementation of the arithmetic. The
// collector in particular carries the message.id dedupe fix — without it every figure
// here would be ~2.2x inflated, which on a $6 kill threshold means killing a healthy
// arm at its true $2.70.
//
// Three propositions, kept separate:
//
//   1. Cost is priced per model from the recorded table, with cache columns distinct.
//   2. An unpriceable model is reported as unpriced — never as $0, never as NaN.
//   3. A kill decision names WHICH threshold fired, and does not fire on a healthy arm.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { priceByModel, decideKill, THRESHOLDS, parseEtimeMs } from '../eval/armcost.mjs';

// Rates from harness-core/config/routing.json v2026-07-29.1, sonnet-4-6:
// in 3, out 15, cache_read 0.3, cache_write 3.75 (per Mtok).
const SONNET = 'claude-sonnet-4-6';

// --- 1. pricing ---

test('cost is priced per model with each cache column at its own rate', () => {
  // 1M of each direction, so every rate appears in the total undivided and a swapped
  // column would be visible rather than absorbed.
  const { total_usd, by_model } = priceByModel({
    [SONNET]: { in: 1_000_000, out: 1_000_000, cache_read: 1_000_000, cache_creation: 1_000_000 },
  });
  assert.equal(by_model[SONNET].usd, 3 + 15 + 0.3 + 3.75);
  assert.equal(total_usd, 22.05);
});

test('cache_read is priced at a tenth of input, not at input', () => {
  // The column that dominates real runs: arm 0's cache_read was 95.6% of its tokens.
  // Pricing it at the input rate would inflate every total by ~10x on that column and
  // trip the kill threshold in the first minute.
  const { total_usd } = priceByModel({ [SONNET]: { cache_read: 2_110_234 } });
  assert.equal(Math.round(total_usd * 10000) / 10000, 0.6331);
});

test('a dated model id prices the same as its base id', () => {
  const dated = priceByModel({ 'claude-haiku-4-5-20251001': { out: 1_000_000 } });
  const base = priceByModel({ 'claude-haiku-4-5': { out: 1_000_000 } });
  assert.equal(dated.total_usd, base.total_usd);
  assert.deepEqual(dated.unpriced, []);
});

test('missing directions count as zero rather than throwing', () => {
  // Real by_model entries omit directions that never occurred.
  const { total_usd } = priceByModel({ [SONNET]: { out: 1_000_000 } });
  assert.equal(total_usd, 15);
});

test('the price table version is reported alongside the figures', () => {
  // §3 control 2: one price table version stamped in the result. A cost number with
  // no table version cannot be re-priced later, and rates change.
  const { price_table_version } = priceByModel({ [SONNET]: { out: 1000 } });
  assert.match(price_table_version, /^\d{4}-\d{2}-\d{2}/);
});

test('the collector\'s real key spelling is priced — input/output, not in/out', () => {
  // THE DEFECT THIS FILE WAS WRITTEN WITH. PLAN.md §9 lists "`in`/`out` vs
  // `input`/`output` key mismatch" as a known past failure, and the first draft of
  // armcost.mjs mapped only `in`/`out` — so on a real transcript both non-cache
  // directions priced at $0 while the tests stayed green, because the fixtures above
  // used the wrong spelling. A fixture that does not match the producer's output is
  // not a test of the producer.
  //
  // These are arm 0's actual recorded counts (HANDOFF §1), and HANDOFF records the
  // cost as $1.12. That number is the calibration: it is what makes the kill
  // threshold mean something.
  const priced = priceByModel({
    [SONNET]: { input: 32, output: 10_742, cache_read: 2_110_234, cache_creation: 86_397 },
  });
  assert.equal(priced.total_usd.toFixed(2), '1.12');
});

test('both key spellings price identically, so neither producer is silently dropped', () => {
  const short = priceByModel({ [SONNET]: { in: 1000, out: 2000 } });
  const long = priceByModel({ [SONNET]: { input: 1000, output: 2000 } });
  assert.equal(short.total_usd, long.total_usd);
  assert.ok(long.total_usd > 0, 'a non-zero token count must not price at $0');
});

test('a count present under both spellings is not double-billed', () => {
  // Accepting two spellings introduces the opposite risk: summing both. A transcript
  // carrying either one must cost the same as a transcript carrying just that one.
  const both = priceByModel({ [SONNET]: { out: 1_000_000, output: 1_000_000 } });
  assert.equal(both.total_usd, 15);
});

// --- 2. an unknown model is unpriced, not free ---

test('an unpriced model is named rather than silently costing zero', () => {
  // The failure this prevents: a model absent from the table contributing $0, so a
  // runaway arm reads as cheap and never trips the threshold. Zero is the most
  // dangerous default here, because it is indistinguishable from "did nothing".
  const priced = priceByModel({ 'claude-future-9': { out: 5_000_000 } });
  assert.deepEqual(priced.unpriced, ['claude-future-9']);
  assert.equal(priced.complete, false);
});

test('a total is never NaN even when one model is unpriced', () => {
  // The `$NaN` failure mode already recorded in PLAN.md §9. A NaN total compares
  // false against every threshold, so the kill switch silently stops working.
  const priced = priceByModel({
    [SONNET]: { out: 1_000_000 },
    'claude-future-9': { out: 5_000_000 },
  });
  assert.equal(Number.isNaN(priced.total_usd), false);
  assert.equal(priced.total_usd, 15);
  assert.equal(priced.complete, false);
});

test('an all-known set reports complete', () => {
  assert.equal(priceByModel({ [SONNET]: { out: 10 } }).complete, true);
});

// --- 3. the kill decision ---

test('a healthy arm under both thresholds is not killed', () => {
  const d = decideKill({ usd: 1.2, spendCapUsd: 6, sinceProgressMs: 60_000, stallMs: 900_000 });
  assert.equal(d.kill, false);
  assert.equal(d.reason, null);
});

test('exceeding the spend cap kills and names spend as the cause', () => {
  const d = decideKill({ usd: 6.01, spendCapUsd: 6, sinceProgressMs: 0, stallMs: 900_000 });
  assert.equal(d.kill, true);
  assert.equal(d.cause, 'spend');
  assert.match(d.reason, /6\.01.*6/s);
});

test('exceeding the stall window kills and names stall as the cause', () => {
  // Separate cause strings, not one boolean. "It was killed" without which threshold
  // fired makes the result unusable: a spend kill says the arm is expensive, a stall
  // kill says it is stuck, and those are different findings about the topology.
  const d = decideKill({ usd: 0.5, spendCapUsd: 6, sinceProgressMs: 900_001, stallMs: 900_000 });
  assert.equal(d.kill, true);
  assert.equal(d.cause, 'stall');
  assert.match(d.reason, /stall/i);
});

test('when both thresholds are exceeded, spend is reported as the cause', () => {
  // Deterministic precedence rather than whichever check runs first: money already
  // spent is the fact, a stall is an inference from silence.
  const d = decideKill({ usd: 99, spendCapUsd: 6, sinceProgressMs: 10 ** 9, stallMs: 900_000 });
  assert.equal(d.cause, 'spend');
});

test('the boundary is exclusive: exactly at the cap is not a kill', () => {
  // Otherwise a threshold set to the expected cost kills the expected run.
  assert.equal(decideKill({ usd: 6, spendCapUsd: 6, sinceProgressMs: 0, stallMs: 900_000 }).kill, false);
  assert.equal(
    decideKill({ usd: 0, spendCapUsd: 6, sinceProgressMs: 900_000, stallMs: 900_000 }).kill,
    false,
  );
});

// --- 4. elapsed time is the ARM's, not the watcher's ---
//
// The watchdog died with a session while arm B was still running, and restarting it
// reset `wall=` to 0m. The pre-registered bound is 90 minutes of ARM wall clock; a
// clock that restarts with the watcher can never reach it, so the cap silently stops
// being a cap. Third instance this session of a guard that is green and blind.
//
// `ps -o etime=` is the arm's own age and survives any number of watcher restarts.

test('etime is parsed as mm:ss', () => {
  assert.equal(parseEtimeMs('39:39'), (39 * 60 + 39) * 1000);
});

test('etime is parsed as hh:mm:ss', () => {
  assert.equal(parseEtimeMs('1:30:00'), 90 * 60 * 1000);
});

test('etime is parsed as dd-hh:mm:ss', () => {
  // Real reading from this machine's long-lived processes. A parser that misreads the
  // day field understates a multi-day age by orders of magnitude.
  assert.equal(parseEtimeMs('05-09:17:58'), ((5 * 24 + 9) * 3600 + 17 * 60 + 58) * 1000);
});

test('an unreadable etime is null, never zero', () => {
  // Zero would read as "just started" and reset the wall cap on every poll — exactly
  // the failure being fixed. Null is the caller's signal to fall back.
  assert.equal(parseEtimeMs(''), null);
  assert.equal(parseEtimeMs('   '), null);
  assert.equal(parseEtimeMs(undefined), null);
  assert.equal(parseEtimeMs('garbage'), null);
});

test('a 91-minute-old arm is over its 90-minute wall cap', () => {
  // The proposition the fix exists for, stated in arm B's own terms.
  assert.equal(parseEtimeMs('1:31:00') > THRESHOLDS.armB.wallCapMs, true);
  assert.equal(parseEtimeMs('1:29:00') > THRESHOLDS.armB.wallCapMs, false);
});

test('the pre-registered thresholds are recorded as constants, not passed ad hoc', () => {
  // Pre-registration: the numbers exist before the runs and are readable afterwards.
  // A threshold chosen mid-run is a threshold chosen to justify a kill.
  assert.equal(typeof THRESHOLDS.stallMs, 'number');
  assert.ok(THRESHOLDS.stallMs > 0);
  assert.equal(typeof THRESHOLDS.armA.spendCapUsd, 'number');
  assert.equal(typeof THRESHOLDS.armB.spendCapUsd, 'number');
  // Arm B is expected to cost ~5x arm A (§3's ~$1-2 vs ~$5-6), so an identical cap
  // would either kill arm B at its expected cost or let arm A run 5x over.
  assert.ok(THRESHOLDS.armB.spendCapUsd > THRESHOLDS.armA.spendCapUsd);
});
