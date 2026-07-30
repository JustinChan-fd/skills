// gate — the 13 frozen M4 names, plus ADDED tests that each name their measurement.
//
// PROVENANCE. The first eleven names are lifted verbatim from PLAN.md §3/M4 and the
// last two from §3's TARS-1339 pair, frozen in git on 2026-07-29 before this file
// existed. They are arm C's experimental control: if they moved to match whatever the
// implementation turned out to do, arm C would be graded on a bar written after the
// run. Anything beyond them carries an `ADDED:` prefix and says what it measures.
//
// WHY THIS MODULE IS THE THESIS. PLAN.md §3/M4: "The last three are the whole point.
// harness-core's verifier produced a false `verified` because it was an LLM grading
// with a score. This one is a function." So three of the thirteen names are not about
// verification logic at all — they are about the gate's own nature: no repo writes, a
// pure function of its inputs, no model call and no network. A gate that graded
// correctly but could be talked out of it would fail the point of having one.
//
// PLAN.md:186 governs the boundary: "The gate never edits the repo and never re-runs
// the worker. It reports." So there is no fix-up path, no retry, and no `attempt`
// field — that last one was rejected outright during M2's amendment.
//
// THE FIVE-STATE RULE, §5 rule 2. Each AC resolves to exactly one of `passed`,
// `failed`, `unverifiable(reason)`, `unsatisfiable(evidence)` — "a fifth state does
// not exist. Silence is fail." That asymmetry is the entire design: `unverified[]`
// being non-empty does NOT auto-fail, because it is the honest channel for "a human
// must look." What fails is an AC that is neither verified nor declared unverifiable.
//
// COMMANDS ARE INJECTED, NOT MOCKED-AWAY. `run` is a parameter with a real default,
// so tests supply a recorded runner and production supplies execFile. This is not the
// gate reading the worker's claimed results — §8.1's mitigation is that the gate runs
// the proposed command ITSELF and ignores what the worker said the outcome was, and an
// injected runner still decides by exit code. The tests that matter assert the gate
// ran the command it was given and used the code it got back.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runGate, GATE_RULES } from '../lib/gate.mjs';

// A config as `loadConfig` would return it. Built here rather than imported so a gate
// test cannot start failing because of a config-schema change.
const CONFIG = Object.freeze({
  verify: { test: 'npm test', lint: 'npm run lint' },
  off_limits: ['src/vendor/**', 'node_modules/**'],
  delivery: { mode: 'pr', never_merge: true },
});

// A runner keyed by command string. Every test states the exit code it wants, so no
// test depends on what an npm script happens to do on this machine.
function runnerFor(codes = {}, log = []) {
  return async (command) => {
    log.push(command);
    const entry = codes[command] ?? { code: 0, output: '' };
    return { code: entry.code ?? 0, output: entry.output ?? '' };
  };
}

const allGreen = (extra = {}) => runnerFor({ 'npm test': { code: 0 }, 'npm run lint': { code: 0 }, ...extra });

const dirs = [];

function tempRepo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'alfred-gate-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const findingRules = (verdict) => verdict.findings.map((f) => f.rule);

// ---------------------------------------------------------------------------
// The 13 frozen names.
// ---------------------------------------------------------------------------

test('all declared checks exit 0 → pass', async () => {
  const log = [];
  const verdict = await runGate({
    config: CONFIG,
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }],
    acMap: [{ ac: 'AC1', command: 'npm test -- retry loop' }],
    touched: ['src/retry.js'],
    run: allGreen({ 'npm test -- retry loop': { code: 0 } }, log),
  });

  assert.equal(verdict.pass, true, JSON.stringify(verdict.findings));
  assert.deepEqual(verdict.findings, []);
  assert.deepEqual(verdict.unverified, []);
});

test('one declared check exits non-zero → fail, naming the check and its output', async () => {
  const verdict = await runGate({
    config: CONFIG,
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }],
    acMap: [{ ac: 'AC1', command: 'npm test -- retry loop' }],
    touched: ['src/retry.js'],
    run: runnerFor({
      'npm test': { code: 0 },
      'npm run lint': { code: 2, output: 'src/retry.js:4  error  noUnusedVariables' },
      'npm test -- retry loop': { code: 0 },
    }),
  });

  assert.equal(verdict.pass, false);
  const finding = verdict.findings.find((f) => f.rule === GATE_RULES.check_failed);
  assert.ok(finding, `expected a check_failed finding, got ${findingRules(verdict)}`);
  // The check's NAME, not just the command: the operator reads config.verify keys.
  assert.match(finding.detail, /lint/);
  assert.match(finding.evidence, /noUnusedVariables/);
  // And the exit code is carried, because "failed" without a code cannot be triaged.
  assert.match(finding.evidence, /2/);
});

test('an AC with no mapping and no unverifiable marker → fail (silence is not a pass)', async () => {
  const verdict = await runGate({
    config: CONFIG,
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }, { id: 'AC2', text: 'no behavior changes' }],
    acMap: [{ ac: 'AC1', command: 'npm test -- retry loop' }],
    touched: ['src/retry.js'],
    run: allGreen({ 'npm test -- retry loop': { code: 0 } }),
  });

  assert.equal(verdict.pass, false);
  const finding = verdict.findings.find((f) => f.rule === GATE_RULES.ac_unmapped);
  assert.ok(finding, `expected ac_unmapped, got ${findingRules(verdict)}`);
  assert.match(finding.detail, /AC2/);
  // An unmapped AC is NOT unverified[]: that list is for declared-and-reasoned gaps.
  // Putting silence there would turn the honest channel into the default.
  assert.deepEqual(verdict.unverified, []);
});

test('an AC marked unverifiable with a reason → pass, and appears in unverified[]', async () => {
  const verdict = await runGate({
    config: CONFIG,
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }, { id: 'AC2', text: 'no behavior changes' }],
    acMap: [
      { ac: 'AC1', command: 'npm test -- retry loop' },
      { ac: 'AC2', unverifiable: true, reason: 'no characterization tests exist for the notify path' },
    ],
    touched: ['src/retry.js'],
    run: allGreen({ 'npm test -- retry loop': { code: 0 } }),
  });

  // PASS. §5: "unverified being non-empty does not auto-fail — it is the honest
  // channel for 'a human must look.'" A gate that failed here would teach the worker
  // to stop declaring gaps, which is the behaviour being designed against.
  assert.equal(verdict.pass, true, JSON.stringify(verdict.findings));
  assert.equal(verdict.unverified.length, 1);
  assert.equal(verdict.unverified[0].ac, 'AC2');
  assert.match(verdict.unverified[0].reason, /characterization tests/);
});

test('an AC marked unverifiable with no reason → fail', async () => {
  const verdict = await runGate({
    config: CONFIG,
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'no behavior changes' }],
    acMap: [{ ac: 'AC1', unverifiable: true }],
    touched: ['src/retry.js'],
    run: allGreen(),
  });

  // Without this, `unverifiable: true` is a one-word opt-out of the whole gate.
  assert.equal(verdict.pass, false);
  assert.ok(verdict.findings.some((f) => f.rule === GATE_RULES.unverifiable_no_reason), findingRules(verdict));
  // And it does NOT land in unverified[] — an unreasoned marker is not a declaration.
  assert.deepEqual(verdict.unverified, []);
});

test('a claim of "X passes" with no recorded command + exit code → fail (no-fabrication)', async () => {
  const verdict = await runGate({
    config: CONFIG,
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }],
    acMap: [{ ac: 'AC1', command: 'npm test -- retry loop' }],
    touched: ['src/retry.js'],
    claims: ['The full suite passes and lint is clean on master.'],
    commands: [{ command: 'npm test -- retry loop', exit: 0 }],
    run: allGreen({ 'npm test -- retry loop': { code: 0 } }),
  });

  assert.equal(verdict.pass, false);
  const finding = verdict.findings.find((f) => f.rule === GATE_RULES.unbacked_claim);
  assert.ok(finding, `expected unbacked_claim, got ${findingRules(verdict)}`);
  // §5 rule 4: "An unbacked claim is a finding, even when it happens to be true —
  // because you cannot tell which from the artifact." The evidence quotes the claim.
  assert.match(finding.evidence, /lint is clean/);
});

test('a file touched outside declared scope → fail, naming the file', async () => {
  const verdict = await runGate({
    config: CONFIG,
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }],
    acMap: [{ ac: 'AC1', command: 'npm test -- retry loop' }],
    declaredScope: ['src/channels/**', 'src/retry.js'],
    touched: ['src/retry.js', 'src/billing/invoice.js'],
    run: allGreen({ 'npm test -- retry loop': { code: 0 } }),
  });

  assert.equal(verdict.pass, false);
  const finding = verdict.findings.find((f) => f.rule === GATE_RULES.scope_violation);
  assert.ok(finding, `expected scope_violation, got ${findingRules(verdict)}`);
  assert.match(finding.detail, /src\/billing\/invoice\.js/);
  // The in-scope file is not reported: a finding per touched file would bury the one
  // that matters under a list of correct ones.
  assert.doesNotMatch(finding.detail, /src\/retry\.js/);
});

test('a file touched in an off-limits path → fail, naming the pattern it matched', async () => {
  const verdict = await runGate({
    config: CONFIG,
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }],
    acMap: [{ ac: 'AC1', command: 'npm test -- retry loop' }],
    touched: ['src/retry.js', 'src/vendor/legacy.js'],
    run: allGreen({ 'npm test -- retry loop': { code: 0 } }),
  });

  assert.equal(verdict.pass, false);
  const finding = verdict.findings.find((f) => f.rule === GATE_RULES.off_limits);
  assert.ok(finding, `expected off_limits, got ${findingRules(verdict)}`);
  assert.match(finding.detail, /src\/vendor\/legacy\.js/);
  // THE PATTERN, per the frozen name. "This file is off limits" leaves the operator
  // grepping the config to find out which rule decided it and whether it was intended.
  assert.match(finding.evidence, /src\/vendor\/\*\*/);
});

test('the gate never writes to the repo — the working tree is byte-identical after', async () => {
  const root = tempRepo({
    'src/retry.js': 'export const retry = () => {};\n',
    'package.json': '{"name":"probe"}\n',
    '.alfred/config.json': '{"version":1}\n',
  });
  const before = treeHash(root);

  await runGate({
    config: CONFIG,
    repoRoot: root,
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }, { id: 'AC2', text: 'no behavior changes' }],
    // Deliberately a FAILING run: the failure path is where a fix-up would be
    // tempting, so that is the path this has to be proven on.
    acMap: [{ ac: 'AC1', command: 'npm test -- retry loop' }],
    touched: ['src/retry.js', 'src/vendor/legacy.js'],
    claims: ['Everything passes.'],
    run: runnerFor({ 'npm test': { code: 1 }, 'npm run lint': { code: 2 }, 'npm test -- retry loop': { code: 1 } }),
  });

  assert.equal(treeHash(root), before, 'the gate modified the working tree');
});

test('the gate verdict is a pure function of its inputs — same inputs, same verdict', async () => {
  const inputs = () => ({
    config: CONFIG,
    repoRoot: tempRepo({ 'src/retry.js': 'x\n' }),
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }, { id: 'AC2', text: 'no behavior changes' }],
    acMap: [
      { ac: 'AC1', command: 'npm test -- retry loop' },
      { ac: 'AC2', unverifiable: true, reason: 'no characterization tests' },
    ],
    declaredScope: ['src/**'],
    touched: ['src/retry.js', 'src/vendor/legacy.js'],
    claims: ['The suite passes.'],
    commands: [{ command: 'npm test -- retry loop', exit: 0 }],
    run: runnerFor({ 'npm test': { code: 0 }, 'npm run lint': { code: 2, output: 'two warnings' }, 'npm test -- retry loop': { code: 0 } }),
  });

  const a = await runGate(inputs());
  const b = await runGate(inputs());

  // Deep equality, not just `pass`: findings order and evidence text are part of the
  // verdict. A gate whose findings arrive in directory or Set-iteration order produces
  // a different artifact for an identical run, and two records that disagree are
  // indistinguishable from a real change in behaviour.
  assert.deepEqual(b, a);
  // And the same inputs twice must not accumulate — a module-level findings array
  // would make the second run report everything twice and still be "equal" only if
  // both runs were polluted.
  assert.equal(a.findings.length, new Set(a.findings.map((f) => `${f.rule}:${f.detail}`)).size);
});

test('the gate has no model call and no network access', () => {
  // Asserted against the SOURCE, because this is a claim about what the module can do,
  // not about what one run happened to do. A behavioural test would pass on a gate
  // that calls a model only when a check is ambiguous — which is exactly the
  // harness-core verifier being replaced, and exactly the case a green test suite
  // would never reach.
  const src = readFileSync(new URL('../lib/gate.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);

  const NETWORK = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'undici', 'axios', 'node-fetch'];
  for (const mod of imports) {
    assert.ok(!NETWORK.includes(mod), `gate.mjs imports ${mod} — the gate must not reach the network`);
  }

  // Code, not comments: this file's own header names the LLM verifier it replaces, and
  // a naive grep over the whole source would flag that prose forever.
  const code = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const forbidden = ['fetch(', 'XMLHttpRequest', 'ANTHROPIC', 'anthropic', 'claude -p', 'messages.create'];
  for (const token of forbidden) {
    assert.ok(!code.includes(token), `gate.mjs code contains ${token} — the gate must be a function, not a model call`);
  }
});

test('an AC demanding "0 warnings" against a tree with 2 pre-existing warnings is reported unsatisfiable, not passed', async () => {
  // TARS-1339 AC #1, and sandbox-a's AC3 reproduces it deliberately: the tree carries
  // 2 warnings in an off-limits path, so "0 warnings" cannot be reached without a
  // scope violation. Both outcomes a naive gate produces are wrong — passing it is
  // false, and failing it as ordinary work sends the worker to edit vendor code.
  const verdict = await runGate({
    config: CONFIG,
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'lint reports 0 errors and 0 warnings' }],
    acMap: [{
      ac: 'AC1',
      unsatisfiable: true,
      evidence: 'npm run lint exits 2 with 2 warnings, both in src/vendor/ which the ticket declares off limits',
    }],
    touched: ['src/retry.js'],
    run: runnerFor({ 'npm test': { code: 0 }, 'npm run lint': { code: 2, output: '2 warnings' } }),
  });

  assert.equal(verdict.pass, false, 'an unsatisfiable AC must not pass');
  const finding = verdict.findings.find((f) => f.rule === GATE_RULES.ac_unsatisfiable);
  assert.ok(finding, `expected ac_unsatisfiable, got ${findingRules(verdict)}`);
  assert.match(finding.evidence, /src\/vendor\//);
  // NOT unverified[]: "a human must look" understates it. This needs the ticket
  // amended, which is the blocked path, so the verdict carries the reason code from
  // blocked.mjs's closed set rather than leaving the loop to infer it from prose.
  assert.deepEqual(verdict.unverified, []);
  assert.equal(verdict.blocked_reason, 'unsatisfiable-ac');
});

test('an AC of the form "no behavior changes" with only a formatter run recorded lands in unverified[], not pass', async () => {
  // §3: 147 files, 526 insertions, 435 deletions, and BOTH arms and I left this
  // unverified. A gate that silently passes it reproduces the bug being fixed.
  const verdict = await runGate({
    config: CONFIG,
    repoRoot: tempRepo(),
    acs: [{ id: 'AC2', text: 'no behavior changes' }],
    acMap: [{ ac: 'AC2', command: 'npm run lint' }],
    touched: ['src/retry.js'],
    commands: [{ command: 'npm run lint', exit: 0 }],
    run: allGreen(),
  });

  // The mapped command EXITS 0. A gate keyed on exit codes alone passes this, which is
  // §8.1's `mapping_implausible`: a formatter cannot settle a behavior question.
  assert.equal(verdict.pass, false, 'a formatter must not settle a behavior AC');
  const finding = verdict.findings.find((f) => f.rule === GATE_RULES.mapping_implausible);
  assert.ok(finding, `expected mapping_implausible, got ${findingRules(verdict)}`);
  assert.match(finding.detail, /AC2/);
  // Per the frozen name it lands in unverified[] — the AC is not settled either way,
  // and that is the honest channel for it.
  assert.ok(verdict.unverified.some((u) => u.ac === 'AC2'), JSON.stringify(verdict.unverified));
});

// ---------------------------------------------------------------------------
// ADDED. Nine guards survived mutation — every one of the thirteen frozen names stayed
// green with the guard deleted. In all nine cases the guard was already present and
// correct (verified by direct probe), so these close test holes rather than fix bugs.
// ---------------------------------------------------------------------------

test('ADDED: the gate decides an AC by the exit code of the proposed command, not by the worker saying it passed', async () => {
  // THE MOST SERIOUS SURVIVOR. Mutation `ac-command-exit-ignored` made the gate ignore
  // a non-zero exit from an ac_map command, and all thirteen frozen names stayed green.
  // That guard is §8.1's ENTIRE mitigation for the conflict of interest: "A dishonest
  // ac_map can only propose a command; it cannot fake an exit code." The frozen names
  // cover a declared `config.verify` check failing, but never an AC's OWN mapped
  // command failing — so the one mechanism that makes worker-authored input safe to
  // accept had nothing asserting it worked.
  const log = [];
  const verdict = await runGate({
    config: { verify: {} }, // no declared checks, so only the ac_map command can fail
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }],
    // The worker proposes the command AND asserts the outcome. The claimed result is
    // deliberately a lie, and the gate must never read it.
    acMap: [{ ac: 'AC1', command: 'npm test -- retry loop', result: 'passed', exit: 0 }],
    touched: ['src/retry.js'],
    run: runnerFor({ 'npm test -- retry loop': { code: 1, output: '1 failing: retry() called twice' } }, log),
  });

  assert.equal(verdict.pass, false, 'a failing AC command must fail the gate regardless of the claimed result');
  const finding = verdict.findings.find((f) => f.rule === GATE_RULES.ac_failed);
  assert.ok(finding, `expected ac_failed, got ${findingRules(verdict)}`);
  assert.match(finding.detail, /AC1/);
  assert.match(finding.evidence, /exit 1/);
  assert.match(finding.evidence, /called twice/);
  // The gate RAN it. Without this the test would also pass on a gate that read
  // `entry.exit` and happened to disagree with it.
  assert.deepEqual(log, ['npm test -- retry loop']);
});

test('ADDED: an ac_map entry with no command at all is unmapped, not passed', async () => {
  // Mutation `empty-command-allowed` survived: an entry that is a bare `{ac: 'AC1'}`
  // shell — no command, no unverifiable, no unsatisfiable — fell through to a pass. It
  // is the cheapest possible way to silence the gate for an AC while still appearing in
  // the ac_map, which is precisely what a completeness check over the map would miss.
  for (const entry of [{ ac: 'AC1' }, { ac: 'AC1', command: '' }, { ac: 'AC1', command: '   ' }]) {
    const verdict = await runGate({
      config: { verify: {} },
      repoRoot: tempRepo(),
      acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }],
      acMap: [entry],
      run: allGreen(),
    });
    assert.equal(verdict.pass, false, `${JSON.stringify(entry)} must not pass`);
    assert.ok(
      verdict.findings.some((f) => f.rule === GATE_RULES.ac_unmapped),
      `${JSON.stringify(entry)} → ${findingRules(verdict)}`,
    );
    assert.deepEqual(verdict.unverified, []);
  }
});

test('ADDED: a command unrelated to the AC subject is implausible, even when it exits 0', async () => {
  // Mutation `subject-overlap-never-fails` survived. The frozen "no behavior changes"
  // name exercises the OTHER branch of implausibility — the not-command-settleable
  // pattern list — so the subject-overlap check (§8.1's actual wording: "a command that
  // does not mention the AC's subject at all is a finding") was never reached by any
  // test. Both branches now have a test, because they fail for different reasons: one
  // is about the shape of the claim, the other about the pair being unrelated.
  const verdict = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the notification channels are consolidated into one module' }],
    acMap: [{ ac: 'AC1', command: 'git status --porcelain' }],
    run: runnerFor({ 'git status --porcelain': { code: 0 } }),
  });

  assert.equal(verdict.pass, false, 'an unrelated command must not settle an AC by exiting 0');
  const finding = verdict.findings.find((f) => f.rule === GATE_RULES.mapping_implausible);
  assert.ok(finding, `expected mapping_implausible, got ${findingRules(verdict)}`);
  assert.match(finding.evidence, /mentions none/);
  assert.ok(verdict.unverified.some((u) => u.ac === 'AC1'));

  // And the converse, or the check is just "fail everything": a command that shares the
  // AC's subject is accepted. Without this half, `subject.some(...) → return null` could
  // be deleted too and the suite would still be green.
  const ok = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the notification channels are consolidated into one module' }],
    acMap: [{ ac: 'AC1', command: 'npm test -- channels' }],
    run: runnerFor({ 'npm test -- channels': { code: 0 } }),
  });
  assert.equal(ok.pass, true, JSON.stringify(ok.findings));
});

test('ADDED: a command NAMED for the behavior it checks still cannot settle "no behavior changes"', async () => {
  // THE FROZEN TEST PASSES FOR THE WRONG REASON, and mutation is how that surfaced.
  // Emptying NOT_COMMAND_SETTLEABLE left all 22 tests green. The frozen name maps the
  // AC to `npm run lint`, which shares no subject word with "no behavior changes" — so
  // the SUBJECT-OVERLAP branch catches it and the pattern list is never reached. Two
  // propositions were riding on one green boolean (§10's unfalsifiable conjunct), and
  // the one that matters was the untested one.
  //
  // Emptying the list and probing directly: `npm run lint` still fails (overlap), but
  // `npm run check:behavior` PASSES — it mentions the subject, so overlap is satisfied,
  // and with the pattern list gone nothing else objects. A worker that names its script
  // after the AC would walk a behavior claim straight through the gate on exit 0.
  //
  // That is not hypothetical politeness about naming. It is the cheapest possible
  // response to a `mapping_implausible` finding: rename the command.
  for (const command of [
    'npm run check:behavior',
    './scripts/verify-no-behavior-changes.sh',
    'npm test -- --grep behavior',
  ]) {
    const verdict = await runGate({
      config: { verify: {} },
      repoRoot: tempRepo(),
      acs: [{ id: 'AC2', text: 'no behavior changes' }],
      acMap: [{ ac: 'AC2', command }],
      run: runnerFor({ [command]: { code: 0 } }),
    });
    assert.equal(verdict.pass, false, `${command} must not settle an absence-of-change AC by exiting 0`);
    const finding = verdict.findings.find((f) => f.rule === GATE_RULES.mapping_implausible);
    assert.ok(finding, `${command} → ${findingRules(verdict)}`);
    // The reason must be the ABSENCE-OF-CHANGE one, not "mentions none of the subject
    // terms" — otherwise this test could pass on the overlap branch too and we would be
    // back to one boolean covering two propositions.
    assert.match(finding.evidence, /absence of change/);
    assert.doesNotMatch(finding.evidence, /mentions none/);
    assert.ok(verdict.unverified.some((u) => u.ac === 'AC2'));
  }

  // The other phrasings in the list, each reached on its own so an accidental deletion
  // of one pattern cannot hide behind another.
  for (const text of ['behavior is unchanged', 'behaviour unchanged', 'no regressions', 'no functional changes']) {
    const verdict = await runGate({
      config: { verify: {} },
      repoRoot: tempRepo(),
      acs: [{ id: 'AC1', text }],
      acMap: [{ ac: 'AC1', command: 'npm test -- behaviour regressions functional changes unchanged' }],
      run: allGreen({ 'npm test -- behaviour regressions functional changes unchanged': { code: 0 } }),
    });
    assert.equal(verdict.pass, false, `"${text}" must be recognised as not-command-settleable`);
    assert.match(
      verdict.findings.find((f) => f.rule === GATE_RULES.mapping_implausible)?.evidence ?? '',
      /absence of change/,
      `"${text}" → ${findingRules(verdict)}`,
    );
  }
});

test('ADDED: a shared file extension is not shared subject matter', async () => {
  // Mutation `word-min-length-dropped` survived: removing the `w.length > 2` filter left
  // every test green. The filter is load-bearing in exactly the repo this runs in — `js`
  // appears in the AC text and in very nearly every command, so counting 2-char tokens
  // as subject matter drifts the overlap check toward "everything is plausible," which
  // is the same end state as deleting it.
  const verdict = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the js entry point is renamed' }],
    // Shares only `js`. Nothing about `node build.js` settles whether an entry point
    // was renamed.
    acMap: [{ ac: 'AC1', command: 'node build.js' }],
    run: runnerFor({ 'node build.js': { code: 0 } }),
  });
  assert.equal(verdict.pass, false, 'a shared file extension must not make a mapping plausible');
  assert.ok(verdict.findings.some((f) => f.rule === GATE_RULES.mapping_implausible), findingRules(verdict));

  // The converse, so this is a test of the threshold and not of "reject everything": a
  // real subject word of three or more characters does establish overlap.
  const ok = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the js entry point is renamed' }],
    acMap: [{ ac: 'AC1', command: 'npm test -- entry' }],
    run: runnerFor({ 'npm test -- entry': { code: 0 } }),
  });
  assert.equal(ok.pass, true, JSON.stringify(ok.findings));
});

test('ADDED: ordinary prose is not a claim — only verification language needs backing', async () => {
  // Mutation `claim-language-filter-removed` survived: with the filter gone, EVERY
  // sentence the worker writes becomes an unbacked_claim. No frozen name notices,
  // because they all supply claims that are verification claims.
  //
  // This matters more than a coverage note. A gate that flags every descriptive
  // sentence produces a findings list nobody reads, and a findings list nobody reads is
  // how a real no-fabrication finding gets scrolled past. The rule is about checkable
  // assertions, not about prose.
  const verdict = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    claims: [
      'Consolidated the four notify call sites into src/notify.js.',
      'The retry helper now takes an explicit attempt count.',
    ],
    run: allGreen(),
  });
  assert.equal(verdict.pass, true, JSON.stringify(verdict.findings));

  // And the same input with verification language added IS a finding — so the test
  // fails if the filter is widened to match nothing.
  const claimed = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    claims: ['Consolidated the four notify call sites into src/notify.js and the suite passes.'],
    run: allGreen(),
  });
  assert.equal(claimed.pass, false);
  assert.ok(claimed.findings.some((f) => f.rule === GATE_RULES.unbacked_claim), findingRules(claimed));
});

test('ADDED: a recorded command with no exit code does not back a claim', async () => {
  // Mutation `exit-presence-not-required` survived, and this one is a gap against the
  // frozen name's own words: "no recorded command + exit code". A command recorded
  // without an exit code is a command someone MEANT to run. Accepting it as backing is
  // the fabrication the rule exists to catch, wearing the shape of evidence.
  const missing = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    claims: ['The lint run is clean.'],
    commands: [{ command: 'npm run lint' }], // no exit
    run: allGreen(),
  });
  assert.equal(missing.pass, false, 'a command with no exit code must not back a claim');
  assert.ok(missing.findings.some((f) => f.rule === GATE_RULES.unbacked_claim), findingRules(missing));

  // exit 0 backs it; a NON-ZERO exit also backs it. The rule is about whether the claim
  // can be checked, not whether it turned out true — §5 rule 4's "even when it happens
  // to be true" cuts both ways, and a gate that only accepted exit 0 as backing would
  // silently push workers toward reporting only green runs.
  for (const exit of [0, 2]) {
    const backed = await runGate({
      config: { verify: {} },
      repoRoot: tempRepo(),
      claims: ['The lint run is clean.'],
      commands: [{ command: 'npm run lint', exit }],
      run: allGreen(),
    });
    assert.deepEqual(findingRules(backed).filter((r) => r === GATE_RULES.unbacked_claim), [], `exit ${exit} must back the claim`);
  }
});

test('ADDED: an off-limits file is reported once, under off_limits, not twice', async () => {
  // Mutation `double-report-off-limits` survived because the frozen off-limits test
  // passes no declaredScope, so the scope filter never runs on the same file. With a
  // scope declared, a vendor file is BOTH off-limits and out of scope, and reporting it
  // twice reads as two independent problems — which is how a triage decision gets made
  // against an inflated count.
  const verdict = await runGate({
    config: CONFIG,
    repoRoot: tempRepo(),
    declaredScope: ['src/retry.js'],
    touched: ['src/retry.js', 'src/vendor/legacy.js'],
    run: allGreen(),
  });

  assert.equal(verdict.pass, false);
  assert.deepEqual(findingRules(verdict), [GATE_RULES.off_limits]);
  // The more specific rule is the one kept: off_limits names the pattern, which is what
  // tells the operator the write was forbidden rather than merely undeclared.
  assert.match(verdict.findings[0].evidence, /src\/vendor\/\*\*/);
});

test('ADDED: path forms that mean the same file are matched the same way', async () => {
  // Mutation `normalize-noop` survived: every frozen name supplies bare relative paths.
  // But `git diff --name-only` and a hand-written scope declaration do not agree on
  // form, and an unnormalized compare reads "not off limits" and PERMITS the write —
  // the same silent-permission failure config.mjs's isOffLimits was written against.
  for (const form of ['src/vendor/legacy.js', './src/vendor/legacy.js', 'src\\vendor\\legacy.js']) {
    const verdict = await runGate({
      config: CONFIG,
      repoRoot: tempRepo(),
      touched: [form],
      run: allGreen(),
    });
    assert.equal(verdict.pass, false, `${form} must be caught as off-limits`);
    assert.ok(verdict.findings.some((f) => f.rule === GATE_RULES.off_limits), `${form} → ${findingRules(verdict)}`);
  }

  // And the declared-scope side, where the two forms appear on opposite sides of the
  // compare: a `./`-prefixed touched file against a bare declared pattern.
  const scoped = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    declaredScope: ['src/retry.js'],
    touched: ['./src/retry.js'],
    run: allGreen(),
  });
  assert.deepEqual(scoped.findings, [], 'a ./-prefixed in-scope file must not be a scope violation');
});

test('ADDED: a duplicate ac_map entry cannot append an opt-out after a real command', async () => {
  // Mutation `duplicate-ac-entry-last-wins` survived. The distinction is not stylistic:
  // last-wins means a worker can propose a command, and — if it fails — append a second
  // entry for the same AC marked unverifiable with a plausible reason. Both entries are
  // individually honest; the pair is an escape hatch. First-wins closes it, and the
  // failing command is still what decides.
  const verdict = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }],
    acMap: [
      { ac: 'AC1', command: 'npm test -- retry loop' },
      { ac: 'AC1', unverifiable: true, reason: 'no characterization tests exist' },
    ],
    run: runnerFor({ 'npm test -- retry loop': { code: 1, output: '1 failing' } }),
  });

  assert.equal(verdict.pass, false, 'an appended unverifiable entry must not excuse a failing command');
  assert.ok(verdict.findings.some((f) => f.rule === GATE_RULES.ac_failed), findingRules(verdict));
  assert.deepEqual(verdict.unverified, [], 'the appended opt-out must not reach unverified[]');
});

test('ADDED: the verdict does not depend on config key insertion order', async () => {
  // Mutation `checks-unsorted` survived because the frozen purity test reuses one frozen
  // CONFIG object, so key order is identical across both runs by construction. Two
  // configs with the same CONTENT and different key order are the same config, and a
  // gate that emits findings in insertion order produces two records that disagree for
  // one repo state — indistinguishable from a real change in behaviour when read later
  // from the telemetry sink.
  const failing = { code: 2, output: 'boom' };
  const run = () => runnerFor({ 'npm test': failing, 'npm run lint': failing });

  const a = await runGate({
    config: { verify: { test: 'npm test', lint: 'npm run lint' } },
    repoRoot: tempRepo(), run: run(),
  });
  const b = await runGate({
    config: { verify: { lint: 'npm run lint', test: 'npm test' } },
    repoRoot: tempRepo(), run: run(),
  });

  assert.equal(a.findings.length, 2);
  assert.deepEqual(b, a, 'findings order must follow the config contents, not its key order');
});

test('ADDED: a shared stopword is not shared subject matter', async () => {
  // Mutation `stopwords-emptied` survived, and finding a pair that discriminates took
  // work — which is itself the finding. Most AC/command pairs share no stopword at all,
  // so the list looks decorative until one does: "all files are formatted" against
  // `npm test -- --all` shares only `all`, a CLI FLAG. With STOPWORDS emptied that
  // counts as subject overlap and the mapping is accepted, so a test-runner invocation
  // settles a formatting AC on exit 0.
  //
  // Kept rather than deleted precisely because the discriminating case is rare: the
  // guard costs nothing and the failure it prevents is a silent pass.
  const verdict = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'all files are formatted' }],
    acMap: [{ ac: 'AC1', command: 'npm test -- --all' }],
    run: runnerFor({ 'npm test -- --all': { code: 0 } }),
  });
  assert.equal(verdict.pass, false, 'a shared stopword must not make a mapping plausible');
  const finding = verdict.findings.find((f) => f.rule === GATE_RULES.mapping_implausible);
  assert.ok(finding, findingRules(verdict));
  assert.match(finding.evidence, /mentions none/);
});

test('ADDED: blocked_reason is null on a pass and on ordinary failed work', async () => {
  // Mutation `blocked-reason-always-set` survived: the frozen unsatisfiable test asserts
  // blocked_reason EQUALS 'unsatisfiable-ac' but nothing ever asserted it is null
  // otherwise, so a gate that stamped every verdict as blocked was green.
  //
  // §8.5 makes that consequential rather than cosmetic. `blocked_reason` is what the
  // loop reads to decide whether to stop, comment, and label `alfred:blocked` — and a
  // blocked item is SKIPPED on later ticks. Always-set means the first tick labels
  // everything blocked and the loop then has nothing workable left, which terminates as
  // "nothing to do" rather than as a bug.
  const passing = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }],
    acMap: [{ ac: 'AC1', command: 'npm test -- retry loop' }],
    run: allGreen({ 'npm test -- retry loop': { code: 0 } }),
  });
  assert.equal(passing.pass, true, JSON.stringify(passing.findings));
  assert.equal(passing.blocked_reason, null);

  // Ordinary failed work is NOT blocked: the worker can act on it, so labelling it
  // blocked would take a fixable item out of the loop's reach permanently.
  const failing = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the retry loop is consolidated' }],
    acMap: [{ ac: 'AC1', command: 'npm test -- retry loop' }],
    run: runnerFor({ 'npm test -- retry loop': { code: 1, output: '1 failing' } }),
  });
  assert.equal(failing.pass, false);
  assert.equal(failing.blocked_reason, null, 'ordinary failed work must not be labelled blocked');
});

test('ADDED: a declared-scope pattern is normalized too, not just the touched file', async () => {
  // Mutation `scope-pattern-not-normalized` survived, and unlike the two equivalent
  // mutants noted in PLAN.md this one is a real hole: `matchesGlob('src/retry.js',
  // './src/retry.js')` is FALSE, so a `./`-prefixed pattern in a declared scope fails to
  // match the very file it names. The earlier normalization test only exercised the
  // touched-file side of the compare.
  //
  // The failure is the loud kind rather than the silent kind — an in-scope file reported
  // as a scope violation — but it fails a CORRECT run, and a gate that fails correct
  // work is one the operator learns to override.
  const verdict = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    declaredScope: ['./src/retry.js', './src/channels/**'],
    touched: ['src/retry.js', 'src/channels/email.js'],
    run: allGreen(),
  });
  assert.deepEqual(verdict.findings, [], 'a ./-prefixed declared pattern must match the file it names');
  assert.equal(verdict.pass, true);
});

test('ADDED: an AC with no usable subject words is not silently plausible', async () => {
  // Mutation `empty-subject-not-skipped` survived. With the `subject.length === 0` early
  // return gone, an AC of pure stopwords ("a b c") gets an empty subject set, the
  // overlap check finds nothing to match, and the gate reports mapping_implausible for
  // every command — failing correct work on an AC nobody can write a better command for.
  //
  // The current behaviour is the deliberate one: an AC with no subject cannot be judged
  // implausible, because there is nothing to compare against. It is a ticket-quality
  // problem, and §5's five states have a channel for that — but inventing an
  // implausibility finding from an empty comparison is not it.
  for (const text of ['', '   ', 'a b c']) {
    const verdict = await runGate({
      config: { verify: {} },
      repoRoot: tempRepo(),
      acs: [{ id: 'AC1', text }],
      acMap: [{ ac: 'AC1', command: 'npm test' }],
      run: allGreen(),
    });
    assert.deepEqual(
      findingRules(verdict).filter((r) => r === GATE_RULES.mapping_implausible),
      [],
      `text ${JSON.stringify(text)} has no subject to compare, so implausibility is not decidable`,
    );
    assert.equal(verdict.pass, true, JSON.stringify(verdict.findings));
  }

  // Guard against the opposite reading of the same early return: an AC WITH a subject
  // must still be checked, so this test cannot be satisfied by skipping the check
  // entirely.
  const real = await runGate({
    config: { verify: {} },
    repoRoot: tempRepo(),
    acs: [{ id: 'AC1', text: 'the notification channels are consolidated' }],
    acMap: [{ ac: 'AC1', command: 'git status --porcelain' }],
    run: runnerFor({ 'git status --porcelain': { code: 0 } }),
  });
  assert.ok(real.findings.some((f) => f.rule === GATE_RULES.mapping_implausible), findingRules(real));
});

// A hash of every tracked path's bytes plus the sorted path list, so a write, a
// deletion, and a new file all change it. `git status` would not: the temp repos here
// are not git repos, and the gate must be provable outside one.
function treeHash(root) {
  const listing = execFileSync('find', [root, '-type', 'f'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
  const parts = listing.map((p) => `${p.slice(root.length)} ${readFileSync(p, 'utf8')}`);
  return `${listing.length}:${parts.join('')}`;
}
