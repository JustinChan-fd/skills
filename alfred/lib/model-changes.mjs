// model-changes — the protocol for what happens when a new model ships, plus the
// ledger of measurements that a model move can expire.
//
// See `docs/MODEL-CHANGES.md` for the argument. This file is the part a test can hold.
//
// WHY THIS IS CODE AND NOT ONLY A DOC. The audit's Section 8 item reads: *"an
// undocumented protocol is one that gets skipped under time pressure."* True, and
// insufficient — this project has now watched a *documented* claim rot twice
// (`PLAN.md` §6's seat table, stale for a day at `99bdac3`; `prices.json`'s "cannot
// happen" cache column, false as measured at `752f3b0`). Prose asserts; only a test
// checks. So the protocol's steps are a frozen ordered list, and the measurements it
// governs are a ledger whose staleness is DERIVED from `SEATS` rather than declared.
//
// The derivation is the whole design. A hand-written `provisional: true` flag would be
// one more string to forget to update. `measurementStatus` compares the model a number
// was taken on against the model that seat runs *now*, so moving a seat re-dates every
// measurement pinned to it, in the same commit, without anyone remembering to.

import { SEATS } from './models.mjs';

// The six steps, verbatim in intent from the audit's Section 8, adapted in two ways:
// each step carries what it FORBIDS (the half that gets skipped under pressure), and
// each carries `alfred`, which is what the step means for this repo specifically —
// including where we have already violated it.
//
// ORDER IS THE PROTOCOL. Step 6 after step 1 is the difference between a measurement
// and a re-fit: `752f3b0` added 278 lines of price/model tests in the same commit that
// moved the model, and whether those lines were a fix or a re-fit is now unanswerable
// from the history. That is step 1 and step 6 performed simultaneously.
export const PROTOCOL_STEPS = Object.freeze([
  Object.freeze({
    step: 1,
    title: 'Freeze the suite. Run it unchanged. That is the reported number.',
    forbids:
      'Adding or editing a case in the same commit as a model swap. The suite is the ' +
      'control variable; if it moves with the model, neither number means anything.',
    alfred:
      'Already violated once, at `752f3b0`: the seat move shipped with `prices.json`, ' +
      'the shared normalizer, `OUTPUT_CEILINGS` and 278 test lines in one commit. The ' +
      'suite version stamp (#42, `config/suite.json`) is what makes the next freeze ' +
      'checkable rather than promised — a result carries the digest it was scored against.',
  }),
  Object.freeze({
    step: 2,
    title: 'Read the new failure shapes. New models fail differently, not merely less.',
    forbids:
      'Concluding "it got better" from a higher score. A score that rises while the ' +
      'failure mode changes is two facts reported as one.',
    alfred:
      'Not yet possible: no run exists after `752f3b0`. Arm C is the first, which is ' +
      'why its results doc must declare the seam (EXPERIMENT-2.md §5) rather than ' +
      'discover it while scoring.',
  }),
  Object.freeze({
    step: 3,
    title: 'Handle saturation: demote to a regression floor, never delete.',
    forbids:
      'Deleting a case everything now passes, and leaving a saturated case in the ' +
      'headline where it inflates the average.',
    alfred:
      '`sandbox-a` is already exactly this, for a different reason: M4\'s gate tests ' +
      'and its trap manifest landed in one commit (`e86cd48`), so the gate catches ' +
      'those traps because it was written against them. It is the right thing to run ' +
      'the gate against and the wrong thing to grade the gate on — a regression floor. ' +
      'The policy is in `docs/SANDBOX.md` §9.',
  }),
  Object.freeze({
    step: 4,
    title: 'Re-calibrate routing. The evals stay put; the thresholds move.',
    forbids:
      'Moving a threshold and an eval case together, which makes the recalibration ' +
      'unmeasurable. Also: raising a `token_budget` because the context grew.',
    alfred:
      '`OUTPUT_CEILINGS` moved 64k -> 128k for the reasoning seats on this release, and ' +
      '`token_budget` was deliberately left alone — more context is a reason to watch ' +
      'spend more closely, not less, or the $11.98 lesson gets undone while looking ' +
      'like an upgrade (`lib/models.mjs`). The size->tier thresholds themselves have ' +
      'not been reviewed against sonnet-5; that review is unclaimed work.',
  }),
  Object.freeze({
    step: 5,
    title: 'Re-ablate the layers suspected of compensating for model weakness.',
    forbids:
      'Citing an ablation result measured on a superseded model as current. A phase ' +
      'worth +12 points on a weaker model may be worth +1 now at identical cost.',
    alfred:
      'This is the step with the most riding on it and it puts an expiry on our own ' +
      'founding number. The 4.7x/4.6x that killed phase orchestration was measured on ' +
      'sonnet-4-6 (verified: `test/fixtures/arm0-transcript.jsonl` names it on all 72 ' +
      'model-bearing lines). The correct posture is PROVISIONAL PENDING RE-ABLATION, ' +
      'and `provisionalMeasurements()` derives that from `SEATS` so it cannot be ' +
      'quietly re-marked as settled. The re-ablation itself is task #46.',
  }),
  Object.freeze({
    step: 6,
    title: 'Then add new cases for the failure modes just discovered.',
    forbids:
      'Doing this before step 1. Adding a case for a failure the new model exhibits, ' +
      'in the run that measures the new model, is fitting the ruler to the result.',
    alfred:
      'Additive-only, per `docs/SANDBOX.md` §9: fixtures grow, they do not get edited, ' +
      'and a new case bumps `config/suite.json`\'s version so old results stay readable ' +
      'as having been scored against the older suite.',
  }),
]);

// The measurement ledger.
//
// Every headline number Alfred's design rests on, with the model it was taken on. This
// exists because `EXPERIMENT-2-RESULTS.md` carries no model stamp at all: arm A's
// $0.617 sits in a file that never says which model produced it, and the seats moved
// the same day. `at` is the measurement date, not the write date.
//
// `seat` is what makes a measurement expirable. A number is stale when the seat it
// constrains no longer runs the model the number was taken on — so the ledger pins each
// measurement to a seat, and `SEATS` does the dating.
export const MEASUREMENTS = Object.freeze([
  Object.freeze({
    id: 'phase-orchestration-cost',
    claim:
      'Four-phase orchestration cost 4.7x the tokens, 4.6x the dollars and 6.8x the ' +
      'wall clock of one bare context on TARS-1339, and did not ship a PR.',
    model: 'claude-sonnet-4-6',
    seat: 'worker',
    at: '2026-07-29',
    source: 'test/fixtures/arm0-transcript.jsonl; docs/PLAN.md §9; docs/HANDOFF.md',
    // n=1 on the simplest possible ticket, per PLAN.md's own "Missing shapes" section.
    // Recorded here so the expiry and the sample size are read together — a re-ablation
    // on sonnet-5 at n=1 would replace one weak number with another.
    caveat: 'n=1, formatting-only ticket; PLAN.md:1070 already calls this the honest limit',
  }),
  Object.freeze({
    id: 'arm-a-baseline-cost',
    claim:
      'One bare `claude -p` context on sandbox-a scored 2 on Axis 1 for $0.617, ' +
      'delivered zero files, and ended on a question.',
    model: 'claude-sonnet-4-6',
    seat: 'worker',
    at: '2026-07-30',
    source: 'docs/exp2-armA-score.md; docs/EXPERIMENT-2-RESULTS.md',
    // The model is inferred from the run window, not from the record: arm A and B both
    // started before `752f3b0` landed at 10:39 PDT (arm B's pipeline record stamps
    // 15:15:43Z = 08:15 PDT), and this shell still exported
    // ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic.claude-sonnet-4-6 when checked on
    // 2026-07-30. Inference, however well-grounded, is the defect: nothing in the
    // evidence files names a model. Arm C must stamp it, which is what #42 wired.
    caveat: 'model inferred from the run window + env, not recorded in the evidence file',
  }),
  Object.freeze({
    id: 'arm-b-pipeline-cost',
    // The arm B system is named in `docs/MODEL-CHANGES.md`, not here. `test/isolation.test.mjs`
    // forbids any non-comment mention of it under lib/, and rightly: Alfred's real coupling
    // was `new URL('../../harness-core/config/user.json')` — a string literal, not an import.
    // A guard that exempted string literals would be the green-and-blind one it replaced, so
    // the wording bends around the guard rather than the guard around the wording.
    claim:
      'The four-phase pipeline (arm B) on sandbox-a spent $18.483 across 8 subagents, ' +
      'scored 0 on Axis 1, and delivered 9 files at 30x arm A\'s cost. 65% of spend was ' +
      'two opus seats in one phase.',
    model: 'claude-sonnet-4-6',
    seat: 'worker',
    at: '2026-07-30',
    source: 'docs/exp2-evidence/armB.json; docs/EXPERIMENT-2-RESULTS.md:223-236',
    // The opus seats in that run were opus-4-8, not opus-5, and the adjudicator seat is
    // opus-5 now. So this figure crosses TWO model seams, not one, and the 30x is the
    // number most exposed to re-measurement.
    caveat:
      'mixed-tier: 65% of spend was opus-4-8 seats; the adjudicator seat is opus-5 now, ' +
      'so this figure crosses two model seams',
  }),
]);

// The model a seat runs right now. Throws on an unknown seat, for the same reason
// `ceilingFor` throws on an unknown model: a defaulted answer here silently marks a
// measurement fresh, and a wrong "fresh" has no error attached to notice.
export function seatModelFor(seat) {
  const entry = SEATS[seat];
  if (!entry) {
    throw new Error(
      `unknown seat '${seat}': no such entry in SEATS. A measurement pinned to a seat ` +
        'that does not exist can never be expired — either the seat was renamed (update ' +
        'the ledger) or the measurement is unanchored.',
    );
  }
  return entry.model;
}

// Is this measurement still a statement about the current configuration?
//
// DERIVED, never declared. Move a seat and every measurement pinned to it re-dates in
// the same commit, with nobody remembering to. That is the property a `provisional: true`
// field cannot have, and the reason this is a function.
export function measurementStatus(measurement) {
  const measuredOn = measurement?.model ?? null;
  const seatNow = seatModelFor(measurement?.seat);
  const provisional = measuredOn !== seatNow;

  return {
    id: measurement?.id ?? null,
    measured_on: measuredOn,
    seat: measurement?.seat ?? null,
    seat_now: seatNow,
    provisional,
    detail: provisional
      ? `measured on ${measuredOn}; the '${measurement?.seat}' seat now runs ${seatNow}. ` +
        'PROVISIONAL PENDING RE-ABLATION — cite it as such, per protocol step 5.'
      : `measured on ${measuredOn}, which the '${measurement?.seat}' seat still runs`,
  };
}

// Every ledger entry that a model move has expired. The honest answer to "what do we
// actually know today", and the thing a results doc should print rather than restate.
export function provisionalMeasurements() {
  return MEASUREMENTS.map(measurementStatus).filter((s) => s.provisional);
}
