// blocked — what Alfred does when he cannot get past something.
//
// The policy (PLAN.md §8.5, decided):
//
//   Stop the run. Comment on the ticket saying what blocked and why. Apply a
//   marker label. The loop keeps running on later ticks but SKIPS blocked items.
//   When nothing unblocked remains, terminate the loop.
//
// Why a label rather than run-local state: the loop is stateless between ticks by
// design (PLAN.md §2.2 — "the loop is `while`, not a prompt"). The ticket itself is
// the only thing that survives, so the ticket carries the marker. A human removing
// the label is the unblock gesture, which needs no extra tooling.
//
// Everything here is pure — `plan*` decides, a caller executes. Same split as
// eval-issue.mjs, and it is what lets the whole policy be tested without a network.

export const BLOCKED_LABEL = 'alfred:blocked';

// A closed set, so "how often does Alfred block, and on what" is answerable by
// aggregating telemetry instead of grepping prose.
export const REASONS = Object.freeze({
  'unsatisfiable-ac': 'an acceptance criterion cannot be satisfied as written',
  'ambiguous-requirement': 'the requirement admits two materially different readings',
  'missing-access': 'a required permission or resource is unavailable',
  'verification-failed': 'the work could not be verified, so it will not be reported as done',
});

function labelNames(item) {
  // `gh issue view --json labels` returns [{name}], a hand-built item may hold
  // plain strings. Reading only one form would make blocked items look workable.
  return (item?.labels ?? []).map((label) =>
    typeof label === 'string' ? label : (label?.name ?? ''),
  );
}

export function isBlocked(item) {
  return labelNames(item).some((name) => name.toLowerCase() === BLOCKED_LABEL.toLowerCase());
}

// The comment a human actually reads. Two things it must always say: that the run
// stopped, and that a reply is what resumes it. Alfred's register, per
// docs/PERSONA.md §3 — this is one of the four surfaces where the voice is allowed.
export function blockComment({ reason, detail }) {
  return [
    `**Halted — \`${BLOCKED_LABEL}\`**`,
    '',
    `I have stopped work on this item rather than proceed on a guess: ${REASONS[reason]}.`,
    '',
    detail,
    '',
    'I will skip this item on subsequent rounds until someone replies here and removes ' +
      `the \`${BLOCKED_LABEL}\` label. Nothing has been merged, and no acceptance criterion ` +
      'has been reported as met.',
    '',
    `_Reason code: \`${reason}\`._`,
    '',
  ].join('\n');
}

export function planBlock({ item, reason, detail } = {}) {
  if (!REASONS[reason]) {
    throw new Error(
      `unrecognised block reason '${reason}'. Use one of: ${Object.keys(REASONS).join(', ')}. ` +
        'Free-text reasons cannot be aggregated across runs.',
    );
  }
  if (!detail || !String(detail).trim()) {
    throw new Error(
      'a block needs a detail explaining the specific obstacle. "Blocked" with no ' +
        'explanation tells the reader nothing they did not already know.',
    );
  }

  // Re-blocking would stack identical comments and bury the original explanation,
  // and the loop re-reads every item each tick.
  if (isBlocked(item)) {
    return { action: 'noop', number: item?.number, reason, alreadyBlocked: true };
  }

  return {
    action: 'block',
    number: item?.number,
    repo: item?.repo,
    reason,
    detail,
    comment: blockComment({ reason, detail }),
    // Additive, not a replacement set: a full set would drop any label a human
    // added between ticks.
    addLabels: [BLOCKED_LABEL],
    alreadyBlocked: false,
  };
}

// First workable item in source order. Order is the caller's business — the loop
// takes one item per tick, so silently reordering here would quietly redefine
// "pick the oldest open issue".
export function selectNext(items = []) {
  return items.find((item) => !isBlocked(item)) ?? null;
}

// One tick's decision. `continue: false` means the loop stops — either because
// everything left needs a human, or because there is nothing to do at all. Those
// are different states and are reported differently.
export function planTick({ items = [] } = {}) {
  const blockedCount = items.filter(isBlocked).length;
  const item = selectNext(items);

  if (item) return { action: 'work', item, continue: true, blockedCount };

  return {
    action: 'terminate',
    continue: false,
    blockedCount,
    reason: blockedCount
      ? `every remaining item is blocked (${blockedCount}) — each awaits a human reply`
      : 'no items to work',
  };
}
