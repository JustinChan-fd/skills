// gaps — the named-holes container.
//
// WHERE THESE THREE NAMES COME FROM. They are an AMENDMENT to M2, appended to its
// 11 frozen names on 2026-07-30 after reviewing `~/Downloads/harness-audit-log-schema.md`
// (a separate Opus 5 research pass on whether sidecar/metrics collection would work).
// The 11 frozen names and the arm 0 anchor are untouched, so arm C's control holds —
// see the ADDED: rationale at the top of tokens.test.mjs. These carry the same
// prefix for the same reason.
//
// WHAT THE DOC CONTRIBUTED. Its §7 step 7 states Alfred's own M0 principle in other
// words — "Never zero-fill missing usage. An unmeasured unit and a free unit must not
// look the same." Alfred already honours that for COST holes: `priceTokens` returns
// `unpriced: []`, `usd: null`, `complete: false`. It had nothing for STRUCTURAL holes
// — an unreadable subagents dir, an absent session id, a guessed run window. Those
// either blunted the whole record to `ok: false` or vanished silently. That is the one
// place the research found Alfred genuinely weaker, so it is the one place amended.
//
// WHAT WAS DELIBERATELY NOT TAKEN, so a later reader does not "restore" it:
//   - `attempt`. PLAN.md:186 — the gate "never re-runs the worker. It reports."
//     A counter frozen at 1 forever is a field that implies a retry loop Alfred does
//     not have. Absent beats green-and-blind.
//   - the doc's outcome enum (ok|stalled|needs_decision|verifier_rejected|error|aborted).
//     `blocked.mjs` REASONS is already a closed set over the same ground
//     (verifier_rejected ~ verification-failed, needs_decision ~ ambiguous-requirement).
//     Two vocabularies for one concept is the very defect the doc's own §8 warns about.
//   - markers-as-primary, and `cost_usd_micros` as the cost SOURCE. See below.
//
// THE MEASUREMENT THAT MOTIVATED THE THIRD NAME. On 2026-07-30 a local OTLP/HTTP
// listener (~30 lines of node:http, no new dependency) captured six real payloads from
// one `claude -p` through the Bedrock gateway, session 14171034-fc61-4932-881f-dd10b6293aa6.
// Telemetry flows fine through Bedrock — the instrumentation is client-side — and the
// `harness.*` resource attributes land on both logs and metrics. But the model id did
// not agree with itself inside that single session:
//
//   api_request log record   model = claude-haiku-4-5-20251001
//   cost.usage metric        model = sonney
//   token.usage metric       model = sonney
//   --output-format json     modelUsage key = sonney
//
// Same session, same 4642 / 264 / 0 / 41812 tokens, same $0.291135 — a figure that
// reconciles to opus-5 $5/$25 to seven decimals while NAMING haiku. So grouping spend
// by `model` attributes it to whichever field the reader happened to open. A cost that
// is precise, integer, and wrong is this project's recurring failure shape, which is
// why `cost_usd_micros` is kept as a DISAGREEMENT DETECTOR and never as the source.
//
// One confounder, not yet separated and not claimed as settled: the `"model": "sonney"`
// typo in ~/.claude/settings.json may be the whole story, or Bedrock-style ids may miss
// Claude Code's internal price table. Fixing the typo and re-running separates them.
//
// NO OTEL DEPENDENCY IN THE RUN PATH. Nothing here reads telemetry. `reconcileModel`
// takes whatever sources a caller HAS and reports disagreement among them, so these
// pass whether OTel is ever enabled or not — which matters, because on this machine no
// OTEL_* variable is set anywhere and capture only happens when a caller opts in
// per-process. The pure-sidecar rule is unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GAP_CODES, newGaps, noteGap, usageRefusal, reconcileModel } from '../lib/gaps.mjs';

// --- 1. a structural hole is recorded without condemning the record ---

test('ADDED: a structural hole is named in gaps[] and does not set ok: false', () => {
  // Two propositions in one name, deliberately asserted apart: that the hole is
  // NAMED, and that naming it leaves the rest of the record usable. Folding them
  // would let a build pass that recorded the hole by discarding everything else —
  // which is what `ok: false` on an otherwise-good record already does today.
  const record = { ok: true, gaps: newGaps() };

  noteGap(record.gaps, 'subagents-unreadable', 'EACCES on <session>/subagents/');

  assert.equal(record.ok, true, 'a partial record is still worth reporting');
  assert.equal(record.gaps.length, 1);
  assert.equal(record.gaps[0].code, 'subagents-unreadable');
  assert.match(record.gaps[0].detail, /subagents/, 'a hole with no detail is not actionable');
});

test('ADDED: a gap code outside the closed set throws, so holes stay aggregatable', () => {
  // Same reasoning as blocked.mjs REASONS: "how often does Alfred lose the subagents
  // dir" must be answerable by aggregating, not by grepping prose. Free text defeats
  // that silently, so it is refused at the boundary rather than accepted and counted.
  const gaps = newGaps();
  assert.throws(() => noteGap(gaps, 'something-went-wrong', 'detail'), /gap code/i);
  assert.equal(gaps.length, 0, 'a refused gap must not be half-recorded');
  assert.ok(Object.keys(GAP_CODES).length > 0, 'the closed set must not be empty');
});

test('ADDED: a gap with no detail throws — an unexplained hole is not actionable', () => {
  const gaps = newGaps();
  assert.throws(() => noteGap(gaps, 'subagents-unreadable', ''), /detail/i);
});

// --- 2. the transcript-shape tripwire ---

test('ADDED: a transcript with parsed lines but zero usable usage records is a named refusal, not $0', () => {
  // THE TRIPWIRE. The doc is right that the transcript format is internal to Claude
  // Code and moves between versions. Alfred cannot abandon it — the by-subagent
  // requirement forces it, and OTel cannot deliver by-subagent without a beta flag and
  // a corporate sign-off (CHECKLIST items 5-6). So the answer is to fail LOUDLY on a
  // shape change instead of parsing it into silence: if a future version renames
  // message.usage, every figure becomes a clean, plottable, false $0.00.
  const refusal = usageRefusal({ lines_parsed: 2, usable_usage_records: 0 });

  assert.equal(refusal.refused, true);
  assert.equal(refusal.code, 'no-usable-usage');
  assert.match(refusal.detail, /2/, 'the detail must carry the count that triggered it');
});

test('ADDED: an empty transcript is not a refusal — the tripwire keys on parsed-but-unusable', () => {
  // The other half, and the reason the trigger is `lines_parsed > 0 && usable === 0`
  // rather than "totals are zero". A tripwire that fires on every trivial session gets
  // muted within a week, and a muted tripwire is worse than none: it reads as coverage.
  const empty = usageRefusal({ lines_parsed: 0, usable_usage_records: 0 });
  assert.equal(empty.refused, false, 'nothing to read is not the same as unreadable');

  const fine = usageRefusal({ lines_parsed: 9, usable_usage_records: 4 });
  assert.equal(fine.refused, false);
});

// --- 3. model identity that disagrees with itself ---

test('ADDED: a model id that disagrees between sources is named in gaps[], not silently picked', () => {
  // The measured case from the header, verbatim. Picking a winner here is the whole
  // defect: either choice produces a confident per-model number that is wrong, with no
  // error and no way to tell correct from broken by looking.
  const gaps = newGaps();

  const chosen = reconcileModel(
    { transcript: 'sonney', otel_api_request: 'claude-haiku-4-5-20251001' },
    gaps,
  );

  assert.equal(chosen, null, 'a disagreement must not resolve to a winner');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].code, 'model-id-disagreement');
  assert.match(gaps[0].detail, /sonney/);
  assert.match(gaps[0].detail, /haiku/, 'both sides must be named or the hole is unreadable');
});

test('ADDED: sources that agree resolve to the id and record no gap', () => {
  // The negative control. Without it, a reconcileModel that returned null
  // unconditionally would pass the test above — a green that proves nothing.
  const gaps = newGaps();
  const chosen = reconcileModel(
    { transcript: 'claude-sonnet-5', otel_api_request: 'claude-sonnet-5' },
    gaps,
  );

  assert.equal(chosen, 'claude-sonnet-5');
  assert.equal(gaps.length, 0, 'agreement is not a hole');
});

test('ADDED: a single source is not a disagreement — one opinion resolves', () => {
  // The common real case, since no OTEL_* variable is set on this machine: the
  // transcript is the only source there is. That must not read as a conflict.
  const gaps = newGaps();
  assert.equal(reconcileModel({ transcript: 'claude-sonnet-5' }, gaps), 'claude-sonnet-5');
  assert.equal(gaps.length, 0);
});

test('ADDED: no sources at all is a named hole, not a resolved model', () => {
  const gaps = newGaps();
  assert.equal(reconcileModel({}, gaps), null);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].code, 'model-id-absent');
});
