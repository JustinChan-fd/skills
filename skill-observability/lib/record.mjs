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

// Gap cap for active-time: idle stretches longer than this count as this much.
// 5 minutes is not a round number picked for tidiness — it is the prompt-cache
// TTL (see CACHE_TTL_MS below, which shares it), so a gap that exceeds the cap
// is precisely a gap the cache did not survive.
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

// ---- attribution boundary ----
//
// The hook's window runs cursor -> EOF, which is what guarantees no spend is
// ever counted twice. But a skill invoked partway through that window did not
// cause the spend that preceded it. MEASURED on run e4c76f92-789-931: the
// window opened at session line 789, research-this was invoked at window line
// 35, and 2,687,434 of 5,452,701 four-way tokens (49%) belonged to the previous
// turn. The record claimed $5.53 for a skill responsible for about half of it.
//
// Splitting by LINE would be wrong. Usage rows dedupe by message.id, and on
// that same run exactly one message.id spanned lines 33/34/35 — the call that
// emitted the Skill tool_use block itself. Aggregating a before-list and an
// after-list would keep the max per direction on each side and count that
// call's 159,040 tokens twice. So the split is by dedup KEY: every row sharing
// a message.id goes wholly to one side, decided by the EARLIEST line that key
// appears on relative to the invocation... except that a call which straddles
// the boundary is the invoking call, and belongs to the skill. Hence: a key is
// attributed if ANY of its rows sits at or after the invocation line.
function dedupKeyOf(entry, anonSeq) {
  const model = entry.model ?? 'unknown';
  return entry.message_id ? `id:${model} ${entry.message_id}` : `anon:${anonSeq}`;
}

export function partitionByInvocation(usageEntries, invocationLine, { gapCapMs } = {}) {
  // A null invocation line means no skill ran in this window: nothing may be
  // attributed. Defaulting the other way is how a 49% overcount happens.
  const attributedKeys = new Set();
  let anon = 0;
  const keyed = usageEntries.map((e) => {
    const key = dedupKeyOf(e, e.message_id ? 0 : (anon += 1));
    // A subagent row's line_index counts lines in ITS OWN transcript, so
    // comparing it to a session line index is meaningless — an agent's line 0 is
    // not "before" the invocation. Placement for those was already decided by
    // subagentIsAttributed (via the spawning tool_use line) and callers pass only
    // the attributed ones, so any non-session row here is attributed by
    // construction. Letting the line comparison run on them instead silently
    // moved every subagent's spend to the unattributed side.
    const isSessionRow = e.source === undefined || e.source === 'session';
    if (!isSessionRow) {
      attributedKeys.add(key);
    } else if (invocationLine !== null && invocationLine !== undefined && typeof e.line_index === 'number' && e.line_index >= invocationLine) {
      attributedKeys.add(key);
    }
    return { entry: e, key };
  });
  const attributed = [];
  const unattributed = [];
  for (const { entry, key } of keyed) {
    (attributedKeys.has(key) ? attributed : unattributed).push(entry);
  }
  return {
    attributed: aggregate(attributed, { gapCapMs }),
    unattributed: aggregate(unattributed, { gapCapMs }),
    invocation_line: invocationLine ?? null,
  };
}

// A subagent's usage rows carry line indices from ITS OWN transcript, so they
// cannot be compared against a session line index — that is a category error.
// The only sound join is meta.toolUseId -> the line of the Agent/Task tool_use
// block that spawned it (MEASURED: both agents on the real run joined to lines
// 46 and 48, against an invocation at 35).
//
// Unjoinable => ATTRIBUTED. Workflow subagents carry no toolUseId key at all,
// and a workflow is the largest single spend a record can hold ($22.53 in one
// measured call); defaulting those to unattributed would hide exactly the spend
// this tool exists to surface. Over-crediting a skill that is visible beats
// silently dropping the biggest number on the page.
// ---- cache state: why two runs of one skill can differ 8x ----
//
// The prompt cache has a 5-minute TTL. Every API call either READS a live cache
// entry (0.1x the input rate) or WRITES a fresh one (1.25x). Reading is 12.5x
// cheaper than writing the same tokens, so whether the cache was alive at
// invocation time dominates the cost of a run — more than the model, more than
// how much work the skill did.
//
// This started as a LINE-DEPTH classification (`fresh`/`warming`/`steady`),
// which was measuring a proxy. Crossing depth against the idle gap before each
// call — 36,794 deduplicated calls over 435 transcripts, avg marginal tokens:
//
//                      gap < 5 min    gap >= 5 min
//     line < 25              9,713          18,355
//     line 25-399            7,759          67,948    <- 8.8x
//     line >= 400            9,951          82,264    <- 8.3x
//
// Marginal is ~8-10K/call at EVERY depth once the cache is warm. Depth only
// correlated because a session's opening calls are the ones most likely to
// follow a long human pause. A fine sweep of the gap axis puts the cliff
// exactly at the documented TTL (avg marginal): 0-15s 7,670 | 240-270s 20,226
// | 270-300s 22,651 | 300-330s 31,380 | 330-420s 63,636 | 600-1800s 89,030.
// Gradual decay up to 300s, cliff after it.
//
// The case the depth rule got actively wrong: a RESUMED session keeps its high
// line index, so it was labeled `steady` and declared comparable while paying
// 96,680 marginal tokens/call (gap > 1h, n=67) — 8x a warm call.
//
// Composition is a symptom, not a classifier. Against ground truth (gap >= TTL
// or first call), the best composition rule `read === 0` recalls only 51.8% of
// cold calls at 86.0% precision; looser variants trade precision away without
// reaching useful recall. So classify on the mechanism (elapsed time), which is
// directly measurable, not on its effects.
export const CACHE_TTL_MS = 300_000;

// `cold` when nothing usable was cached: either the TTL had expired or this is
// the session's first call. `unknown` when the gap cannot be measured from this
// window — reported honestly rather than guessed, because guessing `warm` is
// what silently declares a resumed run comparable.
export function classifyCacheState(idleMsBeforeInvocation, { sessionIsNew } = {}) {
  if (idleMsBeforeInvocation === null || idleMsBeforeInvocation === undefined) {
    return sessionIsNew ? 'cold' : 'unknown';
  }
  return idleMsBeforeInvocation >= CACHE_TTL_MS ? 'cold' : 'warm';
}

// Milliseconds between the last API call BEFORE the invocation and the
// invoking call itself — the interval the cache had to survive.
//
// `invocationAt` is the invocation's own transcript timestamp, used as the
// anchor when no usage row sits at-or-after the invocation line. That is the
// NORMAL shape on the slash path, for two compounding reasons:
//   - a slash invocation is a plain user line and carries no usage of its own,
//     unlike a Skill tool_use, which is emitted BY an API call; and
//   - the Stop hook reads the transcript before the turn's final assistant
//     message is flushed, so the window ends one call short and that call
//     opens the next window, ahead of the next invocation.
// Without the anchor the function returned null at the `!at` guard — before the
// straddler filter and before the previousCallAt fallback that exists to
// prevent exactly this — so every slash run after the first reported `unknown`.
// MEASURED on session 51e8fb3d: 3,828ms of real idle reported as unmeasurable.
export function idleBeforeInvocation(usageEntries, invocationLine, previousCallAt, invocationAt = null) {
  const stamped = (usageEntries ?? [])
    .filter((e) => (e.source === undefined || e.source === 'session') && typeof e.line_index === 'number' && e.timestamp)
    .map((e, i) => ({ line: e.line_index, ms: Date.parse(e.timestamp), key: dedupKeyOf(e, i) }))
    .filter((e) => Number.isFinite(e.ms));
  if (invocationLine === null || invocationLine === undefined) return null;
  // The invoking call, when the invocation IS an API call. Preferred over the
  // invocation's own timestamp so the straddler exclusion below keeps governing
  // the skill_tool path unchanged.
  let at = stamped.filter((e) => e.line >= invocationLine).sort((a, b) => a.ms - b.ms)[0];
  if (!at) {
    const invMs = invocationAt ? Date.parse(invocationAt) : NaN;
    if (!Number.isFinite(invMs)) return null;
    // No dedup key to exclude: the invocation emitted no usage, so no row can
    // be its own straddler and every stamped row is a genuine predecessor.
    at = { line: invocationLine, ms: invMs, key: null };
  }
  // The invoking call STRADDLES the boundary: it is the call that emitted the
  // Skill tool_use, and one message.id spans several transcript lines a few ms
  // apart. On both real records the row immediately "before" the invocation was
  // the invocation's own call — measuring against it gave a ~3ms gap and made
  // cache_state report `warm` unconditionally. Exclude the invoking call's whole
  // dedup group, exactly as partitionByInvocation does.
  const before = stamped
    .filter((e) => e.line < invocationLine && e.key !== at.key)
    .sort((a, b) => b.ms - a.ms)[0];
  // No in-window predecessor: fall back to the cursor-carried timestamp of the
  // last call the PREVIOUS window saw, so a window opening at the invocation is
  // still classifiable instead of permanently `unknown`.
  const prevMs = before ? before.ms : (previousCallAt ? Date.parse(previousCallAt) : NaN);
  if (!Number.isFinite(prevMs)) return null;
  return at.ms - prevMs;
}

export function subagentIsAttributed(agent, toolCalls, invocationLine) {
  const id = agent?.meta?.toolUseId;
  if (typeof id !== 'string' || id === '') return true;
  const spawn = (toolCalls ?? []).find((t) => t.id === id);
  if (!spawn || typeof spawn.line_index !== 'number') return true;
  if (invocationLine === null || invocationLine === undefined) return false;
  return spawn.line_index >= invocationLine;
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
  // Timestamp of the last API call the PREVIOUS window saw, carried across
  // firings in hook state. Lets a window that opens on the invocation still
  // measure its idle gap instead of reporting cache_state `unknown`.
  previousCallAt = null,
  // run_id of the record the PREVIOUS firing wrote, carried in hook state. The
  // Stop hook reads the transcript before the turn's own last assistant message
  // is flushed to it, so every window ends one API call short and that call
  // opens the next window as pre-invocation tail (measured up to 57.6% of a
  // record's marginal tokens). It is reported where it lands, and this names
  // whose it was — the same joinability contract as spawned_by_run_id.
  previousRunId = null,
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

  // Attribution: the window is the turn, the run is the skill. Spend before the
  // first invocation belongs to the previous turn and is reported SEPARATELY
  // rather than folded into the skill's cost (measured 49% of one real record).
  const invocationLines = (invocations ?? [])
    .map((i) => i.line_index)
    .filter((n) => typeof n === 'number');
  const invocationLine = invocationLines.length ? Math.min(...invocationLines) : null;
  const attributedSubagents = subagents.filter((a) => subagentIsAttributed(a, toolCalls, invocationLine));
  const split = partitionByInvocation(
    [...usageEntries, ...attributedSubagents.flatMap((a) => a.usage_entries)],
    invocationLine,
    { gapCapMs },
  );
  // Subagent rows carry their own transcript's line indices, so they cannot be
  // partitioned by session line — they are placed wholesale by their spawning
  // tool_use and then always land on the attributed side. Their usage is added
  // to `attributed` above; unattributed subagent spend is the complement.
  const unattributedSubagents = subagents.filter((a) => !subagentIsAttributed(a, toolCalls, invocationLine));
  const unattributedSubagentAgg = aggregate(unattributedSubagents.flatMap((a) => a.usage_entries), { gapCapMs });
  const invocationDepthLines = invocationLine === null ? null : invocationLine + (window?.line_from ?? 0);
  // Timestamp of the EARLIEST invocation, matching invocationLine above — the
  // anchor for the idle gap when the invocation emitted no API call of its own
  // (the slash path). Read off the same invocation, not the first in the array,
  // so a window holding two invocations cannot pair a line with another's clock.
  const invocationAt = invocationLine === null
    ? null
    : ((invocations ?? []).find((i) => i.line_index === invocationLine)?.timestamp ?? null);
  const idleMs = idleBeforeInvocation(usageEntries, invocationLine, previousCallAt, invocationAt);
  const cacheState = invocationLine === null
    ? null
    : classifyCacheState(idleMs, { sessionIsNew: (window?.line_from ?? 0) === 0 });

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
      // The window's spend split at the invocation boundary. `attributed` is
      // what the skill caused; `unattributed` is the turn's pre-invocation tail,
      // reported rather than discarded so the two always reconcile to the whole.
      //
      // Compare runs on attributed.cost.marginal_usd: measured flat at
      // ~9,600-11,900 tokens/call at EVERY session depth (298 sessions), because
      // a fresh session's higher cache WRITE and a deep session's higher cache
      // READ land in different buckets. total_usd is real money but is NOT
      // comparable across session positions — carry/call climbs 69K -> 120K and
      // plateaus past ~line 400.
      attribution: {
        invocation_line: split.invocation_line,
        session_depth_lines: window?.line_from ?? null,
        // ABSOLUTE session line of the invocation. invocation_line is
        // WINDOW-relative (detectInvocations runs on the sliced window), so a
        // skill invoked at window line 3 of a window opening at 789 is at
        // session line 792 — classifying on invocation_line alone would call
        // every mid-session run "fresh".
        invocation_depth_lines: invocationDepthLines,
        // Idle interval the prompt cache had to survive before the invocation.
        // This — not line depth — is what predicts a run's cost: marginal is
        // ~8-10K tokens/call at every depth when warm and 68-82K when cold.
        idle_ms_before_invocation: idleMs,
        cache_state: cacheState,
        // Whether marginal_usd may be compared to other runs without a caveat.
        // Only a warm run may: a cold one pays 12.5x to write the cache a warm
        // one merely reads, which moves marginal itself, not just carry.
        // `unknown` is not a licence to compare.
        marginal_comparable: cacheState === null ? null : cacheState === 'warm',
        attributed: { tokens: split.attributed.tokens, cost: split.attributed.cost, api_calls: split.attributed.api_calls },
        unattributed: { tokens: split.unattributed.tokens, cost: split.unattributed.cost, api_calls: split.unattributed.api_calls },
        // Which run the pre-invocation tail actually belongs to, or null when
        // there is no tail (naming an owner then would invent a link a
        // dashboard would double-count) or no previous record to name.
        unattributed_belongs_to_run_id:
          split.unattributed.api_calls > 0 ? (previousRunId ?? null) : null,
        subagents_attributed: attributedSubagents.length,
        subagents_unattributed: unattributedSubagents.length,
        unattributed_subagent_tokens: unattributedSubagentAgg.tokens.grand_total,
        policy: 'a usage row is attributed when any row sharing its dedup key sits at/after the first invocation line; subagents are placed by their spawning tool_use line and default to attributed when unjoinable',
      },
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
