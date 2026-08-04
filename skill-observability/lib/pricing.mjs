// Pricing table + deterministic cost computation.
//
// Cost is a COMPUTED value, never a raw one: every cost figure this module
// produces carries the pricing_version that produced it, so historical logs
// can be re-priced when rates change. Unknown models produce cost `null` with
// a structured note — never a guessed number.
//
// Rates are USD per million tokens. Cache multipliers (vs base input rate):
// 5-minute cache write 1.25x, 1-hour cache write 2x, cache read 0.1x.
// Source: Anthropic pricing docs (platform.claude.com/docs/en/pricing),
// captured 2026-08-04.

export const PRICING_VERSION = '2026-08-04.1';

const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;
const CACHE_READ_MULT = 0.1;

// Longest-prefix match against the transcript's model id (which may carry a
// date suffix, e.g. claude-opus-4-5-20251101). `fast` overrides apply when
// usage.speed === "fast".
const MODELS = [
  { prefix: 'claude-fable-5', input: 10, output: 50 },
  { prefix: 'claude-mythos-5', input: 10, output: 50 },
  { prefix: 'claude-opus-5', input: 5, output: 25, fast: { input: 10, output: 50 } },
  { prefix: 'claude-opus-4-8', input: 5, output: 25 },
  { prefix: 'claude-opus-4-7', input: 5, output: 25 },
  { prefix: 'claude-opus-4-6', input: 5, output: 25 },
  { prefix: 'claude-opus-4-5', input: 5, output: 25 },
  { prefix: 'claude-opus-4-1', input: 15, output: 75 },
  // Sonnet 5 sticker is $3/$15 with introductory $2/$10 through 2026-08-31.
  { prefix: 'claude-sonnet-5', input: 3, output: 15, intro: { input: 2, output: 10, through: '2026-08-31T23:59:59Z' } },
  { prefix: 'claude-sonnet-4-6', input: 3, output: 15 },
  { prefix: 'claude-sonnet-4-5', input: 3, output: 15 },
  { prefix: 'claude-haiku-4-5', input: 1, output: 5 },
];

export function ratesFor(modelId, { speed = null, at = null } = {}) {
  if (typeof modelId !== 'string') return null;
  let best = null;
  for (const m of MODELS) {
    if (modelId.startsWith(m.prefix) && (!best || m.prefix.length > best.prefix.length)) best = m;
  }
  if (!best) return null;
  let { input, output } = best;
  let variant = 'standard';
  if (speed === 'fast' && best.fast) {
    ({ input, output } = best.fast);
    variant = 'fast';
  } else if (best.intro && at && Date.parse(at) <= Date.parse(best.intro.through)) {
    ({ input, output } = best.intro);
    variant = 'introductory';
  }
  return {
    model_prefix: best.prefix,
    variant,
    input_per_mtok: input,
    output_per_mtok: output,
    cache_write_5m_per_mtok: input * CACHE_WRITE_5M_MULT,
    cache_write_1h_per_mtok: input * CACHE_WRITE_1H_MULT,
    cache_read_per_mtok: input * CACHE_READ_MULT,
  };
}

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const usd = (v) => Math.round(v * 1e6) / 1e6; // 6 decimal places of USD

/**
 * Cost of one directional bucket, split into the two components that make
 * runs comparable across sessions (see METRICS.md):
 *
 *   marginal      — input + output + all cache WRITES: spend the run itself
 *                   caused. Comparable across runs of the same skill on the
 *                   same model, regardless of session depth.
 *   context_carry — cache READS: the tax of running mid-session (re-reading
 *                   context that existed before the run). Dominated by
 *                   where the run happened, not what the skill did.
 *
 * Bucket shape: { input, output, cache_read, cache_creation_5m,
 * cache_creation_1h, cache_creation_unattributed } — the last is cache-write
 * volume whose TTL split was absent from the transcript; priced at the 5m
 * rate and flagged by the caller.
 */
export function costOfBucket(bucket, rates) {
  if (!rates) return null;
  const perTok = (perMtok) => perMtok / 1_000_000;
  const marginal =
    n(bucket.input) * perTok(rates.input_per_mtok) +
    n(bucket.output) * perTok(rates.output_per_mtok) +
    n(bucket.cache_creation_5m) * perTok(rates.cache_write_5m_per_mtok) +
    n(bucket.cache_creation_1h) * perTok(rates.cache_write_1h_per_mtok) +
    n(bucket.cache_creation_unattributed) * perTok(rates.cache_write_5m_per_mtok);
  const carry = n(bucket.cache_read) * perTok(rates.cache_read_per_mtok);
  return { usd: usd(marginal + carry), marginal_usd: usd(marginal), context_carry_usd: usd(carry) };
}
