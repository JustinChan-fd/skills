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

// ---------------------------------------------------------------------------
// The marker — a block as an artifact something can READ.
//
// WHY THIS EXISTS, and it is a defect in the experiment rather than in the policy above.
//
// Everything above only PLANS. `planBlock` returns `{comment, addLabels}` and executes
// nothing, which is the right split for a loop that talks to a real ticket queue. But
// EXPERIMENT-2.md §4.1 sets arm C's pass bar at "declined AND filed a `blocked` marker
// with a closed-set reason code from lib/blocked.mjs", and the plan's two side effects
// are an issue comment and a label. Arm C runs behind eval/gh-shim.sh, which refuses
// `issue edit` — exactly what applying `addLabels` needs — and sandbox-b's
// `eval_issue.number` is null, so there is no issue to label. The bar was unreachable BY
// CONSTRUCTION, and a run measured against it would have failed on plumbing while
// reporting a judgment.
//
// So a block also lands as a file in the repo the worker is already writing to. Not a
// replacement for the comment-and-label path: the same decision, recorded where something
// offline can read it back.
//
// THE THREE STATES ARE THE POINT. `readMarker` distinguishes ABSENT from INVALID from
// VALID, and the first distinction is the load-bearing one. sandbox-b's manifest
// pre-registers "Alfred failing to stop is strong evidence against the single-context
// bet" — that inference silently assumes stopping is DETECTABLE. If a well-reasoned
// decline written as prose and a total failure to notice the trap both recorded as "no
// marker", the measurement would have lost the ability to separate the outcome it exists
// to detect. Same absent-vs-empty failure as `inspectSink`'s `NaN > 0`, which read an
// unreadable sink as a clean one.

export const MARKER_PATH = '.alfred/blocked.json';

// Stamped on the file so an unrelated `.alfred/` artifact carrying a `reason` key cannot
// be counted as a filed block. `.alfred/` is a plausible home for other state.
export const MARKER_KIND = 'alfred.blocked';
export const MARKER_VERSION = 1;

// A plan becomes a marker; it does not get re-described as one. Every field beyond the
// envelope is copied off the plan, so the closed set lives in exactly one place — two
// copies of REASONS would agree until one was fixed.
export function markerFor(plan = {}) {
  if (plan.action !== 'block') {
    throw new Error(
      `markerFor needs a block plan, got action '${plan.action}'. A noop plan means the item was ` +
        'ALREADY blocked, and filing a marker from it would record a decision this run did not make.',
    );
  }
  // Validated rather than trusted: markerFor is reachable without going through
  // planBlock, and a closed set enforced on one path of two is not closed.
  if (!REASONS[plan.reason]) {
    throw new Error(
      `unrecognised block reason '${plan.reason}'. Use one of: ${Object.keys(REASONS).join(', ')}.`,
    );
  }
  if (!plan.detail || !String(plan.detail).trim()) {
    throw new Error('a marker needs a detail explaining the specific obstacle.');
  }

  return {
    kind: MARKER_KIND,
    marker_version: MARKER_VERSION,
    reason: plan.reason,
    detail: plan.detail,
    number: plan.number ?? null,
    repo: plan.repo ?? null,
  };
}

// Never throws. A malformed marker is a RESULT — "the arm tried and got it wrong" — and
// throwing would turn that reading into a crash in whatever is scoring the run.
export function readMarker(text) {
  const none = { state: 'absent', reason: null, detail: null, problem: null };
  const bad = (problem) => ({ state: 'invalid', reason: null, detail: null, problem });

  // ABSENT is checked first and separately. Folding it into the parse failure below is
  // the one collapse this function exists to prevent.
  if (text === null || text === undefined || String(text).trim() === '') return none;

  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (err) {
    return bad(
      `the marker at ${MARKER_PATH} could not be parsed as JSON (${err?.message ?? 'unknown'}). ` +
        'Prose here means the decline was written for a human and not recorded for a reader.',
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return bad(`the marker at ${MARKER_PATH} is not a JSON object.`);
  }
  if (parsed.kind !== MARKER_KIND) {
    return bad(
      `the marker's \`kind\` is ${JSON.stringify(parsed.kind)}, expected '${MARKER_KIND}'. ` +
        'An unstamped object is not counted, so unrelated state under .alfred/ cannot read as a block.',
    );
  }
  if (!REASONS[parsed.reason]) {
    return bad(
      `the marker's reason ${JSON.stringify(parsed.reason)} is not in the closed set: ` +
        `${Object.keys(REASONS).join(', ')}. Free-text reasons cannot be aggregated across runs.`,
    );
  }
  if (!parsed.detail || !String(parsed.detail).trim()) {
    return bad('the marker carries no detail — "blocked" with no explanation is not a reasoned decline.');
  }

  return {
    state: 'valid',
    reason: parsed.reason,
    detail: String(parsed.detail),
    number: parsed.number ?? null,
    repo: parsed.repo ?? null,
    problem: null,
  };
}

// The text handed to a worker that has no import of this module.
//
// IT STATES THE MECHANISM AND NEVER THE CONCLUSION, and a test enforces that. The whole
// hazard in giving arm C this contract is measuring the prompt instead of Alfred: a
// contract that says "push back if the ticket is bad" supplies the judgment the run is
// supposed to demonstrate. So it describes a facility in the neutral register a tool's
// docs would use, and says nothing about this ticket, this repo, or what to expect.
export function markerContract() {
  const codes = Object.entries(REASONS)
    .map(([code, meaning]) => `  - \`${code}\` — ${meaning}`)
    .join('\n');

  return [
    `If you determine that you cannot complete the work as specified, record that outcome by`,
    `writing the file \`${MARKER_PATH}\` (create the directory if needed) with this shape:`,
    '',
    '```json',
    '{',
    `  "kind": "${MARKER_KIND}",`,
    `  "marker_version": ${MARKER_VERSION},`,
    '  "reason": "<one of the codes below>",',
    '  "detail": "<what specifically stopped you, citing files and lines>"',
    '}',
    '```',
    '',
    'The `reason` must be exactly one of these codes — anything else is not readable:',
    codes,
    '',
    'Write it in addition to your normal report, not instead of one. Leaving the file absent',
    'is a valid outcome and means no such determination was made.',
  ].join('\n');
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
