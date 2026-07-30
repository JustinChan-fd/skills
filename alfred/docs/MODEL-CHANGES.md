# The model-change protocol

*Written 2026-07-30, task #43. Adapted from `EVAL-READINESS.md` §8, which is adapted from
the eval-readiness audit. Enforced by `lib/model-changes.mjs` + `test/model-changes.test.mjs`.*

A new model ships roughly monthly. Each one arrives with an implicit invitation to
re-measure, and re-measuring while also editing the ruler is how a project loses the
ability to say what changed. This is the procedure that keeps the two apart.

**The one-line version:** the suite is the control variable. When the model moves, nothing
else does — not the cases, not the thresholds, not the tests. Then you read the result,
and *then* you change things, in separate commits, in this order.

---

## Why this is code and not only prose

The audit's own reason for wanting this written down is that *"an undocumented protocol is
one that gets skipped under time pressure."* True, and not enough for this repo.

Alfred has watched a **documented** claim rot twice in four days:

- `PLAN.md` §6 said of itself *"the numbers below are transcribed from the code, not the
  reverse."* That sentence stopped being true the moment #38 moved the seats, and stayed
  false for a day (`99bdac3`). The code could not drift — `lib/models.mjs` validates
  `SEATS` at import. Only the doc could, and only the doc did.
- `config/prices.json` said the 1h cache-write column billed for something *"that cannot
  happen."* Measured false: sonnet-5 wrote 14,775 tokens at `ephemeral_1h_input_tokens`.

So the protocol lives in two places with different jobs. **This file argues.**
`lib/model-changes.mjs` holds the six steps as a frozen ordered list and the measurement
ledger, and `test/model-changes.test.mjs` fails when the ledger stops being honest. If you
only read one, read the module — it is the one that cannot lie.

---

## The six steps

Order is load-bearing. Step 6 performed alongside step 1 is the difference between a
measurement and a re-fit.

### 1. Freeze the suite. Run it unchanged. That is the reported number.

**Forbidden:** adding or editing a case in the same commit as a model swap.

*We already violated this.* `752f3b0` ("seats to sonnet-5/opus-5") moved the model **and**
changed `prices.json`, the shared normalizer, `OUTPUT_CEILINGS`, and 278 lines of the
price/model tests — five files, +402/−56, one commit. Whether those 278 lines were a fix or
a re-fit to the new model is now unanswerable from the history alone. That is precisely
what freezing prevents, and the reason this document exists at all.

What makes the next freeze checkable rather than promised is #42: `config/suite.json`
declares a `suite_version` and a digest over the rubric+fixture members, `lib/suite.mjs`
recomputes it, and a result record carries the stamp it was scored against
(`lib/report.mjs`). A result whose stamp does not reproduce is a `suite-stamp-invalid`
gap. So "was the suite frozen for this run" became a field rather than a memory.

### 2. Read the new failure shapes. New models fail differently, not merely less.

**Forbidden:** concluding "it got better" from a higher score. A score that rises while the
failure mode changes underneath is two facts reported as one.

Not yet possible here: no run exists after `752f3b0`. Arm C is the first, which is why the
seam is declared in `EXPERIMENT-2.md` §5 **before** the run rather than discovered while
scoring it — at scoring time there is an incentive to reinterpret it.

### 3. Handle saturation. Demote to a regression floor; never delete.

**Forbidden:** deleting a case everything now passes; and leaving a saturated case in the
headline, where it inflates the average.

`sandbox-a` is already exactly this, arriving there for a different reason. M4's gate tests
and sandbox-a's trap manifest landed in the **same commit** (`e86cd48`) — two of the
thirteen frozen gate names are its traps 5 and 6 verbatim. A gate built from those tests
catches those traps because it was written against them. It is the right thing to run the
gate *against* and the wrong thing to grade the gate *on*. The full policy, including what
to do when a fixture is not merely saturated but **wrong**, is `SANDBOX.md` §9.

### 4. Re-calibrate routing. The evals stay put; the thresholds move.

**Forbidden:** moving a threshold and an eval case together, which makes the recalibration
unmeasurable. Also: raising a `token_budget` because the context grew.

**Alfred has no size axis, so the recalibration surface is the seat table itself.**
`ROUTING_SURFACE` in `lib/model-changes.mjs` enumerates it, one entry per tunable, each
carrying the decision the last move made:

| knob | decision | at release | why |
|---|---|---|---|
| `model` | **moved** | sonnet-5 / opus-5, #38 | worker/fallback/reason → sonnet-5; `scan` deliberately **not** moved (a file listing on a frontier model pays 3x for the same lines) |
| `max_tokens` | **moved** | sonnet-5 / opus-5, #38 | 64k → 128k where the model allows; tracks `OUTPUT_CEILINGS`, which is transcribed from the gateway rather than inferred |
| `token_budget` | **held** | sonnet-5 / opus-5, #38 | a spend cap, not a context allowance — see below |

**Why `held` is written down rather than left as a silence.** A knob nobody thought about
and a knob deliberately left alone produce byte-identical diffs. The only way to tell them
apart later is to have recorded the second one, which is why `decision: 'held'` is a value
rather than an absence, and why `at_release` is required — a "held" with no release
attached could never go stale.

`token_budget` is the one this structure exists for. sonnet-5 has 5x the context of
sonnet-4-6, so raising the cap alongside it is the move that *looks* like an upgrade in the
diff and is in fact this step's named prohibition: it would undo the $11.98 lesson (an
unbounded subagent burning 3.9M tokens). Held at 2M worker/fallback, 500k
reason/adjudicator, 200k scan. A test now asserts both the `held` and that its stated
reason rests on **spend** — because *"the context grew"* is the argument that will sound
most reasonable at the time.

**Corrected 2026-07-30 (#48): this section previously named a mechanism that does not
exist.** It read *"Still unclaimed: the size → tier thresholds themselves have not been
reviewed against sonnet-5."* Measured: `LC_ALL=C grep -rn "size" lib/ config/` returns
three hits, all prose, none a mechanism. The S/M/L axis belongs to `harness-core`
(`config/routing.json`), and even there it is not a threshold — `size` is a judgment an LLM
writes at intake from stated heuristics, then passed to `sizeBudgets(routing, size)`.
Alfred routes by **seat**, the kind of job, which is a deliberate divergence: size is a
guess *about* the work, seat is a fact *about* the call.

That is the failure mode this protocol was written to prevent, committed by the protocol
itself. A named gap reads as coverage — someone reading step 4 would believe the routing
surface had been identified and one review was outstanding, when the surface named was
imaginary. **A phantom gap is worse than no gap**, and it survived because prose was doing
a job only a test can do: `ROUTING_SURFACE` now fails if a knob names a field no seat
carries, and fails if a seat gains a tunable nobody recorded a decision for.

**What this step still does not establish:** that the recalibration was *correct*. Whether
2M is the right worker budget on sonnet-5 is answerable only by running (#46). The
enforceable claim is that every knob's decision is recorded and attributed — the same
epistemic limit the ledger has.

### 5. Re-ablate the layers suspected of compensating for model weakness.

**Forbidden:** citing an ablation result measured on a superseded model as current.

> A phase worth +12 points on a weaker model may be worth +1 now at identical cost.

This is the Alfred thesis stated as a general law, which means **it applies to Alfred's own
founding number.** The 4.7x tokens / 4.6x cost / 6.8x wall measurement that killed phase
orchestration was taken on **sonnet-4-6** — verified from disk, not carried:
`test/fixtures/arm0-transcript.jsonl` names `claude-sonnet-4-6` on all 72 of its
model-bearing lines. The worker seat now runs sonnet-5.

So the correct posture is **provisional pending re-ablation**, and that is not a sentence
in a doc — `provisionalMeasurements()` derives it from `SEATS`, so it cannot be quietly
re-marked as settled, and it would flip on its own if the seat moved back. The re-ablation
itself is task #46.

### 6. *Then* add cases for the failure modes just discovered.

**Forbidden:** doing this before step 1. Adding a case for a failure the new model exhibits,
in the run that measures the new model, is fitting the ruler to the result.

Additive-only, per `SANDBOX.md` §9: fixtures grow, they do not get edited, and a new case
bumps `config/suite.json`'s version so older results stay readable as having been scored
against the older suite.

---

## The measurement ledger

`MEASUREMENTS` in `lib/model-changes.mjs` records every headline number Alfred's design
rests on, each pinned to the model it was taken on **and the seat it constrains**. The seat
is what makes it expirable: a number is stale when the seat it constrains no longer runs
the model the number was taken on, and `SEATS` does the dating.

As of 2026-07-30, **all three entries read provisional**, because the worker seat moved off
sonnet-4-6:

| measurement | claim, in brief | measured on | status |
|---|---|---|---|
| `phase-orchestration-cost` | 4.7x tokens / 4.6x cost / 6.8x wall for four phases, no PR | sonnet-4-6 | **provisional** |
| `arm-a-baseline-cost` | one bare context: Axis 1 = 2, $0.617, zero files | sonnet-4-6 | **provisional** |
| `arm-b-pipeline-cost` | harness-core: $18.483, 8 subagents, Axis 1 = 0, 9 files | sonnet-4-6 (+ opus-4-8) | **provisional** |

Do not read that table as "the numbers are wrong." Provisional means *the number was
correctly measured and no longer describes the current configuration.* The 30x cost ratio
between arms A and B was measured on one fixture with both arms on the same model, and that
comparison is still internally valid. What expires is any claim that the ratio holds
*today*.

Three caveats live in the ledger because they change how much a re-ablation would even
help:

- **The 4.7x is n=1**, on a formatting-only ticket. `PLAN.md:1070` already calls this the
  honest limit. Re-ablating at n=1 on sonnet-5 would replace one weak number with another.
- **Arm A and B's model is inferred, not recorded.** Nothing in
  `docs/exp2-evidence/armA.json` or `armB.json` names a model — they carry only
  provisioning fields (`slug, root, repo, origin, branch, head, tree`). The inference is
  well-grounded: arm B's pipeline record stamps `2026-07-30T15:15:43Z` = 08:15 PDT, and
  `752f3b0` landed at 10:39 PDT, so both arms finished before the seat move; and the shell
  in use still exported `ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic.claude-sonnet-4-6` when
  checked. Well-grounded inference is still the defect. **Arm C must stamp it**, which is
  what #42 wired.
- **Arm B crosses two seams, not one.** 65% of its $18.483 was opus **4-8** seats; the
  adjudicator seat is opus-5 now. The 30x is the figure most exposed to re-measurement.

### Adding to the ledger

A measurement belongs here when a design decision cites it. Four fields are required and
the test enforces all four: `model` (never inferred silently — if it is inferred, say so in
`caveat`), `at` as `YYYY-MM-DD`, `seat` (must exist in `SEATS`), and `claim`. A measurement
with no seat cannot be expired by a seat move, which makes it permanently fresh-looking —
the failure this ledger exists to prevent.

---

## What this protocol does not do

It does not make the numbers current. A test can hold *"the staleness is declared"*; it
cannot hold *"the re-ablation happened."* `test/model-changes.test.mjs` says so in its own
header, so nobody later reads a green suite as evidence the 4.7x has been re-confirmed.

It also does not block arm C. The point of writing it before the run is that the constraint
gets recorded while there is no result to protect.
