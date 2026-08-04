import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, buildRecord } from '../lib/record.mjs';
import { ratesFor, costOfBucket } from '../lib/pricing.mjs';

function entry(overrides = {}) {
  return {
    source: 'session',
    model: 'claude-fable-5',
    timestamp: '2026-08-04T10:00:00.000Z',
    usage: {
      input_tokens: 10,
      output_tokens: 100,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
    },
    ...overrides,
  };
}

test('iterations are summed INSTEAD of top-level usage — never both', () => {
  const withIterations = entry({
    usage: {
      input_tokens: 10,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: [
        { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
    },
  });
  const agg = aggregate([withIterations]);
  const b = agg.tokens.by_model['claude-fable-5'];
  assert.equal(b.input, 10); // NOT 20
  assert.equal(b.output, 100); // NOT 200
});

test('per-TTL cache split is preserved; remainder is unattributed, not silently 5m', () => {
  const e = entry({
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 400 },
    },
  });
  const b = aggregate([e]).tokens.by_model['claude-fable-5'];
  assert.equal(b.cache_creation_5m, 300);
  assert.equal(b.cache_creation_1h, 400);
  assert.equal(b.cache_creation_unattributed, 300);
});

test('no cache_creation object at all => whole write is unattributed + note', () => {
  const e = entry({
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 },
  });
  const agg = aggregate([e]);
  assert.equal(agg.tokens.by_model['claude-fable-5'].cache_creation_unattributed, 500);
  assert.ok(agg.notes.some((n) => n.code === 'cache_ttl_split_missing'));
});

test('unknown model degrades cost to null with a note — never a guess', () => {
  const agg = aggregate([entry({ model: 'claude-future-9' })]);
  assert.equal(agg.cost.by_model['claude-future-9'].usd, null);
  assert.equal(agg.cost.total_usd, null);
  assert.equal(agg.cost.complete, false);
  assert.ok(agg.notes.some((n) => n.code === 'unknown_model_pricing'));
});

test('cost arithmetic: fable-5 rates, cache multipliers, marginal/carry split', () => {
  const rates = ratesFor('claude-fable-5');
  assert.equal(rates.input_per_mtok, 10);
  assert.equal(rates.cache_write_5m_per_mtok, 12.5);
  assert.equal(rates.cache_write_1h_per_mtok, 20);
  assert.equal(rates.cache_read_per_mtok, 1);
  const split = costOfBucket(
    { input: 1_000_000, output: 1_000_000, cache_read: 1_000_000, cache_creation_5m: 1_000_000, cache_creation_1h: 1_000_000, cache_creation_unattributed: 0 },
    rates,
  );
  assert.equal(split.usd, 10 + 50 + 1 + 12.5 + 20);
  // marginal = everything the run caused; carry = cache reads only
  assert.equal(split.marginal_usd, 10 + 50 + 12.5 + 20);
  assert.equal(split.context_carry_usd, 1);
  assert.equal(split.marginal_usd + split.context_carry_usd, split.usd);
});

test('aggregate exposes the split at totals level and it sums to total_usd', () => {
  const agg = aggregate([entry()]);
  const c = agg.cost;
  assert.ok(c.marginal_usd > 0);
  assert.ok(c.context_carry_usd > 0);
  assert.equal(Math.round((c.marginal_usd + c.context_carry_usd) * 1e6) / 1e6, c.total_usd);
  // deep-session shape: carry dominated by cache_read (1000 tokens read vs 210 caused)
  assert.ok(c.by_model['claude-fable-5'].context_carry_usd < c.by_model['claude-fable-5'].marginal_usd);
});

test('pricing: longest-prefix wins, date suffix tolerated, fast + intro variants', () => {
  assert.equal(ratesFor('claude-opus-4-5-20251101').model_prefix, 'claude-opus-4-5');
  assert.equal(ratesFor('claude-opus-5', { speed: 'fast' }).input_per_mtok, 10);
  assert.equal(ratesFor('claude-sonnet-5', { at: '2026-08-04T00:00:00Z' }).variant, 'introductory');
  assert.equal(ratesFor('claude-sonnet-5', { at: '2026-09-15T00:00:00Z' }).variant, 'standard');
  assert.equal(ratesFor('totally-unknown'), null);
});

test('boundary_total is the LAST session line four-way top-level sum', () => {
  const agg = aggregate([
    entry({ timestamp: '2026-08-04T10:00:00Z' }),
    entry({
      timestamp: '2026-08-04T10:05:00Z',
      usage: { input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
    }),
  ]);
  assert.equal(agg.tokens.boundary_total, 100);
});

test('duration: wall vs gap-capped active time', () => {
  const agg = aggregate(
    [
      entry({ timestamp: '2026-08-04T10:00:00Z' }),
      entry({ timestamp: '2026-08-04T10:01:00Z' }),
      entry({ timestamp: '2026-08-04T11:01:00Z' }), // 1h idle gap
    ],
    { gapCapMs: 5 * 60 * 1000 },
  );
  assert.equal(agg.duration.wall_ms, 61 * 60 * 1000);
  assert.equal(agg.duration.active_ms, 60 * 1000 + 5 * 60 * 1000);
});

test('buildRecord separates raw from computed and totals subagents', () => {
  const sessionEntries = [entry()];
  const subagents = [
    {
      file: 'agent-x.jsonl',
      meta: { agentType: 'Explore', spawnDepth: 1 },
      lines_from: 0,
      lines_to: 3,
      usage_entries: [entry({ source: 'subagent:agent-x.jsonl', model: 'claude-haiku-4-5', usage: { input_tokens: 50, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })],
    },
  ];
  const record = buildRecord({
    hookPayload: { session_id: 's', hook_event_name: 'Stop', cwd: '/x', transcript_path: '/x/t.jsonl' },
    invocations: [{ kind: 'skill_tool', name: 'demo', args: null, line_index: 0 }],
    usageEntries: sessionEntries,
    toolCalls: [{ name: 'Bash' }, { name: 'Bash' }, { name: 'Read' }],
    dispatchResults: [],
    subagents,
    interruption: false,
    window: { line_from: 0, line_to: 4, transcript_lines_total: 4 },
    environment: { platform: 'linux', node: 'v22' },
  });
  // raw is verbatim
  assert.equal(record.raw.usage_entries[0].usage.cache_creation.ephemeral_5m_input_tokens, 200);
  assert.equal(record.raw.subagents[0].meta.agentType, 'Explore');
  // computed is derived
  assert.equal(record.computed.counts.subagents, 1);
  assert.equal(record.computed.counts.subagent_tokens_grand_total, 100);
  assert.equal(record.computed.counts.tool_calls_by_name.Bash, 2);
  assert.ok(record.computed.tokens.by_model['claude-haiku-4-5']);
  assert.equal(record.run.skills[0], 'demo');
  // no cross-contamination: raw carries no derived keys
  assert.equal(record.raw.tokens, undefined);
  assert.equal(record.raw.cost, undefined);
});
