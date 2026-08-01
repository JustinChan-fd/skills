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

import { relative } from 'node:path';

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
  if (result.observed_error) {
    // Said out loud. An unobserved tree means the evidence rules returned without a verdict
    // (#63), so the gate's silence on them is not a clean bill of health.
    err(`tree not observed: ${result.observed_error} — the evidence rules could not run`);
  }

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

// A path shown relative when it is inside the repo and absolute when it is not. Kept because the
// run dir is deliberately outside and that is worth being able to see at a glance.
export function displayPath(path, repoRoot) {
  const rel = relative(repoRoot, path);
  return rel.startsWith('..') ? path : rel;
}
