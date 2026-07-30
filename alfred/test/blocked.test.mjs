// The blocked-item policy. See docs/BLOCKED.md.
//
// Four propositions, deliberately separated — folding them into one function would
// make at most one of them testable (see the AC1 conjunct in score.test.mjs for
// what that costs):
//
//   1. A block decision names WHY it blocked, and refuses to be vague.
//   2. Marking an item blocked is idempotent and preserves existing labels.
//   3. The loop SKIPS blocked items rather than retrying them.
//   4. The loop TERMINATES when nothing unblocked remains — it does not spin.
//
// Everything here is pure. `plan*` decides, a caller executes, which is the same
// split eval-issue.mjs uses and is what makes a network-free test possible.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCKED_LABEL,
  REASONS,
  planBlock,
  blockComment,
  isBlocked,
  selectNext,
  planTick,
} from '../lib/blocked.mjs';

// --- 1. a block names its reason ---

test('a block decision carries the reason and the item', () => {
  const plan = planBlock({
    item: { number: 7, repo: 'owner/repo' },
    reason: 'unsatisfiable-ac',
    detail: 'AC3 demands 0 warnings; both are in off-limits src/vendor/.',
  });

  assert.equal(plan.action, 'block');
  assert.equal(plan.number, 7);
  assert.equal(plan.reason, 'unsatisfiable-ac');
  assert.match(plan.comment, /vendor/);
  assert.deepEqual(plan.addLabels, [BLOCKED_LABEL]);
});

test('a block with no detail is refused', () => {
  // "Blocked" with no explanation is the failure mode this policy exists to
  // prevent: a human opens the ticket and learns nothing they did not know.
  assert.throws(
    () => planBlock({ item: { number: 7 }, reason: 'unsatisfiable-ac', detail: '' }),
    /detail/,
  );
});

test('a block with an unrecognised reason is refused', () => {
  // Free-text reasons cannot be aggregated. A closed set means "how often does
  // Alfred block, and on what" is answerable from the telemetry.
  assert.throws(() => planBlock({ item: { number: 7 }, reason: 'because', detail: 'x' }), /reason/);
});

test('every recognised reason produces a comment naming the reason', () => {
  for (const reason of ['unsatisfiable-ac', 'ambiguous-requirement', 'missing-access', 'verification-failed']) {
    const plan = planBlock({ item: { number: 1 }, reason, detail: 'specifics here' });
    assert.match(plan.comment, /specifics here/, `${reason} must carry its detail`);
    assert.ok(plan.comment.length > 40, `${reason} comment must not be a stub`);
  }
});

test('the comment states the run stopped and that a human reply unblocks it', () => {
  // Both halves matter. Without the first a reader assumes work continued; without
  // the second they do not know the ball is in their court.
  const { comment } = planBlock({
    item: { number: 7 },
    reason: 'ambiguous-requirement',
    detail: 'Two structurally different options, neither chosen.',
  });
  assert.match(comment, /stopped|halted/i);
  assert.match(comment, /repl(y|ies)|respond|comment/i);
});

test('the comment carries the blocked marker so it is findable', () => {
  const comment = blockComment({ reason: 'missing-access', detail: 'No push rights.' });
  assert.match(comment, new RegExp(BLOCKED_LABEL));
});

// --- 1b. the persona boundary, on the one surface that ships as code ---
//
// PERSONA.md §5 permits the voice here but restricts "Master Wayne" to the operator's
// own console: this comment lands in a shared ticket queue where a teammate reads it,
// and the harness cannot know who is watching. The rule is prose in a doc, which rots
// silently; asserting it is what makes it hold.

test('the blocked comment does not address the reader as Master Wayne', () => {
  for (const reason of Object.keys(REASONS)) {
    const comment = blockComment({ reason, detail: 'Specifics of the obstacle.' });
    assert.doesNotMatch(comment, /master wayne/i, `${reason} must not use the nickname`);
  }
});

test('the blocked comment says what is unverified rather than dressing it up', () => {
  // PERSONA.md §6's corollary: never let good manners read as a pass. A comment
  // claiming order while the run is halted is the specific failure to prevent.
  const comment = blockComment({
    reason: 'verification-failed',
    detail: 'The build could not be run: the toolchain is absent.',
  });
  assert.doesNotMatch(comment, /impeccable order|all is well|everything is fine/i);
  // Two separate assertions, not one alternation. `/merged|reported as met/` would
  // stay green after either clause was deleted — the same trap as the AC1 conjunct,
  // in mirror: an OR makes each branch individually unfalsifiable.
  assert.match(comment, /nothing has been merged/i, 'must say nothing was merged');
  assert.match(comment, /reported as met/i, 'must say no AC was claimed');
});

// --- 2. marking is idempotent and preserves labels ---

test('blocking an item that already has other labels keeps them', () => {
  const plan = planBlock({
    item: { number: 7, labels: ['eval', 'bug'] },
    reason: 'missing-access',
    detail: 'No push rights on the base branch.',
  });
  // addLabels is additive by design — a full label set would silently drop any
  // label added by a human between ticks.
  assert.deepEqual(plan.addLabels, [BLOCKED_LABEL]);
  assert.equal(plan.alreadyBlocked, false);
});

test('blocking an already-blocked item is a noop, not a duplicate comment', () => {
  // The loop re-reads the item every tick. Commenting each time would bury the
  // original explanation under identical copies.
  const plan = planBlock({
    item: { number: 7, labels: ['eval', BLOCKED_LABEL] },
    reason: 'missing-access',
    detail: 'No push rights.',
  });
  assert.equal(plan.action, 'noop');
  assert.equal(plan.alreadyBlocked, true);
});

test('isBlocked reads the label regardless of case or surrounding labels', () => {
  assert.equal(isBlocked({ labels: [BLOCKED_LABEL] }), true);
  assert.equal(isBlocked({ labels: ['eval', BLOCKED_LABEL, 'bug'] }), true);
  assert.equal(isBlocked({ labels: [BLOCKED_LABEL.toUpperCase()] }), true);
  assert.equal(isBlocked({ labels: ['eval'] }), false);
  assert.equal(isBlocked({ labels: [] }), false);
  assert.equal(isBlocked({}), false);
});

test('isBlocked accepts the object form gh returns for labels', () => {
  // `gh issue view --json labels` yields [{name: 'x'}], not ['x']. Reading only
  // the string form would make every blocked item look workable.
  assert.equal(isBlocked({ labels: [{ name: BLOCKED_LABEL }] }), true);
  assert.equal(isBlocked({ labels: [{ name: 'eval' }] }), false);
});

// --- 3. the loop skips blocked items ---

test('selectNext skips a blocked item and takes the next workable one', () => {
  const picked = selectNext([
    { number: 1, labels: [BLOCKED_LABEL] },
    { number: 2, labels: ['eval'] },
  ]);
  assert.equal(picked.number, 2);
});

test('selectNext returns null when every item is blocked', () => {
  const picked = selectNext([
    { number: 1, labels: [BLOCKED_LABEL] },
    { number: 2, labels: [{ name: BLOCKED_LABEL }] },
  ]);
  assert.equal(picked, null);
});

test('selectNext preserves source order among workable items', () => {
  // The loop takes one item per tick. If selection reordered, "pick the oldest
  // open issue" would silently become "pick whichever".
  const picked = selectNext([
    { number: 5, labels: [] },
    { number: 3, labels: [] },
  ]);
  assert.equal(picked.number, 5);
});

test('selectNext on an empty list is null, not an error', () => {
  assert.equal(selectNext([]), null);
});

// --- 4. the loop terminates rather than spinning ---

test('a tick with a workable item plans work and continues', () => {
  const tick = planTick({ items: [{ number: 2, labels: ['eval'] }] });
  assert.equal(tick.action, 'work');
  assert.equal(tick.item.number, 2);
  assert.equal(tick.continue, true);
});

test('a tick where every item is blocked terminates the loop', () => {
  // The decision: "at that point terminate the loop." A loop that kept waking to
  // re-skip the same blocked items would burn schedule slots forever.
  const tick = planTick({ items: [{ number: 1, labels: [BLOCKED_LABEL] }] });
  assert.equal(tick.action, 'terminate');
  assert.equal(tick.continue, false);
  assert.match(tick.reason, /blocked/);
});

test('a tick with no items at all terminates', () => {
  const tick = planTick({ items: [] });
  assert.equal(tick.action, 'terminate');
  assert.equal(tick.continue, false);
});

test('terminating distinguishes all-blocked from nothing-to-do', () => {
  // Both stop the loop, and they mean different things to whoever reads the log:
  // one needs a human reply, the other is a clean idle.
  const allBlocked = planTick({ items: [{ number: 1, labels: [BLOCKED_LABEL] }] });
  const empty = planTick({ items: [] });
  assert.notEqual(allBlocked.reason, empty.reason);
  assert.equal(allBlocked.blockedCount, 1);
  assert.equal(empty.blockedCount, 0);
});

test('a mixed list works the unblocked item even when most are blocked', () => {
  const tick = planTick({
    items: [
      { number: 1, labels: [BLOCKED_LABEL] },
      { number: 2, labels: [BLOCKED_LABEL] },
      { number: 3, labels: ['eval'] },
    ],
  });
  assert.equal(tick.action, 'work');
  assert.equal(tick.item.number, 3);
  assert.equal(tick.blockedCount, 2);
});

// --- shape ---

test('planTick never mutates the items it was handed', () => {
  const items = [{ number: 1, labels: [BLOCKED_LABEL] }, { number: 2, labels: ['eval'] }];
  const snapshot = JSON.stringify(items);
  planTick({ items });
  assert.equal(JSON.stringify(items), snapshot);
});

test('the blocked label is a single stable string', () => {
  // Written into real tickets and read back on later ticks. If it drifted, every
  // previously-blocked item would silently become workable again.
  assert.equal(typeof BLOCKED_LABEL, 'string');
  assert.equal(BLOCKED_LABEL, 'alfred:blocked');
});
