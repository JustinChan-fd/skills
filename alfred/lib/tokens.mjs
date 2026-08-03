// tokens — reads a Claude Code JSONL transcript and reports what it cost.
//
// Written fresh rather than ported (PLAN.md §8.2). The test CASES came from
// harness-core, because each encodes a bug found the expensive way; the code did not,
// because the Stop hook payload hands Alfred the transcript path directly and
// eliminates the discovery two-thirds of the old collector. Porting that would have
// carried dead code past its own passing tests.
//
// TWO RULES GOVERN EVERY BRANCH BELOW.
//
// 1. NEVER THROW. Cost accounting is a side-car. A parser that can fail an unattended
//    tick over a file it was only reading for telemetry has inverted its own priority.
//    Every path returns the same shape, including the failures, so a caller comparing
//    `peak_context` numerically never meets `undefined`.
//
// 2. ONE API CALL COUNTS ONCE. Claude Code writes one JSONL line per content block
//    (thinking / text / tool_use / tool_use…), repeating the same `message.usage` on
//    each under a single `message.id`. Summing per line inflated every figure this
//    project has reported by ~2x — measured at 1.956 across 322 local transcripts on
//    2026-07-30, independently reproducing harness-core's ~2.2x.
//
// Both rules have a failure mode in common, and it is the one this project keeps
// meeting: a plausible number, no error, and no way to tell correct from broken by
// looking at it.

import { readFileSync } from 'node:fs';

// The gap cap, exported and named because a run measured with an undisclosed cap
// cannot be compared to one measured with a different cap, and nothing in the
// resulting number says which was used.
//
// Five minutes: gaps longer than this are the human being away, not the agent
// working. Uncapped "active time" on an unattended loop measures the wall clock
// between ticks and reports it as compute.
export const DEFAULT_GAP_CAP_MS = 5 * 60 * 1000;

// The four directions, in the result's spelling. `cache_creation` is ONE direction
// here: splitting it by TTL is lib/prices.mjs's job, and it prices the two buckets at
// different rates. The parser's obligation is to lose neither.
const DIRECTIONS = ['input', 'output', 'cache_read', 'cache_creation'];

const zero = () => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });

// Cache-write tokens from one usage object.
//
// FLAT FIRST, THEN THE NESTED BUCKETS — never both. Measured against this gateway on
// 2026-07-30: `cache_creation_input_tokens: 25204` arrived alongside
// `cache_creation: {ephemeral_5m: 0, ephemeral_1h: 25204}`. The flat field is the
// TOTAL ACROSS BUCKETS, so adding it to its own nested buckets bills twice.
//
// The fallback exists because the flat field is not always populated: 10 real rows
// report flat 0 with a nonzero nested 5m bucket, in 3 message.id groups where every
// row has flat 0 — so no sibling row can supply it. The largest is 241,475 tokens,
// about $0.90 at sonnet-5 rates, which a flat-only read reports as free.
//
// Falling back only when flat is absent-or-zero is safe: across all 53,950 real rows,
// a nonzero flat agreed with 5m + 1h every time, so the fallback can never contradict
// a populated flat field.
function cacheCreationOf(usage) {
  const flat = num(usage.cache_creation_input_tokens);
  if (flat > 0) return flat;
  const nested = usage.cache_creation;
  if (nested && typeof nested === 'object') {
    return num(nested.ephemeral_5m_input_tokens) + num(nested.ephemeral_1h_input_tokens);
  }
  return flat;
}

// A missing or non-numeric count is 0, not NaN. A NaN reaching a threshold comparison
// always compares as "under", which is a spend cap that silently stops protecting
// anything — the exact shape of the cap that read 6% of the spend.
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function directionsOf(usage) {
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cache_read: num(usage.cache_read_input_tokens),
    cache_creation: cacheCreationOf(usage),
  };
}

// Every usage object on one transcript line, flattened.
//
// The parent's `message.usage` carries the line's `message.id`; `iterations[]`
// sub-entries are separate API calls with no id of their own, so they are emitted with
// `id: null` and must each count. Conflating those two — treating `undefined` as a
// single dedupe key — swaps a 2x overcount for a silent undercount.
function usagesFromLine(entry) {
  const out = [];
  const message = entry?.message;
  const id = message?.id ?? null;
  const model = message?.model ?? entry?.model ?? '<synthetic>';

  if (message?.usage && typeof message.usage === 'object') {
    out.push({ id, model, usage: message.usage });
  }

  const iterations = Array.isArray(entry?.iterations) ? entry.iterations : [];
  for (const it of iterations) {
    const usage = it?.usage ?? it?.message?.usage;
    if (usage && typeof usage === 'object') {
      // No id: a sub-entry is its own call and is never deduplicated against its parent.
      out.push({ id: null, model: it?.message?.model ?? model, usage });
    }
  }
  return out;
}

// One call's whole context window — the fingerprint the Agent tool reports as
// `subagent_tokens`. A SUM ACROSS THE FOUR DIRECTIONS OF A SINGLE CALL, which is why
// it is never a sum across calls.
const contextTotal = (d) => d.input + d.output + d.cache_read + d.cache_creation;

// The result shape, shared by success and both failure paths. Built in one place so a
// field cannot be added to the success path alone and leave `undefined` where a
// caller does arithmetic.
function base(extra = {}) {
  return {
    ok: true,
    by_model: {},
    timestamps: { min: null, max: null },
    active_ms: 0,
    gap_cap_ms: DEFAULT_GAP_CAP_MS,
    peak_context: 0,
    lines_parsed: 0,
    error: null,
    ...extra,
  };
}

// Parses a transcript's text. Returns the shape above; never throws.
export function collectFromText(text, { start = null, end = null, gapCapMs = DEFAULT_GAP_CAP_MS } = {}) {
  const result = base({ gap_cap_ms: gapCapMs });

  const startMs = start ? Date.parse(start) : null;
  const endMs = end ? Date.parse(end) : null;

  // MAX PER DIRECTION PER (model, id) — not first-wins, and not summed.
  //
  // The frozen test name says one message.id "counts once" but not which row's numbers
  // survive, and the real duplicates are not always identical: id ...7re4umvq carries
  // two rows with {input 2, cache_creation 5502} and, ~350 lines later, two more with
  // every top-level count zeroed. First-wins is right on all 17,330 multi-row groups
  // measured today, and is right only because of the order the producer happened to
  // use. Max is order-independent: one call has one true value per direction, and a
  // zeroed duplicate is a truncated record of it, never a second free call.
  //
  // Keyed on (model, id) rather than id alone: a bare-id key would drop a second
  // model's call sharing that id, reporting zero for it — an undercount that looks
  // exactly like a model not having been used.
  const deduped = new Map();
  // Id-less rows have no identity to merge on, so they accumulate additively.
  const additive = new Map();
  const stamps = [];

  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // A half-written trailing line is the common real case — a transcript being
      // appended to while it is read. Skip it; do not discard the valid lines before it.
      continue;
    }
    result.lines_parsed += 1;

    const tsMs = Date.parse(entry?.timestamp ?? '');
    const inWindow =
      (startMs === null || !(tsMs < startMs)) && (endMs === null || !(tsMs > endMs));

    for (const { id, model, usage } of usagesFromLine(entry)) {
      const d = directionsOf(usage);

      // peak_context is computed BEFORE the window test and outside the dedupe.
      // Deliberately: a wrong run window is what breaks time-based attribution, so
      // the fingerprint has to survive one, and a max is immune to duplicate rows
      // anyway. Gating the peak on either would break transcript identity matching
      // silently — which is how #17/#18 passed cleanly over an inflated sum.
      const total = contextTotal(d);
      if (total > result.peak_context) result.peak_context = total;

      if (!inWindow) continue;

      if (id === null) {
        const acc = additive.get(model) ?? zero();
        for (const k of DIRECTIONS) acc[k] += d[k];
        additive.set(model, acc);
      } else {
        const key = `${model}\u0000${id}`;
        const acc = deduped.get(key);
        if (!acc) {
          deduped.set(key, { model, d: { ...d } });
        } else {
          for (const k of DIRECTIONS) acc.d[k] = Math.max(acc.d[k], d[k]);
        }
      }
    }

    // Stamps are per LINE, not per deduplicated call. The dedupe gates token
    // attribution only: split-block lines are the same call milliseconds apart, and
    // dropping their stamps would silently shorten every measured run.
    if (Number.isFinite(tsMs) && inWindow) stamps.push(tsMs);
  }

  if (result.lines_parsed === 0) {
    return base({
      ok: false,
      gap_cap_ms: gapCapMs,
      error: {
        code: 'unparseable',
        detail: 'no JSONL line in this transcript could be parsed',
      },
    });
  }

  for (const [model, d] of additive) {
    const acc = result.by_model[model] ?? zero();
    for (const k of DIRECTIONS) acc[k] += d[k];
    result.by_model[model] = acc;
  }
  for (const { model, d } of deduped.values()) {
    const acc = result.by_model[model] ?? zero();
    for (const k of DIRECTIONS) acc[k] += d[k];
    result.by_model[model] = acc;
  }

  if (stamps.length > 0) {
    stamps.sort((a, b) => a - b);
    result.timestamps.min = new Date(stamps[0]).toISOString();
    result.timestamps.max = new Date(stamps[stamps.length - 1]).toISOString();
    for (let i = 1; i < stamps.length; i += 1) {
      result.active_ms += Math.min(stamps[i] - stamps[i - 1], gapCapMs);
    }
  }

  return result;
}

// Reads a transcript from disk. A missing file is a structured result, not a throw:
// the transcript may legitimately not exist yet, and that is a fact to report rather
// than a reason to fail the run being measured.
export function collectFromFile(path, options = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    return base({
      ok: false,
      gap_cap_ms: options.gapCapMs ?? DEFAULT_GAP_CAP_MS,
      error: {
        code: cause?.code === 'ENOENT' ? 'not_found' : 'unreadable',
        // The path, never the contents. The privacy rule holds on the error path too.
        detail: `could not read transcript at ${path}: ${cause?.code ?? 'unknown error'}`,
      },
    });
  }
  return collectFromText(text, options);
}
