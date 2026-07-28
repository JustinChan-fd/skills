import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualityScore } from '../tools/lib/quality.mjs';

const goodDeliverable = { completed: true, manifestValid: true, gatesDecided: true, auditWritten: true };

test('known inputs → known number', () => {
  assert.equal(qualityScore({ verifierScores: [0.8, 0.9, 1.0], deliverable: goodDeliverable }), 0.9);
});

test('any failed deliverable check zeroes the score', () => {
  for (const key of Object.keys(goodDeliverable)) {
    const deliverable = { ...goodDeliverable, [key]: false };
    assert.equal(qualityScore({ verifierScores: [1.0], deliverable }), 0);
  }
});

test('no verifier scores → 0', () => {
  assert.equal(qualityScore({ verifierScores: [], deliverable: goodDeliverable }), 0);
});
