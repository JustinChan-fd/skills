#!/usr/bin/env node
// Skill-run observability hook — the deterministic entry point.
//
// Wire this ONE script to Stop, StopFailure, and SessionEnd (see install.mjs /
// README). On every firing it:
//   1. reads the hook payload from stdin (session_id, transcript_path, cwd, …)
//   2. slices the session transcript from this session's cursor to EOF
//   3. detects skill runs in that window (Skill tool_use blocks and
//      <command-name> slash-command tags)
//   4. if any: snapshots raw usage (session + subagent deltas) and writes one
//      JSON record with `raw` and `computed` strictly separated
//   5. advances the cursor either way, so nothing is ever double-counted
//
// Contract with the session that invokes it: NEVER block, NEVER throw, always
// exit 0. A hook that exits 2 would inject its stderr back into the model's
// turn; an observability tap must be invisible. Failures are appended to
// <log-dir>/.state/errors.log instead.
//
// Environment:
//   SKILL_OBS_DIR      log folder (default ~/.claude/skill-runs)
//   SKILL_OBS_LOG_ALL  "1" => snapshot every turn, not only skill turns
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  readTranscriptLines,
  detectInvocations,
  extractUsageEntries,
  extractToolCalls,
  extractDispatchResults,
  detectInterruption,
  readSubagentDelta,
  sessionDirForTranscript,
  environmentFromLines,
} from '../lib/transcript.mjs';
import { buildRecord } from '../lib/record.mjs';

const LOG_DIR = process.env.SKILL_OBS_DIR || join(homedir(), '.claude', 'skill-runs');
const STATE_DIR = join(LOG_DIR, '.state');

function atomicWriteJson(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

function logError(detail) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(join(STATE_DIR, 'errors.log'), `${new Date().toISOString()} ${detail}\n`);
  } catch {
    /* even error logging is best-effort */
  }
}

function readState(sessionId) {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, `${sessionId}.json`), 'utf8'));
  } catch {
    return { session_cursor: 0, subagent_cursors: {} };
  }
}

function writeState(sessionId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  atomicWriteJson(join(STATE_DIR, `${sessionId}.json`), state);
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unnamed';
}

function main() {
  let payload = {};
  try {
    const raw = readFileSync(0, 'utf8');
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    logError(`stdin parse failed: ${err.message}`);
    return;
  }

  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (!sessionId || !transcriptPath || !existsSync(transcriptPath)) {
    logError(`missing session_id/transcript_path (event=${payload.hook_event_name ?? 'unknown'})`);
    return;
  }

  const state = readState(sessionId);
  const { ok, lines, error } = readTranscriptLines(transcriptPath);
  if (!ok) {
    logError(`transcript read failed: ${error.detail}`);
    return;
  }

  const from = Number.isInteger(state.session_cursor) ? Math.min(state.session_cursor, lines.length) : 0;
  const windowLines = lines.slice(from);
  const invocations = detectInvocations(windowLines);

  // Subagent deltas are read (and their cursors advanced) on EVERY firing, so
  // tokens spent in non-skill turns never leak into a later skill record.
  const sessionDir = sessionDirForTranscript(transcriptPath);
  const { agents, nextCursors } = sessionDir
    ? readSubagentDelta(sessionDir, state.subagent_cursors ?? {})
    : { agents: [], nextCursors: state.subagent_cursors ?? {} };

  const shouldLog = invocations.length > 0 || process.env.SKILL_OBS_LOG_ALL === '1';

  // Deterministic run id: session prefix + the window it covers. Unique per
  // record (cursors guarantee a window is processed once) and reconstructable
  // from run.window if a record's id is ever in doubt.
  const runId = `${String(sessionId).slice(0, 8)}-${from}-${lines.length}`;

  // Persistent spawn map: the first firing that SEES a subagent file owns it.
  // If that firing writes a record, the agent is attributed to its run_id
  // forever — later firings that pick up more of the agent's spend join back
  // to the spawning run. First seen during an unlogged firing => null
  // (spawned outside any logged run; still tracked so it never mis-joins).
  const spawns = { ...(state.agent_spawns ?? {}) };
  for (const a of agents) {
    if (!(a.file in spawns)) {
      spawns[a.file] = shouldLog && windowLines.length > 0 ? runId : null;
    }
  }

  // Set only after the record file is on disk. A firing that intended to log but
  // failed must not hand its runId forward: the next window's tail would point
  // at a record no reader can open.
  let wroteRecord = false;

  if (shouldLog && windowLines.length > 0) {
    const usageEntries = extractUsageEntries(windowLines, { source: 'session' });
    const record = buildRecord({
      runId,
      hookPayload: payload,
      invocations,
      usageEntries,
      toolCalls: extractToolCalls(windowLines),
      dispatchResults: extractDispatchResults(windowLines),
      subagents: agents,
      subagentSpawns: spawns,
      interruption: detectInterruption(windowLines),
      window: { line_from: from, line_to: lines.length, transcript_lines_total: lines.length },
      // Timestamp of the last API call the PREVIOUS window saw. A window that
      // opens ON the invocation has no in-window predecessor to measure the
      // cache-TTL gap against, and that is the common shape for a skill invoked
      // as the first act of a turn — without this it reports cache_state
      // `unknown` and its cost is never comparable.
      previousCallAt: state.last_call_at ?? null,
      // run_id of the last record written for this session, so this window's
      // pre-invocation tail names its real owner. See the field's comment in
      // record.mjs: the transcript flush races this hook, so a turn's final API
      // call routinely lands at the head of the NEXT window.
      previousRunId: state.last_run_id ?? null,
      // Scanned over the whole window, not read off line 0 — see
      // environmentFromLines: line 0 carried none of these in 434/434 sessions.
      environment: environmentFromLines(windowLines),
    });

    try {
      const day = record.logged_at.slice(0, 10);
      const dir = join(LOG_DIR, day);
      mkdirSync(dir, { recursive: true });
      const stamp = record.logged_at.replace(/[-:]/g, '').replace(/\..+/, 'Z');
      const label = record.run.skills.length ? record.run.skills.map(safeName).join('+') : 'turn';
      // The window suffix is what makes the name unique. The stamp is
      // second-resolution, and two firings inside one second DID collide: the
      // second record overwrote the first while index.jsonl appended both lines,
      // so the index claimed a record that was no longer on disk. `from-to` is
      // unique per record by construction (cursors process a window once), and
      // is the same pair already carried in run_id and run.window.
      const file = join(dir, `${stamp}__${label}__${String(sessionId).slice(0, 8)}-${from}-${lines.length}.json`);
      atomicWriteJson(file, record);

      // One computed-only summary line per record: cheap to load for
      // dashboards/KPIs without touching the full snapshots. Every field is a
      // scalar or a flat array of scalars, and a field with no answer is null
      // rather than absent — an absent key silently shrinks the table a reader
      // builds, and a group-by on it drops those rows instead of bucketing them.
      const summary = {
        file: file.slice(LOG_DIR.length + 1),
        run_id: record.run.run_id,
        logged_at: record.logged_at,
        session_id: record.run.session_id,
        trigger_event: record.run.trigger_event,
        skills: record.run.skills,
        // WHERE it ran. cwd is the truth; repo is its basename, denormalized so
        // every consumer doing a cross-repo group-by need not parse paths.
        cwd: record.run.cwd ?? null,
        repo: record.run.cwd ? basename(record.run.cwd) : null,
        // WHICH PATH invoked it. A slash line carries no usage of its own; a
        // Skill tool_use is emitted BY an API call. That difference hid a defect
        // behind 93 green tests, and `skills` alone cannot express it.
        invocation_kinds: [...new Set(record.raw.invocations.map((i) => i.kind).filter(Boolean))],
        // WHICH CODE was running, for regressions that track a version or branch.
        claude_code_version: record.run.environment?.claude_code_version ?? null,
        git_branch: record.run.environment?.git_branch ?? null,
        // WHETHER THE COST MAY BE COMPARED. Without these on the index, a KPI
        // averaged over index.jsonl mixes cold runs in with warm ones at 8x the
        // marginal cost per call — the exact error the attribution work exists
        // to prevent, reintroduced by the reader instead of the writer.
        cache_state: record.computed.attribution.cache_state ?? null,
        marginal_comparable: record.computed.attribution.marginal_comparable ?? null,
        models: Object.keys(record.computed.tokens.by_model),
        tokens_grand_total: record.computed.tokens.grand_total,
        boundary_total: record.computed.tokens.boundary_total,
        cost_total_usd: record.computed.cost.total_usd,
        cost_marginal_usd: record.computed.cost.marginal_usd,
        cost_context_carry_usd: record.computed.cost.context_carry_usd,
        cost_known_models_usd: record.computed.cost.known_models_usd,
        cost_complete: record.computed.cost.complete,
        wall_ms: record.computed.duration.wall_ms,
        active_ms: record.computed.duration.active_ms,
        api_calls: record.computed.counts.api_calls,
        subagents: record.computed.counts.subagents,
        interrupted: record.computed.outcome.interrupted_tool_seen,
        error_type: record.computed.outcome.error_type,
        schema_version: record.schema_version,
      };
      appendFileSync(join(LOG_DIR, 'index.jsonl'), JSON.stringify(summary) + '\n');
      wroteRecord = true;
    } catch (err) {
      logError(`record write failed: ${err.message}`);
    }
  }

  // Advanced on EVERY firing, logged or not: an unlogged turn still consumed
  // wall-clock time the prompt cache had to survive, so skipping it here would
  // overstate the next run's idle gap and call a warm run cold.
  const windowCallStamps = extractUsageEntries(windowLines, { source: 'session' })
    .map((e) => (e.timestamp ? Date.parse(e.timestamp) : NaN))
    .filter(Number.isFinite);
  const lastCallAt = windowCallStamps.length
    ? new Date(Math.max(...windowCallStamps)).toISOString()
    : (state.last_call_at ?? null);

  try {
    writeState(sessionId, {
      session_cursor: lines.length,
      subagent_cursors: nextCursors,
      agent_spawns: spawns,
      last_call_at: lastCallAt,
      // Only advanced when a record was actually WRITTEN: an unlogged firing has
      // no run_id to hand forward, and overwriting this with null there would
      // orphan the tail of the last real run.
      last_run_id: wroteRecord ? runId : (state.last_run_id ?? null),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    logError(`state write failed: ${err.message}`);
  }
}

try {
  main();
} catch (err) {
  logError(`unexpected: ${err.stack ?? err.message}`);
}
process.exit(0);