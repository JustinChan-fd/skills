# Alfred — retrospective, 2026-08-02

Written at the point the decision was made to **rebuild Alfred thin**: to keep the
mechanical library and delete the orchestration around it. Written *before* the rebuild
rather than after, so that the reasoning is on record while there is no new result to
protect.

This document is history and judgement. It is not a spec — `PLAN.md` is the spec, and
where the two disagree, `PLAN.md` describes what exists.

---

## 1. What Alfred was for

One sentence, from the original ask: **a process that runs on a loop, checking Jira/GitHub
every n minutes, deciding whether to pick up the next ticket in the queue, working it,
verifying itself, and logging every run's metrics to a local folder for KPI analysis.**

The persona brief (`PERSONA.md`) fixed one operational number — a patrol every 30 minutes
— and one posture: Alfred is the engineering team, the ticket is the stakeholder. A ticket
that cannot be worked gets a comment and a label, not a guess.

Two things about that ask matter for everything below:

1. **The loop was the point.** Autonomous pickup was the capability being bought.
2. **The metrics were the deliverable.** Not a by-product — the stated reason upper
   management would care, and the thing that had to run flawlessly.

## 2. What was actually built

Four pieces (`PLAN.md` §2): a trigger, one `claude -p` worker in a single continuous
context, a deterministic gate that runs *after* the worker in a separate process on the
worker's artifacts, and a reporter that turns the transcript into a record and syncs it to
a git-backed sink.

Milestones M0–M7 were specified; **M0–M6 were built, M7 was not.** As of the freeze tag
`alfred-foundation-frozen` (`d8e4db8`), the tree carried 24 library modules, 38 test files,
and 1553 passing tests. By the end of Phase A that is 1578.

What works, verified rather than asserted:

- **`alfred work "<ticket>"`** — a single, manually-invoked run against one named ticket.
- **The record** (`report.mjs`) — tokens by model, cache read/creation split, cost matched
  to the vendor's own figure **to six decimal places**, gate findings, AC grading,
  delivery status, wall time, and named gaps.
- **The sink** (`telemetry.mjs`) — `log/<repo>/<run_id>.json`, wired as run step 7c so a
  sink failure can never lose the local copy.
- **The gate** (`gate.mjs`) — a deterministic checklist over the diff, not a model call.
- **The library/orchestration split** — 15 modules import only Node builtins and each
  other. This was re-verified by reading the import graph, not assumed, and it is the
  single most consequential fact in this document. See §6.

### What was never built

**`alfred loop` — the original goal — was never started.** The CLI command name exists as
a deliberate refusal (`cli.mjs:295`): *"alfred loop is not yet built: it needs the lock
file and the source poll of PLAN.md §2.2. Refusing rather than exiting 0, because a
scheduler cannot tell a silent success from a tick that patrolled and found nothing."*
`alfred schedule` does not exist at all. No polling, lock-file, or queue-decision logic
exists anywhere.

That refusal is the right shape — a stub that exits 0 would have been indistinguishable
from a healthy patrol — but it means the capability the whole thing was for has zero
instances. Everything measured below was measured on manual invocations.

## 3. The founding measurement, and its caveat

Alfred exists because of one number. A four-phase orchestration was compared against a
single bare context on TARS-1339: **4.7x tokens, 4.6x cost, 6.8x wall clock — and the
orchestrated arm did not ship a PR.** That killed phase orchestration and set the
single-continuous-worker design.

Three caveats are on record (`MODEL-CHANGES.md`, and `lib/model-changes.mjs`'s
`MEASUREMENTS` ledger, which derives the staleness rather than stating it in prose):

- **It is n=1, on a formatting-only ticket.** `PLAN.md:1103` already calls this the honest
  limit. Re-ablating at n=1 would replace one weak number with another.
- **It was measured on sonnet-4-6** — verified from disk: `arm0-transcript.jsonl` names
  `claude-sonnet-4-6` on all 72 of its model-bearing lines. The worker seat runs sonnet-5
  now, so the number reads **provisional**, meaning *correctly measured, no longer
  describing the current configuration.*
- The general law it rests on cuts against it: *a phase worth +12 points on a weaker model
  may be worth +1 now at identical cost.* That applies to Alfred's own founding number.

The ledger exists so this cannot be quietly re-marked as settled. `test/model-changes.test.mjs`
says in its own header that a test can hold *"the staleness is declared"* and cannot hold
*"the re-ablation happened."*

## 4. The two real experiments

Both were same-ticket, both arms on the same model, both non-destructive by standing
constraint (no pushes, no real PRs).

### TARS-1351 — a documentation ticket

|  | Alfred | single-agent |
|---|---|---|
| vendor cost | $4.279 | $1.873 |
| `num_turns` | 77 | 18 |
| cache-read ratio | 88.7% | 84.8% |

**2.28x, not the "4x" from napkin math.** Cache reuse was *higher* on Alfred, so caching
was not the cost driver.

**Quality: a wash, arguably slightly worse for Alfred.** Both arms passed all six literal
ACs and ground-truthed correctly on both objective counts. Beyond that floor, one real
defect each: Alfred left a stale, byte-identical duplicate "External Services" table at
the top of the document while building a fuller one lower down — a structural defect a
reader hits first. The single-agent asserted that *all* handlers call Placement Service
via `PLACEMENT_SERVICE_ENDPOINT`; only 1 of 7 browse handlers does. Alfred's equivalent
line is the corrected version of exactly that fact.

So on the ticket shape where extra deliberation should most plausibly pay off — no code
conventions at stake — 2.28x bought a wash.

> **The Alfred cost figure here is CONTAMINATED and must not be read as an architecture
> result.** Per `lib/router.mjs`, `--max-budget-usd` was removed on 2026-08-02 after an
> isolation experiment found it freezes cache breakpoints: with the flag present,
> `cache_creation_input_tokens` was 0 on every turn and `cache_read_input_tokens` stayed
> pinned at its first-turn value for the whole run, forcing every later turn to resend the
> growing context uncached. Identical freeze at $8 and at $1000, so it is the flag's
> *presence*, not its value. On this run the flag is **the likely majority cause of $6.10
> of $7.49 landing as uncached input.** The thin runner does not pass it. So the largest
> single term in any Alfred-vs-thin delta is **a removed CLI flag, not an architecture**,
> and a comparison that omits this sentence reads as an architecture win. This is exactly
> why A5 added `provenance.notes` — the caveat travels with the record, not with a doc
> someone may not open.

### jarvis#7 — a code ticket

Chosen specifically to test the open question TARS-1351 left: whether convention adherence
and multi-file consistency tip the value calculation for code the way they didn't for docs.

|  | Alfred | single-agent |
|---|---|---|
| vendor cost | $6.04 | $10.24 |
| `num_turns` | 114 | 154 |

**Cost reversed — Alfred 1.7x cheaper.** Two tickets, two directions. **Cost delta is not
a reliable Alfred-vs-single-agent signal.** It appears to track how much the worker
second-guesses itself, not architecture.

**One real quality edge, and it is the only unambiguous one either experiment produced.**
The ticket's advisory notes said *"consider a confidence threshold or review step before
auto-creating to avoid noise."* Alfred built one: `CONFIDENCE_THRESHOLD = 0.6`, a required
per-candidate `confidence` field, type/range validation, and a filter upstream of dedup.
The single-agent has **no confidence field anywhere** — zero grep matches across both its
files — and built no review-step UI either, so this is not "it chose the alternative." Both
test suites were independently re-run rather than self-reported: 472/472 and 470/470 green,
clean `tsc` on both.

The rest — routes, dedup, test depth, task-list integration, injection hygiene — was
comparable. This does not generalize to "Alfred writes better code," and it is n=1.

**And the gate produced a false positive on real data.** Alfred scored `gate: FAIL` on
`evidence_weakened`: "36 line(s) deleted" from `NotesPageHeader.test.tsx`. Independently
checked: test count went **5→9**, assertions **6→12**. The 36 lines were a six-field
`mockReturnValue` repeated five times, collapsed into one `baseContext()` helper, with
net-new tests added on top. `checkEvidence` counted raw deleted lines with no distinction
between *deleting the assertion that made this fail* — the historical sandbox-b trap the
rule was built for — and *refactoring setup while adding coverage.*

**Second, separate gap:** `extractAcceptanceCriteria` recognised only a literal
`## Acceptance Criteria` heading. Issue #7's checklist lives under `## Details`, so
`ac_count: 0`, `graded_criteria: 0`, `ungraded_reason: "none were declared"`. The gate's
AC-grading half was structurally blind — and the only reason the run scored FAIL at all was
the *unrelated* false positive. Had that not fired, a run with **zero graded criteria would
have passed silently.**

That is the most important sentence in this document. The one thing Alfred is supposed to
add over a single agent is deterministic, gate-enforced correctness, and on real data it
delivered a false FAIL on an improved diff while silently grading nothing.

## 5. What was fixed, and how it was proven

Both defects are closed. Neither fix is trusted on a green test alone, because *a test
green before and after a fix proves nothing on its own* — so each was mutation-tested by
breaking the fix in the plausible-wrong direction and confirming exactly the named test
fails.

| commit | defect | mutation result |
|---|---|---|
| `c096ebb` | `evidence_weakened` counted raw deleted lines | 9 mutants, 9 killed, no collateral. **One survived and is recorded as surviving** rather than papered over: `[^{}]*` vs `.*` on the inner rename captures is indistinguishable on real git output, because git factors once and puts the slashes *inside* the braces. The tighter parse is kept on principle and the comment no longer claims a hazard nothing can produce. |
| `5d1d43d` | the local sink was unreachable at two layers, not one | 7 mutants, 7 killed. |
| `0ac6c4d` | no field said which approach produced a record | 8 mutants, 8 killed. |

`c096ebb` also fixed the AC-heading blindness's downstream half. The heading-variance
problem itself is not fixed by widening a regex — see §7.

An honest note on the survivor: recording it is the point. A mutation report with no
survivors is either a genuinely tight suite or a report nobody looked hard enough at, and
those two are indistinguishable from the outside unless the survivors get named.

### Three defects that 781 green tests could not see

The first real `$1.067` run exposed three things the suite was structurally incapable of
noticing: an unreachable `budget_usd` (#70), a gate that failed a correct run (#71), and
declared checks that never ran (#72). The cause is on record as
`feedback_mocked_seam_blindness`: **a test injecting a fake at a seam cannot see that the
seam is missing.** The fix was to run the real entrypoint against a free stub, which found
nine defects past 1148 green tests.

This is the recurring failure shape of the whole project, and it has a name here:
**computed-and-discarded.** A value is calculated correctly, carried nowhere, and the test
asserts the calculation. #63, #69, #72, and #73 are all this. A gate that cannot fire and a
gate that passes look identical from a green suite — which is why `feedback_unfalsifiable_conjunct`
now requires splitting two propositions out of one pass boolean, and why A5's most valuable
test is the *falsifier* (all three real arms plus `null` record no gap), not the one that
catches the typo.

### A fourth, found the same way: the cost figure was 5-6% low for the entire project

Appended 2026-08-03, after Phase D. The result line carries **two** token ledgers — a flat
`usage` object and a per-model `modelUsage` block — and Alfred summed the smaller one.
Measured on both real jarvis#7 runs:

| run | ours | vendor `total_cost_usd` | short by |
|---|---|---|---|
| `20260803T141200Z-7` | $6.030214 | $6.352074599999998 | 5.34% |
| `20260802T142320Z-7` | $5.693860 | $6.03788025 | 6.04% |

Three things about this are worth more than the fix.

**The price table was innocent, and had been the suspect twice.** Pricing `modelUsage` at
the very same rates reproduces the vendor's figure to 1e-9 on both runs. Two earlier
investigations went after the rates; the defect was one field to the left. A wrong answer
localises badly when two candidate causes both predict "our number is low."

**Five agreeing records were read as evidence FOR the table.** The two ledgers agree to six
decimals on short runs, and all five backfilled records are short — so the sink's own data
looked like confirmation. This is `feedback_mocked_seam_blindness` one layer up from code:
not a fake at a seam, but a *corpus* that only contains the regime where the bug is
invisible. Every fixture in a 1147-test suite was small for the same reason every fixture in
every suite is small.

**A human noticed, not the harness.** Both figures had been on the record since M2 and their
agreement had been cited repeatedly as proof the table was right — with nothing ever
comparing them. `cost-source-disagreement` (tolerance relative at 0.1%, because five records
agree to 6dp but differ by 1.11e-16 in the last bit) now fires on 2 of 7 records and on
neither of the five that agree. That the comparison did not exist while both operands sat
side by side in one JSON object is the same computed-and-discarded shape as #63/#69/#72/#73
— and it means the shape survives review passes that were specifically looking for it.

## 6. Why rebuild thin

The decision does not rest on the cost numbers, which point in two directions. It rests on
one structural fact and one behavioural one.

**Structural: the valuable parts were never coupled to the orchestration.** 15 of 24
library modules import only Node builtins and each other. `gate.mjs`, `report.mjs`,
`telemetry.mjs` import nothing from `run.mjs`, `router.mjs`, `cli.mjs`, or `prompt.mjs`.
They are already plain functions over data — worker log in, record out; diffstat plus
config in, findings out; record in, sink-synced out.

This was **proven, not inferred.** A standalone extractor imported `recordForRun` directly
and ran it against a plain `claude -p` single-agent worker log with no Alfred orchestration
involved, producing the same validated record shape and matching two independent historical
runs to eight decimal places. The decoupling the rebuild wants is already true of the
code's shape; it was just never packaged.

**Behavioural: the worker never used the orchestration it was given.** Every run measured
— jarvis#7, TARS-1351 — came back `subagent_count: 0`. The scan and reason seats are
*advertised* via `--agents`; nothing forces delegation, and the model never chose it. So
the orchestration layer's cost was paid on every run and its capability was exercised on
none.

Put together: the parts that earn their keep are library calls, and the parts that don't
are the ones being deleted. `alfred loop` is replaced by the first-class `/loop` primitive
rather than rebuilt — it is a scheduler that already exists.

**What the rebuild does not claim.** It does not claim Alfred's gate earns its keep over
the metrics library alone; nothing here establishes that. It does not claim the thin runner
will be cheaper — the one number that would look like evidence for that is contaminated by
`--max-budget-usd` (§4). And it does not claim the loop will finally work, because on this
machine `/loop`'s underlying mechanics are session-scoped: nothing is written to disk, the
job dies with the session, and recurring jobs expire after seven days regardless. *"Until
all tickets are done"* must be read as *"until done, capped at about a week of
session-bound looping."* True unattended operation needs scheduling outside the session —
real system cron invoking `claude -p` headlessly.

## 7. What the rebuild carries forward

- **The library, unchanged.** All 15 pure modules, plus `acmap.mjs` and `config.mjs`.
- **A confidence gate before work starts, not a wider regex.** Hardening a heading regex
  against infinite ticket-format variance is a losing game. Instead: let the model read the
  ticket in whatever format, extract ACs **with quoted grounding**, and have *plain code*
  verify each quote actually appears in the ticket body. That makes hallucination and
  paraphrase-instead-of-quote mechanically detectable without trusting a self-report — the
  same reason `"did you verify this passes?"` is not a check. Low-confidence or ungrounded
  means refuse early, **and still write a record**, so false-refusal rate is trackable and
  not just false-pass rate.
- **Real delivery, which raises the bar rather than lowering it.** Every experiment so far
  was simulated. A false positive today merely blocks; a false negative once delivery is
  real puts a bad PR on a real repo under the operator's name. PRs are **drafts, never
  merged** — `never_merge` enforced at point of use, not as a config flag someone can read
  as applied.
- **`provenance.arm`, carried and never inferred** (A5, `0ac6c4d`). Three arms will sit
  side by side in one sink and until now no field said which produced a record. There is
  deliberately no heuristic: an arm read off a record's own contents would be the
  conclusion copied out of the data meant to support it.

## 8. The honest limits of this document

- **Every quality verdict here is n=1 per ticket shape**, and the two shapes disagreed.
- **Cost has no consistent direction** across the two experiments, and the more dramatic of
  the two figures is contaminated by a since-removed flag.
- ~~**The gate has never returned `true` on a real run.**~~ **CORRECTED 2026-08-03 by Phase
  D.** It has now: `20260803T141349Z-...TARS-1351` graded `pass: true` with 6 criteria
  graded and 0 findings. Struck rather than deleted, because the reason it was worth writing
  still stands — only-ever-failed was not the same as can-pass, and the #73 fix had been
  validated only on the eval path. What replaces it is a narrower limit: **the pass came on
  a run that changed nothing.** The worker rejected the ticket's premise (the required doc
  sections already existed at `72dfa6df`), verified all six ACs against the file on disk, and
  committed nothing. So a pass is now demonstrated over a *correct no-op*, and not yet over
  work that produced a diff.
- **The push path has never executed on a real run.** Both Phase D runs avoided it from
  opposite directions: TARS-1351 passed the gate with `commits: []` so there was nothing to
  push, and jarvis#7 committed locally but was killed at the 25-minute wall cap, so the gate
  failed and delivery correctly stopped. `never_merge: true` and the draft-PR path are
  therefore still only test-covered, and no draft PR has been opened anywhere.

  **AMENDED 2026-08-03, four runs later, and the reason it keeps not executing has changed.**
  The first two avoided the push by accident. The next three were each stopped earlier, and
  by a *different* mechanism — which is more informative than one repeated failure:

  - **jarvis#6**, refused in its first turn for `low-confidence` at $0.224755. AC6 is
    "verify fix across common mobile breakpoints (375px/390px/414px)", which admits no
    deterministic check, and it scored 0.5 against the 0.6 threshold. The refusal is
    **correct**: the ticket is visual-confirmation ACs end to end, so it is the wrong
    *shape* for this harness, and that was established for one turn's spend rather than a
    full run's. First time the confidence filter fired on a real ticket.
  - **jarvis#11, first attempt**, refused for `quote-not-in-body` at $0.067002 — and the
    refusal was **wrong**. That body holds eight literal backslashes (the author typed
    escaped quotes into GitHub), an attestation arrives as JSON, so `JSON.parse` collapsed
    `\"` to `"` and the comparison rejected a faithful quotation as a paraphrase. Fixed in
    `9ad6476`. A refusal path is the one place a false positive is invisible, because it
    looks exactly like the guard working.
  - **jarvis#11, re-run** — preflight **passed live** (first confirmation that `9ad6476`
    works in the run path, not only under test), the run **completed cleanly** at exit 0 in
    1438890ms for **$6.107901**, and **delivery committed for the first time on a real run**:
    `56162bc` on `alfred/justinchan-fd-jarvis-11-20260803t151017z-11`, 5 files, +131. The
    gate then **failed on one finding** and delivery correctly stopped before the push.

    **The finding is correct, and the worker's own writeup is the proof.**
    `mapping_implausible` on AC6 — "A clear data contract (or operation set) defines the
    relationship between Notes and Todos" — mapped to a `vitest -t` filter over a prompt
    assertion. The brain entry it wrote says, unprompted: *"the ticket's AC6 is satisfied at
    the prompt-contract level, not the schema level"*, and files the structural link under
    **Deferred**. So the gate caught an architectural criterion being settled by a test that
    cannot settle it, on a run where the code changes themselves were sound.

    Two things worth separating here. The work was **good**: it rejected the ticket's stated
    root cause (`summarize.ts` already filtered completed tasks), found two real gaps
    instead, and wrote the test before the fix, saying "New test fails as expected (red)".
    The gate still failed it, and rightly — a correct fix mapped to the wrong evidence is
    exactly what `mapping_implausible` is for. A harness that passed this because the diff
    looked good would be grading the code and calling it grading the claim.

  A hazard found while checking whether delivery was even armed: jarvis's `.husky/pre-push`
  blocks any push touching `src/`, `server/`, or `scripts/` without a `docs/brain/` entry,
  generating one by spawning `claude -p` before exiting 1. Delivery passes `--no-verify` to
  `commit` but deliberately not to `push` (see `lib/delivery.mjs`), because a pre-push hook
  is the repo owner's guard on state other people see and `.husky` is in that repo's
  `off_limits`. It also spends tokens no record can attribute, which is worth knowing
  before reading a cost figure from any run that pushed.

  **I predicted that hook would block this run's push, and I was wrong.** Evaluating its
  real condition against `main..56162bc`: four files under `src/`/`server/` **and**
  `docs/brain/2026-08-03-completed-todos-in-summary-fix.md`, so it would have exited 0 and
  the push would have gone through. The worker satisfied the repo's own convention without
  being told the hook existed — it read the surrounding `docs/brain/` entries and wrote one.
  Worth recording because the prediction was the confident part and the observation
  contradicted it: the hook is still a live hazard for a run that *doesn't* write a brain
  entry, but it is not what stopped this one. **The gate did.**
- **The sink supports ONE arm, not three, so the 3-way comparison cannot be computed from
  it.** Audited 2026-08-03 after Phase D: all ten records carry `provenance.arm ===
  'alfred-thin'`. The distinct-arm count is 1. The other two arms ran before A5 added the
  `provenance` field, and the backfill covered only thin-arm runs.

  **And it is not recoverable by backfilling, which was checked before writing this off.**
  None of the twenty-plus artifacts in `docs/exp2-evidence/` is an Alfred record:
  `armA.json`/`armB.json` are worktree snapshots (`slug,root,repo,origin,branch,head,tree`),
  `armB-implement-record.json` is the harness-core schema, and `armC-acmap-n3-record.json`
  has its own shape (`arm,suite,summary,spent_usd,verdict,thresholds,runs`). Not one carries
  a `cost` block or a worker transcript, so cost cannot be re-derived for any of them.
  Stamping an arm onto a record whose cost cannot be re-derived would manufacture the
  comparison rather than measure it, which is the one thing this whole project is against.

  Consequence for what may be claimed: the cross-arm figures that DO exist — 2.28x on
  TARS-1351, and cost *reversed* (Alfred 1.7x cheaper) on jarvis#7 — come from hand analysis,
  not from the sink, and must be cited that way. The two worktrees
  (`jarvis-issue7-single-agent`, `jarvis-issue7-alfred`) are intact, so a future comparison
  can be re-run under the current schema; it has not been.
- **No aggregation exists.** Records land; nothing rolls them up. The dashboard refuses to
  run (`build.js`: *"v2/ was retired on 2026-07-28; log/ is now the only sink"*). Per-run
  metrics being correct and per-epic metrics not existing are two different states, and
  only the first is true today. This is by design — Alfred writes raw metrics, metadata,
  and snapshots; all KPI analysis and heavy calculation belongs in `alfred-telemetry` as a
  separation of concerns — but the second half of that split is not built.
- **One run exists in TWO sinks, under one `run_id`, with different contents.** Found
  2026-08-03 while fixing the backfill's evidence loss. `20260802T082954Z-TARS-1351` is in both
  `~/.harness/telemetry/log/webtarsthree/` (its `sink` field says so — that config predates the
  move) and `~/Desktop/Repos/alfred-telemetry/log/webtarsthree/`. The copies are **not**
  byte-identical: the old one lacks `cost.vendor_by_model` and `provenance` entirely, because it
  was written before either existed. Anything aggregating across both directories double-counts
  that run and reads its cost from the pre-fix ledger. Not reconciled here, deliberately — the
  old sink holds **1732** records on a completely different schema (`run_id`/`phases`/
  `skill_metrics`, the harness-core shape) against this sink's nine, so merging them is its own
  piece of work and not a footnote to Phase D. What is fixed is that the `sink` field now
  survives a rebuild, so which sink a record was routed to is answerable at all.
- **The record is per-invocation, not per-terminal-session.** A fresh session id is
  generated on every `alfred work`, so two back-to-back runs are two transcripts and two
  records. That is correct for cost-per-ticket comparison and wrong for *"this epic cost
  $X across N tickets,"* which would need a separate step keyed on the loop's own identity.

The rescued Q&A that most of §4–§6 draws on is at
`alfred/eval/archive/2026-08-verdict/qa-log.md`, kept because it was previously reachable
only from `/tmp`.
