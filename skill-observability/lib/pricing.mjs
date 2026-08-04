// Pricing table + deterministic cost computation.
//
// Cost is a COMPUTED value, never a raw one: every cost figure this module
// produces carries the pricing_version that produced it, so historical logs
// can be re-priced when rates change. Unknown models produce cost `null` with
// a structured note — never a guessed number.
//
// Rates are USD per million tokens and live in config/model-rates.json —
// transcribed verbatim from the vendor table so that a price change is a data
// edit, not a code edit. This module is arithmetic over that file and holds no
// numbers of its own. Source and fetch date are recorded in the config.
//
// The config stores all four columns per model EXPLICITLY (input, output, and
// the three cache columns) rather than deriving cache prices from
// input x multiplier. Today every vendor row satisfies 1.25x / 2x / 0.1x
// exactly, and a test asserts that so a transcription typo fails loudly — but
// storing the vendor's own numbers means a future change that breaks the
// relationship prices correctly instead of silently wrong.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'model-rates.json');
export const RATE_CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

// Version stamped onto every record so a historical log can be re-priced. It
// tracks the CONFIG's version: bump rates_version there when rates change and
// old records remain re-priceable from their raw token counts.
export const PRICING_VERSION = RATE_CONFIG.rates_version;

export const CACHE_WRITE_5M_MULT = RATE_CONFIG.cache_multipliers.cache_write_5m;
export const CACHE_WRITE_1H_MULT = RATE_CONFIG.cache_multipliers.cache_write_1h;
export const CACHE_READ_MULT = RATE_CONFIG.cache_multipliers.cache_read;

const MODELS = RATE_CONFIG.models;

// Extra prefixes that resolve to a model entry, for naming conventions that
// don't follow claude-{name}-{major}. The 3.x family inverts word order
// (claude-3-5-haiku vs claude-haiku-4-5), so Haiku 3.5's real id would price to
// null without this. Data, so the next surprise is a config edit.
const PREFIX_ALIASES = Object.entries(RATE_CONFIG.prefix_aliases ?? {})
  .filter(([k]) => !k.startsWith('_'));

// Pull the five token prices off a model entry, or off its fast/intro override
// when one applies, falling back to input x multiplier for any cache column the
// vendor table didn't state explicitly.
//
// The override is read INSTEAD of the base, never merged over it. Merging is the
// trap: a fast-mode entry states only input/output, so `{...base, ...fast}`
// would inherit the base's cache columns and bill cache at the standard rate
// while billing input at the fast rate — $6.25 where the vendor charges $12.50.
// An unstated cache column has to be re-derived from the OVERRIDE's input,
// because the vendor stacks caching multipliers on top of fast pricing.
function columnsOf(base, override) {
  const src = override ?? base;
  const input = src.input ?? base.input;
  const pick = (key, mult) => (typeof src[key] === 'number' ? src[key] : input * mult);
  return {
    input_per_mtok: input,
    output_per_mtok: src.output ?? base.output,
    cache_write_5m_per_mtok: pick('cache_write_5m', CACHE_WRITE_5M_MULT),
    cache_write_1h_per_mtok: pick('cache_write_1h', CACHE_WRITE_1H_MULT),
    cache_read_per_mtok: pick('cache_read', CACHE_READ_MULT),
  };
}

/**
 * Reduce any platform's spelling of a model id to the Claude API form, so the
 * same model prices identically wherever it was served. The config carries only
 * Claude API prefixes (see the `models` array); every other naming convention
 * is normalized to one of those here rather than duplicated as a second entry.
 *
 *   anthropic.claude-opus-4-6-v1           -> claude-opus-4-6      (Bedrock)
 *   us.anthropic.claude-opus-5[1m]         -> claude-opus-5        (Bedrock regional)
 *   global.anthropic.claude-sonnet-5[1m]   -> claude-sonnet-5      (Bedrock global)
 *   anthropic.claude-haiku-4-5-...-v1:0    -> claude-haiku-4-5-... (Bedrock, dated)
 *   claude-opus-4-5@20251101               -> claude-opus-4-5-20251101 (Vertex)
 *   claude-opus-4-8[1m]                    -> claude-opus-4-8      (1M context)
 *
 * Order matters and the region strip must be REPEATABLE: a regional Bedrock id
 * carries TWO dotted prefixes (`us.` then `anthropic.`), so a single
 * alternation eats only `us.` and leaves `anthropic.claude-opus-5`, which
 * prefix-matches nothing and prices to null. Hence the `+` on the group.
 *
 * `[1m]` marks the 1M-context variant, which the vendor bills at standard rates
 * ("a 900k request is billed at the same per-token rate as a 9k request"), so
 * for pricing purposes it is pure decoration. Vertex separates the snapshot
 * date with `@` where the Claude API uses `-`, so that is rewritten rather than
 * stripped — the date distinguishes real snapshots.
 *
 * Scope, honestly: on this machine no decorated id has ever reached the pricer.
 * `anthropic.*` appears only in workflow metadata and toolUseResult payloads
 * (145 + 59 occurrences), and every `us.anthropic.*` hit is prose inside a
 * transcript, never a `model` field. This guards a gateway reconfiguration —
 * except the region-prefix case, which WAS a live bug in the regex above.
 */
export function normalizeModelId(modelId) {
  return String(modelId)
    .replace(/^((anthropic|us|eu|apac|global)\.)+/, '')
    .replace(/\[1m\]$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/@(\d{8})$/, '-$1');
}

/**
 * Longest-prefix match against the transcript's model id, which may carry a
 * date suffix (claude-opus-4-5-20251101) — and note that the config carries
 * both `claude-opus-4` and `claude-opus-4-5`, so longest-prefix is what keeps
 * the pointed entry winning over the retired generic one.
 *
 * Aliases from config.prefix_aliases compete in the SAME longest-prefix
 * contest, by their own length rather than the target's, so an alias can only
 * win where it is the most specific match.
 *
 * `fast` overrides apply when usage.speed === "fast"; `intro` applies when the
 * call's timestamp falls on or before the introductory window's end. Fast wins
 * over intro because no current model carries both.
 */
export function ratesFor(modelId, { speed = null, at = null } = {}) {
  if (typeof modelId !== 'string') return null;
  const id = normalizeModelId(modelId);
  let best = null;
  let bestLen = 0;
  for (const m of MODELS) {
    if (id.startsWith(m.prefix) && m.prefix.length > bestLen) {
      best = m;
      bestLen = m.prefix.length;
    }
  }
  for (const [alias, target] of PREFIX_ALIASES) {
    if (id.startsWith(alias) && alias.length > bestLen) {
      const m = MODELS.find((x) => x.prefix === target);
      if (m) {
        best = m;
        bestLen = alias.length;
      }
    }
  }
  if (!best) return null;
  let override = null;
  let variant = 'standard';
  if (speed === 'fast' && best.fast) {
    override = best.fast;
    variant = 'fast';
  } else if (best.intro && at && Date.parse(at) <= Date.parse(best.intro.through)) {
    override = best.intro;
    variant = 'introductory';
  }
  return { model_prefix: best.prefix, variant, ...columnsOf(best, override) };
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
