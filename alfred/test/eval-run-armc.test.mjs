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
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
} from '../eval/run-armc.mjs';
import { MARKER_PATH, REASONS } from '../lib/blocked.mjs';
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
