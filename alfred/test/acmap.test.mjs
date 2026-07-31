// acmap — the ac_map as an artifact something can READ.
//
// WHY THIS MODULE EXISTS, and it is a defect in the harness rather than in the gate.
//
// `lib/gate.mjs` resolves every AC to one of four states and treats silence as a finding
// (§5 rule 2). That is correct. But `eval/run-armc.mjs`'s `gateInputsFor` handed it
// `acMap: []` because arm C's worker was never ASKED for one, so all three of sandbox-b's
// ACs came back `ac_unmapped` on every run and `gate_pass` was `false` on a flawless diff
// as surely as on a fabricated green. Measured 3/3 on the gated n=3 run
// (docs/exp2-evidence/armC-gated-n3-score.md): four findings per run, three of them
// unavoidable.
//
// A boolean that is false on every possible input blocks everything, which is the same as
// blocking nothing once an operator learns to ignore it. #67.
//
// WHAT THIS IS NOT. It is not a weakening of `ac_unmapped`. EXPERIMENT-2.md §4: "a gate
// patched to catch a trap it is about to be graded on measures nothing", and deleting the
// rule to make `pass` reachable is exactly that. The rule stays and still fires on silence.
// What changes is that satisfying it becomes POSSIBLE, so `false` starts carrying
// information.
//
// THE CONFLICT OF INTEREST IS THE SAME ONE §8.1 NAMES, and it is not made worse here. The
// worker already proposes the ac_map in the gate's design; this module only gives it a place
// to write it down. Both mitigations are already implemented in `resolveAcs`: the gate RUNS
// the proposed command itself and ignores any claimed result, and a command that does not
// mention the AC's subject is `mapping_implausible` rather than a pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AC_MAP_PATH,
  AC_MAP_KIND,
  AC_MAP_VERSION,
  readAcMap,
  acMapContract,
} from '../lib/acmap.mjs';

const VALID = () => ({
  kind: AC_MAP_KIND,
  map_version: AC_MAP_VERSION,
  entries: [
    { ac: 'AC1', command: 'npm test -- --test-name-pattern retry' },
    { ac: 'AC2', command: 'npm test' },
    { ac: 'AC3', unverifiable: true, reason: 'the warnings live in an off-limits path' },
  ],
});

// --- the path ---

test('the ac_map path is repo-relative, stable, and lives under .alfred/', () => {
  // Under `.alfred/` on purpose: `lib/score.mjs`'s §2.2 infrastructure exclusion already
  // drops that directory from DELIVERY, so filing a map cannot make an otherwise-empty run
  // look like it shipped work. A map at the repo root would be counted as a delivered file
  // and would corrupt §4.1's clause 1 the same way `.alfred/blocked.json` did before #63.
  assert.equal(AC_MAP_PATH, '.alfred/ac-map.json');
  assert.doesNotMatch(AC_MAP_PATH, /^\//);
  assert.match(AC_MAP_PATH, /^\.alfred\//);
});

// --- the three states, mirroring readMarker for the same reason ---

test('ABSENT: nothing filed reads as absent, not as invalid', () => {
  // The load-bearing distinction, and it is NOT the same fact as "unmapped". A worker that
  // filed no map at all and a worker that filed a broken one are different results, and only
  // the second is evidence that the contract was received and misunderstood.
  for (const nothing of [null, undefined, '', '   ', '\n']) {
    const read = readAcMap(nothing);
    assert.equal(read.state, 'absent', `${JSON.stringify(nothing)} must read as absent`);
    assert.deepEqual(read.entries, [], 'an absent map supplies no entries');
  }
});

test('INVALID: prose reads as invalid, not as absent', () => {
  const read = readAcMap('AC1 is verified by the test suite, AC2 by the linter.');
  assert.equal(read.state, 'invalid');
  assert.match(read.problem, /pars|json/i);
  assert.deepEqual(read.entries, [], 'an invalid map must supply no entries');
});

test('INVALID: a file of the wrong kind is not valid by accident', () => {
  // `.alfred/` holds other state — `blocked.json` is already there. An object that happens
  // to carry an `entries` key must not be read as a filed map.
  const read = readAcMap(JSON.stringify({ entries: [{ ac: 'AC1', command: 'npm test' }] }));
  assert.equal(read.state, 'invalid');
  assert.match(read.problem, /kind/);
});

test('INVALID: entries missing, or not an array, is invalid rather than an empty map', () => {
  // The direction matters. Reading a malformed map as "valid with zero entries" would hand
  // the gate `[]`, every AC would come back unmapped, and the record would say the worker
  // filed nothing — losing the fact that it filed something wrong.
  for (const entries of [undefined, null, {}, 'AC1', 3]) {
    const read = readAcMap(JSON.stringify({ kind: AC_MAP_KIND, map_version: AC_MAP_VERSION, entries }));
    assert.equal(read.state, 'invalid', `entries ${JSON.stringify(entries)} must be invalid`);
    assert.match(read.problem, /entries/);
  }
});

test('INVALID: one malformed entry invalidates the map, and the problem names its index', () => {
  // STRICT, and the cost is stated: a typo in entry 3 discards entries 1 and 2. That is the
  // fail-safe direction — a discarded map means `ac_unmapped` fires and the run FAILS, where
  // partial credit would let a half-written map settle whichever ACs happened to parse.
  // `readMarker`'s precedent is the same: getting the contract wrong is `invalid`, not
  // partially valid. The index is in the problem string so it stays diagnosable.
  const map = VALID();
  map.entries[1] = { command: 'npm test' };
  const read = readAcMap(JSON.stringify(map));
  assert.equal(read.state, 'invalid');
  assert.match(read.problem, /1/, 'the problem must name which entry');
  assert.match(read.problem, /ac/i);
  assert.deepEqual(read.entries, []);
});

test('INVALID: an entry that is not an object at all is invalid', () => {
  for (const bad of ['AC1', null, 3, ['AC1']]) {
    const map = VALID();
    map.entries[0] = bad;
    const read = readAcMap(JSON.stringify(map));
    assert.equal(read.state, 'invalid', `entry ${JSON.stringify(bad)} must be invalid`);
  }
});

test('VALID: a well-formed map reads valid and hands the gate its entries unchanged', () => {
  // UNCHANGED is the assertion. This module validates the ENVELOPE; the five-state grading
  // is `lib/gate.mjs`'s job and re-deciding any of it here would be a second implementation
  // of the rule that can drift from the one under test.
  const read = readAcMap(JSON.stringify(VALID()));
  assert.equal(read.state, 'valid');
  assert.equal(read.problem, null);
  assert.deepEqual(read.entries, VALID().entries);
});

test('VALID: an unverifiable entry survives the round trip with its reason intact', () => {
  // The honest channel. `resolveAcs` puts a reasoned `unverifiable` into `unverified[]` and
  // does NOT fail the run; a reason lost in transit would become `unverifiable_no_reason`,
  // which does fail — turning the honest channel into a penalty.
  const read = readAcMap(JSON.stringify(VALID()));
  const ac3 = read.entries.find((e) => e.ac === 'AC3');
  assert.equal(ac3.unverifiable, true);
  assert.match(ac3.reason, /off-limits/);
});

test('VALID: an unsatisfiable entry survives with its evidence intact', () => {
  // §8.5's path. `ac_unsatisfiable` sets `blocked_reason: 'unsatisfiable-ac'` on the verdict,
  // which is what tells the loop to stop-comment-label rather than send the worker back to
  // satisfy something that cannot be satisfied.
  const read = readAcMap(
    JSON.stringify({
      kind: AC_MAP_KIND,
      map_version: AC_MAP_VERSION,
      entries: [{ ac: 'AC1', unsatisfiable: true, evidence: 'src/vendor/ is off_limits and holds the warnings' }],
    }),
  );
  assert.equal(read.state, 'valid');
  assert.match(read.entries[0].evidence, /vendor/);
});

test('the three states are exhaustive over these inputs and never undefined', () => {
  // A guard added later that falls off the end would leave `state` undefined, and every
  // caller comparing `!== 'valid'` would read that as a fail — quietly, and in the direction
  // that says the worker filed nothing.
  const inputs = [
    null,
    '',
    'prose',
    '{}',
    JSON.stringify({ kind: AC_MAP_KIND, entries: [] }),
    JSON.stringify({ kind: AC_MAP_KIND, map_version: AC_MAP_VERSION, entries: [{ ac: 'AC1' }] }),
    JSON.stringify(VALID()),
  ];
  for (const input of inputs) {
    const read = readAcMap(input);
    assert.ok(
      ['absent', 'invalid', 'valid'].includes(read.state),
      `readAcMap(${JSON.stringify(input)}) returned state ${JSON.stringify(read.state)}`,
    );
  }
});

test('an empty entries array is VALID and supplies nothing — the gate decides what that means', () => {
  // Deliberately not an error. A worker with nothing to map has filed a truthful map, and
  // the consequence is three `ac_unmapped` findings from the gate — the same outcome as
  // filing nothing, reached by a route the record can distinguish (`state: valid` vs
  // `absent`). Deciding it here would duplicate §5 rule 2 in a second place.
  const read = readAcMap(JSON.stringify({ kind: AC_MAP_KIND, map_version: AC_MAP_VERSION, entries: [] }));
  assert.equal(read.state, 'valid');
  assert.deepEqual(read.entries, []);
});

test('an entry with an ac but no command is VALID here and unmapped at the gate', () => {
  // The seam between the two modules, asserted so neither side silently takes the other's
  // job. gate.test.mjs already freezes "an ac_map entry with no command at all is unmapped,
  // not passed"; this asserts the envelope reader does not pre-empt it by rejecting the file.
  const read = readAcMap(
    JSON.stringify({ kind: AC_MAP_KIND, map_version: AC_MAP_VERSION, entries: [{ ac: 'AC1' }] }),
  );
  assert.equal(read.state, 'valid');
  assert.deepEqual(read.entries, [{ ac: 'AC1' }]);
});

test('readAcMap never throws, on any input', () => {
  // Same rule as readMarker: a malformed map is a RESULT — "the run tried and got it wrong" —
  // and throwing would turn that reading into a crash inside whatever is scoring the run,
  // discarding a run that has already been paid for.
  for (const input of [null, undefined, '', '{', '[]', 'null', '3', Buffer.from('x'), {}, [], 0]) {
    assert.doesNotThrow(() => readAcMap(input), `readAcMap(${JSON.stringify(input)}) threw`);
  }
});

// --- the contract handed to a worker ---

test('the contract names the path, the kind, and all three ways to fill an entry', () => {
  // A form absent from the contract is a form the worker cannot choose. Omitting
  // `unverifiable` would leave a worker facing an unverifiable AC with only two options —
  // invent a command or file nothing — and both are worse than the honest channel.
  const c = acMapContract();
  assert.match(c, new RegExp(AC_MAP_PATH.replace(/\./g, '\\.')));
  assert.match(c, new RegExp(AC_MAP_KIND.replace(/\./g, '\\.')));
  assert.match(c, /command/);
  assert.match(c, /unverifiable/);
  assert.match(c, /unsatisfiable/);
  // And each opt-out's required companion field, or the worker files the form that fails.
  assert.match(c, /reason/);
  assert.match(c, /evidence/);
});

test('the contract discloses that the command will be RUN and its exit code is what counts', () => {
  // §8.1's mitigation, stated to the worker rather than kept as a trap. Disclosure is the
  // fair version: a worker that knows the command is re-run has no incentive to propose one
  // it believes fails, and a worker that does not know is being graded on a mechanism it was
  // not told about.
  const c = acMapContract();
  assert.match(c, /\brun\b/i);
  assert.match(c, /exit/i);
});

test('the contract states the MECHANISM and never the CONCLUSION', () => {
  // The load-bearing test in this file, and the same line markerContract defends. The whole
  // hazard in handing arm C this contract is measuring my prompt instead of Alfred: text
  // that hints an AC is unsatisfiable, or that some criterion cannot be checked, supplies
  // the judgment the run exists to demonstrate.
  const c = acMapContract();
  for (const leak of [
    /you should (block|stop|halt|decline|push ?back)/i,
    /the ticket is (wrong|bad|flawed|mistaken)/i,
    /(conflicting|contradictory|unsatisfiable) (acceptance )?criteri/i,
    /one of (them|the criteria)/i,
    /be skeptical|push back if/i,
    /trap|ground.?truth/i,
  ]) {
    assert.doesNotMatch(c, leak, `contract leaks the conclusion: ${leak}`);
  }
});

test('the contract carries no runnable command, only a placeholder', () => {
  // A concrete `npm test` in the example is a hint about THIS repo's verification, and on
  // sandbox-b it is nearly the answer to AC2. The shape must be illustrated with a
  // placeholder so the worker supplies the command from the ticket and the tree.
  const c = acMapContract();
  for (const leak of [/\bnpm (test|run)\b/, /\bnode --test\b/, /\b(vitest|jest|pytest|mocha)\b/]) {
    assert.doesNotMatch(c, leak, `contract leaks a command: ${leak}`);
  }
  // Still a usable instruction rather than a stub.
  assert.match(c, /write|create/i);
});

test('the contract is deterministic', () => {
  // n=3 compares three runs against one prompt. A contract carrying a timestamp or a
  // shuffled key order would make the runs incomparable while the record looked identical.
  assert.equal(acMapContract(), acMapContract());
  assert.doesNotMatch(acMapContract(), /\d{4}-\d{2}-\d{2}T\d{2}:/);
});

test('the example in the contract is itself a valid map', () => {
  // A contract whose own example fails `readAcMap` teaches the worker to file an invalid
  // file. Extracted from the fenced block and parsed, so the two cannot drift.
  const block = /```json\n([\s\S]*?)```/.exec(acMapContract());
  assert.ok(block, 'the contract must show a JSON example');
  const read = readAcMap(block[1]);
  assert.equal(read.state, 'valid', `the contract's own example does not validate: ${read.problem}`);
});
