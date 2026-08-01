// report — build one accounting record for a finished session.
//
// A PURE FUNCTION, per PLAN.md §2.5: `buildRecord(...) -> record`. It reads two
// things from disk (the transcript, and the subagent files it was told about) and
// writes nothing. The sink path is carried as data for a caller to use. That
// matters concretely: this project's test suite has previously written into the
// production telemetry sink, and `syncRun`'s `git add -A -- log` then absorbed
// unrelated staged changes.
//
// WHY THERE IS NO DISCOVERY LAYER. The Stop hook payload carries `transcript_path`,
// `session_id`, and `cwd` outright, so the record is built from what we were told.
// The old collector's `discoverLoopTranscript` / `discoverSubagentForRun` — with
// `observedTotal` fingerprinting and four-strategy `via` widening — existed only
// because nothing told it which transcript belonged to the run. Given the payload,
// all of it is dead weight, and worse than dead: a searcher can find the wrong file
// and report a confident number for a session that isn't the one that just ended.
//
// AND STILL NO DISCOVERY LAYER, NOW THAT THERE IS A THIRD ENTRY POINT. `recordForRun`
// reports on a worker the PARENT spawned, which gets no Stop hook — that is why
// `executeWork` shipped with `report: null` and the first real run cost $1.0671732 and
// left no record. It searches nothing either: the CLI prints its own `session_id` into
// the log we told it to write, we chose the cwd, and lib/transcript.mjs composes ONE
// candidate from the two. The distinction that matters is between computing a path and
// hunting for a file; only the second can land on the wrong session.
//
// WHAT THIS MODULE ADDS OVER `tokens.mjs` + `prices.mjs`:
//
//   1. THE PARENT/SUBAGENT JOIN. Subagent turns are NOT in the parent transcript —
//      measured on a real 28-subagent session, 0 `isSidechain` entries in 999
//      lines. They live in `<session>/subagents/agent-<id>.jsonl` with a sibling
//      `.meta.json` carrying `{agentType, description, toolUseId, spawnDepth}`, and
//      `toolUseId` is what joins a subagent back to the parent tool call that
//      spawned it. So the two figures are separate measurements of separate files,
//      reported separately, and a caller that wants one number adds them.
//   2. `skipped`. The collector counts what it parsed; the record also has to say
//      what it could not. Derived here rather than added to `tokens.mjs` because it
//      is a property of the file, not of the accounting.
//   3. WIRING THE GUARDS. `usageRefusal` and the gap codes exist in `gaps.mjs` and
//      are tested there. Wiring is where a guard gets forgotten — an unwired
//      tripwire is precisely the green-and-blind shape this project keeps hitting —
//      so `test/report.test.mjs` asserts the call happens, not just that it works.
//
// NEVER ZERO-FILL. Carried from M0: a zero is plottable and false, which is worse
// than a hole. Two distinct ways to say "not known":
//
//   - `cost.total_usd: null` + `complete: false` — we could not read the spend.
//     Used on the failure path and when the usage tripwire fires. A $0.00 there
//     would say the run was free, when what happened is that it spent money we
//     failed to measure.
//   - `gaps[]` — a named structural hole. The record is still worth reading; this
//     says exactly what is missing from it. A gap does NOT set `ok: false`.
//
// ABSENT IS NOT UNREADABLE. A missing subagents directory means nothing spawned,
// and records no gap. If every single-context run carried a permanent hole, the
// gaps list would stop distinguishing anything. A directory that exists and cannot
// be read is the opposite case and IS named: we know we are missing something.

import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { collectFromText } from './tokens.mjs';
import { priceTokens } from './prices.mjs';
import { newGaps, noteGap, usageRefusal } from './gaps.mjs';
import { stampProblems } from './suite.mjs';
import { projectDirFor, sessionFromWorkerLog, transcriptPathFor } from './transcript.mjs';

const DIRECTIONS = ['input', 'output', 'cache_read', 'cache_creation'];

const zero = () => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });

// The record's `work` block when there is no work item — a hand-run session reported
// by the Stop hook. Null-shaped rather than absent: a reader doing `work.item_id`
// gets null, not a TypeError, and a dashboard column stays present and empty instead
// of the row vanishing.
const NO_WORK = { source: null, item_id: null, title: null, ac_count: null };

const nullish = (v) => v === null || v === undefined;

function mergeInto(target, byModel) {
  for (const [model, counts] of Object.entries(byModel ?? {})) {
    const acc = target[model] ?? zero();
    for (const k of DIRECTIONS) acc[k] += counts[k];
    target[model] = acc;
  }
  return target;
}

// Wall clock from a transcript's own first and last stamps.
//
// Distinct from `active_ms`, which caps each inter-message gap: wall time includes
// the pauses, active time excludes them. Both are reported because the difference is
// the interesting part — a run that is 4 minutes of work inside 40 minutes of wall
// clock is a different thing from 40 minutes of work.
function wallMs(timestamps) {
  const min = Date.parse(timestamps?.min ?? '');
  const max = Date.parse(timestamps?.max ?? '');
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return max - min;
}

// Reads one subagent's transcript plus its sibling meta. Both are optional in the
// sense that neither missing is fatal: a `.jsonl` with no meta still spent tokens and
// still belongs in the record, so it is reported with null structural fields rather
// than dropped. Dropping it would under-report the spawn count, and spawn count is
// the metric the delegation-cost lesson rests on.
function readSubagent(dir, file) {
  const agentId = basename(file, '.jsonl');

  let text = '';
  try {
    text = readFileSync(join(dir, file), 'utf8');
  } catch {
    text = '';
  }
  const collected = collectFromText(text);

  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, `${agentId}.meta.json`), 'utf8'));
  } catch {
    meta = {};
  }

  const priced = priceTokens(collected.by_model);

  return {
    agent_id: agentId,
    agentType: meta.agentType ?? null,
    description: meta.description ?? null,
    toolUseId: meta.toolUseId ?? null,
    // Preserved verbatim so nested delegation stays attributable. A subagent that
    // spawned its own subagent is depth 2, and flattening that loses the tree.
    spawnDepth: nullish(meta.spawnDepth) ? null : meta.spawnDepth,
    by_model: collected.by_model,
    wall_ms: wallMs(collected.timestamps),
    active_ms: collected.active_ms,
    cost_usd: priced.total_usd,
  };
}

// Reads the subagents directory. Returns the list plus how the read went, so the
// caller can tell "nothing spawned" from "we could not look".
function readSubagents(subagentsDir) {
  if (nullish(subagentsDir)) return { subagents: [], unreadable: null };

  let files;
  try {
    files = readdirSync(subagentsDir);
  } catch (err) {
    // ENOENT is the ordinary case for a session that spawned nothing — the directory
    // is only created when a subagent runs. Anything else (ENOTDIR, EACCES) means the
    // path is there and we failed to read it, which is a hole worth naming.
    if (err?.code === 'ENOENT') return { subagents: [], unreadable: null };
    return { subagents: [], unreadable: `${subagentsDir}: ${err?.code ?? 'unreadable'}` };
  }

  const subagents = files
    .filter((f) => f.endsWith('.jsonl'))
    // Sorted so a record is a function of its inputs and not of directory order.
    .sort()
    .map((f) => readSubagent(subagentsDir, f));

  return { subagents, unreadable: null };
}

// The shape returned when the transcript itself could not be read. Built as a whole
// record so a consumer never has to branch on which fields exist — `ok: false` tells
// it not to trust the numbers, and every field it might read is present.
//
// PRESENT IS NOT THE SAME AS CARRIED. Until 2026-08-01 this function did not accept
// `gate` or `delivery`, so both keys existed here and both were always empty: every
// transcript-unreadable run persisted `gate: {pass: null, findings: []}` over a verdict
// it had been handed, and `delivery: {commits: [], pr_url: null}` over a branch it had
// pushed. Found by diffing the console against the first record ever written to disk,
// which printed `gate: FAIL / check_failed` beside a file that said nobody looked.
//
// `ok: false` SCOPES TO THE NUMBERS, not to the judgement. What failed here is reading
// the transcript — accounting. The gate ran earlier, over commands and exit codes, and
// touches no transcript; delivery already happened against a remote. Neither is made
// untrue by an unreadable file, and defaulting them empty asserts something false
// rather than declining to answer.
function failed({ session, work, sink, error, suite, gate = null, delivery = null, workerCostUsd = null }) {
  return {
    ok: false,
    error,
    gaps: [],
    session: sessionBlock(session, null),
    work: work ?? NO_WORK,
    tokens: { by_model: {}, peak_context: null, active_ms: null, lines: 0, skipped: 0 },
    subagents: [],
    cost: {
      by_model: {},
      // Not $0.00. The run happened and spent money; we failed to read it. A zero
      // here would be plotted as a free run, and every spend threshold downstream
      // would silently stop protecting anything.
      total_usd: null,
      parent_usd: null,
      // CARRIED EVEN HERE, and it is the one number this path can still have. When the
      // transcript cannot be read the CLI's own figure is the only surviving account of what the
      // run cost — so a record that dropped it would report an unmeasurable run while holding
      // the measurement. It does NOT fill `total_usd`: that field means "computed from the price
      // table", and quietly substituting a second source is how a table stops being checked.
      vendor_usd: workerCostUsd,
      price_table_version: null,
      unpriced: [],
      complete: false,
    },
    // The SAME shape as the success path, from the same fallbacks. `pass: null` here now
    // means what it means there — no verdict was supplied — instead of meaning the
    // verdict was thrown away on the way in.
    gate: {
      pass: gate?.pass ?? null,
      findings: gate?.findings ?? [],
      unverified: gate?.unverified ?? [],
      // HOW MANY CRITERIA THE VERDICT GRADED (#13), and why it graded none. A green run with
      // zero criteria is indistinguishable from one that satisfied four unless the record says
      // so, and the record is what outlives the console line. `null` for a caller that supplied
      // no verdict, matching `pass` above: absent is unobserved, not zero.
      graded_criteria: gate?.graded_criteria ?? null,
      ungraded_reason: gate?.ungraded_reason ?? null,
      // WHICH GATE PRODUCED THIS VERDICT (#8). Carried here for the reason the fields above
      // it are: a record that lost its cost figures is the one whose remaining provenance
      // matters most. Never computed here from `lib/gate.mjs` — that would attach a
      // real-looking sha to a run this gate never graded.
      gate_sha: gate?.gate_sha ?? null,
    },
    delivery: {
      commits: delivery?.commits ?? [],
      pushed_to: delivery?.pushed_to ?? null,
      pr_url: delivery?.pr_url ?? null,
    },
    // Carried on the failure path too. A run whose transcript could not be read was
    // still scored against a suite, and a `suite` key that exists on one path and not
    // the other is the one field a reader would have to guard.
    suite: suite ?? null,
    sink: sink ?? null,
  };
}

function sessionBlock(session, collected) {
  const s = session ?? {};
  return {
    id: s.id ?? null,
    run_id: s.run_id ?? null,
    repo: s.repo ?? null,
    branch: s.branch ?? null,
    base: s.base ?? null,
    cwd: s.cwd ?? null,
    // Explicit values win; otherwise the transcript's own stamps. Reading the
    // transcript's stamps is measurement, not guessing, so it records no gap.
    started_at: s.started_at ?? collected?.timestamps?.min ?? null,
    ended_at: s.ended_at ?? collected?.timestamps?.max ?? null,
    wall_ms: s.wall_ms ?? (collected ? wallMs(collected.timestamps) : null),
  };
}

export function buildRecord({
  transcriptPath,
  subagentsDir = null,
  session = {},
  work = null,
  gate = null,
  delivery = null,
  suite = null,
  sink = null,
  // The CLI's own `total_cost_usd`, when a caller has it. An INDEPENDENT second source for the
  // number computed below, carried beside it rather than merged into it — the two agreeing is
  // the only evidence the copied price table is right, and a merge destroys the comparison.
  // Measured on the real run of 2026-07-31: vendor 1.0671731999999998, ours 1.067173.
  workerCostUsd = null,
  // A refusal the CALLER already reached, reported through the same shape as every other
  // failure. `recordForRun` needs this: "no session id in the log" is known before a path can be
  // composed, and inventing one to fail on would be the wrong-session defect.
  error: presetError = null,
} = {}) {
  if (presetError) {
    return failed({ session, work, sink, suite, gate, delivery, workerCostUsd, error: presetError });
  }

  let text;
  try {
    text = readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    // Reported, never thrown. Report failure cannot fail the run being reported on:
    // the same pure-sidecar rule the OTel capture work operates under.
    return failed({
      session,
      work,
      sink,
      suite,
      gate,
      delivery,
      workerCostUsd,
      error: `could not read transcript ${transcriptPath}: ${err?.code ?? err?.message ?? 'unknown'}`,
    });
  }

  const collected = collectFromText(text);
  if (!collected.ok) {
    return failed({
      session,
      work,
      sink,
      suite,
      gate,
      delivery,
      workerCostUsd,
      error: collected.error?.detail ?? 'transcript could not be parsed',
    });
  }

  const gaps = newGaps();

  // Lines the file holds versus lines the collector could parse. The usual cause of a
  // difference is a truncated tail — a transcript being appended to while it is read.
  // Counted here rather than in `tokens.mjs` because it is a property of the file.
  const nonEmpty = text.split('\n').filter((l) => l.trim() !== '').length;
  const skipped = Math.max(0, nonEmpty - collected.lines_parsed);

  if (nullish(session?.id)) {
    noteGap(gaps, 'session-id-absent', 'no session id was supplied to join this record on');
  }

  // THE SUITE STAMP, wired. `lib/suite.mjs` held the checker and nothing called it,
  // which is the unwired-tripwire shape this module's header names.
  //
  // Only a SUPPLIED stamp is checked. `suite: null` means the run was not scored
  // against a rubric — a hand-run session reported by the Stop hook — and that is not
  // a hole, by the same rule an absent subagents directory is not one: if every
  // unscored run carried a permanent gap, the list would stop distinguishing anything.
  // A stamp that IS present and cannot be reproduced is the opposite case and is named.
  if (suite !== null && suite !== undefined) {
    for (const problem of stampProblems({ suite })) {
      noteGap(gaps, 'suite-stamp-invalid', problem);
    }
  }

  const { subagents, unreadable } = readSubagents(subagentsDir);
  if (unreadable) {
    noteGap(
      gaps,
      'subagents-unreadable',
      `subagents directory could not be read (${unreadable}) — subagent spend is missing from this record`,
    );
  }

  // THE TRANSCRIPT-SHAPE TRIPWIRE, wired.
  //
  // The count passed is the number of usable model groups, which is zero exactly when
  // the number of usable usage records is zero — the only condition `usageRefusal`
  // keys on. Note `<synthetic>` with all-zero counts still forms a group and so does
  // NOT trip this: it is a real usage record that legitimately reads zero.
  const usableModelGroups = Object.keys(collected.by_model).length;
  const refusal = usageRefusal({
    lines_parsed: collected.lines_parsed,
    usable_usage_records: usableModelGroups,
  });
  if (refusal.refused) noteGap(gaps, refusal.code, refusal.detail);

  // Cost is whole-run and per-model. The merge is for PRICING ONLY — `tokens.by_model`
  // keeps the parent's own figures untouched, because a parent total that has silently
  // absorbed its subagents is unrecoverable and reads as a much more expensive context.
  const merged = mergeInto(mergeInto({}, collected.by_model), {});
  for (const s of subagents) mergeInto(merged, s.by_model);

  const priced = priceTokens(merged);
  const parentPriced = priceTokens(collected.by_model);

  return {
    ok: true,
    error: null,
    gaps,
    session: sessionBlock(session, collected),
    work: work ?? NO_WORK,
    tokens: {
      by_model: collected.by_model,
      peak_context: collected.peak_context,
      active_ms: collected.active_ms,
      // The record's name for the collector's `lines_parsed`. The schema field name is
      // frozen in §2.5; the collector's is not renamed to chase it.
      lines: collected.lines_parsed,
      skipped,
    },
    subagents,
    cost: {
      by_model: priced.by_model,
      // Null when the tripwire fired: a spend figure computed over a transcript whose
      // shape we no longer recognise is a precise wrong number, which is this
      // project's recurring failure mode.
      total_usd: refusal.refused ? null : priced.total_usd,
      parent_usd: refusal.refused ? null : parentPriced.total_usd,
      // The vendor's own figure, beside ours and never instead of it. See `workerCostUsd`.
      vendor_usd: workerCostUsd,
      price_table_version: priced.price_table_version,
      unpriced: priced.unpriced,
      complete: refusal.refused ? false : priced.complete,
    },
    gate: {
      pass: gate?.pass ?? null,
      findings: gate?.findings ?? [],
      unverified: gate?.unverified ?? [],
      // HOW MANY CRITERIA THE VERDICT GRADED (#13), and why it graded none. A green run with
      // zero criteria is indistinguishable from one that satisfied four unless the record says
      // so, and the record is what outlives the console line. `null` for a caller that supplied
      // no verdict, matching `pass` above: absent is unobserved, not zero.
      graded_criteria: gate?.graded_criteria ?? null,
      ungraded_reason: gate?.ungraded_reason ?? null,
      // WHICH GATE PRODUCED THIS VERDICT (#8). The blob sha of `lib/gate.mjs`, so
      // `gate_pass: true` records the ruler it was measured against instead of leaving the
      // fixed gate and the gate it replaced byte-indistinguishable on disk. `null` for a
      // caller that supplied no verdict, matching `pass` above.
      //
      // ON THIS SECTION, NOT IN `suite`. `lib/gate.mjs` is a declared not_member of the
      // suite digest — the system under test must not version its own ruler — and the
      // precedent for where a not_member's identity lands is `cost.price_table_version`
      // above: on the section it governs.
      gate_sha: gate?.gate_sha ?? null,
    },
    delivery: {
      commits: delivery?.commits ?? [],
      pushed_to: delivery?.pushed_to ?? null,
      pr_url: delivery?.pr_url ?? null,
    },
    // Carried VERBATIM, including when it is the thing that is wrong. Dropping or
    // repairing a bad stamp would destroy the only evidence of what the run claimed,
    // which is what makes a bad stamp diagnosable at all. The gap says not to trust it.
    suite: suite ?? null,
    // Carried as data. This module never resolves it and never writes to it.
    sink: sink ?? null,
  };
}

// Entry point one: the Stop hook. The payload is the whole input.
//
// `subagentsDir` is DERIVED, not searched: Claude Code stores a session's transcript
// at `<project-dir>/<session-id>.jsonl` and its subagents at
// `<project-dir>/<session-id>/subagents/`. That is a fixed formula from two payload
// fields, which is why a hook-driven record needs no discovery — and why pointing the
// payload at a different transcript reads that transcript, with no opportunity to
// wander onto a neighbouring one.
export function recordFromHookPayload(payload = {}, extra = {}) {
  const transcriptPath = payload.transcript_path ?? null;
  const sessionId = payload.session_id ?? null;

  const subagentsDir =
    transcriptPath && sessionId ? join(dirname(transcriptPath), sessionId, 'subagents') : null;

  return buildRecord({
    ...extra,
    transcriptPath,
    subagentsDir: extra.subagentsDir ?? subagentsDir,
    session: { id: sessionId, cwd: payload.cwd ?? null, ...(extra.session ?? {}) },
  });
}

// Entry point three: a worker WE spawned, reporting from the parent.
//
// The hook path above is a session reporting on itself — Claude Code runs the Stop hook inside
// the session and hands over `transcript_path`. A worker Alfred launched is a different process
// and the parent gets no hook, which is why `executeWork` shipped with `report: null` and the
// first real run cost $1.0671732 and left no record. Nothing was undiscoverable; nothing had
// told us, and the CLI had.
//
// STILL NOT A SEARCH. `sessionFromWorkerLog` reads the id the CLI printed and
// `transcriptPathFor` composes one candidate from it. If the file is not there the record says
// so and names the path, which is how a stale vendor convention becomes diagnosable instead of
// becoming a fleet of runs that all cost $0.00.
export function recordForRun({
  workerLog = null,
  cwd = null,
  session = {},
  home = undefined,
  ...extra
} = {}) {
  const found = sessionFromWorkerLog(workerLog);

  if (!found.session_id) {
    // REFUSED BEFORE COMPOSING A PATH. Without an id the formula yields
    // `<project-dir>/undefined.jsonl`, and a stale file left there by an earlier bug would be
    // read as this run's — a confident number for the wrong session, which is the one failure
    // this module's header refuses outright. `buildRecord` is still what answers, so the caller
    // gets the same shape on every path and never branches on which fields exist.
    return buildRecord({
      ...extra,
      transcriptPath: null,
      session: { cwd, ...session },
      workerCostUsd: found.total_cost_usd,
      error: 'the worker log carried no session id, so no transcript could be named',
    });
  }

  const home_ = home === undefined ? {} : { home };
  return buildRecord({
    ...extra,
    transcriptPath: transcriptPathFor({ cwd, sessionId: found.session_id, ...home_ }),
    // Derived the same way the hook path derives it: sibling of the transcript, named for the
    // session. One formula, so a subagent layout change breaks both paths at once rather than
    // leaving one of them quietly reading nothing.
    subagentsDir: join(
      projectDirFor(cwd, home_),
      found.session_id,
      'subagents',
    ),
    session: { id: found.session_id, cwd, ...session },
    workerCostUsd: found.total_cost_usd,
  });
}
