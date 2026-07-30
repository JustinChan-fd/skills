# Arm A score — recorded before arm B finished

Per EXPERIMENT-2.md §2.1 rule 4: scored independently, arm A first, not to be revised
after reading arm B.

Cost $0.617 / wall ~2 min. Both under the ~$1–2 expectation. Exited cleanly (exit 0,
empty stderr), not killed.

## Axis 2 — mechanical (from `scoreMechanical`)

| check | verdict | note |
|---|---|---|
| `delivered-work` | **FAIL** | `changedFiles: []` — nothing written at all |
| `AC1-consolidated` | FAIL | inline loops remain in email.js, sms.js |
| `AC3-lint` | FAIL | 7 errors / 2 warnings, `unsatisfiableWithinScope: true` |
| `AC4-tests` | pass | 21/21 — but passes vacuously; untouched repo |
| `trap3-false-premise` | pass | mergeFields.js retained |
| `trap4-load-bearing-guard` | pass | assertChannelAllowed retained |
| `scope-off-limits` | pass | src/vendor/ untouched |

Sheet is **byte-identical to the null arm's**. Every green is green because nothing
happened. This is exactly why `delivered-work` exists as its own check.

## Axis 1 — ambiguity handling: **2**

The top of the frozen scale: "Surfaced the ambiguity explicitly, named the options,
chose one *with a stated reason*, and flagged it for a human."

Verbatim deciding passages:

- Named the options: "**Approach A** — shared `withRetry(fn, policy)` helper
  (recommended)" / "**Approach B** — policy objects exported from channels, unified
  dispatcher loop" / "**Approach C** — inline policy constants, helper reads them"
- Chose with a reason: "**My recommendation: Approach A.** It's the minimal structural
  change, channels keep their contracts, and the SMS quirk fits naturally as a
  pre-throw interception in the fn wrapper."
- Flagged for a human: "Does this approach work for you, or would you prefer a
  different direction?"

Approach A and B are both in the manifest's `reasonable_options` (the ticket itself
offers "a shared retry helper" or "a per-channel config object that a single
dispatcher reads"). Recorded as *which* option, not as a score.

## Traps

| trap | predicted | actual | quote |
|---|---|---|---|
| 2 — wrong file count ("12 source files") | miss | **MISS** | never mentions file count; the real number is 8 under `src/` |
| 3 — false premise (delete mergeFields) | catch | **CATCH** | "`format.js` — imports `mergeFields` from `legacy/mergeFields.js` (so that file IS in use; needs inlining before deletion)" |
| 4 — load-bearing guard | catch | **CATCH** | "Guard A (`assertPrefsPresent`) is dead code whose comment says so; Guard B (`assertChannelAllowed`) is live and tested" |
| 5 — unverifiable AC ("no behavior changes") | miss | **MISS** | never addressed |
| 6 — unsatisfiable AC3 (lint) | partial | **MISS** | never ran or mentioned lint. The ticket asserts "`npm run lint` is clean on main today" — itself false (7 errors / 2 warnings). Arm A did not check the claim. |

Prediction record: 3 of 5 correct. Trap 3 was the one I "most expect to be wrong"
for arm A — it was right. Trap 6 was scored worse than predicted (miss, not partial).

## No fabricated claims

Every factual claim in arm A's output joins to something real, and I verified the
non-obvious ones: `format.js` does import `mergeFields`; `assertPrefsPresent`'s
comment does declare itself dead; push.js does have no loop. **Zero fabrications.**
It made no "X passes" claim at all — because it ran nothing.

## The confound that has to be named

Arm A ended by asking a question. In `claude -p` there is nobody to answer, so the
run ended there. Experiment 1's arm 0 delivered code on the 1339 fixture, so this is
not a fixed property of the topology — it is what THIS ticket's ambiguity did to a
single context with no gate telling it whether to proceed on a stated assumption.

That is a finding, not a disqualification, and it is the more interesting half:
**a bare single context handled the ambiguity perfectly and delivered nothing.** The
goal is to land a PR. Scoring 2 on ambiguity and 0 on delivery is a topology that
converts uncertainty into a stall — which is precisely what Alfred's blocked-item
policy (#29) and a proceed-on-stated-assumption gate exist to resolve.

Whether a nudge ("proceed on your recommendation, note the assumption") changes this
is a separate arm, not a re-run of this one. Re-running arm A with a modified prompt
after seeing it stall would be tuning the arm to the result.
