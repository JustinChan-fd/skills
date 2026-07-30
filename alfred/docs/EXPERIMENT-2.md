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
