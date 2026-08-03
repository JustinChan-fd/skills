// models — the two token limits that are not the same limit, and the stop reason
// that decides whether a response is worth reading.
//
// Alfred's router (PLAN.md §6) is a table, not a service. This is the table, plus the
// three checks that keep a seat from being configured into a request the gateway will
// refuse or an answer that is quietly half-written.
//
// THE DISTINCTION THIS MODULE EXISTS FOR:
//
//   max_tokens    per-RESPONSE output ceiling. An API parameter. Hard-capped by the
//                 gateway at 64,000 or 128,000 depending on the model. Exceeding it
//                 does not cost more — the request is rejected.
//   token_budget  per-SEAT spend cap across a subagent's whole life, summed over
//                 however many calls it makes. Alfred's own accounting, enforced by
//                 stopping the subagent. Legitimately much larger than max_tokens.
//
// PLAN.md §4 originally set `max_tokens: 200000` and `500000`. Those were budgets
// wearing the parameter's name, and the parameter is the smaller of the two by an
// order of magnitude. Both requests would have failed at the gateway, and the fix that
// clamps them to 64k without splitting the concepts would delete the $11.98 lesson
// (an unbounded subagent burning 3.9M tokens) while appearing to address it.

// The gateway's published ceilings, transcribed rather than derived. There is no rule
// mapping a family to a ceiling: sonnet-4-6 and sonnet-5 differ by 2x, and opus-4-5 is
// an opus model at 64k while every later opus is at 128k. Any code that tried to infer
// this would be inventing a pattern the vendor does not guarantee.
export const OUTPUT_CEILINGS = Object.freeze({
  'claude-haiku-4-5': 64_000,
  'claude-sonnet-4-5': 64_000,
  'claude-sonnet-4-6': 64_000,
  'claude-sonnet-5': 128_000,
  'claude-opus-4-5': 64_000,
  'claude-opus-4-6': 128_000,
  'claude-opus-4-7': 128_000,
  'claude-opus-4-8': 128_000,
  'claude-opus-5': 128_000,
});

// ONE normalizer, re-exported rather than reimplemented.
//
// This file previously carried its own copy that stripped only a trailing date, while
// every request to this gateway spells the model with an `anthropic.` prefix and often a
// `-v1` or `-v1:0` suffix — so `ceilingFor('anthropic.claude-opus-5')` threw on the exact
// id production uses. Two copies of one normalization is also the precise shape that
// produced the `in`/`out` price defect: the copies agreed until one was extended.
//
// Importing sideways within lib/ is fine under test/isolation.test.mjs, which forbids
// reaching outside alfred/ — not sibling modules.
export { normalizeModelId } from './prices.mjs';
import { normalizeModelId } from './prices.mjs';

export function ceilingFor(model) {
  const ceiling = OUTPUT_CEILINGS[normalizeModelId(model)];
  if (ceiling === undefined) {
    // Deliberately not a default. A guessed 64k on a 128k model silently halves the
    // available output; a guessed 128k on a 64k model produces a rejected request in
    // the middle of an unattended tick. Both are invisible; the throw is not.
    throw new Error(
      `unknown model '${model}': no published output ceiling. Add it to OUTPUT_CEILINGS ` +
        'with the value from the gateway model list — do not assume a default.',
    );
  }
  return ceiling;
}

// Validates one seat and returns it unchanged. Not a clamp: silently lowering a
// configured value would make the config file and the request disagree, and the
// config is what a human reads when the numbers look wrong.
export function validateSeat(seat) {
  const { model, max_tokens: maxTokens, token_budget: tokenBudget } = seat ?? {};
  const ceiling = ceilingFor(model);

  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`max_tokens must be a positive integer, got ${maxTokens}`);
  }
  if (maxTokens > ceiling) {
    throw new Error(
      `max_tokens ${maxTokens} exceeds the ${ceiling} ceiling for ${model}. If this was ` +
        'meant as a spend cap across the whole subagent, it belongs in token_budget.',
    );
  }
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    throw new Error(
      `token_budget must be a positive integer, got ${tokenBudget}. An absent cap is how ` +
        'a subagent runs to $11.98 — omission must be an error, not an infinity.',
    );
  }

  return seat;
}

// The router table from PLAN.md §6, now with both numbers and both of them checked.
//
// max_tokens sits at each model's ceiling: the parameter costs nothing unused, and a
// lower value is a truncation waiting to happen on the one call that writes a large
// file. token_budget is what actually bounds spend, and it is sized to the seat's job.
//
// The reasoning seats moved from sonnet-4-6 to sonnet-5 on 2026-07-30, after confirming
// live (http 200, end_turn, service_tier standard) rather than reading a model list. It
// is not a tradeoff: sonnet-5 has 5x the context, 2x the output ceiling, and a lower list
// rate. The old default was simply stale.
//
// token_budget is deliberately UNCHANGED by that move. It bounds spend, and a model with
// more context is a reason to watch spend more closely, not less — raising the cap
// alongside the context would quietly undo the $11.98 lesson while looking like an
// upgrade.
export const SEATS = Object.freeze({
  worker: { model: 'claude-sonnet-5', max_tokens: 128_000, token_budget: 2_000_000 },
  fallback: { model: 'claude-sonnet-5', max_tokens: 128_000, token_budget: 2_000_000 },
  // Mechanical reads, and deliberately NOT upgraded — "use the best models" is about the
  // seats that reason. A file listing on a frontier model pays 3x for the same lines, and
  // misrouting by tier is a named failure mode for this project. The tight budget is the
  // point too: a scan that needs 500k has stopped being a scan.
  scan: { model: 'claude-haiku-4-5', max_tokens: 64_000, token_budget: 200_000 },
  reason: { model: 'claude-sonnet-5', max_tokens: 128_000, token_budget: 500_000 },
  // Explicit escalation only, one logged event with a reason. 128k here is free
  // headroom, not an invitation.
  adjudicator: { model: 'claude-opus-5', max_tokens: 128_000, token_budget: 500_000 },
});

for (const [name, seat] of Object.entries(SEATS)) {
  try {
    validateSeat(seat);
  } catch (cause) {
    // Fail at import, not at 3am on the call that uses the seat.
    throw new Error(`seat '${name}' is misconfigured: ${cause.message}`, { cause });
  }
}

// Stop reasons that mean the model finished saying what it had to say. Everything
// else — including anything added to the API after this was written — is a failure.
const COMPLETED = new Set(['end_turn', 'stop_sequence', 'tool_use']);

// Why this is a first-class check rather than a log line: a `max_tokens` stop returns
// a WELL-FORMED response. Valid envelope, valid content block, containing half a file
// or an unterminated JSON object. Nothing downstream can tell it from a finished
// answer except this field, so a run that does not read it will commit the truncation.
export function classifyStop(reason) {
  if (reason === null || reason === undefined) {
    return {
      ok: false,
      truncated: false,
      detail:
        'stop_reason absent: the response is either still streaming or the field was ' +
        'never read. Not treated as success — an unread stop_reason and a clean finish ' +
        'must not look the same.',
    };
  }
  if (COMPLETED.has(reason)) return { ok: true, truncated: false, detail: reason };

  if (reason === 'max_tokens') {
    return {
      ok: false,
      truncated: true,
      detail:
        'stop_reason max_tokens: the response was truncated at the output ceiling. The ' +
        'content is well-formed and incomplete — discard it, do not commit it. Split the ' +
        'work across calls rather than raising max_tokens, which is already at the ceiling.',
    };
  }
  return {
    ok: false,
    truncated: false,
    detail: `stop_reason ${reason}: not a completed turn. Treated as a failed call.`,
  };
}
