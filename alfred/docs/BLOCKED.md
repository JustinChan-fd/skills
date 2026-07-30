# The blocked-item policy

**Status: DECIDED.** Closes `PLAN.md` §8.5 (`harness-core` #20), which had been
carried as an open product decision.

## The decision

> If there's something the agent can't get past or reason through, just stop the
> run and comment on the ticket or issue — we're blocked until the user replies. With
> a block message, label or flag on the ticket, the loop can still run again but
> skips over a blocked item until it has nothing else it can do. At that point,
> terminate the loop.

Implemented in `lib/blocked.mjs`, tested in `test/blocked.test.mjs` (21 tests).

## The four rules

1. **Stop the run.** Do not proceed on a guess. Nothing is merged and no acceptance
   criterion is reported as met.
2. **Comment on the ticket**, naming the specific obstacle. A block with no detail
   is refused at the API level — `planBlock` throws.
3. **Apply `alfred:blocked`.** The loop is stateless between ticks (`PLAN.md` §2.2 —
   the loop is a `while`, not a prompt), so the ticket itself carries the state.
4. **Skip, then terminate.** Later ticks pass over blocked items. When nothing
   workable remains, the loop stops rather than waking to re-skip forever.

## Unblocking

A human replies to the comment and removes the `alfred:blocked` label. That is the
whole gesture — no extra tooling, and it is the same action whether the fix is a
clarified requirement, a granted permission, or an amended AC.

## Reason codes

A closed set, so "how often does Alfred block, and on what" is answerable by
aggregating telemetry rather than grepping prose. Adding a free-text reason throws.

| code | means |
|---|---|
| `unsatisfiable-ac` | an acceptance criterion cannot be satisfied as written |
| `ambiguous-requirement` | the requirement admits two materially different readings |
| `missing-access` | a required permission or resource is unavailable |
| `verification-failed` | the work could not be verified, so it will not be reported as done |

`sandbox-a`'s AC3 is exactly `unsatisfiable-ac`: it demands 0 errors *and* 0
warnings, and both warnings live in `src/vendor/`, which the ticket declares off
limits. TARS-1339's AC #1 was the real instance this was learned from.

## Design notes worth keeping

**Why a label, not run-local state.** Nothing survives a tick except the ticket, so
the marker has to live there. It also makes the block visible to a human scanning
the issue list, which run-local state would not be.

**Why `addLabels` is additive.** Writing a full label set would silently drop
anything a human added between ticks. Alfred adds one label and touches no other.

**Why re-blocking is a noop.** The loop re-reads every item each tick. Commenting
each time would bury the original explanation under identical copies, which is a
slow way to destroy the one artefact a human needs.

**Why labels are read in two shapes.** `gh issue view --json labels` returns
`[{name: '…'}]`; a hand-built item holds plain strings. Reading only the string form
would make every blocked item look workable — the failure mode is an infinite retry
of something that cannot succeed, which is the opposite of this policy's intent.

**Why all-blocked and nothing-to-do report differently.** Both stop the loop and
they mean different things to whoever reads the log: one needs a human reply, the
other is a clean idle. `planTick` returns `blockedCount` and distinct `reason`
strings so the two are never conflated.

## Known limit

Trap 6 in Experiment 2 has a behavioural half — *what should a tick do when a
blocking AC is unsatisfiable* — that this policy now answers, but the experiment's
arms were specified before the answer existed. Arms A and B are still scored on
**reporting** only, since neither runs Alfred's loop. `EXPERIMENT-2.md` §5 records
that limit; this policy is what a future Alfred arm would be scored against.
