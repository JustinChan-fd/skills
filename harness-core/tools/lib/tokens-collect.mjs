// Pure, defensive parser for session/subagent transcripts (JSONL).
//
// Sums token usage by model x direction (input / output / cache_read /
// cache_creation), slices to an optional ISO start/end window, and reports
// per-call timestamp min/max plus a gap-capped active-time sum. It reads only
// numeric usage fields, model ids, and timestamps — never message content — so
// its return value carries derived sums and metadata, never raw transcript
// text (privacy: only sums leave the machine, see the run-record sync path).
//
// Every failure mode (garbage JSONL, missing file, empty transcript) returns a
// structured `{ ok: false, error }` result rather than throwing: token
// collection must never crash the run it is enriching.
//
// TOKEN DATA PROVENANCE — sources retrieved 2026-07-28
// (re-verify before treating as current; docs are dated snapshots)
//
// 1. Messages API — usage object
//    https://platform.claude.com/docs/en/api/messages
//    "Billing and rate-limit usage. Anthropic's API bills and rate-limits by
//    token counts." → the numbers are billing-grade, not estimates.
//    Caveat: "the token counts in usage will not match one-to-one with the
//    exact visible content of an API request or response."
//    Total-input formula our cost math depends on:
//      total_input_tokens = input_tokens
//                         + cache_read_input_tokens
//                         + cache_creation_input_tokens
//
// 2. Prompt caching
//    https://platform.claude.com/docs/en/build-with-claude/prompt-caching
//    cache_creation_input_tokens: "tokens written to the cache when creating
//      a new entry"
//    cache_read_input_tokens: "tokens retrieved from the cache for this
//      request"
//    input_tokens: only tokens after the last cache breakpoint — do NOT
//      simplify cost math to input_tokens alone; that undercounts heavily on
//      cached runs.
//
// 3. Claude Code subagents & cache
//    https://code.claude.com/docs/en/prompt-caching
//    "A subagent starts its own conversation with its own system prompt and
//    tool set… builds its own cache." → driver tokens live in a subagent
//    transcript, not the top-level session transcript. This is why
//    standalone mode (discoverStandaloneTranscript) misses them and why the
//    backfill-directional command exists.
//
// 4. Monitoring usage — transcript location + stability caveat
//    https://code.claude.com/docs/en/monitoring-usage
//    Transcripts are persisted at "~/.claude/projects/*/*.jsonl".
//    CRITICAL: "The transcript entry format is internal to Claude Code and
//    changes between versions, so a pipeline that joins on these fields can
//    break on any release; treat the joins as version-specific rather than
//    a stable contract." Transcript parsing here is a pragmatic,
//    version-specific source — NOT a stable contract.
//
// 5. Recommended future migration (TODO — do not implement now):
//    Claude Code's OpenTelemetry exporter emits documented metrics
//    claude_code.token.usage and claude_code.cost.usage; api_request events
//    carry input_tokens / output_tokens / cache_read_tokens /
//    cache_creation_tokens / cost_usd_micros keyed by session.id. This is
//    the stable contract to migrate to. See docs/notes/otel-token-migration.md
//    for context. // TODO(otel): migrate directional collection off transcript
//    parsing once the OTel exporter is confirmed stable.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { tierForModelId } from './model-tier.mjs';
import { readAgentTree, descendantsOf, driversOf } from './agent-tree.mjs';

// Active-time gap cap. Between two consecutive events, any idle gap longer than
// this is counted as at most this many ms — so a run that sat idle overnight
// between two calls doesn't report the whole night as active work. 5 minutes is
// a deliberate, documented default (the issue pins no value); override via the
// `gapCapMs` option.
export const DEFAULT_GAP_CAP_MS = 5 * 60 * 1000;

export const FORMAT_VERSION = '1';

const DIRECTIONS = {
  input: 'input_tokens',
  output: 'output_tokens',
  cache_read: 'cache_read_input_tokens',
  cache_creation: 'cache_creation_input_tokens',
};

function emptyBucket() {
  return { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
}

// Add a single usage object's directional counts into a model's bucket.
function addUsage(bucket, usage) {
  if (!usage || typeof usage !== 'object') return;
  for (const [dir, field] of Object.entries(DIRECTIONS)) {
    const v = usage[field];
    if (typeof v === 'number' && Number.isFinite(v)) bucket[dir] += v;
  }
}

// The total context of ONE api call: everything the model had to read plus what
// it wrote. This is the number the Agent tool surfaces as `subagent_tokens`,
// which drivers copy into a record's `tokens_observed.total` — so the max of
// this across a transcript is an identity fingerprint for "this file is that
// run's". Missing cache keys coerce to 0: older transcript lines carry only
// input/output, and a NaN here makes every later fingerprint comparison false.
function contextTotal(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  let total = 0;
  for (const field of Object.values(DIRECTIONS)) {
    const v = usage[field];
    if (typeof v === 'number' && Number.isFinite(v)) total += v;
  }
  return total;
}

// A transcript line may carry usage in message.usage (top-level) and in each
// entry of an iterations[] array (fallback/multi-attempt sub-entries, each with
// its own .usage or .message.usage). All of them count toward the line's model.
//
// Used for the PEAK only. Peak needs no deduplication: duplicate lines repeat an
// identical usage object, and a MAX over duplicates equals a MAX over uniques.
// Leaving this path untouched is deliberate — peak_context is the transcript
// identity fingerprint (#17/#18), and gating it would break run matching
// silently for no gain.
function usagesFromLine(line) {
  const out = [];
  const top = line?.message?.usage;
  if (top) out.push(top);
  if (Array.isArray(line?.iterations)) {
    for (const it of line.iterations) {
      const u = it?.usage ?? it?.message?.usage;
      if (u) out.push(u);
    }
  }
  return out;
}

// The usages a line contributes to the SUMS, deduplicated by message.id.
//
// ONE API CALL IS MANY TRANSCRIPT LINES. Claude Code writes one JSONL line per
// content block of an assistant response (thinking / text / tool_use / …),
// repeating the SAME message.usage on every one and chaining them by parentUuid
// under a single message.id. Summing per line bills one call up to 4 times:
// measured on the jarvis #4 implement driver, 310 usage rows carried only 162
// distinct ids, inflating every token and dollar figure by ~2.2x.
//
// Two rules, and the second is what makes this safe:
//  - a top-level usage whose message.id was already counted is DROPPED;
//  - a usage with NO message.id is ALWAYS counted.
// The second rule is not defensive padding. `iterations[]` sub-entries carry no
// id of their own, so a plain `seen.add(id)` would treat every id-less row as
// the same call and collapse them — trading a 2.2x overcount for a silent
// undercount, which is strictly worse. (Empirically the id-less case is
// synthetic: across 94,416 usage rows in 6,254 local transcripts every real row
// carries an id, top-level `iterations` never appears, and
// `message.usage.iterations` is always empty. The iterations[] branch is
// speculative; it stays supported, and stays additive.)
//
// `countedIds` is threaded from the caller and mutated here so that the FIRST
// in-window occurrence of a call is the one counted. Marking ids during the
// unwindowed peak pass instead would let a window boundary falling between two
// blocks of one response drop that call from the sums entirely.
function countableUsages(line, countedIds) {
  const out = [];
  const top = line?.message?.usage;
  if (top) {
    const id = line?.message?.id;
    if (typeof id !== 'string' || id === '') {
      out.push(top); // no id to deduplicate on — count it
    } else if (!countedIds.has(id)) {
      countedIds.add(id);
      out.push(top);
    }
  }
  if (Array.isArray(line?.iterations)) {
    for (const it of line.iterations) {
      const u = it?.usage ?? it?.message?.usage;
      if (u) out.push(u);
    }
  }
  return out;
}

function inWindow(ts, startMs, endMs) {
  if (ts === null) return true; // undateable lines can't be excluded by a window
  if (startMs !== null && ts < startMs) return false;
  if (endMs !== null && ts > endMs) return false;
  return true;
}

/**
 * Parse a transcript's raw JSONL text.
 * @param {string} text
 * @param {{start?:string|null,end?:string|null,gapCapMs?:number}} [opts]
 * @returns {{ok:boolean, by_model:object, timestamps:{min:string|null,max:string|null},
 *            active_ms:number, gap_cap_ms:number, lines_total:number,
 *            lines_parsed:number, lines_skipped:number, peak_context:number,
 *            error:null|{code:string,detail:string}}}
 */
export function collectFromText(text, opts = {}) {
  const gapCapMs = Number.isFinite(opts.gapCapMs) ? opts.gapCapMs : DEFAULT_GAP_CAP_MS;
  const startMs = opts.start ? Date.parse(opts.start) : null;
  const endMs = opts.end ? Date.parse(opts.end) : null;

  const base = {
    ok: false,
    by_model: {},
    timestamps: { min: null, max: null },
    active_ms: 0,
    gap_cap_ms: gapCapMs,
    lines_total: 0,
    lines_parsed: 0,
    lines_skipped: 0,
    peak_context: 0,
    error: null,
  };

  if (typeof text !== 'string' || text.trim() === '') {
    return { ...base, error: { code: 'empty', detail: 'transcript is empty or not text' } };
  }

  const rawLines = text.split('\n').filter((l) => l.trim() !== '');
  base.lines_total = rawLines.length;

  const stamps = []; // ms timestamps of in-window, dateable lines, in file order
  const byModel = base.by_model;
  // message.ids already counted toward the sums — see countableUsages. Scoped to
  // one transcript: ids are globally unique, and collectFromFiles merges
  // per-file results, so cross-file leakage is not possible.
  const countedIds = new Set();

  for (const raw of rawLines) {
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      base.lines_skipped += 1; // a corrupt line is not this parser's crash to have
      continue;
    }
    base.lines_parsed += 1;

    const tsStr = typeof line?.timestamp === 'string' ? line.timestamp : null;
    const tsMs = tsStr ? Date.parse(tsStr) : NaN;
    const ts = Number.isFinite(tsMs) ? tsMs : null;

    const usages = usagesFromLine(line);

    // Peak is measured UNWINDOWED, deliberately. The window is derived from the
    // run's own started_at/ended_at, and a wrong window is exactly the failure
    // the fingerprint exists to rescue — TARS-1271's directional capture came
    // back empty because a windowed match dropped the only call that identified
    // the transcript. Sums stay windowed below: they answer "what did THIS run
    // spend", where counting a neighbour's calls is the error to avoid.
    for (const u of usages) {
      const total = contextTotal(u);
      if (total > base.peak_context) base.peak_context = total;
    }

    if (!inWindow(ts, startMs, endMs)) continue;

    if (ts !== null) {
      stamps.push({ ms: ts, iso: tsStr });
      if (base.timestamps.min === null || ts < Date.parse(base.timestamps.min)) base.timestamps.min = tsStr;
      if (base.timestamps.max === null || ts > Date.parse(base.timestamps.max)) base.timestamps.max = tsStr;
    }

    // Sums count each API call once; the peak pass above deliberately does not.
    const model = typeof line?.message?.model === 'string' ? line.message.model : null;
    if (model) {
      const countable = countableUsages(line, countedIds);
      if (countable.length) {
        byModel[model] ??= emptyBucket();
        for (const u of countable) addUsage(byModel[model], u);
      }
    }
  }

  if (base.lines_parsed === 0) {
    return { ...base, error: { code: 'unparseable', detail: 'no transcript lines could be parsed as JSON' } };
  }

  // Gap-capped active time over in-window, dateable events in chronological order.
  stamps.sort((a, b) => a.ms - b.ms);
  let active = 0;
  for (let i = 1; i < stamps.length; i += 1) {
    active += Math.min(stamps[i].ms - stamps[i - 1].ms, gapCapMs);
  }
  base.active_ms = active;
  base.ok = true;
  return base;
}

// ---- transcript discovery ----
//
// Claude writes each project's transcripts under
// ~/.claude/projects/<munged-cwd>/, where <munged-cwd> is the absolute cwd with
// every "/" and "." replaced by "-". The session's own transcript is
// <project-dir>/<session-uuid>.jsonl; a driver's subagent transcripts are
// SIBLINGS of it at <project-dir>/<session-uuid>/subagents/agent-*.jsonl.

/** Munge an absolute cwd to Claude's project-directory name (dir name only).
 * Claude replaces every character that is NOT alphanumeric-or-dash with "-"
 * (so "/", ".", and "@" in a username-shaped home dir all collapse to "-",
 * while existing dashes are preserved). A narrower "/.-only" rule leaves "@"
 * intact and silently mislocates the transcript → directional tokens degrade
 * to estimated. */
export function mungeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9-]/g, '-');
}

/** Full ~/.claude/projects/<munged-cwd> path for a cwd. */
export function projectDirForCwd(cwd, { home = homedir() } = {}) {
  return join(home, '.claude', 'projects', mungeProjectDir(cwd));
}

// Newest-mtime *.jsonl in a directory (top-level files only), optionally
// filtered by name prefix. Ties are broken by filename (lexicographically
// greatest) so the result is deterministic. A missing/unreadable directory
// returns a structured not-found result rather than throwing.
function newestJsonl(dir, { prefix = '' } = {}) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    return { ok: false, path: null, error: { code: 'not_found', detail: err.message } };
  }
  const candidates = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl') || !name.startsWith(prefix)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    candidates.push({ name, full, mtimeMs: st.mtimeMs });
  }
  if (candidates.length === 0) {
    return { ok: false, path: null, error: { code: 'not_found', detail: `no matching .jsonl in ${dir}` } };
  }
  candidates.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.name < b.name ? 1 : -1));
  return { ok: true, path: candidates[0].full, error: null };
}

/**
 * Loop-dispatched drivers: the just-closed subagent transcript is the
 * newest-mtime agent-*.jsonl in the loop session's own subagents/ directory
 * (the sequential-dispatch invariant makes it unambiguous — see harness-loop
 * SKILL.md step 6). `subagentsDir` is <project-dir>/<session-uuid>/subagents.
 */
export function discoverLoopTranscript(subagentsDir) {
  return newestJsonl(subagentsDir, { prefix: 'agent-' });
}

/**
 * Standalone runs: pick the newest-mtime top-level session .jsonl in the run's
 * own project directory (subagent transcripts are nested under a
 * <session-uuid>/ subdirectory, so top-level-only naturally excludes them).
 */
export function discoverStandaloneTranscript(projectDir) {
  return newestJsonl(projectDir, {});
}

/**
 * The subagents directory for one session: <projectDir>/<sessionId>/subagents.
 *
 * Derivation, not configuration. `CLAUDE_CODE_SESSION_ID` is present in the env of
 * every Bash call the harness makes, and `projectDirForCwd` already maps a cwd to
 * its transcript directory — so the caller can always compute this. The previous
 * design required a skill to remember `--mode loop --subagents-dir`; no skill file
 * ever did, which is half of why #17 went unnoticed. Deriving it removes the
 * LLM from a deterministic lookup.
 */
export function subagentsDirForSession({ sessionId, projectDir, cwd, home } = {}) {
  if (!sessionId) return null;
  const dir = projectDir ?? (cwd ? projectDirForCwd(cwd, { home }) : null);
  if (!dir) return null;
  return join(dir, sessionId, 'subagents');
}

// ---- run-level orchestration (used by the CLI subcommand + phase/run-end wiring) ----

/**
 * Resolve which transcript to read for a run:
 *  - explicit `transcript` path wins;
 *  - `mode: "loop"` prefers the peak-context fingerprint match against
 *    `observedTotal`, falling back to the newest agent-*.jsonl in `subagentsDir`;
 *  - otherwise standalone: the newest top-level .jsonl in `projectDir`, or in
 *    the project dir derived from `cwd` when `projectDir` is not given.
 *
 * The fingerprint is a PREFERENCE, not a requirement. `discoverSubagentForRun`
 * needs a positive `tokens_observed.total` to match against, and failing without
 * one would break directional capture for every run that has none — so a missing
 * or unmatched fingerprint degrades to newest-mtime rather than to nothing.
 *
 * SUPERSEDED FOR LIVE COLLECTION by `resolveTranscripts` + `mode: 'subtree'`.
 * This singular resolver remains for explicit-path and backfill callers. Its
 * standalone newest-mtime branch must NOT be used for a phase run: the
 * orchestrator is idle while a phase runs (measured: 0 tokens inside the phase
 * window across three stages), so the newest top-level transcript is at best
 * unrelated. See issue #17.
 *
 * Why prefer it at all: newest-mtime is only correct while exactly one run is in
 * flight. With two overlapping runs the newest file belongs to whichever sibling
 * wrote last, and a run gets another run's tokens. The fingerprint is an identity
 * check, so it stays correct under overlap.
 *
 * Returns a discovery result `{ ok, path, error, via }`, where `via` is
 * 'explicit' | 'fingerprint' | 'newest_mtime' — provenance for the CLI's output.
 * It is NOT written to the run record: run-record.schema.json's
 * tokens_directional subschema is additionalProperties:false.
 */
export function resolveTranscript({ transcript, mode, subagentsDir, projectDir, cwd, home, observedTotal } = {}) {
  if (transcript) return { ok: true, path: transcript, error: null, via: 'explicit' };
  if (mode === 'loop') {
    if (!subagentsDir) return { ok: false, path: null, error: { code: 'not_found', detail: 'loop mode requires a subagents dir' }, via: null };
    if (Number.isFinite(observedTotal) && observedTotal > 0) {
      const fingerprinted = discoverSubagentForRun({ subagentsDir, observedTotal });
      if (fingerprinted.ok) return { ...fingerprinted, via: 'fingerprint' };
      // no_fingerprint / not_found both fall through to mtime, deliberately.
    }
    return { ...discoverLoopTranscript(subagentsDir), via: 'newest_mtime' };
  }
  const dir = projectDir ?? (cwd ? projectDirForCwd(cwd, { home }) : null);
  if (!dir) return { ok: false, path: null, error: { code: 'not_found', detail: 'no project dir or cwd to discover a standalone transcript' }, via: null };
  return { ...discoverStandaloneTranscript(dir), via: 'newest_mtime' };
}

/**
 * Resolve the transcript LIST for a run. `resolveTranscript` (singular) is kept
 * unchanged for existing callers; this is the plural form the subtree mode needs.
 *
 * Why a list: a phase driver's own transcript is not the phase's cost. Measured on
 * the TARS-1271 implement run, the driver's own spend was 233,607,665 against a
 * subtree total of 308,519,206 — reading one file undercounts by 24%. Driver
 * subtrees partition the session exactly (sum of subtrees == grand total across
 * every agent), so rolling up over `descendantsOf` neither drops nor double-counts.
 *
 * Subtree precedence:
 *   1. explicit `transcript`            -> via 'explicit'
 *   2. `agentId`                        -> via 'subtree'            (exact identity)
 *   3. `observedTotal > 0`              -> via 'fingerprint_subtree' (identify, then roll up)
 *   4. neither                          -> via 'all_drivers'        (whole session)
 *
 * There is deliberately NO fallback from subtree mode to standalone newest-mtime.
 * That path resolved an unrelated later session's transcript on the run that
 * exposed #17, and 100% of harness spend lives in subagent transcripts anyway
 * (orchestrator-only spend inside a phase window measured 0 tokens across three
 * stages) — so falling back would trade a noted absence for a wrong number.
 */
export function resolveTranscripts(opts = {}) {
  const { transcript, mode, subagentsDir, agentId, observedTotal } = opts;
  if (transcript) return { ok: true, paths: [transcript], error: null, via: 'explicit' };
  if (mode !== 'subtree') {
    const single = resolveTranscript(opts);
    return { ok: single.ok, paths: single.ok ? [single.path] : [], error: single.error, via: single.via };
  }
  const tree = readAgentTree(subagentsDir);
  if (!tree.ok) return { ok: false, paths: [], error: tree.error, via: null };

  const pathsFor = (ids) => ids.map((id) => join(subagentsDir, `agent-${id}.jsonl`));

  if (agentId) {
    return { ok: true, paths: pathsFor(descendantsOf(tree, agentId)), error: null, via: 'subtree' };
  }
  if (Number.isFinite(observedTotal) && observedTotal > 0) {
    const hit = discoverSubagentForRun({ subagentsDir, observedTotal });
    if (hit.ok) {
      const id = basename(hit.path).replace(/^agent-/, '').replace(/\.jsonl$/, '');
      return { ok: true, paths: pathsFor(descendantsOf(tree, id)), error: null, via: 'fingerprint_subtree' };
    }
    // An unmatched fingerprint degrades to every driver rather than to nothing:
    // the whole session's subagent spend is a superset of this run's, where
    // newest-mtime standalone was measured to be a disjoint set.
  }
  const all = driversOf(tree).flatMap((d) => descendantsOf(tree, d));
  return { ok: true, paths: pathsFor([...new Set(all)]), error: null, via: 'all_drivers' };
}

/**
 * Merge several `collectFromFile` results into one. Per-model directional fields
 * are summed; `active_ms` is summed; `peak_context` takes the MAX because it is a
 * high-water mark of a single context window — summing peaks across agents would
 * invent a context size no agent ever held, and would break the fingerprint match
 * that reads it back.
 */
export function mergeByModel(results) {
  const by_model = {};
  let peak_context = 0;
  let active_ms = 0;
  for (const r of results) {
    if (!r?.ok) continue;
    for (const [model, sums] of Object.entries(r.by_model ?? {})) {
      const acc = (by_model[model] ??= emptyBucket());
      // DIRECTIONS is an object mapping our field name -> the transcript's usage
      // key; its KEYS are the bucket fields. Reuse it rather than re-listing them.
      for (const k of Object.keys(DIRECTIONS)) acc[k] += sums[k] ?? 0;
    }
    peak_context = Math.max(peak_context, r.peak_context ?? 0);
    active_ms += r.active_ms ?? 0;
  }
  return { by_model, peak_context, active_ms };
}

/**
 * `collectFromFile` over many paths, merged. An unreadable path is skipped, not
 * fatal: one missing transcript in a subtree should degrade the sum, not void it.
 * Returns the same shape as `collectFromFile`.
 */
export function collectFromFiles(paths, opts = {}) {
  const results = (paths ?? []).map((p) => collectFromFile(p, opts));
  const merged = mergeByModel(results);
  if (Object.keys(merged.by_model).length === 0) {
    return {
      ok: false, by_model: {}, peak_context: 0, active_ms: 0,
      error: { code: 'no_usage', detail: `no model usage across ${paths?.length ?? 0} transcript(s)` },
    };
  }
  return { ok: true, ...merged, error: null };
}

/**
 * Turn a parser result into the additive `tokens_directional` record field
 * plus an optional degradation note. The format version is ALWAYS stamped, even
 * on failure. `complete` is true only when parsing succeeded AND at least one
 * model was actually collected AND every model id seen RESOLVES in
 * `modelTierMap` (exactly, or via `model-tier.mjs` normalization). The emptiness clause exists because a parse failure and a
 * zero-usage transcript are indistinguishable from `unknown.length` alone: with
 * `by_model: {}` there are no unknown ids, so `complete` used to come out true
 * over nothing at all. The note's code says which degradation happened —
 * `empty_collection` (nothing collected) vs `unknown_model` (collected, but an
 * unrecognized id that must not be silently mis-tiered under a default tier) —
 * because `tokens_directional` itself cannot carry a reason field: its subschema
 * in run-record.schema.json is additionalProperties:false.
 */
export function buildTokensDirectional({ result, modelTierMap = {}, now = new Date() }) {
  const tokens_directional = {
    by_model: result?.ok ? result.by_model : {},
    format_version: FORMAT_VERSION,
    collected_at: now.toISOString(),
    complete: false,
  };
  if (!result || !result.ok) {
    return {
      tokens_directional,
      note: { code: result?.error?.code ?? 'unknown', detail: result?.error?.detail ?? 'token collection failed' },
    };
  }
  // Resolution is normalizing, not literal: transcripts carry dated
  // (claude-sonnet-4-5-20250929), anthropic.-prefixed, and bare-alias spellings of
  // models the map holds one canonical entry for. A literal `m in modelTierMap`
  // left 46.6% of real usage lines unresolved and degraded healthy runs to
  // complete:false. See model-tier.mjs for why there is no family-substring
  // fallback: an id that is genuinely new must still land here and degrade loudly.
  const unknown = Object.keys(result.by_model).filter((m) => tierForModelId(m, modelTierMap) === null);
  if (unknown.length) {
    return {
      tokens_directional,
      note: { code: 'unknown_model', detail: `unrecognized model id(s), degraded to estimated: ${unknown.join(', ')}` },
    };
  }
  // A collect can succeed and still find nothing: an empty by_model has no
  // unknown model ids to flag, so the old `complete = true` here fired on a
  // transcript that produced zero usage lines. The live TARS-1271 record landed
  // exactly that way — `complete: true` over `by_model: {}` — and a consumer
  // reading `complete` has no reason to also test emptiness. Completeness now
  // requires something to have been collected.
  //
  // Order relative to the `unknown.length` check above is deliberately
  // unobservable, and no test pins it: `unknown` is derived from
  // Object.keys(result.by_model), so an empty by_model yields an empty unknown.
  // The two branches are disjoint by construction and cannot both apply to one
  // input. Order relative to the `!result.ok` check above them is NOT free —
  // a failed collect must keep its own error code rather than be relabelled
  // `empty_collection`, and that ordering is pinned by test.
  if (Object.keys(tokens_directional.by_model).length === 0) {
    return {
      tokens_directional,
      note: { code: 'empty_collection', detail: 'transcript parsed but contained no model usage; nothing to attribute' },
    };
  }
  tokens_directional.complete = true;
  return { tokens_directional, note: null };
}

/**
 * End-to-end collection for a run: resolve the transcript, parse it, and build
 * the `tokens_directional` field + optional degradation note. Never throws —
 * every failure mode routes through `buildTokensDirectional` and degrades to an
 * estimated-with-note result.
 */
export function collectForRun({ transcript, mode, subagentsDir, projectDir, cwd, home, start, end, gapCapMs, modelTierMap, observedTotal, agentId, sessionId, now = new Date() } = {}) {
  // Derive the subagents dir when the caller did not pass one but can name the
  // session — see subagentsDirForSession for why this is derived, not configured.
  const dir = subagentsDir ?? subagentsDirForSession({ sessionId, projectDir, cwd, home });
  const resolved = resolveTranscripts({
    transcript, mode, subagentsDir: dir, projectDir, cwd, home, observedTotal, agentId,
  });
  const result = resolved.ok
    ? collectFromFiles(resolved.paths, { start, end, gapCapMs })
    : { ok: false, by_model: {}, peak_context: 0, active_ms: 0, error: resolved.error };
  const built = buildTokensDirectional({ result, modelTierMap, now });
  return { ...built, source: resolved.ok ? (resolved.paths[0] ?? null) : null, via: resolved.via ?? null, result };
}

/**
 * Read and parse a transcript file. A missing/unreadable path degrades to a
 * structured `{ ok: false, error: { code: 'not_found' } }` result rather than
 * throwing.
 */
export function collectFromFile(path, opts = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      by_model: {},
      timestamps: { min: null, max: null },
      active_ms: 0,
      gap_cap_ms: Number.isFinite(opts.gapCapMs) ? opts.gapCapMs : DEFAULT_GAP_CAP_MS,
      lines_total: 0,
      lines_parsed: 0,
      lines_skipped: 0,
      peak_context: 0,
      error: { code: 'not_found', detail: err.message },
    };
  }
  return collectFromText(text, opts);
}

// ---- backfill: cross-run directional attribution ----
//
// When a run is driven by a loop-dispatched subagent, the driver's tokens live
// in a separate subagent transcript (not the session top-level), so the standard
// standalone/loop collection misses them. backfill-directional bridges that gap:
// it discovers the right transcript by matching its peak single-call context
// against the run's recorded `tokens_observed.total`, then attributes their token
// sums to the run record. The caller (harness.mjs backfill-directional) owns the
// write; this layer is pure discovery + cross-check.

// How far a transcript's peak single-call context may sit from the run's
// recorded tokens_observed.total and still be considered the same subagent.
//
// The lower bound absorbs a real skew: the driver reads the Agent-tool
// subagent_tokens tag, and may read it before the subagent's final streamed
// usage entry is flushed, so the transcript's true peak can exceed what was
// recorded. The upper bound is what makes this an identity check rather than a
// floor — without it, the largest transcript in the directory matches every
// smaller run, and a long-running sibling driver wins every attribution.
export const FINGERPRINT_BAND = { lo: 0.95, hi: 1.05 };

/**
 * Find the subagent transcript belonging to a run, by fingerprint.
 *
 * `observedTotal` is the run record's `tokens_observed.total` — the Agent-tool
 * `subagent_tokens` tag, which is the subagent's PEAK single-call context, not a
 * sum. A transcript's own peak (Task 2's `peak_context`) is therefore a near-exact
 * identity match. This replaced a spawnDepth + description-substring + 60s-overlap
 * AND, where any one signal failing left `tokens_directional.by_model` empty —
 * which is how TARS-1271 shipped with no directional capture at all.
 *
 * @param {{ subagentsDir:string, observedTotal?:number }} opts
 *   `start`/`end` are accepted for call-site compatibility but not consulted:
 *   fingerprint-matching transcripts are accepted regardless of window overlap.
 * @returns {{ ok:boolean, path:string|null, error:null|{code:string,detail:string} }}
 */
export function discoverSubagentForRun({ subagentsDir, observedTotal } = {}) {
  let entries;
  try {
    entries = readdirSync(subagentsDir);
  } catch (err) {
    return { ok: false, path: null, error: { code: 'not_found', detail: err.message } };
  }

  // No fingerprint means no match. There is deliberately no heuristic fallback:
  // guessing from timestamps is what produced empty and mis-attributed stamps.
  const observed = Number.isFinite(observedTotal) ? observedTotal : 0;
  if (observed <= 0) {
    return {
      ok: false,
      path: null,
      error: {
        code: 'no_fingerprint',
        detail: 'record has no tokens_observed.total, so there is nothing to fingerprint against',
      },
    };
  }

  // Sort descending so that a tie-break update always moves toward the smaller
  // path: without the `jsonlPath < best.path` condition the first entry (largest)
  // would win; with it, each smaller path replaces, and the smallest wins.
  // This makes the tie-break load-bearing on all filesystems, not just ones where
  // readdirSync returns entries in non-alphabetical order.
  entries.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  let best = null; // { path, drift }
  for (const name of entries) {
    if (!name.endsWith('.meta.json') || !name.startsWith('agent-')) continue;

    const baseName = name.slice(0, -'.meta.json'.length);
    const jsonlPath = join(subagentsDir, baseName + '.jsonl');

    const result = collectFromFile(jsonlPath);
    if (!Number.isFinite(result.peak_context) || result.peak_context <= 0) continue;

    const ratio = result.peak_context / observed;
    // Reject anything outside the band. Fingerprint-matching transcripts are accepted
    // regardless of time-window overlap — a wrong window is exactly what the old
    // MIN_OVERLAP_MS check used to reject on, leaving by_model empty (TARS-1271).
    if (ratio < FINGERPRINT_BAND.lo || ratio > FINGERPRINT_BAND.hi) continue;

    const drift = Math.abs(ratio - 1);
    // Closest to 1 wins. On an exact tie, the lexicographically smaller path wins:
    // readdirSync order is not stable across filesystems, and a non-deterministic
    // pick makes the same run attribute differently on a re-scan.
    if (best === null || drift < best.drift || (drift === best.drift && jsonlPath < best.path)) {
      best = { path: jsonlPath, drift };
    }
  }

  if (best === null) {
    return {
      ok: false,
      path: null,
      error: {
        code: 'not_found',
        detail: `no transcript peak within [${FINGERPRINT_BAND.lo}, ${FINGERPRINT_BAND.hi}] of observed total ${observed}`,
      },
    };
  }
  return { ok: true, path: best.path, error: null };
}

/**
 * Attribute directional token sums for a run from a discovered subagent
 * transcript. Never writes to disk — the caller owns the `stampTokensDirectional`
 * call. Always returns a structured result; never throws.
 *
 * Discovery is by peak-context fingerprint: the run record's
 * `tokens_observed.total` is matched against each candidate transcript's
 * `peak_context` within FINGERPRINT_BAND. The old spawnDepth + description +
 * window-overlap AND is gone; any one of those signals failing left by_model empty.
 *
 * @param {{ runDir:string, subagentsDir:string, start?:string, end?:string,
 *           modelTierMap?:object, now?:Date }} opts
 */
export function backfillDirectional({ runDir, subagentsDir, start, end, modelTierMap = {}, now = new Date() } = {}) {
  // Read the run record for the effective window + observed token total.
  let record;
  try {
    record = JSON.parse(readFileSync(join(runDir, 'record.json'), 'utf8'));
  } catch (err) {
    return { ok: false, error: { code: 'not_found', detail: `could not read record.json: ${err.message}` } };
  }

  const effectiveStart = start ?? record.started_at ?? null;
  const effectiveEnd = end ?? record.ended_at ?? now.toISOString();

  const observedTotal = record.tokens_observed?.total ?? 0;

  const discovered = discoverSubagentForRun({
    subagentsDir,
    observedTotal,
    start: effectiveStart,
    end: effectiveEnd,
  });

  if (!discovered.ok) return { ok: false, error: discovered.error };

  const result = collectFromFile(discovered.path, { start: effectiveStart, end: effectiveEnd });
  // Defense-in-depth: a transcript that passed discovery should always be parseable
  // (discovery requires at least one timestamp line, which means at least one JSON line
  // was successfully parsed → collectFromText sets ok:true). This guard covers edge
  // cases such as a transcript that becomes unreadable between discovery and collection.
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Guard: a transcript that parsed but contained no usage data in the run window
  // must not be stamped as a complete empty result — that looks like a successful
  // attribution of zero tokens, which is indistinguishable from no data.
  if (Object.keys(result.by_model).length === 0) {
    return {
      ok: false,
      error: { code: 'no_usage', detail: 'transcript was discovered but contained no usage data within the run window — not stamping empty result' },
    };
  }

  const built = buildTokensDirectional({ result, modelTierMap, now });
  return { ok: true, ...built, source: discovered.path, result };
}
