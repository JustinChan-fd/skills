import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scoreDefectResult } from '../lib/score.mjs';

// A representative seeded-defect signature (the D8 silently-wrong defect: the
// two real error-message strings get folded into SUCCESS_MESSAGES so
// classifyVariant() misclassifies them as success).
const D8_SIGNATURE = {
  file_paths: ['src/App.tsx'],
  criterion:
    'Variant (success/error) is conveyed from App.tsx’s real call sites to the toast via a content-based classifier',
  keyword_terms: ['classifyVariant', 'SUCCESS_MESSAGES', 'error variant', 'dead code', 'error-styled'],
};

test('clean miss: a pass gate result is never a catch, regardless of signature', () => {
  const r = scoreDefectResult({
    signature: D8_SIGNATURE,
    gateResult: 'pass',
    failures: [],
  });
  assert.deepEqual(r, { caught: false, severity: 'none', matched_term: null });
});

test('clean miss: pass result even with failures present is still a miss', () => {
  // Defensive: gate result is authoritative — a "pass" with stray advisory
  // text must not be scored as a catch.
  const r = scoreDefectResult({
    signature: D8_SIGNATURE,
    gateResult: 'pass',
    failures: [{ tag: 'advisory', description: 'classifyVariant looks off' }],
  });
  assert.equal(r.caught, false);
  assert.equal(r.severity, 'none');
});

test('full catch: blocking-fail citing a signature keyword scores full', () => {
  const r = scoreDefectResult({
    signature: D8_SIGNATURE,
    gateResult: 'blocking-fail',
    failures: [
      {
        tag: 'blocking',
        description:
          'The two real failure paths would render as success-styled toasts because their strings were added to SUCCESS_MESSAGES.',
      },
    ],
  });
  assert.equal(r.caught, true);
  assert.equal(r.severity, 'full');
  assert.equal(r.matched_term, 'SUCCESS_MESSAGES');
});

test('full catch: matching on the seeded file path alone is sufficient', () => {
  const r = scoreDefectResult({
    signature: D8_SIGNATURE,
    gateResult: 'blocking-fail',
    failures: [{ tag: 'blocking', description: 'Regression in src/App.tsx variant handling.' }],
  });
  assert.equal(r.caught, true);
  assert.equal(r.severity, 'full');
  assert.equal(r.matched_term, 'src/App.tsx');
});

test('partial catch: advisory-fail citing the signature scores partial', () => {
  const r = scoreDefectResult({
    signature: D8_SIGNATURE,
    gateResult: 'advisory-fail',
    failures: [
      { tag: 'advisory', description: 'Minor: classifyVariant classification seems too permissive.' },
    ],
  });
  assert.equal(r.caught, true);
  assert.equal(r.severity, 'partial');
  assert.equal(r.matched_term, 'classifyVariant');
});

test('false negative: a blocking-fail that cites something unrelated is NOT a catch', () => {
  const r = scoreDefectResult({
    signature: D8_SIGNATURE,
    gateResult: 'blocking-fail',
    failures: [
      {
        tag: 'blocking',
        description: 'The production build fails: tsc error in src/domain/pagination.ts.',
      },
    ],
  });
  assert.equal(r.caught, false);
  assert.equal(r.severity, 'none');
  assert.equal(r.matched_term, null);
});

test('matching is case-insensitive substring', () => {
  const r = scoreDefectResult({
    signature: D8_SIGNATURE,
    gateResult: 'blocking-fail',
    failures: [{ tag: 'blocking', description: 'the success_messages set was tampered with' }],
  });
  assert.equal(r.caught, true);
  assert.equal(r.matched_term, 'SUCCESS_MESSAGES');
});

test('blocking wins severity when both a blocking and advisory failure match', () => {
  const r = scoreDefectResult({
    signature: D8_SIGNATURE,
    gateResult: 'blocking-fail',
    failures: [
      { tag: 'advisory', description: 'classifyVariant nit' },
      { tag: 'blocking', description: 'error variant is dead code — never reachable in the shipped app' },
    ],
  });
  assert.equal(r.caught, true);
  assert.equal(r.severity, 'full');
});

test('object-shaped failures ({blocking:[],advisory:[]}) are normalized', () => {
  const r = scoreDefectResult({
    signature: D8_SIGNATURE,
    gateResult: 'blocking-fail',
    failures: {
      blocking: ['error-styled toasts would never render for the two real failure paths'],
      advisory: ['unrelated nit'],
    },
  });
  assert.equal(r.caught, true);
  assert.equal(r.severity, 'full');
  assert.equal(r.matched_term, 'error-styled');
});

test('real telemetry line: issue-13 plan round-2 announce()-variant blocking-fail is a full catch', () => {
  // Proves the matcher works against real verifier prose, not only synthetic
  // strings. This is the exact verifier_round event line the MID plan verifier
  // emitted at round 2 of the issue-13 plan run (dead-code error-variant find).
  const fixturePath = fileURLToPath(new URL('./fixtures/issue-13-plan-r2.jsonl', import.meta.url));
  const line = readFileSync(fixturePath, 'utf8').trim().split('\n')[0];
  const event = JSON.parse(line);
  const r = scoreDefectResult({
    signature: D8_SIGNATURE,
    gateResult: event.data.result,
    failures: event.data.failures,
  });
  assert.equal(r.caught, true);
  assert.equal(r.severity, 'full');
  // The matcher returns the first seeded keyword term (in signature order)
  // found in the failure prose. Both "error variant" and "dead code" appear
  // verbatim in the real blocking failure; "error variant" comes first in the
  // signature's keyword_terms, so it is the reported match.
  assert.equal(r.matched_term, 'error variant');
});
