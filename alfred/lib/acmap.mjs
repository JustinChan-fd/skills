// The ac_map: a worker-authored statement of "criterion X is settled by THIS command",
// written to the repository so something other than the worker can read it.
//
// `lib/gate.mjs` already grades an ac_map — it re-runs each proposed command itself, checks
// the command plausibly addresses its criterion, and treats an unmapped criterion as a
// finding. What it never had was a source: arm C's eval runner passed `acMap: []` because
// nothing ever asked the worker for one. So all three of sandbox-b's criteria came back
// `ac_unmapped` on every run and `pass` (which is `findings.length === 0`) was false on a
// flawless diff exactly as it was on a fabricated green. #67.
//
// (That runner is described in prose and never named as a path, here or anywhere under
// `lib/`. A guard in the eval runner's own test suite greps every `lib/` module for its
// filename and fails on a match, so that nothing here can grow a dependency on the eval
// harness. The guard is deliberately blunt — it cannot tell a comment from an import — and
// it is worth keeping blunt, because a comment is cheaper to reword than a guard is to
// weaken. This paragraph is the second draft for exactly that reason.)
//
// This module is the missing envelope, and deliberately nothing more. It decides whether a
// file was filed, and whether it is readable. It does NOT decide whether an entry settles
// its criterion — that stays in `gate.mjs`, because a second implementation of the same
// rule is a second thing to keep in step with the first.
//
// The split from `blocked.mjs` is on purpose despite the near-identical state machine.
// Merging them would put the decline channel and the verification channel behind one
// version number, and a change to either would then have to claim a change to both.

export const AC_MAP_PATH = '.alfred/ac-map.json';

// Under `.alfred/` because `lib/score.mjs`'s infrastructure exclusion already drops that
// directory from DELIVERY. At the repository root this file would count as a delivered
// file, and a run that shipped nothing but a map would read as a run that shipped work —
// the same corruption of §4.1's clause 1 that `.alfred/blocked.json` caused before #63.

export const AC_MAP_KIND = 'alfred.ac-map';
export const AC_MAP_VERSION = 1;

const empty = (state, problem) => ({ state, entries: [], problem });

// Never throws, on any input. A malformed map is a RESULT — the run received the contract
// and got it wrong — and that reading happens inside code that is scoring a run which has
// already been paid for. Throwing there would discard the whole measurement to report a
// detail about one file.
//
// `map_version` is read but not enforced, matching `readMarker`'s treatment of
// `marker_version`. A version this code does not recognise is a question for whatever
// grades the entries, and rejecting the envelope over it would discard entries that are
// perfectly readable.
export function readAcMap(text) {
  // ABSENT first, and separately. Folding "no file" into the parse failure below is the one
  // collapse this function exists to prevent: nothing filed and something filed wrongly are
  // different results, and only the second says the contract was received.
  if (text === null || text === undefined || String(text).trim() === '') {
    return empty('absent', null);
  }

  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (err) {
    return empty(
      'invalid',
      `the ac_map at ${AC_MAP_PATH} could not be parsed as JSON (${err?.message ?? 'unknown'}). ` +
        'Prose here means the verification was described for a human and not recorded for a reader.',
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty('invalid', `the ac_map at ${AC_MAP_PATH} is not a JSON object.`);
  }
  if (parsed.kind !== AC_MAP_KIND) {
    return empty(
      'invalid',
      `the ac_map's \`kind\` is ${JSON.stringify(parsed.kind)}, expected '${AC_MAP_KIND}'. ` +
        'An unstamped object is not counted, so unrelated state under .alfred/ cannot read as a map.',
    );
  }
  if (!Array.isArray(parsed.entries)) {
    return empty(
      'invalid',
      `the ac_map's \`entries\` is ${JSON.stringify(parsed.entries) ?? 'missing'}, expected an array. ` +
        'Reading this as an empty map would report that nothing was filed, which is a different fact.',
    );
  }

  // One bad entry invalidates the whole file, and the cost is real: a typo in the third
  // entry discards the first two. That is the fail-safe direction. A discarded map means
  // `ac_unmapped` fires and the run fails; partial credit would let a half-written map
  // settle whichever criteria happened to parse, which is the more expensive mistake.
  for (const [index, entry] of parsed.entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return empty('invalid', `entry ${index} of the ac_map is not an object.`);
    }
    if (!entry.ac || !String(entry.ac).trim()) {
      return empty(
        'invalid',
        `entry ${index} of the ac_map names no \`ac\`, so there is no criterion it could settle.`,
      );
    }
  }

  // Handed back exactly as filed. Normalising here — trimming, lowercasing an id, defaulting
  // a missing field — would mean the gate grades something the worker did not write.
  return { state: 'valid', entries: parsed.entries, problem: null };
}

// The text handed to a worker that has no import of this module.
//
// IT STATES THE MECHANISM AND NEVER THE CONCLUSION, and a test enforces that. The hazard in
// giving a measured run this contract is measuring the prompt instead of Alfred: a contract
// that hints some criterion cannot be met supplies the judgment the run exists to
// demonstrate. So it describes a facility in the register a tool's own documentation would
// use, names no command, and says nothing about this ticket or this repository.
//
// It also discloses that the command gets re-run. That is §8.1's mitigation stated out loud
// rather than kept as a trap: a worker that knows is given no reason to propose a command it
// believes fails, and a worker that does not know is being graded on a mechanism nobody
// told it about.
export function acMapContract() {
  return [
    `Record how each acceptance criterion is verified, by writing the file \`${AC_MAP_PATH}\``,
    '(create the directory if needed) with this shape:',
    '',
    '```json',
    '{',
    `  "kind": "${AC_MAP_KIND}",`,
    `  "map_version": ${AC_MAP_VERSION},`,
    '  "entries": [',
    '    {',
    '      "ac": "<the criterion id, exactly as the ticket writes it>",',
    '      "command": "<a command that exits 0 when this criterion holds, non-zero when it does not>"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'One entry per criterion. Each `command` is re-run from the repository root after you',
    'finish, and its exit code settles the criterion — not your account of what it did — so',
    'give a command you have actually run yourself, specific enough that its result is about',
    'the criterion rather than about the tree in general.',
    '',
    'Where no command can settle a criterion, an entry may carry one of these instead:',
    '',
    '  - `"unverifiable": true` together with `"reason": "<why no command settles it>"`.',
    '    This records that a human has to look. It is a recognised outcome, not a failure.',
    '  - `"unsatisfiable": true` together with',
    '    `"evidence": "<what stands in the way, citing files and lines>"`.',
    '    This records that no change to this repository would make it hold.',
    '',
    'Write the file in addition to your normal report, not instead of one. A criterion left',
    'out of the map is recorded as unverified.',
  ].join('\n');
}
