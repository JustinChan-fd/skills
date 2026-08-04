// Snapshot record builder: the one place where `raw` and `computed` meet.
//
// Record shape (schema/skill-run.schema.json is the normative version):
//   {
//     schema_version, logged_at,
//     run:      { identity of this run: session, event, cwd, window }
//     raw:      { verbatim material copied from hook payload + transcripts }
//     computed: { every derived number, each traceable to raw }
//   }
//
// The invariant this module enforces: nothing under `raw` is transformed
// (beyond selecting which lines fall in the window), and nothing under
// `computed` is ever the only place a source number lives.
import { ratesFor, costOfBucket, PRICING_VERSION } from './pricing.mjs';

export const SCHEMA_VERSION = '1';

// Gap cap for active-time: idle stretches longer than this count as this much
// (same convention as alfred-core's tokens-collect DEFAULT_GAP_CAP_MS).
export const DEFAULT_GAP_CAP_MS = 5 * 60 * 1000;

function emptyBucket() {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_creation_5m: 0,
    cache_creation_1h: 0,
    cache_creation_unattributed: 0,
    api_calls: 0,
  };
}

// Usage objects to count for one entry. The API documents usage.iterations as
// the per-attempt source of truth (top-level covers only the attempt that
// produced the returned message), so when iterations[] is present we sum the
// iterations INSTEAD of the top level — never both, which would double-count.
function usagesToCount(usage) {
  if (Array.isArray(usage?.iterations) && usage.iterations.length > 0) {
    return usage.iterations.map((it) => it?.usage ?? it).filter((u) => u && typeof u === 'object');
  }
  return usage && typeof usage === 'object' ? [usage] : [];
}

function addUsage(bucket, u) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  bucket.input += n(u.input_tokens);
  bucket.output += n(u.output_tokens);
  bucket.cache_read += n(u.cache_read_input_tokens);
  const cc = n(u.cache_creation_input_tokens);
  const five = n(u.cache_creation?.ephemeral_5m_input_tokens);
  const hour = n(u.cache_creation?.ephemeral_1h_input_tokens);
  if (u.cache_creation && typeof u.cache_creation === 'object') {
    bucket.cache_creation_5m += five;
    bucket.cache_creation_1h += hour;
    // Any remainder the split doesn't account for stays visible, not silently 5m'd.
    const rem = cc - five - hour;
    if (rem > 0) bucket.cache_creation_unattributed += rem;
  } else {
    bucket.cache_creation_unattributed += cc;
  }
}

function bucketTotal(b) {
  return b.input + b.output + b.cache_read + b.cache_creation_5m + b.cache_creation_1h + b.cache_creation_unattributed;
}

// Final-turn four-way sum over TOP-LEVEL usage — the quantity a dispatcher
// observes at the boundary (docs/specs/2026-07-31-token-measurement-contract.md
// §1a). Computed from session-source entries only, in line order.
function boundaryTotal(usageEntries) {
  let last = null;
  for (const e of usageEntries) {
    if (e.source !== 'session') continue;
    const u = e.usage;
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const t = n(u.input_tokens) + n(u.output_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
    last = t;
  }
  return last;
}

export function aggregate(usageEntries, { gapCapMs = DEFAULT_GAP_CAP_MS } = {}) {
  const byModel = {};
  const notes = [];
  const stamps = [];
  // Speed is tracked PER (model, speed) bucket, never once per window. A single
  // session-global value applied the fast multiplier to every model: 1M fast +
  // 1M standard Opus 5 input reported $20.00 where $15.00 is correct.
  const speedByModel = {};

  // Dedupe by message.id. Several transcript lines can carry usage for ONE API
  // call under a single message.id — measured 6,222 of 11,805 rows on this
  // machine, a 2.097x overcount when summed naively (project_cost_accounting).
  //
  // Two properties the naive fixes get wrong:
  //   - duplicates are NOT identical (2,946 of them carried nonzero tokens), so
  //     first-wins/last-wins both lose real spend. Keep the MAX per direction:
  //     a zeroed or smaller duplicate is a truncated record of the same call,
  //     never a second free one.
  //   - a MISSING id must not become a shared key, or a 2x overcount is traded
  //     for a silent undercount. Id-less rows are each their own call.
  const dedup = new Map(); // key -> { model, speed, bucket }
  let anon = 0;
  for (const entry of usageEntries) {
    const model = entry.model ?? 'unknown';
    const speed = typeof entry.usage?.speed === 'string' ? entry.usage.speed : null;
    // Model is part of the key: the same message.id under two model ids is not
    // one call, and collapsing across models would corrupt per-model pricing.
    const key = entry.message_id ? `id:${model} ${entry.message_id}` : `anon:${anon += 1}`;

    const one = emptyBucket();
    for (const u of usagesToCount(entry.usage)) addUsage(one, u);

    const prev = dedup.get(key);
    if (!prev) {
      dedup.set(key, { model, speed, bucket: one });
    } else {
      // Same call seen again: keep the larger figure in each direction.
      for (const k of Object.keys(one)) {
        if (k === 'api_calls') continue;
        prev.bucket[k] = Math.max(prev.bucket[k], one[k]);
      }
      // A fast marker anywhere in the group applies to the whole call.
      if (speed && !prev.speed) prev.speed = speed;
    }

    // Timestamps are per LINE, not per deduplicated call: duration should
    // reflect the wall-clock span the session actually occupied.
    const ms = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(ms)) stamps.push(ms);
  }

  // Fold the deduplicated calls into per-model buckets. api_calls counts REAL
  // calls, so cost-per-call stays honest.
  //
  // Tokens roll up per MODEL (the reported shape), but cost is computed per
  // (model, speed) because the rate differs: summing tokens first and then
  // picking one rate is exactly the bug this replaces. bySpeed keeps the
  // sub-buckets pricing needs without changing by_model.
  const bySpeed = {}; // `${model} ${speed ?? ''}` -> { model, speed, bucket }
  for (const { model, speed, bucket } of dedup.values()) {
    byModel[model] ??= emptyBucket();
    for (const k of Object.keys(bucket)) {
      if (k === 'api_calls') continue;
      byModel[model][k] += bucket[k];
    }
    byModel[model].api_calls += 1;

    const sig = `${model} ${speed ?? ''}`;
    bySpeed[sig] ??= { model, speed, bucket: emptyBucket() };
    for (const k of Object.keys(bucket)) {
      if (k === 'api_calls') continue;
      bySpeed[sig].bucket[k] += bucket[k];
    }
    bySpeed[sig].bucket.api_calls += 1;
    if (speed) speedByModel[model] = speed;
  }

  stamps.sort((a, b) => a - b);
  let activeMs = 0;
  for (let i = 1; i < stamps.length; i += 1) activeMs += Math.min(stamps[i] - stamps[i - 1], gapCapMs);

  const totals = emptyBucket();
  delete totals.api_calls;
  let apiCalls = 0;
  for (const b of Object.values(byModel)) {
    for (const k of Object.keys(totals)) totals[k] += b[k];
    apiCalls += b.api_calls;
  }

  // Cost per model, then summed. Unknown model => cost null + note, and the
  // grand total degrades to null rather than pretending completeness.
  const costByModel = {};
  let costTotal = 0;
  let marginalTotal = 0;
  let carryTotal = 0;
  let costComplete = true;
  const firstStamp = stamps.length ? new Date(stamps[0]).toISOString() : null;
  const usd6 = (v) => Math.round(v * 1e6) / 1e6;

  // Price each (model, speed) bucket at ITS OWN rate, then sum into the model.
  for (const { model, speed, bucket } of Object.values(bySpeed)) {
    const rates = ratesFor(model, { speed, at: firstStamp });
    const split = costOfBucket(bucket, rates);
    // An unpriced bucket carrying ZERO tokens is free by arithmetic, not by
    // guess — so it must not drag the whole window's cost to null. Measured:
    // `<synthetic>` (a harness placeholder, stop_reason "stop_sequence", every
    // token field 0) appears in 73 rows across this machine's 434 sessions and
    // nulled the cost of 4,471,414,795 real tokens. The unknown-model refusal
    // below still fires for anything with tokens on it.
    if (split === null && bucketTotal(bucket) === 0) {
      costByModel[model] ??= { usd: 0, marginal_usd: 0, context_carry_usd: 0, rates: null };
      continue;
    }
    if (split === null) {
      // Keep the null verdict sticky: a model priced in one speed bucket and
      // unknown in another is still incomplete overall.
      costByModel[model] = { usd: null, marginal_usd: null, context_carry_usd: null, rates: null };
      costComplete = false;
      notes.push({ code: 'unknown_model_pricing', detail: `no pricing entry for model id "${model}"; its cost is null and excluded from cost_usd_total` });
      continue;
    }
    if (costByModel[model] === undefined) {
      costByModel[model] = { ...split, rates };
    } else if (costByModel[model].rates !== null) {
      // Second speed bucket for this model: accumulate, and record that more
      // than one rate applied so a reader is not misled by a single `variant`.
      const acc = costByModel[model];
      acc.usd = usd6(acc.usd + split.usd);
      acc.marginal_usd = usd6(acc.marginal_usd + split.marginal_usd);
      acc.context_carry_usd = usd6(acc.context_carry_usd + split.context_carry_usd);
      acc.rates_by_speed ??= [acc.rates];
      acc.rates_by_speed.push(rates);
      acc.mixed_speed = true;
    }
    costTotal += split.usd;
    marginalTotal += split.marginal_usd;
    carryTotal += split.context_carry_usd;
  }
  if (totals.cache_creation_unattributed > 0) {
    notes.push({ code: 'cache_ttl_split_missing', detail: `${totals.cache_creation_unattributed} cache-write tokens carried no 5m/1h split; priced at the 5m rate` });
  }

  return {
    tokens: {
      by_model: byModel,
      totals,
      grand_total: bucketTotal(totals),
      boundary_total: boundaryTotal(usageEntries),
      counting_policy: 'usage.iterations summed when present, else top-level usage; never both',
    },
    cost: {
      by_model: costByModel,
      total_usd: costComplete ? Math.round(costTotal * 1e6) / 1e6 : null,
      marginal_usd: costComplete ? Math.round(marginalTotal * 1e6) / 1e6 : null,
      context_carry_usd: costComplete ? Math.round(carryTotal * 1e6) / 1e6 : null,
      known_models_usd: Math.round(costTotal * 1e6) / 1e6,
      complete: costComplete,
      pricing_version: PRICING_VERSION,
      cache_multipliers: { write_5m: 1.25, write_1h: 2.0, read: 0.1 },
      split_policy: 'marginal = input + output + cache writes (spend the run caused); context_carry = cache reads (session-depth tax). See METRICS.md.',
    },
    duration: {
      started_at: stamps.length ? new Date(stamps[0]).toISOString() : null,
      ended_at: stamps.length ? new Date(stamps[stamps.length - 1]).toISOString() : null,
      wall_ms: stamps.length ? stamps[stamps.length - 1] - stamps[0] : 0,
      active_ms: activeMs,
      gap_cap_ms: gapCapMs,
    },
    api_calls: apiCalls,
    notes,
  };
}

export function buildRecord({
  runId = null,
  hookPayload,
  invocations,
  usageEntries,
  toolCalls,
  dispatchResults,
  subagents,
  subagentSpawns = {},
  interruption,
  window,
  environment,
  now = new Date(),
  gapCapMs,
}) {
  const allUsage = [
    ...usageEntries,
    ...subagents.flatMap((a) => a.usage_entries),
  ];
  const agg = aggregate(allUsage, { gapCapMs });
  const sessionOnly = aggregate(usageEntries, { gapCapMs });
  const subagentTokenTotal = agg.tokens.grand_total - sessionOnly.tokens.grand_total;

  const toolCounts = {};
  for (const t of toolCalls) {
    const k = t.name ?? 'unknown';
    toolCounts[k] = (toolCounts[k] ?? 0) + 1;
  }

  // The subagent join table (computed, so raw.subagents stays verbatim).
  // spawned_by_run_id is THE join key: this run's id when the agent first
  // appeared in this window, an earlier record's run_id when this window only
  // carries a later slice of a long-lived agent, or null when the agent was
  // spawned in a turn nobody logged. tool_use_id joins back to the exact
  // Agent/Task call in that record's raw.tool_calls / raw.dispatch_results.
  const subagentRuns = subagents.map((a) => {
    const t = aggregate(a.usage_entries, { gapCapMs });
    return {
      file: a.file,
      agent_type: a.meta?.agentType ?? null,
      tool_use_id: a.meta?.toolUseId ?? null,
      spawned_by_run_id: subagentSpawns[a.file] ?? null,
      spawned_this_run: subagentSpawns[a.file] === runId && runId !== null,
      lines_from: a.lines_from,
      lines_to: a.lines_to,
      tokens_grand_total: t.tokens.grand_total,
      cost_usd: t.cost.total_usd,
      models: Object.keys(t.tokens.by_model),
    };
  });

  return {
    schema_version: SCHEMA_VERSION,
    logged_at: now.toISOString(),
    run: {
      run_id: runId,
      session_id: hookPayload?.session_id ?? null,
      trigger_event: hookPayload?.hook_event_name ?? null,
      cwd: hookPayload?.cwd ?? null,
      transcript_path: hookPayload?.transcript_path ?? null,
      skills: [...new Set(invocations.map((i) => i.name).filter(Boolean))],
      window,
      environment,
    },
    // ---- verbatim material; nothing below this key is transformed ----
    raw: {
      hook_payload: hookPayload ?? null,
      invocations,
      usage_entries: usageEntries,
      subagents,
      dispatch_results: dispatchResults,
      tool_calls: toolCalls,
    },
    // ---- derived values only; every number traces back to `raw` ----
    computed: {
      outcome: {
        trigger_event: hookPayload?.hook_event_name ?? null,
        session_end_reason: hookPayload?.reason ?? null,
        error_type: hookPayload?.error_type ?? null,
        interrupted_tool_seen: interruption,
      },
      tokens: agg.tokens,
      cost: agg.cost,
      duration: agg.duration,
      counts: {
        api_calls: agg.api_calls,
        assistant_usage_lines: usageEntries.length,
        tool_calls: toolCalls.length,
        tool_calls_by_name: toolCounts,
        subagents: subagents.length,
        subagent_tokens_grand_total: subagentTokenTotal,
        invocations: invocations.length,
      },
      subagent_runs: subagentRuns,
      notes: agg.notes,
    },
  };
}
