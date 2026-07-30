// The model table: output ceilings, spend budgets, and stop reasons.
//
// This file exists because PLAN.md §4 shipped two impossible numbers:
//
//   "scan":  { "model": "claude-haiku-4-5", "max_tokens": 200000 }
//   "reason":{ "model": "claude-sonnet-4-6", "max_tokens": 500000 }
//
// `max_tokens` is the API's PER-RESPONSE output ceiling, and on this gateway it is
// 64,000 (sonnet-4-5/4-6, haiku-4-5) or 128,000 (opus-4-6+, opus-5, sonnet-5). Both
// values above exceed it, so both requests would be rejected outright.
//
// The numbers were not wrong about anything real — they were the $11.98 lesson, where
// an unbounded subagent burned 3.9M tokens. That is a SPEND cap across a whole
// subagent's life. Two different quantities wearing one name, and the name belonged to
// the smaller one. So: `token_budget` for the spend cap, `max_tokens` for the API
// parameter, and neither is allowed to be inferred from the other.
//
// Four propositions, kept apart on purpose:
//
//   1. Every seat's `max_tokens` is within its model's real ceiling.
//   2. `token_budget` is a separate axis and MAY legitimately exceed the ceiling.
//   3. An unknown model does not silently receive a default ceiling.
//   4. A `max_tokens` stop is a FAILURE, not a completed turn.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OUTPUT_CEILINGS,
  ceilingFor,
  validateSeat,
  SEATS,
  classifyStop,
} from '../lib/models.mjs';

// --- 1. the ceiling is real, and per model ---

test('the ceiling is 64k for the sonnet-4 line and haiku, 128k for opus and sonnet-5', () => {
  // Transcribed from the gateway's own model list. Hard-coded rather than derived,
  // because there is no rule connecting a model name to its ceiling — sonnet-4-6 and
  // sonnet-5 differ by 2x and share a family.
  assert.equal(ceilingFor('claude-sonnet-4-6'), 64_000);
  assert.equal(ceilingFor('claude-sonnet-4-5'), 64_000);
  assert.equal(ceilingFor('claude-haiku-4-5'), 64_000);
  assert.equal(ceilingFor('claude-opus-5'), 128_000);
  assert.equal(ceilingFor('claude-opus-4-8'), 128_000);
  assert.equal(ceilingFor('claude-sonnet-5'), 128_000);
});

test('a dated model id resolves to the same ceiling as its base id', () => {
  // Transcripts carry `claude-haiku-4-5-20251001`. A ceiling lookup that missed the
  // dated form would throw on exactly the ids that appear in real telemetry.
  assert.equal(ceilingFor('claude-haiku-4-5-20251001'), 64_000);
});

test('an unknown model id throws rather than receiving a default ceiling', () => {
  // A default would be the worst outcome: 64k guessed for a 128k model wastes
  // headroom silently, and 128k guessed for a 64k model produces a rejected request
  // at 3am. Neither is visible without the throw.
  assert.throws(() => ceilingFor('claude-something-7'), /unknown model/i);
});

// --- 2. every configured seat fits, and the numbers that shipped do not ---

test('every seat in the router table declares max_tokens within its ceiling', () => {
  // The regression guard. This is the assertion PLAN.md §4 would have failed.
  for (const [name, seat] of Object.entries(SEATS)) {
    const ceiling = ceilingFor(seat.model);
    assert.ok(
      seat.max_tokens <= ceiling,
      `seat '${name}' asks for ${seat.max_tokens} on ${seat.model}, ceiling is ${ceiling}`,
    );
  }
});

test('the two values PLAN.md originally shipped are rejected', () => {
  // Named explicitly so the fix is anchored to the defect rather than to a range.
  assert.throws(
    () => validateSeat({ model: 'claude-haiku-4-5', max_tokens: 200_000 }),
    /max_tokens/,
  );
  assert.throws(
    () => validateSeat({ model: 'claude-sonnet-4-6', max_tokens: 500_000 }),
    /max_tokens/,
  );
});

test('validateSeat rejects a max_tokens of zero or below', () => {
  // A 0 ceiling is accepted by `<= ceiling` and yields a response with no content.
  assert.throws(() => validateSeat({ model: 'claude-opus-5', max_tokens: 0 }), /max_tokens/);
});

// --- 3. the spend cap is a different axis ---

test('token_budget may exceed the output ceiling, because it is not the same quantity', () => {
  // The load-bearing distinction. 500k was never wrong as a budget — a subagent that
  // reads 40 files across 30 turns spends that much legitimately. It was wrong only as
  // a per-response ceiling. A validator that clamped both to 64k would have "fixed"
  // the defect by deleting the lesson.
  const seat = validateSeat({
    model: 'claude-sonnet-4-6',
    max_tokens: 64_000,
    token_budget: 500_000,
  });
  assert.equal(seat.token_budget, 500_000);
  assert.equal(seat.max_tokens, 64_000);
});

test('every seat carries a token_budget, since the unbounded subagent is the known hazard', () => {
  for (const [name, seat] of Object.entries(SEATS)) {
    assert.equal(typeof seat.token_budget, 'number', `seat '${name}' needs a spend cap`);
    assert.ok(seat.token_budget > 0, `seat '${name}' spend cap must be positive`);
  }
});

test('a seat with no token_budget is refused', () => {
  // Omission is how the $11.98 run happened: nothing was configured, so nothing
  // bounded it. An absent cap must be an error, not an infinity.
  assert.throws(
    () => validateSeat({ model: 'claude-opus-5', max_tokens: 128_000 }),
    /token_budget/,
  );
});

// --- 4. truncation is a failure ---

test('a max_tokens stop is a failure, not a completed turn', () => {
  // The reason this matters more than the ceiling itself: a truncated response is
  // well-formed. It arrives with a valid envelope containing half a file or an
  // unterminated JSON object, and an agent that reads only `content` builds on top of
  // it. `stop_reason` is the only place the truncation is visible.
  const verdict = classifyStop('max_tokens');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.truncated, true);
  assert.match(verdict.detail, /truncat/i);
});

test('an end_turn stop is a completed turn', () => {
  const verdict = classifyStop('end_turn');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.truncated, false);
});

test('a tool_use stop is a completed turn, not a truncation', () => {
  // The agent loop's normal state. Treating it as failure would abort every run on
  // its first tool call.
  assert.equal(classifyStop('tool_use').ok, true);
  assert.equal(classifyStop('tool_use').truncated, false);
});

test('a stop_reason of null is not treated as success', () => {
  // Null means the response is still streaming, or that the field was never read.
  // Defaulting it to ok would make an unread stop_reason indistinguishable from a
  // clean finish — which is the exact bug this file exists to prevent.
  const verdict = classifyStop(null);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.truncated, false);
  assert.match(verdict.detail, /absent|missing|unknown/i);
});

test('an unrecognised stop_reason is not treated as success', () => {
  const verdict = classifyStop('some_future_reason');
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /some_future_reason/);
});

test('refusal and pause stops are failures with their own detail', () => {
  // Distinct from truncation: neither is a ceiling problem, and reporting them as
  // truncation would send whoever reads the log to the wrong fix.
  for (const reason of ['refusal', 'pause_turn']) {
    const verdict = classifyStop(reason);
    assert.equal(verdict.ok, false, `${reason} is not a completed turn`);
    assert.equal(verdict.truncated, false, `${reason} is not a truncation`);
    assert.match(verdict.detail, new RegExp(reason));
  }
});
