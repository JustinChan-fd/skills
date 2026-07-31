// run-armc — Experiment 2 arm C's runner. EVAL SCAFFOLDING, NOT THE PRODUCT.
//
// THIS IS NOT `bin/alfred` AND MUST NOT BECOME IT.
//
// PLAN.md §2: "There is no second implementation of the trigger." A hand-wired runner
// that quietly becomes the real entrypoint IS that second implementation, and it would
// happen gradually — a lib/ module importing "just one thing" from here, then another.
// The name says `armc` for that reason, and a test asserts nothing in lib/ mentions this
// file. When arm C is scored, this is deleted with the rest of eval/.
//
// What it hand-wires is narrow: M5 owes "flag construction is pure — config in, argv
// out", which for ONE run is a hand-built argv, and M7's loop is irrelevant because this
// runs three times on a fixed fixture rather than patrolling. Everything else already
// exists and is imported: provisioning (lib/fixture.mjs), the gate (lib/gate.mjs), the
// record (lib/report.mjs), pricing and the caps (eval/armcost.mjs).
//
// FIVE PROPERTIES THIS FILE EXISTS TO GET RIGHT, each one a recorded past defect:
//
//   1. n=3 counts three COUNTED runs. A killed run has no cost figure; counting it
//      computes variance over two points while reporting three.
//   2. Two caps, not one. Per-run alone permits 3x the agreed exposure; total alone lets
//      one runaway starve the variance measurement that justified n=3.
//   3. The gate and the report run EVEN WHEN THE WORKER IS KILLED. Skipping them on a
//      kill is how a cap turns into a silent no-result: money spent, nothing readable.
//   4. A cost figure is never published without a delivery outcome. Arm A's $0.617 was
//      the best number in the experiment and bought a design review with zero files.
//   5. The spend denominator is FULL and RECURSIVE, per arm C run. §2.8's watchdog read
//      $1.072 against an $18 cap while the arm had spent $16.03 — 6% of the real figure,
//      so the cap could not have fired at any price.
//
// The decisions are pure functions at the top and the impure shell is at the bottom,
// because a threshold that can only be exercised by burning a real run is a threshold
// nobody ever exercises — which is precisely how §2.8's kill switch shipped green.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { THRESHOLDS, priceByModel, transcriptsFor, decideKill, parseEtimeMs } from './armcost.mjs';
// Reused, not reimplemented. #44 says so explicitly, and a second copy of the seat rule is
// the shape that produced the `in`/`out` price defect: two copies agree until one is fixed.
import { staleSeatEnv } from './otel-capture.mjs';

// ---------------------------------------------------------------------------
// 1. Identity. Each run gets its own project dir, so each is priced separately.

// The arm name `transcriptsFor` matches on. Per-RUN, not per-arm: n=3 exists to measure
// variance BETWEEN runs, and a denominator shared across the three would report a spread
// of zero by construction — the recursive fix pulling against itself.
export const runProjectSlug = (index) => `armC${index}`;

// ---------------------------------------------------------------------------
// 2. What counts toward n.

// A killed run is not a cheap run; it is an ABSENT measurement. It was stopped partway,
// so its spend figure is a lower bound on a number nobody will ever know, and averaging a
// lower bound with two real figures produces a mean that is wrong in a direction that
// flatters the topology.
//
// Delivery outcome does NOT gate counting. Arm A's shape — complete, cheap, zero files —
// is a valid cost measurement paired with a failing delivery outcome, and those are two
// columns. Excluding it would bias cost toward whichever runs happened to produce work.
export function countsTowardN(run = {}) {
  if (run.status !== 'completed') return false;
  // Belt to the status braces. A `completed` record whose pricing threw has no number to
  // average, and letting it through computes a mean over fewer points than the
  // denominator claims — the §2.8 failure shape in miniature.
  return Number.isFinite(run.usd);
}

// ---------------------------------------------------------------------------
// 3. The total cap, checked across runs.

// Takes the completed runs' figures AND the one in flight. The bug this signature
// prevents: recomputing the cap per run sees only the current figure, so three runs at
// $7 each pass a $20 total cap forever while spending $21.
export function decideTotalKill({ completedUsd = [], currentUsd = 0, totalCapUsd } = {}) {
  const prior = completedUsd.filter((n) => Number.isFinite(n)).reduce((a, b) => a + b, 0);
  const cumulativeUsd = Math.round((prior + (Number.isFinite(currentUsd) ? currentUsd : 0)) * 1e6) / 1e6;
  if (cumulativeUsd > totalCapUsd) {
    return {
      kill: true,
      cause: 'total',
      cumulativeUsd,
      // Names the denominator next to the figure. Without it a later reader cannot tell a
      // real overrun from one mis-summed over the wrong set of runs.
      reason:
        `cumulative $${cumulativeUsd.toFixed(2)} across ${completedUsd.length} completed run(s) plus the ` +
        `one in flight exceeded the pre-registered $${totalCapUsd} experiment cap. Killed rather than ` +
        'spending a third run to confirm what two already show.',
    };
  }
  return { kill: false, cause: null, cumulativeUsd, reason: null };
}

// ---------------------------------------------------------------------------
// 4. Summarizing without averaging away the evidence.

// Returns the per-run figures FIRST and the aggregate second, in that order on purpose.
// §2.8's lesson is that a metric without its denominator lies, and a mean is the metric
// most able to hide one: three runs and two runs produce the same-looking number.
export function summarize(runs = []) {
  const counted = runs.filter(countsTowardN);
  const usds = counted.map((r) => r.usd);
  const mean = usds.length ? usds.reduce((a, b) => a + b, 0) / usds.length : null;
  return {
    // Every run, in order, with its own figure and its own delivery outcome. The pair is
    // the unit of evidence; either alone is the arm A non-answer.
    runs: runs.map((r) => ({
      index: r.index,
      status: r.status,
      usd: Number.isFinite(r.usd) ? r.usd : null,
      delivered: r.delivered ?? null,
      gate_pass: r.gate_pass ?? null,
      blocked_reason: r.blocked_reason ?? null,
    })),
    counted: counted.length,
    attempted: runs.length,
    mean_usd: mean === null ? null : Math.round(mean * 1e6) / 1e6,
    spread_usd: usds.length ? Math.round((Math.max(...usds) - Math.min(...usds)) * 1e6) / 1e6 : null,
    killed_indexes: runs.filter((r) => r.status === 'killed').map((r) => r.index),
    // Carried so the acceptance verdict never has to re-derive it, and so a reader of the
    // record alone can check the arithmetic.
    total_usd: Math.round(usds.reduce((a, b) => a + b, 0) * 1e6) / 1e6,
  };
}

// ---------------------------------------------------------------------------
// 5. Acceptance.

// The conjunction from #41: mean <= $4 AND (max - min) <= mean, over THREE counted runs.
//
// THE ASYMMETRY HERE IS NOT THE ONE `denominator-asymmetry` RECORDS, and the difference
// is worth stating because copying that shape would get this wrong.
//
// There, FAILS needed no denominator because more sources cannot repair a disagreement.
// Here, the early rejection is licensed by something else entirely: COST IS NON-NEGATIVE.
// Once the runs so far sum past n x the ceiling, no third figure can bring the mean under
// it, so the set is decidable early. That reasoning is one-directional — an expensive PAIR
// is not decidable, because a cheap third run genuinely can rescue it ($6 + $6 + $0 lands
// the mean at exactly $4). And the SPREAD clause is never decidable early in either
// direction, because a third figure can widen or narrow it.
//
// So: ACCEPTED needs all three. REJECTED needs all three UNLESS the sum has already
// passed n x ceiling. Everything else is INCONCLUSIVE, which is a verdict and not a
// silence.
export function acceptVerdict(s, { caps = THRESHOLDS.armC } = {}) {
  const { n, acceptMeanUsd } = caps;
  const mean_ok = s.mean_usd !== null && s.mean_usd <= acceptMeanUsd;
  const spread_ok = s.mean_usd !== null && s.spread_usd !== null && s.spread_usd <= s.mean_usd;

  if (s.counted < n) {
    // Checked BEFORE the arithmetic-forced rejection below? No — after, deliberately.
    // See the guard immediately following: an incomplete set that has already blown the
    // budget is decided, and reporting it as INCONCLUSIVE would ask for a third run whose
    // result cannot change the answer.
    if (s.total_usd > n * acceptMeanUsd) {
      return {
        status: 'REJECTED',
        mean_ok: false,
        spread_ok,
        counted: s.counted,
        expected: n,
        line:
          `arm C REJECTED after ${s.counted}/${n} runs — $${s.total_usd.toFixed(2)} already spent against a ` +
          `ceiling of ${n} x $${acceptMeanUsd} = $${(n * acceptMeanUsd).toFixed(2)}. Cost is non-negative, so ` +
          'the mean cannot be rescued by the remaining run(s). Decided early rather than paid for.',
      };
    }
    return {
      status: 'INCONCLUSIVE',
      mean_ok,
      spread_ok,
      counted: s.counted,
      expected: n,
      line:
        `arm C INCONCLUSIVE — only ${s.counted}/${n} runs counted (${s.attempted} attempted, killed: ` +
        `${s.killed_indexes.length ? s.killed_indexes.join(', ') : 'none'}). Agreement among ${s.counted} says ` +
        'nothing about the run(s) that did not finish, and the spread clause is what makes n=3 mean anything. ' +
        'Do not read this as a pass.',
    };
  }

  if (mean_ok && spread_ok) {
    return {
      status: 'ACCEPTED',
      mean_ok,
      spread_ok,
      counted: s.counted,
      expected: n,
      line:
        `arm C ACCEPTED — mean $${s.mean_usd.toFixed(2)} <= $${acceptMeanUsd} and spread ` +
        `$${s.spread_usd.toFixed(2)} <= mean, over ${s.counted}/${n} runs. Acceptance is about COST only; ` +
        'the delivery outcomes are a separate column and must be read too.',
    };
  }

  const why = [];
  if (!mean_ok) why.push(`mean $${s.mean_usd?.toFixed(2) ?? '-'} exceeds the $${acceptMeanUsd} ceiling`);
  if (!spread_ok) {
    why.push(
      `spread $${s.spread_usd?.toFixed(2) ?? '-'} exceeds the mean $${s.mean_usd?.toFixed(2) ?? '-'} — the ` +
        'runs disagree by more than the figure they average to, so the mean is not a measurement of anything',
    );
  }
  return {
    status: 'REJECTED',
    mean_ok,
    spread_ok,
    counted: s.counted,
    expected: n,
    line: `arm C REJECTED over ${s.counted}/${n} runs — ${why.join('; ')}.`,
  };
}

// ---------------------------------------------------------------------------
// 6. Phase order. The gate runs on a kill.

// A killed run still wrote files, still has a transcript, and still cost money. Skipping
// the gate because the worker was stopped converts a cap into a silent no-result: the
// most expensive kind of run, one that produced a bill and no reading.
//
// Returned as data rather than expressed as control flow so the ordering is testable
// without a run — the property "gate comes after worker, on both outcomes" is exactly the
// kind of thing that gets reordered during a refactor and noticed a month later.
// It takes `workerOutcome` and IGNORES IT. That is the whole point, and the signature keeps
// it that way: a function that took no argument could not be asked the question, and the
// bug being designed out is a future reader adding `if (killed) return [...]` because
// skipping the gate on a kill looks like an obvious saving.
const PHASES = Object.freeze(['preflight', 'provision', 'worker', 'gate', 'report', 'score']);

export function planPhases({ workerOutcome } = {}) {
  if (workerOutcome !== 'completed' && workerOutcome !== 'killed') {
    throw new Error(`planPhases needs a worker outcome, got ${JSON.stringify(workerOutcome)}`);
  }
  return [...PHASES];
}

// ---------------------------------------------------------------------------
// 7. Preflight. Every refusal names what to fix.

// Refusals rather than warnings, because each of these produces a PLAUSIBLE WRONG NUMBER
// rather than an error — the failure mode where the run appears to succeed.
export function preflightProblems({ env = {}, sink = {}, fixture = {}, ghShim = null } = {}) {
  const problems = [];

  // Reuses staleSeatEnv's rule rather than restating it. A pre-restart shell inherits the
  // old sonnet id from its parent `claude` process (a non-interactive zsh sources no
  // startup file), so the run would silently measure the wrong seat and the model stamp
  // would name a model that never ran.
  for (const p of staleSeatEnv(env)) {
    problems.push(`stale seat env — ${p}. Restart the session; there is no file left to edit.`);
  }

  // Checked BEFORE the count, because `NaN > 0` is false: an unreadable sink would slip
  // through the comparison below as though it were empty. "Could not measure it" must never
  // collapse into "it is fine" — the same absent-vs-empty distinction that diagnosed the
  // seat env, where an ABSENT opus id meant the pre-fix .zshrc had nothing to export.
  if (sink.unreadable || !Number.isFinite(Number(sink.staged))) {
    problems.push(
      'the telemetry sink could not be read, which is not the same as finding it clean. Refusing rather ' +
        "than starting a run whose telemetry writes might absorb someone else's staged work.",
    );
  } else if (Number(sink.staged) > 0) {
    problems.push(
      `the telemetry sink has ${sink.staged} staged change(s). syncRun's \`git add -A -- log\` absorbs ` +
        'unrelated staged work into a telemetry commit. Unstage first.',
    );
  }

  if (fixture.husky) problems.push('.husky/ is present in the sandbox — measure the arm, not the hook.');
  if (fixture.gitignore === false) problems.push('.gitignore is missing from the sandbox (control 5) — its absence produces plausible-looking wrong numbers.');
  if (fixture.packageJson === false) problems.push('package.json is missing from the sandbox (control 5) — `npm test` would fail for the fixture\'s reason, not the arm\'s.');
  if (!fixture.originHead) {
    problems.push(
      'origin/HEAD is unset in the clone (control 7). The implement path resolves it when base_branch is ' +
        'null, and a failure at branch-cut time would be scored as the topology\'s fault rather than the fixture\'s.',
    );
  }

  if (!ghShim) {
    problems.push(
      'the gh shim is absent (control 8). It is not optional: arm C receives a real GITHUB_SLUG because the ' +
        'eval issue lives there, so `gh pr create` is reachable and would put sandbox code on a real repository.',
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------
// 8. The impure shell.

const ALFRED = fileURLToPath(new URL('..', import.meta.url));
const PROJECTS = '/Users/206618626@bwt3.com/.claude/projects';
const GH_SHIM = join(ALFRED, 'eval', 'gh-shim.sh');

// Priced from this run's own transcripts, recursively. Returns null rather than 0 when
// nothing is readable: a 0 reads as "free" and a null reads as "unmeasured", and the
// difference decides whether the run counts toward n.
export async function priceRun(index, { projectsDir = PROJECTS, collect } = {}) {
  const files = transcriptsFor(runProjectSlug(index), { projectsDir });
  if (!files.length) return { usd: null, transcripts: 0, unpriced: [] };
  const collectFromFiles =
    collect ??
    (await import('/Users/206618626@bwt3.com/Desktop/Repos/skills/harness-core/tools/lib/tokens-collect.mjs'))
      .collectFromFiles;
  const r = await collectFromFiles(files);
  const p = priceByModel(r.by_model);
  return { usd: p.total_usd, transcripts: files.length, unpriced: p.unpriced, price_table_version: p.price_table_version };
}

// Reads the sandbox's own state for the control checks, rather than asserting they hold.
export function inspectFixture(repoRoot) {
  const originHead = (() => {
    try {
      return execFileSync('git', ['-C', repoRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
        encoding: 'utf8',
      }).trim() || null;
    } catch {
      return null;
    }
  })();
  return {
    husky: existsSync(join(repoRoot, '.husky')),
    gitignore: existsSync(join(repoRoot, '.gitignore')),
    packageJson: existsSync(join(repoRoot, 'package.json')),
    originHead,
  };
}

export function inspectSink(sinkDir = '/Users/206618626@bwt3.com/.harness/telemetry') {
  try {
    const out = execFileSync('git', ['-C', sinkDir, 'diff', '--cached', '--name-only'], {
      encoding: 'utf8',
    });
    return { staged: out.split('\n').filter((l) => l.trim() !== '').length };
  } catch {
    // Unreadable is not clean. Reported as a problem via a sentinel the preflight refuses.
    return { staged: Number.NaN, unreadable: true };
  }
}

// The hand-built argv M5 would otherwise construct. One place, so the flags a run used are
// recoverable from the record rather than from shell history.
export function workerArgv({ prompt, model, maxTurns = null } = {}) {
  const argv = [
    '-p',
    prompt,
    '--model',
    model,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'json',
  ];
  if (maxTurns) argv.push('--max-turns', String(maxTurns));
  return argv;
}

export const gate = () => import('../lib/gate.mjs');
export const report = () => import('../lib/report.mjs');

export { THRESHOLDS, GH_SHIM, parseEtimeMs, decideKill };
