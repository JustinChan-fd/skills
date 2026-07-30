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
// Note `cache_creation` maps to `cache_write` (the 5-minute column) and nothing maps to
// `cache_write_1h`. A 1-hour breakpoint is rejected by this gateway, so charging that
// column would bill for something that cannot occur.
const COLUMNS = [
  [['in', 'input'], 'in'],
  [['out', 'output'], 'out'],
  [['cache_read', 'cache_read_input_tokens'], 'cache_read'],
  [['cache_creation', 'cache_write', 'cache_creation_input_tokens'], 'cache_write'],
];

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

// Which rate row applies, accounting for a scheduled step-up.
//
// `at` is an optional ISO date — the record's own `started_at`, not `now()`. Reading
// the wall clock here would make cost an impure function of its inputs: the same
// historical record would re-price differently tomorrow, and the version stamp exists
// precisely so that cannot happen.
function ratesFor(table, id, at) {
  const base = table.models[id];
  if (!base) return null;
  const change = table.rate_changes?.[id];
  if (!change || !at) return base;
  return at >= change.standard_from ? change.standard : base;
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

    // An undated call cannot know which side of a step-up it is on, so it uses the
    // rates as recorded and names the model. The caveat is what makes a stale figure
    // self-identifying rather than merely plausible.
    if (table.rate_changes?.[id] && !at) rateChangePending.push(model);

    let usd = 0;
    let usable = true;
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
