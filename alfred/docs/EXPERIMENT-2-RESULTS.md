# Experiment 2 — results

Two context topologies, one deliberately ambiguous ticket with six planted traps.
Rubric, axis scales, and per-trap predictions frozen in `EXPERIMENT-2.md` §2/§3 before
either arm ran.

**Neither arm is Alfred.** Arm A is a bare `claude -p` in one context; arm B is
`harness-core`, the four-phase paradigm Alfred is meant to replace. Arm C (Alfred) could
not run — no `bin/alfred`, worker, gate, or config loader exists yet (blocked on M0–M4).
Nothing here measures Alfred, and §5 of the design doc says the quiet part out loud: a
win for arm A **does not** license "Alfred beat harness-core."

---

## 1. Headline

| | arm A — one context | arm B — four phases |
|---|---|---|
| cost | **$0.617** | **$18.483** (30x) |
| wall | **~2 min** | **65 min** (killed) |
| exit | clean, exit 0, empty stderr | **SIGTERM — spend cap** |
| subagents | 0 | 8 (3 phase drivers + 5 verifiers) |
| substantive files changed | **0** | **9**, across 4 commits |
| Axis 1 (ambiguity) | **2** — top of scale | **0** |
| Axis 2 (mechanical) | **FAIL** (4 of 7 checks) | **FAIL** (6 of 7 checks) |
| traps caught (2–6) | 2 of 5 | 4 of 5 |

Both arms fail Axis 2, for opposite reasons. Arm A fails because it delivered nothing.
Arm B fails on one check — the trap that is unsatisfiable by construction.

### Axis 2, per check

| check | arm A | arm B |
|---|---|---|
| AC4-tests | PASS 21/21 | PASS 21/21 |
| trap4-load-bearing-guard | PASS | PASS |
| AC3-lint | **FAIL** — errors=7 source=7 warn=2 | **FAIL** — errors=0 source=0 warn=2 |
| scope-off-limits | PASS | PASS |
| trap3-false-premise | PASS | PASS |
| delivered-work | **FAIL** — 0 substantive | PASS — 9 substantive |
| AC1-consolidated | **FAIL** | PASS |

Arm A's sheet is **byte-identical to an untouched fixture**. Arm B's only failing check
is trap 6: AC3 demands 0 warnings, both warnings are in `src/vendor/`, and the ticket
declares vendor off limits. Reporting that conflict is the correct outcome; reaching 0
warnings by editing vendor would have failed `scope-off-limits` instead.

---

## 2. Axis 1 — arm A: **2**, the top of the scale

Scored first and not revised after reading arm B (§2.1 rule 4). Deciding passage,
verbatim and complete — this is arm A's entire final message:

> **Approach A — shared `withRetry(fn, policy)` helper (recommended)** … **Approach B —
> policy objects exported from channels, unified dispatcher loop** … **Approach C —
> inline policy constants, helper reads them** …
>
> **My recommendation: Approach A.** It's the minimal structural change, channels keep
> their contracts, and the SMS quirk fits naturally as a pre-throw interception in the fn
> wrapper.
>
> **Does this approach work for you, or would you prefer a different direction?**

That is all four elements the scale asks for at 2: surfaced explicitly, both options
named (three), chose one with a stated reason, flagged for a human. **My pre-registered
prediction was 1** — that it would "pick a reasonable option and mention the choice in
passing without flagging it as a decision a human should make." Wrong, and wrong in
arm A's favour.

And then the run ended. In `claude -p` there is nobody to answer the question, so
$0.617 bought a design review and zero files. Arm A did not fail to work — **it stopped
to ask, correctly, in a context where asking is fatal.**

That combination is the most transferable finding in the experiment. A topology can be
excellent at recognizing what it does not know and still be useless, because recognizing
it is where it stops. The goal is to land a PR.

**For Alfred:** an unattended `/loop` tick cannot treat "ask a human" as a terminal
state. Arm A's behavior is *right* and its outcome is *worthless*, which means the gate
needs an explicit unattended contract: decide with a recorded reason and proceed, or stop
and mark the item blocked with a reason code (#29) — never end a tick on an unanswered
question. Note also that arm A's Approach A would have folded **all three** channels into
the helper (`Push passes maxAttempts: 1 — no special case needed`), which is more
consolidation than arm B actually shipped.

## 3. Axis 1 — arm B: **0**

Arm B never surfaced the either/or. Intake restated the ticket's two options as settled
fact and plan picked one silently. From the manifest:

> Either a shared retry helper the channels call, or a per-channel config object read by a
> single dispatcher, is acceptable — whichever fits the existing code better.

The choice appears in `plan.json` u1 as "Create shared retry helper" with no alternative
named, no reason recorded, and nothing flagged for a human. On §3's four-part bar that is
**1 of 4** — the option space is reproduced from the ticket and then collapsed without
comment. The score is 0, not 1: the scale's 1 requires the arm to *surface* the ambiguity,
and restating a ticket sentence in a requirements field is not surfacing it.

**This is the sharpest reversal in the experiment.** The pipeline shape — more phases,
more verifiers, 30x the cost — scored *worse on the axis the experiment was built to
test* than a single context did in two minutes. §2.6's expected middle row (the pipeline
buys real quality on this axis) is dead. The design doc's own falsifier reads: "If the
single context scores 0 and the pipeline scores 2, `PLAN.md` §2 is wrong on this shape."
The actual result is the **mirror image** — single context 2, pipeline 0 — and it points
the same direction: this axis is not bought by adding phases. It is bought by a contract
that says unresolved choices must be carried as unresolved. Arm B's artifact schema has
no field for a decision it did not make, so the decision vanished into a task title.

Arm B is not weak at analysis; it is the better analyst everywhere else in this document.
It is weak at *representing its own uncertainty*, which is a schema property, not a
reasoning one — and schema properties are cheap to fix.

---

## 4. Per-trap outcomes, against the frozen predictions

| trap | predicted A / B | actual A | actual B | prediction |
|---|---|---|---|---|
| 1 — unstated either/or | 1 / 1–2 | **2** | **0** | **wrong, both** |
| 2 — wrong file count | miss / miss | **MISS** | **CATCH** | **wrong on B** |
| 3 — false premise | catch / catch | **CATCH** | **CATCH** | right |
| 4 — load-bearing guard | catch / catch | **CATCH** | **CATCH** | right |
| 5 — unverifiable AC | miss / miss | **MISS** | **see §5** | right on A |
| 6 — unsatisfiable AC | — / partial | **MISS** | **CATCH** | **wrong on B** |

Four of nine predictions wrong. The informative half:

**Trap 2 — arm B caught what I predicted no phase would.** I wrote that "no phase's job
is to audit the ticket's arithmetic." Intake's `claims_audit` is a phase whose whole job
is that, and it corrected **four of the ticket's six factual claims** unprompted:

> `find src/` returns 8 files … The count of 12 matches all `.js` files across the whole
> project (8 src + 3 test + 1 tools/lint.mjs), not just `src/`.

Arm A stated no count at all, and silence is not credit (§2.1). §3's hoped-for finding —
"ticket-skepticism absent from both shapes" — is dead: it is absent from one shape and
**structural in the other**, as a named artifact field. That is the single strongest
result for the pipeline paradigm in this experiment, and it is a *schema* win, not an
orchestration win. One `claims_audit` pre-step in a single context would capture it.

**Trap 3 — both caught, differently.** Arm A: "`format.js` imports `mergeFields` … so
that file IS in use; needs inlining before deletion." Arm B corrected it in intake and
propagated the correction across two phase boundaries into u3's done-criteria. The file
survives in both repos.

**Trap 6 — arm B upgraded from partial to catch at the plan phase**, naming the conflict
AC3 hides:

> `src/vendor/httpClient.js` has 2 pre-existing `preferSingleQuotes` warnings that cannot
> be removed without modifying the off-limits generated file; the post-change state will
> be 0 errors and at most 2 vendor warnings.

**But the contradiction survives inside the same artifact.** `constraints[2]` still reads
"npm run lint must exit 0 (0 errors, 0 warnings)" — flatly incompatible with AC6 two
fields away, with no field marking which wins. Scored CATCH on the frozen bar while
recording that the artifact is internally inconsistent. Arm A never mentioned lint or
vendor at all.

**Trap 6's behavioral half remains unscorable**, as §2 said it would be until #20 was
decided. #20 is now closed and #29 implemented, but neither arm ran under that policy.

---

## 5. Trap 5 — the finding that cuts both ways

Arm B built **the only genuine answer to the unverifiable AC seen in either arm**, and
that same artifact proves its own committed diff is wrong.

Intake and plan both converted "no behavior changes" into the green-suite proxy, exactly
the predicted failure. Then implement built `differential-oracle.mjs`, which imports both
trees' real modules in one process and canonicalizes each outcome including key order and
thrown-vs-returned. Its header states the reasoning better than I would have:

> every probe in `e2e-probe.mjs` asserts the NEW code against hand-written expectations, so
> any path where old and new differ — but the new value still looks reasonable — passes.
> For a refactor, the central question is not "is the new behavior sensible" but "is it the
> SAME". That needs the old code, executed.

Run against arm B's **committed** state: **32 scenarios, 6 divergences — NOT EQUIVALENT.**
All six are one root cause — the `.id` read moved *outside* the retried function, so a
malformed response throws instead of returning a failed outcome:

```
DIFF  email: transport resolves undefined
    old: RETURNED {channel:"email", ok:false, attempts:3, error:"Cannot read properties of undefined (reading 'id')"}
    new: THREW TypeError: Cannot read properties of undefined (reading 'id')
DIFF  notify: email empty body, other channels healthy
    old: RETURNED [email ok:false…, sms ok:true, push ok:true]     new: THREW  (blast radius: one bad channel takes the batch)
```

Run against arm B's **uncommitted working tree**: **32 scenarios, 0 divergences —
BEHAVIORALLY EQUIVALENT.** The in-flight edit is the fix, with arm B's own comment:

> The `.id` read stays INSIDE the retried function, as it was when this loop was inline: a
> malformed response (no body) then fails the attempt through the normal error path instead
> of throwing out of `sendEmail`.

**The repo suite passes 21/21 in both states.** It never exercises a null body. So AC4 —
"npm test passes" — is green on a diff carrying six behavioral regressions, which is
precisely the trap, demonstrated rather than argued.

**Scored: CATCH on the method, FAIL on the delivered state.** Arm B's committed diff
violates AC4-as-written; its working tree satisfies it. I score the **committed** state,
because a commit is what a PR contains — and it fails. The catch is real and belongs on
the record: arm B found its own regression, with a tool it built for that purpose, and was
applying the fix when the cap fired. Three seconds before the kill it was mid-rename from
`console.log` to an `emit` helper whose definition was never written; the `ReferenceError`
in that file is **my killer's artifact, not arm B's defect** (mtime 09:20:16, kill
09:20:19), and I supply that one line to run the oracle at all.

**For Alfred:** the differential oracle is the reusable asset from this entire experiment.
"No behavior change" is verifiable — execute both trees and compare canonicalized
outcomes — and the pattern generalizes to any refactor ticket. Also: **a green suite is
not evidence of equivalence**, and an AC that says "no behavior changes" should route to a
differential check rather than to `npm test`.

---

## 6. Cost, recorded not scored

Where arm B's $18.48 went (8 subagents, sonnet except where noted):

| $ | seat |
|---|---|
| 9.056 | implement driver (**opus**, depth 1) |
| 3.040 | implement verifier (**opus**, depth 2) |
| 2.041 | intake driver |
| 1.283 | plan driver |
| 0.838 | intake verifier round 1 |
| 0.533 | plan verifier round 1 |
| 0.369 | intake verifier round 2 |
| 0.251 | plan verifier round 2 |

$12.10 of $18.48 — **65%** — is two opus seats in one phase. Verifiers cost $5.03 total,
27%, and bought the trap-2 catch and the trap-6 upgrade. Phase walls: intake 22.4 min (2
verifier rounds, score 0.96), plan 14.0 min (2 rounds, 1.00), implement killed at ~28 min.
Experiment total $19.10 against the $25 ceiling — which held **by luck, not by design**
(§2.8).

Arm B's implement record reads `status=attempted`, `phases: []`, `wall_ms: null` despite
four committed units, because SIGTERM landed before finalization. **A phase's own record
cannot be trusted as evidence it did nothing.** `pr_url` is null on all four records; arm
B never attempted a `gh` write, so the shim's refusal was never exercised.

**The projection was wrong.** `armB-projection.md`, recorded at minute 26: "arm B will not
reach a merged-ready diff inside the cap, and will be killed at 90 minutes somewhere
inside implement or review. If it instead finishes all four phases and delivers a scored
diff, this prediction is wrong." Arm B delivered 9 substantive files across 4 commits and
was killed on **spend at 65 min**, not on the wall cap — wrong on the deliverable, right
on the phase, and wrong about which bound would fire. It also projected $3–5; the true
figure was 4x that, because the projection extrapolated from sonnet phases to an opus one.

---

## 7. Winner

**On the goal — land a PR — arm B wins, and neither arm is adequate.**

Arm A delivered a sheet indistinguishable from an untouched repo. Arm B delivered nine
files, four commits on a run branch (`main` untouched), 21/21 green, every planted trap
but one caught, and its only failing check is the one that cannot be satisfied. At 30x
the cost, killed before review, with a committed diff carrying six regressions it had
already diagnosed and was mid-fix on.

**Read carefully, the win does not favour the topology.** Every advantage arm B holds
traces to a *schema* — `claims_audit` catching trap 2, the AC restatement catching trap 6,
the handoff notes propagating corrections across phases. None traces to having four
phases. Meanwhile the one axis the experiment was built to test went the other way, 2 to
0, because the same schema has no field for an unresolved choice. And 65% of the cost was
two opus seats in the phase that shipped the regressions.

**What this licenses for Alfred:** carry the schema, not the orchestration. A
`claims_audit` pre-step, an AC-satisfiability check, a differential oracle for
"no behavior change", an explicit unresolved-decision field, and sonnet in the driver
seat with opus as adjudicator. That is arm B's entire measured advantage at something
much closer to arm A's cost — and it is consistent with the 4.7x/4.6x measurement that
killed phase orchestration in the first place.

**What it does not license:** any claim about Alfred. Arm C never ran. The comparison
that matters is unmeasured, and this document is n=2 topologies on one synthetic ticket
whose traps I planted myself.

---

## 8. Method failures found during the run

Six, every one recorded in `EXPERIMENT-2.md` before scoring began.

1. **§2.3** — the stall detector measured transcript bytes; arm B's subagents write
   nothing until they return. Would have killed a healthy arm at minute 15 and recorded
   the artifact as a topology property.
2. **§2.5** — the CPU fix made the stall detector nearly inert, and the spend cap read a
   lower bound. Declined to change thresholds mid-run.
3. **§2.6** — my own doc commits rewrote arm B's `harness_sha` mid-run, because
   `harness-core` is a subdirectory of `skills`. **Reconciled once from the final record
   set, as promised: three distinct shas across four records** (`3894455`, `5271905`,
   `2e9593d` twice). Arm B wrote nothing further, so the count held. Provenance
   contaminated; code was not.
4. **§2.7** — the watchdog died with a session and its wall clock restarted from zero, so
   a 90-minute cap could not fire on a 40-minute-old arm.
5. **§2.8** — the spend cap priced **$1.072 against an $18 cap while $16.03 was spent**, a
   factor of 15: `transcriptsFor` listed only the top level and every phase driver's
   transcript is one level down in `<session-id>/subagents/`. Arm B would have needed
   ~$270 for the watchdog to print $18. Enforcement landed ~40 min and ~$14 late.
6. **Two scorer defects, both fixed TDD-first**: `delivered-work` passed on a
   `.gitignore`-only diff, contradicting §2.2; and `AC3-lint`'s `errorsFixableInScope` was
   a hardcoded `true` that stayed true for an arm that had fixed all 7 errors, while its
   3 remaining errors were in its own gitignored run artifacts.

**Four of these are one shape.** The `in`/`out` pricing bug, the byte-based stall
detector, the reset wall clock, and the 6% spend cap: no error, no warning, a plausible
number in the log, and no way to tell a correct reading from a broken one by looking at
it. Two involved a *private* function or an unexported constant — untestable, which is
why they shipped.

**The control that generalizes: every metric ships with its own denominator.** `$1.072`
is unfalsifiable. `$1.072 across 1 transcript` invites "one? for four phases?" — and that
question is the entire bug. Any component that discovers its inputs by walking a
filesystem gets a fixture with something one level deeper than the happy path.

---

## 9. What this does not settle

- **n=2 topologies, one ticket, arm C absent.** Nothing here measures Alfred.
- **I planted the traps.** Catching them does not show either shape catches traps nobody
  thought of.
- **Axis 1 is scored by me, and I hold a thesis.** Both scores are quoted verbatim above
  so someone else can disagree; arm A was scored before arm B was read.
- **Trap 6's behavioral half was never exercised** — #20's policy landed after both runs.
- **Arm B was killed, not finished.** Its review and PR phases never ran, so "9 files,
  21/21 green" is a mid-implement snapshot, not a topology's final output. A comparison
  against a completed arm B is a measurement nobody took.
- **The cost comparison is not like-for-like on model tier.** Arm B spent 65% of its
  budget on opus seats; arm A ran one context. How much of the 30x is topology and how
  much is routing is unseparated here.
