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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

// A transcript line may carry usage in message.usage (top-level) and in each
// entry of an iterations[] array (fallback/multi-attempt sub-entries, each with
// its own .usage or .message.usage). All of them count toward the line's model.
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
 *            lines_parsed:number, lines_skipped:number, error:null|{code:string,detail:string}}}
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
    error: null,
  };

  if (typeof text !== 'string' || text.trim() === '') {
    return { ...base, error: { code: 'empty', detail: 'transcript is empty or not text' } };
  }

  const rawLines = text.split('\n').filter((l) => l.trim() !== '');
  base.lines_total = rawLines.length;

  const stamps = []; // ms timestamps of in-window, dateable lines, in file order
  const byModel = base.by_model;

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

    if (!inWindow(ts, startMs, endMs)) continue;

    if (ts !== null) {
      stamps.push({ ms: ts, iso: tsStr });
      if (base.timestamps.min === null || ts < Date.parse(base.timestamps.min)) base.timestamps.min = tsStr;
      if (base.timestamps.max === null || ts > Date.parse(base.timestamps.max)) base.timestamps.max = tsStr;
    }

    const model = typeof line?.message?.model === 'string' ? line.message.model : null;
    const usages = usagesFromLine(line);
    if (model && usages.length) {
      byModel[model] ??= emptyBucket();
      for (const u of usages) addUsage(byModel[model], u);
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

/** Munge an absolute cwd to Claude's project-directory name (dir name only). */
export function mungeProjectDir(cwd) {
  return String(cwd).replace(/[/.]/g, '-');
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

// ---- run-level orchestration (used by the CLI subcommand + phase/run-end wiring) ----

/**
 * Resolve which transcript to read for a run:
 *  - explicit `transcript` path wins;
 *  - `mode: "loop"` uses the given `subagentsDir` (newest agent-*.jsonl);
 *  - otherwise standalone: the newest top-level .jsonl in `projectDir`, or in
 *    the project dir derived from `cwd` when `projectDir` is not given.
 * Returns a discovery result `{ ok, path, error }`.
 */
export function resolveTranscript({ transcript, mode, subagentsDir, projectDir, cwd, home } = {}) {
  if (transcript) return { ok: true, path: transcript, error: null };
  if (mode === 'loop') {
    if (!subagentsDir) return { ok: false, path: null, error: { code: 'not_found', detail: 'loop mode requires a subagents dir' } };
    return discoverLoopTranscript(subagentsDir);
  }
  const dir = projectDir ?? (cwd ? projectDirForCwd(cwd, { home }) : null);
  if (!dir) return { ok: false, path: null, error: { code: 'not_found', detail: 'no project dir or cwd to discover a standalone transcript' } };
  return discoverStandaloneTranscript(dir);
}

/**
 * Turn a parser result into the additive `tokens_directional` record field
 * plus an optional degradation note. The format version is ALWAYS stamped, even
 * on failure. `complete` is true only when parsing succeeded AND every model id
 * seen is present in `modelTierMap` — a parse failure or any unrecognized model
 * id degrades to `complete: false` with a note (so an unknown model is flagged,
 * never silently mis-tiered under a default tier).
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
  const unknown = Object.keys(result.by_model).filter((m) => !(m in modelTierMap));
  if (unknown.length) {
    return {
      tokens_directional,
      note: { code: 'unknown_model', detail: `unrecognized model id(s), degraded to estimated: ${unknown.join(', ')}` },
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
export function collectForRun({ transcript, mode, subagentsDir, projectDir, cwd, home, start, end, gapCapMs, modelTierMap, now = new Date() } = {}) {
  const resolved = resolveTranscript({ transcript, mode, subagentsDir, projectDir, cwd, home });
  const result = resolved.ok
    ? collectFromFile(resolved.path, { start, end, gapCapMs })
    : { ok: false, by_model: {}, error: resolved.error };
  const built = buildTokensDirectional({ result, modelTierMap, now });
  return { ...built, source: resolved.ok ? resolved.path : null, result };
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
      error: { code: 'not_found', detail: err.message },
    };
  }
  return collectFromText(text, opts);
}
