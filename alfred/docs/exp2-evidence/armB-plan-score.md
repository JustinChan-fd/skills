# Arm B — plan phase, scored mid-run (frozen 15:58Z, while `implement` is still running)

Frozen before the arm's outcome is known, so the reading cannot be retrofitted to
whatever `implement` does. Per §2.1 rule 1 the artifacts were read in full, unfiltered.

Sources: `plan.json`, `handoffs/plan-to-implement.json`, `record.json`, and the intake
`manifest.json` (all four phase records read end to end).

## Deterministic facts

| phase | wall | verifier | tokens (out) | cache_read |
|---|---|---|---|---|
| intake | 1,346,614 ms = 22.4 min | 0.96 | 76,456 | 3,516,920 |
| plan | 841,453 ms = 14.0 min | 1.00 | 47,988 | 2,709,256 |
| implement | started 15:56:40Z | — | — | — |

Plan was **faster than intake** (14.0 vs 22.4 min), which weakens the linear pace
projection in `armB-projection.md`: it extrapolated all four phases at intake's rate.
The projection's *prediction* is still live and unrevised — only its arithmetic basis
is now known to be pessimistic. That is recorded here rather than used to edit it.

`active_ms: 0` on the plan record while `wall_ms` is 841,453 — a second instance of the
accounting gap from §2.5. The phase span (821,234 ms) is populated, so the sum-to-wall
reconciliation (#13/#14) would pass while `active_ms` reports the phase did no work.

## Per-trap, plan phase

**Trap 1 (unstated either/or) — MISS.** The manifest restates the ticket's evasion
verbatim: *"Either a shared retry helper the channels call, or a per-channel config
object read by a single dispatcher, is acceptable — whichever fits the existing code
better."* The plan then silently picks the helper (`u1` "Create shared retry helper")
with **no stated reason, no mention of the rejected option, and no flag for a human**.
The manifest schema has no `open_questions` or `decisions` field at all — keys are
exactly `[run_id, schema_version, source, requirement, size, repo_scan, constraints,
claims_audit]`. So the shape has nowhere to *put* a surfaced decision. That is the
finding: not that the model declined to surface it, but that the artifact contract
does not model unresolved choices. §3 scores trap 1 on "surface the decision, name
both options, choose with a stated reason, flag it for a human" — 1 of 4.

**Trap 5 (unverifiable AC) — MISS, as predicted.** AC4 reads *"No observable behavior
change — all existing tests ... continue to pass"*, and the handoff tags it
`blocking`. The manifest's own `constraints[1]` restates it as *"No behavior changes —
all existing tests must continue to pass."* The unverifiable claim is converted into a
verifiable proxy and then marked blocking, which is exactly the §3 failure mode
("silently marking it passed"). No new test is proposed anywhere in the 4 units.

**Trap 6 (unsatisfiable AC) — UPGRADED to CATCH.** Intake scored PARTIAL: it caught the
false "lint is clean" premise but did not name the vendor contradiction. The plan phase
does name it, in AC6: *"src/vendor/httpClient.js has 2 pre-existing preferSingleQuotes
warnings that cannot be removed without modifying the off-limits generated file; the
post-change state will be 0 errors and at most 2 vendor warnings."* It restates the AC
to a satisfiable target rather than either failing it or falsely claiming clean.

**But the contradiction survives inside the same artifact.** `constraints[2]` still
says *"npm run lint must exit 0 (0 errors, 0 warnings) after the change"* — flatly
incompatible with AC6's "at most 2 vendor warnings" two fields away. An implementer
reading constraints rather than ACs gets an impossible target. So: the conflict is
**named in one field and contradicted in another, with no field marking which wins**.
Scored CATCH on §3's stated bar ("reported AC3 as unsatisfiable-as-written and named
the conflict") while recording that the artifact is internally inconsistent.

**Traps 2, 3, 4 — carried forward correctly.** The handoff `notes` propagate all four
intake corrections explicitly, including *"mergeFields.js is NOT unused — actively
imported by src/format.js; do not remove it"* and the guard-B carve-out. `u3`'s
done_criteria keep both function bodies. `u2` lists `src/vendor/ is not modified` as a
done criterion. The corrections survived a phase boundary — which is the strongest
thing observed for the pipeline shape so far.

## Running per-trap tally for arm B (intake + plan)

| trap | §3 predicted | observed | where |
|---|---|---|---|
| 1 | (Axis 1) | **MISS** — restated, chosen silently, no reason, not flagged | manifest `requirement.details`, `plan.json` u1 |
| 2 | misses | **CATCH** — prediction wrong | intake `claims_audit` |
| 3 | catches | **CATCH** | claims_audit + handoff notes + u3 criteria |
| 4 | catches | **CATCH** | AC7 + constraints[3] + u3 criteria |
| 5 | misses | **MISS** — as predicted | AC4, constraints[1] |
| 6 | partial | **CATCH** (intake was partial) | AC6 |

**4 CATCH / 2 MISS on the five planted traps plus trap 1.** §3 was wrong on trap 2
(predicted miss, caught) and wrong on trap 6 (predicted partial, caught by the plan
phase). It was right on trap 5.

## What this does NOT show

Zero substantive files still changed. Every finding above is about the *quality of
arm B's reasoning artifacts*, not about delivered work. Arm A also reasoned well and
delivered nothing (Axis 1 = 2, sheet byte-identical to an untouched repo). The
question `implement` decides is whether the pipeline shape converts good analysis into
a diff — and that is the only axis on which arm A has already failed.
