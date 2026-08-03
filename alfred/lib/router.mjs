// router — config in, argv array out. No spawn, no model call, no I/O.
//
// PLAN.md §6: "A table and two flags. Not a service, not a phase, not a model call." The table
// is lib/models.mjs. This is the two flags.
//
// WHAT THE CLI ACTUALLY ENFORCES, measured against the live gateway rather than read off the
// help text, because three of this project's last four defects were controls that could not
// fire and encoding a flag's semantics on faith is how a fourth gets written:
//
//   --agents `model`    REAL. Forced a delegation and `modelUsage` came back with two entries,
//                       `anthropic.claude-sonnet-5` and `claude-haiku-4-5` — the subagent was
//                       billed at the tier named here.
//   --agents anything   IGNORED, SILENTLY. `{"probe":{...,"bogus_key_xyz":1}}` ran clean, and
//   else                so did `maxTokens: 999999` — a value far above every published ceiling,
//                       on a call where the subagent verifiably ran. An unknown key is not
//                       rejected, not warned about, not forwarded.
//
// The consequence is the design: NO TOKEN CEILING IS WRITTEN INTO THE --agents PAYLOAD. Not
// `maxTokens`, not `token_budget`. Either one would read in the config like a spend cap while
// having no effect at all, which is worse than no cap — it makes the file look protected.
// PLAN.md §M5 asks for "per-tier ceilings" in that payload; that is not a thing the CLI can do,
// and the frozen test name is kept while what it asserts follows the measurement.
//
// `--max-budget-usd` WAS HERE, AND WAS REMOVED (2026-08-02). It is a real, CLI-enforced dollar
// ceiling — measured: a $0.001 cap returned `is_error: true, subtype: error_max_budget_usd,
// terminal_reason: budget_exhausted`. But a from-scratch isolation experiment (a synthetic
// 12-file task, one Alfred-specific flag varied at a time) found it is ALSO the specific cause
// of a cache-breakpoint freeze: with it present, `cache_creation_input_tokens` was 0 on every
// turn and `cache_read_input_tokens` stayed pinned at its first-turn value for the run's entire
// duration, forcing every later turn to resend the whole growing context uncached. Identical
// freeze at $8 and at $1000, so it is the flag's PRESENCE and not its value. Removing it —
// `--agents`, `--append-system-prompt`, and `--session-id` all still present — restored normal
// climbing `cache_read`. On the real TARS-1351 run, this flag is the likely majority cause of
// $6.10 of $7.49 being uncached input. A dollar cap that roughly quadruples the dollars it caps
// is not a net safety win, so it is gone; `--max-turns` and `--wall-cap-minutes` (lib/run.mjs's
// external kill) remain as the runaway bounds. Neither is a dollar cap — that gap is accepted
// rather than hidden, and `config.budget_usd` is gone with it rather than left as a setting that
// reads as applied and no longer is.
//
// So the $11.98 lesson (an unbounded subagent burning 3.9M tokens) rests on ONE thing now:
// SEATS[seat].token_budget as Alfred's own accounting, enforced by whoever is watching the
// subagent — exported here as `seatBudgets` so it is available to be enforced rather than
// implied. An unenforced budget in a variable does not pretend the vendor is checking it.

import { SEATS, ceilingFor, normalizeModelId } from './models.mjs';

// The subagent tiers, and the two omissions are the point. `worker`/`fallback` are the main
// context rather than subagents. `adjudicator` is absent so that opus cannot be arrived at by
// omission — PLAN.md §4: "models.agents has no opus entry by default. Escalation is explicit."
export const AGENT_SEATS = Object.freeze(['scan', 'reason']);

// Each tier's brief. These reach the model, so they say what the seat is FOR — a description
// that does not distinguish the tiers gives the delegating context no basis to pick one, and it
// will default to whatever it read last.
//
// Exported so lib/prompt.mjs can tell the WORKER these seats exist, byte-identically. `--agents`
// wires a seat so the CLI will honour a delegated call, but this module's own header is explicit
// that it only measured the routing effect — nothing about that payload tells the main context a
// seat is there to be reached for. A worker never told a seat exists has no basis to delegate to
// it. Same anti-drift reason the marker/ac_map contracts are imported rather than retyped: two
// copies of "what scan is for" disagree eventually, and the worker reading the stale one
// delegates on the wrong basis.
export const AGENT_BRIEFS = Object.freeze({
  scan: {
    description:
      'Mechanical reads with no judgement: list files, grep for a symbol, report what is on ' +
      'disk. Use for lookups whose answer is a fact rather than an argument.',
    prompt:
      'You report what is in the repository, exactly as it is. Quote paths and line numbers. ' +
      'If the answer is not in the files you read, say that instead of inferring it. You do ' +
      'not judge whether the code is good and you do not propose changes.',
  },
  reason: {
    description:
      'Reads a diff, a ticket, or a body of code and judges it. Use when the question needs ' +
      'an argument rather than a lookup.',
    prompt:
      'You judge what you are given and state the judgement plainly, with the evidence that ' +
      'supports it. A false premise in a ticket is a finding to report, not an obstacle to ' +
      'work around. Say what you are uncertain about rather than resolving it silently.',
  },
});

// Alfred's own per-seat accounting, which is NOT in the argv because the CLI does not enforce
// it. Exported so a caller can enforce it by stopping the subagent; returning it from here
// keeps one source for both halves of the routing decision.
export function seatBudgets() {
  return Object.fromEntries(AGENT_SEATS.map((name) => [name, SEATS[name].token_budget]));
}

export function agentsPayload(config) {
  const overrides = config?.models?.agents ?? {};

  // The CLI will not catch an operator's typo — measured: it accepted `bogus_key_xyz` without
  // complaint. So `agnets: {...}` or `scna: {...}` would sit in the config file looking applied
  // while the real seat ran on its default. This is the only place that can fail.
  for (const name of Object.keys(overrides)) {
    if (!AGENT_SEATS.includes(name)) {
      throw new Error(
        `unknown subagent seat '${name}': known seats are ${AGENT_SEATS.join(', ')}. ` +
          'A misspelled seat is silently ignored by the CLI, so it is refused here.',
      );
    }
  }

  const payload = {};
  for (const name of AGENT_SEATS) {
    const model = overrides[name]?.model ?? SEATS[name].model;

    // Throws on an unpublished id. Called for that effect: a typo should fail before anything
    // spawns, not on the rejected request in the middle of an unattended tick.
    ceilingFor(model);

    // The $11.98 lesson as a refusal. A subagent tier may be retuned within its class, but
    // routing one to opus is an escalation and escalation is explicit, logged, and adjudicated
    // — never a line in a per-repo config file.
    if (/opus/i.test(normalizeModelId(model))) {
      throw new Error(
        `subagent seat '${name}' is set to '${model}': no subagent tier may route to opus. ` +
          'Opus is the adjudicator seat, reached by explicit escalation with a logged reason.',
      );
    }

    // `description`, `prompt`, `model` — the three keys measured to have an effect. Nothing
    // else, on purpose. See the header: an extra key here is inert and reads as a control.
    payload[name] = { ...AGENT_BRIEFS[name], model };
  }
  return payload;
}

export function workerArgv({ config, prompt, appendSystemPrompt, maxTurns, sessionId } = {}) {
  // loadConfig's rule applied here: a router that invents its own defaults makes the config
  // file decorative, and the config is what a human reads when the numbers look wrong.
  if (!config) {
    throw new Error('no config: refusing to build a worker invocation with unstated routing');
  }
  const text = typeof prompt === 'string' ? prompt : '';
  if (!text.trim()) {
    throw new Error('prompt is empty: refusing to spawn a worker with nothing to work on');
  }

  const worker = config.models?.worker ?? SEATS.worker.model;
  const fallback = config.models?.fallback ?? SEATS.fallback.model;
  ceilingFor(worker);
  ceilingFor(fallback);

  // An argv ARRAY, never a shell string. A ticket body reaches this function as `prompt`, and
  // a body containing backticks or `$(...)` must arrive at the CLI as one argument that no
  // shell re-parses. Pre-escaping would be worse than useless: the backslashes would reach the
  // model as literal text in the prompt.
  const argv = [
    '-p', text,
    '--model', worker,
    // ALWAYS present, with no opt-out. §2.3's reason is a 3am capacity error producing a dead
    // tick nobody is awake to notice. Its real semantics are narrow and worth knowing: it
    // switches models when the primary is overloaded or unavailable, and retries the primary
    // at the start of each user turn.
    '--fallback-model', fallback,
    '--permission-mode', 'bypassPermissions',
    // NO MCP SERVERS, and this pairs with the line above rather than standing alone. MEASURED
    // 2026-08-01: `claude -p` with no --mcp-config still loads the operator's servers — a haiku
    // spawn from a bare tool shell called `mcp__atlassian__getJiraIssue` and got a real answer.
    // So under bypassPermissions the worker held Jira WRITE access to the ticket it is graded
    // against: it could rewrite the acceptance criteria, close the issue, or strip its own
    // `alfred:blocked` label. That is instrument_modified aimed at the SPECIFICATION instead of
    // the grader, and the gate is structurally blind to it — it scores the working-tree diff,
    // and a Jira edit leaves no diff.
    //
    // `--strict-mcp-config` means "only servers named by --mcp-config", so passing it with no
    // --mcp-config is what makes the set empty. Alfred's own trusted Jira fetch passes both
    // flags together with a read-only allowlist; the worker gets the strict flag alone.
    '--strict-mcp-config',
    // stream-json rather than the single-object json mode, so the log fills in as the worker
    // runs rather than staying empty until one object lands at the very end — the operator was
    // otherwise flying blind for the run's full duration. MEASURED 2026-08-01: `--output-format
    // stream-json` on its own is a hard CLI error ("requires --verbose"); paired with --verbose
    // the terminal line of the stream carries the exact same fields the single-object mode's
    // only line did (session_id, total_cost_usd, num_turns, terminal_reason, subtype, is_error),
    // so the accounting this project reads (transcript.mjs's two log readers, report.mjs's
    // workerCostUsd cross-check) needed no change beyond parsing the LAST line rather than the
    // whole blob.
    '--output-format', 'stream-json',
    '--verbose',
    // NO --max-budget-usd. It was here, and measured to be the specific cause of a
    // cache-breakpoint freeze — see the header. `--max-turns` and lib/run.mjs's external
    // wall-cap kill are the runaway bounds now; neither is a dollar cap, and that gap is
    // accepted rather than papered over with a flag that quadruples the dollars it caps.
    '--agents', JSON.stringify(agentsPayload(config)),
  ];

  // A pre-generated id rather than one parsed back out of the log after the fact: the caller
  // can compose the transcript path deterministically before the worker has written a byte.
  // Not generated IN HERE — `randomUUID()` on every call would break the purity M5 pins
  // ("config in, argv array out", asserted by calling twice and deep-equaling the result).
  if (typeof sessionId === 'string' && sessionId.trim()) {
    argv.push('--session-id', sessionId);
  }

  if (appendSystemPrompt) argv.push('--append-system-prompt', appendSystemPrompt);
  if (maxTurns !== undefined && maxTurns !== null) argv.push('--max-turns', String(maxTurns));

  return argv;
}
