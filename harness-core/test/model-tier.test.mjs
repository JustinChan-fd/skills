import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelId, tierForModelId } from '../tools/lib/model-tier.mjs';

// A stand-in for routing.json's model_id_to_tier, holding only the undated,
// unprefixed spellings the real map holds — the whole point is that dated and
// prefixed ids must resolve THROUGH this shape, not require entries of their own.
const MAP = {
  'claude-opus-5': 'HIGH',
  'claude-opus-4-8': 'HIGH',
  'claude-sonnet-5': 'MID',
  'claude-sonnet-4-6': 'MID',
  'claude-sonnet-4-5': 'MID',
  'claude-haiku-4-5': 'LOW',
  '<synthetic>': 'LOW',
  opus: 'HIGH',
  sonnet: 'MID',
  haiku: 'LOW',
};

test('an id already in the map resolves without any normalization', () => {
  assert.equal(tierForModelId('claude-sonnet-4-6', MAP), 'MID');
  // The sentinel is a literal map key and must survive untouched — it is not a
  // model name and must never be mangled by the stripping rules.
  assert.equal(tierForModelId('<synthetic>', MAP), 'LOW');
  assert.equal(normalizeModelId('<synthetic>'), '<synthetic>');
});

test('a trailing -YYYYMMDD date suffix is stripped — the dominant unresolved form', () => {
  // 1,739 usage lines in the sampled local transcripts carry exactly this id.
  assert.equal(normalizeModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(tierForModelId('claude-sonnet-4-5-20250929', MAP), 'MID');
  assert.equal(tierForModelId('claude-haiku-4-5-20251001', MAP), 'LOW');
});

test('a leading anthropic. prefix is stripped, and composes with date-stripping', () => {
  assert.equal(normalizeModelId('anthropic.claude-sonnet-4-6'), 'claude-sonnet-4-6');
  assert.equal(tierForModelId('anthropic.claude-sonnet-5', MAP), 'MID');
  // Both rules on one id — the Bedrock-style dated form.
  assert.equal(normalizeModelId('anthropic.claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(tierForModelId('anthropic.claude-haiku-4-5-20251001', MAP), 'LOW');
});

test('bare tier aliases resolve, because transcripts really do carry them', () => {
  for (const [id, tier] of [['opus', 'HIGH'], ['sonnet', 'MID'], ['haiku', 'LOW']]) {
    assert.equal(tierForModelId(id, MAP), tier);
  }
});

test('a non-Anthropic vendor prefix is NOT stripped and stays unresolved', () => {
  // These are real ids in local transcripts. They have no Anthropic tier and no
  // Anthropic price; resolving them to one would be a pricing defect, so only the
  // exact "anthropic." prefix is ever removed.
  assert.equal(normalizeModelId('qwen.qwen3-coder-30b-a3b-v1:0'), 'qwen.qwen3-coder-30b-a3b-v1:0');
  assert.equal(tierForModelId('qwen.qwen3-coder-30b-a3b-v1:0', MAP), null);
  assert.equal(tierForModelId('deepseek.r1-v1:0', MAP), null);
});

test('an unrecognized Anthropic-shaped id stays unresolved — no family guessing', () => {
  // This is the rename tripwire's whole reason to exist: a future flagship must
  // come back null and force complete:false, NOT get silently mis-tiered (and
  // therefore mis-priced) by a substring match on "sonnet" or "opus".
  assert.equal(tierForModelId('claude-sonnet-9', MAP), null);
  assert.equal(tierForModelId('claude-opus-9-9', MAP), null);
  assert.equal(tierForModelId('some-unrecognized-model-99', MAP), null);
});

test('a partial or malformed date suffix is not treated as a date', () => {
  // Only a full 8-digit trailing group is a date. Stripping anything shorter
  // would eat a version segment: claude-opus-4-8 must not become claude-opus-4.
  assert.equal(normalizeModelId('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(tierForModelId('claude-opus-4-8', MAP), 'HIGH');
  assert.equal(normalizeModelId('claude-sonnet-4-5-2025'), 'claude-sonnet-4-5-2025');
  assert.equal(tierForModelId('claude-sonnet-4-5-2025', MAP), null);
});

test('garbage input returns null instead of throwing — collection must never crash', () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(normalizeModelId(bad), null);
    assert.equal(tierForModelId(bad, MAP), null);
  }
  // A missing or empty map is a degradation, not a crash.
  assert.equal(tierForModelId('claude-opus-5', {}), null);
  assert.equal(tierForModelId('claude-opus-5', undefined), null);
});
