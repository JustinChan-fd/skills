import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateDecision } from '../tools/lib/gate.mjs';

test('all pass → open', () => {
  assert.deepEqual(gateDecision({ result: 'pass', rounds: 1, cap: 5 }), { decision: 'open', record: null });
});

test('advisory fail under cap → revise', () => {
  assert.deepEqual(gateDecision({ result: 'advisory-fail', rounds: 2, cap: 5 }), { decision: 'revise', record: null });
});

test('advisory fail at cap → open + defect recorded', () => {
  assert.deepEqual(gateDecision({ result: 'advisory-fail', rounds: 5, cap: 5 }), { decision: 'open', record: 'defect' });
});

test('advisory delta below plateau threshold → open + residue', () => {
  assert.deepEqual(
    gateDecision({ result: 'advisory-fail', rounds: 2, cap: 5, delta: 0.01, plateauThreshold: 0.05 }),
    { decision: 'open', record: 'residue' },
  );
});

test('advisory fail at high score → open + residue immediately (fast-open)', () => {
  assert.deepEqual(
    gateDecision({ result: 'advisory-fail', rounds: 1, cap: 5, score: 0.95, advisoryOpenScore: 0.9 }),
    { decision: 'open', record: 'residue' },
  );
});

test('advisory fail below fast-open score still revises', () => {
  assert.deepEqual(
    gateDecision({ result: 'advisory-fail', rounds: 1, cap: 5, score: 0.85, advisoryOpenScore: 0.9 }),
    { decision: 'revise', record: null },
  );
});

test('fast-open never applies to blocking failures', () => {
  assert.deepEqual(
    gateDecision({ result: 'blocking-fail', rounds: 1, cap: 5, score: 0.99, advisoryOpenScore: 0.9 }),
    { decision: 'revise', record: null },
  );
});

test('blocking fail under cap → revise', () => {
  assert.deepEqual(gateDecision({ result: 'blocking-fail', rounds: 2, cap: 5 }), { decision: 'revise', record: null });
});

test('blocking fail at cap → shut + escalation', () => {
  assert.deepEqual(gateDecision({ result: 'blocking-fail', rounds: 5, cap: 5 }), { decision: 'shut', record: 'escalation' });
});

test('unknown result throws', () => {
  assert.throws(() => gateDecision({ result: 'maybe', rounds: 1, cap: 5 }), /unknown gate result/);
});
