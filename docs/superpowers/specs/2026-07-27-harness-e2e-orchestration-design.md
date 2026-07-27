# Harness E2E Orchestration — Design

**Date:** 2026-07-27
**Status:** Approved-pending-spec-review
**Scope:** The orchestration layer that turns three independently-runnable skills (`harness-intake`, `harness-plan`, `harness-implement`) into one autonomous, confidence-gated ticket→PR pipeline — via a new gate skill (`harness-bridge`) and a new parent runbook (`harness-run`).

---

## 1. Goal

By morning, a **usable `harness-run`** the user can point at a ticket and trust to go intake → plan → implement → **guardrailed draft PR** without intervention, plus that pipeline exercised end-to-end on **TARS-1271**.

Non-goal tonight: running the harness unattended in production. "Overnight loop" = the **dev loop that builds this**, not the harness running unsupervised on real tickets.

### Design pillars (unchanged, load-bearing)
- **ticket-skepticism** — research-grounded facts outrank ticket prose.
- **manifest-as-hypothesis** — a manifest is a claim until evidence confirms it; once a bridge stamps it PROCEED, the stamped manifest outranks the ticket for everything downstream (**manifest supremacy**).
- **determinism-over-LLM** — prefer a formula to a judgment; the one LLM in the gate can only *lower* confidence.
- **size-based routing** — bigger/uncertain work gets more corroboration and heavier tiers.

---

## 2. Architecture

```
                 ┌─────────────┐   ┌─────────────┐
   ticket ─────► │harness-intake│─►│harness-bridge│─► PROCEED ─┐
                 └─────────────┘   │  (Handoff A) │            │
                                   └─────────────┘            ▼
                                                       ┌─────────────┐   ┌─────────────┐
                                                       │ harness-plan │─►│harness-bridge│─► PROCEED ─┐
                                                       │ (+re-sizing) │   │  (Handoff B) │            │
                                                       └─────────────┘   └─────────────┘            ▼
                                                                                            ┌──────────────┐
                                                                                            │harness-implement│─► draft PR
                                                                                            └──────────────┘
```

`harness-run` is the **conductor**: an artifact-gated runbook (SKILL.md + a small `lib/conductor.js`) that provisions the worktree, calls each child **as a skill** (never launches `workflow.js` directly), reads the artifact each skill leaves on disk, invokes `harness-bridge` between skills, and acts on the verdict. Each child skill remains independently invocable exactly as today.

**Why call children as skills, not as JS:** firing the SKILL wrapper preserves the telemetry write, cleanup, and handoff logic each skill owns. Launching `workflow.js` directly loses all three.

---

## 3. harness-bridge (the confidence gate)

### 3.1 I/O contract
- **Input:** the upstream artifact path (Handoff A: `intake-manifest.json`; Handoff B: plan `p1.json` + `manifest.json`) and a handoff id (`A` | `B`).
- **Output:** the **same** manifest, stamped and written as a **new versioned file** (`<name>-gated.json`). The original is never mutated. Stamp fields: `gated: true`, `confidence: 0-100`, `verdict`, `flags[]`, `probeResults[]`.
- **Telemetry:** a full honest v2 record (`skill: "harness-bridge"`) — see §6.

### 3.2 Confidence formula (frozen checklist)
`score = Σ(weightᵢ × checkᵢ)` where each `checkᵢ ∈ [0,1]` is **pure JS** over the artifact (and the cheap read-only repo facts already embedded in it). No check calls an LLM. Then `final = holePoker(score)` — one Sonnet skeptic, **lower-only**.

Weights per handoff **sum to exactly 100** (asserted at load). **Threshold = 85.**

#### Handoff A — intake → plan (Σ = 100)

| Wt | Check | Computes | Catches |
|---|---|---|---|
| 24 | `grounding-evidence-fresh` | target primitive (token after `→` in `migrationPattern`) appears in some grep/shell/searchScope/files, **and** research-typed ACs carry a positive-hit signal | #2 |
| 20 | `files-populated` | fraction of work units with non-empty `files[]` | #1 |
| 18 | `ac-research-executable` | fraction of `acList` with valid `researchType` + matching non-trivial directive | plan can't ground |
| 12 | `size-corroboration` | ≥2 independent magnitude sources AND declared size agrees with files+AC proxy | #5 |
| 10 | `ac-referenced-files-covered` | code-file paths named in an AC resolve into union of `files[]` | #3 (intake layer) |
| 8 | `claim-truth-consistency` | fraction of verified ACs whose grep count is within 20% of ticket-claimed count | ticket-skepticism |
| 5 | `scope-grounded` | `scopePath`/`searchScope` prefixes ≥1 discovered file | blind scope |
| 3 | `size-shape-consistency` | `size ∈ {XS,S,M,L}` and `L ⇔ non-empty groups[]` | routing |

#### Handoff B — plan → implement (Σ = 100)

| Wt | Check | Computes | Catches |
|---|---|---|---|
| 30 | `task-spec-completeness` | fraction of tasks with WHAT+WHERE+HOW+DONE and a fenced snippet, WHERE/HOW ≥20 chars — mirrors plan's shipped NEEDS_CONTEXT predictor (`harness-plan/workflow.js:1408-1430`) | primary stall predictor |
| 20 | `task-files-present-bounded` | 0 if empty; 1.0 for 1–3 files; decays above 3 | #1 + #4 |
| 16 | `where-resolves-to-files` | WHERE has a `file:line` anchor AND that path is in the task's `files[]` | NEEDS_CONTEXT loc |
| 12 | `companion-edit-closure` | import/path refs in HOW/DONE covered by union of `files[]` | #3 |
| 10 | `tdd-done-literal-assertion` | among `tddRequired` tasks, fraction whose DONE has a literal assertion; vacuously 1 if none | oracle-invention stalls |
| 6 | `manifest-dag-consistency` | `plans[].dependsOn` resolvable + non-self; `execution` matches wiring | unschedulable graph |
| 3 | `concern-atomicity` | ≤1 DONE / no `and`-chained clauses per task | #4 secondary |
| 3 | `size-shape-consistency` | (shared) | routing |

**Failure-mode coverage (all 5, most at two layers):** #1 → A:files-populated / B:files-bounded · #2 → A:grounding-evidence-fresh (+ hole-poker) · #3 → A:ac-referenced-files-covered / B:companion-edit-closure · #4 → B:files-bounded / atomicity · #5 → A:size-corroboration.

Checks live in `harness-bridge/lib/confidence.js`, one pure function per check, each returning `[0,1]`, with the computation expressed as **real JS** (not code-as-string — that was the committee stall bug). A `lib/confidence.test.js` locks each against fixtures.

### 3.3 Hole-poker (the one LLM)
A single Sonnet skeptic that can **only lower** the formula score. It attacks *presence vs. truth* on the highest-weight checks that passed suspiciously clean (a 100/100 is itself a flag): grounding freshness (hit in a comment / test fixture / node_modules / wrong branch? signature mismatch?), right-files-not-just-non-empty (missing barrel/DI/route companion), tautological DONE assertions, fake corroboration (two sizing signals sharing one upstream call), smuggled second concern. Returns `{adjustedScore ≤ score, reasons[]}`.

### 3.4 Verdicts & retry budget (one retry)
- **PROCEED** (`final ≥ 85`) — advance; downstream treats the stamped manifest as **more truthful than the ticket**.
- **RE_ASK** (`final < 85`, first miss) — autonomous recovery, no human:
  1. read-only probes answer the failing checks' `flags[]` (Explore-style, Haiku, `effort:'low'`);
  2. re-run the **previous** skill in narrow `--refine` mode (re-synthesize only the flagged parts, write a new versioned file);
  3. re-gate.
- **EXIT** (`final < 85`, second miss) — stop, full telemetry, summarize to the user. Budget is exactly one retry per handoff.

### 3.5 --refine mode (intake + plan)
Both skills gain a `--refine <gated-path>` mode: read the flagged parts, re-synthesize only those, write a NEW versioned file (never overwrite). Refine is a delta, not a full re-run.

### 3.6 Weight agency (TONIGHT ONLY) + final report
The frozen weights are the **jumping-off point**. `harness-run` may adjust weights mid-run when a run/debug/issue shows a weight is miscalibrated. Guardrails keep it auditable and reversible:

1. **Override layer, not a rewrite.** Adjustments live in `weights-override.json` passed to the bridge; `lib/confidence.js` defaults are never edited. Delete the override → frozen defaults return.
2. **Re-normalize to exactly 100** per handoff after every change (bridge asserts the invariant on load).
3. **Every change is a telemetry event** appended to `weightChanges[]`: `{handoff, checkId, oldWeight, newWeight, reason, triggeringRunId, ts}`.
4. **Bounded:** a weight moves at most **±15** per adjustment; no check may drop to 0 or exceed 60 (a single run can't nuke a failure-mode catcher).
5. **Final weight-evolution report** at run end: initial → final weights for both handoffs, every change with its reason, side by side.

Scope note: this loosening is explicitly **tonight-scoped** because expected behavior is unknown; the report is the artifact we review to decide durable weights later.

---

## 4. harness-run (the conductor)

### Phase 0 — worktree provisioning
Base off `feat/migrate-native-fetch-from-axios` (the branch where `clientFetch` actually exists; PR #318). Provision an **isolated git worktree** of `origin/feat/migrate-native-fetch-from-axios` so the user's dirty local `tars-1271-client-migrate-http-layer` is never touched.

### Phases 1–5 — sequence
1. Call `harness-intake` (as a skill) → read `intake-manifest.json`.
2. Call `harness-bridge A` → PROCEED / RE_ASK(→refine intake) / EXIT.
3. Call `harness-plan` (as a skill, consuming the **gated** manifest; may re-size — §5) → read plan `p1.json` + `manifest.json`.
4. Call `harness-bridge B` → PROCEED / RE_ASK(→refine plan) / EXIT.
5. Call `harness-implement` (as a skill) → guardrailed **draft** PR.

### Aggregation & logging
`runId = ${issueKey}-${runTs}` links every record (intake → bridgeA → plan → bridgeB → implement). The conductor aggregates per-skill telemetry into one run summary and always logs — including on EXIT.

### `lib/conductor.js`
Small, pure, unit-tested: sequence table, verdict→action mapping, retry-budget accounting, weight-override read/write + re-normalize + bound-check, run-summary assembly. No Workflow globals (unit-testable like every other `lib/`).

---

## 5. Manifest supremacy & harness-plan re-sizing

When intake sizes a ticket (say **L**) but research uncovers the real shape (more or fewer facts), harness-plan **re-points/re-sizes** via manifest supremacy: the gated manifest's grounded facts override intake's sizing. Re-sizing changes routing/branching — fewer researchers, Sonnet architect vs Opus, single plan vs split. This is the existing size-based-routing pillar applied at the plan boundary, driven by the stamped manifest rather than the ticket.

---

## 6. Telemetry v2 additions

**Invariant: the v2 schema is gospel. NEVER remove a field. Skills may only ADD.**

The bridge writes a full honest v2 record (real tokens/cost/duration; `skill: "harness-bridge"`) following the existing shape (`schemaVersion, runId, skill, skillsCommit, ts, status, outcome, sourceIssue, repo, repoPath, branch, durationMs, size, tokens{…}, agentCount{…}, cost{…}, …`). It ADDS:

- `confidence`, `verdict`, `flags[]`, `probeResults[]` — the gate result.
- `retries` (int) — recovery attempts this handoff.
- `errorLog[]` — structured `{phase, message, ts}` entries.
- `weightChanges[]` — the §3.6 override stream (also surfaced in the final report).

`runId` linkage across all five records lets the conductor and later analysis reconstruct a full run.

---

## 7. Model routing

Repoint the **"opus" seat** → `claude-opus-5` (released 2026-07-24, same price as 4.8, stronger at unattended verify-before-publish). Current v2 records show `claude-sonnet-4-6` and `claude-haiku-4-5`; the tiering itself is unchanged — mechanical→Haiku, research/architect(XS/S/M)/synthesis/coverage/security→Sonnet, L-architect→Opus(now Opus 5). Driver seat = Opus 5 at the build checkpoint.

---

## 8. Guardrails & authorization (verbatim, must remain in effect)

- Autonomous push/PR authorized **ONLY** as: **DRAFT PR, guardrailed** — push to a `harness/TARS-1271-*` branch, open a **DRAFT** PR, **NEVER merge, NEVER force-push, NEVER touch main directly, only in webtarsthree, only for TARS-1271.**
- Final PR merges back to **`feat/migrate-native-fetch-from-axios`** (NOT main).
- **Stop on first success** — once the target PR lands + `npm test` green + telemetry flowed, stop iterating.
- **$500 hard spend ceiling tonight** (backstop; stop-on-first-success is the primary brake).
- **ALWAYS fire harnesses as skills, never launch `workflow.js` directly.**
- Base worktrees off `feat/migrate-native-fetch-from-axios` (isolated; never touch the user's dirty local branch).
- **NEVER-list** (never self-decide; always surface): irreversible-destructive, security-auth-permission, cost-over-threshold, public-api-contract, out-of-scope, legal-compliance.

---

## 9. Out of scope (tonight)
- Unattended production runs.
- Cross-skill shared library (each skill keeps its own `lib/`; `confidence.js` lives only in harness-bridge).
- Durable re-weighting (tonight's weights are a starting point; the final report informs later decisions).
- Any merge to `main` or to the feature branch (user-gated, separate step).

---

## 10. Build checklist (feeds writing-plans)
1. `harness-bridge` skill: `lib/confidence.js` (frozen checklist, real-JS checks) + `lib/confidence.test.js`; hole-poker agent; verdict/retry logic; `--gated.json` writer; v2 telemetry record with the §6 additions.
2. Weight-override mechanism: `weights-override.json` read/normalize/bound + `weightChanges[]` logging + final report.
3. `harness-run` runbook (SKILL.md) + `lib/conductor.js` + `lib/conductor.test.js`; Phase 0 worktree provisioning.
4. `--refine` mode on `harness-intake` and `harness-plan`.
5. harness-plan re-sizing via manifest supremacy.
6. Telemetry additions (`retries`, `errorLog`, `weightChanges`) wired into the bridge record.
7. Repoint "opus" seat → `claude-opus-5`.
8. Fix the known harness-plan issues surfaced during the run as they block the pipeline (per stop-on-first-success).
9. Autonomous TARS-1271 run: intake → bridge → plan → bridge → implement → guardrailed draft PR.
