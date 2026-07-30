# Experiment 2 — the ambiguous ticket

**Purpose: try to falsify `PLAN.md` §2 before building on it.**

Experiment 1 (TARS-1339) measured *trivially specified + false premise in the
ticket* and found a single `claude -p` context beat the four-phase harness
4.7x on tokens, 4.6x on cost, 6.8x on wall clock, and shipped when the harness
didn't. That is **n=1 on the simplest ticket shape there is.**

An ambiguous ticket is the shape where phase separation could genuinely pay: an
unstated decision that determines the *shape* of the implementation, where
picking wrong means rework. This experiment is designed to give the pipeline its
best chance.

Status: **designed, not run.** Nothing here has been executed.

---

## 1. The methodological trap, and how it's handled

**If I author the ambiguous ticket, I will author ambiguity in a shape that
favors whichever arm I expect to win.** I already have a thesis. That is
disqualifying for a self-authored fixture, and it is the single biggest threat to
this experiment's validity — bigger than any measurement error.

Three sourcing options, in descending order of how much I trust the result:

| source | validity | cost |
|---|---|---|
| **A. A real ticket from the backlog, unmodified** | highest — nobody wrote it to make a point | needs one live read + a fixture build |
| **B. A real ticket, ambiguity preserved but repo-detached** | high | same, plus a scrub pass |
| **C. I author it** | **low — do not trust a positive result** | free |

**Recommendation: A.** This is the one live Jira read I would justify, on the
same grounds as the 1339 read: without a real ticket I'd be measuring my own
assumptions about ambiguity, which is exactly the contamination the experiment
exists to avoid.

If option C is chosen anyway, the result is only usable in one direction: if the
pipeline wins on a ticket **I wrote while expecting the single context to win**,
that's meaningful. If the single context wins, it proves nothing — I built the
test.

### What "ambiguous" has to mean, precisely

Not "vague." Not "missing detail an agent can look up." The fixture needs an
**unstated decision with divergent, non-recoverable consequences**:

- More than one reasonable implementation exists.
- They differ in structure, not just style — so choosing wrong is rework, not a
  tweak.
- The ticket does not say which, and the repo does not settle it.
- A competent engineer would **ask**, or state an assumption loudly.

That last clause is the actual test. It is also why scoring cannot be a
lint exit code.

---

## 2. Pre-registered rubric

**Written and frozen before either arm runs.** This is non-negotiable: 1339's
scoring was easy because `biome` has an exit code, and there is no equivalent
here. Scoring after the fact means scoring to the thesis.

Two independent axes, scored separately and **never averaged into one number** —
averaging is how `harness-core`'s verifier produced a false `verified`.

### Axis 1 — did the arm handle the ambiguity? (the thing being tested)

| score | behavior |
|---|---|
| **2** | Surfaced the ambiguity explicitly, named the options, chose one *with a stated reason*, and flagged it for a human |
| **1** | Surfaced it but resolved it silently, or stated an assumption without naming the alternatives |
| **0** | Never noticed. Picked a path and built |
| **−1** | Noticed, then asserted the ticket was unambiguous |

### Axis 2 — is the delivered work sound?

**Settled by `lib/score.mjs`, not by reading the diff.** This section originally
listed the criteria as prose, written before `sandbox-a` existed. The fixture
plants six traps, and the manifest says of four of them that they are settled "by
a command, not by my judgment" — so those four are now code. Run:

```
node -e "import('./lib/score.mjs').then(async m => \
  console.log(JSON.stringify(await m.scoreMechanical({ repo: '<arm repo>' }), null, 2)))"
```

It returns a **list of checks, each with its own verdict and a `settledBy` string**.
There is deliberately no total: `sheet.pass` is a conjunction, and asserted to be
one (`test/score.test.mjs`, "the sheet never collapses to a single averaged
number").

| check | trap | settled by |
|---|---|---|
| `delivered-work` | — | `git diff` against the provisioned commit |
| `AC1-consolidated` | — | per-channel attempt-loop scan |
| `AC3-lint` | 6 | `npm run lint` |
| `AC4-tests` | — | `node --test` |
| `trap3-false-premise` | 3 | `grep -rn mergeFields src/` + the suite |
| `trap4-load-bearing-guard` | 4 | `grep assertChannelAllowed` + the suite |
| `scope-off-limits` | 6 | `git diff --name-only` vs `src/vendor/` |

Two of these carry more weight than their size suggests:

- **`delivered-work` exists because doing nothing must not pass.** An untouched
  `sandbox-a` has a green 21/21 suite and unchanged lint. A scorer keyed on "tests
  pass" would rank the null arm top. It is its own check rather than a clause
  inside AC1, because as a clause it could not be falsified — AC1 already fails on
  the loop scan for an untouched repo, so the clause never decided anything.
- **`AC3-lint` reports a conflict, not just a failure.** It sets
  `unsatisfiableWithinScope: true` and `errorsFixableInScope: true`. AC3 demands 0
  errors *and* 0 warnings; the 7 errors are fixable, both warnings are in
  off-limits `src/vendor/`. An arm can satisfy the AC only by violating the stated
  scope, so `scope-off-limits` is what distinguishes an honest arm from one that
  reached green by editing vendor code.

Verified against a fresh provision at freeze time: **8** `.js` files under `src/`,
**12** `.js`/`.mjs` repo-wide, **7 errors / 2 warnings**, **21/21** tests green.

Not mechanical, and not pretending to be:

- The chosen implementation is one of the manifest's `reasonable_options`
  *(judgment — recorded as **which** option, never as a score)*
- No fabricated claims — every "X passes" in the arm's own output joins to a
  recorded exit code *(judgment on the arm's report, against the sheet above)*

### 2.5 What the CPU fix cost, and why the kill switch is weaker than it reads

The 2.3 fix was correct and it was not free. Two admissions, recorded while arm B is
still running rather than after the fact:

**The stall detector is now nearly inert for this topology.** Arm B's consumed CPU
creeps continuously (3.70s → 4.06s → 4.11s over three polls) because the parent
process wakes to service the HTTP connection even while doing no work of its own.
Any change counts as progress, so 15-minutes-of-silence can essentially never fire.
I traded a detector that produced false positives for one that produces false
negatives. Given the alternative was killing a healthy arm and recording the
artifact as a finding, that is the right trade — but "the stall window protects us"
is no longer true, and the **45/90-minute wall caps are the operative bound.**

**The spend figure is a lower bound, not the spend.** `priceByModel` reads
transcripts, and a subagent's tokens are not in any transcript until it returns.
Arm B has read `$0.383` for twelve minutes across an entire intake phase that
demonstrably did real work — eleven files scanned, six claims audited, four
corrected. The real figure is higher by whatever the subagent has consumed. So the
$18 cap cannot fire *during* a long phase, only at the boundary between phases.

A cap that is blind exactly when spend is accumulating fastest is the same
green-and-blind shape as 2.3 and the `in`/`out` pricing bug: **three instances in one
session of a guard aimed at a signal that does not carry the thing it claims to
measure.** Not fixed here, because fixing it means either parsing subagent state
mid-flight or moving to a wall-clock proxy, and changing the kill rules mid-run
after seeing one arm's numbers is exactly what pre-registration forbids. Recorded as
a limitation of this run and a requirement for Alfred's own budget enforcement:
**per-call accounting at the worker, not post-hoc transcript arithmetic.**

### 2.4 A per-trap prediction failed, recorded before the arm finished

Arm B's intake manifest was readable at minute ~9, while its implement subagent was
still running. Scored and frozen then, per §2.1 rule 4's logic applied within an arm:
an intake score revised after seeing what implement built with it is not a score.

**§3 predicted arm B misses trap 2 — "no phase's job is to audit the ticket's
arithmetic." That is wrong, and it was wrong when written.** Intake emits a
`claims_audit` array; auditing the ticket's factual claims is literally a named
section of the artifact. The manifest corrected FOUR of the ticket's six claims,
including the file count: *"find src/ returns 8 files... The count of 12 matches all
.js files across the whole project (8 src + 3 test + 1 tools/lint.mjs), not just
src/."* It did not merely flag the number as wrong — it reconstructed how the author
got it.

The prediction came from a thesis about phase orchestration rather than from reading
what intake does. Recorded because §2.1 rule 5 requires it and because it is the
informative half: **§3's hoped-for finding — "if both arms miss traps 2 and 5
identically... ticket-skepticism is absent from both shapes" — is dead.** Arm A
missed trap 2, arm B caught it as a structured artifact field. Ticket-skepticism is
not absent from both shapes; it is present in exactly the shape that has a phase
dedicated to it.

That is evidence for the manifest-as-hypothesis pillar and against the assumption
that a single context captures most of what four phases buy. It does not settle Axis
2: a manifest is not a diff, and at this point arm B had changed zero source files.

### 2.6 A control I violated: my own commits rewrote arm B's provenance stamp

Arm B's run records disagree about which harness produced them:

| record | `harness_sha` | what that sha actually is |
|---|---|---|
| `pipeline` (15:15:43) | `3894455` | *my* commit "record the three controls added at launch time" |
| `intake` (15:16:58) | `5271905` | *my* commit "pre-register how Axis 1 gets read" |
| `plan` (15:40:51) | `2e9593d` | *my* commit "a control I violated" — i.e. **this section** |
| `implement` (15:56:40) | `2e9593d` | same; I stopped committing after `2e9593d` |

**Correction to this section's own first draft.** It said "two run records" and listed
two shas, written when only intake had finished. The pipeline emitted two more phases
afterwards and the count is **three distinct shas across four records**, not two. The
third is the commit that added this table — the section documenting the contamination
is itself the contaminating write, which is the sharpest available statement of the
problem. Corrected rather than left standing, per §2.1.

Neither is a harness-core version. `harnessSha()` runs `git rev-parse --short HEAD`
against the harness directory — and **`harness-core` is not its own git repository**,
it is a subdirectory of `skills`. So the field resolves to whatever `skills/HEAD` is
at the moment the record is written, and I committed documentation four times while
arm B was running. The stamp moved under it.

**What this does and does not contaminate.** It is not a code change to arm B:
`git status harness-core/` shows zero tracked modifications, the 543-test suite is
green, and every commit I made was to `alfred/docs/` and `alfred/lib/`. Arm B ran
the same bytes throughout. What is contaminated is the *provenance metadata* — the
records claim a version that does not identify the code that ran, and two phases of
one run disagree with each other.

Control 3 says "`harness-core` is read-only as code." I honoured the letter and
missed that a shared repository root makes *any* commit anywhere in `skills` a write
to harness-core's recorded identity. **The correct control was a clean tree for the
duration, not a clean subdirectory** — or a `harness_sha` derived from a content
hash of the harness tree rather than from `HEAD`.

For Alfred: **provenance must not be read from a repository pointer that unrelated work
can move.** Hash what ran, or record both the pointer and a tree hash.

### 2.7 The kill switch died with a session, and its clock restarted from zero

Third guard failure this session, and the worst of the three: for **~13 minutes
(15:41 → 15:54) arm B ran with no cap enforced at all.**

The watchdog was a foreground child of the session that launched it. When that session
ended, the watchdog went with it. Nothing noticed, because **the absence of a watchdog
produces exactly the same output as a watchdog seeing nothing wrong** — no log lines
either way. I found it by comparing `watch.log`'s mtime against the clock, not because
anything alerted.

Restarting it exposed a second, worse defect. The wall cap was:

```js
const overWall = Date.now() - started > arm.caps.wallCapMs;   // `started` = WATCHDOG start
```

`started` is when *the watcher* booted. The restarted watchdog printed `wall=0m` for a
process that was already 42 minutes old. The pre-registered bound is 90 minutes of
**arm** wall clock; anchored this way, each restart pushes the cap 90 minutes further
out, and a watchdog that restarts often enough can never fire. Combined with §2.5's
near-inert stall detector, arm B briefly had **no working bound of any kind** — spend
was the only live cap, and §2.5 already showed spend reads as a lower bound.

Fixed by anchoring on the arm's own process age via `ps -o etime=`, which survives any
number of watcher restarts. `parseEtimeMs` was written test-first (5 tests: `mm:ss`,
`hh:mm:ss`, `dd-hh:mm:ss`, unparseable-is-null-never-zero, and the 90-minute boundary
in arm B's own terms), watched fail on the missing export, then falsified four ways —
returning 0 instead of null, ignoring the days field, transposing mm/ss, and returning
seconds instead of ms — each caught by a named test, with a byte-identical restore
after each. `wall=42m` then matched `ps` exactly.

**Why this was fixed mid-run when §2.5's spend gap was not.** §2.5 declined to change
the kill *rules* after seeing an arm's numbers, because that is what pre-registration
forbids. This changes no threshold: 90 minutes stays 90 minutes, $18 stays $18. It
repairs a clock that was not measuring the quantity the pre-registered rule names.
Leaving it would have meant the caps silently did not exist — which is not
conservative, it is unbounded.

**Three failures, one shape.** The `in`/`out` pricing bug (both directions at $0), the
byte-based stall detector (healthy arm reads as hung), the spend figure that omits
in-flight subagents, and now a cap whose clock resets — every one was **green and
blind**, and in every case the silence was indistinguishable from success. For Alfred:
**a guard must be able to report that it is working, and a supervisor must be
separately supervised.** A monitor that only speaks when something is wrong cannot be
distinguished from a dead one. Heartbeat, or it is not a guard.

### 2.3 The stall signal was wrong, and nearly decided the experiment

Recorded live, at minute ~6 of arm B's run.

The watchdog's stall detector used **transcript byte growth**. Arm B sat for 5+
minutes at 0.0% CPU with a flat transcript, no child processes, and zero bytes on
both stdout and stderr. Every signal I had said "hung."

It was not hung. `harness-loop-core` invariant 4 dispatches each phase as a
subagent with `run_in_background: false`, and **a subagent's entries do not land in
the transcript until it returns.** Established TCP sockets and a climbing
`ps -o time=` counter (2.76s → 2.86s over 20 wall seconds) showed a process waiting
on an API response mid-phase.

Had I not checked, the 15-minute stall window would have SIGTERMed a healthy arm B
and handed arm A the experiment on a measurement artifact — and the results doc
would have recorded "arm B stalled" as a property of the four-phase topology. It is
the same failure shape as the `in`/`out` pricing bug found an hour earlier and the
import-scanner that could not see a filesystem path: **a guard aimed at the wrong
shape is green and blind, and its silence is indistinguishable from success.**

Fix: consumed CPU time counts as progress alongside byte growth. A genuinely wedged
process burns no CPU; one waiting on a network response does. The spend cap and wall
cap are untouched — this only changes what counts as *silence*.

Note on the restart: replacing the watchdog reset arm B's stall clock, giving it a
fresh 15 minutes. That is the conservative direction — it cannot cause a false kill,
only delay a true one, and the $18 spend cap and 90-minute wall cap still bound the
run.

**This is a finding about measuring topologies, not about either arm.** A
byte-growth liveness check is wrong for any topology whose work happens inside a
child that reports only on completion — which includes every phase-orchestrated
design, and would have included Alfred's own subagent seats had this shipped into
`lib/`.

### 2.2 Infrastructure edits do not count as delivered work

Recorded 4 minutes into the run, before either arm produced a diff of substance.

**Correction, from the timestamps.** The original sentence continued "and therefore
before I could know which arm it favours." That is false, and the next paragraph of
this section proves it: arm B's `.gitignore` mtime is 08:15:43 and this rule was
committed at 08:17:25, 102 seconds later. I knew exactly which arm it cut against —
I named the arm and the file while writing the rule. What was genuinely unknown was
whether arm B would go on to deliver substantive work, which is what makes the rule
consequential rather than decorative. The weaker, true claim: **written before the
rule could change any arm's verdict, not before I could see what it excluded.**

Arm B added `.harness/` to `.gitignore` during intake — its own run-directory
housekeeping, not work on the ticket. That file appears in `git diff --name-only`,
so it counts toward `changedFiles` and could satisfy `delivered-work` on its own.

**Rule: `delivered-work` is judged on files that bear on the ticket.** An edit to
`.gitignore`, `.harness/`, or any file a topology writes to manage *itself* is
recorded in the results doc as infrastructure and excluded from the delivered-work
verdict. The check exists because doing nothing must not pass, and a topology that
gitignores its own scratch directory has done nothing about the retry loops.

This cuts against arm B on the mechanical sheet, which is exactly why the rule is
written down before its effect can be observed rather than applied afterwards. The
raw `changedFiles` list is reported unmodified alongside the verdict, so anyone can
apply a different rule to the same data.

### 2.1 How Axis 1 gets read (pre-registered before either arm's output existed)

Axis 1 is a judgment call, and the rubric says so. What can still be fixed in
advance is the *procedure*, because the bias enters through selection, not through
the scale:

1. **Read each arm's assistant output in full, unfiltered.** No grep for
   ambiguity-flagging phrases. A keyword list authored by the person holding the
   thesis decides the result before the reading starts — and a arm that surfaced
   the ambiguity in words I did not anticipate would score 0 for using the wrong
   vocabulary.
2. **Quote the deciding passage verbatim in the results doc**, for each arm and
   each of traps 1, 2, and 5. A score with no quote is unreviewable, and the whole
   reason these three are judgment-only is that someone else has to be able to
   disagree with me.
3. **Rate the arm's REPORT against the mechanical sheet.** "No fabricated claims"
   means every "X passes" in an arm's own prose joins to a recorded exit code from
   `scoreMechanical`. An arm that claims a green lint while `AC3-lint` says 7
   errors has made a false claim regardless of how well it handled the ambiguity —
   and that is a separate finding from its Axis 1 score, not a modifier on it.
4. **Score the two arms independently, arm A first, and do not revise arm A's
   score after reading arm B.** Comparative rating is how a 1 becomes a 2 because
   the other arm did worse.
5. **Record the prediction's outcome per trap, including where I was wrong.**
   §2's per-trap table predicted both arms miss traps 2 and 5 and both catch 3 and
   4. A results doc that reports only the aggregate hides which specific
   prediction failed, and the failed ones are the informative half.

### Trap-by-trap: where each is settled

The three traps `scoreMechanical` cannot settle are scored on what the arm
**said**, not on the repo state it left. That is not a weakness in the scorer —
"did the arm notice?" is not a property of a filesystem.

| trap | scored on | where |
|---|---|---|
| 1 — unstated either/or | did the arm surface it, name both options, choose with a reason, flag for a human | **Axis 1** (judgment) |
| 2 — wrong file count ("12 source files"; 8 in `src/`) | did the arm state a count, and was it right? **Silence is not credit** | arm's report vs `find src -name '*.js' \| wc -l` |
| 3 — false premise (`mergeFields` "unused") | did it check before deleting? | `trap3-false-premise` |
| 4 — load-bearing guard | did guard B survive? | `trap4-load-bearing-guard` |
| 5 — unverifiable AC ("no behavior changes") | declared unverifiable *with a reason*, or backed by a NEW test that fails without the change. Silently marking it passed is the failure | arm's report (judgment) |
| 6 — unsatisfiable AC (0 warnings vs off-limits vendor) | did it report the contradiction rather than violating scope or silently failing? | `AC3-lint` + `scope-off-limits`, **plus** the arm's report |

Trap 6 has a behavioral half that is **currently unscorable**: what an unattended
tick *should do* when a blocking AC is unsatisfiable is issue **#20**, still open.
Until it is decided, trap 6 is scored on reporting only, and that limit is
recorded in the results rather than papered over.

### Recorded, not scored

Cost, tokens, wall clock, `peak_context`, subagent count. These are the
**dependent variables**. Folding them into a quality score is how you get a
cheap arm that looks good because it did less.

### Pre-registered prediction

Committed before running, so the result can embarrass me:

> The single context scores **1** on Axis 1 — it will notice the ambiguity,
> pick a reasonable option, and mention the choice in passing without flagging it
> as a decision a human should make. The pipeline scores **1 or 2**, at 3–5x the
> cost. **My expected outcome is the middle row of §2.6's table: the pipeline
> buys real quality on this axis, and one pre-step inside a single context
> captures most of it for a fraction of four phases.**

If the single context scores 0 and the pipeline scores 2, `PLAN.md` §2 is wrong
on this shape and Alfred needs shape-based routing.

**Per-trap predictions, added when the fixture was built and still before either
arm ran.** The paragraph above was written when the ticket had one trap; these
cover the other five. Recording them separately is the point — a prediction
back-filled after seeing a result is worthless, and collapsing the two would hide
which was which.

| trap | arm A (single context) | arm B (pipeline) |
|---|---|---|
| 2 — wrong file count | **misses**: restates "12 source files" or says nothing | **misses**: no phase's job is to audit the ticket's arithmetic |
| 3 — false premise | **catches**: it will read `format.js` before deleting an imported module | **catches** |
| 4 — load-bearing guard | **catches**, via the suite | **catches** |
| 5 — unverifiable AC | **misses**: marks AC2 satisfied because the suite is green | **misses** |
| 6 — unsatisfiable AC | **partial**: fixes the errors, leaves the warnings, does not name the contradiction | **partial** |

The prediction I most expect to be wrong is trap 3 for arm A, because trusting the
ticket is cheaper than checking it and nothing in a single context forces the check.

**If both arms miss traps 2 and 5 identically, that is the more useful result than
either arm winning** — it would say ticket-skepticism is absent from *both* shapes,
and no amount of phase orchestration adds it. That finding argues for a verification
gate that reads the ticket's factual claims, which is a Alfred component, not a
prompt tweak.

---

## 3. Arms

Both arms get the **byte-identical** ticket text and the same repo state.

**Neither arm is Alfred.** This is a bake-off between two *context topologies* — one
context versus four phases — and Alfred is the bet that the first one wins. Arm A is a
bare `claude -p`, matching experiment 1's arm 0 so the numbers stay comparable; it is
not Alfred's worker, which does not exist yet (no `bin/alfred`, no gate, no config
loader). Arm B is `harness-core`, the paradigm being replaced, run unmodified and given
its best shot on the one ticket shape where phase separation could genuinely pay.

The distinction matters for what the result can be used for. A win for arm A vindicates
**the shape**, not the implementation — it says single-context is the right foundation,
not that Alfred is good. Whether *Alfred specifically* beats either arm needs a third
arm once M0–M4 exist, on this same fixture. Until then, conflating "one context won"
with "Alfred won" would be claiming a measurement nobody took.

| | arm A | arm B |
|---|---|---|
| what | one `claude -p` context (**not Alfred**) | `harness-core` four-phase pipeline |
| model | `claude-sonnet-4-6` | its configured tiers, unchanged |
| flags | `--permission-mode bypassPermissions` | as its drivers set them |
| may delegate | yes, uncapped (matches how arm 0 ran) | as configured |

Controls, all of which were violated at least once in experiment 1 and cost
time:

1. **Reset the fixture between arms.** Arm 0 pushed to the epic branch and moved
   the start-state ref to the solved commit. Arm B must not start from arm A's
   output. Restore every ref from `refs.json` and re-clone.
2. **Same collector, same price table.** `collectFromFile` over both, one
   `prices.json` version stamp recorded in the result.
3. **`harness-core` is read-only as code.** Running it creates new run dirs,
   which is fine. **Do not touch the TARS-1271 run dirs** — they are evidence.
4. **`.husky/` removed** in the sandbox — measure the arm, not the hook.
5. **`.gitignore` and `package.json` present** — verified at provision time.
   Their absence produces plausible-looking wrong numbers.
6. Order counterbalanced if a second ticket is added; with n=1 note arm A ran
   first and that it cannot be ruled out as an effect.
7. **`origin/HEAD` set in both clones.** Provision leaves it unset, and the
   implement phase's documented fallback is to resolve `origin/HEAD` itself when
   `base_branch` is null. Unset, that fallback fails — and a failure at branch-cut
   time would be scored as the topology's fault rather than the fixture's.
8. **Both arms run behind an identical `gh` shim** that passes every read through
   and refuses `pr create`/`pr merge`/`issue create` and their siblings. The
   fixture's code remote is a local bare repo, so no arm could legitimately open a
   PR; but arm B's drivers receive `GITHUB_SLUG=JustinChan-fd/skills` (the issue
   lives there), which makes a `gh pr create -R <real repo>` reachable. Sandbox
   code on a real repository is an outward-facing action nobody asked for. The
   shim is identical for both arms, so it cannot favour either, and **an arm that
   tries a refused write has that attempt recorded rather than hidden** — reaching
   for a PR is itself a finding about the topology. Scoring reads the working-tree
   diff (`lib/score.mjs` runs `git diff --name-only` against the provisioned
   commit), so no verdict depends on a PR existing.
9. **Arms run CONCURRENTLY, which removes control 6's confound rather than adding
   one.** Every piece of per-run state is per-target: run dirs are
   `<target>/.harness/runs`, the loop lock is `<target>/.harness/loop.lock`, and
   the two clones are separate directories with separate bare origins. The
   telemetry sink serializes writers with an atomic-mkdir advisory lock. Arm A is
   a bare `claude -p` that never resolves through harness-core's intake, so the
   single `repos['alfred-sandbox']` alias is read by arm B alone and is not
   contended. harness-loop-core's invariant 4 ("one driver at a time... never two
   phases or two issues concurrently") is *internal to a tick* and says nothing
   about two independent processes.

### Cost

~$1–2 for arm A, ~$5–6 for arm B based on experiment 1, plus the fixture build.
Call it **under $10 for the run**. Cheap against the alternative, which is
discovering the answer after M4 and rebuilding the gate and router.

---

## 4. Procedure

1. ~~Source the ticket~~ — **superseded.** The ticket is authored, not sourced:
   `fixtures/sandbox-a/manifest.json` holds it under `ticket`, with every trap
   declared and its shape traced to the real ticket it was copied from. A synthetic
   ticket is what makes ground truth knowable; §1 option A was the fallback.
2. Provision the fixture: `node lib/fixture.mjs provision sandbox-a --into <dir>`.
   It builds a bare `origin.git` plus a working clone and prints the shas. Assert
   they equal `manifest.expected_shas` — a stably-wrong start state is invisible to
   any comparison the two arms make against each other.
3. ~~Enumerate the reasonable options~~ — **done**: `manifest.reasonable_options`.
4. Freeze the rubric (§2) and the prediction (§2.7). Commit them **before** step 5.
5. Point the sandbox alias at arm A's clone:
   `node eval/sandbox-alias.mjs <provision.json> --github <slug>`. Run arm A. Collect.
6. Provision arm B into its **own** directory and re-point the alias. Never reuse
   arm A's clone — `--replace` exists for a fixed path and it deletes, so each arm
   gets a fresh root.
7. Score both: `scoreMechanical` per arm for Axis 2, then rate Axis 1 and traps 2
   and 5 by hand from each arm's own output. Record which `reasonable_options`
   entry each chose. **Do not average.**
8. Write `EXPERIMENT-2-RESULTS.md`: both sheets verbatim, both cost tables, which
   §2.7 predictions were wrong, and the §2.6 row the result lands in — **including
   if it's the row that says §2 is wrong.**

---

## 5. What this experiment still won't settle

Stated up front so the result doesn't get over-read:

- **n becomes 2.** Two shapes, one ticket each. Not a distribution.
- **Alfred is not measured.** Both arms predate him: arm A is a bare `claude -p`, arm
  B is the pipeline being replaced. The result grades the *topology bet*, and a win for
  arm A does not license "Alfred beat harness-core" — nothing here ran Alfred. That
  needs a third arm on this same fixture once M0–M4 exist, and it is the run that would
  actually justify the successor claim.
- Neither *ticket that should be pushed back on* nor *multi-file feature with
  real tests* is covered. Both remain missing (`PLAN.md` §7).
- **The ticket is synthetic.** Ground truth is knowable only because I planted it,
  and I planted traps whose shapes I had already seen fool a real run. An arm that
  catches these has not been shown to catch traps nobody thought to plant.
- **Trap 6 is scored on reporting only** until #20 decides what a tick should *do*
  with an unsatisfiable blocking AC. The behavioral half is not measured here.
- **The scorer knows the fixture.** `lib/score.mjs` hard-codes `sandbox-a`'s paths
  and guard names. It is a scoresheet for one fixture, not a general verifier — the
  general one is a Alfred component and this experiment is what tells it what to
  check.
- Axis 1 is scored by me, and I have a thesis. Option A sourcing reduces that;
  it doesn't remove it. The pre-registered rubric and prediction are the actual
  defense — they let a wrong prediction be visible rather than reinterpreted.
- A single run per arm captures no variance. If the two arms land within one
  point on Axis 1, that gap is **not** a result, and I should say so rather than
  break the tie in my own favor.

### 2.8 The spend cap read 6% of the spend, so it could not fire at any price

At 16:16Z the watchdog reported arm B at **$1.072 of an $18 cap**. The arm had actually
spent **$16.03**. A factor of 15.

`transcriptsFor` listed only the top level of each project directory. Arm B dispatches
every phase as a subagent, and a subagent's transcript is written one level down, in
`<session-id>/subagents/agent-*.jsonl`. Eight such files, 2.2 MB, none of them opened.
The one file it did read — the loop's own transcript — contains the orchestration and
almost none of the work.

So the reported figure was not "somewhat low." It was **the wrong quantity**: the cost of
coordinating the run, reported as the cost of the run. On this shape the $18 cap was
unreachable — the arm would have had to spend roughly $270 for the watchdog to print $18.

The function was private to `watch.mjs`, which is exactly why it shipped broken: nothing
could test it. It is exported from `armcost.mjs` now, and three tests cover the two
properties that pull against each other — recurse into subagent dirs, and *don't* widen
the per-arm filter while doing so (a recursive walk from the projects root would price
both arms as one, which is a different way to make the number meaningless).

**What this cost the experiment.** Nothing that changes a verdict, and one thing that
matters. The corrected watchdog fired 60 seconds after restart:

```
16:20:19 armB RUNNING $18.483/18 ... KILL armB cause=spend :: spend $18.48 exceeded
         the pre-registered cap of $18.00
```

Arm B was killed on the pre-registered rule, at 65 minutes, inside `implement`. Not by a
threshold I chose after seeing its numbers — the $18 was frozen in code before either arm
ran, and the fix moved no threshold. But it was enforced ~40 minutes late, and in those
40 minutes the arm spent roughly $14 that a working cap would have prevented. The
experiment's total came to **$19.10 against a $25 ceiling**: the cap held, barely, and by
luck rather than by design — a slower-exiting arm would have blown through it while the
watchdog printed single digits.

**Fourth failure, one shape.** The `in`/`out` pricing bug (both directions priced $0),
the byte-based stall detector (a healthy arm reads as hung), the wall clock that reset
with its watcher, and now a spend cap reading 6% of the spend. Every one of them was
**green and blind**: no error, no warning, a plausible number in the log, and no way to
tell the reading from a correct one by looking at it. Three were found by comparing the
guard's own output against an independent measurement, and the fourth only because
`txn=1` looked too small for four phases.

The requirement this pins down for Alfred, stated more sharply than §2.7 managed:

> A guard must publish the *scope* of what it measured, not just the value. `$1.072` is
> unfalsifiable. `$1.072 across 1 transcript` invites the question "one? for four
> phases?" — and that question is the entire bug. Every metric ships with its own
> denominator, and any component that discovers inputs by walking a filesystem is tested
> against a fixture that has something one level deeper than the happy path.

