// The model-change protocol, as assertions rather than prose.
//
// WHY THIS FILE EXISTS. `docs/eval-readiness/2026-07-30-scorecard.md` §8 scored the
// protocol item **FAIL** — nothing written down — and then scored the six steps against
// what had already happened. Step 1 was already violated: `752f3b0` moved the seats to
// sonnet-5 *and* changed `prices.json`, `OUTPUT_CEILINGS`, the shared normalizer, and
// 278 lines of the price/model tests in ONE commit. Whether those 278 lines were a fix
// or a re-fit is now unanswerable from the history.
//
// A doc alone would not have caught that, and would not catch the next one. The
// scorecard's own §9 names the shape: *"a doc that says of itself 'these numbers are
// transcribed from the code' is the kind that rots unnoticed, because the sentence reads
// as a guarantee."* That sentence was false in `PLAN.md` §6 for a day (`99bdac3`).
//
// So the protocol lives in `lib/model-changes.mjs` as data, `docs/MODEL-CHANGES.md`
// explains it, and this file asserts the three things that must not silently drift:
//
//   1. THE MEASUREMENT LEDGER IS HONEST. Every headline number Alfred rests on names
//      the model it was taken on. A figure with no model attached is exactly arm A's
//      $0.617 problem, and the fix is to make the omission fail a test.
//   2. THE EXPIRY IS COMPUTED, NOT ASSERTED. A measurement taken on a model that is no
//      longer in the seat it was measured for is PROVISIONAL. Derived from SEATS at
//      import, so moving a seat re-derives it — the doc cannot claim freshness the code
//      does not have.
//   3. THE PROTOCOL'S STEPS ARE ORDERED AND CLOSED. Same rule as `blocked.mjs` REASONS
//      and `gaps.mjs` GAP_CODES: "did we follow step 3" has to be answerable by reading
//      a structure, not by grepping prose.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO: assert that a re-ablation has happened. It
// cannot — the re-ablation is task #46 and costs money. It asserts that the *staleness
// is declared*, which is the honest thing a test can hold. Marking the 4.7x fresh is
// what this file is here to prevent; making it fresh is not a test's job.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_STEPS,
  MEASUREMENTS,
  seatModelFor,
  measurementStatus,
  provisionalMeasurements,
} from '../lib/model-changes.mjs';
import { SEATS } from '../lib/models.mjs';

// --- 1. the ledger names its model ---

test('every recorded measurement names the model it was taken on', () => {
  assert.ok(MEASUREMENTS.length > 0, 'the ledger is empty — nothing to keep honest');

  for (const m of MEASUREMENTS) {
    assert.ok(
      typeof m.model === 'string' && m.model.trim() !== '',
      `measurement '${m.id}' has no model. This is arm A's $0.617 defect: a number in a ` +
        'file with no model stamp while the seats moved beneath it.',
    );
    assert.ok(
      typeof m.at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.at),
      `measurement '${m.id}' needs a YYYY-MM-DD date, got ${JSON.stringify(m.at)}`,
    );
    assert.ok(
      typeof m.seat === 'string' && m.seat.trim() !== '',
      `measurement '${m.id}' must name the SEAT it constrains — a measurement that ` +
        'constrains no seat cannot be expired by a seat move',
    );
    assert.ok(
      typeof m.claim === 'string' && m.claim.trim() !== '',
      `measurement '${m.id}' must state what it claims, or "is it still true" is unanswerable`,
    );
  }
});

test('the founding 4.7x/4.6x measurement is in the ledger, on sonnet-4-6', () => {
  // Verified from disk, not carried: test/fixtures/arm0-transcript.jsonl names
  // claude-sonnet-4-6 on all 72 of its model-bearing lines. This is the measurement
  // that killed phase orchestration (PLAN.md:14) and it is the one with the most
  // riding on it.
  const founding = MEASUREMENTS.find((m) => m.id === 'phase-orchestration-cost');
  assert.ok(founding, 'the 4.7x/4.6x is not in the ledger — the headline number is unstamped');
  assert.equal(founding.model, 'claude-sonnet-4-6');
});

test('every measurement names a seat that exists in SEATS', () => {
  // A measurement pinned to a seat name that was renamed away silently stops being
  // expirable: `seatModelFor` would find nothing to compare against, and the status
  // would read fresh forever.
  for (const m of MEASUREMENTS) {
    assert.ok(
      Object.hasOwn(SEATS, m.seat),
      `measurement '${m.id}' names seat '${m.seat}', which is not in SEATS. Either the ` +
        'seat was renamed (update the ledger) or the measurement is unanchored.',
    );
  }
});

// --- 2. expiry is derived from SEATS, not declared ---

test('a measurement whose seat still runs the model it was taken on is current', () => {
  const status = measurementStatus({
    id: 'x',
    model: SEATS.worker.model,
    seat: 'worker',
    at: '2026-07-30',
    claim: 'a claim',
  });
  assert.equal(status.provisional, false);
  assert.equal(status.measured_on, SEATS.worker.model);
  assert.equal(status.seat_now, SEATS.worker.model);
});

test('a measurement whose seat has moved to another model is provisional, and says which way', () => {
  const status = measurementStatus({
    id: 'y',
    model: 'claude-sonnet-4-6',
    seat: 'worker',
    at: '2026-07-30',
    claim: 'a claim',
  });
  assert.equal(status.provisional, true);
  assert.equal(status.measured_on, 'claude-sonnet-4-6');
  assert.equal(status.seat_now, SEATS.worker.model);
  assert.match(
    status.detail,
    /claude-sonnet-4-6/,
    'the detail must name the model the number was taken on — "stale" alone is not actionable',
  );
});

test('the 4.7x reads PROVISIONAL today, because the worker seat moved off sonnet-4-6', () => {
  // THE POINT OF THE WHOLE FILE. Not a hand-written "provisional: true" flag — a
  // derivation from SEATS. If someone moves the worker seat back to sonnet-4-6, this
  // test flips on its own, which is the behaviour a flag cannot have.
  const provisional = provisionalMeasurements();
  const ids = provisional.map((p) => p.id);
  assert.ok(
    ids.includes('phase-orchestration-cost'),
    `expected the founding measurement to read provisional; provisional set was ${JSON.stringify(ids)}`,
  );
});

test('seatModelFor throws on an unknown seat rather than defaulting', () => {
  // Same rule as ceilingFor: a defaulted answer here would silently mark a measurement
  // fresh, which is the one wrong answer with no error attached.
  assert.throws(() => seatModelFor('nonexistent'), /nonexistent/);
});

// --- 3. the steps are closed and ordered ---

test('the protocol is six ordered steps, and the order is the protocol', () => {
  // Order is load-bearing, not cosmetic: "freeze the suite" AFTER "add new cases" is
  // exactly the violation `752f3b0` committed. A set would lose that.
  assert.equal(PROTOCOL_STEPS.length, 6);
  for (let i = 0; i < PROTOCOL_STEPS.length; i += 1) {
    assert.equal(PROTOCOL_STEPS[i].step, i + 1, 'steps must be numbered 1..6 in array order');
  }
  assert.match(PROTOCOL_STEPS[0].title, /[Ff]reeze/, 'step 1 is freeze-the-suite');
  assert.match(PROTOCOL_STEPS[5].title, /add|new case/i, 'step 6 is add-new-cases, and it is LAST');
});

test('each step says what it forbids, not only what to do', () => {
  // A step that only says "re-calibrate routing" is unfollowable under pressure. The
  // forbidden half is the half that gets skipped, and it is what #43 exists to write
  // down BEFORE arm C rather than discover while scoring it.
  for (const s of PROTOCOL_STEPS) {
    assert.ok(
      typeof s.forbids === 'string' && s.forbids.trim() !== '',
      `step ${s.step} ('${s.title}') states no prohibition`,
    );
  }
});

test('the steps are frozen, so a step cannot be edited out at the point of use', () => {
  assert.ok(Object.isFrozen(PROTOCOL_STEPS));
  assert.throws(() => {
    PROTOCOL_STEPS.push({ step: 7, title: 'skip it' });
  });
});
