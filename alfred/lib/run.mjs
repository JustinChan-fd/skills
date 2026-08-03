// run — PLAN.md §2.1's eight steps, wired. The only module here that spawns anything.
//
// DELIBERATELY THIN. The call for this slice was the minimum that can run end to end, so that
// real failures name the guards worth having rather than imagined ones naming them first. What
// is NOT here: a lock file (§2.2, `alfred loop`'s job), stall detection, a gh shim, branch
// creation, or delivery. Those arrive when a real run asks for them.
//
// WHAT IS HERE IS EVERY GAP THE EXPERIMENT'S RUNNER FOUND BY ACTUALLY LAUNCHING SOMETHING.
// (Named by role rather than by path. The arm C test file's §9 guard refuses any mention of that
// runner's filename from lib/ — "nothing in lib/ imports the arm C runner, so it cannot become the
// entrypoint by accident" — and it stays deliberately blunt; lib/gate.mjs carries the same note
// for the same reason. The runner lives under eval/, and the tests beside it hold the
// measurements this module's guards were derived from.) Those gaps were
// invisible to sixty green tests because every one of them injected a fake at the seam that was
// missing, and they cost real money to find:
//
//   1. stdio to a FILE, not a pipe. A child emitting past the 64KB pipe buffer with nothing
//      draining it never exits, and `--output-format json` is far past that. Measured: a stub
//      emitting 200KB hung until the wall cap fired, which would have scored the launcher's own
//      bug as a finding about Alfred's topology.
//   2. A LAUNCH FAILURE IS NOT A COMPLETED RUN. `spawn` reports ENOENT on a later tick, so
//      `child.pid` is undefined and a naive wait reports a worker that never started as one
//      that finished having delivered nothing.
//   3. A WALL CAP THAT FIRES FROM OUTSIDE THE CHILD. It is now the PRIMARY runaway bound, not a
//      supplement to a dollar cap — `--max-budget-usd` was removed from the worker's own argv
//      (see lib/router.mjs's header) after it was measured to freeze cache-breakpoint
//      advancement. SIGTERM, not SIGKILL: the transcript the run is priced from has to flush.
//
// THE SEAT ENV, WHICH IS MEASURED RATHER THAN ASSUMED. `~/.zshrc:42-44` exports the three
// `ANTHROPIC_DEFAULT_*` seats and there is no `.zshenv`, `.zprofile`, or `.zlogin` — so
// `env -i zsh -l -c 'env'` shows ZERO of them: a tool-spawned shell inherits no seats at all.
// And in the other direction, a long-lived process holds whatever env it started with; one
// session's held `ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic.claude-sonnet-4-6` with no OPUS var.
// Either way an inherited seat is untestable and silently wrong, so the child env is SET from
// `SEATS` and the inherited value LOSES.
//
// The honest scope of that control: `--model`, `--fallback-model` and the `--agents` payload pin
// every model Alfred NAMES. The env pins the ones the CLI resolves on its own — an alias, its
// own internal calls — which are exactly the ones no argv can reach and no record would show.
//
// THE RUN DIRECTORY IS OUTSIDE THE REPOSITORY, and that is not tidiness. The gate scores the
// working-tree diff, so a `source.json` or a `worker.log` written under `repoRoot` is counted as
// DELIVERED WORK and raises `scope_violation` on a run that did nothing wrong.

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { loadConfig } from './config.mjs';
import { deliver } from './delivery.mjs';
import { resolveItem } from './item.mjs';
import { ARM_IDS } from './gaps.mjs';
import { recordForRun } from './report.mjs';
import { runGate } from './gate.mjs';
import { SEATS } from './models.mjs';
import { checkAttestation, parseAttestation } from './preflight.mjs';
import { composeWorkerPrompt, standingRules } from './prompt.mjs';
import { workerArgv } from './router.mjs';
import { syncRecord } from './telemetry.mjs';
import { firstTurnFromWorkerLog, terminalErrorFromWorkerLog } from './transcript.mjs';

const execFileAsync = promisify(execFile);

// The record's filename inside the run directory. A sibling of `source.json`: that file is what
// the run was ASKED to do, this one is what it cost and how it was graded.
export const RECORD_FILENAME = 'record.json';

// WHICH ARM THIS RUNNER IS (A5). Three approaches will sit side by side in the sink — the
// single-agent control, Alfred before the thin rewrite, and this — and `provenance.arm` is the
// only field that tells their records apart.
//
// A CONSTANT HERE, DELIBERATELY NOT A CONFIG KEY. The arm names the CODE that performed the run.
// A repo config claiming `alfred-thin` while the multi-agent runner executed would be a lie the
// record carries forever, and configs outlive the code they were written against —
// webtarsthree's has already survived two rewrites of this runner. So the runner states its own
// identity, and the one caller permitted to override it (`executeWork`'s `provenance` argument) is
// Phase C's backfill, which is reconstructing a run some other code performed.
//
// FROM THE CLOSED SET in gaps.mjs, not a bare literal: a typo here would label every record this
// runner ever writes with a cohort of one — recorded as `provenance-arm-unknown` on every run,
// which is a gap nobody would read as "the constant is misspelled". Referenced by NAME rather than
// by index, so reordering the list cannot silently re-point it.
// THIN AS OF THIS BRANCH, AND THE CHANGE IS THE POINT OF THE CONSTANT. `gaps.mjs` defines
// `alfred-thin` as "the single-session runner Phase B builds" and `alfred-multi-agent` as "Alfred as
// it stood BEFORE the thin rewrite (phase orchestration)". This runner no longer orchestrates
// phases: one `claude -p`, one session, graded once. Leaving this on MULTI_AGENT would have filed
// every record from here under the cohort whose defining property — phase orchestration, the thing
// measured at 4.7x tokens for no PR — this code no longer has, and the comparison those arm ids
// exist to support would silently pool two different runners into one number.
//
// EVERY RECORD FROM THIS COMMIT FORWARD IS `alfred-thin`. Phase C's backfill of historical runs
// passes `provenance` explicitly and is unaffected: those records describe code that really was
// the multi-agent runner, and relabelling them would destroy the very contrast being measured.
export const ARM = ARM_IDS.THIN;

// 45 minutes. RAISED FROM 25 ON MEASURED EVIDENCE, 2026-08-03. It no longer matches
// THRESHOLDS.armC.wallCapMs, and that divergence is deliberate: eval/armcost.mjs defines the
// conditions a frozen experiment was run under, so moving it would rewrite history rather than
// change behaviour. This constant governs live runs and is free to move.
//
// WHAT THE 10-RECORD SINK SHOWS. Exactly ONE run ever hit the 25-minute cap
// (20260803T141200Z-7, jarvis#7, killed at 1500264ms). It was not thrashing: 148 turns, 12 edits
// already applied, first edit at turn 85, and its last words were "Now writing the failing test
// for the frontend button" — a run mid-stride, not a run in a loop. The next-longest run
// (20260803T151017Z-11) COMPLETED at 23.98 minutes, i.e. with 61 seconds of headroom against a
// 25-minute cap, which makes that success closer to luck than to margin. 45 clears the one
// observed overrun and leaves the one observed success genuinely uncrowded.
//
// WHY 45 AND NOT 60, WHICH WAS ASKED FOR. The clock is not what binds these runs — the context
// window is. Peak context on the two long runs was 167027 and 146538 (84% and 73% of sonnet-5's
// 200k), and the KILLED one had ALREADY COMPACTED ONCE while the completing one never did. So a
// cap generous enough to permit routine compaction does not buy proportionally more work; it buys
// a run that survives with a degraded evidence trail, because compaction is where the
// ac_map-to-evidence chain gets dropped — the exact material the gate grades. A cap kill is loud
// and leaves a local commit behind (69a59c8 survived this one; only the PUSH is gated). Silent
// evidence loss is neither. 45 sits above the observed need and below routine compaction.
//
// AND LENGTH IS NOT WHAT MAKES A RUN EXPENSIVE, which is the intuition this change has to correct.
// Cost per minute FALLS as runs lengthen: $0.85/min at 9 minutes against $0.24/min at 25, because
// cache reads amortise across a long single session. Raising the cap therefore does not scale cost
// with the ceiling the way it appears to — the ~$6 both long runs landed on was set by the work,
// not by the clock.
export const DEFAULT_WALL_CAP_MS = 45 * 60 * 1000;

// One env var per model family. Named as a frozen list so a test asserts against the same set
// the writer uses rather than against a second copy of three strings.
export const SEAT_ENV_VARS = Object.freeze([
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]);

const FAMILY_VAR = Object.freeze({
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
});

// Derived from the seats table, never typed. A literal here would pass forever while `SEATS`
// moved underneath it, which is #67's shape in the one place where the drift spends money at
// the wrong tier.
//
// Takes the table as an argument so the disagreement refusal below is testable: `SEATS` is
// frozen and valid, and a guard that can only be exercised by breaking a frozen export is a
// guard nobody ever watches fire.
export function seatEnvFrom(seats = SEATS) {
  const vars = {};
  const claimed = {};

  for (const [name, seat] of Object.entries(seats ?? {})) {
    const model = String(seat?.model ?? '');
    const family = /haiku|sonnet|opus/.exec(model)?.[0];
    if (!family) {
      throw new Error(
        `seat '${name}' names model '${model}', which belongs to no known family. There is one ` +
          'env var per family, so a seat outside them would resolve to whatever the parent shell ' +
          'exported — which is the failure this function exists to remove.',
      );
    }

    const key = FAMILY_VAR[family];
    // TWO SEATS ON ONE FAMILY MUST AGREE. There is one env var per family, so picking a winner
    // would route a seat to a model nobody wrote down — and that shows up only as an
    // unexplained cost column, long after the run.
    if (vars[key] !== undefined && vars[key] !== model) {
      throw new Error(
        `seats '${claimed[key]}' and '${name}' both use the ${family} family but name different ` +
          `models ('${vars[key]}' and '${model}'). One env var carries the family default, so ` +
          'these cannot both be honoured and neither is silently preferred.',
      );
    }
    vars[key] = model;
    claimed[key] = name;
  }

  for (const key of SEAT_ENV_VARS) {
    if (vars[key] === undefined) {
      throw new Error(
        `no seat names a model for ${key}. An unset family default means the CLI resolves that ` +
          'tier however it likes, and the record would not show it.',
      );
    }
  }

  return vars;
}

// The child's environment. MERGED onto the inherited env so the child keeps node, git and
// `claude` off the inherited PATH — a replaced PATH fails for the environment's reason and reads
// as the run's — but the seats are applied LAST so a stale inherited value loses.
export function workerEnv({ env = process.env, seats = SEATS } = {}) {
  return { ...env, ...seatEnvFrom(seats) };
}

// A path component that cannot open a directory tree keyed on someone else's repository.
// `acme/jarvis#4` carries a separator, and joining it unescaped creates `.../acme/jarvis#4/`.
//
// TRUNCATED FROM THE FRONT, not the back, and that is the whole point. The 60-char cap used to
// keep the first 60 characters — fine when every ref was a short key or `acme/jarvis#4`, and wrong
// the moment a browse URL became legal (`4c00ecf`), because a URL's distinguishing part is its
// TAIL: scheme, host and `/browse/` are shared prefix, and the ticket is last. MEASURED before
// this: `https://<56-char-host>/browse/TARS-1351` and `.../TARS-1359` slugged to the same 60
// characters, so within one stamp two different tickets shared a run directory and one run's
// artifacts overwrote the other's — the exact failure `runDirFor` below says it prevents, arrived
// at from the other end of the string. Keeping the tail also keeps the name legible: an operator
// reading `.alfred-runs/` wants to see which ticket, and the host is the part they already know.
const slug = (text) => {
  const clean = String(text ?? 'item')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // `-` re-trimmed after the cut: slicing mid-separator would otherwise leave a leading dash.
  return (clean.length > 60 ? clean.slice(-60).replace(/^-+/, '') : clean) || 'item';
};

// Where the run's own artifacts live. OUTSIDE `repoRoot` — see the header. Deterministic given
// a stamp, so the record's path is reproducible and two runs never share a directory (armc's
// `$TMPDIR/armC1-worker.log` silently replaced the previous run's output).
export function runDirFor({ repoRoot, itemId, stamp, runRoot = null } = {}) {
  const root = runRoot ?? join(dirname(resolve(repoRoot ?? '.')), '.alfred-runs');
  return join(root, `${stamp}-${slug(itemId)}`);
}

// Names and creates the run directory. Exported because `--dry-run` needs one too, and it needs
// it for a reason worth stating: a rehearsal still FETCHES the ticket, and §2.1 calls writing the
// raw payload non-negotiable — "fetch once with no copy means no run is replayable". A dry run
// that fetched and discarded would reintroduce exactly that, on the path an operator uses to
// check what a run is about to do.
//
// One function rather than two call sites so the stamp format cannot differ between them; a
// rehearsal whose directory sorts differently from the real run's is a needless puzzle at 3am.
export function newRunDir({ repoRoot, ref, runRoot = null, stamp = null } = {}) {
  const at = stamp ?? new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  // Named from the REF, which is known before the id: resolving the item is what writes into
  // this directory, so the directory has to exist first. A ticket ref slugs to the same thing
  // its id would.
  const dir = runDirFor({ repoRoot, itemId: ref, stamp: at, runRoot });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const numstat = async (repoRoot, args) => {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
};

// GIT C-QUOTES PATHS, AND THE ESCAPED FORM IS WHAT THE GATE WOULD SCORE. Measured: a path with
// any byte outside ASCII arrives from `--numstat` AND `ls-files` as
// `"test/\303\274n\303\257.test.js"` — surrounding quotes and octal escapes, a literal 30-char
// string for a 16-char filename. Left encoded, three things break at once: `isEvidence` matches
// against an escaped path, the operator reads the escaped path in `touched`, and
// `git show HEAD:<that>` cannot resolve it — the last one silently, as absent counts.
//
// `-c core.quotePath=false` WAS the first fix here and was removed deliberately. It handles the
// non-ASCII case, but a name containing a literal `"`, a tab, or a newline is still quoted under
// it (verified: `"test/we\"ird.test.js"`), because leaving those raw would make the output
// unparseable. So a decoder is needed regardless — and once it exists, the flag only serves to
// keep the common case AWAY from it, leaving the decoder exercised solely by names nobody has.
// One path that always runs beats two where the tested one is the rare one.
//
// Octal before the simple escapes: decoding `\\` first would eat the backslash `\303` needs.
// Bytes are collected and decoded as UTF-8 at the end because one character is several octal
// escapes, and decoding each alone yields mojibake.
const unquotePath = (raw) => {
  const s = String(raw);
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return s;
  const body = s.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') {
      bytes.push(...Buffer.from(body[i], 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (next >= '0' && next <= '7') {
      bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    const simple = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '\\': 92, '"': 34 };
    if (next in simple) {
      bytes.push(simple[next]);
      i += 1;
      continue;
    }
    bytes.push(92);
  }
  return Buffer.from(bytes).toString('utf8');
};

// COUNTING WHAT SURVIVED (#74). The two numbers `checkEvidence` needs to tell a refactor from
// an exploit — see `evidenceGrew` in gate.mjs for why one number is not enough.
//
// STRIP BEFORE COUNTING, in this order. A commented-out `it(` and an `it(` inside a string
// literal both inflate the block count, and a worker that comments out its assertions would
// otherwise read as having kept them. Block comments first, then line comments, then string
// and template bodies — the naive regex-on-raw-source version counts all three.
const stripNonCode = (src) =>
  String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');

// `(\.\w+)*` is load-bearing and was measured: the bare `/\b(it|test)\s*\(/` form scores ZERO
// for `it.each`, `test.skip`, and `it.todo`, so converting a suite to `it.each` looks like mass
// deletion while skipping every test in a file can look like no change at all. `describe` counts
// because a deleted describe block takes its children with it.
const TEST_BLOCK = /\b(?:it|test|describe)(?:\.\w+)*\s*\(/g;

// Assertion shapes across the runners Alfred actually meets (vitest/jest `expect`, node:test
// `assert`, chai `.should`). Counted rather than pattern-matched for correctness: the question
// is only "did the number of things that can fail go down", so a broad count is right and a
// missed dialect shows up as an unobserved pair, which is graded as before.
const ASSERTION = /\bexpect\s*\(|\bassert\b\s*(?:\.\w+)?\s*\(|\.\s*should\b|\btoBe(?:Truthy|Falsy|Null|Defined)?\s*\(|\btoEqual\s*\(/g;

const countMatches = (src, re) => {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(src) !== null) n += 1;
  return n;
};

const countsFor = (src) => ({
  tests: countMatches(stripNonCode(src), TEST_BLOCK),
  assertions: countMatches(stripNonCode(src), ASSERTION),
});

// Same shape as gate.mjs's `isEvidence`, and DUPLICATED rather than imported on purpose: the
// gate must stay a pure function of its inputs (no repo reads), and this side must stay free to
// widen what it measures without moving the rule that grades. A file this misses arrives at the
// gate with no counts, which is graded exactly as it was before #74 — the safe direction.
const looksLikeEvidence = (file) => {
  const parts = String(file).split('\\').join('/').replace(/^\.\//, '').split('/');
  if (parts.some((p) => ['test', 'tests', 'spec', '__tests__'].includes(p))) return true;
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(parts[parts.length - 1] ?? '');
};

// `test/{old.js => new.js}` is what --numstat emits for a rename, and `git show <ref>:<that>`
// fails `fatal: path does not exist` — reproduced, no config needed. Both sides are recoverable
// from the one path, so the rename is resolved rather than dropped.
//
// WHEN THE ARROW APPEARS AT ALL, measured, because I had assumed `git mv` was enough: the arrow
// is a RENAME-DETECTION artifact, not a `git mv` one. Moving a 12-test file and cutting one test
// yields `test/{channels => notify}.test.js`; moving a 2-test file and cutting one yields TWO
// separate entries, an all-deleted old path and an all-added new one, because similarity fell
// under git's 50% threshold. Both shapes are handled — the split shape needs nothing, since each
// path resolves on its own side, and the all-deleted old path counting to zero is the correct
// reading of a file that is gone.
//
// TWO SHAPES, NOT ONE, and the second was missed until a nested rename was actually run. Git
// factors out a COMMON prefix and suffix, so the braces only appear when there is something to
// factor. Measured:
//
//   test/{channels.test.js => notify.test.js}          same directory  → braces
//   {test => spec}/channels.test.js                    sibling dir     → braces
//   old/sub/channels.test.js => new/deep/notify.test.js nothing shared  → NO BRACES
//
// The brace-only regex silently missed that third form entirely: `before` came back as the whole
// 50-char string, `git show` failed, and the file arrived unmeasured — the exact blind spot this
// function exists to close, for the rename that moves furthest and hides most.
//
// `[^{}]*` rather than `.*` on the inner captures, and the honest status of that choice: it is a
// stricter parse of the documented format, NOT a fix for an observed failure. I claimed it
// protected against a path with two braced segments; git does not emit one. Asked for a move
// where both the middle directory and the filename change, it factors once and puts the slashes
// INSIDE the braces — `a/{b/c/x.test.js => z/c/y.test.js}` — which greedy and lazy parse
// identically. The mutation to `.*` survived the whole suite, and rather than keep a comment
// asserting a hazard nothing can produce, this records that the two forms are indistinguishable
// on real git output and the tighter one is kept on principle alone.
//
// The braced form is tried FIRST, and that order is load-bearing. A braced path also contains
// ` => `, so splitting on the arrow first would tear `test/{a => b}.test.js` into `test/{a` and
// `b}.test.js`. Only a path with no braces at all can be split on the bare arrow.
const renamePaths = (file) => {
  const braced = /^([^{}]*)\{([^{}]*) => ([^{}]*)\}([^{}]*)$/.exec(file);
  if (braced) {
    const [, prefix, from, to, suffix] = braced;
    // `split('//')` handles git's `{ => sub}/f.js` form, where one side is empty and the naive
    // join leaves a doubled separator.
    const clean = (s) => `${prefix}${s}${suffix}`.split('//').join('/');
    return { before: clean(from), after: clean(to) };
  }
  // A filename may legally contain ` => ` (verified: git emits `test/old => new.test.js`
  // unquoted, so the output is genuinely ambiguous and no parse can be certain). Split anyway —
  // it is the only reading that makes the no-common-part rename measurable — but only when
  // BOTH halves resolve to something git can show. `evidenceCounts` returns null if the
  // pre-image read fails, so a misread arrives as unobserved, which is the pre-#74 grade.
  const arrow = /^(.+?) => (.+)$/.exec(file);
  if (arrow) return { before: arrow[1], after: arrow[2] };
  return { before: file, after: file };
};

// ONE try/catch PER SIDE PER FILE, and this is the whole reason this is a separate function.
// `observeTree`'s post-spawn call site sits inside a try whose catch turns the ENTIRE diffstat
// to undefined — so an unguarded `git show` throw here would blind `evidence_weakened` AND
// `instrument_modified` for the run, on any repo where one path failed to resolve. A file that
// cannot be read on both sides contributes nothing and costs nothing.
// `before`/`after` are passed IN rather than re-derived from `file`, because `observeTree` now
// resolves the rename at the parse and `file` is already the post-image — re-parsing it here
// would find no arrow and read the pre-image at the new path, which does not exist at `since`.
async function evidenceCounts({ repoRoot, since, before, after }) {
  const read = async (ref, path) => {
    try {
      return await numstat(repoRoot, ['show', `${ref}:${path}`]);
    } catch {
      return null;
    }
  };

  const src0 = await read(since, before);
  if (src0 === null) return null;

  // The worktree, not `HEAD:` — the gate scores what the worker left on disk, and the post-spawn
  // observation happens before anything is committed.
  let src1 = null;
  try {
    src1 = readFileSync(join(repoRoot, after), 'utf8');
  } catch {
    // Deleted outright. The counts go to zero, which is a real observation and the strongest
    // possible signal for this rule — not an absence.
    src1 = '';
  }

  const b = countsFor(src0);
  const a = countsFor(src1);
  return {
    tests_before: b.tests,
    tests_after: a.tests,
    assertions_before: b.assertions,
    assertions_after: a.assertions,
  };
}

// What the worker actually did to the tree, in the shape the gate reads.
//
// `added`/`deleted` PER FILE, because `checkEvidence` filters on `Number(entry.deleted) > 0` and
// `checkInstruments` sums `added + deleted`. A shape carrying `insertions`/`deletions` would make
// both rules read every file as zero-churn and never fire — green, and blind.
//
// UNTRACKED FILES ARE INCLUDED. `git diff --numstat` alone reports nothing for a new file, so a
// whole new module could land outside the declared scope unseen. `--intent-to-add` on a
// throwaway index would mutate the tree being scored, so the untracked files are listed
// separately and counted by hand.
// COUNTS ARE OPT-IN (#74), and the flag exists because there are two call sites with different
// questions. `treeIsDirty` asks "is anything here at all" BEFORE the spawn — it has no `since` to
// diff a worker's edits against, and counting there would spend git calls to compare HEAD with
// itself. The post-spawn observation is the one whose answer the gate grades.
export async function observeTree({ repoRoot, since = 'HEAD', withEvidenceCounts = false } = {}) {
  const entries = new Map();

  const tracked = await numstat(repoRoot, ['diff', '--numstat', since, '--']);
  for (const line of tracked.split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split('\t');
    // `rest.join('\t')` because a path may contain a tab — in which case git quotes it and the
    // tab arrives as the two characters `\t`, so the join is defensive rather than load-bearing.
    // Unquoted here, at the parse, so every downstream consumer (the gate's `isEvidence`, the
    // operator-facing `touched`, `git show`) sees the path as it exists on disk.
    const raw = unquotePath(rest.join('\t'));
    if (!raw) continue;

    // THE RENAME ARROW IS RESOLVED HERE, NOT LEFT FOR THE GATE, and this was the last defect the
    // #74 tests found — the one that reached furthest past the rule being fixed.
    //
    // Shipping `a/{b/c/x.test.js => z/c/y.test.js}` as `file` hands the gate a string that is not
    // a path, and EVERY rule keyed on the path then reads it wrong. Measured on the real
    // predicates: `isEvidence` is false, because the last segment is `y.test.js}` — with the
    // brace, so the `\.test\.js$` regex misses — and no segment equals `test`. So a renamed test
    // file OUTSIDE a `test/` directory was invisible to `evidence_weakened` entirely, and the
    // same wrong string is what `scope_violation` and `off_limits` glob against and what
    // `touched` shows the operator. `test/{a => b}.test.js` happened to survive only because its
    // prefix segment was literally `test`, which is why the first pass of these tests missed it.
    //
    // `after` is the right identity: it is what exists on disk now, what the operator can open,
    // and what every path pattern is written against. The pre-image is not lost — `renamePaths`
    // recovers it from the raw string for the counts, and `renamed_from` records it so a reader
    // is not left wondering why a file with deletions has no history at that path.
    const { before, after } = renamePaths(raw);
    const file = after;
    // `-` for a binary file. Zero would read as "observed and unchanged", which is a claim this
    // cannot make, so it is carried as null and the gate's `Number(null) > 0` reads false.
    entries.set(file, {
      file,
      added: added === '-' ? null : Number(added),
      deleted: deleted === '-' ? null : Number(deleted),
      ...(before === after ? {} : { renamed_from: before }),
    });
  }

  // MEASURED: `ls-files` quotes on the same rule as `--numstat`, so an untracked non-ASCII path
  // arrives escaped here too. Unquoted before it is used as an argv path, or the `--no-index`
  // count below runs against a filename that does not exist and the file lands with `added: null`.
  const untracked = await numstat(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  for (const raw of untracked.split('\n')) {
    if (!raw.trim()) continue;
    const file = unquotePath(raw);
    let added = 0;
    try {
      // `git diff --no-index /dev/null <file>` counts the lines without touching the index.
      const out = await numstat(repoRoot, ['diff', '--numstat', '--no-index', '/dev/null', file]);
      added = Number(out.split('\t')[0]);
    } catch (err) {
      // `--no-index` exits 1 when there IS a difference, which is always here. The numbers are
      // on stdout regardless.
      const out = String(err?.stdout ?? '');
      added = Number(out.split('\t')[0]);
    }
    entries.set(file, { file, added: Number.isFinite(added) ? added : null, deleted: 0 });
  }

  const diffstat = [...entries.values()];

  // Evidence files only, and only when asked. Each file's counts are attached or omitted
  // independently — one unresolvable path must not cost the others their measurement, and an
  // omitted pair is graded exactly as it was before #74.
  if (withEvidenceCounts) {
    for (const entry of diffstat) {
      // EITHER SIDE OF A RENAME COUNTS AS EVIDENCE. A file moved OUT of `test/` into `src/` is
      // still a deletion of evidence, and asking only about the post-image would grant an
      // exclusion for the move itself.
      const before = entry.renamed_from ?? entry.file;
      if (!(looksLikeEvidence(entry.file) || looksLikeEvidence(before))) continue;
      if (!(Number(entry.deleted) > 0)) continue;
      const counts = await evidenceCounts({ repoRoot, since, before, after: entry.file });
      if (counts) Object.assign(entry, counts);
    }
  }

  return { diffstat, touched: diffstat.map((e) => e.file) };
}

// Is this tree gradeable? The check that has to happen before the money is spent.
//
// DIRTY IS DEFINED BY `observeTree`, DELIBERATELY, AND NOT BY `git status --porcelain`. The two
// disagree on ignored files, and the difference is not academic: #15 put `.alfred/ac-map.json`
// into `.gitignore` precisely so `--exclude-standard` drops it from the diff the gate scores. A
// refusal keyed on porcelain would read that marker as dirt and refuse every run in this
// repository — a guard stricter than the harm it prevents, which is how a correct guard comes to
// be switched off. What matters is exactly what the gate can see and will attribute to the
// worker, so the observer that produces the gate's input is the one that answers the question.
//
// WHY REFUSE AT ALL. Nothing on the observe→gate path asks WHEN a change arrived, so a change
// already present at spawn time is scored as the worker's. That is wrong in both directions: a
// stale edit to a test file raises `evidence_weakened` against a worker that never opened it
// (#71's shape, invisible in the record), and a stale edit that happens to satisfy a criterion is
// graded as delivered (#15's false green, one layer up). Neither is a verdict worth paying for.
export async function treeIsDirty({ repoRoot }) {
  const { touched } = await observeTree({ repoRoot });
  // Sorted so the refusal message is stable across runs — git's ordering differs between the
  // tracked and untracked passes, and an operator diffing two refusals should see the tree
  // change, not the enumeration order.
  return [...touched].sort();
}

// The message, kept beside the check rather than inlined at the call site: the PATHS are the
// diagnostic. "the working tree is dirty" sends someone to `git status` in a directory they may
// not be sitting in, and a count says nothing about what to commit or revert.
//
// IT ALSO SAYS WHAT NOT TO EXPECT. Alfred does not stash, revert, or clean — the operator's
// uncommitted work is unrecoverable from here, and a tool that silently repairs the thing it is
// measuring has no standing to report on it. The override is named so the refusal is actionable
// in the case where the dirt is deliberate.
export function dirtyRefusal(paths) {
  const shown = paths.slice(0, 20);
  const more = paths.length - shown.length;
  return (
    `refusing to spawn against a dirty working tree: the gate scores the diff against HEAD and ` +
    `would attribute ${paths.length === 1 ? 'this change' : 'these changes'} to the worker. ` +
    `Commit, revert, or move ${paths.length === 1 ? 'it' : 'them'}, or pass --allow-dirty to ` +
    `grade the tree as it stands. Nothing here was cleaned:\n` +
    shown.map((p) => `  ${p}`).join('\n') +
    (more > 0 ? `\n  ... and ${more} more` : '')
  );
}

// Launches the worker and resolves once it has ended or been stopped.
//
// Everything about this function is one of the three measured gaps in the header. `bin` is a
// parameter so a test can launch a real child that is not `claude` — the seam has to be exercised
// for real, because a test asserting that a stubbed spawn received an env is blind to the spawn
// being wired wrong.
export function spawnWorker(
  argv,
  {
    bin = 'claude',
    cwd,
    logPath,
    env = process.env,
    seats = SEATS,
    wallCapMs = DEFAULT_WALL_CAP_MS,
    // STOP THIS WORKER EARLY, on what it has written so far (B2). `watch(logText)` returns
    // `{reason, detail}` to stop or anything falsy to let it run. Called on a timer against the log
    // the child is appending to, until it fires once or the child ends.
    //
    // A PREDICATE, AND THIS FUNCTION KNOWS NOTHING ABOUT PREFLIGHT. `executeWork` composes the
    // predicate out of `firstTurnFromWorkerLog` + `parseAttestation` + `checkAttestation`; the
    // launcher's job is the race, not the rule. Keeping the split means the attestation logic is
    // testable with no child process and the race is testable with no attestation.
    //
    // OPT-IN. `undefined` means no timer is ever created, so every existing caller's behaviour is
    // byte-identical — a spawn path silently rewritten for all callers is not an addition.
    watch = null,
    // 2s. The attestation lands within seconds of the spawn, and the thing being saved is minutes
    // of a 25-minute cap, so a tighter poll buys nothing and reads a growing file more often for it.
    pollMs = 2000,
  } = {},
) {
  mkdirSync(dirname(logPath), { recursive: true });
  const sink = openSync(logPath, 'w');
  const startedAt = Date.now();

  // A FILE, NOT A PIPE. See gap 1.
  const child = spawn(bin, argv, {
    cwd,
    env: workerEnv({ env, seats }),
    detached: false,
    stdio: ['ignore', sink, sink],
  });

  return new Promise((resolvePromise, reject) => {
    let killed = false;
    let timer = null;
    // WHY THE WATCH STOP IS ITS OWN FLAG AND NOT `killed`. `killed` means the wall cap fired, and
    // `executeWork` raises a `check_failed` finding from it that says the worker ran out of time. A
    // preflight refusal reported through the same flag would be diagnosed as a timeout — a different
    // problem with a different fix — and §2.8's recorded failure is precisely a run whose stop
    // reason was lost on the way to the verdict.
    let stopped = null;
    let poll = null;

    // ONE CLOSE, MEASURED. A failed spawn emits BOTH 'error' and 'close' — Node's own
    // `maybeClose` runs off `onErrorNT` — so closing the fd in each handler throws
    // `EBADF: bad file descriptor` from the second one. That surfaced as an uncaughtException
    // taking down the test rather than as the refusal below: a second false-success shape
    // hiding behind the fix for the first, which is the same pairing armc found here.
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      closeSync(sink);
    };

    // A LAUNCH FAILURE IS NOT A COMPLETED RUN. See gap 2: this arrives on a later tick than
    // `spawn` returns, and without it a `pid`-less child reads as a worker that finished.
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };

    child.once('error', (err) => {
      if (timer) clearTimeout(timer);
      stopPolling();
      release();
      reject(
        new Error(
          `the worker never launched: ${err.message}. A run that did not start is not a run that ` +
            'delivered nothing — refusing rather than reporting a completed run with no cost.',
          { cause: err },
        ),
      );
    });

    // THE WALL CAP, FROM OUTSIDE THE CHILD. See gap 3. SIGTERM so the transcript flushes.
    timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, wallCapMs);

    // THE WATCH, ON A TIMER AGAINST THE GROWING LOG (B2).
    //
    // POLLED, NOT READ ONCE. The attestation is not on disk when the child starts — measured at
    // line 6 of a real 301-line log, some hundreds of milliseconds in. A watch called once at spawn
    // time would read an empty file, conclude nothing, and be a mechanism that is present, green,
    // and incapable of ever firing. That is the unwired-tripwire shape this project keeps finding.
    if (typeof watch === 'function') {
      poll = setInterval(() => {
        // ONCE. SIGTERM is a request, not a guarantee: a child that ignores it keeps writing, the
        // next poll matches again, and without this latch the run would signal it every `pollMs` and
        // overwrite the stop reason with whatever a later, longer read happened to match. The FIRST
        // reason is the true one.
        if (stopped) return;

        let text;
        try {
          text = readFileSync(logPath, 'utf8');
        } catch {
          // The file may not exist yet, or may be mid-write. Not an outcome — just nothing to read.
          return;
        }

        let verdict = null;
        try {
          verdict = watch(text);
        } catch {
          // A BROKEN WATCH MUST NOT STOP A WORKING WORKER, and it especially must not throw from
          // inside a timer: this callback is not inside the promise's own try, so an escape would
          // take down the process supervising a worker that is already costing money. The mechanism
          // that reports a problem must not become the problem — `readMarker`'s rule.
          return;
        }
        if (!verdict) return;

        stopped = {
          reason: verdict.reason ?? null,
          detail: verdict.detail ?? null,
          // WHEN it was stopped, because the cost of the mechanism is the question it exists to
          // answer. A refusal at 4s and a refusal at 4 minutes are the same verdict and very
          // different value, and nothing else in the record could tell them apart.
          at_ms: Date.now() - startedAt,
        };
        stopPolling();
        // SIGTERM, for the wall cap's reason: the transcript this run is priced from has to flush.
        // The spend up to the refusal is real and has to be reported, not discarded.
        child.kill('SIGTERM');
      }, pollMs);
      // UNREF'd. Without it this interval holds the event loop open, and `alfred work` would sit
      // there after the run finished — a hang introduced by the thing meant to prevent one. The
      // 'close' handler clears it in the normal case; this covers every other exit.
      poll.unref?.();
    }

    child.once('close', (exit, signal) => {
      clearTimeout(timer);
      stopPolling();
      // Returns early on a launch failure: 'error' already rejected, and resolving after that
      // would be a no-op that reads in the code like a second outcome.
      if (closed) return;
      release();
      resolvePromise({
        exit,
        signal,
        killed,
        // `null` WHEN NOTHING STOPPED IT, never `{reason: null}`. Absent is not "stopped for no
        // reason" — the same absent-is-not-zero rule `gate.pass` and `cost.total_usd` follow.
        stopped,
        wall_ms: Date.now() - startedAt,
        pid: child.pid ?? null,
        log: logPath,
      });
    });
  });
}

// THE PREFLIGHT PREDICATE. `spawnWorker`'s `watch` contract, composed out of three pieces that each
// know nothing about the others: `firstTurnFromWorkerLog` reads a growing log, `parseAttestation`
// finds the fenced block, `checkAttestation` grades it against the criteria the ticket declared.
//
// WHY IT IS BUILT HERE AND NOT INSIDE `spawnWorker`. The launcher owns the race — poll interval,
// SIGTERM, the latch that fires once — and this owns the rule. Split that way, the attestation
// logic is testable with no child process and the race is testable with no attestation. Fused, a
// bug in either is only reachable by paying for both.
//
// RETURNS null FOR "KEEP GOING", which is `watch`'s contract, and there are FOUR distinct ways to
// get there. Three of them are the mechanism working:
//
//   no criteria      nothing was declared, so there is nothing to attest to. `executeWork` does not
//                    even arm a watch in that case — this clause is the belt to that braces.
//   absent           the poll ran before the child wrote a byte. Every run passes through here.
//   in_progress      the turn is being written right now. A half-written fence is not a lie, and
//                    refusing on one would fire on a worker about to answer correctly.
//
// The fourth is the honest limit of a substring check: `checkAttestation` returns `refused: false`
// and this returns null, WITHOUT that meaning the quotes were true. It means no quote was found to
// be false. `preflight.mjs`'s header is explicit that this path can only ever refuse, never grant a
// pass, which is why nothing here or there is named `ok`, `pass`, or `verified`.
//
// A COMPLETE TURN WITH NO ATTESTATION IS A REFUSAL, and it can only be known once the turn is over —
// that is what the third state buys. `parseAttestation`'s `absent` on a `complete` turn means the
// worker read the contract and answered around it.
function preflightWatch({ criteria, body, threshold }) {
  const declared = Array.isArray(criteria) ? criteria : [];
  if (declared.length === 0) return null;

  return (logText) => {
    const turn = firstTurnFromWorkerLog(logText);
    if (turn.state !== 'complete') return null;

    const parsed = parseAttestation(turn.text);
    // NO `absent` BRANCH HERE, AND ONE WAS WRITTEN AND THEN DELETED. It returned
    // `attestation-absent` with its own prose, a mutant replacing it with `if (false)` survived the
    // suite, and the trace is why: `parsed.attestation` is null in that state, and
    // `checkAttestation(null)` ALREADY returns `attestation-absent` — with a better detail, because
    // it names which criteria went unattested and the deleted branch could not. No input can
    // distinguish the two forms, which makes the branch unearned rather than untested, and a branch
    // that cannot fire is indistinguishable from one that passed. Same call as the blank-string half
    // of `firstTurnFromWorkerLog`'s guard. Kept as a comment because "there is deliberately no
    // absent branch" is a fact the next reader will otherwise re-add.
    if (parsed.state === 'invalid') {
      // `attestation-unreadable` FROM THE FROZEN SET, and the first draft of this line invented
      // `attestation-unparseable` instead. Nothing would have thrown: the string would have reached
      // the record, and a reader grouping runs by refusal code would have had one bucket that
      // matches no documented reason — a value computed correctly and carried into a shape nothing
      // can read, which is this project's recurring defect wearing a different coat. The set is
      // frozen in preflight.mjs precisely so the codes are a closed vocabulary; a test below pins
      // that every reason this runner can emit is a key in it.
      return { reason: 'attestation-unreadable', detail: parsed.problem };
    }

    const verdict = checkAttestation({ attestation: parsed.attestation, criteria: declared, body, threshold });
    if (!verdict.refused) return null;
    return { reason: verdict.reason, detail: verdict.detail };
  };
}

// PLAN.md §2.1, in its order. Returns a RESULT and does not throw, for the same reason
// `resolveItem` and `loadConfig` do not: an unusable input is "the operator asked for something
// that isn't there", and throwing turns that reading into a crash inside whatever is looping
// over ticks at 3am.
//
// `spawn`, `gate` and `report` are injected with real defaults. That is not the runner trusting
// a claimed result — an injected gate still decides by exit code — it is the only way to exercise
// the ordering without spending money on every assertion.
export async function executeWork({
  ref,
  config = null,
  repoRoot,
  runRoot = null,
  stamp = null,
  maxTurns = null,
  wallCapMs = DEFAULT_WALL_CAP_MS,
  // #14. Defaults to REFUSING, because the failure it prevents is silent: a run against a dirty
  // tree produces a verdict that reads exactly like a valid one. An opt-in guard would be off on
  // every unattended tick, which is the only place nobody is watching.
  allowDirty = false,
  spawn: spawnFn = spawnWorker,
  gate: gateFn = runGate,
  // A REAL DEFAULT AT LAST. This was `null` with a comment saying the record "needs a transcript
  // path this slice does not yet know how to find", and the consequence was measured: the first
  // real run cost $1.0671732 and produced no record at all. The path was always computable — see
  // lib/transcript.mjs — so what was missing was the wiring, not the information.
  report: reportFn = recordForRun,
  // Same injection pattern as `report`/`spawn`/`gate`: real default is `syncRecord`, so a real
  // run really pushes to the configured sink, and a test can substitute a stub without touching
  // git. See lib/telemetry.mjs's header for why this is a fresh implementation and not an import
  // of harness-core's `syncRun`.
  sync: syncFn = syncRecord,
  // B3. Same injection pattern, and the real default really pushes. Injectable for one reason only:
  // a test of the steps AROUND delivery (the record's shape, the exit code, the console output)
  // should not need a bare remote and a `gh` on PATH to run.
  //
  // WHAT A TEST MUST NOT DO WITH THIS SEAM. Substituting a stub here proves nothing about delivery
  // itself — `test/delivery.test.mjs` drives the real module against a real git repo and a real
  // `file://` remote for exactly that reason. This seam exists so that OTHER tests are cheap, not
  // so that delivery's own behaviour can be asserted against a fake. That distinction is the
  // mocked-seam lesson: a test injecting a fake at a seam cannot see the seam is missing.
  deliver: deliverFn = deliver,
  env = process.env,
  // Injected only so a test can put a transcript somewhere and have the composed path find it.
  // An environment fact rather than a module boundary, which is the point: with `report` left at
  // its default, the log is really parsed, the path really composed, and the transcript really
  // read and priced. Substituting the reporter instead would re-create the mocked-seam blindness
  // that let three defects through a suite green on all of them.
  home = undefined,
  // Injected so a test can assert the SAME id reaches both `--session-id` and the composed
  // transcript path, without depending on the real generator's randomness. Real default is
  // `randomUUID`: pre-generating the id here (rather than parsing it back out of the worker log
  // after the fact) is what lets a caller compose the transcript path before the worker has
  // written a byte, and it means `--session-id` and `sessionFromWorkerLog`'s reading of the
  // stream-json log are two independent confirmations of the same session, not one derived
  // from the other.
  newSessionId = randomUUID,
  // A5. Defaults to THIS runner's own identity, stated by the code rather than read from config —
  // see `ARM`. Overridden by exactly one caller: Phase C's backfill, which reconstructs records
  // for runs performed by code that is not this code, and must be able to say `backfilled: true`
  // and name the arm that actually ran. Merged over the default rather than replacing it, so a
  // backfill that supplies only `notes` still gets a labelled record.
  provenance = null,
  // Forwarded to `resolveItem`, whose own defaults are the real `gh` and the real MCP fetch. Left
  // `undefined` here rather than defaulted, so that module stays the single place those defaults
  // are named — two copies of "what fetches an issue" drift, and the drift is invisible until a
  // run resolves a ticket through the stale one.
  gh = undefined,
  jiraFetch = undefined,
} = {}) {
  const root = typeof repoRoot === 'string' ? repoRoot : '';
  if (!root) return { ok: false, error: 'no repoRoot: nothing to work in', run_dir: null };

  // Step 1. A supplied config is used as given (bin/alfred loads it once and passes it down); an
  // absent one is LOADED and never invented, per §2.1's "no defaults for a missing config".
  let cfg = config;
  if (!cfg) {
    const loaded = loadConfig(root);
    if (!loaded.ok) return { ok: false, error: loaded.error, run_dir: null };
    cfg = loaded.config;
  }

  const runDir = newRunDir({ repoRoot: root, ref, runRoot, stamp });

  // Step 2. Resolve the item AND write the raw payload, before anything else happens. §2.1 calls
  // this non-negotiable and a bug fix: harness-core persisted a one-line excerpt, so no run there
  // is replayable.
  // THE `gh`/`jiraFetch` SEAM, FORWARDED RATHER THAN RE-IMPLEMENTED. `resolveItem` already takes
  // both with real defaults; `executeWork` was swallowing them, which meant every test of a step
  // AFTER item resolution had to route around the resolver — by passing a `ref` that lands on the
  // prompt path, and therefore by testing the steps below against an item with no criteria and no
  // id. That is mocked-seam blindness one layer out: the preflight only exists when criteria exist,
  // so a suite that can only reach it with zero criteria cannot see it at all.
  //
  // NOT AN `item` OVERRIDE. Handing `executeWork` a pre-built item would let a test assert against a
  // shape `item.mjs` never produces — the AC1..ACn ids the gate keys on are extracted by that
  // module's own parser, and a hand-written `{id: 'AC1'}` agrees with it only until it changes.
  // Injecting the FETCH keeps the extraction real and stubs only the network.
  const resolved = await resolveItem({ ref, config: cfg, runDir, gh, jiraFetch });
  if (!resolved.ok) return { ok: false, error: resolved.error, run_dir: runDir };
  const item = resolved.item;

  // Step 2b. #14 — IS THE TREE GRADEABLE. After the fetch and before the spawn, and both halves
  // of that placement are deliberate:
  //
  //   AFTER, so a refused tick leaves `source.json` on disk and an operator can see which item
  //   was refused. Ordered before the fetch, a refusal would be indistinguishable from a run
  //   that never started.
  //
  //   BEFORE, because the whole point is that nothing is spent. A dirty tree does not make the
  //   worker fail — it makes the verdict meaningless, and a meaningless verdict costs the same
  //   as a real one.
  //
  // A FAILED OBSERVATION IS NOT A CLEAN TREE. `observeTree` shells out to git, and a repoRoot
  // that is not a repository throws. Treated as "could not tell" and allowed through: the
  // not-a-git-repo case already has a stated verdict path of its own (see cli.test.mjs), and
  // converting every such run into a refusal here would move a diagnosable failure to a
  // misleading one. The gate still receives `diffstat: undefined` and #63's distinction holds.
  if (!allowDirty) {
    let dirty = [];
    try {
      dirty = await treeIsDirty({ repoRoot: root });
    } catch {
      dirty = [];
    }
    if (dirty.length > 0) {
      return { ok: false, error: dirtyRefusal(dirty), run_dir: runDir, dirty };
    }
  }

  // Step 3 is `resolveBase`, and it STILL is not called here — but the reason has changed, so the
  // comment has to. It used to read "a base this thin path cannot use is not resolved and then
  // quietly discarded", which was correct while nothing downstream created a branch. B3 added
  // `lib/delivery.mjs`, so the base is now both resolved and used — inside `deliver`, at Step 8,
  // which is the only code that can act on it.
  //
  // KEPT THERE RATHER THAN MOVED HERE. Resolving at this line would mean carrying a base through
  // the spawn, the gate and the reporter to reach the one function that uses it, and a value that
  // travels that far past its point of use is how #63/#69/#72/#73 all happened. `deliver` refusing
  // on a null base is also the only refusal that can be correct: at this point in the run a
  // missing base is not yet a problem, because a failed gate may mean nothing is delivered at all.

  // Step 4. The prompt and the flags, both from the modules that own them.
  const sessionId = newSessionId();
  let argv;
  try {
    argv = workerArgv({
      config: cfg,
      prompt: composeWorkerPrompt({ item, config: cfg, repoRoot: root }),
      appendSystemPrompt: standingRules(),
      maxTurns,
      sessionId,
    });
  } catch (err) {
    return { ok: false, error: err.message, run_dir: runDir };
  }

  // Step 5. Spawn and WAIT — with the preflight armed, if there is anything to check.
  //
  // `watch` IS UNDEFINED WHEN THERE ARE NO CRITERIA, not a predicate that always returns null.
  // `spawnWorker` creates no timer for a non-function, so `alfred work "fix the flaky test"` reads a
  // growing log zero times instead of every two seconds for a whole run to reach a conclusion that
  // was foregone before the spawn. `?? undefined` rather than passing null through for the same
  // reason: the option's default is what "unarmed" means, and this is the caller saying it.
  const logPath = join(runDir, 'worker.log');
  const watch = preflightWatch({
    criteria: item.acceptance_criteria ?? [],
    // The BODY, which is the only thing here that is not Alfred's own text. A quote is checked
    // against what the ticket actually said, not against the prompt Alfred composed from it —
    // otherwise Alfred's own contract text would count as a place a quote could be found, and a
    // worker echoing the contract's example would attest successfully to nothing.
    body: item.body ?? '',
  }) ?? undefined;
  let worker;
  try {
    worker = await spawnFn(argv, { cwd: root, logPath, runDir, env, wallCapMs, watch });
  } catch (err) {
    return { ok: false, error: err.message, run_dir: runDir, worker: null };
  }

  // THE VERDICT, AS A FACT ABOUT THE RUN. `worker.stopped` is the launcher reporting that the
  // predicate fired; this turns it into the shape `report.mjs`'s `preflightBlock` whitelists.
  //
  // `attested` IS NOT RECOMPUTED HERE, and that is a deliberate hole rather than an oversight. The
  // count lives inside `checkAttestation`'s verdict, which the predicate consumed and discarded to
  // satisfy `watch`'s `{reason, detail}` contract. Threading it back out would mean either widening
  // that contract — making the launcher carry a field only one caller understands — or re-reading
  // and re-grading the log after the fact, which is a second grader that can disagree with the
  // first. `null` says "not observed" rather than asserting a number nobody counted, which is this
  // project's absent-is-not-zero rule. The zero-criteria case is different and IS known: nothing
  // was declared, so nothing was attested, and `0` there is a measurement.
  const preflight = worker?.stopped
    ? { refused: true, reason: worker.stopped.reason, detail: worker.stopped.detail, attested: null, checks: [] }
    : { refused: false, reason: null, detail: null, attested: watch ? null : 0, checks: [] };

  // Step 6. Observe, then gate. OBSERVE FIRST and pass the result: `runGate` takes no default
  // for `diffstat`, so a runner that omits it silently disables `evidence_weakened` and
  // `instrument_modified` while the verdict reads exactly like a pass (#63).
  let observed = { diffstat: undefined, touched: [] };
  try {
    // `withEvidenceCounts` HERE and not in the pre-spawn dirty check: this is the observation
    // the gate grades, and `since` defaults to HEAD, which is the worker's true baseline
    // precisely because `treeIsDirty` refused to spawn against anything uncommitted.
    observed = await observeTree({ repoRoot: root, withEvidenceCounts: true });
  } catch (err) {
    // UNOBSERVED, and left as `undefined` rather than `[]`. `[]` would assert "no evidence was
    // weakened" off a measurement that failed, which is the exact collapse #63 removed.
    observed = { diffstat: undefined, touched: [], error: err.message };
  }

  const verdict = await gateFn({
    config: cfg,
    repoRoot: root,
    acs: item.acceptance_criteria ?? [],
    // The ac_map is read from the tree the worker wrote. Absent is `absent`, not clean —
    // `readAcMap`'s distinction, and the gate raises `ac_unmapped` from it.
    acMap: await readAcMapFrom(root),
    touched: observed.touched,
    diffstat: observed.diffstat,
  });

  const findings = [...(verdict.findings ?? [])];

  // A KILLED WORKER IS NOT A GRADED WORKER. §2.8's recorded failure was a killed run scored as a
  // completed one; the gate cannot see this, because from the tree's side a worker stopped
  // mid-sentence looks like one that chose to stop.
  if (worker?.killed) {
    findings.push({
      rule: 'check_failed',
      detail: `the worker was killed at the wall cap after ${worker.wall_ms}ms (${worker.signal ?? 'SIGTERM'})`,
      evidence: `log: ${worker.log}`,
    });
  }

  // NOR IS A WORKER THAT STOPPED FOR ITS OWN REASONS. The clause above only sees kills ALFRED
  // caused; `killed` is its own timer's flag. Measured on TARS-1351: the CLI hit
  // `--max-budget-usd 8`, terminated the worker mid-flight, and exited 0 with `killed: false`, so
  // that branch was false and the verdict came back PASS with zero findings on a truncated run.
  // The reason exists only in the log, which is why this reads the log and not the exit code.
  const terminal = terminalErrorFromWorkerLog(readLogText(worker?.log));
  if (terminal) {
    const spent = terminal.cost_usd === null ? '' : ` after $${terminal.cost_usd.toFixed(6)}`;
    const turns = terminal.turns === null ? '' : ` and ${terminal.turns} turns`;
    findings.push({
      rule: 'check_failed',
      detail:
        `the worker did not finish: the CLI reported ${terminal.reason}${spent}${turns}` +
        (terminal.errors.length > 0 ? ` — ${terminal.errors.join('; ')}` : ''),
      evidence: `log: ${worker?.log}`,
    });
  }

  // NOR IS A WORKER WE STOPPED AT THE PREFLIGHT. The third member of the same family, and the one
  // whose false-pass is most inviting: a worker stopped four seconds in has touched nothing, so from
  // the TREE's side it is indistinguishable from a worker that finished and correctly changed
  // nothing — a clean diff, no findings, and `pass = findings.length === 0` is TRUE. §2.8's recorded
  // failure exactly, at a new site. The gate cannot see a refusal; the runner has to say so.
  if (preflight.refused) {
    findings.push({
      rule: 'check_failed',
      detail: `the preflight refused this run (${preflight.reason}): ${preflight.detail ?? 'no detail'}`,
      evidence: `log: ${worker?.log}`,
    });
  }

  const gate = {
    ...verdict,
    findings,
    pass: findings.length === 0,
  };

  // Step 8. DELIVER — the branch, the commit, and on a pass the push and the draft PR.
  //
  // BEFORE STEP 7, THOUGH IT IS NUMBERED AFTER IT. The record has a `delivery` block that has been
  // `{commits: [], pushed_to: null, pr_url: null}` on every run ever made, because nothing filled
  // it; delivering after the record was written would leave it that way forever. So the numbering
  // follows §4's step list and the ORDER follows the data: deliver, then report what delivery did.
  //
  // AFTER THE GATE, and this is the part that cannot be reordered. `deliver` reads `gate.pass` to
  // decide whether to push. Running it earlier would either push ungraded work or need the verdict
  // it does not yet have.
  //
  // ANOTHER SIDECAR, same shape as Steps 7/7b/7c and the same argument with more at stake: the
  // worker ran, the money is spent, and the gate graded the tree. A `gh` outage or a rejected push
  // must read as "it was not delivered" and never as "the run failed" — a throw here reaches
  // `cli.mjs` as exit 2, which a scheduler retries at full price for a run that already happened.
  // `deliver` is documented never to throw; this is still caught, because a contract is not a
  // guarantee and the cost of being wrong is a repeated 25-minute run.
  //
  // `allowDirty` DOES NOT SUPPRESS DELIVERY, deliberately. A dirty tree already returned above, so
  // reaching this line with `allowDirty` set means an operator asked for a run against a tree they
  // know is dirty — and the commit that results is exactly what makes that inspectable afterwards.
  let delivery = null;
  try {
    delivery = await deliverFn({
      repoRoot: root,
      config: cfg,
      item,
      gate,
      runId: basename(runDir),
      preflight,
      // `recordPath` DOES NOT EXIST YET and is not passed. The PR body would like to name the
      // record, but the record needs delivery's result — so one of the two has to go first, and
      // naming a path that has not been written is the worse failure: it sends a reviewer to a file
      // that is not there. The run id is in the body, and that is the join key to the record.
      recordPath: null,
    });
  } catch (err) {
    delivery = {
      committed: false,
      branch: null,
      base: null,
      pushed: false,
      pr_url: null,
      steps: [],
      error: `deliver threw: ${String(err?.message ?? err)}`,
    };
  }

  // Step 7. Report. A SIDECAR, AND THE try/catch IS THE WHOLE POINT: the work landed, the gate
  // graded it, and an exception in the accounting must not turn that into a refusal. `main` reads
  // a throw as exit 2, which a scheduler retries — at full price, for a run that already
  // succeeded. So a broken reporter costs the record and nothing else, and says so.
  let record = null;
  let recordError = null;
  try {
    record = reportFn({
      // What the record needs to be joinable: the log to read the session id out of, and the cwd
      // the transcript was filed under. Both are things this function chose, which is why no
      // search is involved.
      workerLog: readLogText(worker?.log),
      cwd: root,
      home,
      work: {
        source: item.source ?? null,
        item_id: item.id ?? null,
        title: item.title ?? null,
        ac_count: item.acceptance_criteria?.length ?? null,
      },
      gate,
      // `sessionId` is the id THIS function generated at Step 4 and handed to the worker via
      // `--session-id` — known before the log exists, so `recordForRun` composes the transcript
      // path from it rather than waiting to parse it back out of the worker's own log.
      session: {
        id: sessionId,
        run_id: basename(runDir),
        repo: cfg.repo ?? null,
        wall_ms: worker?.wall_ms ?? null,
      },
      sink: cfg.telemetry?.sink ?? null,
      // A5. `ARM` first so a caller supplying only `notes` or only `backfilled` still gets an arm,
      // and NOT read from `cfg`: the arm is a property of the code executing this line, and a
      // config that outlived a rewrite of this runner would otherwise mislabel every run it
      // configured. `backfilled: false` is stated rather than left to the reporter's default,
      // because "a live run is not a backfill" is a fact this function knows and the reporter
      // only assumes.
      provenance: { arm: ARM, backfilled: false, ...(provenance ?? {}) },
      // B2. The verdict, onto disk. `result.preflight` being right proves nothing about what a
      // reader sees a week from now, and the record is the only thing that outlives the console
      // line — the exact gap between "computed" and "carried" that #63/#69/#72/#73 all are.
      preflight,
      // B3. WHAT DELIVERY DID. `report.mjs` has held this block since M2 and it has been three
      // empty fields on every record ever written, because no caller passed anything — its own
      // header says so: "both keys existed here and both were always empty". This is the caller.
      //
      // MAPPED, NOT SPREAD. `deliver` returns `{committed, branch, base, pushed, pr_url, head,
      // steps, error}` and the record's schema is `{commits, pushed_to, pr_url}`; spreading would
      // put `branch` and `pushed` into a record that names neither, and `reportRecord` would print
      // nothing for `pushed_to` while the data sat one key over. `head` is the commit sha, which is
      // what `commits` means, and it is `[]` rather than `[null]` when nothing was committed —
      // absent-is-not-zero, and a one-element array holding null reads as "one commit" to anything
      // that checks length.
      //
      // `pushed_to` IS THE BRANCH ONLY IF IT WAS PUSHED. A branch that exists locally is not a
      // place anything was pushed to, and recording it as one would make a failed push look like a
      // successful one in the only artifact that outlives the console.
      // `steps` AND `error` TOO, and they were missing until 2026-08-03. `buildRecord` accepts
      // both, carries both, and has a comment at that field about this precise failure mode — but
      // this object was hand-built with three keys, so the two it did not name were dropped one
      // layer ABOVE the code being careful about them. Measured on all three records that ever ran
      // delivery, including jarvis#11 whose commit `56162bc` exists on disk: `steps: []` on every
      // one. Enumerating keys by hand is the shape that keeps producing this (#63/#69/#72/#73, and
      // the backfill tool emptying `preflight`/`sink` the same day).
      //
      // `error` IS THE CONSEQUENTIAL HALF: null means "delivery raised nothing", so a run whose
      // PUSH FAILED wrote a record byte-identical to one whose push was skipped for a failed gate.
      // The console distinguished them at the time; the only artifact that outlives it did not.
      //
      // AND THIS IS THE SECOND HALF OF A FIX ALREADY MADE. `3aba45b` ("delivery.error was computed,
      // printed, and discarded") added both fields to `buildRecord` — the layer below — and looked
      // complete: report.mjs carried them, its own tests asserted it, and the suite was green. The
      // records stayed empty anyway, because THIS object is what report.mjs was handed. A fix
      // verified only at the layer it edited is not verified; what was missing was an assertion
      // that followed a real delivery all the way onto disk, which is what `ADDED D4` now does.
      delivery: {
        commits: delivery?.head ? [delivery.head] : [],
        pushed_to: delivery?.pushed ? delivery.branch : null,
        pr_url: delivery?.pr_url ?? null,
        steps: delivery?.steps ?? [],
        error: delivery?.error ?? null,
      },
    });
  } catch (err) {
    recordError = String(err?.message ?? err);
  }

  // Step 7b. AND ONTO DISK. Built-and-discarded is this project's recurring defect (#63, #69,
  // #72, #73): `buildRecord` computes cost.by_model, peak_context, subagents[], gaps[] and the
  // gate's findings, `reportRecord` prints four of those fields, and before this the rest reached
  // nothing. A run dir held `source.json` and `worker.log` — what the run was asked to do and the
  // worker's raw output — and nothing saying what it cost or how it was graded.
  //
  // SEPARATELY CAUGHT from the build above, and for a different failure: the reporter throwing
  // means there is no record, an unwritable path means there IS one and it stayed in memory. Both
  // are sidecar failures that must not fail a graded run, and a reader has to be able to tell
  // which happened, so the two errors are joined rather than one overwriting the other.
  // A SEPARATE FIELD, not appended to `record_error`. The first draft joined them and a mutant
  // caught it: `reportRecord` early-returns on `recordError` with "FAILED to build", so a record
  // that built perfectly and merely could not be written printed a false cause AND suppressed the
  // cost line — the one figure an operator most needs. Two failures, two names:
  //
  //   record_error        the reporter threw. There is no record.
  //   record_write_error  there IS a record; it stayed in memory.
  let recordPath = null;
  let recordWriteError = null;
  if (record) {
    try {
      const path = join(runDir, RECORD_FILENAME);
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
      recordPath = path;
    } catch (err) {
      recordWriteError = `could not write ${RECORD_FILENAME}: ${String(err?.message ?? err)}`;
    }
  }

  // Step 7c. Sync to the real sink. A THIRD sidecar, same reason as record_error/record_write_error
  // above: the graded run already happened, so a sink outage (network down, remote renamed, disk
  // full) must read as "the sync failed" and never as "the run failed". `syncFn` itself never
  // throws (see lib/telemetry.mjs), but this is still caught — a stub or a future change to that
  // contract must not be the thing that turns a successful run into a refusal.
  let sync = null;
  if (record) {
    try {
      sync = syncFn({ runDir, telemetry: cfg.telemetry ?? null, record });
    } catch (err) {
      sync = { synced: false, reason: `sync_threw: ${String(err?.message ?? err)}` };
    }
  }

  return {
    ok: true,
    error: null,
    run_dir: runDir,
    item,
    worker,
    gate,
    // The verdict as its own field, ALWAYS present. `worker.stopped` already carries whether the
    // predicate fired, but a caller reading that has to know what `stopped` means and that a
    // preflight is what arms it; this states the outcome directly, including the not-refused case,
    // so "we checked and found no false quote" and "we never checked" are distinguishable without
    // inference. `bin/alfred` prints from this and `cli.mjs` decides the exit code from it.
    preflight,
    // B3. THE FULL DELIVERY RESULT, not the three-field record projection. The record keeps what a
    // telemetry consumer needs; a caller here needs `branch` and `base` and `steps` too — a failed
    // push has to tell an operator which local branch holds the work, and `steps[]` is the only
    // place the sequence is legible. `null` only when delivery never ran at all.
    delivery,
    record,
    // Where it landed, or null. A caller that printed a path it had not written would send an
    // operator to a file that is not there.
    record_path: recordPath,
    record_write_error: recordWriteError,
    // Named rather than swallowed. A record that is absent for a reason nobody wrote down is
    // indistinguishable from a run nobody asked to report on.
    record_error: recordError,
    // Whether the record made it to the telemetry sink — `{ synced, reason? }` from `syncFn`, or
    // null when there was no record to sync in the first place.
    sync,
    observed_error: observed.error ?? null,
  };
}

// The worker's own result JSON. Unreadable is null, not an exception, for the sidecar reason
// above — and a killed worker, whose accounting matters most, is exactly the case that leaves a
// log that may not be there or may be half-written.
function readLogText(logPath) {
  if (!logPath) return null;
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
}

// Reads the ac_map the worker filed, if it filed one. Kept here rather than in acmap.mjs because
// that module is deliberately I/O-free — it parses text and says what it found.
async function readAcMapFrom(repoRoot) {
  const { AC_MAP_PATH, readAcMap } = await import('./acmap.mjs');
  const { readFileSync } = await import('node:fs');
  let text = null;
  try {
    text = readFileSync(join(repoRoot, AC_MAP_PATH), 'utf8');
  } catch {
    // Absent. `readAcMap(null)` returns state 'absent', which is what the gate should see.
  }
  return readAcMap(text).entries;
}
