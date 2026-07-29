// Model-id → tier resolution for directional token accounting.
//
// routing.json's model_id_to_tier holds ONE canonical spelling per model
// (undated, unprefixed). Real transcripts carry three more spellings of the
// same models, and 46.6% of usage lines in a local sample (3,583 of 7,684)
// carried an id the raw map could not resolve — claude-sonnet-4-5-20250929
// alone was 1,739 of them. Each unresolved id forces
// tokens_directional.complete:false on an otherwise perfect capture, and
// leaves the tokens unpriceable.
//
// WHAT THIS DELIBERATELY DOES NOT DO: guess a tier from a family substring
// ("contains sonnet → MID"). Date-stripping and anthropic.-stripping are
// lossless respellings of one specific model — the id still names exactly the
// model the map has an entry and a price for. A substring match is a different
// thing entirely: a guess. It would price a future claude-sonnet-9 at today's
// sonnet rates and, worse, silence the rename tripwire in config.test.mjs that
// exists precisely to fail loudly when a new flagship appears. An id this
// module does not recognize must come back null.
//
// Pure: no I/O, no imports, never throws. Token collection must never crash the
// run it is enriching.

// Bedrock-style vendor prefix. ONLY this exact prefix is stripped — a generic
// /^\w+\./ would also strip qwen. and deepseek., which are real ids in local
// transcripts that genuinely have no Anthropic tier or price.
const VENDOR_PREFIX = 'anthropic.';

// A trailing model snapshot date: exactly 8 digits at the end, e.g. the -20250929
// of claude-sonnet-4-5-20250929. Anchored and fixed-width so it cannot eat a
// version segment — claude-opus-4-8 keeps its -8.
const DATE_SUFFIX_RE = /-\d{8}$/;

/**
 * Canonical spelling of a model id: `anthropic.` prefix removed, trailing
 * -YYYYMMDD date removed. Returns null for anything that is not a string.
 * An id needing no changes is returned unchanged (including the '<synthetic>'
 * sentinel, which is a literal map key rather than a model name).
 */
export function normalizeModelId(id) {
  if (typeof id !== 'string') return null;
  let out = id;
  if (out.startsWith(VENDOR_PREFIX)) out = out.slice(VENDOR_PREFIX.length);
  return out.replace(DATE_SUFFIX_RE, '');
}

/**
 * Look up a model id's tier in a model_id_to_tier map, trying the id exactly as
 * given before its normalized spelling. Exact-first matters: it lets the map
 * carry an entry for a literal id that normalization would otherwise rewrite.
 * Returns null when unresolvable — the caller reports that as a degradation.
 */
export function tierForModelId(id, map) {
  if (typeof id !== 'string' || map === null || typeof map !== 'object') return null;
  if (Object.hasOwn(map, id)) return map[id];
  const normalized = normalizeModelId(id);
  if (normalized !== null && normalized !== id && Object.hasOwn(map, normalized)) {
    return map[normalized];
  }
  return null;
}
