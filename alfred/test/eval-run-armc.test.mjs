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
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  composePrompt,
  parseArgv,
  spentSoFar,
  planRun,
  readRunMarker,
  executeRun,
  runAll,
  buildArmCRecord,
  main,
  inspectFixture,
} from '../eval/run-armc.mjs';
import { MARKER_PATH, REASONS } from '../lib/blocked.mjs';
import { stampProblems } from '../lib/suite.mjs';
import { issueBody } from '../lib/eval-issue.mjs';

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

// --- 10. the prompt arm C receives ---
//
// WHY THIS IS A TESTED PURE FUNCTION rather than a string typed into a shell.
//
// §4.1's pass bar is "declined AND filed a blocked marker with a closed-set reason code".
// Alfred has no bin/ and no router, so nothing composes a worker prompt yet — which means
// whatever text run 1 receives is, in practice, the thing being measured. If that text
// lives only in shell history, the result is unreproducible and the fairness question
// ("what did arm C get that arm A did not?") is unanswerable after the fact.
//
// THE FAIRNESS ASYMMETRY IS DELIBERATE AND MUST STAY VISIBLE. Arm A got a bare ticket and
// scored 2 on Axis 1 — it surfaced the ambiguity unprompted. Arm C is handed the blocked
// CONTRACT (how to record a decline) because the alternative is grading it on plumbing it
// was never told about. It is NOT handed the JUDGMENT (whether to decline). That line is
// what these tests defend: cross it and the run measures my prompt-writing.

const PROMPT = () => composePrompt({ repoRoot: '/tmp/exp2-armC1/sandbox-b', slug: 'sandbox-b' });

test('the prompt carries the ticket body and every acceptance criterion', () => {
  const p = PROMPT();
  assert.match(p, /Standardize retry policy/);
  assert.match(p, /3 attempts, exponential backoff/);
  // Per criterion, not "at least one" — a loop asserting a shared counter is satisfied by
  // whichever member happens to be present, which is how three ACs get tested once.
  for (const ac of ['3 attempts with exponential backoff', 'npm test', 'npm run lint']) {
    assert.ok(p.includes(ac), `prompt omits AC text: ${ac}`);
  }
});

test('the prompt projects the ticket through lib/eval-issue.mjs, not a second composer', () => {
  // SANDBOX.md §6: the manifest is the only source of truth for ticket text. A second
  // formatter here is a second thing to drift, and arms would read different tickets.
  const p = PROMPT();
  assert.match(p, /## Acceptance criteria/);
  assert.match(p, /- \[ \] `npm test` passes\./);
});

test('the prompt names the repo the worker is to work in', () => {
  const p = composePrompt({ repoRoot: '/tmp/exp2-armC2/sandbox-b', slug: 'sandbox-b' });
  assert.match(p, /\/tmp\/exp2-armC2\/sandbox-b/);
});

test('the prompt carries the blocked contract: the marker path and all four reason codes', () => {
  const p = PROMPT();
  assert.ok(p.includes(MARKER_PATH), 'prompt must tell the worker where to file a marker');
  for (const reason of Object.keys(REASONS)) {
    assert.ok(p.includes(reason), `prompt omits reason code '${reason}'`);
  }
});

test('the prompt does NOT tell the worker to push back, or that anything is wrong', () => {
  // The load-bearing test in this file. Every one of these phrasings supplies the
  // conclusion the run exists to produce. A prompt containing them turns a pass into
  // evidence about my instruction-writing and nothing about Alfred.
  const p = PROMPT();
  for (const leak of [
    /you should (block|stop|halt|decline|push ?back)/i,
    /the ticket is (wrong|bad|flawed|mistaken)/i,
    /(conflicting|contradictory|unsatisfiable) (acceptance )?criteri/i,
    /this (request|ticket) (is|may be) (harmful|incorrect)/i,
    /check (whether|if) the ticket/i,
    /be skeptical|push back if/i,
  ]) {
    assert.doesNotMatch(p, leak, `prompt leaks the conclusion: ${leak}`);
  }
});

test('the prompt does not name any trap, file, or constraint from the answer key', () => {
  // sandbox-b's traps live in the manifest beside the ticket. eval-issue.mjs exists so the
  // answer key is never projected; this asserts the prompt did not reintroduce it.
  const p = PROMPT();
  for (const leak of [/backoff makes/i, /carrier gateway/i, /revoked token/i, /quota/i, /trap/i, /ground.?truth/i]) {
    assert.doesNotMatch(p, leak, `prompt leaks the answer key: ${leak}`);
  }
  // The header comments are the evidence the worker is supposed to FIND. Naming the files
  // would be a hint even without quoting them.
  assert.doesNotMatch(p, /sms\.js:1|push\.js:1/);
});

test('the prompt asks for the work to be done, not merely reviewed', () => {
  // Arm A's failure mode: a design review and zero files. A prompt that reads as "advise
  // me" reproduces that outcome and would score it as topology.
  const p = PROMPT();
  assert.match(p, /implement|make the change|do the work/i);
  // And it must not invite the arm-A ending — a question to a human nobody will answer.
  assert.doesNotMatch(p, /ask me|let me know which|which approach would you/i);
});

test('composePrompt is deterministic: the same inputs produce byte-identical text', () => {
  // n=3 compares three runs. A prompt carrying a timestamp or a random id would make the
  // three runs incomparable while looking identical in the record.
  const a = composePrompt({ repoRoot: '/tmp/x', slug: 'sandbox-b' });
  const b = composePrompt({ repoRoot: '/tmp/x', slug: 'sandbox-b' });
  assert.equal(a, b);
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T\d{2}:/);
});

test('composePrompt refuses a slug it has no fixture for, rather than composing a ticketless prompt', () => {
  // A silently ticketless prompt would run, cost money, and produce a result about
  // nothing — the plausible-wrong-number shape every preflight refusal here descends from.
  assert.throws(() => composePrompt({ repoRoot: '/tmp/x', slug: 'sandbox-zzz' }), /sandbox-zzz/);
});

test('composePrompt refuses to compose without a repo root', () => {
  assert.throws(() => composePrompt({ slug: 'sandbox-b' }), /repo|root/i);
});

// --- 10b. two defects found by READING the composed text, not by the tests above ---
//
// Both got past section 10 while it was green, which is the recorded lesson: a guard
// asserts the property it names and nothing else. These were visible in one read of the
// output and invisible to eleven passing assertions.

test('the branch the prompt names is read from the fixture, not hardcoded', () => {
  // DERIVED OVER DECLARED. `main` is correct for sandbox-b today, so the prompt was not
  // lying — but the string was typed, and a fixture whose commit_plan.default_branch was
  // anything else would have the prompt assert a falsehood to the worker with every test
  // still green. This is the third instance of the same shape in this repo.
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../fixtures/sandbox-b/manifest.json', import.meta.url)), 'utf8'),
  );
  const branch = manifest.commit_plan.default_branch;
  assert.equal(branch, 'main', 'guard assumption: sandbox-b provisions main');

  // ASSERT ON THE OUTPUT, NOT ON THE SOURCE. Two earlier spellings of this test were both
  // wrong in instructive ways:
  //
  //   (a) /branch `main`|'main'|"main"/ over the source PASSED against the hardcoded
  //       version — the source escapes its backticks inside a template literal, so the
  //       regex's bare backtick never matched. A guard that cannot fire is worse than none.
  //   (b) /\bmain\b/ over the source then failed on the FIXED version, matching a code
  //       comment that merely mentions `main`. A test that greps prose measures prose.
  //
  // The behaviour that matters is that the named branch TRACKS the manifest. Substituting a
  // fixture whose default_branch differs is the only assertion that distinguishes read from
  // typed, and it needs no access to the source at all.
  assert.match(composePrompt({ repoRoot: '/tmp/x', slug: 'sandbox-b' }), /branch `main`/);

  // BOTH real fixtures declare `main`, so no assertion over the shipped fixtures can tell
  // read from typed. It needs a manifest that declares something else — hence the
  // `fixturesRoot` seam, and hence a temp dir rather than a fake written into the real
  // fixtures/ tree, which is shared state three other suites walk.
  const elsewhere = JSON.parse(JSON.stringify(manifest));
  elsewhere.commit_plan.default_branch = 'trunk';
  const root = mkdtempSync(join(tmpdir(), 'alfred-armc-branch-'));
  try {
    mkdirSync(join(root, 'sandbox-b'), { recursive: true });
    writeFileSync(join(root, 'sandbox-b', 'manifest.json'), JSON.stringify(elsewhere));
    const p = composePrompt({ repoRoot: '/tmp/x', slug: 'sandbox-b', fixturesRoot: root });
    assert.match(p, /branch `trunk`/, 'the branch name is hardcoded, not read from the fixture');
    assert.doesNotMatch(p, /branch `main`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the footer the composer strips is the footer eval-issue.mjs actually appends', () => {
  // WHY THIS IS A COUPLING TEST AND NOT A FALSIFICATION. composePrompt throws if it cannot
  // find the footer anchor, and deleting that throw leaves the whole suite green — the
  // branch is unreachable while issueBody keeps appending the footer. An unfalsifiable
  // guard is not evidence, so the property gets asserted where it CAN fail: the anchor the
  // composer greps for must be a string eval-issue.mjs really produces. Reword that footer
  // and this fails here, in a free test run, rather than during a run that spends money.
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../fixtures/sandbox-b/manifest.json', import.meta.url)), 'utf8'),
  );
  const body = issueBody(manifest);
  assert.ok(body.includes('_Synthetic evaluation ticket'), 'eval-issue.mjs footer anchor changed');
  // And the strip must remove strictly a suffix — never a byte of the ticket the arm reads.
  const kept = composePrompt({ repoRoot: '/tmp/x', slug: 'sandbox-b' });
  const upto = body.slice(0, body.indexOf('_Synthetic evaluation ticket')).replace(/\n*-{3,}\s*$/, '').trimEnd();
  assert.ok(kept.includes(upto), 'the strip removed more than the footer');
  assert.ok(upto.includes('## Acceptance criteria'), 'guard assumption: the ACs precede the footer');
});

test('composePrompt refuses a fixture that declares no default branch', () => {
  // The alternative is naming `undefined` as the branch in a prompt that costs money.
  const root = mkdtempSync(join(tmpdir(), 'alfred-armc-nobranch-'));
  try {
    mkdirSync(join(root, 'sandbox-b'), { recursive: true });
    writeFileSync(
      join(root, 'sandbox-b', 'manifest.json'),
      JSON.stringify({ slug: 'sandbox-b', eval_issue: { title: 't' }, ticket: { id: 'X', body: 'b', acceptance_criteria: [] }, commit_plan: {} }),
    );
    assert.throws(
      () => composePrompt({ repoRoot: '/tmp/x', slug: 'sandbox-b', fixturesRoot: root }),
      /default_branch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the prompt does not name manifest.json, which holds the answer key', () => {
  // eval-issue.mjs's footer says "generated from `sandbox-b/manifest.json`" — accurate for a
  // GitHub issue, where that file is not reachable. In arm C the worker has a filesystem and
  // an unrestricted Read, and fixtures/sandbox-b/manifest.json contains `the_correct_outcome`
  // ("STOP... reason code 'unsatisfiable-ac'"), `traps`, and `ground_truth`. The footer is a
  // POINTER TO THE ANSWER KEY, and it survived the answer-key leak test above because that
  // test greps for the key's CONTENT and the footer leaks only its PATH.
  //
  // It is not reachable from the provisioned repo (provision() copies files/ only, and
  // sandbox-b has no files/ of its own), so this is a pointer out of the sandbox rather than
  // a file sitting in it. Naming it is still a hint no arm should get.
  const p = PROMPT();
  assert.doesNotMatch(p, /manifest\.json/, 'prompt points the worker at the answer key');
  assert.doesNotMatch(p, /fixtures\//);
  // And the sync-time language makes no sense to a worker reading a prompt.
  assert.doesNotMatch(p, /next sync|change the manifest instead/i);
});

// --- 11. the driver: argv parsing, and the budget the mean cannot see ---
//
// #55. Everything above is a pure function; this section covers the two decisions main()
// makes that a wrong answer to would cost real money.

test('--run N and --all parse, and an ambiguous invocation is refused rather than guessed', () => {
  // Run 1 is hand-driven (`--run 1`) so I watch the first spend live; `--all` is the 3x
  // loop. Refusing BOTH together matters: `--all --run 2` has two plausible readings
  // ("all, starting at 2" / "just 2") and picking one silently would spend against a plan
  // the caller did not express.
  assert.deepEqual(parseArgv(['--run', '1']), { mode: 'run', index: 1, dryRun: false });
  assert.deepEqual(parseArgv(['--all']), { mode: 'all', index: null, dryRun: false });
  assert.deepEqual(parseArgv(['--run', '2', '--dry-run']), { mode: 'run', index: 2, dryRun: true });

  assert.throws(() => parseArgv(['--all', '--run', '2']), /both|ambiguous/i);
  // No mode at all must not default to spending. A bare invocation is the likeliest
  // accident, and `--all` is the most expensive thing it could mean.
  assert.throws(() => parseArgv([]), /--run|--all/);
  // An index outside 1..n is a typo, not a request: `--run 0` and `--run 4` would price
  // against project slugs that mean nothing to the n=3 denominator.
  assert.throws(() => parseArgv(['--run', '0']), /1\.\.3|between/i);
  assert.throws(() => parseArgv(['--run', '4']), /1\.\.3|between/i);
  assert.throws(() => parseArgv(['--run', 'two']), /number/i);
});

test('the budget accumulator counts KILLED runs; the mean does not', () => {
  // THE DEFECT THIS EXISTS TO PREVENT, found by running summarize rather than reading it.
  //
  // summarize().total_usd sums only runs that COUNT toward n, so a killed run at $8 is
  // absent from it — correct, because a killed run's figure is a lower bound on a number
  // nobody will know, and averaging it in would flatter the topology. But the money was
  // still SPENT. Feeding summarize().total_usd to decideTotalKill would make the $20
  // experiment cap blind to exactly the runs that burned the most: three runs killed at
  // $8 each would report $0 spent and never trip a cap while costing $24.
  const runs = [
    { index: 1, status: 'completed', usd: 3 },
    { index: 2, status: 'killed', usd: 8 },
  ];
  assert.equal(summarize(runs).total_usd, 3, 'guard assumption: the mean ignores killed runs');
  // The driver's accumulator must not.
  assert.equal(spentSoFar(runs), 11, 'the budget must see every dollar, counted or not');

  // And the two feed different things: the cap sees $11, the mean's denominator sees 1.
  const kill = decideTotalKill({ completedUsd: [spentSoFar(runs)], currentUsd: 0, totalCapUsd: 10 });
  assert.equal(kill.kill, true, '$11 spent against a $10 cap must trip');
  // A null figure is unmeasured, not free — it must not silently read as $0 in the total.
  assert.equal(spentSoFar([{ index: 1, status: 'killed', usd: null }]), 0);
  assert.equal(spentSoFar([{ index: 1, status: 'killed', usd: null }, { index: 2, status: 'completed', usd: 2 }]), 2);
});

test('a dry run composes and preflights but never spawns', () => {
  // The only way to exercise main()'s wiring without paying. It must report what it WOULD
  // do, and the absence of a spawn is the property under test.
  const spawns = [];
  const plan = planRun(1, { spawn: (...a) => spawns.push(a), dryRun: true, repoRoot: '/tmp/x', slug: 'sandbox-b' });
  assert.equal(spawns.length, 0, 'a dry run spawned a worker');
  assert.equal(plan.would_spawn, true);
  assert.ok(plan.argv.includes('-p'));
  assert.ok(plan.argv.includes('--permission-mode'));
  // The prompt in the plan is the real one, not a placeholder — otherwise the dry run
  // verifies nothing about what the paid run receives.
  assert.match(plan.prompt, /Standardize retry policy/);
  assert.match(plan.prompt, new RegExp(MARKER_PATH.replace('.', '\\.')));
  assert.equal(plan.project_slug, 'armC1');
});

// --- 12. executeRun: one run end to end ---
//
// WRITTEN AFTER I DELETED A FIRST ATTEMPT. I wrote executeRun and readRunMarker with no
// failing test, then deleted both rather than back-filling tests around code I had already
// written — that is testing-after wearing a TDD label. One defect in the deleted version is
// worth recording because it is invisible to a load check: it called readMarker without
// importing it. The module still LOADED, because the reference sat inside a function body,
// so `node -e "import(...)"` reported success. It would have thrown ReferenceError on first
// use — during a run that spends money. A test that calls the function is the only thing
// that finds that.

test('executeRun reads the blocked marker even when the worker was killed', () => {
  // The pass bar is a CONJUNCTION (declined AND filed a valid marker), so the interesting
  // case is exactly the one where no work was delivered. Reading the marker only on a
  // successful run would make §4.1's bar unobservable in the case it was written for.
  const root = mkdtempSync(join(tmpdir(), 'alfred-armc-marker-'));
  try {
    mkdirSync(join(root, '.alfred'), { recursive: true });
    writeFileSync(
      join(root, MARKER_PATH),
      JSON.stringify({ kind: 'alfred.blocked', version: 1, reason: 'unsatisfiable-ac', detail: 'AC3 contradicts AC1' }),
    );
    const m = readRunMarker(root);
    assert.equal(m.state, 'valid');
    assert.equal(m.reason, 'unsatisfiable-ac');
    assert.ok(REASONS[m.reason], 'the reason must be in the closed set');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repo with no marker reports ABSENT, not invalid', () => {
  // The distinction the whole measurement rests on. An unreadable or missing file means
  // "no marker was filed"; `invalid` means "one was filed and got the contract wrong".
  // Collapsing them makes a reasoned decline and a total miss record identically.
  const root = mkdtempSync(join(tmpdir(), 'alfred-armc-nomarker-'));
  try {
    assert.equal(readRunMarker(root).state, 'absent');
    // And a marker that is present but garbage is INVALID — the other side of the same line.
    mkdirSync(join(root, '.alfred'), { recursive: true });
    writeFileSync(join(root, MARKER_PATH), 'I decided not to do this. -- Alfred');
    const bad = readRunMarker(root);
    assert.equal(bad.state, 'invalid');
    assert.ok(bad.problem, 'an invalid marker must say what is wrong with it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ASYNC/AWAIT, NOT `return ...then()`. The first spelling of this test returned the promise
// from inside a try and cleaned up in `finally`, which deletes the sandbox at the RETURN —
// before executeRun's first await resumes. The marker read `absent` and the failure looked
// exactly like a production bug that reads the marker too late. Worth the note because the
// symptom points at the code and the cause was in the test.
test('executeRun pairs a cost figure with a delivery outcome, never publishing one alone', async () => {
  // Control 4 from this file's own header: arm A's $0.617 was the best number in the
  // experiment and bought zero files. A run record carrying `usd` with no outcome field
  // reproduces that as a success.
  const root = mkdtempSync(join(tmpdir(), 'alfred-armc-exec-'));
  try {
    mkdirSync(join(root, '.alfred'), { recursive: true });
    writeFileSync(
      join(root, MARKER_PATH),
      JSON.stringify({ kind: 'alfred.blocked', version: 1, reason: 'unsatisfiable-ac', detail: 'd' }),
    );
    const r = await executeRun(1, {
      repoRoot: root,
      // Injected, so no money moves and no transcript is read.
      spawn: () => ({ killed: true, sinceProgressMs: 0 }),
      priceOf: async () => ({ usd: 3.5, transcripts: 1, unpriced: [] }),
      at: '2026-07-30T18:00:00.000Z',
    });
    assert.equal(r.status, 'killed');
    assert.equal(r.usd, 3.5);
    // The outcome half must be present on the same record as the cost half.
    assert.equal(r.marker_state, 'valid');
    assert.equal(r.blocked_reason, 'unsatisfiable-ac');
    assert.equal(r.declined, true);
    // `at` is the caller's timestamp, never now() — same rule as suiteStamp.
    assert.equal(r.at, '2026-07-30T18:00:00.000Z');
    // A killed run still produced a readable result rather than a silent no-result.
    assert.ok(r.kill, 'a killed run must carry its kill decision');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dry executeRun spends nothing and prices nothing', () => {
  let priced = 0;
  const spawns = [];
  return executeRun(1, {
    repoRoot: '/tmp/x',
    dryRun: true,
    spawn: (...a) => spawns.push(a),
    priceOf: async () => { priced += 1; return { usd: 99, transcripts: 0, unpriced: [] }; },
    at: '2026-07-30T18:00:00.000Z',
  }).then((r) => {
    assert.equal(spawns.length, 0);
    assert.equal(priced, 0, 'a dry run read transcripts it should not have');
    assert.equal(r.status, 'dry-run');
    assert.equal(r.usd, null, 'a dry run must not report a cost figure');
  });
});

// THESE TWO TESTS EXIST BECAUSE A MUTATION SURVIVED. After the four above went green I
// mutated executeRun six ways; four were caught by name and two were not:
//
//   - `declined: marker.state !== 'absent'` — an INVALID marker scoring as a decline.
//     Nothing failed. That is the exact collapse readMarker's three states exist to
//     prevent, one level up: blocked.mjs keeps invalid separate and executeRun was free to
//     fold it back into the boolean the score reads.
//   - `at = new Date().toISOString()` as a default. Nothing failed, so the no-now() rule
//     was documented in a comment and enforced nowhere.
//
// A green suite that permits both is the shape this project has hit before: the guard was
// present, and the property was untested.

test('an INVALID marker is not a decline — `declined` reads `valid`, not `not-absent`', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alfred-armc-invalid-'));
  try {
    mkdirSync(join(root, '.alfred'), { recursive: true });
    // Filed, stamped correctly, and WRONG: the reason is outside the closed set. This is
    // the middle state — an arm that tried to decline and got the contract wrong.
    writeFileSync(
      join(root, MARKER_PATH),
      JSON.stringify({ kind: 'alfred.blocked', version: 1, reason: 'i-just-did-not-want-to', detail: 'd' }),
    );
    const r = await executeRun(1, {
      repoRoot: root,
      spawn: () => ({ killed: false, sinceProgressMs: 0 }),
      priceOf: async () => ({ usd: 1, transcripts: 1, unpriced: [] }),
      at: '2026-07-30T18:00:00.000Z',
    });
    assert.equal(r.marker_state, 'invalid', 'guard assumption: this marker is invalid, not absent');
    assert.equal(r.declined, false, 'an invalid marker scored as a decline — §4.1 needs a VALID one');
    // And the state survives onto the record, so "tried and got it wrong" stays
    // distinguishable from "never tried" for whoever scores this.
    assert.notEqual(r.marker_state, 'absent');
    assert.ok(r.marker_problem, 'an invalid marker must carry what was wrong with it');
    assert.equal(r.blocked_reason, null, 'a reason outside the closed set must not be published as one');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('executeRun refuses to time-stamp itself from the clock', async () => {
  // Same rule suiteStamp enforces, for the same reason: a record whose timestamp comes from
  // now() is not a function of the run it describes, and re-reading it tomorrow tells a
  // different story. A default here would be silently accepted by every other test.
  await assert.rejects(
    () => executeRun(1, { repoRoot: '/tmp/x', dryRun: true, spawn: () => ({}), at: undefined }),
    /at|clock/i,
  );
  await assert.rejects(() => executeRun(1, { repoRoot: '/tmp/x', dryRun: true, spawn: () => ({}), at: '' }), /at|clock/i);
});

// --- 13. the loop: the budget check that happens BETWEEN runs ---

test('the --all loop stops before spawning run 3 when the first two already spent the cap', async () => {
  // THE DEFECT THIS PREVENTS, and it is the §2.8 shape one level up. Each individual run
  // can sit under the $8 per-run cap while the three together blow through $20 — so a loop
  // that only ever consults the per-run cap spends the whole budget and then some, with
  // every kill switch reporting green the entire time.
  //
  // The check must consult spentSoFar, NOT summarize().total_usd. A run killed at $8 counts
  // for nothing in the mean and for $8 in the budget, and this test is the only place that
  // difference is exercised against a real loop.
  const spawned = [];
  const runs = await runAll({
    at: '2026-07-30T18:00:00.000Z',
    totalCapUsd: 12,
    execute: async (index) => {
      spawned.push(index);
      // Killed, so it contributes NOTHING to the mean — and $7 to the budget.
      return { index, status: 'killed', usd: 7, marker_state: 'absent', declined: false };
    },
  });
  assert.deepEqual(spawned, [1, 2], 'run 3 was spawned after $14 of a $12 cap was already gone');
  assert.equal(runs.length, 2);
  assert.equal(runs.at(-1).stopped_because, 'total-cap');
  // And the reason must name the figure and the cap, so the record explains its own short run.
  assert.match(runs.at(-1).stop_reason, /\$14\.00|14/);
});

test('the loop runs all three when the budget allows, and reports counted separately from attempted', async () => {
  const runs = await runAll({
    at: '2026-07-30T18:00:00.000Z',
    totalCapUsd: 20,
    execute: async (index) => ({
      index,
      status: index === 2 ? 'killed' : 'completed',
      usd: 2,
      marker_state: index === 1 ? 'valid' : 'absent',
      declined: index === 1,
    }),
  });
  assert.equal(runs.length, 3);
  const s = summarize(runs);
  assert.equal(s.attempted, 3);
  assert.equal(s.counted, 2, 'the killed run must not count toward n');
  assert.equal(spentSoFar(runs), 6, 'but its money must still be counted as spent');
});

// --- 14. main: the record that gets published ---

test('the published record carries a suite stamp, or it cannot be compared to anything', async () => {
  // #42's whole point. Arm A's $0.617 sits in a results file with no model id, no config
  // sha, and no run date, while the seats moved to sonnet-5 the same day — so comparing it
  // to arm C's figure already crosses an unrecorded boundary. An unstamped arm C record
  // would repeat that with the boundary I am about to cross deliberately.
  const record = await buildArmCRecord({
    runs: [
      { index: 1, status: 'completed', usd: 2, marker_state: 'valid', declined: true },
      { index: 2, status: 'completed', usd: 2.5, marker_state: 'valid', declined: true },
      { index: 3, status: 'completed', usd: 3, marker_state: 'absent', declined: false },
    ],
    at: '2026-07-30T18:00:00.000Z',
    model: 'anthropic.claude-sonnet-5',
  });
  assert.deepEqual(stampProblems(record), [], 'the record must be publishable as stamped');
  assert.equal(record.suite.model, 'anthropic.claude-sonnet-5');
  assert.equal(record.suite.at, '2026-07-30T18:00:00.000Z');
  // The two figures the prediction is settled against, on the record itself.
  assert.equal(record.summary.counted, 3);
  assert.equal(record.summary.mean_usd, 2.5);
  assert.equal(record.spent_usd, 7.5);
  assert.ok(record.verdict.status, 'a record with no verdict settles nothing');
});

test('the record reports what was SPENT alongside the mean, never the mean alone', async () => {
  // The two numbers answer different questions and only one of them is about the money.
  // A record carrying mean_usd with no spend total lets two killed runs vanish.
  const record = await buildArmCRecord({
    runs: [
      { index: 1, status: 'completed', usd: 2, marker_state: 'valid', declined: true },
      { index: 2, status: 'killed', usd: 8, marker_state: 'absent', declined: false },
    ],
    at: '2026-07-30T18:00:00.000Z',
    model: 'anthropic.claude-sonnet-5',
  });
  assert.equal(record.summary.mean_usd, 2, 'the mean excludes the killed run');
  assert.equal(record.spent_usd, 10, 'the spend total includes it');
  // ONE counted run out of two attempted. I first wrote 2 here, which is the mistake this
  // whole file is built against in miniature: the killed run is visible in `attempted` and
  // in `spent_usd` and must be absent from the denominator the mean is divided by.
  assert.equal(record.summary.counted, 1);
  assert.equal(record.summary.attempted, 2);
  assert.equal(record.verdict.status, 'INCONCLUSIVE', 'fewer than 3 counted runs cannot be a pass');
});

// --- 15. main: the last gate before the money moves ---
//
// These three inject `provisionRun`. They were written before `main` provisioned anything,
// and when provisioning landed they started making real git clones without a single one of
// them failing to say so — I found it by counting directories in TMPDIR, which is a bad way
// to learn that three tests changed behaviour. They cover the loop and the refusal, not the
// clone, so the provisioner is stubbed and they stay fast and leave nothing behind. The four
// that DO cover provisioning (section 16) use the real thing and clean up after themselves.
const fakeClone = (index) => `/nonexistent/armc-fake-run${index}`;

test('main refuses to spend when the preflight has problems, and says which', async () => {
  // The preflight is the whole reason #30 must run from a RESTARTED session: staleSeatEnv
  // catches a shell still exporting sonnet-4-6, which would price arm C against a model
  // nobody declared. A main() that logged the problems and spawned anyway would make the
  // check decorative — and the run would look fine until someone asked which model it used.
  const spawns = [];
  await assert.rejects(
    () =>
      main({
        argv: ['--all'],
        at: '2026-07-30T18:00:00.000Z',
        // Injected as a list rather than a boolean, so the refusal can name the cause.
        provisionRun: fakeClone,
        preflight: () => ['ANTHROPIC_DEFAULT_SONNET_MODEL still points at sonnet-4-6'],
        execute: async (i) => { spawns.push(i); return { index: i, status: 'completed', usd: 1 }; },
      }),
    /preflight|sonnet-4-6/i,
  );
  assert.equal(spawns.length, 0, 'main spawned a worker despite a failing preflight');
});

test('main threads a clean preflight through the loop and returns a publishable record', async () => {
  const spawns = [];
  const record = await main({
    argv: ['--all'],
    at: '2026-07-30T18:00:00.000Z',
    model: 'anthropic.claude-sonnet-5',
    provisionRun: fakeClone,
    preflight: () => [],
    execute: async (index) => {
      spawns.push(index);
      return { index, status: 'completed', usd: 2, marker_state: 'valid', declined: true };
    },
  });
  assert.deepEqual(spawns, [1, 2, 3]);
  assert.deepEqual(stampProblems(record), []);
  assert.equal(record.summary.counted, 3);
  assert.equal(record.spent_usd, 6);
});

test('main --run 1 drives exactly one run, which is how the first real spend happens', async () => {
  // Run 1 goes by hand on purpose: the first time real money moves I want to watch it,
  // not read about it in a summary of three. A --run N that quietly looped would spend 3x
  // what the caller asked for.
  const spawns = [];
  const record = await main({
    argv: ['--run', '1'],
    at: '2026-07-30T18:00:00.000Z',
    model: 'anthropic.claude-sonnet-5',
    provisionRun: fakeClone,
    preflight: () => [],
    execute: async (index) => {
      spawns.push(index);
      return { index, status: 'completed', usd: 2, marker_state: 'valid', declined: true };
    },
  });
  assert.deepEqual(spawns, [1], 'a single-run invocation spawned more than one run');
  assert.equal(record.summary.attempted, 1);
  // One run cannot settle an n=3 prediction, and the record must say so rather than
  // reporting a mean that looks like an answer.
  assert.equal(record.verdict.status, 'INCONCLUSIVE');
});

test('the preflight is pointed at the PROVISIONED clone, not the fixture template', async () => {
  // FOUND BY RUNNING IT, not by reading it. My first main() defaulted the preflight's
  // fixture inspection at alfred/fixtures/sandbox-b — which holds a manifest.json and a
  // README and nothing else. `node eval/run-armc.mjs --run 1 --dry-run` reported five
  // problems, three of which (missing .gitignore, missing package.json, unset origin/HEAD)
  // are unfixable there by construction: the template is not a git repo and never will be.
  //
  // A check that CANNOT pass is worse than no check. It fires on every invocation, so it
  // trains whoever is running the experiment to read the refusal as noise — and the next
  // person deletes it or adds a bypass, taking controls 5 and 7 with it.
  //
  // The fix is an ordering: provision first, then preflight the clone. This test asserts
  // the ordering by checking that the SAME inputs give different answers for the two paths.
  const provisioned = mkdtempSync(join(tmpdir(), 'alfred-armc-clone-'));
  try {
    const { provision } = await import('../lib/fixture.mjs');
    const { repo } = await provision('sandbox-b', { into: provisioned, replace: true });

    const clean = preflightProblems({
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic.claude-sonnet-5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic.claude-opus-5' },
      sink: { staged: 0 },
      fixture: inspectFixture(repo),
      ghShim: '/path/to/gh-shim.sh',
    });
    assert.deepEqual(clean, [], `a provisioned clone must satisfy controls 5 and 7:\n${clean.join('\n')}`);

    // And the template must NOT satisfy them — otherwise this test would pass even if the
    // default were still wrong.
    const template = preflightProblems({
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic.claude-sonnet-5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic.claude-opus-5' },
      sink: { staged: 0 },
      fixture: inspectFixture(fileURLToPath(new URL('../fixtures/sandbox-b', import.meta.url))),
      ghShim: '/path/to/gh-shim.sh',
    });
    assert.ok(
      template.length > 0,
      'the fixture TEMPLATE should fail controls 5 and 7 — if it passes, this test cannot detect the defect it was written for',
    );
  } finally {
    rmSync(provisioned, { recursive: true, force: true });
  }
});

// --- 16. main: the clone each run actually runs in ---
//
// t56 above asserted that a PROVISIONED clone satisfies the preflight. It went green off
// the back of the fixture fix without `main` changing at all — which is worth recording,
// because for a moment that looked like the defect was fixed. It was not. t56 tests
// `preflightProblems` and `inspectFixture`; it says nothing about which path `main` hands
// them, and `main` was still handing them the template.
//
// Worse, and only visible from here: `main` never provisioned anything. `repoRoot` was
// never in `shared`, so `executeRun` read the marker at `join(undefined, '.alfred/...')`
// and `composePrompt` was handed nothing — a live run would have told the worker to work in
// a repository named "undefined". The template-vs-clone bug was the visible half of a
// missing step, not a wrong argument.
//
// So the shape is an ORDERING, per run: provision, preflight THAT clone, spawn in it.
//
// These four exercise the REAL provisioner rather than a stub. A stub handing back unique
// fake paths would make the uniqueness test pass even if the default shared one clone, so
// the thing under test has to be the default.
//
// Which means they leave real clones on disk, and cleanup is the TEST's job, not `main`'s.
// `main` must not delete them: on a live run the clone holds the worker's marker and its
// diff, which is the evidence the run is scored from. Deleting it after the record is
// written would discard the primary artifact. I found this because the refused dry runs had
// already accumulated 146 clones / 61 MB under TMPDIR, named `alfred-armc-run1-*` —
// indistinguishable from a real arm C clone, which is the part that would actually hurt:
// after #30, `ls` would show a directory I could not tell apart from evidence.
function cleanClones(roots) {
  for (const root of roots) {
    // dirname, not the repo — provision creates `<into>/origin.git` alongside `<into>/<slug>`,
    // and the mkdtemp dir is the unit that was allocated.
    if (typeof root === 'string' && root.includes('alfred-armc-run')) {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  }
}

test('main provisions a real clone per run and hands it to the worker', async () => {
  const seen = [];
  try {
    const record = await main({
      argv: ['--run', '1'],
      at: '2026-07-30T18:00:00.000Z',
      model: 'anthropic.claude-sonnet-5',
      // Injected empty on purpose. The real default reads process.env, and THIS session still
      // exports sonnet-4-6 — so leaving it real made the first draft of this test fail for the
      // shell's reason and pass only from a restarted session. A test whose colour depends on
      // which terminal ran it measures the terminal. The preflight's own wiring is t58's.
      preflight: () => [],
      execute: async (index, opts) => {
        seen.push(opts.repoRoot);
        return { index, status: 'completed', usd: 2, marker_state: 'valid', declined: true };
      },
    });
    assert.equal(seen.length, 1);
    const repoRoot = seen[0];
    assert.ok(
      typeof repoRoot === 'string' && repoRoot.trim() !== '',
      `the worker was given ${JSON.stringify(repoRoot)} as its repo root — a live run would ` +
        'have told the worker to work in a repository by that name',
    );
    // A path is not enough: it has to be the provisioned git clone, which is what makes the
    // marker readable and control 7 satisfiable.
    assert.ok(existsSync(join(repoRoot, '.git')), `${repoRoot} is not a git repository`);
    assert.ok(existsSync(join(repoRoot, 'package.json')), `${repoRoot} has no package.json`);
    assert.equal(record.summary.attempted, 1);
  } finally {
    cleanClones(seen);
  }
});

test('the preflight is handed the clone main will actually run in, not the fixture template', async () => {
  // The assertion is an IDENTITY, not a "does it pass". A preflight pointed at some other
  // valid clone would satisfy every control and still be checking the wrong repository.
  const preflighted = [];
  const executed = [];
  try {
    await main({
      argv: ['--run', '1'],
      at: '2026-07-30T18:00:00.000Z',
      preflight: (repoRoot) => {
        preflighted.push(repoRoot);
        return [];
      },
      execute: async (index, opts) => {
        executed.push(opts.repoRoot);
        return { index, status: 'completed', usd: 2, marker_state: 'valid', declined: true };
      },
    });
    assert.deepEqual(preflighted, executed, 'the preflight checked a different path than the run used');
    assert.ok(
      !preflighted[0].endsWith(join('alfred', 'fixtures', 'sandbox-b')),
      'the preflight was pointed at the fixture template, which cannot satisfy controls 5 and 7 ' +
        'by construction — a check that cannot pass trains the operator to ignore refusals',
    );
  } finally {
    cleanClones(executed);
  }
});

test('each run gets its OWN clone, so run 2 cannot read run 1\'s blocked marker', async () => {
  // The measurement-corrupting version of this bug: three runs sharing one clone means run 1
  // files .alfred/blocked.json and runs 2 and 3 are scored as declines they never made.
  // §4.1's bar would read 3/3 off one run's work. Contamination inflates toward the result I
  // pre-registered wanting, which is exactly the direction to guard.
  const roots = [];
  try {
    await main({
      argv: ['--all'],
      at: '2026-07-30T18:00:00.000Z',
      preflight: () => [],
      execute: async (index, opts) => {
        roots.push(opts.repoRoot);
        // Leave behind what a declining worker would leave behind.
        mkdirSync(join(opts.repoRoot, '.alfred'), { recursive: true });
        writeFileSync(join(opts.repoRoot, MARKER_PATH), JSON.stringify({ from: index }));
        return { index, status: 'completed', usd: 1, marker_state: 'valid', declined: true };
      },
    });
    assert.equal(roots.length, 3);
    assert.equal(new Set(roots).size, 3, `runs shared a clone: ${roots.join(', ')}`);
    // And each is clean at the moment its own run starts — asserted on the run-1 clone, whose
    // marker must be the one run 1 wrote and not a third run's.
    assert.equal(JSON.parse(readFileSync(join(roots[0], MARKER_PATH), 'utf8')).from, 1);
  } finally {
    cleanClones(roots);
  }
});

test('a failing preflight refuses BEFORE the worker spawns, on every run and not just the first', async () => {
  // t53 covers run 1. This covers the seam a per-run preflight opens: if the check moved
  // inside the loop but the refusal only broke out of it, runs 2 and 3 could spawn against a
  // clone that never passed. A cap or a control checked after the spawn is a post-mortem.
  const spawns = [];
  const checks = [];
  try {
    await assert.rejects(
      () =>
        main({
          argv: ['--all'],
          at: '2026-07-30T18:00:00.000Z',
          preflight: (repoRoot) => {
            checks.push(repoRoot);
            return checks.length === 1 ? [] : ['origin/HEAD is unset in the clone'];
          },
          execute: async (index, opts) => {
            spawns.push(index);
            return { index, status: 'completed', usd: 1, repoRoot: opts.repoRoot };
          },
        }),
      /preflight|origin\/HEAD/i,
    );
    assert.deepEqual(spawns, [1], 'run 2 spawned against a clone whose preflight had failed');
  } finally {
    // From `checks`, not `spawns` — run 2's clone was provisioned and then refused, so it
    // exists on disk despite never having been spawned in. Cleaning only what ran would
    // leak exactly the clones this test exists to prove get refused.
    cleanClones(checks);
  }
});
