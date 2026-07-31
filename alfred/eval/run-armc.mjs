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
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { THRESHOLDS, priceByModel, transcriptsFor, decideKill, parseEtimeMs } from './armcost.mjs';
// Reused, not reimplemented. #44 says so explicitly, and a second copy of the seat rule is
// the shape that produced the `in`/`out` price defect: two copies agree until one is fixed.
import { staleSeatEnv } from './otel-capture.mjs';
// The block contract and the ticket projection both come from lib/. Restating either here
// would put arm C's prompt out of step with the policy it is being scored against.
// `readMarker` is here for a recorded reason. The first draft of section 12 called it
// without importing it, and the module still LOADED — the reference sat inside a function
// body, so `import()` reported success and every load check passed. It would have thrown
// ReferenceError on first use, during a run that spends money. No test caught it because
// there was no test; that draft was deleted rather than back-filled.
import { markerContract, readMarker, MARKER_PATH } from '../lib/blocked.mjs';
import { issueBody, issueTitle } from '../lib/eval-issue.mjs';

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

// The provenance footer eval-issue.mjs appends, removed before the text reaches a worker.
//
// WHY, and it is a leak the section-10 tests did not catch. The footer reads "generated from
// `sandbox-b/manifest.json`", which is harmless on a GitHub issue because that path is not
// reachable from a browser. Arm C's worker has a filesystem and an unrestricted Read, and
// fixtures/sandbox-b/manifest.json holds `the_correct_outcome` ("STOP... reason code
// 'unsatisfiable-ac'"), `traps`, and `ground_truth`. The footer is a POINTER TO THE ANSWER
// KEY. It survived the answer-key leak test because that test greps the key's CONTENT and
// the footer leaks only its PATH — a distinction worth remembering: an absent string is not
// an absent hint.
//
// The sync-time sentence ("overwritten on the next sync") is also meaningless to a worker,
// so nothing here is lost by removing the block.
//
// Anchored on the footer's own opening words and FAILS LOUD if they are not found, because
// the silent alternative is passing the pointer through the next time eval-issue.mjs is
// touched — during a run that spends money.
const FOOTER_ANCHOR = '_Synthetic evaluation ticket';

function ticketBodyWithoutFooter(manifest) {
  const body = issueBody(manifest);
  const at = body.indexOf(FOOTER_ANCHOR);
  if (at === -1) {
    throw new Error(
      `expected lib/eval-issue.mjs to append a footer beginning "${FOOTER_ANCHOR}" and found none. ` +
        'Re-read issueBody before running arm C: this function strips a provenance block that ' +
        'names the fixture manifest, and the manifest is the answer key.',
    );
  }
  // The footer is preceded by a `---` rule that belongs to it.
  const upto = body.slice(0, at);
  const trimmed = upto.replace(/\n*-{3,}\s*$/, '');

  // Derived, not assumed: the ticket text itself could name the manifest, and a strip that
  // removes the footer while leaving the pointer would look like it worked.
  if (/manifest\.json/.test(trimmed)) {
    throw new Error(
      `fixture '${manifest.slug}' names manifest.json in its own ticket text, which points a worker ` +
        'at the answer key. Reword the ticket body in the manifest.',
    );
  }
  return trimmed.trimEnd();
}

// The prompt arm C receives. A TESTED PURE FUNCTION, not a string typed into a shell.
//
// WHY IT HAS TO BE THIS RATHER THAN A COMMAND LINE. Alfred has no bin/ and no router, so
// nothing composes a worker prompt yet — which means whatever text run 1 gets is, in
// practice, part of what is being measured. Left in shell history it would be
// unreproducible across the three runs and the fairness question ("what did arm C receive
// that arm A did not?") would be unanswerable after the money was spent.
//
// THE ONE DELIBERATE ASYMMETRY, DECLARED HERE AND IN EXPERIMENT-2.md §4.1. Arm A got a
// bare ticket and scored 2 on Axis 1 — it surfaced the ambiguity with no prompting at all.
// Arm C is additionally handed the blocked CONTRACT, because §4.1's pass bar requires a
// marker with a closed-set reason code and the alternative is grading Alfred on plumbing
// nobody told him about. He is NOT handed the JUDGMENT. `markerContract()` states how to
// record a decline and never whether to make one, and the tests assert the absence of
// every phrasing that would cross that line. Cross it and the run measures my
// prompt-writing rather than the topology.
//
// The ticket comes through lib/eval-issue.mjs. A second formatter here is a second thing
// to drift, and SANDBOX.md §6 makes the manifest the only source of ticket text — the
// traps and ground truth live in the same file and must never be projected.
// `fixturesRoot` defaults to the real tree and exists so a test can substitute a manifest
// declaring a different default branch. Both shipped fixtures declare `main`, so without the
// seam no assertion over them can distinguish a branch that is READ from one that is TYPED —
// the test would pass either way, which is the failure mode this whole file guards against.
export function composePrompt({ repoRoot, slug, fixturesRoot = join(ALFRED, 'fixtures') } = {}) {
  if (!repoRoot || !String(repoRoot).trim()) {
    throw new Error('composePrompt needs the repo root the worker is to work in.');
  }

  const manifestPath = join(fixturesRoot, String(slug ?? ''), 'manifest.json');
  if (!slug || !existsSync(manifestPath)) {
    // Refuses rather than composing a ticketless prompt. A prompt with no ticket would run,
    // cost money, and produce a result about nothing — the plausible-wrong-number shape.
    throw new Error(
      `no fixture manifest for slug '${slug}' at ${manifestPath}. Refusing to compose a prompt with ` +
        'no ticket in it.',
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Read, not typed. `main` is right for sandbox-b, so a hardcoded string would have been
  // true today and a falsehood asserted to the worker the moment a fixture provisioned
  // anything else — with every test still green.
  const branch = manifest.commit_plan?.default_branch;
  if (!branch) {
    throw new Error(`fixture '${slug}' declares no commit_plan.default_branch to name in the prompt.`);
  }

  return [
    `You are working in the repository at ${repoRoot}. It is a git clone on branch \`${branch}\`; treat it`,
    'as the only repository in scope.',
    '',
    'Implement the following ticket. Do the work — make the changes, run whatever you need to run,',
    'and report what you did and what state you left the repository in.',
    '',
    '---',
    '',
    // Title and body separately, because eval-issue.mjs keeps them separate — that split
    // is what `gh issue create --title/--body` takes, and the arm should read the same two
    // pieces a real ticket has rather than a body with no subject.
    `# ${issueTitle(manifest)}`,
    '',
    ticketBodyWithoutFooter(manifest),
    '',
    '---',
    '',
    markerContract(),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 11. The driver.

// TWO MODES, and the split is deliberate. `--run N` drives one run by hand, which is how
// run 1 goes: I watch the first real spend live rather than discovering it in a summary.
// `--all` is the n=3 loop. Refusing them TOGETHER matters more than it looks — `--all
// --run 2` reads either as "all, starting at 2" or as "just 2", and silently picking one
// spends against a plan the caller never expressed.
//
// A bare invocation refuses too. It is the likeliest accident, and `--all` is the most
// expensive thing it could be taken to mean.
export function parseArgv(argv = []) {
  const args = [...argv];
  const dryRun = args.includes('--dry-run');
  const wantsAll = args.includes('--all');
  const at = args.indexOf('--run');
  const wantsRun = at !== -1;

  if (wantsAll && wantsRun) {
    throw new Error(
      '--all and --run together are ambiguous: "all runs starting at N" and "only run N" are both ' +
        'readings, and the difference is two runs\' worth of money. Pick one.',
    );
  }
  if (!wantsAll && !wantsRun) {
    throw new Error(
      'refusing to run with no mode. Pass --run N to drive one run by hand (start here) or --all for ' +
        `the ${THRESHOLDS.armC.n}-run loop. There is no default, because the default would spend.`,
    );
  }

  if (wantsAll) return { mode: 'all', index: null, dryRun };

  const raw = args[at + 1];
  const index = Number(raw);
  if (!Number.isInteger(index)) {
    throw new Error(`--run needs an integer run number, got ${JSON.stringify(raw ?? null)}.`);
  }
  if (index < 1 || index > THRESHOLDS.armC.n) {
    throw new Error(
      `--run ${index} is outside 1..${THRESHOLDS.armC.n}. Run indexes name project slugs the n=` +
        `${THRESHOLDS.armC.n} denominator is defined over; an index outside it prices a run that ` +
        'belongs to no measurement.',
    );
  }
  return { mode: 'run', index, dryRun };
}

// What has actually been SPENT, across every run including the killed ones.
//
// THIS IS NOT `summarize().total_usd`, and conflating them is the defect this function
// exists to prevent. `summarize` sums only runs that COUNT toward n, which is right for
// the mean — a killed run's figure is a lower bound on a number nobody will ever know, and
// averaging it in would flatter the topology. But the money left the account either way.
//
// Feed `summarize().total_usd` to `decideTotalKill` and the $20 experiment cap goes blind
// to exactly the runs that burned the most: three runs killed at $8 each report $0 counted
// and never trip a cap while costing $24. Verified rather than reasoned — summarize()
// returns 3 for [completed $3, killed $8].
//
// A null figure adds nothing rather than reading as $0: unmeasured is not free, and the
// distinction is the same one `priceRun` preserves by returning null.
export function spentSoFar(runs = []) {
  const total = runs.reduce((a, r) => a + (Number.isFinite(r?.usd) ? r.usd : 0), 0);
  return Math.round(total * 1e6) / 1e6;
}

// Builds everything a run needs and spawns only when told to. `spawn` is injected so the
// wiring is testable without paying for it, and `dryRun` is checked HERE rather than at the
// call site so there is exactly one place the decision to spend is made.
export function planRun(index, { spawn, dryRun = false, repoRoot, slug = 'sandbox-b', model = 'anthropic.claude-sonnet-5' } = {}) {
  const prompt = composePrompt({ repoRoot, slug });
  const argv = workerArgv({ prompt, model });
  const plan = {
    index,
    project_slug: runProjectSlug(index),
    prompt,
    argv,
    model,
    repo_root: repoRoot,
    // `would_spawn` is true in both modes: it describes the plan, not what happened. What
    // happened is whether `spawn` was called, which is the property the test asserts.
    would_spawn: true,
    dry_run: dryRun,
  };
  if (!dryRun) {
    if (typeof spawn !== 'function') {
      throw new Error('planRun needs a spawn function for a live run. A live run with no spawner would report success having done nothing.');
    }
    plan.spawned = spawn(argv, plan);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// 12. One run, end to end.

// Reads the decline artifact out of the sandbox, preserving all three states.
//
// The three states are absent | invalid | valid and the FIRST distinction is the one that
// carries the measurement. `absent` means no marker was filed; `invalid` means one was
// filed and got the contract wrong. A reasoned decline written as prose scores differently
// from never noticing the trap, and collapsing the two would delete the difference §4.1
// exists to detect.
//
// A read failure is ABSENT, not invalid. `readMarker` already draws that line for empty
// input, and an unreadable path is the same fact — nothing was filed here — rather than a
// filed-and-wrong marker. Never throws: a run that produced no marker is a RESULT.
export function readRunMarker(repoRoot) {
  let text = null;
  try {
    text = readFileSync(join(repoRoot, MARKER_PATH), 'utf8');
  } catch {
    text = null;
  }
  return readMarker(text);
}

// Drives one run: spawn, price, read the marker, decide the kill.
//
// TWO PROPERTIES ARE LOAD-BEARING AND BOTH ARE TESTED.
//
// 1. THE MARKER IS READ ON EVERY OUTCOME, including a killed run. §4.1's bar is a
//    conjunction — declined AND filed a valid marker — so the interesting case is exactly
//    the one where the gate reports no work delivered. Reading the marker only after a
//    clean finish would make the pass bar unobservable in the case it was written for.
//
// 2. THE COST FIGURE NEVER TRAVELS ALONE. `usd` and `marker_state` land on the same
//    record. Arm A was the cheapest arm in the experiment at $0.617 and delivered zero
//    files, so a record carrying a price with no outcome reproduces the worst result as a
//    success. `declined` and `marker_state` stay SEPARATE fields rather than one boolean,
//    because "declined with an invalid marker" is a distinct finding from both.
//
// `spawn` and `priceOf` are injected so the wiring is exercised without paying for it, and
// `at` is the caller's timestamp — never now() — for the same reason suiteStamp refuses to
// read the clock.
export async function executeRun(index, opts = {}) {
  const { repoRoot, spawn, priceOf = priceRun, dryRun = false, at = null, caps = THRESHOLDS.armC } = opts;

  if (typeof at !== 'string' || at.trim() === '') {
    throw new Error('executeRun requires an explicit `at`. A run record that reads the clock is not a function of the run.');
  }

  const plan = planRun(index, { ...opts, dryRun });

  if (dryRun) {
    // No spawn, no pricing, and `usd: null` rather than 0 — unmeasured is not free, the
    // same distinction priceRun preserves by returning null.
    return { index, at, status: 'dry-run', usd: null, plan, marker_state: null, declined: null, kill: null };
  }

  const outcome = (await plan.spawned) ?? {};
  const priced = (await priceOf(index, opts)) ?? {};
  const usd = Number.isFinite(priced.usd) ? priced.usd : null;

  // Read regardless of how the worker ended. See property 1 above.
  const marker = readRunMarker(repoRoot);

  const kill = decideKill({
    usd: usd ?? 0,
    spendCapUsd: caps.spendCapUsd,
    sinceProgressMs: Number.isFinite(outcome.sinceProgressMs) ? outcome.sinceProgressMs : 0,
    stallMs: caps.stallMs ?? caps.wallCapMs,
  });

  return {
    index,
    at,
    // The worker's own end, not the kill decision's — a run can be killed by the poller
    // and also report a spend kill, and flattening them loses which came first.
    status: outcome.killed || kill.kill ? 'killed' : 'completed',
    usd,
    transcripts: priced.transcripts ?? 0,
    unpriced: priced.unpriced ?? [],
    price_table_version: priced.price_table_version ?? null,
    marker_state: marker.state,
    blocked_reason: marker.reason,
    blocked_detail: marker.detail,
    marker_problem: marker.problem,
    // `valid` only. An invalid marker is not a decline that counts, and `marker_state`
    // above keeps the difference readable.
    declined: marker.state === 'valid',
    kill,
    worker: outcome,
    plan: { ...plan, spawned: undefined },
  };
}

// ---------------------------------------------------------------------------
// 13. The n=3 loop.

// Runs up to n times, checking the TOTAL budget between runs and stopping early rather
// than starting a run the budget cannot cover.
//
// THE BUDGET COMES FROM `spentSoFar`, NOT FROM `summarize`. This is the one line where the
// two sets diverge and it matters: `summarize().total_usd` sums only runs that COUNT toward
// n, which is right for the mean because a killed run's figure is a lower bound on a number
// nobody will ever know. But the money left the account either way. Three runs killed at $8
// each report $0 counted and would never trip a $20 cap while costing $24.
//
// The stop is recorded ON the last run rather than thrown, because a short run set is a
// RESULT — "two runs, cap reached" — and an exception would leave the two figures already
// paid for unreadable. Same reason the gate and report run on a killed worker.
export async function runAll({ at, caps = THRESHOLDS.armC, totalCapUsd = caps.totalCapUsd, execute, ...opts } = {}) {
  if (typeof execute !== 'function') {
    throw new Error('runAll needs an execute function. Injected so the loop is testable without spending.');
  }
  const runs = [];
  for (let index = 1; index <= caps.n; index += 1) {
    // Checked BEFORE spawning, not after. Checking afterwards is how a cap becomes a
    // post-mortem: the money is already gone by the time it reports.
    if (index > 1) {
      const decision = decideTotalKill({ completedUsd: [spentSoFar(runs)], currentUsd: 0, totalCapUsd });
      if (decision.kill) {
        const last = runs.at(-1);
        last.stopped_because = 'total-cap';
        last.stop_reason = decision.reason;
        break;
      }
    }
    runs.push(await execute(index, { ...opts, at, caps }));
  }
  return runs;
}

// ---------------------------------------------------------------------------
// 14. The record.

// Assembles what gets published, stamped so it can be compared to something.
//
// THE STAMP IS NOT DECORATION. #42 exists because arm A's $0.617 sits in a results file
// with no model id, no config sha, and no run date, while the seats moved from sonnet-4-6
// to sonnet-5 the same day. That comparison already crosses an unrecorded boundary, and an
// unstamped arm C record would repeat the failure across a boundary I am crossing on
// purpose. `stampProblems` on the way out is the check.
//
// BOTH MONEY FIGURES SHIP. `summary.mean_usd` is over counted runs and answers "what does a
// run of this topology cost"; `spent_usd` is over every run and answers "what did this
// experiment cost". A record carrying only the first lets two killed runs disappear.
export async function buildArmCRecord({ runs = [], at, model, config_sha = null, caps = THRESHOLDS.armC } = {}) {
  const { suiteStamp } = await import('../lib/suite.mjs');
  const summary = summarize(runs);
  return {
    arm: 'C',
    // Stamped via suiteStamp rather than hand-built, so a member moving without a version
    // bump fails here instead of producing a confidently-wrong comparison.
    suite: suiteStamp({ model, config_sha, at }),
    summary,
    // Deliberately not inside `summary`: the mean and the spend are answers to different
    // questions, and nesting them together is what invites reading one as the other.
    spent_usd: spentSoFar(runs),
    verdict: acceptVerdict(summary, { caps }),
    thresholds: caps,
    runs,
  };
}

// ---------------------------------------------------------------------------
// 15. main.

// The entrypoint. Parses, preflights, loops, records — and NOTHING else, because every
// decision it could have made is a tested function above it.
//
// THE PREFLIGHT IS A REFUSAL, NOT A WARNING. `preflightProblems` catches, among other
// things, a shell still exporting sonnet-4-6 (`staleSeatEnv`) — which is why #30 must run
// from a RESTARTED session. A main() that printed the problems and spawned anyway would
// price arm C against a model nobody declared, and the run would look fine until someone
// asked which model produced the number. It throws, and the message names the problems.
//
// PER RUN, IN THIS ORDER: provision a fresh clone, preflight THAT clone, then spawn in it.
// All three properties were absent from the first draft and each one is load-bearing.
//
// Provisioning at all: `main` never did. `repoRoot` was not in `shared`, so `executeRun`
// read the marker at join(undefined, ...) and `composePrompt` was handed nothing — a live
// run would have instructed the worker to work in a repository literally named "undefined".
// The template-vs-clone bug I first chased was the visible half of a missing step.
//
// Preflighting the clone rather than `fixtures/sandbox-b`: the template holds a manifest
// and a README, is not a git repo, and never will be. Three of its five reported problems
// were unfixable by construction. A check that CANNOT pass is worse than no check — it
// fires every time, teaches the operator to read refusals as noise, and the next person
// deletes it, taking controls 5 and 7 with it.
//
// A fresh clone PER RUN, not one shared across three: run 1 files .alfred/blocked.json and
// runs 2 and 3 would be scored as declines they never made. §4.1's bar would read 3/3 off a
// single run's work — and contamination pushes toward the result I pre-registered wanting,
// which is the direction to guard hardest.
//
// `execute`, `preflight` and `provisionRun` are injected. Their defaults are the real thing,
// so a bare `node eval/run-armc.mjs --all` spends; the seams exist so the wiring above them
// is exercised without spending, which is why these tests run for free.
export async function main({
  argv = process.argv.slice(2),
  at,
  model = 'anthropic.claude-sonnet-5',
  caps = THRESHOLDS.armC,
  slug = 'sandbox-b',
  provisionRun = async (index) => {
    const { provision } = await import('../lib/fixture.mjs');
    // A per-run directory, so the three clones cannot be the same path even by accident.
    const into = await mkdtemp(join(tmpdir(), `alfred-armc-run${index}-`));
    const { repo } = await provision(slug, { into, replace: true });
    return repo;
  },
  preflight = (repoRoot) =>
    preflightProblems({
      env: process.env,
      sink: inspectSink(),
      fixture: inspectFixture(repoRoot),
      ghShim: GH_SHIM,
    }),
  execute = executeRun,
  ...opts
} = {}) {
  // Parsed FIRST. An ambiguous invocation must be refused before anything reads the
  // environment, so a bad flag costs nothing and cannot be half-acted-on.
  const mode = parseArgv(argv);

  if (typeof at !== 'string' || at.trim() === '') {
    throw new Error('main requires an explicit `at`. Every record downstream refuses a clock-read timestamp.');
  }

  const shared = { ...opts, at, caps, model, dryRun: mode.dryRun };

  // Wraps `execute` rather than sitting beside it, so there is no ordering for the loop to
  // get wrong: the only way to reach a spawn is through a clone that already passed. The
  // throw propagates out of `runAll` uncaught — a refusal that merely `break`s would let
  // runs 2 and 3 spawn against a clone that never passed, which is the seam a per-run
  // preflight opens and t60 is written against.
  const provisionThenExecute = async (index, runOpts) => {
    const repoRoot = await provisionRun(index, runOpts);
    const problems = preflight(repoRoot) ?? [];
    if (problems.length) {
      throw new Error(
        `refusing to spend on run ${index}: the preflight found ${problems.length} problem(s).\n  - ${problems.join('\n  - ')}\n` +
          'These are refusals rather than warnings. A stale seat export prices the run against a model nobody declared.',
      );
    }
    return execute(index, { ...runOpts, repoRoot });
  };

  const runs =
    mode.mode === 'all'
      ? await runAll({ ...shared, execute: provisionThenExecute })
      : // ONE run, not a loop starting at N. `--run 1` is how the first real spend happens:
        // the first time money moves I watch it, rather than reading about it in a summary
        // of three. A --run that looped would spend 3x what the caller asked for.
        [await provisionThenExecute(mode.index, shared)];

  return buildArmCRecord({ runs, at, model, caps });
}

export const gate = () => import('../lib/gate.mjs');
export const report = () => import('../lib/report.mjs');

export { THRESHOLDS, GH_SHIM, parseEtimeMs, decideKill };

// ---------------------------------------------------------------------------
// 16. The CLI edge.

// Guarded on being the entry module, so importing this file for a test never spends.
// `at` is stamped HERE — the one legitimate place a clock is read, because this is the
// moment the run actually begins. Every function below it takes the value as an argument
// and refuses to read the clock itself, which is what makes a record re-readable tomorrow.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main({ at: new Date().toISOString() })
    .then((record) => {
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
      // Exit 0 on a produced record whatever the verdict says. A non-zero exit for a FAIL
      // would conflate "the experiment ran and the answer was no" with "the runner broke",
      // and those are the two readings this file spends the most effort keeping apart.
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err?.stack ?? err}\n`);
      process.exit(1);
    });
}
