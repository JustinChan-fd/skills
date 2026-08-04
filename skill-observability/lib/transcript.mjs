// Deterministic transcript reader for skill-run observability.
//
// Reads Claude Code session transcripts (JSONL) and extracts, VERBATIM, the
// pieces a run snapshot needs: per-assistant-line usage objects, skill/slash
// command invocation evidence, tool activity, and subagent transcripts. No
// aggregation happens here — everything returned under `raw` keys is copied
// untouched from the transcript so a snapshot is a faithful sub-record of the
// session file. Aggregation lives in record.mjs, clearly separated.
//
// Every failure mode degrades to a structured result; nothing here may throw
// past its boundary — the hook that calls this must never break a session.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// Fields copied verbatim from each transcript line onto the raw usage entry.
// The full `message.usage` object is included as-is; these are the line-level
// identifiers that make the entry traceable back to the transcript.
const LINE_ID_FIELDS = ['uuid', 'parentUuid', 'requestId', 'sessionId', 'timestamp', 'isSidechain', 'entrypoint', 'gitBranch', 'version', 'effort'];

export function parseLines(text) {
  const out = [];
  if (typeof text !== 'string' || text === '') return out;
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '') continue;
    try {
      out.push(JSON.parse(rawLine));
    } catch {
      out.push({ __unparseable: true });
    }
  }
  return out;
}

export function readTranscriptLines(path) {
  try {
    return { ok: true, lines: parseLines(readFileSync(path, 'utf8')), error: null };
  } catch (err) {
    return { ok: false, lines: [], error: { code: 'read_failed', detail: err.message } };
  }
}

function contentBlocks(line) {
  const content = line?.message?.content;
  return Array.isArray(content) ? content : [];
}

function contentText(line) {
  const content = line?.message?.content;
  if (typeof content === 'string') return content;
  return contentBlocks(line)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// ---- invocation detection ----
//
// A "skill run" is triggered either by the Skill tool (assistant tool_use
// block named "Skill") or by a user slash command, which Claude Code encodes
// in the user message as <command-name>/foo</command-name> (with optional
// <command-args> / <command-message> siblings).

const COMMAND_TAG = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS_TAG = /<command-args>([\s\S]*?)<\/command-args>/;

export function detectInvocations(lines) {
  const invocations = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line?.type === 'user') {
      const text = contentText(line);
      const m = COMMAND_TAG.exec(text);
      if (m) {
        invocations.push({
          kind: 'slash_command',
          name: m[1].trim(),
          args: (COMMAND_ARGS_TAG.exec(text)?.[1] ?? '').trim() || null,
          line_index: i,
          uuid: line.uuid ?? null,
          timestamp: line.timestamp ?? null,
        });
      }
    }
    if (line?.type === 'assistant') {
      for (const block of contentBlocks(line)) {
        if (block?.type === 'tool_use' && block.name === 'Skill') {
          invocations.push({
            kind: 'skill_tool',
            name: typeof block.input?.skill === 'string' ? block.input.skill : null,
            args: typeof block.input?.args === 'string' ? block.input.args : null,
            line_index: i,
            uuid: line.uuid ?? null,
            timestamp: line.timestamp ?? null,
            tool_use_id: block.id ?? null,
          });
        }
      }
    }
  }
  return invocations;
}

// ---- raw extraction ----

// One raw entry per assistant line that carries a top-level message.usage.
// The usage object is copied verbatim (per-TTL cache split, service_tier,
// speed, iterations, server_tool_use — whatever the API reported).
export function extractUsageEntries(lines, { source } = {}) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line?.type !== 'assistant') continue;
    const usage = line?.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const entry = {
      source: source ?? 'session',
      line_index: i,
      model: typeof line?.message?.model === 'string' ? line.message.model : null,
      stop_reason: line?.message?.stop_reason ?? null,
      // The API's message id. Multiple transcript lines can report usage for a
      // SINGLE call under one message.id (measured: 6,222 of 11,805 rows on this
      // machine), so this is the dedupe key that keeps totals honest. Carried
      // here rather than derived later so record.mjs never has to re-read lines.
      message_id: typeof line?.message?.id === 'string' ? line.message.id : null,
      usage,
    };
    for (const f of LINE_ID_FIELDS) {
      if (line[f] !== undefined) entry[f] = line[f];
    }
    out.push(entry);
  }
  return out;
}

// Tool activity in the window: names + ids only (never inputs/outputs, which
// can be huge and may carry content the snapshot doesn't need).
export function extractToolCalls(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line?.type !== 'assistant') continue;
    for (const block of contentBlocks(line)) {
      if (block?.type === 'tool_use') {
        out.push({ line_index: i, name: block.name ?? null, id: block.id ?? null, timestamp: line.timestamp ?? null });
      }
    }
  }
  return out;
}

// Agent/Task dispatch results observed on user lines (toolUseResult) — these
// carry the parent-side observation of a subagent (agentId, totals when
// synchronous). Copied verbatim minus nothing: they are small and numeric.
export function extractDispatchResults(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line?.type !== 'user') continue;
    const r = line?.toolUseResult;
    if (!r || typeof r !== 'object') continue;
    if (r.agentId === undefined && r.totalTokens === undefined && r.usage === undefined) continue;
    out.push({ line_index: i, timestamp: line.timestamp ?? null, toolUseResult: r });
  }
  return out;
}

export function detectInterruption(lines) {
  return lines.some((l) => l?.type === 'user' && l?.toolUseResult && typeof l.toolUseResult === 'object' && l.toolUseResult.interrupted === true);
}

// ---- subagents ----
//
// Subagent transcripts live at <project-dir>/<session-uuid>/subagents/
// agent-<id>.jsonl with an agent-<id>.meta.json sibling. `cursors` maps
// filename -> line count already processed by a previous firing, so only the
// delta is attributed to this run.

// Walks subagents/ RECURSIVELY. A flat readdir was measured to miss 89.5% of
// agent transcripts on this machine — 5,176 files under
// subagents/workflows/<wf_id>/ against 605 sitting flat, silently, no error.
//
// THE TRAP, and why the filter is on the filename prefix rather than the
// extension: recursing and taking every *.jsonl also swallows journal.jsonl
// (196 on this disk), which is workflow resume bookkeeping carrying ZERO usage
// fields. Each would land as a phantom zero-token agent, so an overcount would
// silently replace the undercount and the headline bug would look fixed.
// `agent-` is the real convention; `.jsonl` is a coincidence journal.jsonl
// shares.
//
// `name` is the path RELATIVE to subagents/, so it stays unique within a
// session and remains a stable cursor key. (Measured: 0 basename collisions
// within any single session; the 6 that exist are across sessions, and cursors
// are per-session — but a relative path is correct regardless of that count.)
export function listSubagentFiles(sessionDir) {
  const root = join(sessionDir, 'subagents');
  const out = [];

  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing/unreadable dir is not an error — there may be no subagents
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(join(dir, e.name), rel);
      } else if (e.name.startsWith('agent-') && e.name.endsWith('.jsonl')) {
        out.push({ name: rel, path: join(dir, e.name) });
      }
    }
  };

  walk(root, '');
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function readSubagentDelta(sessionDir, cursors = {}) {
  const agents = [];
  const nextCursors = { ...cursors };
  for (const f of listSubagentFiles(sessionDir)) {
    const { ok, lines } = readTranscriptLines(f.path);
    if (!ok) continue;
    const from = Number.isInteger(cursors[f.name]) ? cursors[f.name] : 0;
    nextCursors[f.name] = lines.length;
    const delta = lines.slice(from);
    const usage = extractUsageEntries(delta, { source: `subagent:${f.name}` });
    if (usage.length === 0 && from > 0) continue; // nothing new from this agent
    let meta = null;
    try {
      // Resolve the sidecar next to the transcript itself. Deriving it from
      // f.path (not from sessionDir + f.name) keeps nested agents working:
      // their sidecar lives in the same workflows/<wf_id>/ dir they do.
      meta = JSON.parse(readFileSync(f.path.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    } catch {
      /* meta is optional */
    }
    agents.push({
      file: f.name,
      meta,
      lines_from: from,
      lines_to: lines.length,
      usage_entries: usage,
    });
  }
  return { agents, nextCursors };
}

// Session subdirectory that holds subagents/ for a given transcript path:
// <dir>/<session-uuid>.jsonl -> <dir>/<session-uuid>/
export function sessionDirForTranscript(transcriptPath) {
  const b = basename(transcriptPath);
  if (!b.endsWith('.jsonl')) return null;
  return join(transcriptPath.slice(0, -b.length), b.slice(0, -'.jsonl'.length));
}

export function fileMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
