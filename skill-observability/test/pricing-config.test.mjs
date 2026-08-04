// The pricing config is TRANSCRIBED data, so the failure mode is a typo, not a
// logic bug. These tests exist to make a typo loud.
//
// The vendor-table assertions below are deliberately hand-written literals
// rather than a loop over the config: a loop reading the config to check the
// config proves only that JSON.parse works. Each row here was read off
// https://platform.claude.com/docs/en/about-claude/pricing on 2026-08-04 and
// typed in independently. If someone edits a rate in the config and these fail,
// that is the test doing its job — update these too, from the vendor page.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ratesFor, normalizeModelId, RATE_CONFIG, PRICING_VERSION } from '../lib/pricing.mjs';

const AT = '2026-08-04T00:00:00Z';
const r = (id, opts) => ratesFor(id, { at: AT, ...opts });

// --- the vendor table, independently transcribed -----------------------------

test('vendor rates: input/output per model, as published', () => {
  const expected = [
    ['claude-fable-5', 10, 50],
    ['claude-mythos-5', 10, 50],
    ['claude-opus-5', 5, 25],
    ['claude-opus-4-8', 5, 25],
    ['claude-opus-4-7', 5, 25],
    ['claude-opus-4-6', 5, 25],
    ['claude-opus-4-5', 5, 25],
    ['claude-opus-4-1', 15, 75],
    ['claude-sonnet-4-6', 3, 15],
    ['claude-sonnet-4-5', 3, 15],
    ['claude-haiku-4-5', 1, 5],
    ['claude-haiku-3-5', 0.8, 4],
  ];
  for (const [id, input, output] of expected) {
    const got = r(id);
    assert.ok(got, `${id} must be priced`);
    assert.equal(got.input_per_mtok, input, `${id} input`);
    assert.equal(got.output_per_mtok, output, `${id} output`);
  }
});

test('vendor rates: the three cache columns, as published', () => {
  // Read straight off the vendor table's 5m / 1h / hits-and-refreshes columns.
  const expected = [
    ['claude-fable-5', 12.5, 20, 1],
    ['claude-opus-5', 6.25, 10, 0.5],
    ['claude-opus-4-1', 18.75, 30, 1.5],
    ['claude-sonnet-4-6', 3.75, 6, 0.3],
    ['claude-haiku-4-5', 1.25, 2, 0.1],
    ['claude-haiku-3-5', 1, 1.6, 0.08],
  ];
  for (const [id, w5, w1h, read] of expected) {
    const got = r(id);
    assert.equal(got.cache_write_5m_per_mtok, w5, `${id} 5m write`);
    assert.equal(got.cache_write_1h_per_mtok, w1h, `${id} 1h write`);
    assert.equal(got.cache_read_per_mtok, read, `${id} cache read`);
  }
});

test('every stated cache column obeys the published multipliers', () => {
  // The vendor states 1.25x / 2x / 0.1x AND prints explicit columns. Both must
  // agree for every row, which is exactly what catches a fat-fingered digit.
  // If a future vendor change breaks the relationship, this test SHOULD fail —
  // the explicit column wins and this assertion is what forces the discussion.
  const { cache_write_5m: m5, cache_write_1h: m1h, cache_read: mr } = RATE_CONFIG.cache_multipliers;
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
  for (const m of RATE_CONFIG.models) {
    for (const variant of [m, m.intro, m.fast].filter(Boolean)) {
      const input = variant.input ?? m.input;
      if (typeof variant.cache_write_5m === 'number') near(variant.cache_write_5m, input * m5, `${m.prefix} 5m`);
      if (typeof variant.cache_write_1h === 'number') near(variant.cache_write_1h, input * m1h, `${m.prefix} 1h`);
      if (typeof variant.cache_read === 'number') near(variant.cache_read, input * mr, `${m.prefix} read`);
    }
  }
});

test('config is internally well-formed: unique prefixes, all four prices present', () => {
  const seen = new Set();
  for (const m of RATE_CONFIG.models) {
    assert.ok(!seen.has(m.prefix), `duplicate prefix ${m.prefix}`);
    seen.add(m.prefix);
    assert.equal(typeof m.input, 'number', `${m.prefix} input`);
    assert.equal(typeof m.output, 'number', `${m.prefix} output`);
    assert.ok(m.input > 0 && m.output > 0, `${m.prefix} prices must be positive`);
    assert.ok(m.output > m.input, `${m.prefix}: output should exceed input`);
  }
  assert.equal(PRICING_VERSION, RATE_CONFIG.rates_version);
  assert.match(RATE_CONFIG.source_url, /platform\.claude\.com/);
});

// --- variants ----------------------------------------------------------------

test('Sonnet 5 introductory pricing applies through 2026-08-31 and not after', () => {
  const intro = r('claude-sonnet-5');
  assert.equal(intro.variant, 'introductory');
  assert.equal(intro.input_per_mtok, 2);
  assert.equal(intro.output_per_mtok, 10);
  // Cache columns must follow the INTRO input, not the sticker input — pricing
  // the cache off $3 while pricing input off $2 is the plausible wrong split.
  assert.equal(intro.cache_write_5m_per_mtok, 2.5);
  assert.equal(intro.cache_read_per_mtok, 0.2);

  const post = ratesFor('claude-sonnet-5', { at: '2026-09-01T00:00:01Z' });
  assert.equal(post.variant, 'standard');
  assert.equal(post.input_per_mtok, 3);
  assert.equal(post.cache_read_per_mtok, 0.3);
});

test('intro window boundary is inclusive of its final second', () => {
  assert.equal(ratesFor('claude-sonnet-5', { at: '2026-08-31T23:59:59Z' }).variant, 'introductory');
  assert.equal(ratesFor('claude-sonnet-5', { at: '2026-09-01T00:00:00Z' }).variant, 'standard');
});

test('intro pricing needs a timestamp — no timestamp means sticker price', () => {
  // Deliberate: guessing the intro rate for an undated call would understate
  // cost, and a cost instrument should never guess downward.
  assert.equal(ratesFor('claude-sonnet-5').variant, 'standard');
  assert.equal(ratesFor('claude-sonnet-5').input_per_mtok, 3);
});

test('fast mode doubles Opus 5 and Opus 4.8, and cache follows the fast input', () => {
  for (const id of ['claude-opus-5', 'claude-opus-4-8']) {
    const fast = r(id, { speed: 'fast' });
    assert.equal(fast.variant, 'fast', id);
    assert.equal(fast.input_per_mtok, 10, id);
    assert.equal(fast.output_per_mtok, 50, id);
    // Vendor: "prompt caching multipliers apply on top of fast mode pricing."
    assert.equal(fast.cache_write_5m_per_mtok, 12.5, id);
    assert.equal(fast.cache_read_per_mtok, 1, id);
  }
});

test('fast mode is NOT offered on Opus 4.7 or 4.6 — those bill standard', () => {
  // Vendor: 4.7 errors on speed:'fast'; 4.6 runs at standard speed and bills
  // standard. Either way the correct price here is the standard one, and
  // inventing a fast rate for them would overstate cost by 2x.
  for (const id of ['claude-opus-4-7', 'claude-opus-4-6']) {
    const got = r(id, { speed: 'fast' });
    assert.equal(got.variant, 'standard', id);
    assert.equal(got.input_per_mtok, 5, id);
  }
});

// --- id matching -------------------------------------------------------------

test('longest-prefix match keeps a pointed entry beating a generic one', () => {
  // claude-opus-4 (retired, $15) and claude-opus-4-5 ($5) both prefix-match
  // "claude-opus-4-5-20251101". Shortest-match-wins would price it 3x high.
  assert.equal(r('claude-opus-4-5-20251101').model_prefix, 'claude-opus-4-5');
  assert.equal(r('claude-opus-4-5-20251101').input_per_mtok, 5);
  assert.equal(r('claude-opus-4-20250514').model_prefix, 'claude-opus-4');
  assert.equal(r('claude-opus-4-20250514').input_per_mtok, 15);
  assert.equal(r('claude-sonnet-4-20250514').input_per_mtok, 3);
});

test('Bedrock/Vertex platform decorations are stripped before matching', () => {
  assert.equal(normalizeModelId('anthropic.claude-opus-4-6-v1'), 'claude-opus-4-6');
  assert.equal(normalizeModelId('anthropic.claude-opus-4-6-v1[1m]'), 'claude-opus-4-6');
  assert.equal(normalizeModelId('anthropic.claude-haiku-4-5-20251001-v1:0'), 'claude-haiku-4-5-20251001');
  assert.equal(normalizeModelId('claude-opus-4-8[1m]'), 'claude-opus-4-8');
  assert.equal(normalizeModelId('us.claude-sonnet-5'), 'claude-sonnet-5');

  // The whole point: these must PRICE, not return null.
  assert.equal(r('anthropic.claude-opus-4-6-v1').input_per_mtok, 5);
  assert.equal(r('anthropic.claude-haiku-4-5-20251001-v1:0').input_per_mtok, 1);
  assert.equal(r('claude-opus-4-8[1m]').input_per_mtok, 5);
});

test('the 1M-context variant bills at standard rates, not a long-context premium', () => {
  // Vendor: Claude 4.6+ include the full 1M window at standard pricing.
  assert.deepEqual(r('claude-opus-4-8[1m]'), r('claude-opus-4-8'));
});

test('unknown and non-model ids price to null, never to a guess', () => {
  // These are real values observed in transcripts on this machine. A guessed
  // number here would be worse than a null: cost_complete:false is visible,
  // a wrong dollar figure is not.
  for (const id of ['totally-unknown', '<synthetic>', 'deepseek.r1-v1:0', 'qwen.qwen3-coder-30b-a3b-v1:0', 'opus', 'sonnet', 'haiku', 'sonnet 4.6', '', null, undefined, 42]) {
    assert.equal(ratesFor(id, { at: AT }), null, `${String(id)} must be null`);
  }
});

test('a friendly alias must not accidentally match a real prefix', () => {
  // "opus"/"sonnet" appear in transcripts (slash-command echoes). They are not
  // model ids and must not resolve — matching is id-startsWith-prefix, never
  // the reverse, and this pins that direction.
  assert.equal(ratesFor('opus', { at: AT }), null);
  assert.equal(ratesFor('claude', { at: AT }), null);
});

// --- the modifiers we deliberately do NOT implement --------------------------

test('unimplemented vendor modifiers are documented with reasons', () => {
  // Not testing behavior — testing that the decisions stay written down. A
  // future reader should be able to tell "considered and excluded" from
  // "missed", and each of these was a judgement call.
  const ni = RATE_CONFIG.not_implemented;
  for (const key of [
    'batch_api_50pct_discount',
    'data_residency_1_1x',
    'web_search_10_per_1000',
    'code_execution_0_05_per_hour',
    'managed_agents_session_runtime',
    'long_context_premium',
  ]) {
    assert.equal(typeof ni[key], 'string', `${key} must carry a reason`);
    assert.ok(ni[key].length > 40, `${key} reason must be substantive`);
  }
  assert.match(RATE_CONFIG.cross_model_caveat.tokenizer_change, /30%/);
});
