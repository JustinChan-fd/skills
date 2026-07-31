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
import { existsSync } from 'node:fs';

import {
  PROTOCOL_STEPS,
  MEASUREMENTS,
  ROUTING_SURFACE,
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

// --- 1b. the ledger's citations resolve ---
//
// #49. `source` is the field that makes a ledger entry checkable by a human: it is where
// you go to see whether the claim says what the ledger says it says. Nothing verified the
// paths existed, so a citation could point at a file that had been moved, renamed or
// deleted and still READ as evidence. That is #48's phantom-mechanism shape one level
// down — the defect is not a wrong number, it is a reference that looks like support and
// leads nowhere.
//
// This was not hypothetical. `arm-a-baseline-cost` cited `docs/exp2-armA-score.md`, which
// was a byte-identical stray copy of `docs/exp2-evidence/armA-score.md` (md5 b68cab74…,
// added first at `a940b86`, copied into the evidence dir at `c6bc1c5`). De-duplicating to
// the canonical evidence dir deletes the cited path, and before this test nothing would
// have noticed the ledger now pointing at nothing.
//
// WHAT IT DOES NOT CHECK: that the file says what the claim says. No test can hold that —
// the same limit as `MEASUREMENTS` itself, which records that a number was measured, not
// that it was measured correctly. This holds the weaker, mechanical property: the reader
// following a citation lands on a file that exists.
test('every source a measurement cites resolves to a file on disk', () => {
  assert.ok(MEASUREMENTS.length > 0, 'the ledger is empty — nothing to resolve');

  // Citations carry human locators — `docs/PLAN.md §9`, `…RESULTS.md:223-236` — which are
  // part of the value to a reader and not part of the path. Strip only those two forms;
  // anything else left in the string is meant to be a path and gets checked as one.
  const toPath = (raw) => raw.trim().replace(/\s+§.*$/, '').replace(/:\d+(-\d+)?$/, '');

  for (const m of MEASUREMENTS) {
    assert.ok(
      typeof m.source === 'string' && m.source.trim() !== '',
      `measurement '${m.id}' cites no source, so its claim cannot be checked by hand`,
    );

    let checked = 0;
    for (const raw of m.source.split(';')) {
      const rel = toPath(raw);
      if (rel === '') continue;
      checked += 1;
      assert.ok(
        existsSync(new URL(`../${rel}`, import.meta.url)),
        `measurement '${m.id}' cites '${rel}', which does not exist. A citation that ` +
          'leads nowhere reads as evidence and is not — either the file moved (repoint ' +
          'the ledger) or the evidence is gone and the claim is now unsupported.',
      );
    }

    // PER MEASUREMENT, not across the ledger. The first version of this counted globally
    // and a falsification pass caught it passing on `source: ';;'` — five real paths from
    // the other two entries cleared the aggregate threshold while THIS entry contributed
    // none. That is the unfalsifiable conjunct: one counter answering two questions, so a
    // measurement with no checkable citation hid behind its neighbours' citations.
    assert.ok(
      checked > 0,
      `measurement '${m.id}' has a non-empty source that yields no path (${JSON.stringify(m.source)}). ` +
        'Separators without citations read as sourced and are not.',
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

// --- 4. step 4's recalibration surface: HELD is a decision, not a silence ---
//
// ADDED 2026-07-30 (#48), correcting #43. Step 4's own `alfred` text claimed *"the
// size->tier thresholds have not been reviewed against sonnet-5; that review is unclaimed
// work."* That named a mechanism which does not exist. Measured:
//
//   LC_ALL=C grep -rn "size" alfred/lib/ alfred/config/   ->  3 hits, all prose, none a
//                                                             mechanism
//
// The S/M/L axis is `harness-core`'s (`config/routing.json`: `sizes` -> per-size budgets,
// plus `tiers` -> `model_id_to_tier`), and even there it is not a threshold: `size` is a
// judgment an LLM writes at intake from stated heuristics, then passed into
// `sizeBudgets(routing, size)`. Alfred routes by SEAT — the kind of job — with no size
// input at all, which is a divergence rather than an omission.
//
// That mattered more than a wording fix. Step 4 is the one step whose compliance was
// UNCHECKABLE: `token_budget` being "deliberately unchanged" across the sonnet-5 move is
// the single most load-bearing recalibration decision in the repo, and it lived only in a
// comment. Step 4 forbids *"raising a `token_budget` because the context grew"* — so the
// prohibition and the evidence it was honored were in the same unenforced prose.
//
// ROUTING_SURFACE fixes that by making HELD an explicit, recorded decision. The property
// these tests hold is NOT that the recalibration was correct — no test can hold that, the
// same limit MEASUREMENTS has. It is that every knob a model change could require moving
// has a recorded decision naming which way it went and why, so a silent move is a test
// failure rather than a diff nobody reads.

test('every routing knob records whether the model move MOVED or HELD it', () => {
  assert.ok(ROUTING_SURFACE.length > 0, 'the surface is empty — step 4 has nothing to check');

  for (const k of ROUTING_SURFACE) {
    assert.ok(
      k.decision === 'moved' || k.decision === 'held',
      `knob '${k.id}' records decision '${k.decision}'; a knob with no decision is the ` +
        'unenforced-comment state #48 exists to end',
    );
    assert.ok(
      typeof k.why === 'string' && k.why.trim() !== '',
      `knob '${k.id}' is '${k.decision}' for no stated reason. "Held" without a reason is ` +
        'indistinguishable from "forgotten", which is the whole failure mode.',
    );
  }
});

test('holding a knob is recorded against the release that could have moved it', () => {
  // A decision with no release attached cannot expire. This is the same property
  // `measurementStatus` derives for numbers, applied to tunables: "held" is a statement
  // about a specific model move, not a permanent posture.
  //
  // The non-emptiness guard is not decoration. A `for` loop over an empty array passes,
  // so without it this test would have been GREEN against the stub `ROUTING_SURFACE = []`
  // — reporting "every knob names a release" about zero knobs. That is the
  // green-and-blind shape this repo has already been bitten by.
  assert.ok(ROUTING_SURFACE.length > 0, 'the surface is empty — this test would pass blind');

  for (const k of ROUTING_SURFACE) {
    assert.ok(
      typeof k.at_release === 'string' && k.at_release.trim() !== '',
      `knob '${k.id}' names no release, so nothing can ever make its decision stale`,
    );
  }
});

test('every threshold-bearing seat field is covered by the surface', () => {
  // The test that makes this enforcement rather than documentation: add a tunable to a
  // seat without recording its recalibration decision and THIS fails. Without it,
  // ROUTING_SURFACE is one more list that goes stale — which is `PLAN.md` §6's exact
  // history (silently stale for a day at `99bdac3`).
  const TUNABLE = ['model', 'max_tokens', 'token_budget'];
  const covered = new Set(ROUTING_SURFACE.map((k) => k.field));

  for (const field of TUNABLE) {
    assert.ok(
      covered.has(field),
      `no knob covers the seat field '${field}'. Every quantity a model change can ` +
        'require recalibrating needs a recorded decision, or step 4 is unfollowable.',
    );
  }

  // And the reverse direction: a knob naming a field no seat has is a leftover.
  const seatFields = new Set(Object.values(SEATS).flatMap((s) => Object.keys(s)));
  for (const k of ROUTING_SURFACE) {
    assert.ok(
      seatFields.has(k.field),
      `knob '${k.id}' names field '${k.field}', which no seat in SEATS carries. This is ` +
        'the phantom-mechanism defect #48 corrects — a knob for something that is not there.',
    );
  }
});

test('token_budget is recorded as HELD, and the reason names spend rather than context', () => {
  // The one decision most likely to be quietly undone, because undoing it looks like an
  // upgrade. sonnet-5 has 5x the context of sonnet-4-6; the tempting move is to raise the
  // cap alongside it, which is step 4's named prohibition and re-creates the $11.98 run.
  const knob = ROUTING_SURFACE.find((k) => k.field === 'token_budget');
  assert.ok(knob, 'token_budget has no recorded decision');
  assert.equal(knob.decision, 'held');
  assert.match(
    knob.why,
    /spend|cap|\$11\.98/i,
    'the reason for holding token_budget must rest on spend. "The context grew" is the ' +
      'argument step 4 forbids, and it is the argument that sounds most reasonable.',
  );
});

test('the surface does not claim a size axis Alfred does not have', () => {
  // Guards the specific error #48 corrects, in the file that made it. #43's step 4 text
  // named "size->tier thresholds"; grep proves Alfred has no size mechanism in lib/ or
  // config/. A protocol that points at a mechanism which does not exist is worse than one
  // that says nothing: it reads as covered.
  const step4 = PROTOCOL_STEPS.find((s) => s.step === 4);
  assert.doesNotMatch(
    step4.alfred,
    /size->tier|size-to-tier|size→tier/i,
    'step 4 still cites size->tier thresholds. Alfred routes by seat; the S/M/L axis is ' +
      'harness-core\'s, and is an LLM judgment there rather than a threshold.',
  );
});

test('routing decisions are frozen, so a knob cannot be re-decided at the point of use', () => {
  // Same reason as the release test above: `Object.freeze([])` is frozen, so the per-knob
  // half of this assertion is unreachable on an empty surface. Two propositions ("the
  // array is frozen" and "each knob is frozen") must not hide behind one pass.
  assert.ok(ROUTING_SURFACE.length > 0, 'the surface is empty — the per-knob check is unreachable');
  assert.ok(Object.isFrozen(ROUTING_SURFACE));
  for (const k of ROUTING_SURFACE) {
    assert.ok(Object.isFrozen(k), `knob '${k.id}' is not frozen`);
  }
  assert.throws(() => {
    ROUTING_SURFACE.push({ id: 'smuggled', field: 'model', decision: 'moved' });
  });
});
