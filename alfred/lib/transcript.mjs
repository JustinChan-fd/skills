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

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A worker killed at the wall cap is exactly the run whose accounting matters most, and it
    // leaves a half-written object. Throwing here turns the most interesting run into a crash.
    return none;
  }

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
