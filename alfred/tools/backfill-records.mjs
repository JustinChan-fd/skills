#!/usr/bin/env node
//
// BACKFILL: re-derive the historical records THROUGH `recordForRun`, then sync them.
//
// WHY A SCRIPT AND NOT AN EDITOR. Every one of these five runs already has a `record.json` on
// disk, and the field they lack — `provenance` — is four keys. Hand-adding it would have taken
// minutes. It is refused for one reason: a hand-written record is a record no code produced,
// and the sink's whole claim is that a figure in it was computed by the pricer from a
// transcript. Patch one field by hand and every OTHER field in that file becomes unverified
// too, because nothing distinguishes the key someone typed from the keys the code wrote.
// So the transcripts are re-read and the records re-derived. The numbers either reproduce or
// they do not, and either answer is worth having.
//
// WHY `backfilled: true` IS NOT COSMETIC. These records describe runs performed by code that
// is not today's code. `provenance.arm` says which arm ran; `backfilled` says the record was
// assembled after the fact by this script rather than by the run itself. An analysis that
// cannot tell those apart will eventually compare a live figure against a reconstructed one
// and call the difference a result.
//
// ARM ASSIGNMENT IS EVIDENCE-BASED, NOT ASSUMED. All five are `alfred-thin`, established four
// ways rather than by looking at the dates:
//   - every transcript's first user turn is Alfred's own composed prompt ("You are working in
//     the repository at ... Treat it as the only repository in scope. The work item is ...")
//   - `git log -- lib/run.mjs` shows a single-session spawn from its FIRST commit
//     (8f271f9, 2026-07-31). There is no phase-orchestration code anywhere in its history,
//     so no run recorded here could have been produced by the multi-agent arm.
//   - `"name":"Task"` appears zero times in all five transcripts: no run spawned a subagent
//     through the Task tool, which is what the multi-agent arm did.
//   - the `scan`/`reason` seat disclosure landed 2026-08-01T2014Z (068c3ac), and the two runs
//     BEFORE that timestamp mention no seats while the three after mention both. The arm is
//     the same across all five; that boundary is a prompt change within one arm, and saying so
//     here stops a later reader from reading it as two cohorts.
//
// NOT `single-agent`, THE CONTROL, EITHER — and this is the distinction most worth stating,
// because a mislabel here would corrupt the exact comparison the sink exists to answer. The
// control arm is a bare `claude -p` with no harness. These five all ran under Alfred's
// composed prompt, off_limits, and gate. The jarvis#7 single-agent control is a DIFFERENT
// session, has no `record.json`, and is deliberately out of scope here (it needs a separate
// extraction path: a bare 1.5MB .jsonl with no result line and no `total_cost_usd`).
//
// FIVE, NOT FOUR. The plan said four. A `record.json` inventory found five, and the fifth
// (skills#21) is as real as the others. Backfilling four of five would have left a hole
// nobody would later notice, so the count is corrected here rather than obeyed.
//
// SEVEN NOW, and the two added are NOT historical. Phase D's own live runs
// (20260803T141200Z-7, 20260803T141349Z-...TARS-1351) are appended because 96cb211 landed
// AFTER they finished, so records written by the live path were already missing
// `cost.vendor_by_model` within hours of being written. That is the general case, not an
// accident of tonight: any record predating a reader change is stale in exactly the fields
// that change added, and re-deriving is the only way to make the sink homogeneous enough to
// aggregate. `backfilled: true` on those two is therefore doing real work — they were live
// runs whose COST FIELDS are reconstructions, and an analysis that treats a rebuilt figure as
// a live one is the failure this flag exists to prevent.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { recordForRun } from '../lib/report.mjs';
import { syncRecord } from '../lib/telemetry.mjs';
import { ARM_IDS } from '../lib/gaps.mjs';

const RUNS_ROOT = process.env.ALFRED_RUNS_ROOT ?? `${process.env.HOME}/Desktop/Repos/.alfred-runs`;
const SINK_DIR = process.env.ALFRED_SINK_DIR ?? `${process.env.HOME}/Desktop/Repos/alfred-telemetry`;
const DRY_RUN = process.argv.includes('--dry-run');

// THE `cwd` EACH WORKER REALLY RAN IN, which is what `transcriptPathFor` needs and is NOT
// recoverable from the run directory name. Taken from each transcript's own first user turn
// (the prompt states the repo path) and cross-checked against the ~/.claude/projects directory
// the transcript actually sits in — two sources, because a wrong cwd here composes a path to
// some OTHER session's transcript and would produce a confident number for the wrong run.
//
// `20260802T142320Z-7` is the awkward one: its prompt says `.` because it was launched from
// inside the worktree, and its transcript lives under `-jarvis-issue7-alfred`. The literal
// path is used, not the `.`.
const RUNS = [
  {
    dir: '20260801T065609Z-21',
    cwd: `${process.env.HOME}/Desktop/Repos/skills`,
    repo: 'skills',
    notes:
      'Backfilled 2026-08-03. First Alfred run to leave a record at all. Arm established by ' +
      'prompt shape + lib/run.mjs history (single-session from its first commit) + zero Task-tool ' +
      'calls. Predates the scan/reason seat disclosure (068c3ac, 2026-08-01T2014Z), so its prompt ' +
      'names no seats — a prompt difference within this arm, not a different arm.',
  },
  {
    dir: '20260801T221431Z-https-fandango.atlassian.net-browse-TARS-1351',
    cwd: `${process.env.HOME}/Desktop/Repos/webtarsthree`,
    repo: 'webtarsthree',
    notes:
      'Backfilled 2026-08-03. THE PASS:TRUE TARS-1351 RUN, and the one an analysis is most ' +
      'likely to reach for — so its caveats are stated here rather than left to be rediscovered. ' +
      'THREE TARS-1351 runs have records; this is the earliest and the only one graded pass:true. ' +
      'The other two are 20260802T033853Z-...browse-TARS-1351 (pass:false) and ' +
      '20260802T082954Z-TARS-1351 (pass:false). Its worker log reports is_error:true DESPITE the ' +
      'pass, which is unreconciled and should be treated as a reason to distrust the pass rather ' +
      'than as noise. Predates the seat disclosure, so the prompt names no seats.',
  },
  {
    dir: '20260802T033853Z-https-fandango.atlassian.net-browse-TARS-1351',
    cwd: `${process.env.HOME}/Desktop/Repos/webtarsthree`,
    repo: 'webtarsthree',
    notes:
      'Backfilled 2026-08-03. Second of three TARS-1351 runs with records; pass:false. Same ' +
      'ticket and same repo as 20260801T221431Z, which passed — the pair is the useful comparison ' +
      'and neither should be aggregated as if it were the only attempt.',
  },
  {
    dir: '20260802T082954Z-TARS-1351',
    cwd: `${process.env.HOME}/Desktop/Repos/webtarsthree-tars1351-clean`,
    repo: 'webtarsthree',
    notes:
      'Backfilled 2026-08-03. Third of three TARS-1351 runs; pass:false. TWO THINGS MAKE THIS ONE ' +
      'NON-COMPARABLE ON COST, both stated because neither is visible in the figures. (1) It ran ' +
      'under `--max-budget-usd`, so its $4.28 is a CEILING-CONSTRAINED figure, not what the work ' +
      'cost — and per the measured behaviour of that flag the cap is enforced POST-TURN, so the ' +
      'run may have exceeded it before stopping. (2) It ran in the ...-tars1351-clean worktree, ' +
      'not the main checkout, so its starting tree differed from the other two. It is also the ' +
      'only one of the five with a non-empty `subagents` array (a `scan` seat).',
  },
  {
    dir: '20260802T142320Z-7',
    cwd: `${process.env.HOME}/Desktop/Repos/jarvis-issue7-alfred`,
    repo: 'jarvis',
    notes:
      'Backfilled 2026-08-03. The Alfred side of the jarvis#7 A/B; pass:false on evidence_weakened, ' +
      'which was later established to be a FALSE POSITIVE on a legitimate test refactor (5->9 ' +
      'tests, 6->12 assertions) and fixed in A3. The gate verdict on this record is therefore ' +
      'known-wrong and must not be counted as a failure. Its single-agent counterpart is a ' +
      'different session with no record.json and is NOT backfilled here. Its cost.total_usd ' +
      '($5.69) and vendor_usd ($6.04) disagree by ~6%, the only such disagreement among the five. ' +
      'AMENDED 2026-08-03 later the same day: that ~6% is no longer unexplained. The result line ' +
      'carries two token ledgers and Alfred was summing the smaller `usage` field rather than ' +
      '`modelUsage`; see 96cb211. This record now carries a `cost-source-disagreement` gap and a ' +
      '`cost.vendor_by_model` block, and it is the ONLY one of the five that does — which is the ' +
      'evidence the tripwire discriminates rather than just fires.',
  },
  // TONIGHT'S TWO LIVE RUNS, appended after the fix so the whole sink carries the same fields.
  // Rebuilt for the same reason as the five above and no other: their transcripts are immutable,
  // so cost and tokens re-derive exactly, while gate/delivery/work are carried forward verbatim
  // (a verdict is a judgment made against a working tree that no longer exists).
  {
    dir: '20260803T141200Z-7',
    cwd: `${process.env.HOME}/Desktop/Repos/jarvis`,
    repo: 'jarvis',
    notes:
      'Live run 2026-08-03, Phase D. KILLED AT THE 25-MINUTE WALL CAP after 1500264ms, so its ' +
      'gate FAIL must not be read as a judgment on the work: two of the eight findings are ' +
      '`check_failed` naming the kill itself, and the CLI reported `aborted_streaming` at 102 ' +
      'turns. The six `ac_unmapped` findings are real but expected of an unfinished run — the ' +
      'worker never reached the point of writing an ac_map. It committed locally to ' +
      'alfred/justinchan-fd-jarvis-7-20260803t141200z-7 and pushed nothing, because the gate did ' +
      'not pass. THE RUN THAT EXPOSED THE COST DEFECT: ours $6.030214 against vendor $6.352075, ' +
      'a 5.34% gap, and the second of the two records that carry it. Rebuilt after 96cb211 so it ' +
      'carries `cost.vendor_by_model` and the named gap. Its predecessor 20260802T142320Z-7 is ' +
      'the same ticket in a worktree; the two are not independent samples.',
  },
  {
    dir: '20260803T141349Z-https-fandango.atlassian.net-browse-TARS-1351',
    cwd: `${process.env.HOME}/Desktop/Repos/webtarsthree`,
    repo: 'webtarsthree',
    notes:
      'Live run 2026-08-03, Phase D. PASS with 6 graded criteria, 0 findings, $0.825523 against ' +
      'vendor $0.8255230000000001 — agreement to 6dp, and the fourth TARS-1351 run. `commits: []` ' +
      'is CORRECT and is the interesting part: the worker rejected the ticket\'s premise, finding ' +
      'docs/modules/placements.md already carried every required section from 72dfa6df, verified ' +
      'all six ACs against the existing file, and changed nothing. Ticket-skepticism working as ' +
      'designed, not a failure to deliver. It is therefore a WEAK delivery test — it exercised ' +
      'commit-nothing and push-nothing, never the push path. This run is also the reason the ' +
      'delivery.error/steps fix (3aba45b) exists: a correct no-op and a delivery that blew up ' +
      'before committing were byte-identical on disk before it.',
  },
];

// Same tolerance as `run.mjs`'s: an unreadable log is a record that says so, not a crash.
function readLogText(logPath) {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
}

const results = [];

for (const run of RUNS) {
  const runDir = join(RUNS_ROOT, run.dir);
  const oldPath = join(runDir, 'record.json');
  if (!existsSync(oldPath)) {
    results.push({ dir: run.dir, status: 'SKIP', why: 'no record.json' });
    continue;
  }

  const before = JSON.parse(readFileSync(oldPath, 'utf8'));

  // THE SAME CALL A LIVE RUN MAKES. `workerLog` is the log on disk, `session.id` is the id the
  // old record recorded, `cwd` is where the worker really ran. Everything downstream — the
  // transcript path, the token counts, the price — is recomputed from those, which is the point.
  // `workerLog` IS THE LOG'S TEXT, NOT ITS PATH — and this cost a dry run to find. Handing it
  // the path parses as nothing, so `sessionFromWorkerLog` returned no `total_cost_usd` and all
  // five records rebuilt with `vendor_usd: null`. The tokens and our own price still reproduced
  // exactly, which is what made it dangerous: the run LOOKED clean, and the field that went
  // missing is the INDEPENDENT second source. Losing it silently converts a two-source
  // agreement check into a one-source assertion, which is `feedback_denominator_asymmetry`
  // exactly. `run.mjs:1117` reads the file first; so does this.
  const rebuilt = recordForRun({
    workerLog: readLogText(join(runDir, 'worker.log')),
    cwd: run.cwd,
    session: {
      id: before.session?.id,
      run_id: before.session?.run_id,
      repo: run.repo,
      branch: before.session?.branch ?? null,
      base: before.session?.base ?? null,
      started_at: before.session?.started_at ?? null,
      ended_at: before.session?.ended_at ?? null,
      wall_ms: before.session?.wall_ms ?? null,
    },
    // CARRIED FORWARD, NOT RECOMPUTED — and the distinction matters. The gate's verdict is a
    // judgment made against a working tree that no longer exists; re-deriving it today would
    // grade a different tree and silently replace what actually happened. Cost and tokens ARE
    // recomputed, because the transcript they read is immutable.
    work: before.work,
    gate: before.gate,
    delivery: before.delivery,
    suite: before.suite,
    provenance: { arm: ARM_IDS.THIN, backfilled: true, notes: run.notes },
  });

  // DID THE MONEY REPRODUCE? The one question this script can answer that a hand-edit could
  // not. A mismatch is not necessarily a bug — the pricer has been corrected since some of
  // these ran — but it must be VISIBLE rather than overwritten in place.
  const oldUsd = before.cost?.total_usd ?? null;
  const newUsd = rebuilt.cost?.total_usd ?? null;
  const drift = oldUsd !== null && newUsd !== null ? newUsd - oldUsd : null;

  results.push({
    dir: run.dir,
    status: rebuilt.ok ? 'OK' : 'RECORD_ERROR',
    error: rebuilt.error ?? null,
    old_usd: oldUsd,
    new_usd: newUsd,
    drift,
    vendor_usd: rebuilt.cost?.vendor_usd ?? null,
    arm: rebuilt.provenance?.arm ?? null,
    backfilled: rebuilt.provenance?.backfilled ?? null,
    gaps: (rebuilt.gaps ?? []).map((g) => g.code ?? g),
    pass: rebuilt.gate?.pass ?? null,
  });

  if (!DRY_RUN) {
    // The original is kept. A backfill that destroys the thing it was derived from leaves no
    // way to check the derivation, and these files are the only copy of what the run reported.
    if (!existsSync(`${oldPath}.pre-backfill`)) {
      writeFileSync(`${oldPath}.pre-backfill`, readFileSync(oldPath));
    }
    writeFileSync(oldPath, `${JSON.stringify(rebuilt, null, 2)}\n`);

    const sync = syncRecord({
      runDir,
      telemetry: { dir: SINK_DIR, repo_slug: run.repo },
      record: rebuilt,
    });
    results.at(-1).synced = sync.synced === true ? sync.path ?? true : `NO: ${sync.reason}`;
  }
}

console.log(DRY_RUN ? '=== DRY RUN, nothing written ===' : '=== BACKFILL APPLIED ===');
for (const r of results) {
  console.log(`\n${r.dir}`);
  console.log(`  status=${r.status}${r.error ? ` error=${r.error}` : ''}`);
  console.log(`  usd: was=${r.old_usd} now=${r.new_usd} drift=${r.drift} vendor=${r.vendor_usd}`);
  console.log(`  arm=${r.arm} backfilled=${r.backfilled} pass=${r.pass}`);
  console.log(`  gaps=${JSON.stringify(r.gaps)}`);
  if (r.synced !== undefined) console.log(`  synced=${r.synced}`);
}
console.log(`\n${results.filter((r) => r.status === 'OK').length}/${results.length} rebuilt cleanly`);
