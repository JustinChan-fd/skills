// armcost — price an arm's transcript mid-flight, and decide when to stop paying.
//
// THIS FILE LIVES IN `eval/`, NOT `lib/`, and for the same reason sandbox-alias.mjs
// does: it reads harness-core's price table. That is allowed here and forbidden in
// lib/ (test/isolation.test.mjs enforces it). Reaching for the table rather than
// copying it is deliberate — a second copy of the rates would drift, and the whole
// point of the version stamp is that a figure can be re-priced later.
//
// It also uses harness-core's `collectFromFiles`, which carries the message.id dedupe
// fix. Re-deriving token sums here would put the kill decision on unvalidated
// arithmetic: pre-fix figures ran ~2.2x inflated, and a 2.2x inflation against a $6
// cap kills a healthy arm at its true $2.70.
//
// Nothing an Alfred run touches. Delete with the rest of eval/ once Experiment 2 is
// scored.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROUTING = fileURLToPath(new URL('../../harness-core/config/routing.json', import.meta.url));

function routing() {
  return JSON.parse(readFileSync(ROUTING, 'utf8'));
}

// PRE-REGISTERED KILL THRESHOLDS.
//
// Recorded here, in code, before either arm runs — so the numbers cannot be adjusted
// afterwards to justify whatever was done. A threshold picked mid-run is a threshold
// picked to make a kill look principled.
//
// Spend caps are ~3x each arm's expected cost from EXPERIMENT-2.md §3 (~$1-2 arm A,
// ~$5-6 arm B). 3x is wide enough that ordinary variance does not trip it and narrow
// enough that the $11.98 shape gets caught. The caps DIFFER by arm on purpose: a
// single shared cap would either kill arm B at its expected cost or give arm A 5x its
// budget, and "the expensive arm was killed for being expensive" is a rigged result.
//
// The stall window is 15 minutes of no new transcript bytes AND no new tokens. Arm B's
// measured wall clock was 24.6 minutes for two phases, so a per-phase gap of several
// minutes is normal; 15 minutes of total silence is not. It is deliberately longer
// than any observed think-time and shorter than the patience for a hung process.
export const THRESHOLDS = Object.freeze({
  stallMs: 15 * 60 * 1000,
  // A hard ceiling on the whole experiment regardless of per-arm caps, since both
  // arms run concurrently and two half-runaways cost as much as one full one.
  totalCapUsd: 25,
  armA: Object.freeze({ spendCapUsd: 6, expectedUsd: 2, wallCapMs: 45 * 60 * 1000 }),
  armB: Object.freeze({ spendCapUsd: 18, expectedUsd: 6, wallCapMs: 90 * 60 * 1000 }),
});

// Parses `ps -o etime=` ([[dd-]hh:]mm:ss) into ms — the ARM's own age.
//
// The wall cap was anchored on the WATCHDOG's start time, so when the watchdog died
// with a session and was restarted, `wall=` reset to 0m and a 90-minute cap could
// never fire on a 40-minute-old arm. The pre-registered bound is the arm's wall clock,
// and `etime` is the only reading that survives an arbitrary number of watcher
// restarts. Null on anything unparseable, never 0: a 0 reads as "just started" and
// would reset the cap on every poll, which is the exact bug being removed.
export function parseEtimeMs(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const [days, hms] = s.includes('-') ? s.split('-') : [null, s];
  const parts = hms.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (days !== null && !Number.isFinite(Number(days))) return null;
  const [ss, mm, hh = 0] = nums.reverse();
  const secs = ss + mm * 60 + hh * 3600 + (days === null ? 0 : Number(days) * 86400);
  return secs * 1000;
}

function normalize(model) {
  return String(model ?? '').replace(/-\d{8}$/, '');
}

// Maps the collector's direction keys onto the price table's columns.
//
// EACH ROW LISTS EVERY SPELLING, because the `in`/`out` vs `input`/`output` mismatch is
// a recorded past defect (PLAN.md §9) and the first draft of this file reproduced it:
// it mapped only `in`/`out`, the collector emits `input`/`output`, so both non-cache
// directions priced at $0 and arm 0's real transcript came out at $0.96 against a
// recorded $1.12. The tests were green throughout — their fixtures used the spelling
// the implementation expected rather than the one the collector emits.
//
// Read as first-present-wins, NOT summed: a transcript carrying both spellings must
// cost the same as one carrying either, or accepting two names becomes double-billing.
const COLUMNS = [
  [['input', 'in'], 'in'],
  [['output', 'out'], 'out'],
  [['cache_read', 'cache_read_input_tokens'], 'cache_read'],
  [['cache_creation', 'cache_creation_input_tokens'], 'cache_write'],
];

// First key that is actually present. `??` on the value would be wrong: a legitimate 0
// under the first spelling must not fall through to the second.
function tokensFor(counts, keys) {
  for (const key of keys) {
    if (counts?.[key] !== undefined && counts?.[key] !== null) return Number(counts[key]);
  }
  return 0;
}

// Prices a collector `by_model` map. Returns per-model dollars, a total, the table
// version, and the ids it could not price.
export function priceByModel(byModel, { config = routing() } = {}) {
  const table = config.model_prices_usd_per_mtok ?? {};
  // `price_table.version` — the stamp that makes a figure re-priceable when rates
  // change. Read from the file's real shape rather than guessed: an 'unknown' fallback
  // here would produce cost numbers nobody can re-derive later.
  const version = config.price_table?.version;
  if (!version) {
    throw new Error(
      `no price_table.version in ${ROUTING}: a cost figure with no table version cannot ` +
        'be re-priced, and rates change. Refusing to report an unstamped number.',
    );
  }

  const out = {};
  const unpriced = [];
  let total = 0;

  for (const [model, counts] of Object.entries(byModel ?? {})) {
    const rates = table[normalize(model)];
    if (!rates) {
      // Named, not zeroed. A missing model contributing $0 makes a runaway arm read
      // as cheap, and the kill switch silently stops protecting anything.
      unpriced.push(model);
      out[model] = { usd: null, unpriced: true };
      continue;
    }
    let usd = 0;
    for (const [countKeys, rateKey] of COLUMNS) {
      const tokens = tokensFor(counts, countKeys);
      const rate = Number(rates[rateKey] ?? 0);
      if (Number.isFinite(tokens) && Number.isFinite(rate)) usd += (tokens / 1_000_000) * rate;
    }
    out[model] = { usd, unpriced: false };
    total += usd;
  }

  return {
    by_model: out,
    // Rounded to the cent-thousandth: enough precision for a threshold comparison,
    // and it keeps float noise out of the printed figure.
    total_usd: Math.round(total * 1e6) / 1e6,
    price_table_version: version,
    unpriced,
    complete: unpriced.length === 0,
  };
}

// The kill decision. Pure, so the thresholds are testable without burning a run.
//
// `cause` is a distinct string rather than a boolean because the two kills are
// different findings: a spend kill says the topology is expensive, a stall kill says
// it hangs. Collapsing them would lose the more interesting half.
export function decideKill({ usd, spendCapUsd, sinceProgressMs, stallMs }) {
  // Spend takes precedence when both fire: money already spent is a fact, while a
  // stall is an inference drawn from silence.
  if (Number.isFinite(usd) && usd > spendCapUsd) {
    return {
      kill: true,
      cause: 'spend',
      reason:
        `spend $${usd.toFixed(2)} exceeded the pre-registered cap of $${spendCapUsd.toFixed(2)}. ` +
        'Killed rather than paying to confirm what the trend already shows.',
    };
  }
  if (Number.isFinite(sinceProgressMs) && sinceProgressMs > stallMs) {
    return {
      kill: true,
      cause: 'stall',
      reason:
        `no transcript progress for ${Math.round(sinceProgressMs / 60000)} minutes, past the ` +
        `${Math.round(stallMs / 60000)}-minute stall window. Treated as hung.`,
    };
  }
  return { kill: false, cause: null, reason: null };
}
