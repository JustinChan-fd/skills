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
//   3. A WALL CAP THAT FIRES FROM OUTSIDE THE CHILD. `--max-budget-usd` is real but enforced
//      POST-TURN — a $0.001 cap let $0.0352 through — so it bounds a runaway across turns and
//      bounds nothing inside one. SIGTERM, not SIGKILL: the transcript the run is priced from
//      has to flush.
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
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { loadConfig } from './config.mjs';
import { resolveItem } from './item.mjs';
import { runGate } from './gate.mjs';
import { SEATS } from './models.mjs';
import { composeWorkerPrompt, standingRules } from './prompt.mjs';
import { workerArgv } from './router.mjs';

const execFileAsync = promisify(execFile);

// 25 minutes, the same number THRESHOLDS.armC.wallCapMs carries, and for the same reason: arm B
// ran 24.6 minutes and produced no PR, so a cap below that would kill runs before they can fail
// honestly and a cap far above it makes an unattended tick unbounded.
export const DEFAULT_WALL_CAP_MS = 25 * 60 * 1000;

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
const slug = (text) =>
  String(text ?? 'item')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';

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
export async function observeTree({ repoRoot, since = 'HEAD' } = {}) {
  const entries = new Map();

  const tracked = await numstat(repoRoot, ['diff', '--numstat', since, '--']);
  for (const line of tracked.split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!file) continue;
    // `-` for a binary file. Zero would read as "observed and unchanged", which is a claim this
    // cannot make, so it is carried as null and the gate's `Number(null) > 0` reads false.
    entries.set(file, {
      file,
      added: added === '-' ? null : Number(added),
      deleted: deleted === '-' ? null : Number(deleted),
    });
  }

  const untracked = await numstat(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  for (const file of untracked.split('\n')) {
    if (!file.trim()) continue;
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
  return { diffstat, touched: diffstat.map((e) => e.file) };
}

// Launches the worker and resolves once it has ended or been stopped.
//
// Everything about this function is one of the three measured gaps in the header. `bin` is a
// parameter so a test can launch a real child that is not `claude` — the seam has to be exercised
// for real, because a test asserting that a stubbed spawn received an env is blind to the spawn
// being wired wrong.
export function spawnWorker(
  argv,
  { bin = 'claude', cwd, logPath, env = process.env, seats = SEATS, wallCapMs = DEFAULT_WALL_CAP_MS } = {},
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
    child.once('error', (err) => {
      if (timer) clearTimeout(timer);
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

    child.once('close', (exit, signal) => {
      clearTimeout(timer);
      // Returns early on a launch failure: 'error' already rejected, and resolving after that
      // would be a no-op that reads in the code like a second outcome.
      if (closed) return;
      release();
      resolvePromise({
        exit,
        signal,
        killed,
        wall_ms: Date.now() - startedAt,
        pid: child.pid ?? null,
        log: logPath,
      });
    });
  });
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
  spawn: spawnFn = spawnWorker,
  gate: gateFn = runGate,
  report: reportFn = null,
  env = process.env,
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
  const resolved = await resolveItem({ ref, config: cfg, runDir });
  if (!resolved.ok) return { ok: false, error: resolved.error, run_dir: runDir };
  const item = resolved.item;

  // Step 3 is `resolveBase`, and it belongs to delivery rather than to the worker — nothing here
  // creates a branch yet. Deliberately not called, so that a base this thin path cannot use is
  // not resolved and then quietly discarded.

  // Step 4. The prompt and the flags, both from the modules that own them.
  let argv;
  try {
    argv = workerArgv({
      config: cfg,
      prompt: composeWorkerPrompt({ item, config: cfg, repoRoot: root }),
      appendSystemPrompt: standingRules(),
      maxTurns,
    });
  } catch (err) {
    return { ok: false, error: err.message, run_dir: runDir };
  }

  // Step 5. Spawn and WAIT.
  const logPath = join(runDir, 'worker.log');
  let worker;
  try {
    worker = await spawnFn(argv, { cwd: root, logPath, runDir, env, wallCapMs });
  } catch (err) {
    return { ok: false, error: err.message, run_dir: runDir, worker: null };
  }

  // Step 6. Observe, then gate. OBSERVE FIRST and pass the result: `runGate` takes no default
  // for `diffstat`, so a runner that omits it silently disables `evidence_weakened` and
  // `instrument_modified` while the verdict reads exactly like a pass (#63).
  let observed = { diffstat: undefined, touched: [] };
  try {
    observed = await observeTree({ repoRoot: root });
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

  const gate = {
    ...verdict,
    findings,
    pass: findings.length === 0,
  };

  // Step 7. Report, if a reporter was supplied. Null rather than a default, because the record
  // needs a transcript path this slice does not yet know how to find — and a reporter called with
  // a guessed path would produce a record about the wrong session.
  const record = reportFn ? reportFn({ item, config: cfg, gate, worker, runDir }) : null;

  return {
    ok: true,
    error: null,
    run_dir: runDir,
    item,
    worker,
    gate,
    record,
    observed_error: observed.error ?? null,
  };
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
