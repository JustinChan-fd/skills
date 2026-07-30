// prices — model id normalization and cost math.
//
// Two jobs, and one rule that governs both: **never report a number you cannot stand
// behind.** PLAN.md §M0 states it as "a zero cost is plottable and false, which is
// worse than a hole," and every branch below is an application of it. When this module
// cannot price something it says so by name; it does not fall back to $0, and it does
// not let a NaN into a total that a threshold will later be compared against.
//
// The reason that rule is written in capitals rather than assumed: four separate
// guards in this project have already shipped green and blind — an `in`/`out` price
// mapping that zeroed two directions, a byte-based stall detector that could not fire,
// a wall clock that reset with its watcher, and a spend cap reading 6% of the spend.
// All four produced a plausible number with no error and no way to tell correct from
// broken by looking at it. A false zero here is the same failure with a dollar sign.
//
// It reads `alfred/config/prices.json` — a COPY of harness-core's table, deliberately.
// `eval/armcost.mjs` reaches upstream because measuring the thing you are replacing
// requires touching it; `lib/` must not, and `test/isolation.test.mjs` enforces that.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TABLE_PATH = fileURLToPath(new URL('../config/prices.json', import.meta.url));

let cached = null;

// The copied table, parsed once. Cached because pricing is called per model per record
// and re-reading the file would make cost a function of disk state.
export function loadPriceTable() {
  if (!cached) cached = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
  return cached;
}

// Collector ids to table ids.
//
// Every transform here corresponds to a spelling actually observed in this machine's
// transcripts, not to a shape that seemed plausible:
//
//   claude-haiku-4-5-20251001              dated
//   anthropic.claude-sonnet-4-6            Bedrock prefix
//   anthropic.claude-opus-4-6-v1           prefix + version suffix
//   anthropic.claude-haiku-4-5-20251001-v1:0   prefix + date + versioned suffix
//
// The `[1m]` marker is deliberately NOT stripped. `claude-opus-4-8[1m]` is the
// 1M-context variant, which bills above the standard row past 200k, and those rates
// are not in the table. Normalizing the marker away would price a premium call at the
// standard rate — a number that is quietly too low with nothing to indicate it. Left
// intact, the id misses the table and is reported as unpriced, which is the honest
// outcome: the figure is short by a listed amount rather than an invisible one.
export function normalizeModelId(model) {
  return String(model ?? '')
    .replace(/^anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-\d{8}$/, '');
}

// The collector's direction keys, mapped onto the table's columns.
//
// EACH ROW LISTS EVERY SPELLING because the mismatch is a recorded defect (PLAN.md §9)
// that shipped twice: `eval/armcost.mjs`'s first draft mapped only `in`/`out` while the
// collector emits `input`/`output`, so both non-cache directions priced at $0 and arm
// 0's real transcript came out at $0.96 against a recorded $1.12 — with green tests
// throughout, because the fixtures used the spelling the implementation expected rather
// than the one the producer emits.
//
// FIRST-PRESENT-WINS, NOT SUMMED. Accepting two names for one count introduces the
// opposite risk: a transcript carrying both spellings must cost the same as one
// carrying either, or the flexibility becomes double-billing.
//
// Cache writes are NOT in this list. They need the split below, because they are the one
// direction where two recorded numbers can describe the same tokens.
const COLUMNS = [
  [['in', 'input'], 'in'],
  [['out', 'output'], 'out'],
  [['cache_read', 'cache_read_input_tokens'], 'cache_read'],
];

// Cache-write count keys, in the three shapes a record can carry them.
//
// FLAT IS THE TOTAL ACROSS TTL BUCKETS, NOT THE 5-MINUTE PORTION. Measured against this
// gateway on 2026-07-30, a write with an explicit 1h breakpoint returned:
//
//   "cache_creation_input_tokens": 25204,
//   "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 25204 }
//
// So charging the flat field at the 5m rate and then adding the 1h column bills the same
// tokens twice. The 5-minute portion is a DERIVED quantity whenever the record does not
// state it outright.
const CACHE_WRITE_TOTAL = ['cache_creation', 'cache_write', 'cache_creation_input_tokens'];
const CACHE_WRITE_5M = ['cache_creation_5m', 'ephemeral_5m_input_tokens'];
const CACHE_WRITE_1H = ['cache_creation_1h', 'ephemeral_1h_input_tokens'];

// The first key actually PRESENT, not the first truthy one. `??` would be a bug here:
// `{ in: 0, input: 1000000 }` is a contradiction, and resolving it by skipping the
// explicit zero invents a million tokens that were never used.
function tokensFor(counts, keys) {
  for (const key of keys) {
    const value = counts?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return 0;
}

// True when none of `keys` is present, as distinct from present-and-zero. The 5m split
// below has to tell "the record says 0" from "the record says nothing," because those
// two lead to different arithmetic.
function hasAny(counts, keys) {
  return keys.some((key) => counts?.[key] !== undefined && counts?.[key] !== null);
}

// Splits a cache-write count into its two TTL buckets and returns dollars.
//
// The three cases, and why each is what it is:
//
//   only a flat total          all 5m. The overwhelmingly common record, and the one
//                              arm 0's $1.12 anchor is built from — adding this split
//                              must not move it.
//   explicit 5m and 1h         both authoritative. Nothing is derived when the record
//                              already states the split.
//   flat total plus 1h         5m = total - 1h. The measured payload shape. Deriving is
//                              what prevents the double charge.
//
// `usable: false` rather than a clamp when the 1h portion exceeds its total: a negative
// 5m portion would subtract real money, and clamping to zero reports a confident figure
// derived from a contradiction. The unambiguous half is still charged.
function cacheWriteUsd(counts, rates) {
  const oneHour = Number(tokensFor(counts, CACHE_WRITE_1H));
  const rate5m = Number(rates.cache_write ?? 0);
  const rate1h = Number(rates.cache_write_1h ?? 0);

  if (!Number.isFinite(oneHour) || !Number.isFinite(rate5m) || !Number.isFinite(rate1h)) {
    return { usd: 0, usable: false };
  }

  let fiveMinute;
  let usable = true;
  if (hasAny(counts, CACHE_WRITE_5M)) {
    fiveMinute = Number(tokensFor(counts, CACHE_WRITE_5M));
  } else {
    const total = Number(tokensFor(counts, CACHE_WRITE_TOTAL));
    if (!Number.isFinite(total)) return { usd: (oneHour / 1e6) * rate1h, usable: false };
    // A flat total is only ever the whole story when there is no 1h portion to remove
    // from it; otherwise it is the sum and the 1h half has already been accounted for.
    fiveMinute = total - oneHour;
    if (fiveMinute < 0) {
      // The record contradicts itself. Charge the 1h portion, which is unambiguous, and
      // let the caller mark the total incomplete.
      return { usd: (oneHour / 1e6) * rate1h, usable: false };
    }
  }

  if (!Number.isFinite(fiveMinute)) return { usd: (oneHour / 1e6) * rate1h, usable: false };
  return { usd: (fiveMinute / 1e6) * rate5m + (oneHour / 1e6) * rate1h, usable };
}

// Which rate row applies.
//
// `at` is accepted and deliberately unused for now. The USER'S DECISION 2026-07-30: price
// sonnet-5 at its post-step-up $3/$15 always, including inside the introductory window,
// so every figure stays directly comparable to arm B's recorded $18.483 (measured on
// sonnet-4-6 at $3/$15) and no figure changes meaning on 2026-09-01. The consequence,
// stated in the table too so nobody "corrects" it back: until September every reported
// dollar runs 1.5x ABOVE what was billed — a deliberate conservative bias.
//
// The parameter stays in the signature because it is the hook for the NEXT scheduled
// change, and because the alternative is worse: `at` is the record's own `started_at`,
// never `now()`. A cost function that consults the wall clock is not a pure function of
// its inputs, so the same historical record would re-price differently tomorrow — which
// is exactly what the version stamp exists to prevent.
//
// Table rows therefore carry the STANDARD rate directly; `rate_changes` records the
// introductory rate that is not being applied, because a rate we decline to charge is
// still a fact, and dropping it would make the decision indistinguishable from never
// having noticed the step-up.
function ratesFor(table, id, _at) {
  return table.models[id] ?? null;
}

// Prices a `by_model` map. Returns per-model dollars, a total, the table version, the
// ids it could not price, and the ids whose rate is scheduled to change.
export function priceTokens(byModel, { at = null } = {}) {
  const table = loadPriceTable();

  const out = {};
  const unpriced = [];
  const rateChangePending = [];
  let total = 0;
  let complete = true;

  for (const [model, counts] of Object.entries(byModel ?? {})) {
    const id = normalizeModelId(model);
    const rates = ratesFor(table, id, at);

    if (!rates) {
      // Named, never zeroed. A model absent from the table contributing $0 makes a
      // runaway run read as cheap, and every spend threshold downstream silently
      // stops protecting anything.
      unpriced.push(model);
      out[model] = { usd: null, unpriced: true };
      complete = false;
      continue;
    }

    let usd = 0;
    let usable = true;

    // Cache writes first, because they are the only direction needing the TTL split.
    const cacheWrite = cacheWriteUsd(counts, rates);
    usd += cacheWrite.usd;
    if (!cacheWrite.usable) usable = false;

    for (const [countKeys, rateKey] of COLUMNS) {
      const tokens = Number(tokensFor(counts, countKeys));
      const rate = Number(rates[rateKey] ?? 0);
      // A non-numeric count is a broken input, not a zero. Absorbing it would put a
      // number in the total that no token count produced.
      if (!Number.isFinite(tokens) || !Number.isFinite(rate)) {
        usable = false;
        continue;
      }
      usd += (tokens / 1_000_000) * rate;
    }

    if (!usable) complete = false;
    out[model] = { usd, unpriced: false };
    total += usd;
  }

  return {
    by_model: out,
    // Rounded to the cent-thousandth: enough precision for a threshold comparison, and
    // it keeps float noise out of the printed figure.
    total_usd: Math.round(total * 1e6) / 1e6,
    price_table_version: table.version,
    unpriced,
    rate_change_pending: rateChangePending,
    complete,
  };
}
