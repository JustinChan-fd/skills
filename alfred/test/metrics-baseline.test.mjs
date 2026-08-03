// THE METRICS BASELINE. A fake ticket, a real repo, and a canned transcript driven through the REAL
// `executeWork`, asserting the record's numbers against values computed BY HAND — so a drift anywhere
// in the metrics library fails here, in a second, for free, instead of being discovered on a live run
// that costs a dollar and twenty-five minutes.
//
// WHY THIS EXISTS WHEN THE SUITE ALREADY HAS 1138 TESTS. Two gaps, both found by reading the existing
// assertions rather than assumed:
//
//   1. `run.test.mjs`'s end-to-end record test asserts `cost.total_usd > 0`. That is a DIRECTION, not
//      a value. It stays green if every rate in `config/prices.json` doubles, halves, or drifts to any
//      wrong-but-positive number — which is exactly the class of failure a price table invites, because
//      the table is DATA and no test that asserts a sign can see data move.
//   2. `report.test.mjs` drives real reduced transcripts hard, but it tests `buildRecord` as a unit,
//      with the transcript handed straight to it. Nothing drove ticket → spawn → transcript → gate →
//      record → disk and then checked the ARITHMETIC at the far end. A unit-correct pricer wired to
//      the wrong field is the mocked-seam shape this project has already paid for.
//
// So the proposition is narrow and it is covered nowhere else: THE NUMBERS THAT COME OUT THE FAR END
// OF A WHOLE RUN EQUAL THE NUMBERS ARITHMETIC SAYS THEY SHOULD.
//
// EXPECTED VALUES ARE HAND-COMPUTED, NEVER A SECOND CALL TO THE CODE. Asserting
// `record.cost.total_usd === priceTokens(...).total_usd` is the code agreeing with itself — green no
// matter how wrong both sides are, the definition of an unfalsifiable test. Every dollar figure below
// is written as its own multiplication, so a reader can check it against `config/prices.json` with a
// calculator and no knowledge of this codebase.
//
// THE TOKENS COME FROM THE TRANSCRIPT, NOT THE WORKER LOG, and that distinction is load-bearing: the
// worker log carries the VENDOR's `total_cost_usd` and the session id, while every token count comes
// from `~/.claude/projects/<slug>/<session>.jsonl`. This fixture therefore writes BOTH — the log the
// runner named and the transcript the CLI would have filed — and `home` is injected so the composed
// path really finds it. `report` stays at its default, so the log is really parsed, the path really
// composed, the transcript really read and really priced. Substituting the reporter instead would
// re-create the mocked-seam blindness that let three defects through a suite green on all of them.
//
// DETERMINISTIC, WITH EVERY SOURCE OF NON-DETERMINISM NAMED AND KILLED:
//   the model    — never called. `spawn` is stubbed and writes fixed bytes.
//   the clock    — a fixed `stamp` and a fixed transcript `timestamp`; nothing reads `now()`.
//   the session  — `newSessionId` is fixed, so the transcript path is knowable in advance.
//   the tokens   — canned, so usage is bytes on disk rather than whatever a model happened to do.
// No network, no `claude`, no spend. It runs in the ordinary suite on every change.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AC_MAP_KIND, AC_MAP_PATH } from '../lib/acmap.mjs';
import { ARM_IDS } from '../lib/gaps.mjs';
import { ARM, RECORD_FILENAME, executeWork } from '../lib/run.mjs';

const temps = [];
const mktemp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), `alfred-baseline-${prefix}-`));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

// ── THE FIXED INPUTS ──────────────────────────────────────────────────────────────────────────
//
// FOUR TOKEN COLUMNS, ALL DIFFERENT AND NONE A MULTIPLE OF ANOTHER. Deliberate: with `input` and
// `cache_read` equal, a pricer that read one field for both would still total correctly and this
// would pass while the per-column split was nonsense. 120k/8k/450k/30k share no factor that could
// absorb a swapped rate.
//
// CACHE_READ IS THE LARGEST, because it is on real runs — `SKILL.md`'s own measurement puts it at
// 95.6% of the cheap arm's tokens. A baseline whose largest column were `input` would under-weight
// the one rate ($0.30/Mtok against $3) where a mistake costs the most absolute dollars.
const TOKENS = Object.freeze({
  input: 120_000,
  output: 8_000,
  cache_read: 450_000,
  cache_creation: 30_000,
});

const MODEL = 'claude-sonnet-5';

// FROM `config/prices.json`, TRANSCRIBED BY HAND so this file STATES what it believes the rates are,
// in dollars per million tokens. Reading the table here instead would make the test agree with any
// edit to it — the agreeing-with-itself failure. Someone who changes the vendor's prices has to
// change this constant too, deliberately, having checked.
const RATE = Object.freeze({ in: 3, out: 15, cache_read: 0.3, cache_write: 3.75 });

// $0.7275, and here is the whole computation:
//   input        120,000 / 1e6 * $3.00  = $0.36
//   output         8,000 / 1e6 * $15.00 = $0.12
//   cache_read   450,000 / 1e6 * $0.30  = $0.135
//   cache_write   30,000 / 1e6 * $3.75  = $0.1125
//                                         ─────────
//                                          $0.7275
const EXPECTED_USD =
  (TOKENS.input / 1e6) * RATE.in +
  (TOKENS.output / 1e6) * RATE.out +
  (TOKENS.cache_read / 1e6) * RATE.cache_read +
  (TOKENS.cache_creation / 1e6) * RATE.cache_write;

// A FIXED STAMP, and it is deliberately AFTER the sonnet-5 introductory window. `lib/prices.mjs`
// prices this model at $3/$15 on both sides of that boundary on purpose; pinning the stamp means
// that promise is TESTED rather than trusted, and the figure above cannot move when a date passes.
const STAMP = '20260803T120000Z';
const TRANSCRIPT_AT = '2026-08-03T12:00:00.000Z';
const SESSION_ID = 'baseline-0000-4000-8000-000000000001';

// The vendor's own figure, close to ours but NOT equal, so a swap between the two fields cannot pass.
// Agreement between two independent sources is the only evidence the copied price table is right, and
// a merge of the two destroys the comparison — hence `notEqual` in the test below.
const VENDOR_USD = 0.7301;

// ── THE FAKE TICKET ───────────────────────────────────────────────────────────────────────────
//
// ONE CRITERION, SHELL-VERIFIABLE, AND IT REALLY PASSES against a file the stub worker really writes.
// A baseline whose gate always failed would price only failed runs, and `gate.pass` would carry no
// information here either — the only-ever-failed problem already recorded against #73, where a gate
// that has never returned true is indistinguishable from one that cannot.
//
// THE COMMAND SHARES THE WORD "baseline" WITH THE CRITERION, which is not cosmetic: §8.1's
// `mapping_implausible` rule fails a command that mentions none of its criterion's subject words, so
// a rubber-stamp map cannot buy a pass. This map earns its plausibility.
const TICKET_BODY = [
  'Add a deterministic marker file so the metrics baseline has something real to grade.',
  '',
  '## Acceptance Criteria',
  '',
  '- src/baseline.js exports a BASELINE marker',
  '',
].join('\n');

const ghIssue = () => async () =>
  JSON.stringify({
    number: 1,
    title: 'a deterministic baseline marker',
    body: TICKET_BODY,
    url: 'https://github.com/acme/jarvis/issues/1',
  });

// ── THE CANNED TRANSCRIPT ─────────────────────────────────────────────────────────────────────
//
// SHAPED LIKE A REAL `~/.claude/projects/<slug>/<session>.jsonl`, because that is what the parser
// under test reads. Two properties are load-bearing:
//
//   `message.id` IS PRESENT AND REPEATS ACROSS TWO LINES. On a real transcript the usage block
//   repeats per streamed block under one id, and `tokens.mjs` dedupes on it — the defect that once
//   inflated every figure in this project by ~2.2x. Two lines sharing an id means this baseline
//   COUNTS THE TOKENS ONCE, so a regression that removes the dedupe doubles the total and fails here.
//
//   THE `timestamp` IS FIXED, because pricing is date-aware. A transcript stamped with the wall clock
//   would re-price the same historical record differently tomorrow.
const assistantLine = () =>
  JSON.stringify({
    type: 'assistant',
    timestamp: TRANSCRIPT_AT,
    message: {
      role: 'assistant',
      model: MODEL,
      id: 'msg_baseline_0001',
      usage: {
        input_tokens: TOKENS.input,
        output_tokens: TOKENS.output,
        cache_read_input_tokens: TOKENS.cache_read,
        cache_creation_input_tokens: TOKENS.cache_creation,
      },
    },
  });

// The same line TWICE — same id, same usage. That repetition is the dedupe's falsifier: counted twice
// this baseline reports $1.455 rather than $0.7275, the shape of the ~2.2x inflation already measured.
const transcriptLines = () => `${assistantLine()}\n${assistantLine()}\n`;

// The worker log: the vendor's result line, which is where `total_cost_usd` and the session id come
// from. NOT where the tokens come from — that separation is the point of writing both files.
const workerLogText = () =>
  `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: SESSION_ID,
    total_cost_usd: VENDOR_USD,
    num_turns: 6,
  })}\n`;

// A real git repo, because `observeTree` shells out to git and a fake would assert against my model
// of `--numstat` rather than against git's output.
function baselineRepo() {
  const dir = mktemp('repo');
  git(dir, ['init', '--quiet', '-b', 'main']);
  git(dir, ['config', 'user.email', 'alfred@example.invalid']);
  git(dir, ['config', 'user.name', 'Alfred Baseline']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'existing.js'), 'export const existing = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'base']);
  return dir;
}

const CONFIG = Object.freeze({
  version: 1,
  repo: 'jarvis',
  source: { kind: 'github', github: { owner: 'acme', repo: 'jarvis' } },
  base: { rules: [{ default: 'main' }] },
  branch_prefix: 'alfred/',
  verify: {},
  // `off`, so the baseline never reaches a git remote or `gh`. Delivery has its own suite driving the
  // real module against a real `file://` remote; a metrics test that needed one would be untrue to
  // its own name and would fail for reasons that are not about metrics.
  delivery: { mode: 'off', never_merge: true },
  off_limits: [],
});

// One whole run of the fake ticket. Returns everything a test might assert on.
async function runBaseline() {
  const repo = baselineRepo();
  const home = mktemp('home');

  // The transcript where the CLI would have filed it, in the layout measured on this machine:
  // realpath'd cwd, every non-alphanumeric character a dash.
  const projectDir = join(home, '.claude', 'projects', realpathSync(repo).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), transcriptLines());

  const result = await executeWork({
    ref: 'acme/jarvis#1',
    config: CONFIG,
    repoRoot: repo,
    runRoot: mktemp('runs'),
    stamp: STAMP,
    home,
    newSessionId: () => SESSION_ID,
    gh: ghIssue(),
    spawn: async (argv, opts) => {
      writeFileSync(opts.logPath, workerLogText());
      // The work: the file the criterion is about.
      writeFileSync(join(repo, 'src', 'baseline.js'), 'export const BASELINE = true;\n');
      // And the ac-map, keyed by the positional id the extractor mints (`AC1`), with a command that
      // names its criterion's subject so §8.1's plausibility rule is satisfied honestly.
      mkdirSync(join(repo, '.alfred'), { recursive: true });
      writeFileSync(
        join(repo, AC_MAP_PATH),
        `${JSON.stringify(
          {
            kind: AC_MAP_KIND,
            version: 1,
            entries: [{ ac: 'AC1', command: 'grep -q BASELINE src/baseline.js' }],
          },
          null,
          2,
        )}\n`,
      );
      return { exit: 0, killed: false, signal: null, wall_ms: 4321, log: opts.logPath };
    },
  });

  return { repo, result };
}

// ── THE BASELINE ──────────────────────────────────────────────────────────────────────────────

test('BASELINE: a whole run prices to the exact dollar arithmetic says, not merely to something positive', async () => {
  const { result } = await runBaseline();

  assert.equal(result.ok, true, `the run did not complete: ${result.error}`);
  assert.ok(result.record, 'a completed run produced no record');
  assert.equal(result.record.ok, true, `record failed: ${result.record.error}`);

  // TWO INDEPENDENT STATEMENTS OF ONE CLAIM. The literal is asserted against the computation as well
  // as against the code, so someone who edits `RATE` to match a changed table still trips the
  // literal — and has to look at the vendor's price list rather than at this file.
  assert.equal(EXPECTED_USD, 0.7275, 'the hand-computed constant no longer equals its own arithmetic');
  assert.equal(
    result.record.cost.total_usd,
    0.7275,
    `priced ${result.record.cost.total_usd}, expected 0.7275 — the price table or the token parser moved`,
  );
});

test('BASELINE: the four token columns survive the whole chain, each one distinctly', async () => {
  const { result } = await runBaseline();
  const byModel = result.record.tokens.by_model[MODEL];

  assert.ok(
    byModel,
    `no token bucket for ${MODEL}; got ${JSON.stringify(Object.keys(result.record.tokens.by_model))}`,
  );
  // EACH COLUMN NAMED SEPARATELY rather than compared as one object, so a failure says WHICH field
  // moved. A single deepEqual reports "objects differ" and leaves the reader to diff four numbers.
  assert.equal(byModel.input, TOKENS.input, 'input tokens');
  assert.equal(byModel.output, TOKENS.output, 'output tokens');
  assert.equal(byModel.cache_read, TOKENS.cache_read, 'cache_read tokens');
  assert.equal(byModel.cache_creation, TOKENS.cache_creation, 'cache_creation tokens');
});

test('BASELINE: usage repeated under one message.id is counted ONCE', async () => {
  // The dedupe's falsifier, and the reason the transcript carries two identical assistant lines.
  // Without the dedupe every figure doubles — the ~2.2x inflation this project has measured and
  // fixed once already. `0.7275` rather than `1.455` is the whole assertion.
  const { result } = await runBaseline();

  assert.equal(result.record.cost.total_usd, 0.7275, 'the repeated usage block was counted twice');
  assert.equal(
    result.record.tokens.by_model[MODEL].input,
    TOKENS.input,
    `input was ${result.record.tokens.by_model[MODEL].input}, so the message.id dedupe stopped working`,
  );
});

test('BASELINE: the vendor figure is carried BESIDE ours and neither replaces the other', async () => {
  const { result } = await runBaseline();

  assert.equal(result.record.cost.vendor_usd, VENDOR_USD, 'the vendor figure was dropped or overwritten');
  assert.equal(result.record.cost.total_usd, 0.7275, 'our figure was replaced by the vendor one');
  assert.notEqual(
    result.record.cost.vendor_usd,
    result.record.cost.total_usd,
    'the two sources became one field, so they can no longer disagree — and disagreement is the signal',
  );
});

test('BASELINE: the per-model split is priced, not zero-filled, and names the model', async () => {
  const { result } = await runBaseline();
  const split = result.record.cost.by_model[MODEL];

  assert.ok(
    split !== undefined,
    `no cost split for ${MODEL}; got ${JSON.stringify(Object.keys(result.record.cost.by_model))}`,
  );
  // The split has to agree with the total on a single-model run. Two fields, one arithmetic: a pricer
  // that summed the wrong bucket would keep one of them right, and this catches the other.
  assert.equal(
    typeof split === 'object' ? split.usd : split,
    0.7275,
    `the split says ${JSON.stringify(split)} while the total says 0.7275`,
  );
  assert.deepEqual(result.record.cost.unpriced, [], 'a known model was recorded as unpriced');
});

test('BASELINE: the gate really passes, so a passing verdict is reachable and not only a failure path', async () => {
  // WHY THIS IS ITS OWN TEST. A baseline that always failed the gate would price only failed runs and
  // `gate.pass` would carry no information — the only-ever-failed problem recorded against #73, where
  // a gate that has never returned true is indistinguishable from one that cannot.
  const { result } = await runBaseline();

  assert.equal(
    result.gate.pass,
    true,
    `the baseline gate failed: ${JSON.stringify((result.gate.findings ?? []).map((f) => `${f.rule}: ${f.detail}`))}`,
  );

  // ANTI-VACUITY. A pass caused by nothing being graded is not a pass. These two rules are exactly
  // what a silently-unmapped or rubber-stamped criterion produces, and either means the `grep` above
  // never ran — so the passing verdict would be measuring nothing.
  const rules = (result.gate.findings ?? []).map((f) => f.rule);
  assert.ok(!rules.includes('ac_unmapped'), 'the criterion was never mapped, so nothing was verified');
  assert.ok(!rules.includes('mapping_implausible'), 'the ac-map was a rubber stamp');
  assert.equal(result.record.work.ac_count, 1, 'the fake ticket stopped yielding exactly one criterion');
});

test('BASELINE: the record reaches DISK with its numbers intact, not just the in-memory object', async () => {
  // Computed-and-discarded is this project's recurring defect (#63/#69/#72/#73), and a returned value
  // nobody persists is the same defect as a computed one nobody stores. Asserting only on
  // `result.record` would pass on a run whose record never got written — and the file is the only
  // artifact that outlives the console.
  const { result } = await runBaseline();

  assert.equal(result.record_error, null, `the reporter threw: ${result.record_error}`);
  assert.equal(result.record_write_error, null, `the record could not be written: ${result.record_write_error}`);
  assert.ok(result.record_path, 'no record path was reported');
  assert.ok(result.record_path.endsWith(RECORD_FILENAME), `unexpected record filename: ${result.record_path}`);

  const onDisk = JSON.parse(readFileSync(result.record_path, 'utf8'));
  assert.equal(onDisk.cost.total_usd, 0.7275, 'the file exists but does not carry the priced total');
  assert.equal(onDisk.tokens.by_model[MODEL].cache_read, TOKENS.cache_read, 'tokens did not reach disk');
  assert.equal(onDisk.session.id, SESSION_ID, 'the record on disk cannot be joined back to its session');
});

test('BASELINE: the record states which ARM produced it, and it is the thin runner', async () => {
  // The arm is the join column for every cross-arm comparison. A record labelled with the wrong
  // cohort pools two different runners into one number, which is worse than an absent label because
  // it looks answerable.
  const { result } = await runBaseline();

  assert.equal(result.record.provenance.arm, ARM, 'the runner did not state its own arm');
  assert.equal(
    result.record.provenance.arm,
    ARM_IDS.THIN,
    'this branch IS the thin runner; a record saying otherwise mislabels the cohort',
  );
  assert.equal(result.record.provenance.backfilled, false, 'a live run was recorded as a backfill');
});

test('BASELINE: two runs of the same fixture produce identical numbers', async () => {
  // DETERMINISM, ASSERTED RATHER THAN ASSUMED — this is what makes the baseline usable as an
  // instrument at all. If the same inputs can yield different figures, then a change in the number
  // tells you nothing about a change in the code. The fields compared are the ones a dashboard reads.
  //
  // Each call builds its own repo, home and run root, so the two runs share no state but the code.
  const a = await runBaseline();
  const b = await runBaseline();

  assert.deepEqual(
    { cost: a.result.record.cost, tokens: a.result.record.tokens },
    { cost: b.result.record.cost, tokens: b.result.record.tokens },
    'the same fixture priced differently twice — something in the chain reads the clock or the machine',
  );
});
