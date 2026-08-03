// transcript — where the transcript of a worker we just launched lives.
//
// THIS IS NOT THE DISCOVERY LAYER lib/report.mjs REFUSES. That refusal is aimed at searching:
// the old collector fingerprinted candidate files by `observedTotal` and widened through four
// strategies, and a searcher is free to find the wrong file and report a confident number for
// a session that is not the one that ended. Nothing here searches. There is exactly one
// candidate and it is computed from two things we already know for certain — the cwd we chose
// for the spawn, and the `session_id` the CLI itself printed in the result JSON it wrote to our
// log. Either the file is at that path or the caller records a hole.
//
// WHY THE HOOK PATH DOES NOT COVER THIS. `recordFromHookPayload` is for a session reporting on
// ITSELF: Claude Code runs the Stop hook inside the session and hands it `transcript_path`
// outright. A worker Alfred spawned is a DIFFERENT process, and the parent gets no hook — so
// without this the $1.07 run of 2026-07-31 produced no record at all, and `executeWork` shipped
// with `report: null` and a comment saying the path "is not discoverable". It is; it just is not
// handed over.
//
// THE FORMULA, MEASURED. Both halves bite:
//
//   1. realpath FIRST. `/tmp` is a symlink to `/private/tmp` on darwin, so every run under
//      `/tmp` has its transcript filed under the resolved spelling. Composing the unresolved
//      one looks in a directory that does not exist.
//   2. EVERY non-alphanumeric character becomes a dash — not just the separators. Verified
//      against two real directories on this machine, the second of which is the interesting
//      one: `/Users/…@bwt3.com/.claude/jobs/…` mangles to `-Users-…-bwt3-com--claude-jobs-…`,
//      where `@` and `.` are dashes and `/.` is the DOUBLE dash a slash-only pass cannot make.

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Exported so a caller can say what it looked for when the file is not there. A reporter that
// says only "no transcript" leaves nobody able to tell a wrong formula from an absent run.
export function projectDirFor(cwd, { home = homedir() } = {}) {
  let resolved = String(cwd ?? '');
  try {
    resolved = realpathSync(resolved);
  } catch {
    // UNRESOLVABLE IS NOT FATAL. A repo deleted between the spawn and the report is a plausible
    // tick and this module is a sidecar — it must never be what kills a run whose work already
    // landed. The unresolved spelling is composed instead, the caller finds nothing there, and
    // that becomes a reported hole rather than an exception.
  }
  return join(home, '.claude', 'projects', resolved.replace(/[^A-Za-z0-9]/g, '-'));
}

export function transcriptPathFor({ cwd, sessionId, home = homedir() } = {}) {
  return join(projectDirFor(cwd, { home }), `${sessionId}.jsonl`);
}

// Why the worker STOPPED, when it stopped for a reason Alfred did not cause.
//
// MEASURED on the first real jira run (TARS-1351, 2026-08-01): the worker spent the whole
// `--max-budget-usd 8` cap, the CLI terminated it mid-flight, and the run was graded a PASS.
// `spawnWorker`'s `killed` flag could not catch it and never could — that flag is set by
// Alfred's own `setTimeout`, so it means "WE stopped it", and a budget kill happens inside the
// child, which then exits NORMALLY. exit 0, no signal, `killed: false`. Every signal that the
// run was cut short lives in this file and nowhere else.
//
// FOUR FIELDS CARRIED THE SAME FACT and the check reads three of them, because reading only one
// would rest a finding on whichever field the vendor renames first:
//   is_error: true | subtype: error_max_budget_usd | terminal_reason: budget_exhausted
// `errors` is used for the DETAIL rather than the decision — an array whose contents are prose
// is the right thing to quote to an operator and the wrong thing to branch on.
//
// GENERAL, NOT BUDGET-SPECIFIC. Any `is_error` result means the CLI is reporting its own run as
// failed, and a gate that only knew about budgets would pass the next terminal reason there is.
// `reason` is returned verbatim so the finding names what actually happened rather than a
// category this function guessed.
export function terminalErrorFromWorkerLog(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;

  // The LAST line that parses, not the whole file. Single-object `--output-format json` is one
  // line and satisfies this identically, so the same reader also survives `stream-json`, where
  // the result object is the final event of many.
  const lines = text.trim().split('\n');
  let parsed = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const candidate = JSON.parse(lines[i]);
      if (candidate && typeof candidate === 'object') {
        parsed = candidate;
        break;
      }
    } catch {
      // Not a complete JSON line. A worker killed mid-write leaves exactly this, and it is the
      // run whose accounting matters most — keep walking backwards rather than throwing.
    }
  }
  if (!parsed) return null;

  const reason = parsed.terminal_reason ?? parsed.subtype ?? null;
  if (parsed.is_error !== true && !reason) return null;
  // BOTH FIELDS ARE WRITTEN ON A GENUINE FINISH, AND THEY DISAGREE. MEASURED ON TARS-1351,
  // 2026-08-01: `terminal_reason: 'completed'` alongside `subtype: 'success'` — two different
  // strings for the same clean stop. The `??` above prefers `terminal_reason`, so checking only
  // `reason === 'success'` missed this exactly and reported a healthy 58-turn run as
  // `check_failed`. `subtype` is checked directly, not folded into `reason`, because `reason` is
  // also the string a real failure's `terminal_reason` carries (`budget_exhausted`,
  // `context_exhausted`) and this exemption must not fire on those.
  if (parsed.is_error !== true && (reason === 'success' || parsed.subtype === 'success')) return null;

  const errors = Array.isArray(parsed.errors) ? parsed.errors.filter((e) => typeof e === 'string') : [];
  return {
    reason: typeof reason === 'string' ? reason : 'unknown',
    errors,
    turns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
    cost_usd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
  };
}

// The CLI's own account of the run, out of the log we told it to write.
//
// `total_cost_usd` is carried alongside the id for one reason: it is an INDEPENDENT second
// source for the number this project computes from the price table, and the two agreeing is
// the only evidence the table is right. Measured on the real run — vendor 1.0671731999999998,
// ours 1.067173. A cross-check, never the source: `lib/models.mjs` is ground truth for model
// ids and `lib/prices.mjs` for rates, per the OTel finding that CLI-reported ceilings are not.
export function sessionFromWorkerLog(text) {
  const none = { session_id: null, total_cost_usd: null };
  if (typeof text !== 'string' || text.trim() === '') return none;

  // The LAST line that parses, not the whole file — same reader as terminalErrorFromWorkerLog
  // above, for the same reason. Single-object `--output-format json` is one line and satisfies
  // this identically; `stream-json` writes several lines first (hook context, tool init, the
  // assistant's own messages) and the result object — the one carrying session_id — is the
  // final line. A whole-blob `JSON.parse` throws on that shape and every stream-json run would
  // report as unmeasurable.
  const lines = text.trim().split('\n');
  let parsed = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const candidate = JSON.parse(lines[i]);
      if (candidate && typeof candidate === 'object') {
        parsed = candidate;
        break;
      }
    } catch {
      // A worker killed at the wall cap leaves exactly this on its last line, and it is the run
      // whose accounting matters most — keep walking backwards rather than giving up or throwing.
    }
  }
  if (!parsed) return none;

  const id = parsed?.session_id;
  // An error result is still valid JSON with no id. Returning `undefined` would compose
  // `<project-dir>/undefined.jsonl`, and a stale file at that path would be read as this run's
  // — the wrong-session defect report.mjs's header exists to refuse.
  if (typeof id !== 'string' || id.trim() === '') return none;

  const cost = parsed?.total_cost_usd;
  return {
    session_id: id,
    total_cost_usd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
  };
}

// The worker's FIRST TURN, out of a log that is still being written.
//
// WHY THIS EXISTS AND WHY IT IS HERE. `lib/preflight.mjs` checks an attestation the worker writes
// before it touches anything. That check is only worth its own existence if it can happen WHILE
// the worker runs: a refusal computed after a 25-minute run has already paid the full price of
// the thing it was meant to prevent — this project's computed-and-discarded shape (#63, #69,
// #72, #73) with a dollar figure on it. `--output-format stream-json` is what makes the early
// read possible, and it is already in the worker's argv for an unrelated reason (lib/router.mjs:
// so the operator is not flying blind for the run's duration). This module already owns "read
// facts out of the worker's log", so the reader lives beside the other two rather than in
// preflight.mjs, which is deliberately I/O-free and knows nothing about log formats.
//
// MEASURED, on the real 301-line stream-json log at
// `.alfred-runs/20260802T142320Z-7/worker.log`: 175 `assistant` events, 113 `user`, 12 `system`,
// 1 `result`. The first `user` event is line 6, and the three content blocks before it are
// `thinking`, `text`, `tool_use` in that order. So the first turn is the assistant text emitted
// before the first `user` event — and it is on disk within seconds of the spawn, long before the
// run ends.
//
// THREE STATES, and `in_progress` is the load-bearing one. A poller reading 200ms in sees
// assistant text and no `user` event yet: the turn is still being written, and refusing there
// would fire on a worker that was about to answer correctly. A false refusal costs a spawn and
// teaches the operator to route around the mechanism, which is worse than no mechanism. Same
// absent/invalid/incomplete discipline as `readMarker` and `parseAttestation`.
//
// `thinking` IS NOT TEXT. It is the model reasoning toward an answer rather than the answer, and
// an attestation found only in a thinking block is one the worker never committed to. `tool_use`
// has no text to read.
//
// NEVER THROWS. Same rule as the two readers above: the mechanism that reports a problem must not
// become the problem, and this one runs against a file another process is appending to.
export function firstTurnFromWorkerLog(text) {
  const none = { state: 'absent', text: null };
  // `typeof` ONLY, and the blank-string half of this guard was DELETED rather than kept. It was
  // written as `|| text.trim() === ''`, and a mutant removing that clause survived the suite — so
  // it was traced rather than re-pinned: a whitespace-only log is already dropped line-by-line by
  // the `!line.trim()` skip below and returns `none` through the empty-`parts` clause at the end.
  // No input can distinguish the two forms, which makes it unearned code rather than an untested
  // guard, and a guard that cannot fire is indistinguishable from one that passed — this project's
  // recurring shape. The `typeof` half stays and is load-bearing: `(42).split` does not exist, so
  // dropping it turns a hostile input into the throw this function promises never to do.
  if (typeof text !== 'string') return none;

  const parts = [];
  let sawUser = false;
  let sawResult = false;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // A torn line, and it can appear ANYWHERE in a file being appended to — not only at the
      // tail. Treating one as the turn boundary would truncate the attestation and refuse on a
      // partial quote, so it is skipped and the scan continues.
      continue;
    }
    if (!event || typeof event !== 'object') continue;

    if (event.type === 'result') {
      sawResult = true;
      break;
    }

    // THE BOUNDARY. A `user` event is a tool result coming back, which means the worker has
    // stopped talking and started acting. Everything after it belongs to a later turn.
    if (event.type === 'user') {
      sawUser = true;
      break;
    }

    if (event.type !== 'assistant') continue;

    // A SUBAGENT'S WORDS ARE NOT THE WORKER'S. MEASURED: every assistant event on the real log
    // carried `parent_tool_use_id: null`, because that run delegated to nothing. A run that DOES
    // delegate interleaves the subagent's messages into the same stream tagged with the tool_use
    // id that spawned them — and reading those as the attestation would grade a context that was
    // never handed the contract.
    if (event.parent_tool_use_id) continue;

    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type !== 'text') continue;
      if (typeof block.text !== 'string') continue;
      parts.push(block.text);
    }
  }

  if (parts.length === 0) return none;
  return {
    // A `result` event means the CLI says the run is over, so the turn cannot grow. Without that
    // clause a worker that answered and stopped — no tool calls at all — would poll as
    // `in_progress` forever and the caller would wait out the wall cap on a run that finished in
    // ten seconds.
    state: sawUser || sawResult ? 'complete' : 'in_progress',
    text: parts.join('\n'),
  };
}
