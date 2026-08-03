# Eval-readiness scorecard #1 — 2026-07-30

**Produced by:** Claude Opus 5 (`claude-opus-5`), reading the repo at commit `99bdac3`,
branch `alfred/foundation`.
**Checklist version:** `docs/EVAL-READINESS.md` as of this commit (adapted from
`~/Downloads/harness-eval-readiness-audit.md`, Opus 5, 2026-07-30).
**Scope:** `alfred/` only. `harness-core` is untouched evidence and is not audited here.
**Repo state:** 12 `lib/*.mjs`, 21 test files / **434 alfred tests**, 11 top-level docs
(19 `.md` under `docs/` including `exp2-evidence/`), 2 fixtures, 4 `eval/` scripts. No `bin/`, no `lib/router.mjs`, no `SKILL.md`. (The 1008 repo-wide
figure and the ~93 s suite time are carried from an earlier run in this session and were
**not** re-measured for this scorecard; the 434 was re-counted from disk.)
**Diagnostic only.** Nothing was fixed during this pass.

---

## 0. What is being scored, and the one thing that most limits it

**Alfred has never run.** Arms A (bare `claude -p`) and B (`harness-core`) have run and
are scored; arm C is Alfred and does not yet exist as an invokable thing
(`EXPERIMENT-2-RESULTS.md:8` — *"Arm C (Alfred) could not run — no `bin/alfred`, worker,
gate, or config loader exists yet"*; the config loader and gate now exist, the entrypoint
does not).

That single fact determines most verdicts below. Whole sections describe measurement of
runs, and Alfred has produced zero runs of its own. Where an item cannot be scored for
that reason it is `N/A-NOT-YET` with the milestone named — **not** PASS, and **not**
N/A-BY-DESIGN.

**Counting note.** The 434 figure requires `LC_ALL=C grep -a`. Plain `grep` reports **0**
matches in `test/gate.test.mjs` and exits 1, because that file contains `\x00`/`\x01`
delimiters at `test/gate.test.mjs:833`. Plain grep therefore yields 406 and a non-zero
exit that reads as "clean" — silently omitting the 28 tests of the module that *is* the
thesis. This was hit during this pass and is now written into the checklist's own
"How to run it."

---

## 1. Foundations

| item | verdict | evidence |
|---|---|---|
| Eval corpus exists at all | **PARTIAL** | Two fixtures with machine-readable expected outcomes: `fixtures/sandbox-a/manifest.json` (9,920 bytes, 6 traps) and `fixtures/sandbox-b/manifest.json` (22,197 bytes, 6 traps, keys include `ground_truth`, `the_correct_outcome`, `arm_c_predictions`, `expected_shas`). The shared tree is 56 KB across 14 files. That is a corpus of **two cases**. Neither is versioned — see §4. |
| Corpus derives from real runs | **PASS** | `SANDBOX.md` §2 Mitigation 1 requires every trap *shape* to cite a real instance, and its six-row table does: wrong file count ← 1339 "claimed 148, was 144"; false premise ← 1339 "master is clean at 0 errors — it had 5"; looks-stale-but-load-bearing ← `noStaticElementInteractions`; unverifiable AC ← 1339 AC#2; unsatisfiable AC ← 1339 AC#1; unstated either/or ← **1272 verbatim, lifted from wording a stakeholder wrote**. This is the strongest single item in the audit. Caveat kept honest: the *shapes* derive from real runs; the *content* is synthetic by design (`SANDBOX.md` §1 — traps are "planted, so coverage is deliberate"). |
| Evals assert on outcomes, not mechanism | **PASS** | `lib/score.mjs:6` — four of sandbox-a's traps are settled *"by a command, not by my judgment... The point is that the person holding the thesis does not get to decide whether the load-bearing guard survived."* `lib/gate.mjs` resolves each AC by **running the command itself** and deciding on exit code (`test/gate.test.mjs:99`), explicitly ignoring what the worker claimed. No eval in `test/` asserts "phase X emitted artifact Y" — there are no phases to assert about. |
| Grader hierarchy respected | **PASS** | Programmatic: `lib/gate.mjs`, `lib/score.mjs`, all 434 tests. LLM-judge: **none in the runtime** — `test/gate.test.mjs:293` asserts the gate has no model call and `:304` asserts it imports nothing from a network module list. Human-labeled: Axis 1 of Experiment 2 only, and it is declared as such under §9 *"What this does not settle"* (`EXPERIMENT-2-RESULTS.md:330`). No LLM judge grades anything a script could settle. |
| Held-out set exists | **FAIL** | No artifact found. `grep -riI "held-out\|heldout\|hold-out"` over `alfred/` returns nothing. Both fixtures are self-authored by the same party holding the thesis. The mitigation named in `SANDBOX.md` §2 Mitigation 3 is `tars-1339` — *"which I did not author"* — but it is a **future** requirement, not an existing held-out set. Reported scores are tuning-contaminated; sandbox-b is only partially so (authored *after* M0–M4 froze, `manifest.json.authored_after: 7da5718`). |
| Tiering for speed | **FAIL** | `package.json` holds exactly one script: `{"test": "node --test"}`. No smoke/full split; `grep -i "smoke\|nightly"` returns nothing. Full suite ≈ 93 s, which is *currently* tolerable — this fails on absence of the split, not on slowness, and it will bite when a live-run tier exists. |
| Every eval independently runnable + machine-readable | **PARTIAL, and worse than it looks** | Runnable: `lib/fixture.mjs:287` gates a standalone CLI on `process.argv[1]`; `eval/armcost.mjs`, `eval/sandbox-alias.mjs`, `eval/watch.mjs` are invokable. Machine-readable *inputs*: `lib/report.mjs` and `lib/score.mjs` return structured objects, manifests are JSON. **Machine-readable results: none.** `docs/exp2-evidence/` contains `armA.json` and `armB.json`, which **look** like result records and are not — both are 8-field fixture *provisioning* records (`slug`, `root`, `repo`, `origin`, `branch`, `head`, `tree`), byte-identical apart from paths, carrying **no score, cost, or verdict**. Every actual result lives in hand-written prose (`EXPERIMENT-2-RESULTS.md`, 300+ lines, headline in a table a human must read). A file named `armA.json` that contains no arm-A result is its own small drift hazard — noted for #47. |

## 2. Contract & invariant coverage

| item | verdict | evidence |
|---|---|---|
| Handoff schema conformance at every phase boundary | **N/A-BY-DESIGN → re-scored on Alfred's real boundaries: PARTIAL** | Alfred has no phase boundaries; that is the finding the project rests on (`PLAN.md:1059`, 4.7x on n=1). Re-scored per the checklist's adaptation, on the four boundaries Alfred does have: **(a) config file → `loadConfig`: PASS** — `lib/config.mjs:50-88` is a declared schema with `required`/`oneOf` and recursive validation (`:94`), 26 tests. **(b) transcript → `report`: PASS** — 20 tests, and absence is distinguished from unreadability (`lib/report.mjs:45`, `:143-144`). **(c) worker output → `gate`: PARTIAL** — the gate validates the AC map it is handed (`mapping_implausible` rule) but nothing produces that map yet, so the producer side is unasserted. **(d) report → sink: UNVERIFIED here** — `sink` is carried on the record (`lib/report.mjs:181`, `:316`) but the write path is `harness-core`'s `syncRun`, outside this audit's scope. |
| Repo-agnosticism (≥3 dissimilar fixtures) | **FAIL** | Two fixtures, and they are **not dissimilar** — `fixtures/sandbox-b/manifest.json.files_from: "sandbox-a"`, i.e. one tree, JavaScript, `npm test`, 56 KB, shared by reference (`sandbox-b/` carries no `files/` at all). The choice is deliberate and reasoned (`PLAN.md:1164-1170`: a copy per slug *"fails silently — edit sandbox-a's `sms.js`, sandbox-b's copy does not move, both ground-truth suites stay green"*), and `test/fixture-shared-tree.test.mjs` (13 tests) enforces it. Sound for comparing arms; does **nothing** for repo-agnosticism, which is currently **assumed**. |
| Heterogeneous intake equivalence | **PARTIAL / N/A-NOT-YET** | `lib/config.mjs:44` — `SOURCE_KINDS = ['jira', 'github']`, enforced at `:57` as `oneOf`. Two of the three intake shapes are *declared*; "raw prompt" is not among them despite the foundational goal naming "a ticket or prompt from any context." No equivalence assertion exists because no intake code exists (that is M6). Flagging the raw-prompt gap now: it is a **stated requirement absent from the schema**, which is cheaper to fix before the schema has users. |
| Audit logging completeness | **PASS** | The best-covered invariant, as it should be — telemetry is the product. `lib/gaps.mjs:17-25` freezes 7 codes so a structural hole is *named*, never zero-filled: `subagents-unreadable`, `session-id-absent`, `run-window-guessed`, `no-usable-usage`, `model-id-disagreement`, `model-id-absent`, `direct-api-calls-untracked`. `lib/gaps.mjs:32` rejects any code outside that set (`if (!Object.hasOwn(GAP_CODES, code))`), so a new hole cannot be logged under an invented name. `lib/report.mjs` notes the gap rather than dropping subagent spend. Fails loudly, as required. |
| Escalation behavior + a case forcing it | **PARTIAL** | Adapted from `NEEDS_DECISION` to Alfred's blocked policy. `lib/blocked.mjs` freezes 4 reasons (`unsatisfiable-ac`, `ambiguous-requirement`, `missing-access`, `verification-failed`) and rejects unrecognised ones; 23 tests. A **fixture** forcing the condition exists — sandbox-b's shape is `should-be-pushed-back-on`. What is missing is the run: no case has ever driven Alfred into the blocked path, because Alfred has not run. |
| Verifiers never capped | **PASS-BY-DESIGN, with a live sub-question: UNVERIFIED** | Structural: the gate is a pure function with no token budget (`test/gate.test.mjs:263` *"the gate verdict is a pure function of its inputs — same inputs, same verdict"*, `:293` *"the gate has no model call and no network access"*). Re-scored per the checklist's adaptation to the question that *can* fail — **is the gate reachable on every exit path, including a killed worker?** No artifact found either way, and the failure is demonstrated: `EXPERIMENT-2-RESULTS.md:241-243` — arm B's implement record reads `status=attempted`, `phases: []`, `wall_ms: null` *"despite four committed units, because SIGTERM landed before finalization,"* with the lesson stated as **"A phase's own record cannot be trusted as evidence it did nothing."** Confirmed in the artifact itself (`docs/exp2-evidence/armB-implement-record.json`: `phases: []`, `wall_ms: null`, `ended_at: null`, `branch: null`, alongside a real `run_id` and `started_at`). Alfred's gate runs in a separate process *after* the worker, which is the right shape, but nothing asserts it survives a worker kill. **This belongs in #44's runner design.** |
| Reasoning-budget assignment asserted as applied | **PARTIAL** | `lib/models.mjs:107` freezes SEATS with per-seat ceilings, validated **at import** (`:121` loops every seat), so a bad seat fails immediately rather than at 3am; `OUTPUT_CEILINGS` at `:27` throws on an unknown model rather than guessing (`:59`). The escalation policy is stated in the code itself (`:116` — *"Explicit escalation only, one logged event with a reason"*). Assignment is asserted; **application is not** — nothing yet passes these to a live `--agents` payload (M5/M6). |

## 3. Grader quality — scored against the *human* judge, per the checklist

| item | verdict | evidence |
|---|---|---|
| LLM judge validated against human labels | **N/A-BY-DESIGN** | No LLM judge exists in the runtime — `test/gate.test.mjs:293` asserts it, and `:304` enforces it structurally: *"gate.mjs imports ${mod} — the gate must not reach the network"*. The design deliberately replaced one; `lib/score.mjs:13-15` names the failure mode being escaped (*"Averaging is how harness-core's verifier produced a false `verified`"*). |
| Judges emit discrete labels, not 1–10 scores | **PASS** | The gate returns `{pass, findings[], unverified[]}` — `lib/gate.mjs:354`: *"A conjunction over findings, never a score, and deliberately NOT over `unverified`."* `lib/score.mjs:12-15` forbids averaging outright, naming the failure it prevents (*"Averaging is how harness-core's verifier produced a false `verified`"*). Axis 1 is a 3-point scale (0/1/2), discrete. Nothing in the repo produces a 1–10 scalar. |
| Rubrics concrete and few-shot'd with an example per grade | **PARTIAL** | `EXPERIMENT-2.md` §2 froze both axis scales and per-trap predictions before either arm ran, and the freeze held (`EXPERIMENT-2-RESULTS.md:4-5`). But there is **no worked example per grade point** — no "here is what a 1 looks like." With n=1 per arm and a 3-point scale, the difference between a 1 and a 2 currently rests on one person's reading. |
| Pairwise comparison where absolute quality is ill-defined | **PASS** | The whole experiment is pairwise on a shared fixture: same ticket, same tree, same `gh` shim for both arms (`EXPERIMENT-2.md:479` — *"the shim is identical for both arms, so it cannot favour either"*). |
| Over-specification smell | **PASS** | Checked for evals that would break on a reworded-but-correct output. The gate keys on exit codes and file paths, not output strings. `test/gate.test.mjs:51-52` injects a runner keyed by command so *"no test depends on what an npm script happens to do on this machine"*, and `:42-43` builds the config inline *"so a gate test cannot start failing because of a config-schema change."* `lib/score.mjs:37` uses one source regex (`INLINE_LOOP`, matching `for (let attempt`) — rewording-sensitive, but it targets the specific construct AC1 asks to remove, which is the legitimate use. |
| **Judge-holds-a-thesis disclosure** *(the item that replaces item 1)* | **PASS** | Declared in both docs, before and after: `EXPERIMENT-2.md:591` *"Axis 1 is scored by me, and I have a thesis"*, and `EXPERIMENT-2-RESULTS.md:330` *"Axis 1 is scored by me, and I hold a thesis."* The defense is pre-registration, and it worked: **four of nine per-trap predictions were wrong** and are recorded as wrong rather than reinterpreted. A judge whose errors are on the record is a partly-validated judge. |

## 4. Statistical hygiene — the weakest section, and the most urgent

| item | verdict | evidence |
|---|---|---|
| Run-to-run variance known / noise floor | **FAIL** | No artifact found. No suite has ever been run twice against an unchanged system. |
| n > 1 per case | **FAIL** | n=1 everywhere. `LC_ALL=C grep -rn "n=1" docs/*.md` returns **11 hits across 6 files**: `EXPERIMENT-2.md` ×3, `PLAN.md` ×3, `HANDOFF.md` ×2, `DIAGRAMS.md` ×1, `SANDBOX.md` ×1, and `EVAL-READINESS.md` ×1 (the checklist written in this same pass, so 10 predate it). The admission is honest and the consequence pre-committed at `EXPERIMENT-2.md:594-596`: *"A single run per arm captures no variance. If the two arms land within one point on Axis 1, that gap is not a result, and I should say so rather than break the tie in my own favor."* Scope note: the strongest statement, `EXPERIMENT-2.md:8` — *"That is n=1 on the simplest ticket shape there is"* — makes n=1 and thin-coverage a **single** admission, so §4 and §6 here are not independent failures. |
| Sample size adequate for claimed effects | **PARTIAL** | The two headline effects are enormous — **30x cost** ($0.617 vs $18.483) and **4.7x tokens** — and an effect that large is unlikely to be pure noise, so these do not fail on the <5%-delta rule. But the *decision* Alfred is being built to inform is a cost-acceptability judgment on arm C, where a plausible result is single-digit dollars against arm B's $18.48. **A 2x-ish delta against an unknown noise floor is exactly the decision this item forbids.** This is the argument for n=3, and it is the open question in #41. |
| Comparisons paired | **PASS** | Same fixture, same tree, same shim, both arms; per-trap diff table rather than average-vs-average (`EXPERIMENT-2-RESULTS.md` per-trap section, `EXPERIMENT-2.md:361`). |
| Suite versioned; results tagged (suite version, model, config, date) | **FAIL** | `LC_ALL=C grep -n "suite_version\|\"version\""` over both manifests **exits 1 — no field exists.** `EXPERIMENT-2-RESULTS.md:1-11` carries **no model id, no config sha, and no run date**; its header names the arms and the caveat, nothing about the environment. The fixtures do carry `authored`, `authored_after: 7da5718`, and `expected_shas` — real provenance, but on the *fixture*, not on the *result*. Consequence: arm A's $0.617 was measured on **sonnet-4-6**, seats moved to sonnet-5 the same day (#38), and **nothing in the results file records which model produced which number.** Task #42; partly unrecoverable, because stamping retroactively leaves the history ambiguous about when the stamp became true. |
| Cases grow additively; written no-edit policy | **FAIL** | No artifact found. sandbox-b was *added* rather than sandbox-a edited, which is the right instinct and is even justified in writing (`fixtures/sandbox-b/manifest.json.why_a_second_fixture_exists` — M4's gate tests and sandbox-a's traps landed in the same commit `e86cd48`). But instinct is not policy: nothing forbids a future edit to sandbox-a's manifest, and no test would notice. |

## 5. Agent/trajectory specifics — the strongest fit

| item | verdict | evidence |
|---|---|---|
| End-state assertions on the environment | **PASS** | `lib/score.mjs` runs real commands against a real provisioned tree and reads exit codes; `lib/gate.mjs` reads the repo and runs the declared checks. `lib/score.mjs:16-18` names the trap avoided: *"Doing nothing must not pass. An untouched sandbox-a has a green test suite. A scorer keyed on 'tests pass' would rank the null arm top."* Nothing judges the transcript. |
| Trajectory metrics captured | **PARTIAL** | Captured: subagent tree with `depth` preserved so nested delegation stays attributable, per-subagent `wall_ms`, `active_ms`, `by_model`, `cost_usd`, `lines_parsed`, `usable_usage_records`, `peak_context`. **Not captured:** step count, tool-selection accuracy, revision-loop iterations, retries, stalls. `test/fixtures/iterations.jsonl` exists alongside `arm0-transcript.jsonl`, `garbage.jsonl`, `unknown-model.jsonl`, `split-blocks.jsonl` and a `session-with-subagents/` tree — real groundwork for parsing, not yet a metric. Retries/stalls are the ones that matter for the tail (§6). |
| Cost + latency first-class | **PASS** | Headline table leads with cost and wall (`EXPERIMENT-2-RESULTS.md:19-20`), with an 8-row per-seat breakdown at `:223-234` that produced the sharpest cost finding in the project — `:237` **"$12.10 of $18.48 — 65% — is two opus seats in one phase"**, the phase that shipped 6 regressions, against verifiers at $5.03/27% which *"bought the trap-2 catch and the trap-6 upgrade."* Also records that the $25 experiment ceiling *"held by luck, not by design."* `lib/report.mjs` treats `cost` and `wall_ms` as record fields, not addenda. |
| Stall detection itself evaluated | **FAIL** | No artifact found. `grep -i "resum\|interrupt"` over `lib/` returns one hit, and it is about a *human* reply resuming a blocked item (`lib/blocked.mjs:41`), not a stalled agent. Two demonstrations that the failure mode is real and consequential: arm B's SIGTERM'd record (`phases: []`, `wall_ms: null`), and `EXPERIMENT-2-RESULTS.md:301-302` §2.7 — *"the watchdog died with a session and its wall clock restarted from zero, so a 90-minute cap could not fire on a 40-minute-old arm."* A stall detector that resets its own clock is the exact thing this item asks us to test. |
| Per-tier capability mapping | **FAIL** | Routing is asserted (`PLAN.md:940` seat table; `lib/models.mjs:107-119` SEATS) but **grounded in intuition, not measured cliffs**. No per-tier eval exists. `lib/models.mjs:116` documents the *policy* ("explicit escalation only, one logged event with a reason") — a policy, not a measurement. The `scan` seat is deliberately left on haiku-4-5 at 64k with no measurement behind that choice. |
| *Alfred addition:* every metric ships its denominator | **PARTIAL** | The lesson is recorded (`EXPERIMENT-2-RESULTS.md:303-306` — the watchdog priced **$1.072 against an $18 cap while $16.03 had been spent**, a factor of ~15; arm B would have needed **~$270** for the watchdog to print $18, so enforcement landed ~40 min and ~$14 late) and the root cause named: `transcriptsFor` listed only the top level, and every phase driver's transcript is one level down in `<session-id>/subagents/`. The derived control is stated at `:318` — *"`$1.072` is unfalsifiable. `$1.072 across 1 transcript` invites 'one? for four phases?'"* But **no test asserts a watchdog reads the full denominator**: `eval/watch.mjs` is eval infrastructure with no test file. A repeat is currently possible. |
| *Alfred addition:* a failed read never reports $0 | **PASS** | `lib/report.mjs` failure branch sets `total_usd: null` with the reason inline: *"Not $0.00. The run happened and spent money; we failed to read it. A zero here would be plotted as a free run, and every spend threshold downstream would silently stop protecting anything."* Asserted by M2's arm-0 anchor test. |

## 6. Tail and failure-path coverage

| item | verdict | evidence |
|---|---|---|
| Seeded failure fixtures (7 shapes) | **FAIL** | 1 of 7 present. **Ambiguous/underspecified ticket: PASS** — both fixtures, and sandbox-b's whole shape is `should-be-pushed-back-on`. **Absent, no artifact found:** repo with failing tests; malformed/partial input; unfamiliar repo layout (see §2 repo-agnosticism — both fixtures share one tree); deliberately stalled agent; mid-run interruption/resumability. |
| Tail reported as a separate arm | **N/A-NOT-YET** | No tail arm exists to report. Task #45. |
| Refusal / escalation / "insufficient information" cases | **PASS** | The best-covered part of this section, and it is where arm A scored its **2** — `EXPERIMENT-2-RESULTS.md:72`: *"$0.617 bought a design review and zero files. Arm A did not fail to work — it stopped"* to ask a human, correctly, in a context where nobody could answer. `lib/blocked.mjs` implements the policy with 4 frozen reasons; sandbox-b's correct outcome is a push-back. This is Alfred's declared strong suit and it has fixture coverage. |

**The section's own argument, applied to Alfred.** *(§6 continued)* Alfred's central claim is that a
deterministic gate beats an LLM verifier at lower cost. On a clean run the gate finds
nothing and looks like pure overhead — precisely the shape this section warns gets cut.
**The gate is currently justified almost entirely on happy-path reasoning**, because 6 of
7 failure fixtures do not exist. Worse, the founding 4.7x measurement was taken on *"the
simplest ticket shape there is"* (`EXPERIMENT-2.md:8`) — the tail is where that number is
least tested and where four phases would plausibly do best. **If Alfred's thesis is
wrong, the tail is where it is wrong, and we currently cannot see there.**

## 7. Ablation readiness

| item | verdict | evidence |
|---|---|---|
| **A null baseline exists** | **PASS** | The audit's designated highest-priority gap, and we have it. Arm A **is** the null baseline — a bare `claude -p`, one prompt, no harness, on the same fixture, already run and scored: **$0.617 / ~2 min / Axis 1 = 2 / 0 files** (`EXPERIMENT-2-RESULTS.md:19-23`). Recorded with the honest caveat that a win for arm A does not license "Alfred beat harness-core" (`:11`). |
| Layers independently toggleable via config | **PARTIAL** | Cleanly toggleable from `config.mjs`'s schema (`lib/config.mjs:50-88`): `verify` commands, `off_limits`, `delivery.mode`, `delivery.never_merge`, `models` (incl. per-agent seats), `telemetry.sink`, `loop.poll_interval_minutes`, `base.rules`. **Entangled / not toggleable without a code edit:** the gate itself (no on/off flag — running it is unconditional in the design), `gaps[]` emission, the report's parent/subagent join, and the blocked policy. For an *additive* ladder that is largely fine — you add layers by turning them on — but "score the run with and without the gate" currently requires editing code. |
| Additive ladder feasible | **PARTIAL** | Rungs 1 and 2 exist: **baseline** = arm A (run), **+schemas** ≈ arm B's contribution, already isolated as a finding (*"Carry the schema, not the orchestration"* — every arm B advantage traced to a schema, not to having four phases). Rungs 3+ (**+gate**, **+telemetry**, **+model switching**) are not runnable because no rung includes Alfred yet. Task #46. |
| One variable per run, everything else pinned | **PARTIAL** | Pinned and asserted: fixture tree (both arms recorded `head fa052265…` / `tree a5b0d41e…` — verified byte-identical in `armA.json` and `armB.json`), the `gh` shim (`EXPERIMENT-2.md:479` — *"the shim is identical for both arms, so it cannot favour either"*), the price table (one table over both arms), commit identity (`commit_plan` fixes author/committer/gpgsign/autocrlf). **Not pinned: the model.** Arm A ran on sonnet-4-6; seats are now sonnet-5. That is a second variable moving between arm A and arm C, and it is currently **undeclared** — task #43. |
| Cost reported alongside quality | **PASS** | Same table, same row group (`EXPERIMENT-2-RESULTS.md:19-23`). The 30x is stated as prominently as the Axis 1 scores. |
| Results dated + stamped with the model | **FAIL** | Same failure as §4's stamping item, from the other direction: `EXPERIMENT-2-RESULTS.md:1-11` has no model stamp, no date, no config sha. The fixtures are dated; the results are not. |

## 8. Model-change protocol

| item | verdict | evidence |
|---|---|---|
| Protocol written down in the repo | **FAIL** | No artifact found. `grep -i "model release\|model swap\|new model ships\|freeze the suite"` over `alfred/docs/` returns nothing. Task #43. |

**Scored against the protocol's six steps, as of today:**

1. **Freeze the suite on a swap** — **VIOLATED, and it already happened.** Commit
   `752f3b0` ("seats to sonnet-5/opus-5, and the cache column I priced from an
   assumption") changed the model *and* `prices.json`, the shared normalizer,
   `OUTPUT_CEILINGS`, and 278 lines of the price/model tests in **one commit** — 5 files,
   +402/−56. The suite was not the control variable; it moved with the model. Whether the
   `+278` test lines are a fix or a re-fit is now unanswerable from the history alone,
   which is precisely what freezing prevents.
2. **Read new failure shapes** — not done. No post-`752f3b0` run exists to read.
3. **Handle saturation** — no saturated cases yet (the corpus is 2 cases old).
4. **Re-calibrate routing** — **not done, and the ceilings moved 64k → 128k**, which is
   exactly the kind of change that should trigger a threshold review.
5. **Re-ablate** — **not done, and this is the item that stings.** By this rule, *"a phase
   worth +12 points on a weaker model may be worth +1 now at identical cost."* Alfred's
   founding 4.7x/4.6x measurement was taken on **sonnet-4-6**. Under our own adopted
   checklist, that finding is **provisional pending re-ablation**, not settled. Recording
   it here so no future scorecard can treat it as bedrock.
6. **Then add new cases** — n/a, nothing to add from a run that hasn't happened.

## 9. Staleness & periodic refresh

| item | verdict | evidence |
|---|---|---|
| Model-quirk workarounds | **PASS (nothing found)** | Searched for verbose decomposition, redundant reminders, defensive re-statements, output-format nagging. Alfred has **no prompt files** to bloat — the gate is a function and there is no worker prompt yet. The design's own framing is the contrast: Alfred's `while` loop against `harness-loop-core`'s ~3,000-word SKILL.md, whose cost is *"model tokens spent simulating a `while` loop."* **This item is currently PASS for lack of a surface, not for discipline** — re-score it the moment a worker prompt exists, which is M6. |
| Saturated evals inflating the headline | **PASS** | 4-day-old corpus; nothing saturated. |
| Corpus age | **PASS** | 100% of cases from the last 90 days (sandbox-a 2026-07-29, sandbox-b 2026-07-30). The inverse risk applies instead: a corpus this young reflects *one* week's understanding of the failure modes. |
| Invariants no longer matching reality | **PARTIAL** | One live instance, and it is **not** the one I expected — see the correction under the next row. `HANDOFF.md:221-235` still lists five items under *"Open — do not decide unilaterally"*, of which **four are decided**: AC→command mapping (`PLAN.md:1080` DECIDED hybrid), tokens-collect port (`:1102` DECIDED), fixture-in-git (`:1114` DECIDED), codename (`:1182` DECIDED: Alfred), unsatisfiable AC (`:1184` DECIDED). A reader starting from HANDOFF would re-open four settled decisions. Otherwise the enforced invariants hold: `test/isolation.test.mjs` (**6 tests**, not 12 — recounted) mechanically enforces the no-`harness-core`-import rule that previously lived only in prose (`:7` — *"That rule lived in prose (PERSONA.md §8, SANDBOX.md §6) until a reader asked the question"*), correctly permitting `eval/` to reach it *"because measuring the thing you are replacing requires reaching it"* (`:14`, `:117`). |
| Dead phases/layers | **N/A-NOT-YET** | Nothing has run; nothing can be shown non-load-bearing yet. Re-score after arm C. |
| Prompt bloat | **N/A-BY-DESIGN** | No prompts. |
| Dependency drift | **PASS** | Node built-ins only; `package.json` declares no dependencies. One drift risk noted and already handled: the gateway's own capability listing is unreliable (bare `haiku-4-5` claims `max_tokens 16384` / no caching, but accepted 30000 and read a cache entry), and the repo deliberately does not treat that listing as ground truth. |
| Duplicated docs at two paths *(found during this pass)* | **PARTIAL** | `docs/exp2-armA-score.md` and `docs/exp2-evidence/armA-score.md` are **byte-identical** (4,399 bytes, `diff -q` clean); likewise `docs/exp2-armB-intake-score.md` and `docs/exp2-evidence/armB-intake-score.md` (3,300 bytes). Two copies of a score sheet with nothing marking either as canonical is a drift hazard of exactly the §9 shape: edit one and the other silently disagrees. No test notices. Cheap fix, deliberately **not** made in this pass — added to #47. **RESOLVED 2026-07-30 by #49 (`4bfb4a4`+1):** the two top-level strays were deleted (git shows they were added *first*, at `a940b86`, then copied into `exp2-evidence/` at `c6bc1c5`; `armB-plan-score.md` exists only in the evidence dir, which settles that dir as canonical). The finding above is left as written — this scorecard is a snapshot at `99bdac3` and the paths it names were real then. **What the fix found that this row did not:** nothing verified that a `MEASUREMENTS.source` citation resolves, and `lib/model-changes.mjs:141` cited one of the deleted paths. The duplicate was a drift hazard; the dangling citation was a drift *already in flight*. Now guarded by a test. |
| **Docs asserting their own freshness** *(Alfred addition)* | **PARTIAL — fired twice in four days, and a third time during this pass** | Instance 1, fixed at `99bdac3`: `PLAN.md` §6's seat table said of itself *"the numbers below are transcribed from the code, not the reverse"* — and three rows (worker, fallback, `reason`) read sonnet-4-6/64k for a full day after #38 moved SEATS to sonnet-5/128k. The sentence asserting freshness is what made the staleness invisible. Instance 2: `HANDOFF.md`'s four-stale-decisions list above. **Correction to a claim I carried into this pass:** I had recorded §8.3 as "standing open on a 6.7 MB figure belonging to a different fixture." It is not open — `PLAN.md:1114` reads DECIDED, and `:1154-1161` *diagnoses* the 6.7 MB figure explicitly (*"belongs to the TARS-1339 clone, a separate fixture, and carrying it into this row made a cheap decision look costly"*). The figure survives only where it is correct: `SANDBOX.md:18` and `HANDOFF.md:86` describe `tars-1339`, which genuinely is 6.7 MB. So instance 3 is **this scorecard's own draft**, caught by verifying rather than by trusting a note. **Three drift events in a four-day-old project — one of them mine, in the pass that exists to catch them — is the strongest evidence here that the checklist earns its place rather than being ceremony.** |

**Cadence.** The checklist's default table is **aspirational, not running.** Today "every
change" means `npm test` (~93 s, 1008 tests) and nothing else in the table happens.
Recommended near-term cadence, sized to a project this young:

| Cadence | Action | Status |
|---|---|---|
| Every commit | `npm test` | **live** |
| Before any live-spend run | Re-read this scorecard's §4 and §7; confirm caps pre-registered | not yet |
| After each experiment arm | Stamp the result (suite version, model, config, date) | **blocked on #42** |
| Every model/seat change | Section 8 protocol | **blocked on #43** |
| After M5–M7 | Re-run this checklist; diff against this scorecard | scheduled |

## 10. Anti-patterns — instances by path

| anti-pattern | present? | detail |
|---|---|---|
| Evals measuring the harness rather than the outcome | **no** | The gate runs commands and reads exit codes; `score.mjs` runs real commands on a real tree. |
| LLM judges grading what a script could check | **no** | No LLM judge exists. `lib/score.mjs:6-7` is explicitly the command that replaces one — *"sandbox-a's manifest says of four traps that they are settled 'by a command, not by my judgment' — so this module is that command."* |
| Unvalidated judges producing headline numbers | **YES, disclosed** | Axis 1 is a single human holding a thesis (`EXPERIMENT-2-RESULTS.md:330`, under §9 *"What this does not settle"*). Mitigated by pre-registration and by 4 of 9 predictions being recorded as wrong; **not** mitigated to the point where an Axis 1 delta of 1 point means anything (`EXPERIMENT-2.md:594-596` says so). |
| Happy-path-only suite used to justify cutting failure-path machinery | **YES, latent** | 6 of 7 failure fixtures absent (§6). The exposure is not that we cut something — it is that Alfred's gate is currently justified without tail evidence, which is the exact reasoning error this section names. Task #45. |
| Scores compared across suite versions as if the same measurement | **YES, imminent** | No suite version exists (§4). Arm A ran on sonnet-4-6, arm C will run on sonnet-5, and nothing in the results file records that. Comparing $0.617 to arm C's figure **already crosses an unrecorded boundary.** Tasks #42, #43. |
| Decisions on deltas smaller than the noise floor | **YES, imminent** | The noise floor is unknown (§4) and the pending decision is arm C's cost acceptability. This is exactly what #41 exists to prevent — and why n=1 vs n=3 must be chosen *before* the run. |
| Iterating against the set used to report performance | **YES, partially mitigated** | Both fixtures are self-authored. sandbox-b reduces it (authored after M0–M4 froze; `authored_after: 7da5718`). Not eliminated: no held-out set exists; `tars-1339` remains a promise (`SANDBOX.md:72-73` — *"Before Alfred ships anything, it must also clear `tars-1339`, which I did not author."*). |
| Layers that cannot be disabled without a code edit | **YES** | The gate, `gaps[]`, the report join, the blocked policy (§7). Task #46. |
| "It seems better" substituting for a measured delta | **no** | The project's habit runs the other way — the 4.7x killed a design the author preferred, and `EXPERIMENT-2-RESULTS.md` records four wrong predictions as wrong. |
| *Alfred addition:* green suite treated as behavioral equivalence | **no — and it is the reusable asset** | Arm B's committed diff carried **6 regressions** while the repo suite passed **21/21 in both states**, because it never exercised a null body — `EXPERIMENT-2-RESULTS.md:181` (*"32 scenarios, 6 divergences — NOT EQUIVALENT"* against the committed state) and `:200` (*"The repo suite passes 21/21 in both states"*). The differential oracle at `docs/exp2-evidence/armB-differential-oracle.mjs` (10 KB) is the artifact. The derived rule — an AC saying "no behavior changes" routes to a differential check, never to `npm test` — is **not yet encoded in `gate.mjs`**, so record this as a rule the repo *knows* and does not yet *enforce*. |
| *Alfred addition:* metric reported without its denominator | **YES, unenforced** | §2.8's watchdog — a cap that read 1/15th of the spend. Lesson recorded at `EXPERIMENT-2-RESULTS.md:318`, no test asserts it (§5). |

---

## Top gaps, ranked by leverage

Ranked by how much each limits our ability to answer the question the whole project turns
on: **"is this over-engineered for the current model?"**

1. **No noise floor (§4).** Ranked first because it is the only gap that is
   **unrecoverable by later work**: variance cannot be retrofitted onto a run already
   taken. Everything downstream — cost acceptability, the ablation ladder, any "layer X is
   worth it" claim — is a delta, and a delta against an unknown floor is not a
   measurement. The 30x is large enough to survive; the arm C comparison probably is not.
2. **No result stamping / no suite version (§4, §7).** Second because it is *also*
   unrecoverable in a subtler way: stamping retroactively leaves the history ambiguous
   about when the stamp became true. Arm A's $0.617 sits in a file with no model id while
   the seats have already moved beneath it.
3. **6 of 7 failure fixtures absent (§6).** Third because it is the gap most likely to
   make us **cut the right thing for the wrong reason.** The gate looks like overhead on
   clean runs by construction; without tail evidence, a cost-driven decision to drop it
   would be unfalsifiable at the moment it is made.
4. **No model-change protocol (§8), and one swap already happened un-protocolled.**
   Fourth because it puts an expiry date on our founding measurement. If the 4.7x is a
   sonnet-4-6 artifact, the project's premise needs re-testing, not defending.
5. **No held-out set (§1) / repo-agnosticism assumed (§2).** Fifth: both fixtures are
   self-authored and share one tree, so a PASS on either is weak evidence by our own
   pre-commitment. `tars-1339` is the named remedy and remains unrun.
6. **Layers not independently toggleable (§7).** Sixth — real, but it blocks the *second*
   experiment, not the first, and an additive ladder needs less of it than a subtractive
   one would.
7. **No per-tier capability mapping (§5).** Seventh: the routing table is intuition, and
   misrouting is a known cost multiplier (65% of arm B's spend was two opus seats). Lower
   ranked only because it is cheap to measure later and expensive to measure now.

## Minimum viable eval suite

Coverage is thin (2 cases, 1 of 7 failure shapes). The smallest set that would give a real
regression net, in build order:

1. **The two fixtures we have, versioned and stamped** — `sandbox-a` (ambiguous),
   `sandbox-b` (should-be-pushed-back-on). Grader: **programmatic** (`score.mjs` +
   `gate.mjs`) for Axis 2, **human pre-registered** for Axis 1. First because the cheapest
   real improvement is making the cases we already have comparable across runs.
2. **A repo-with-failing-tests fixture.** Grader: **programmatic** (exit code). Second
   because it is the failure shape most likely to occur in production and the cheapest to
   author — it is sandbox-a with one test broken. It also directly tests the rule the repo
   knows and does not enforce: an AC saying "no behavior changes" must not route to
   `npm test`.
3. **A dissimilar-repo fixture** — different language, layout, and test runner (Python +
   pytest is the obvious choice). Grader: **programmatic**. Third because repo-agnosticism
   is currently *assumed*, and it is a claim in the foundational goal ("from any context").
4. **A mid-run-interruption case.** Grader: **programmatic** — assert the gate still runs
   and the report records `null`, not `0`, after a killed worker. Fourth because arm B
   demonstrated this failure mode is real (`phases: []`, `wall_ms: null` after SIGTERM) and
   it is the one that silently corrupts the telemetry that *is* Alfred's product.
5. **`tars-1339`, un-authored by us.** Grader: **programmatic + human**. Last because it is
   the most expensive and the most meaningful — the only case where a PASS is strong
   evidence rather than weak.

Deliberately **not** in the minimum set: a stalled-agent fixture (hard to author
deterministically, and the stall metric doesn't exist yet), and per-tier capability
mapping (a measurement project, not a regression net).

## Concrete next actions

Ordered. Each names the file to create or change. **No fixes were made in this pass.**

1. **Decide n for arm C, and pre-register caps + kill thresholds in code** — task #41.
   Files: `docs/EXPERIMENT-2.md` (pre-registration section), plus a caps constant in the
   arm C runner. **Blocking on the user; unrecoverable if skipped.**
2. **Version-stamp the rubric+fixture pair and stamp every result** — task #42. Files:
   `fixtures/*/manifest.json` (add `suite_version`), `docs/EXPERIMENT-2-RESULTS.md`
   (header stamp: suite version, model, config sha, date), plus **a test that an unstamped
   result record fails**. The test is the point; a policy nothing enforces is instance 3 of
   §9's drift signal.
3. **Write the additive-only fixture policy** — task #42. File: `docs/SANDBOX.md` (new
   section) or `docs/EVAL-READINESS.md`. Must say what to do when a fixture is *wrong*
   rather than merely incomplete.
4. **Write the model-change protocol and declare the sonnet-4-6 → sonnet-5 seam** — task
   #43. Files: new `docs/MODEL-CHANGES.md`; `docs/EXPERIMENT-2.md` (declare the seam
   *before* arm C runs, not after). Must state explicitly that the 4.7x is provisional
   pending re-ablation.
5. **Build the arm C runner with the gate on every exit path** — task #44. File:
   `eval/run-armc.mjs`. Two requirements this scorecard adds: the gate must run even when
   the worker is killed (§2), and the watchdog must read the full recursive denominator
   (§5, §2.8).
6. **Run arm C** — task #30. Only after 1–5.
7. **Author the seeded failure fixtures, tail arm reported separately** — task #45. Files:
   `fixtures/sandbox-c/` (failing tests), `fixtures/sandbox-d/` (dissimilar language).
8. **Make layers toggleable; score the ladder additively** — task #46. Files:
   `lib/config.mjs` (feature flags), `eval/ladder.mjs`.
9. **Smoke/full split and machine-readable results** — task #47. Files: `package.json`
   (`test:smoke`), a results JSON emitter alongside the prose. Also in #47: rename the
   misleading `armA.json`/`armB.json` (they are provisioning records), and de-duplicate the
   two score sheets that exist at two paths (§9).

## Diff vs. last audit

**None — this is scorecard #1.** No prior report from this checklist exists in the repo
(`docs/eval-readiness/` created by this pass).

For scorecard #2, the three lines that matter most:

- Did §4 move? (noise floor, n, stamping) — if not, every number since is still
  uninterpretable.
- Did §6 move? (failure fixtures) — if not, the gate is still justified on happy-path
  reasoning.
- **What was recommended here and not done, with the reason.** A checklist re-run that
  produces a fresh document and no change is the ceremony this was written to avoid.
