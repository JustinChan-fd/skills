// lib/router.mjs — config in, argv array out. No spawn, no model call, no I/O.
//
// PLAN.md M5 freezes four names; they appear below verbatim as the first four tests. The rest
// are ADDED: and each names what it measures.
//
// TWO THINGS MEASURED AGAINST THE LIVE CLI before these tests were written, because the
// alternative was encoding a guess about a flag and calling it a control:
//
//   `--max-budget-usd 0.001` on a 40-line counting prompt returned
//   `is_error: true, subtype: 'error_max_budget_usd', terminal_reason: 'budget_exhausted'`
//   and `total_cost_usd: 0.0351519`. So the ceiling is REAL and ENFORCED BY THE CLI, and it
//   is enforced AFTER a turn rather than before it — a cap of $0.001 still spent 3.5 cents.
//   It bounds a runaway; it does not bound the first turn.
//
//   `--agents '{"probe":{"description":"d","prompt":"p","bogus_key_xyz":1}}'` ran to
//   `end_turn` with no complaint. The flag SILENTLY IGNORES unknown keys. So does
//   `maxTokens: 999999` — a value above every published ceiling — on a call where the
//   subagent verifiably ran (`modelUsage` carried both `anthropic.claude-sonnet-5` and
//   `claude-haiku-4-5`, which is the same probe proving the `model` key IS honoured).
//
// That second finding is why NO token ceiling goes in --agents: not `token_budget` and not
// `maxTokens`. Either would read in the config like a spend cap while having no effect, which
// is worse than no cap because the file looks protected. PLAN.md §M5's frozen name asks for
// "per-tier ceilings" in that payload; the CLI cannot do it, so the name is kept and what it
// asserts follows the measurement. The $11.98 lesson rests on `--max-budget-usd` for dollars
// and on `seatBudgets()` for tokens — the latter Alfred's own accounting, which does not
// pretend the vendor is checking it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { THRESHOLDS } from '../eval/armcost.mjs';
import { SEATS } from '../lib/models.mjs';
import { AGENT_SEATS, agentsPayload, budgetUsdFor, seatBudgets, workerArgv } from '../lib/router.mjs';

const CONFIG = Object.freeze({
  version: 1,
  repo: 'jarvis',
  models: { worker: 'claude-sonnet-5', fallback: 'claude-sonnet-5' },
});

const argvOf = (over = {}) => workerArgv({ config: { ...CONFIG, ...over }, prompt: 'p' });
const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

// --- the four frozen M5 names ---

test('worker model comes from config; sonnet is the default when config is silent', () => {
  assert.equal(flag(argvOf(), '--model'), 'claude-sonnet-5');
  assert.equal(flag(argvOf({ models: { worker: 'claude-opus-5' } }), '--model'), 'claude-opus-5');
  // Silent config falls back to the SEATS table rather than to a literal here. Two copies of
  // "the default worker model" is how the router and the seat table come to disagree.
  assert.equal(flag(argvOf({ models: {} }), '--model'), SEATS.worker.model);
  assert.equal(flag(argvOf({ models: undefined }), '--model'), SEATS.worker.model);
});

test('--fallback-model is always present for loop-launched runs', () => {
  // ALWAYS, with no opt-out, because PLAN.md §2.3's reason is a 3am capacity error producing
  // a dead tick nobody is awake to notice.
  assert.equal(flag(argvOf(), '--fallback-model'), SEATS.fallback.model);
  assert.equal(
    flag(argvOf({ models: { worker: 'claude-opus-5', fallback: 'claude-sonnet-5' } }), '--fallback-model'),
    'claude-sonnet-5',
  );
  assert.equal(flag(argvOf({ models: {} }), '--fallback-model'), SEATS.fallback.model);
});

test('subagent tiers become an --agents JSON payload with per-tier ceilings', () => {
  const payload = JSON.parse(flag(argvOf(), '--agents'));
  assert.deepEqual(Object.keys(payload).sort(), [...AGENT_SEATS].sort());
  for (const name of AGENT_SEATS) {
    // `model` is the one key measured to have an effect, so it is the one the payload carries.
    assert.equal(payload[name].model, SEATS[name].model, name);
    assert.equal(typeof payload[name].description, 'string');
    assert.ok(payload[name].description.length > 0, name);
    assert.equal(typeof payload[name].prompt, 'string');
  }

  // The per-tier CEILING half of this frozen name is NOT in the payload, and the assertion is
  // inverted on purpose — see the header. `maxTokens: 999999` was measured to run clean on a
  // real delegation, so a ceiling written here would be inert while reading as enforced. The
  // ceilings still exist; they are just where they can be acted on.
  const budgets = seatBudgets();
  assert.deepEqual(Object.keys(budgets).sort(), [...AGENT_SEATS].sort());
  for (const name of AGENT_SEATS) {
    assert.equal(budgets[name], SEATS[name].token_budget, name);
  }
});

test('no tier defaults to opus — the expensive tier must be named explicitly', () => {
  // The $11.98 lesson as an assertion. Adjudication is an escalation with a logged reason,
  // never something a subagent lands on by omission.
  const payload = JSON.parse(flag(argvOf(), '--agents'));
  for (const [name, seat] of Object.entries(payload)) {
    assert.ok(!/opus/i.test(seat.model), `${name} routed to ${seat.model}`);
  }
  assert.ok(!AGENT_SEATS.includes('adjudicator'));
  // And a config that tries to put opus in a subagent tier is refused rather than honoured:
  // the tiers are Alfred's routing policy, not a per-repo preference.
  assert.throws(
    () => agentsPayload({ models: { agents: { scan: { model: 'claude-opus-5' } } } }),
    /opus/i,
  );
});

// --- ADDED ---

test('ADDED: flag construction is pure — config in, argv array out, no spawn', () => {
  // M5's own name for it. Asserted by calling it twice and getting deep-equal arrays: any
  // clock, pid, tmpdir or counter in there breaks this.
  const a = workerArgv({ config: CONFIG, prompt: 'p' });
  const b = workerArgv({ config: CONFIG, prompt: 'p' });
  assert.deepEqual(a, b);
  assert.ok(Array.isArray(a));
  assert.ok(a.every((x) => typeof x === 'string'));
});

test('ADDED: the prompt is an argv element, never interpolated into a string', () => {
  // Measured hazard from lib/eval-issue-sync.mjs: a ticket body carrying backticks or
  // `$(...)` must reach the CLI as one argument. An argv array is the mechanism; this asserts
  // the shape rather than trusting it.
  const hostile = 'fix `rm -rf /` and $(whoami) and "quotes" and \'more\'';
  const argv = workerArgv({ config: CONFIG, prompt: hostile });
  assert.equal(flag(argv, '-p'), hostile);
  assert.equal(argv.filter((x) => x === hostile).length, 1);
});

test('ADDED: --max-budget-usd is present, because it is the only ceiling the CLI enforces', () => {
  // Probed live: a $0.001 cap returned subtype error_max_budget_usd / terminal_reason
  // budget_exhausted. This is the $11.98 bound with teeth. A run without it has no bound at
  // all, so it is not optional.
  const argv = argvOf();
  const budget = Number(flag(argv, '--max-budget-usd'));
  assert.ok(Number.isFinite(budget));
  assert.ok(budget > 0);
});

test('ADDED: the budget comes from config when stated and refuses a nonsense value', () => {
  assert.equal(flag(argvOf({ budget_usd: 7.5 }), '--max-budget-usd'), '7.5');
  for (const bad of [0, -1, 'lots', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => budgetUsdFor({ budget_usd: bad }), /budget/i, String(bad));
  }
});

test('ADDED: the default budget is the pre-registered KILL cap, not the acceptance mean', () => {
  // The distinction armcost.mjs is explicit about: spendCapUsd $8 kills a run, acceptMeanUsd
  // $4 fails it on acceptance. --max-budget-usd aborts, so it is the kill number. Defaulting
  // to $4 would be exactly the collapse that comment warns against — it "would kill every run
  // that was about to produce the evidence that makes its own cost figure meaningful."
  assert.equal(budgetUsdFor({}), THRESHOLDS.armC.spendCapUsd);
  assert.equal(budgetUsdFor(undefined), THRESHOLDS.armC.spendCapUsd);
  assert.notEqual(THRESHOLDS.armC.spendCapUsd, THRESHOLDS.armC.acceptMeanUsd);
  // lib/ may not import eval/, so router.mjs holds its own copy of the number. This is the
  // cross-check that keeps the copy from drifting silently.
  assert.equal(budgetUsdFor({}), 8);
});

test('ADDED: --permission-mode bypassPermissions and --output-format json are both present', () => {
  // The run is priced from the transcript and the record is parsed from the json payload, so
  // both are load-bearing rather than conveniences. Same pair the arm C runner used, which is
  // what keeps a production run comparable to a measured one.
  const argv = argvOf();
  assert.equal(flag(argv, '--permission-mode'), 'bypassPermissions');
  assert.equal(flag(argv, '--output-format'), 'json');
});

test('ADDED: an append-system-prompt is carried when given, and absent when not', () => {
  assert.equal(flag(argvOf(), '--append-system-prompt'), null);
  const argv = workerArgv({ config: CONFIG, prompt: 'p', appendSystemPrompt: 'audit the ticket' });
  assert.equal(flag(argv, '--append-system-prompt'), 'audit the ticket');
});

test('ADDED: --max-turns is carried only when given', () => {
  assert.equal(flag(argvOf(), '--max-turns'), null);
  assert.equal(flag(workerArgv({ config: CONFIG, prompt: 'p', maxTurns: 40 }), '--max-turns'), '40');
});

test('ADDED: an unknown model id is refused at flag-construction time', () => {
  // ceilingFor throws on an unpublished id. Surfacing that HERE means a typo fails before
  // anything spawns; deferring it means a 3am tick spends on a rejected request.
  assert.throws(() => argvOf({ models: { worker: 'claude-sonnet-9' } }), /claude-sonnet-9/);
  assert.throws(() => argvOf({ models: { worker: 'claude-sonnet-5', fallback: 'nope-1' } }), /nope-1/);
});

test('ADDED: a worker model on the gateway prefix form is accepted', () => {
  // Every real request to this gateway spells the model `anthropic.claude-…`. A router that
  // only accepts the bare form refuses the id production uses.
  assert.equal(
    flag(argvOf({ models: { worker: 'anthropic.claude-opus-5' } }), '--model'),
    'anthropic.claude-opus-5',
  );
});

test('ADDED: an empty prompt is refused rather than spawned', () => {
  for (const p of [null, undefined, '', '   ']) {
    assert.throws(() => workerArgv({ config: CONFIG, prompt: p }), /prompt/i, String(p));
  }
});

test('ADDED: a missing config is refused rather than defaulted', () => {
  // loadConfig's rule applied here: a router that invents its own defaults makes the config
  // file decorative, and the config is what a human reads when the numbers look wrong.
  assert.throws(() => workerArgv({ config: null, prompt: 'p' }), /config/i);
});

test('ADDED: the payload carries only the three keys measured to have an effect', () => {
  // A key with no effect is not free: it reads as configuration. This pins the surface so a
  // later "improvement" adding maxTokens/temperature/tools has to confront the measurement
  // rather than assume the flag honours it.
  const payload = agentsPayload(CONFIG);
  for (const [name, seat] of Object.entries(payload)) {
    assert.deepEqual(Object.keys(seat).sort(), ['description', 'model', 'prompt'], name);
  }
});

test('ADDED: config may override a subagent seat model within the same tier discipline', () => {
  const payload = agentsPayload({ models: { agents: { reason: { model: 'claude-sonnet-4-6' } } } });
  assert.equal(payload.reason.model, 'claude-sonnet-4-6');
});

test('ADDED: an unknown subagent seat name is refused, not silently added', () => {
  // The measured reason this test exists: `--agents` accepted `bogus_key_xyz` and ran clean.
  // The CLI will not catch an operator's typo, so this is the only place it can be caught.
  assert.throws(() => agentsPayload({ models: { agents: { scna: { model: 'claude-haiku-4-5' } } } }), /scna/);
});

test('ADDED: no token ceiling is written into the --agents payload, deliberately', () => {
  // Not an oversight, and the assertion is here so nobody "fixes" it. Both spellings and both
  // concepts: measured, --agents ignores unknown keys, and `maxTokens: 999999` ran clean on a
  // real delegation. A cap here cannot fire while making the config read as protected.
  const payload = agentsPayload(CONFIG);
  for (const [name, seat] of Object.entries(payload)) {
    for (const key of ['token_budget', 'tokenBudget', 'maxTokens', 'max_tokens']) {
      assert.ok(!(key in seat), `${name}.${key} would be inert`);
    }
  }
  // And the token bound is reachable where it CAN be enforced, so this is a relocation rather
  // than a deletion. A test asserting only the absence would pass if the bound vanished.
  assert.ok(seatBudgets().scan > 0);
});

test('ADDED: the argv contains no shell metacharacter escaping — it is not a shell string', () => {
  // A router that pre-escaped its arguments would be a router built for a shell string, and
  // the escaping would then reach the CLI as literal backslashes in the prompt.
  const argv = workerArgv({ config: CONFIG, prompt: "don't" });
  assert.equal(flag(argv, '-p'), "don't");
  assert.ok(!argv.some((x) => x.includes('\\\'')));
});
