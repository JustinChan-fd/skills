// run-armc — the arm C runner's decisions, tested without spending a cent.
//
// Every judgement this file covers is a PURE function on purpose. The runner's impure
// half (provision, spawn, poll) is a thin shell around these, because a threshold that
// can only be exercised by burning a real run is a threshold nobody ever exercises —
// §2.8's kill switch shipped green and blind for exactly that reason.
//
// Four propositions, kept separate so a failure names which one broke:
//
//   1. n=3 means THREE COUNTED runs. A killed run has no cost figure, so counting it
//      computes variance over two points while reporting three.
//   2. The two caps are different numbers. Per-run alone permits 3x the agreed
//      exposure; total alone lets one runaway starve the variance measurement that
//      justified n=3 in the first place.
//   3. Acceptance needs the full denominator; rejection sometimes does not — and the
//      asymmetry here is NOT the one [[denominator-asymmetry]] records. That one came
//      from "more sources cannot repair a disagreement". This one comes from "cost is
//      non-negative", which makes a sum-based rejection decidable early and a
//      spread-based one not. Copying the shape without re-deriving it would have got
//      the second half wrong (tests 13 and 14 are the pair that pins this).
//   4. A cost figure is never reported without a delivery outcome. Arm A's $0.617 read
//      as the best number in the experiment and bought zero files.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { THRESHOLDS, transcriptsFor } from '../eval/armcost.mjs';
import {
  countsTowardN,
  decideTotalKill,
  summarize,
  acceptVerdict,
  planPhases,
  preflightProblems,
  runProjectSlug,
} from '../eval/run-armc.mjs';

// --- 1. the thresholds, pre-registered ---

test('arm C thresholds are pre-registered in code: n=3, $8 per run, $20 across all three, 25 minutes', () => {
  const c = THRESHOLDS.armC;
  assert.equal(c.n, 3);
  assert.equal(c.spendCapUsd, 8);
  assert.equal(c.totalCapUsd, 20);
  assert.equal(c.wallCapMs, 25 * 60 * 1000);
  assert.equal(c.acceptMeanUsd, 4);
});

test('the per-run kill cap is looser than the acceptance ceiling, because a kill is not a verdict', () => {
  // The gap is deliberate and was the one thing most likely to be "tidied" into a
  // single number. A kill cap must be loose enough never to abort a healthy run; an
  // acceptance ceiling can sit much lower, because failing acceptance costs nothing but
  // a conclusion. Equal values would mean every run that fails acceptance is killed
  // before it can produce the delivery outcome that makes its cost figure mean anything.
  assert.ok(
    THRESHOLDS.armC.spendCapUsd > THRESHOLDS.armC.acceptMeanUsd,
    'the kill cap must exceed the acceptance ceiling, or acceptance can never be measured on a failing run',
  );
});

test('the total cap is below n times the per-run cap, or it permits nothing', () => {
  const c = THRESHOLDS.armC;
  assert.ok(
    c.totalCapUsd < c.n * c.spendCapUsd,
    `a $${c.totalCapUsd} total against ${c.n} x $${c.spendCapUsd} would never bind — the per-run cap would always fire first`,
  );
});

// --- 2. the total cap counts across runs ---

test('the total cap counts cumulative spend across completed runs, not the current run alone', () => {
  // $7 spent over two finished runs, $7 in flight. No single figure is near $8, and the
  // experiment has spent $14 of a $20 budget. Recomputing per run sees only 7.
  const d = decideTotalKill({ completedUsd: [4, 3], currentUsd: 7, totalCapUsd: 20 });
  assert.equal(d.kill, false);
  assert.equal(d.cumulativeUsd, 14);
});

test('the total cap fires on the sum even when no single run is near its own cap', () => {
  const d = decideTotalKill({ completedUsd: [7, 7], currentUsd: 7, totalCapUsd: 20 });
  assert.equal(d.kill, true);
  assert.equal(d.cause, 'total');
  assert.equal(d.cumulativeUsd, 21);
  assert.match(d.reason, /\$21\.00/);
  // Names the denominator, so a later reader can tell a real overrun from a mis-summed one.
  assert.match(d.reason, /across 2 completed run\(s\) plus the one in flight/);
});

// --- 3. a killed run does not count toward n ---

test('a killed run does not count toward n', () => {
  assert.equal(countsTowardN({ status: 'killed', usd: 6.2 }), false);
});

test('a run that completed counts toward n even when it delivered nothing', () => {
  // Arm A's shape: cheap, complete, zero files. It is a valid cost measurement and a
  // failing delivery outcome, and those are two different columns. Excluding it would
  // bias the cost figure toward whichever runs happened to produce work.
  assert.equal(countsTowardN({ status: 'completed', usd: 0.617, delivered: false }), true);
});

test('a run with no cost figure cannot count, whatever its status says', () => {
  // Belt to the status braces: a `completed` record whose pricing threw has no number
  // to average, and letting it through would compute a mean over fewer points than the
  // denominator claims.
  assert.equal(countsTowardN({ status: 'completed', usd: null }), false);
  assert.equal(countsTowardN({ status: 'completed' }), false);
});

// --- 4. per-run records stay separate ---

test('per-run figures are kept separate, and the summary never replaces them with their mean', () => {
  const runs = [
    { index: 1, status: 'completed', usd: 1, delivered: true },
    { index: 2, status: 'completed', usd: 2, delivered: true },
    { index: 3, status: 'completed', usd: 9, delivered: false },
  ];
  const s = summarize(runs);
  assert.deepEqual(
    s.runs.map((r) => r.usd),
    [1, 2, 9],
    'the individual figures must survive summarization',
  );
  assert.deepEqual(
    s.runs.map((r) => r.delivered),
    [true, true, false],
    'and so must each run’s delivery outcome, or the cost figures lose their meaning',
  );
});

test('mean and spread are computed over counted runs only, and the denominator travels with them', () => {
  const runs = [
    { index: 1, status: 'completed', usd: 2, delivered: true },
    { index: 2, status: 'killed', usd: 8.5, delivered: false },
    { index: 3, status: 'completed', usd: 4, delivered: true },
  ];
  const s = summarize(runs);
  assert.equal(s.counted, 2);
  assert.equal(s.attempted, 3);
  assert.equal(s.mean_usd, 3); // (2 + 4) / 2 — the killed 8.5 is excluded
  assert.equal(s.spread_usd, 2);
  assert.deepEqual(s.killed_indexes, [2]);
});

// --- 5. acceptance and rejection ---

test('acceptance needs all three runs; two agreeing runs are not a pass', () => {
  const v = acceptVerdict(
    summarize([
      { index: 1, status: 'completed', usd: 1, delivered: true },
      { index: 2, status: 'completed', usd: 1, delivered: true },
    ]),
  );
  assert.equal(v.status, 'INCONCLUSIVE');
  assert.match(v.line, /2\/3/);
});

test('a run set is rejected when the spread exceeds the mean, even though the mean passes', () => {
  // $1, $2, $9 averages to $4 and "passes" while the spread is larger than the signal.
  // This clause is what makes n=3 mean anything at all.
  const v = acceptVerdict(
    summarize([
      { index: 1, status: 'completed', usd: 1, delivered: true },
      { index: 2, status: 'completed', usd: 2, delivered: true },
      { index: 3, status: 'completed', usd: 9, delivered: true },
    ]),
  );
  assert.equal(v.status, 'REJECTED');
  assert.match(v.line, /spread/);
});

test('rejection IS decidable early, when the sum already forces the mean over the ceiling', () => {
  // Two runs at $7 sum to $14. The ceiling is a mean of $4 over n=3, so the whole set
  // cannot come in under $12 no matter what the third run costs — cost is non-negative.
  // Waiting to spend a third run to confirm arithmetic is waste.
  const v = acceptVerdict(
    summarize([
      { index: 1, status: 'completed', usd: 7, delivered: true },
      { index: 2, status: 'completed', usd: 7, delivered: true },
    ]),
  );
  assert.equal(v.status, 'REJECTED');
  assert.match(v.line, /cannot be rescued/);
});

test('and NOT decidable the other way: a cheap third run can still rescue an expensive pair', () => {
  // $6 + $6 = $12, mean-so-far $6. A third run at $0 lands the mean at exactly $4,
  // which passes. So this must stay INCONCLUSIVE — the early rejection above is sound
  // only because the sum has passed n x ceiling, not merely because the mean-so-far has.
  const v = acceptVerdict(
    summarize([
      { index: 1, status: 'completed', usd: 6, delivered: true },
      { index: 2, status: 'completed', usd: 6, delivered: true },
    ]),
  );
  assert.equal(v.status, 'INCONCLUSIVE');
});

test('acceptance is a conjunction, and passes only when both clauses hold on three runs', () => {
  const v = acceptVerdict(
    summarize([
      { index: 1, status: 'completed', usd: 3, delivered: true },
      { index: 2, status: 'completed', usd: 3.5, delivered: true },
      { index: 3, status: 'completed', usd: 4, delivered: true },
    ]),
  );
  assert.equal(v.status, 'ACCEPTED');
  assert.equal(v.mean_ok, true);
  assert.equal(v.spread_ok, true);
});

// --- 6. the gate runs even on a kill ---

test('the gate and report run even when the worker was killed', () => {
  const phases = planPhases({ workerOutcome: 'killed' });
  assert.ok(phases.includes('gate'), 'a killed run still has artifacts worth reading');
  assert.ok(phases.includes('report'));
});

test('a cost figure is never reported without a delivery outcome', () => {
  // Both outcomes, one rule. Skipping the gate on a kill is how a cap turns into a
  // silent no-result: the run cost money and produced no readable verdict.
  for (const workerOutcome of ['completed', 'killed']) {
    const phases = planPhases({ workerOutcome });
    assert.ok(
      phases.indexOf('gate') > phases.indexOf('worker'),
      `${workerOutcome}: the gate must run after the worker`,
    );
    assert.ok(phases.includes('report'), `${workerOutcome}: no cost figure without a record`);
  }
});

// --- 7. preflight refusals ---

test('refuses to start from a session that predates the .zshrc seat fix', () => {
  const problems = preflightProblems({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic.claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic.claude-opus-5',
    },
    sink: { staged: 0 },
    fixture: { husky: false, gitignore: true, packageJson: true, originHead: 'refs/remotes/origin/main' },
    ghShim: '/x/gh-shim.sh',
  });
  assert.ok(
    problems.some((p) => p.includes('ANTHROPIC_DEFAULT_SONNET_MODEL')),
    `expected a stale-seat refusal, got ${JSON.stringify(problems)}`,
  );
});

test('refuses to start when the telemetry sink has staged changes', () => {
  const problems = preflightProblems({ ...ok(), sink: { staged: 3 } });
  assert.ok(problems.some((p) => /staged/.test(p)), JSON.stringify(problems));
});

test('an UNREADABLE sink is refused, not treated as clean', () => {
  // `inspectSink` reports NaN when the git read fails, and `NaN > 0` is false — so the
  // obvious comparison lets an unreadable sink through as if it were empty. Same shape as
  // the absent-vs-empty distinction in the seat env: "I could not measure it" must never
  // collapse into "it is fine".
  const problems = preflightProblems({ ...ok(), sink: { staged: Number.NaN, unreadable: true } });
  assert.ok(problems.some((p) => /could not be read|unreadable/i.test(p)), JSON.stringify(problems));
});

test('refuses when a fixture control is missing, and names which one', () => {
  // Each control separately, because a single "fixture not ready" would not tell the
  // operator what to fix — and three of these produce plausible-looking wrong numbers
  // rather than an error.
  const cases = [
    [{ husky: true }, /husky/],
    [{ gitignore: false }, /gitignore/],
    [{ packageJson: false }, /package\.json/],
    [{ originHead: null }, /origin\/HEAD/],
  ];
  for (const [override, pattern] of cases) {
    const base = ok();
    const problems = preflightProblems({ ...base, fixture: { ...base.fixture, ...override } });
    assert.ok(
      problems.some((p) => pattern.test(p)),
      `${JSON.stringify(override)} should be refused by name, got ${JSON.stringify(problems)}`,
    );
  }
});

test('the gh shim is not optional', () => {
  const problems = preflightProblems({ ...ok(), ghShim: null });
  assert.ok(problems.some((p) => /shim/.test(p)), JSON.stringify(problems));
});

test('a clean preflight returns no problems, so the refusals above are not vacuous', () => {
  // Without this, every refusal test would pass against a function that refuses
  // everything — the guard would be unfalsifiable in the direction that matters.
  assert.deepEqual(preflightProblems(ok()), []);
});

function ok() {
  return {
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic.claude-sonnet-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic.claude-opus-5',
    },
    sink: { staged: 0 },
    fixture: { husky: false, gitignore: true, packageJson: true, originHead: 'refs/remotes/origin/main' },
    ghShim: '/x/gh-shim.sh',
  };
}

// --- 8. each run is priced from its own transcripts ---

test('each arm C run is priced from its own dir, so run 2 never absorbs run 1’s spend', async () => {
  // The recursive denominator fix (§2.8) pulls against this: recursing far enough to see
  // subagent spend must not recurse so far that the three runs merge into one figure.
  // n=3 exists to measure variance BETWEEN runs, and a shared denominator would report
  // a spread of zero by construction.
  // Each run's slug must be DISTINCT, asserted against literals rather than against
  // `runProjectSlug` itself. Deriving both the fixture and the query from one function
  // makes the test blind: collapsing the slug to a constant would leave every assertion
  // below satisfied by one shared directory. Watched to pass against a collapsed slug
  // before this was added.
  assert.deepEqual(
    [1, 2, 3].map(runProjectSlug),
    ['armC1', 'armC2', 'armC3'],
    'the three runs must not share a project slug, or their spend figures merge',
  );

  const root = await mkdtemp(join(tmpdir(), 'armc-projects-'));
  try {
    for (const idx of [1, 2, 3]) {
      // `transcriptsFor` matches `exp2-<arm>-`, so the arm name is the middle segment.
      const dir = join(root, `-Users-x-tmp-exp2-armC${idx}-sandbox-b`);
      await mkdir(join(dir, 'session-1', 'subagents'), { recursive: true });
      await writeFile(join(dir, 'session-1.jsonl'), '{}\n');
      await writeFile(join(dir, 'session-1', 'subagents', 'agent-a.jsonl'), '{}\n');
    }
    for (const idx of [1, 2, 3]) {
      const files = transcriptsFor(runProjectSlug(idx), { projectsDir: root });
      assert.equal(files.length, 2, `run ${idx} should see its own top-level AND subagent transcript`);
      assert.ok(
        files.every((f) => f.includes(runProjectSlug(idx))),
        `run ${idx} priced a file belonging to another run: ${JSON.stringify(files)}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- 9. the runner is not the product ---

test('nothing in lib/ imports the arm C runner, so it cannot become the entrypoint by accident', () => {
  // PLAN.md §2: "There is no second implementation of the trigger." A hand-wired eval
  // runner that quietly becomes bin/alfred IS that second implementation, and the way
  // it would happen is a lib/ module importing it for "just one thing".
  const libDir = fileURLToPath(new URL('../lib/', import.meta.url));
  const offenders = readdirSync(libDir)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => /run-armc/.test(readFileSync(join(libDir, f), 'utf8')));
  assert.deepEqual(offenders, []);
});
