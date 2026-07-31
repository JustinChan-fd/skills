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

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PROJECTS_DIR = '/Users/206618626@bwt3.com/.claude/projects';

// #59: rates come from Alfred's own decided table. See priceByModel for why this is not
// the drift the header warns about — the two tables encode different DECISIONS about the
// sonnet-5 rate, so "reach upstream to avoid a copy" priced arm C at the introductory
// rate the project had explicitly chosen against.
const PRICES = fileURLToPath(new URL('../config/prices.json', import.meta.url));

function priceTable() {
  return JSON.parse(readFileSync(PRICES, 'utf8'));
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

  // ARM C, decided 2026-07-30 (task #41) BEFORE arm C ran. Five numbers, and the
  // relationships between them are the load-bearing part:
  //
  //   n              3. One run measures a cost; three measure whether that cost is a
  //                  property of the topology or of the day.
  //   spendCapUsd    $8 per run. A KILL threshold — loose enough that it never aborts a
  //                  healthy run.
  //   acceptMeanUsd  $4 mean. An ACCEPTANCE threshold, and deliberately HALF the kill
  //                  cap. kill != acceptance: a run may legitimately cost $6, fail
  //                  acceptance, and still be worth finishing for its delivery outcome.
  //                  Collapsing these to one number would kill every run that was about
  //                  to produce the evidence that makes its own cost figure meaningful.
  //   totalCapUsd    $20 across all three, checked against CUMULATIVE spend. Below
  //                  3 x $8 = $24 on purpose: a per-run cap alone permits 3x the agreed
  //                  exposure, and $24 is not an amount anyone agreed to.
  //   wallCapMs      25 minutes. Arm B took 24.6 for two phases; arm C is one context,
  //                  so 25 minutes is generous for the topology being measured and short
  //                  enough that a wedged run does not eat an afternoon.
  //
  // The acceptance rule is a CONJUNCTION: mean <= $4 AND (max - min) <= mean. The spread
  // clause is what makes n=3 mean anything — $1, $2, $9 averages to $4 and "passes"
  // while the variance exceeds the signal. A mean-only rule would accept that.
  armC: Object.freeze({
    n: 3,
    spendCapUsd: 8,
    expectedUsd: 3,
    acceptMeanUsd: 4,
    totalCapUsd: 20,
    wallCapMs: 25 * 60 * 1000,
  }),
});

// Every transcript belonging to an arm, INCLUDING its subagents'.
//
// A phase driver is a subagent, and its transcript is written to
// `<projects>/<slug>/<session-id>/subagents/agent-*.jsonl` — one level below the loop's
// own `<session-id>.jsonl`. The first version of this listed only the top level, so it
// priced arm B at $1.072 against an $18 cap while the arm had actually spent $16.03.
// The guard was green and blind: 15/16ths of the spend was in files it never opened,
// and the cap could not have fired at any price.
//
// Two properties, both tested, because the fix pulls against the bug:
//   - recursive, so subagent spend counts;
//   - still scoped to ONE arm's dirs, so recursing does not merge the arms into one
//     figure. A walk from the projects root would price arm A's cost into arm B.
export function transcriptsFor(arm, { projectsDir } = {}) {
  const root = projectsDir ?? DEFAULT_PROJECTS_DIR;
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.jsonl')) out.push(p);
    }
  };
  for (const entry of readdirSync(root)) {
    if (!entry.includes(`exp2-${arm}-`)) continue;
    walk(join(root, entry));
  }
  return out;
}

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

// One normalizer, imported, not a third copy.
//
// This was `String(model).replace(/-\d{8}$/, '')` — dates only. So `anthropic.claude-sonnet-5`,
// the id form the gateway and the worker JSON both carry, missed every row in the table and
// came back `unpriced`. It did not surface on run 1 because harness-core's collector happens
// to emit the bare id, which is exactly the mocked-seam shape: the input the fixtures chose
// is the one input on which the bug is invisible.
//
// Task #38 already removed two copies of this logic for drifting. `lib/prices.mjs` exports
// the full version — prefix, `-vN(:N)`, date — and eval/ may import lib/ (only the reverse
// is forbidden, per test/isolation.test.mjs). A private copy here would be that same drift
// reintroduced in the file whose whole job is to be believed about money.
import { normalizeModelId as normalize } from '../lib/prices.mjs';

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
//
// #59: THE RATES COME FROM ALFRED'S OWN `config/prices.json`, not from harness-core's
// routing.json. The header above says reaching upstream avoids a second copy that could
// drift — true for the COLLECTOR, wrong for the RATES, because the two tables encode
// different decisions and had already diverged:
//
//   harness-core  claude-sonnet-5  in 2 / out 10   + introductory_until 2026-08-31
//   alfred        claude-sonnet-5  in 3 / out 15
//
// The $3/$15 choice is deliberate (task #38): it keeps every figure comparable to arm
// B's $18.483 and valid past the step-up, at the cost of reporting ~1.5x above actual
// billing until then. Reading upstream inverted that bias. Measured on arm C run 1 —
// recorded $1.974173, actual $2.961259, which is the CLI's own self-reported
// total_cost_usd to seven decimals.
//
// It is not only a reporting bug. `decideKill` compares THIS figure to the $8/run cap,
// so a 1.5x understatement made the real ceiling $12/run and $30 total.
//
// `config` stays injectable so a test can price against a known table without touching
// either file on disk.
export function priceByModel(byModel, { config = priceTable() } = {}) {
  const table = config.models ?? config.model_prices_usd_per_mtok ?? {};
  // The stamp that makes a figure re-priceable when rates change. Read from the file's
  // real shape rather than guessed: an 'unknown' fallback here would produce cost
  // numbers nobody can re-derive later. Accepts either file's shape — Alfred's table
  // versions at the top level, harness-core's under `price_table`.
  const version = config.version ?? config.price_table?.version;
  if (!version) {
    throw new Error(
      `no version in ${PRICES}: a cost figure with no table version cannot ` +
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
