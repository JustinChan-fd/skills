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

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priceByModel, decideKill, THRESHOLDS, parseEtimeMs, transcriptsFor } from '../eval/armcost.mjs';

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

// --- 5. a subagent's transcript is part of the arm's spend ---
//
// The watchdog priced arm B at $1.072 while its true cost was $16.03 — a factor of
// 15. `transcriptsFor` listed only the top level of each project dir, and every
// phase driver's transcript lives one level down in `<session-id>/subagents/`.
//
// The cap was $18. The watchdog would have reported $1.10 at $18.00 spent, so the
// spend cap could not fire at all — the same class as §2.7's reset wall clock and
// §2.5's inert stall detector: THE GUARD WAS GREEN AND BLIND.
//
// `transcriptsFor` was a private function inside watch.mjs, which is precisely why
// this shipped: nothing could test it. It is exported now so this test can exist.
test('transcripts are collected recursively, so subagent spend is not invisible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'armcost-txn-'));
  const proj = join(root, 'exp2-armX-sandbox-a');
  await mkdir(join(proj, 'sess-1', 'subagents'), { recursive: true });
  await writeFile(join(proj, 'sess-1.jsonl'), '{}\n');
  await writeFile(join(proj, 'sess-1', 'subagents', 'agent-aaa.jsonl'), '{}\n');
  await writeFile(join(proj, 'sess-1', 'subagents', 'agent-bbb.jsonl'), '{}\n');

  const found = transcriptsFor('armX', { projectsDir: root });

  assert.equal(found.length, 3, `expected the loop transcript AND both subagents, got ${found.length}`);
  assert.ok(found.some((f) => f.endsWith('agent-aaa.jsonl')));
  assert.ok(found.some((f) => f.endsWith('agent-bbb.jsonl')));
  await rm(root, { recursive: true, force: true });
});

test('another arm transcripts are never priced into this arm', async () => {
  // The dir filter is what keeps the two arms' costs independent. Recursing must not
  // widen it — a recursive walk from the projects root would price every arm as one.
  const root = await mkdtemp(join(tmpdir(), 'armcost-txn-'));
  await mkdir(join(root, 'exp2-armX-sandbox-a'), { recursive: true });
  await mkdir(join(root, 'exp2-armY-sandbox-a', 'sess-9', 'subagents'), { recursive: true });
  await writeFile(join(root, 'exp2-armX-sandbox-a', 'mine.jsonl'), '{}\n');
  await writeFile(join(root, 'exp2-armY-sandbox-a', 'sess-9', 'subagents', 'theirs.jsonl'), '{}\n');

  const found = transcriptsFor('armX', { projectsDir: root });

  assert.equal(found.length, 1);
  assert.ok(found[0].endsWith('mine.jsonl'));
  await rm(root, { recursive: true, force: true });
});

test('a non-jsonl file in a subagents dir is not priced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'armcost-txn-'));
  const sub = join(root, 'exp2-armX-sandbox-a', 'sess-1', 'subagents');
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, 'agent-aaa.jsonl'), '{}\n');
  await writeFile(join(sub, 'agent-aaa.output'), 'not a transcript\n');

  const found = transcriptsFor('armX', { projectsDir: root });

  assert.equal(found.length, 1);
  assert.ok(found[0].endsWith('.jsonl'));
  await rm(root, { recursive: true, force: true });
});

// --- 4. the price table this file reads is ALFRED'S decided table, not the upstream one ---
//
// #59, found by comparing a live arm C figure against the CLI's own total. The run
// recorded usd 1.974173; Alfred's config/prices.json over the same usage computes
// 2.961259, which matches the CLI's self-reported total_cost_usd (2.96125875) to seven
// decimals. Ratio exactly 1.5 — the $2/$10 introductory sonnet-5 rate against the
// $3/$15 decided one.
//
// WHY 25 GREEN TESTS ABOVE DID NOT SEE IT: every one of them prices `claude-sonnet-4-6`,
// whose rate is $3/$15 in BOTH tables because it has no introductory period. The tests
// agreed with the wrong table on the one model where the two tables agree. The seat
// Alfred actually runs — sonnet-5 — is the only row where they differ, and no test
// priced it. That is the mocked-seam shape one level out: the fixture chose the input
// on which the defect is invisible.
//
// Two propositions, deliberately separate, because a single assertion on the dollar
// figure would pass if the reporting were fixed and the KILL SWITCH left reading the
// old table:
//
//   4a. the reported figure uses the decided rate
//   4b. the kill threshold is compared against that same figure
//
// 4a alone is a reporting bug. 4a + 4b is a spend-control bug: the $8/run cap enforced
// against a 1.5x-understated number is really a $12 cap.

import { readFileSync as _readFileSync } from 'node:fs';

const ALFRED_TABLE = JSON.parse(
  _readFileSync(new URL('../config/prices.json', import.meta.url), 'utf8'),
);

// Run 1's real usage, from docs/exp2-evidence/armC1-worker.json. Real counts rather
// than round numbers so the assertion is against a figure that was actually billed.
const RUN1_USAGE = Object.freeze({
  input: 160_302,
  output: 71_615,
  cache_read: 3_363_605,
  cache_creation: 105_879,
});

test('sonnet-5 is priced at the decided $3/$15, not the introductory $2/$10', () => {
  const { by_model, price_table_version } = priceByModel({ 'claude-sonnet-5': RUN1_USAGE });
  const rates = ALFRED_TABLE.models['claude-sonnet-5'];
  assert.equal(rates.in, 3, 'guard: the decided table must carry the $3 input rate');

  const expected =
    (RUN1_USAGE.input * rates.in +
      RUN1_USAGE.output * rates.out +
      RUN1_USAGE.cache_read * rates.cache_read +
      RUN1_USAGE.cache_creation * rates.cache_write) /
    1e6;

  // The CLI's own figure for this exact run, to seven decimals. An independent oracle:
  // it is not computed from either table.
  assert.equal(Math.round(expected * 1e6) / 1e6, 2.961259);
  assert.equal(
    by_model['claude-sonnet-5'].usd.toFixed(6),
    expected.toFixed(6),
    'armcost priced sonnet-5 off a different table than config/prices.json',
  );
  assert.equal(price_table_version, ALFRED_TABLE.version);
});

test('the run spend cap is enforced against the decided rate, so $8 means $8', () => {
  // Usage scaled so the DECIDED rate lands just over the $8 cap and the introductory
  // rate lands just under it. Reading the wrong table turns this kill into a pass.
  const scale = 2.9;
  const usage = Object.fromEntries(
    Object.entries(RUN1_USAGE).map(([k, v]) => [k, Math.round(v * scale)]),
  );
  const { total_usd } = priceByModel({ 'claude-sonnet-5': usage });
  const cap = THRESHOLDS.armC.spendCapUsd;

  assert.ok(total_usd > cap, `priced at $${total_usd.toFixed(2)}, which must exceed the $${cap} cap`);
  assert.ok(total_usd / 1.5 < cap, 'guard: the introductory rate must NOT trip this cap');
  assert.equal(decideKill({ usd: total_usd, spendCapUsd: cap, sinceProgressMs: 0, stallMs: 1e9 }).cause, 'spend');
});

// --- 5. #59, part two: the gateway id form, and one normalizer instead of three ---
//
// The collector happens to emit bare `claude-sonnet-5`, so this is not a demonstrated
// live-path break — run 1 priced non-null. It is the same shape of defect one level out:
// a table lookup that works only for the spelling the fixtures use. `lib/prices.mjs`
// already exports a normalizer that strips the prefix, the `-vN` suffix AND the date, and
// eval/ is allowed to import lib/ (only the reverse is forbidden). A third private copy
// here is the two-copies drift of task #38 reintroduced.

test('gateway-prefixed and versioned ids price the same as the bare id', () => {
  const usage = { input: 1_000_000, output: 1_000_000 };
  const bare = priceByModel({ 'claude-sonnet-5': usage });

  for (const id of [
    'anthropic.claude-sonnet-5',
    'anthropic.claude-sonnet-5-v1:0',
    'claude-sonnet-5-20260601',
  ]) {
    const got = priceByModel({ [id]: usage });
    assert.deepEqual(got.unpriced, [], `${id} did not resolve to a priced row`);
    assert.equal(got.total_usd, bare.total_usd, `${id} priced differently from the bare id`);
  }
});
