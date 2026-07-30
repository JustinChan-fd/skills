# Alfred — eval & ablation readiness checklist

**What this is.** A standing checklist for whether Alfred's *measurement practice* is
sound enough that its numbers mean something. Not a checklist for whether Alfred works
— that is `EXPERIMENT-2.md` and the test suite. This one asks the prior question: if a
future run says "layer X is worth keeping," would we be entitled to believe it?

**Provenance.** Adapted 2026-07-30 from `~/Downloads/harness-eval-readiness-audit.md`
(authored by Opus 5, 144 lines, 10 sections), at the user's direction:

> that doc is also maybe not supposed to fully apply line by line to our alfred work,
> but the bones and sections might apply for setting strong foundations. bring things
> over as needed but dont take it as gospel. use it to fill in our gaps and give us
> peace of mind moving forward.

The source doc was written against a **four-phase harness**. Alfred is deliberately a
single context. So this copy is an *adaptation*, and the adaptation is recorded per item
rather than done silently — see "How to read the verdicts" below.

**Ambition.** If this earns its place on Alfred, it becomes the gold standard applied to
future skills and workflows in this repo.

---

## How to run it

1. Read the actual repo. **Do not infer structure from naming conventions** — open the
   files. This rule is the source doc's and it is kept verbatim because it has already
   caught two stale docs in this project (see §9 notes in the scorecards).
2. Cite `file:line` for every finding. Where something is absent, write **"no artifact
   found"** rather than assuming it lives elsewhere. Where you cannot settle it, write
   `UNVERIFIED` — never guess.
3. Return one verdict per item (below).
4. Write the result to `docs/eval-readiness/<YYYY-MM-DD>-scorecard.md`, stamped with the
   date and the model that produced it, so the next run has something to diff.
5. **Do not fix anything in the same pass.** The source doc's closing line, kept:
   *"This pass is diagnostic — report first, and wait for direction on what to build."*
   A pass that fixes as it goes cannot report what the state was.

### Grep hazard, learned the hard way on 2026-07-30

`alfred/test/gate.test.mjs` contains literal `\x00` and `\x01` bytes — deliberate
delimiters in its `treeHash` helper (`test/gate.test.mjs:833`). `grep` therefore
classifies the file as binary, prints **nothing**, and exits **1**. An inventory built
with plain `grep -c` silently omits **28 tests in the module that is Alfred's whole
thesis**, and the non-zero exit reads as "no matches, clean." Use `LC_ALL=C grep -a`.
Same false-green family as an unquoted `--include=*.mjs` (zsh dies on the glob before
grep runs) and `cmd | grep pattern; echo $?` (reports grep's status, not cmd's).

---

## How to read the verdicts

| verdict | meaning |
|---|---|
| **PASS** | Satisfied, with evidence cited. |
| **PARTIAL** | Some of it exists; the scorecard names exactly what is missing. |
| **FAIL** | Not satisfied. No softening. |
| **N/A-BY-DESIGN** | The item presumes an architecture Alfred deliberately does not have. **Must carry the reason and the design decision it traces to.** |
| **N/A-NOT-YET** | Presumes a component not built yet. Must name the milestone. |
| `UNVERIFIED` | Could not be settled this pass. Must say what would settle it. |

**Why `N/A-BY-DESIGN` exists, and the trap it avoids.** The source doc's Section 2
asserts handoff-schema conformance *at every phase boundary*. Alfred has no phase
boundaries — that is the finding the whole project rests on (one context did the ticket
at 4.7x fewer tokens than four phases). Scoring that item FAIL would mean this checklist
failing a design for lacking a structure it was built not to have, which is the source
doc's **own** Section 1 warning turned on itself: *"mechanism-bound evals lock in the
current architecture and make it impossible to compare against a simpler design."*

So the split is: **`N/A-BY-DESIGN` when the item is mechanism-bound to a topology we
rejected on measured evidence; FAIL when the item is about outcomes and we simply don't
have it.** The second category is where every real gap has landed so far.

**Do not use `N/A-BY-DESIGN` as an escape hatch.** It requires a citation to the
decision, not a preference. If the reason is "we haven't got round to it," that is
`N/A-NOT-YET` or FAIL.

---

## Section 1 — Foundations

- [ ] **Eval corpus exists at all** — a versioned set of cases with expected outcomes,
      checked in. Where?
- [ ] **Corpus derives from real runs, not imagined cases.** Traceable to actual
      failures in run history? Cases invented from a spec are a weaker signal.
      *Alfred note:* the fixtures are synthetic by necessity but each trap's **shape**
      is required to cite a real ticket instance (`SANDBOX.md` §2 Mitigation 1). Score
      the citation, not the vibe: a trap with no cited real instance is a gap.
- [ ] **Evals assert on outcomes, not mechanism.** Flag every eval asserting "phase X
      emitted artifact Y" where the goal is "the change satisfies the ticket and passes
      the repo's tests."
      *Alfred note:* this item is the load-bearing one for us and must **never** be
      marked N/A. Alfred's thesis is that a simpler topology wins; mechanism-bound
      evals would make that untestable.
- [ ] **Grader hierarchy respected.** Classify each grader programmatic / human-labeled
      / LLM-judge. Flag any LLM-judge where a deterministic check existed (schema
      validation, exit code, suite result, tool-call assertion, file diff).
- [ ] **A held-out set exists**, never used for prompt/skill iteration. If not, say
      plainly that reported scores are contaminated by tuning.
- [ ] **Tiering for speed** — a fast smoke set distinct from the full suite. A suite too
      slow to run is a suite that isn't run.
- [ ] **Every eval independently runnable**, reporting machine-readable results, not
      only human prose.

## Section 2 — Contract & invariant coverage

Encodes declared protected invariants. Should be the most deterministic evals present.

- [ ] **Handoff/manifest schema conformance at every boundary, both directions.**
      *Adaptation:* Alfred has no phase boundaries. Expect `N/A-BY-DESIGN`. But the item
      is **not** vacuous — it becomes: *is every boundary Alfred does have asserted in
      both directions?* Alfred's real boundaries are (a) config file → `loadConfig`,
      (b) transcript on disk → `report`, (c) worker's touched files + AC map → `gate`,
      (d) report → telemetry sink. Score those four.
- [ ] **Repo-agnosticism tested, not assumed** — ≥3 deliberately dissimilar fixture
      repos (different language, layout, test runner, size) asserting equivalent
      behavior.
      *Alfred note:* this one stays as written. It is the item most likely to be
      quietly skipped, because sharing one tree across fixtures is convenient and
      `SANDBOX.md` §7 has a *deliberate* reason for it ("the repo stops being a
      variable"). That reason is sound for comparing arms and useless for proving
      repo-agnosticism. Both things are true; score them separately.
- [ ] **Heterogeneous intake equivalence** — Jira ticket, greenfield idea, raw prompt
      each drive intake to comparable downstream artifacts.
- [ ] **Audit logging completeness** — an eval asserting a full run produces a
      complete, parseable record with no dropped events. Protected invariant; should
      fail loudly.
      *Alfred note:* strongest fit of any Section 2 item, because telemetry *is*
      Alfred's product. `gaps[]` exists precisely so a structural hole is named rather
      than zero-filled.
- [ ] **Escalation behavior** — capped agents surface a decision rather than
      deliberating past budget, and a case exists that forces exactly that condition.
      *Adaptation:* the source doc names `NEEDS_DECISION`, a harness-core token. Alfred's
      equivalent is the blocked-item policy (`lib/blocked.mjs`). Score the behavior, not
      the token.
- [ ] **Verifiers are never capped** — asserted in config, or only assumed by
      convention?
      *Adaptation:* Alfred's verifier is a deterministic function with no token budget
      at all, so "uncapped" is structural. The live question instead: **is the gate
      reachable on every exit path**, including a worker that died or was killed? A gate
      that never runs is worse than one that runs uncapped.
- [ ] **Reasoning-budget assignment asserted as actually applied**, not merely passed.

## Section 3 — Grader quality

- [ ] **Any LLM-judge grader validated against human labels**, with the agreement rate
      reported. An unvalidated judge is an unmeasured instrument.
- [ ] **Judges emit discrete labels, not 1–10 scores.** Fine-grained scalars are
      unreliable.
- [ ] **Judge rubrics concrete and few-shot'd**, with an example of each grade.
- [ ] **Pairwise comparison used where absolute quality is ill-defined.**
- [ ] **Over-specification smell** — flag any eval that would break on a
      reworded-but-correct output. That is a grader defect: loosen the grader, don't
      edit the case.

*Alfred note on this whole section.* Alfred has no LLM judge in its runtime — the gate is
a function, and that is the thesis (`gate.mjs`: no model call, no network, asserted at
`test/gate.test.mjs:293`). But **the human scoring an experiment is a judge**, and
`EXPERIMENT-2-RESULTS.md` §11 says so out loud: *"Axis 1 is scored by me, and I hold a
thesis."* Score this section against **that** judge. Items 2–5 apply to a human rubric
exactly as they apply to a model one, and item 1's "validated against human labels" is
the one that genuinely cannot apply to a single human's own labels — say so, and record
what replaces it (pre-registration).

## Section 4 — Statistical hygiene

- [ ] **Run-to-run variance is known** — the same suite run repeatedly against an
      unchanged system to establish a noise floor. Without this number, no delta is
      interpretable.
- [ ] **n > 1 per case** for anything non-deterministic; variance reported with the mean.
- [ ] **Sample size adequate** for the effect sizes claimed. Flag any decision made on a
      <5% delta over a small set.
- [ ] **Comparisons are paired** — same inputs, both arms, per-case diff — not
      average-vs-average.
- [ ] **Suite is versioned**, results tagged `(suite version, model, config, date)`.
      Editing a case without a version bump silently rebases the history and makes trend
      lines lie.
- [ ] **Cases grow additively** — a written policy against editing existing cases.
      Additions are free; edits break comparability.

*Alfred note.* This section is where Alfred is weakest and the weakness is structural,
not an oversight: every headline number in the project is n=1, admitted in nine places
across the docs. `EXPERIMENT-2.md:594` pre-committed the honest consequence — *"A single
run per arm captures no variance. If the two arms land within one point on Axis 1, that
gap is not a result, and I should say so rather than break the tie in my own favor."*
**Variance cannot be retrofitted onto a run already taken.** Anything in this section
must be settled *before* the run it applies to, or it is settled never.

## Section 5 — Agent/trajectory specifics

- [ ] **End-state assertions on the environment** — branch created, tests pass, PR opened
      correctly, files as expected — rather than judging the transcript.
- [ ] **Trajectory metrics captured:** step count, tool-selection accuracy,
      revision-loop iterations, retries, stalls.
- [ ] **Cost and latency are first-class eval outputs** — tokens, dollars, wall-clock. A
      change that gains 3% quality and doubles wall-clock is a regression given the
      current pain points.
- [ ] **Stall detection is itself evaluated** — a case that reproduces a stall and
      asserts recovery.
- [ ] **Per-tier capability mapping** — subagent tasks evaluated per model tier, so the
      size → tier routing table rests on measured cliffs rather than intuition.

*Alfred note.* This section is Alfred's strongest fit of all ten — it is close to a
description of the product. Two Alfred-specific additions, both earned from measured
failures, not from taste:

- **Every metric ships with its own denominator.** `EXPERIMENT-2-RESULTS.md` §2.8: the
  watchdog reported arm B at *$1.072 of an $18 cap* while the arm was actually spending
  toward $18.483 — it read ~6% of the spend, so the cap could not fire at any price.
  A metric whose denominator is wrong reads as reassurance.
- **A record that says the run happened must not report the spend as zero.** `report.mjs`
  writes `total_usd: null` on a failed read, never `0.00`: *"A zero here would be
  plotted as a free run, and every spend threshold downstream would silently stop
  protecting anything."*

## Section 6 — Tail and failure-path coverage

**The most common gap. Read it carefully.** Kept whole from the source doc, including its
argument, because it is the item most likely to lead us to cut the right thing for the
wrong reason:

> Verifiers, revision loops, self-healing, and escalation contribute *nothing* on clean
> runs. Evaluated only against happy-path cases, they read as pure overhead — and get
> cut, after which the failures land in production. Components justified by variance
> reduction must be measured on worst-case, not mean.

- [ ] **Seeded failure fixtures exist:** repo with failing tests, malformed/partial
      input, ambiguous or underspecified ticket, unfamiliar repo layout, deliberately
      stalled agent, mid-run interruption (resumability).
- [ ] **Tail results reported as a separate arm**, never averaged into the headline.
- [ ] **Refusal / escalation / "insufficient information" cases exist** — situations
      where the correct behavior is to stop, not to proceed.

*Alfred note.* Read this section **against Alfred's own thesis**, not just its coverage.
Alfred's central claim is that a deterministic gate beats an LLM verifier at lower cost.
On a clean run the gate finds nothing and looks like pure overhead — which is precisely
the shape this section warns gets cut. The gate must be justified on the tail or not at
all. Note also that the tail is where the 4.7x measurement is *least* tested: it was
taken on the simplest ticket shape there is.

## Section 7 — Ablation readiness

- [ ] **A null baseline exists** — plain Claude Code, one good prompt, no harness, scored
      on the same suite. Every layer must beat this number to justify itself. The source
      doc: if this is missing, *"that is the single highest-priority gap in the audit."*
- [ ] **Layers independently toggleable** via config/flags, so an ablation needs no code
      edit. List which can be disabled cleanly and which are entangled.
- [ ] **Additive ladder is feasible** — baseline → +schemas → +gate → +telemetry →
      +model switching, each scored. Subtractive ablation on interacting components gets
      confounded (parts compensate for each other) and biases toward keeping everything.
- [ ] **One variable per run**, everything else pinned (model, config, temperature, case
      set).
- [ ] **Cost reported in the same breath as quality.** Quality-neutral is a *win* when
      the layer costs 40% of wall-clock.
- [ ] **Ablation results dated and stamped with the model they were measured on.**

## Section 8 — Model-change protocol

A documented procedure for what happens when a new model ships, in this order:

1. **Freeze the suite.** Run it unchanged. That is the reported number. Never add or edit
   cases in the same run as a model swap — the suite is the control variable.
2. **Read the new failure shapes.** New models fail *differently*, not merely less.
3. **Handle saturation.** Cases everything now passes carry no information — demote them
   to a cheap regression floor, don't delete them, and add a harder tier.
4. **Re-calibrate routing.** Size → tier thresholds and reasoning budgets move on every
   release. The evals stay put; the thresholds move.
5. **Re-ablate** layers suspected of compensating for model weakness rather than adding
   real structure. **Ablation results expire** — a phase worth +12 points on a weaker
   model may be worth +1 now at identical cost.
6. **Then** add cases for the failure modes just discovered.

- [ ] Is this, or an equivalent, written down in the repo? If not, that is a **FAIL** —
      an undocumented protocol is one that gets skipped under time pressure.

*Alfred note, and it stings.* Rule 5 puts an **expiry date on our own founding
measurement.** The 4.7x/4.6x finding that killed phase orchestration was taken on
sonnet-4-6. Seats moved to sonnet-5 on 2026-07-30. By this rule the correct posture is
that the 4.7x is *provisional pending re-ablation*, not settled. Any scorecard that marks
Section 8 without noting this is not scoring honestly.

## Section 9 — Staleness & periodic refresh

Skills and workflows rot. Scaffolding written for a weaker model becomes dead weight that
slows the current one. Audit for these drift signals:

- [ ] **Model-quirk workarounds** — instructions that route around a limitation that may
      no longer apply (verbose decomposition, redundant reminders, defensive
      re-statements, output-format nagging). List each with a note on whether it still
      earns its place.
- [ ] **Saturated evals** still counted in the headline, inflating it.
- [ ] **Corpus age** — what fraction of cases came from runs in the last 90 days?
- [ ] **Invariants that no longer match reality** — declared protected, code has drifted.
- [ ] **Dead phases/layers** — present but never load-bearing in any recent run.
- [ ] **Prompt bloat** — length growth with no corresponding eval improvement.
- [ ] **Dependency drift** — hooks, CLI flags, or APIs referenced but changed upstream.
- [ ] **Docs asserting their own freshness.** *(Alfred addition.)* A doc that says of
      itself "these numbers are transcribed from the code" is the kind that rots
      unnoticed, because the sentence reads as a guarantee. Find every such claim and
      check it. This item exists because that exact sentence was false in `PLAN.md` §6
      for a day.

**Recommended cadence** — adapt per scorecard, don't inherit blindly:

| Cadence | Action |
|---|---|
| Every change | Smoke set |
| Nightly | Full suite + tail arm |
| Monthly | Refresh corpus from recent runs; add cases for new failure modes; check judge-vs-human agreement hasn't drifted |
| Quarterly | Re-establish noise floor; demote saturated cases; prune model-quirk workarounds; review invariants against code |
| Every model release | Section 8 protocol in full |
| Semi-annually | Full additive ablation from the null baseline |

*Alfred note.* This cadence assumes a project older than Alfred is. Until a smoke/full
split exists, "every change" means `npm test` and "nightly" means nothing. Score the
cadence as **aspirational and say so** rather than pretending it runs.

## Section 10 — Anti-patterns to flag explicitly

Call out any instance by file path:

- Evals that measure the harness rather than the outcome
- LLM judges grading things a script could check deterministically
- Unvalidated judges producing headline numbers
- Happy-path-only suites used to justify cutting failure-path machinery
- Scores compared across different suite versions as if they were the same measurement
- Decisions made on deltas smaller than the (unknown) noise floor
- Iterating against the same set used to report performance
- Layers that cannot be disabled without a code edit
- Any place where "it seems better" substitutes for a measured delta
- **A green suite treated as evidence of behavioral equivalence.** *(Alfred addition,
  the sharpest finding of Experiment 2.)* Arm B's committed diff carried **6
  regressions**; the repo suite passed **21/21 in both states**, because it never
  exercised a null body. An AC saying "no behavior changes" must route to a differential
  check, never to `npm test`.
- **A metric reported without its denominator.** *(Alfred addition, §2.8.)*

---

## Required output per pass

1. **Readiness scorecard** — every item above with a verdict and one line of evidence.
2. **Top gaps ranked by leverage** — what most limits our ability to answer *"is this
   over-engineered for the current model?"* Explain the ranking.
3. **Minimum viable eval suite** — if coverage is thin, the smallest set that gives a
   real regression net: which cases, from where, which grader type, why those first.
4. **Concrete next actions** — ordered, each naming the file(s) to create or change.
5. **Diff vs. the last scorecard** in `docs/eval-readiness/` — what improved, what
   regressed, what was recommended and not done. **The "recommended and not done" line
   is the one that matters**; without it a checklist re-run becomes a ritual that
   produces a fresh document and no change.
6. **Save the report** to `docs/eval-readiness/<date>-scorecard.md` with the model that
   produced it.

## What this checklist does not do

- It does not decide whether Alfred is good. It decides whether our numbers are worth
  arguing about.
- It does not authorize spend. Items requiring a live run must be run as their own task,
  with caps pre-registered.
- It does not fix anything. See rule 5 of "How to run it."
