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
  if (parsed.is_error !== true && reason === 'success') return null;

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
