// cli — argv in, exit code out. The parse, the refusals, and PLAN.md §2.1 step 8.
//
// WHY THIS IS NOT bin/alfred ITSELF. §1's layout asks for "one script with subcommands so the
// slash command and cron invoke the *same* code path", and that is still what exists: one
// `main`, reached one way. The parse lives in a `.mjs` because the refusals below are the whole
// value of the layer, and a refusal inside an extensionless shebang script cannot be imported,
// cannot be asserted on, and therefore cannot be watched failing. bin/alfred is a shebang and a
// call — and test/cli.test.mjs still LAUNCHES it, because a missing shebang, a non-executable
// file, and an off-by-one in `argv.slice` are all invisible to an import and fatal to a tick.
//
// THREE EXIT CODES, AND THE DISTINCTION IS THE POINT OF THE SLICE:
//
//   0  the gate passed.
//   1  a worker ran, cost money, and the gate said no. Ordinary rework.
//   2  REFUSED before spending anything. The operator's input or the config is wrong.
//
// Collapsing 1 and 2 breaks the loop in both directions: an unattended tick that reads a
// misconfiguration as a failed run retries it forever at full price, and one that reads a
// failed run as a misconfiguration stops retrying work that failed honestly. §2.2 asks the loop
// to tell "nothing to do" from "something went wrong"; this is the mechanism it will read.
//
// EVERY UNKNOWN FLAG IS REFUSED, and that is not pedantry — it is the measured behaviour of the
// tool underneath. The vendor CLI accepted `bogus_key_xyz` inside `--agents` without a warning,
// and accepted `maxTokens: 999999` on a call where the subagent verifiably ran. lib/router.mjs
// refuses an unknown subagent seat for exactly that reason. The same argument applies one layer
// out: `--dryrun` silently ignored is a real run the operator believed was a rehearsal, and the
// bill arrives before the misunderstanding does.

import { CONFIG_RELATIVE_PATH, loadConfig } from './config.mjs';
import { DEFAULT_WALL_CAP_MS, executeWork, newRunDir, spawnWorker } from './run.mjs';
import { composeWorkerPrompt, standingRules } from './prompt.mjs';
import { resolveItem } from './item.mjs';
import { workerArgv } from './router.mjs';

export const EXIT = Object.freeze({
  pass: 0,
  gate_failed: 1,
  refused: 2,
});

const COMMANDS = Object.freeze(['work', 'loop']);

export function usage() {
  return [
    'usage: alfred <command> [options]',
    '',
    'commands:',
    '  work <ref>        run one work item to a verdict. <ref> is a github issue',
    '                    reference (acme/jarvis#4, #4, or an issue URL) or a plain',
    '                    sentence, which becomes a prompt-sourced item with no',
    '                    acceptance criteria and none invented.',
    '  loop              poll the configured source and work one item. NOT BUILT.',
    '',
    'options:',
    '  --repo <path>            repository to work in (default: cwd)',
    '  --run-root <path>        where run artifacts go (default: a sibling of the repo,',
    '                           never inside it — the gate scores the working tree)',
    '  --max-turns <n>          hand --max-turns to the worker',
    '  --wall-cap-minutes <n>   kill the worker after n minutes (default:',
    `                           ${DEFAULT_WALL_CAP_MS / 60000})`,
    '  --worker-bin <path>      the binary to spawn (default: claude)',
    '  --dry-run                compose everything, spawn nothing, print the argv',
    '  --allow-dirty            grade a tree that already has uncommitted changes.',
    '                           Refused by default: the gate scores the diff against',
    '                           HEAD, so pre-existing edits are attributed to the',
    '                           worker. Nothing is ever cleaned either way.',
    '  --help                   print this and exit 0',
    '',
    'exit codes: 0 the gate passed, 1 a run was graded and failed, 2 refused before',
    'anything spent. A scheduler must be able to tell 1 from 2.',
  ].join('\n');
}

// A refusal carried as a value rather than thrown across the process boundary. `main` turns it
// into exit 2 and a line on stderr; `parseArgv` throws so a caller in-process gets a stack.
class Refusal extends Error {}

const flagNeedsValue = (flag, value) => {
  // THE SILENT-CORRUPTION SHAPE. `--repo --dry-run` naively parsed yields `repo: '--dry-run'`,
  // and the run is then graded against a directory of that name. The eventual error is about a
  // missing path and points nowhere near the typo.
  if (value === undefined || String(value).startsWith('--')) {
    throw new Refusal(`${flag} needs a value, and '${value ?? ''}' looks like the next flag`);
  }
  return value;
};

const positiveInt = (flag, raw) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Refusal(`${flag} must be a positive whole number, got ${JSON.stringify(raw)}`);
  }
  return n;
};

export function parseArgv(argv = []) {
  const args = [...argv];
  const command = args.shift();

  if (command === '--help' || command === '-h') return { command: 'help' };
  if (command === undefined) throw new Refusal('no command given');
  if (!COMMANDS.includes(command)) {
    throw new Refusal(`unknown command '${command}': expected one of ${COMMANDS.join(', ')}`);
  }

  const parsed = {
    command,
    ref: null,
    repo: null,
    runRoot: null,
    maxTurns: null,
    // Imported, never a second literal. A `25` typed here would drift from the constant the
    // spawn actually uses, and the record would state a cap the run did not run under.
    wallCapMs: DEFAULT_WALL_CAP_MS,
    workerBin: null,
    dryRun: false,
    // #14. FALSE, not undefined, and declared here rather than left to the switch alone. An
    // absent key is falsy too, so a flag registered in the switch and forgotten here would
    // appear to work while `parsed.allowDirty` was never anything but undefined — and the test
    // asserting the default would be asserting nothing.
    allowDirty: false,
    help: false,
  };

  const rest = [];
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--repo':
        parsed.repo = flagNeedsValue(arg, args.shift());
        break;
      case '--run-root':
        parsed.runRoot = flagNeedsValue(arg, args.shift());
        break;
      case '--worker-bin':
        parsed.workerBin = flagNeedsValue(arg, args.shift());
        break;
      case '--max-turns':
        parsed.maxTurns = positiveInt(arg, flagNeedsValue(arg, args.shift()));
        break;
      case '--wall-cap-minutes':
        parsed.wallCapMs = positiveInt(arg, flagNeedsValue(arg, args.shift())) * 60 * 1000;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--allow-dirty':
        parsed.allowDirty = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Refusal(
            `unknown flag '${arg}'. Refused rather than ignored: the CLI underneath accepts ` +
              'unknown keys silently, and a flag believed to be doing something is worse than ' +
              'one that is missing.',
          );
        }
        rest.push(arg);
    }
  }

  // THE REF IS ONE ARGUMENT, TAKEN WHOLE. A prompt-sourced item is a sentence, and joining the
  // leftovers would silently accept `alfred work make the retry configurable` as five words
  // while `--retry` inside it would already have been refused above as a flag. One argument,
  // quoted by the caller, is the only unambiguous reading.
  if (rest.length > 1) {
    throw new Refusal(
      `expected one work item, got ${rest.length} arguments (${rest.map((r) => JSON.stringify(r)).join(', ')}). ` +
        'Quote a prompt-sourced item so it arrives as one argument.',
    );
  }
  parsed.ref = rest[0] ?? null;

  return parsed;
}

// The accounting, printed for the same reader. A record built and never mentioned is the shape
// this project keeps finding in its own instruments: `report` is wired now, but a run whose books
// silently failed to balance looks on the console exactly like one whose books balanced.
//
// BOTH COST FIGURES OR NEITHER. `total_usd` is ours, from the copied price table; `vendor_usd` is
// what the CLI said it charged. Their agreeing is the only evidence the copy is right, and an
// operator shown one of them cannot notice the day they diverge.
//
// A NULL COST IS A SENTENCE, NOT A BLANK. `total_usd: null` means we could not read the spend —
// printed as such, because a missing line reads as "cheap" and `$0.00` reads as "free".
export function reportRecord(record, { out, recordError = null, recordPath = null, recordWriteError = null }) {
  if (recordError) {
    // The reporter itself threw. Said out loud and NOT fatal: the record is a sidecar, and a
    // scheduler that reads a failed report as a failed run retries a succeeded one at full price.
    out(`record: FAILED to build — ${recordError}`);
    return;
  }
  if (!record) {
    out('record: none was built for this run');
    return;
  }

  const cost = record.cost ?? {};
  const ours = typeof cost.total_usd === 'number' ? `$${cost.total_usd.toFixed(6)}` : 'unreadable';
  const vendor = typeof cost.vendor_usd === 'number' ? `$${cost.vendor_usd}` : 'unreported';
  out(`record: ${record.ok ? 'ok' : 'INCOMPLETE'} cost ${ours} (vendor ${vendor})`);

  // The reason, on its own line. `ok: false` without a cause is indistinguishable from a run
  // nobody asked to report on.
  if (!record.ok && record.error) out(`  reason: ${record.error}`);

  // HOW THE RUN STOPPED, when something stopped it. Printed here because `record: ok cost $6.03`
  // is otherwise the whole console summary of a run that was cut off at the wall cap with 12 edits
  // half-applied — `ok` reports on the ACCOUNTING, and the accounting of a truncated run succeeds.
  // The gate's findings do carry the prose, but they print further down and behind a failed gate;
  // this is the cost line's own sibling.
  //
  // SILENT ON A CLEAN RUN, the rule `reportSync` and `reportDelivery` both follow: a "not stopped"
  // line on every successful tick is how an operator learns to skip the line that means something.
  if (record.stop?.killed || record.stop?.reason) {
    const at = Number.isFinite(record.stop.at_ms) ? ` at ${Math.round(record.stop.at_ms / 1000)}s` : '';
    const sig = record.stop.signal ? ` (${record.stop.signal})` : '';
    out(`  STOPPED SHORT: ${record.stop.reason ?? 'unknown reason'}${at}${sig}`);
  }
  // A gap does not condemn the record — it says which part of a record worth reading is missing.
  for (const gap of record.gaps ?? []) out(`  gap ${gap.code}: ${gap.detail ?? ''}`.trimEnd());

  // WHERE IT LANDED, and only when it actually did. The console keeps four fields; the file keeps
  // cost.by_model, peak_context, subagents[], gaps[] and the gate's findings. An operator who is
  // not told the path has the same audit gap one directory over.
  //
  // Printed from what the writer RETURNED, never composed here: a path this function built would
  // be right about where the record belongs and silent about whether it arrived.
  if (recordPath) out(`  saved to ${recordPath}`);
  // AFTER the cost lines, not instead of them. A write failure means the figures above are the
  // only surviving copy, which makes suppressing them the exact wrong response — the first draft
  // of this routed the write error through `recordError` and did precisely that.
  else if (recordWriteError) out(`  NOT SAVED — ${recordWriteError}`);
}

// Where the record went, or did not (A4). `executeWork` has returned `result.sync` since the sink
// was wired and `main` printed none of it — the same computed-and-discarded shape as #63/#69/#72/
// #73, in the one field that says whether the accounting left this machine.
//
// LOCAL-ONLY IS NAMED, NOT IMPLIED. `{synced: true, remote: null}` means the record is committed in
// exactly one place; printed as a bare "synced" it reads as "safe off-machine", which is the
// misreading that matters when the disk it is on is the only copy.
//
// AN UNCONFIGURED SINK IS SILENT. Most repos carry no telemetry block, and a "NOT SYNCED" line on
// every one of those runs is how an operator learns to skip the line that means something.
export function reportSync(sync, { out }) {
  if (!sync) return;
  if (!sync.synced) {
    if (sync.reason === 'telemetry_not_configured') return;
    out(`sink: NOT SYNCED — ${sync.reason ?? 'no reason given'}`);
    return;
  }
  const where = sync.remote ? `pushed to ${sync.remote}` : 'local only, no remote configured';
  out(`sink: ${sync.path ?? '(path not reported)'} (${where})`);
}

// B3. WHERE THE WORK WENT, which is the one thing a run could do that nobody was told about. Found
// by a test, not by reading: the end-to-end delivery test asserted the PR url appeared in the output,
// the push had really landed and `gh pr create --draft` had really run, and the output said only
// `gate: PASS`. Alfred pushed a branch to a remote and opened a pull request, and its own operator
// had no way to know from the tick's output — they would have to open `record.json` to find out
// something had been published on their behalf. That is the worst version of the project's
// computed-and-discarded defect (#63/#69/#72/#73): the value was not dropped from a record, it was
// dropped from the notification of an outward-facing side effect.
//
// FOUR OUTCOMES, EACH ITS OWN LINE, because collapsing them is how "delivered" comes to mean nothing:
// nothing to deliver, committed but deliberately not pushed, pushed, and pushed-but-the-PR-failed.
//
// SILENT WHEN THERE WAS NOTHING TO DELIVER, on the same argument as `reportSync`'s unconfigured sink:
// a line on every no-op run teaches an operator to skip the line that matters.
export function reportDelivery(delivery, { out }) {
  if (!delivery) return;

  // A FAILURE BEFORE ANYTHING HAPPENED still prints, unlike a clean no-op: a refusal or a git error
  // means the run's diff may exist nowhere, which an operator needs to know now rather than next tick.
  if (!delivery.committed) {
    if (delivery.error) out(`delivery: NOT DELIVERED — ${delivery.error}`);
    return;
  }

  const where = delivery.branch ?? '(branch not reported)';
  if (!delivery.pushed) {
    // THE VERDICT IS THE REASON, and saying so matters: an operator seeing "not pushed" under a
    // failed gate should read it as the rule working, not as delivery breaking.
    const why = delivery.error ? `— ${delivery.error}` : '— the gate did not pass, so nothing was pushed';
    out(`delivery: committed to ${where} locally ${why}`);
    return;
  }

  if (delivery.pr_url) {
    out(`delivery: pushed ${where} — DRAFT pr ${delivery.pr_url}`);
    return;
  }
  // PUSHED WITH NO PR. Either `mode: 'push'` (no PR was ever wanted) or `gh` failed after the push
  // landed — and the second is the case this line exists for, because the bytes are on the remote
  // whether or not a pull request wraps them.
  //
  // "NOT opened" AND "no pr requested" ARE FAR APART ON PURPOSE. The first draft said "but NO pr:"
  // for the failure, and the falsifier test caught that `/NO pr/i` matches "(no pr requested)" too —
  // so the two opposite outcomes were one case-insensitive regex apart. That is the shared-name /
  // distinct-path hazard in prose: a reader skimming for "no pr" could not tell a healthy `push`-mode
  // run from a PR that failed to open. Fixed in the strings rather than in the assertion, because the
  // assertion was reporting a real ambiguity in the output an operator reads.
  if (delivery.error) out(`delivery: pushed ${where} — the pr was NOT opened: ${delivery.error}`);
  else out(`delivery: pushed ${where} (no pr requested)`);
}

// The verdict, printed for whoever reads the tick's output. Findings first: an operator reading
// a failure wants the rule that fired, not the run's plumbing.
export function reportVerdict(gate, { out }) {
  out(`gate: ${gate.pass ? 'PASS' : 'FAIL'}`);
  for (const finding of gate.findings ?? []) {
    out(`  ${finding.rule}: ${finding.detail ?? ''}`);
    if (finding.evidence) out(`    evidence: ${finding.evidence}`);
  }
  // UNVERIFIED IS NOT A FINDING and does not fail the run — `runGate`'s conjunction is over
  // findings only. It is printed because a criterion nobody could check is the thing a human
  // most needs to see, and swallowing it is how "verified" comes to mean "nothing objected".
  for (const item of gate.unverified ?? []) {
    // `worker-declared` is printed because the label's whole purpose is preventing a
    // misreading (#72): an entry the worker volunteered and a criterion from the ticket,
    // printed identically, send an operator hunting the ticket for a bar nobody set there.
    const origin = item.worker_declared ? ' [worker-declared]' : '';
    out(`  unverified:${origin} ${item.ac ?? item.id ?? ''} ${item.detail ?? item.reason ?? ''}`.trimEnd());
  }
  if (gate.blocked_reason) out(`blocked: ${gate.blocked_reason}`);
}

export async function main(
  argv = process.argv.slice(2),
  { out = console.log, err = console.error, cwd = process.cwd() } = {},
) {
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (e) {
    err(String(e.message));
    err('');
    err(usage());
    return EXIT.refused;
  }

  if (parsed.command === 'help' || parsed.help) {
    out(usage());
    return EXIT.pass;
  }

  // NOT EXIT 0. §2.2 asks that a no-op tick be indistinguishable from a healthy one, which is
  // exactly why an unbuilt loop must not exit 0: once cron is pointed at it, a silent success is
  // a loop that appears to patrol and does nothing. It refuses until there is a lock and a poll.
  if (parsed.command === 'loop') {
    err(
      'alfred loop is not yet built: it needs the lock file and the source poll of PLAN.md §2.2. ' +
        'Refusing rather than exiting 0, because a scheduler cannot tell a silent success from ' +
        'a tick that patrolled and found nothing.',
    );
    return EXIT.refused;
  }

  if (!parsed.ref) {
    err('alfred work needs a work item: an issue ref, or a quoted sentence to work on');
    err('');
    err(usage());
    return EXIT.refused;
  }

  const repoRoot = parsed.repo ?? cwd;

  // LOADED HERE, ONCE, AND PASSED DOWN. `executeWork` accepts a config so there is one read per
  // run; doing it here is what lets the refusal below name the file before a run directory has
  // been created for a run that is not going to happen.
  const loaded = loadConfig(repoRoot);
  if (!loaded.ok) {
    err(loaded.error);
    // Named explicitly. `loadConfig`'s message carries the relative path, and an operator in the
    // wrong directory needs the absolute one to see which tree it looked in.
    err(`looked for: ${repoRoot}/${CONFIG_RELATIVE_PATH}`);
    return EXIT.refused;
  }
  const config = loaded.config;

  if (parsed.dryRun) return dryRun({ parsed, config, repoRoot, out, err });

  // The worker binary is injected through the spawn rather than read from the environment, so a
  // test can substitute a stub and everything else on the path runs for real.
  const spawn = parsed.workerBin
    ? (args, opts) => spawnWorker(args, { ...opts, bin: parsed.workerBin })
    : spawnWorker;

  let result;
  try {
    result = await executeWork({
      ref: parsed.ref,
      config,
      repoRoot,
      runRoot: parsed.runRoot,
      maxTurns: parsed.maxTurns,
      wallCapMs: parsed.wallCapMs,
      allowDirty: parsed.allowDirty,
      spawn,
    });
  } catch (e) {
    // A crash reaching the operator as a stack trace is a tick with no record of why it died.
    // `executeWork` returns results rather than throwing; this is the backstop for the case it
    // does not anticipate, and it is deliberately a refusal — nothing here can tell whether the
    // worker spent anything, and reporting a graded failure it cannot substantiate is worse.
    err(`alfred failed before reaching a verdict: ${e?.message ?? e}`);
    return EXIT.refused;
  }

  if (result.run_dir) out(`run dir: ${result.run_dir}`);

  if (!result.ok) {
    err(result.error);
    return EXIT.refused;
  }

  // THE WORKER'S EXIT CODE IS EVIDENCE, NOT THE VERDICT. `claude -p` exits non-zero on a budget
  // stop and on an API error, and both leave a tree the gate can score; a worker that exits 0
  // having done nothing must not pass on its own say-so. So this is reported and the gate sets
  // the code.
  const worker = result.worker ?? {};
  out(
    `worker: exit ${worker.exit ?? '?'}${worker.signal ? ` (${worker.signal})` : ''}` +
      `${worker.killed ? ' KILLED at the wall cap' : ''} in ${worker.wall_ms ?? '?'}ms`,
  );
  if (worker.log) out(`worker log: ${worker.log}`);

  // THE PREFLIGHT, SAID OUT LOUD, and to stderr because it is a refusal. Without this the line above
  // reads `worker: exit 0 (SIGTERM) in 4000ms` — a healthy-looking short run — and the only trace of
  // WHY is a `check_failed` finding among however many others the gate raised. An operator seeing a
  // four-second run and no stated cause reasonably concludes the worker crashed, and debugs the
  // wrong thing.
  //
  // ONLY WHEN REFUSED. A line on every run saying the preflight found nothing would be asserting the
  // attestation was TRUE, which a substring check cannot establish — it can only ever refuse. See
  // lib/preflight.mjs's header on why nothing in this path is named `ok`, `pass`, or `verified`.
  if (result.preflight?.refused) {
    err(`preflight REFUSED this run (${result.preflight.reason}): ${result.preflight.detail ?? 'no detail'}`);
    err('the worker was stopped in its first turn. Nothing it claimed afterwards was checked, because');
    err('there was nothing afterwards — this is a refusal that cost one turn, not a graded run.');
  }
  if (result.observed_error) {
    // Said out loud. An unobserved tree means the evidence rules returned without a verdict
    // (#63), so the gate's silence on them is not a clean bill of health.
    err(`tree not observed: ${result.observed_error} — the evidence rules could not run`);
  }

  reportRecord(result.record ?? null, {
    out,
    recordError: result.record_error ?? null,
    recordPath: result.record_path ?? null,
    recordWriteError: result.record_write_error ?? null,
  });
  reportSync(result.sync ?? null, { out });
  // BEFORE THE VERDICT, deliberately. The verdict is the last thing printed because it is what an
  // operator scans for; a delivery line after it would be read as a footnote to the verdict rather
  // than as the run's outward-facing side effect.
  reportDelivery(result.delivery ?? null, { out });
  reportVerdict(result.gate ?? { pass: false, findings: [] }, { out });

  return result.gate?.pass ? EXIT.pass : EXIT.gate_failed;
}

// The rehearsal. Everything up to the spawn, and it SAYS it did not spawn — "composed the argv"
// and "ran the worker" printing the same thing is the false-success shape this project keeps
// finding in its own instruments.
async function dryRun({ parsed, config, repoRoot, out, err }) {
  // A REHEARSAL STILL FETCHES, SO IT STILL WRITES. `resolveItem` writes `source.json` and takes
  // no default for where — measured here by passing null and getting "could not write
  // source.json: path must be of type string". That refusal is correct: §2.1 calls persisting the
  // raw payload non-negotiable because harness-core's fetch-once-with-no-copy left no run
  // replayable, and a dry run that fetched a ticket and discarded it would be that same defect on
  // the path an operator uses to check what is about to happen.
  const runDir = newRunDir({ repoRoot, ref: parsed.ref, runRoot: parsed.runRoot });
  const resolved = await resolveItem({ ref: parsed.ref, config, runDir });
  if (!resolved.ok) {
    err(resolved.error);
    return EXIT.refused;
  }

  let argv;
  try {
    argv = workerArgv({
      config,
      prompt: composeWorkerPrompt({ item: resolved.item, config, repoRoot }),
      appendSystemPrompt: standingRules(),
      maxTurns: parsed.maxTurns,
    });
  } catch (e) {
    err(String(e?.message ?? e));
    return EXIT.refused;
  }

  out('DRY RUN: the worker did not run and nothing was spent.');
  out(`item: ${resolved.item.id} (${resolved.item.source})`);
  out(`repo: ${repoRoot}`);
  out('argv:');
  for (const [i, arg] of argv.entries()) {
    // The prompt and the system prompt are long enough to bury every flag after them, and the
    // flags are the reason anyone runs a rehearsal. Elided with their real length, so a prompt
    // that came out empty is still visible as one.
    const shown = arg.length > 120 ? `${arg.slice(0, 117)}… [${arg.length} chars]` : arg;
    out(`  [${i}] ${shown}`);
  }
  return EXIT.pass;
}
