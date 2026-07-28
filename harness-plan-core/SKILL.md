---
name: harness-plan-core
description: >-
  Harness phase 2 (Node-CLI spine) — turn an intake manifest into planned units
  mapped to real repo locations with done-criteria, negotiate the entry
  contract, and write the plan→implement handoff, with automatic run logging and
  v2 telemetry. Use when the user says "harness plan", "plan this run", or after
  harness-intake-core has produced a manifest. Works standalone given any manifest.
---

# harness-plan-core

You are phase 2 of the harness (intake → plan → implement). Your job: decide
HOW — break the requirement into implementable units mapped to real code
locations, and negotiate the contract implement will be verified against.

**The manifest is the source of truth — do not re-research.** Intake already
audited the input's claims against the code (`claims_audit`) and mapped the
relevant surface (`repo_scan`). Plan from those; never re-read the original
issue for facts (it may contain claims intake corrected), and never re-scan
what `repo_scan` already covers. Your own repo reads are targeted spot-checks
of the specific locations your units will name.

Let `CLI` = `node ~/.claude/skills/harness-core/tools/harness.mjs`.

## Invariants

Same five as every phase — logging first and fatal on exit 2; single writer
(only you write plan/handoff/record); tiers assigned from `CLI config`, never
self-selected; every artifact validated before use; and reached via
`Skill({skill: "harness-plan-core"})`, never a raw prompt or a `Workflow`-tool
script standing in for a proper Skill invocation.

## Workflow

**1. Locate the upstream run.** Find the manifest: the user may give a run id
or path; else take the newest `.harness/runs/*__intake__*/manifest.json` in
the target repo (resolve the repo as harness-intake-core does: cwd, else user.json
registry, else ask) — call the resolved path `<manifest_path>`. Validate it
(`CLI validate --schema manifest --file <manifest_path>`). Read the
intake→plan handoff beside it; its
`entry_contract` is your input contract. If the handoff or the manifest is
missing/invalid, STOP and tell the user to run harness-intake-core first — the
manifest is intake's artifact, and the single-writer invariant means plan
does not repair, regenerate, or reconstruct it by guessing. This happens
before your own run is initialized (step 2), so there is nothing to finalize
yet — just stop and tell the user. (If a missing/invalid manifest were ever
discovered after init-run, finalize first: `CLI run-end --target <path>
--run-dir <run_dir> --status failed --reason-code crash --reason-detail
"upstream manifest missing or invalid — run harness-intake-core first"`, then stop
and tell the user.)

**2. Start your own run** (standalone invocability — every phase logs its own
run; `parent_run_id` stays null until the orchestrator exists):

    CLI init-run --target <path> --repo <slug> --kind plan --source <source> [--issue <n>] [--branch <b>]

`--source` takes the CLI's literal source form — `issue-<n>` (e.g. `issue-7`),
`adhoc`, or `file` — matching the source segment of the manifest's run id, NOT
the manifest's `source.type` value.

**2.5. Forward-route prior residue (issue-sourced runs only).** Before
spot-checks or plan writing, pull any residue earlier phases left for this
issue:

    CLI residue-scan --target <path> --issue <n>

Parse `<n>` from the issue number in the manifest's run id (its
`__issue-<n>__` segment) or the manifest's `source.ref`; SKIP this step
entirely for `adhoc`/`file`-sourced runs (they carry no issue number and are
permanently outside forward-routing). `residue-scan` returns
`{ items: [...] }` — the u1-shaped `residue`/`defect` notes recorded against
this issue by any prior intake/plan/implement run, oldest-to-newest.

For EACH returned item, make an explicit relevance call — do not leave it ad
hoc: an item is **stale** once a later successful run on that same phase has
already resolved the concern its `data.criterion`/`data.detail` describes, and
**still-relevant** otherwise. Carry every still-relevant item forward into
either a specific unit's `done_criteria` (when it names concrete work the plan
must do) or the handoff `notes` landing checklist (when it's a caveat implement
should watch but not a unit of work) — reproducing its `data.detail` so the
carried-forward text is traceable to what the gate flagged.

Note a deliberate, accepted limitation: this repo's four pre-standardization
historical residue notes (predating the u1 shape) are **expected to be
invisible** to `residue-scan` — not because of their `data.type` value, but
because none carries `data.criterion`. Two of the four already use the literal
`data.type:"residue"` for real issues (issue-2, issue-3), so a type-only
filter would wrongly resurface them; the criterion-presence requirement is
what keeps them out. This is a documented going-forward-only gap, not a defect
to work around — do not hand-scan `audit.jsonl` to recover them.

**3. Targeted spot-checks (read-only; discovery only on gaps).** Default: NO
discovery subagents. Verify yourself, with direct reads, that the specific
files/symbols your units will reference match what `repo_scan` says (things
drift between runs). Spawn budgeted discovery subagents (at most
`max_parallel_readers` for the manifest's size; task type
`read_only_discovery`, LOW/haiku, MINIMAL reasoning, brief-file + validate +
render the prompt with `CLI render-brief --file <path>` + audit `spawn`) ONLY
when the manifest's `repo_scan`
lacks something planning genuinely needs — and audit a `note` event naming
the gap, so intake learns what it should have captured. Persist any findings
you use to `findings/`, and resolve any `needs-decision-*.json` before
proceeding.

**4. Write the plan** (`<run_dir>/plan.json`, `plan` schema). Shape:

    {
      "run_id": "<this run's id>",
      "plan_key": "<KEY>-p1",
      "units": [
        {
          "id": "u1",
          "title": "Add session middleware",
          "locations": ["src/middleware/", "src/app.mjs"],
          "depends_on": [],
          "done_criteria": ["requests without a session cookie get 401", "existing tests still pass"]
        }
      ],
      "order": ["u1"],
      "schema_version": "1.0.0"
    }

The plan is now a schema'd artifact (`CLI validate --schema plan --file
<run_dir>/plan.json` — the step-5 preflight enforces this too). For a unit
whose `files[]` would exceed the per-task cap (a bulk migration), do NOT hand-
split: write it as one unit and run `CLI split-tasks --plan <run_dir>/plan.json`
to break it into same-group parallel chunks deterministically. When a manifest
produced multiple plan files with a dependency graph, order them with `CLI
plan-order --manifest <plan-manifest.json>` rather than sequencing by hand.

Rules: every `locations` entry must exist in the repo (or be explicitly marked
`"NEW: <path>"`); every unit's `done_criteria` must be checkable by running
something; units small enough that implement can verify them one at a time.
Two more, learned from measured runs:
- Reference files and symbol/step names, never line numbers — line anchors rot
  and verifiers burn rounds nitpicking them.
- Units must be completable in `order`: a unit's done-criteria may not depend
  on a later unit's output (if a test can only pass once a later unit lands,
  either merge the units or move the criterion). Post-verification outcomes
  (merge, tag, issue-close) are not unit criteria at all — they go in the
  handoff `notes` as the landing checklist, because implement's verifier runs
  before merge and can never satisfy them.

**5. Verifier loop.** FIRST run the deterministic preflight and fix every
finding before spending any verifier tokens:

    CLI preflight --phase plan --run-dir <run_dir>

Exit 1 → fix plan.json per the findings, re-run until clean (location
existence, dependency order, and criteria non-emptiness are script problems,
not LLM problems). Then: fresh-context verifier, task type `verifier_plan`
(MID/sonnet, FULL reasoning). Ground-truth checks:
- Every non-NEW location exists; every NEW location's parent dir exists.
- Every manifest acceptance criterion is covered by ≥1 unit's done-criteria;
  no orphan units that trace to nothing.
- Dependency order is acyclic and complete, and no unit's done-criteria
  depend on a later unit's output.
- FOR SIZES S AND M: the verifier also reviews the draft entry contract you
  hand it (see step 6's fast path) — approving or amending each criterion's
  wording and tag — so a separate negotiation round is unnecessary.
The verifier returns: score 0–1, tagged failures, and a gate-ready `result`
(`pass` when the failure list is empty; `advisory-fail`/`blocking-fail` by
the highest-severity tag present — make your verifier prompt require this
field so the mapping is never improvised). Audit a `spawn` event when you
dispatch the verifier (its `data.task_type` is mandatory — a spawn event
without a non-empty `task_type` is rejected as `invalid_audit_entry`) and a
`verifier_round` event after EVERY round — pass rounds included (the `CLI
anomalies` integrity scan checks succeeded runs for one `verifier_round` per
round used and a verifier `spawn`):

    CLI audit --target <path> --event '{"ts":"<now>","run_id":"<run_id>","phase":"plan","agent_id":"<verifier-agent-id>","event":"spawn","data":{"tier":"MID","task_type":"verifier_plan"}}'

Then `CLI gate --size <size> --rounds <n> --result <r> --score <score>` (always pass
the score: a high-scoring advisory-only round opens immediately with
residue) and act on the decision exactly as harness-intake-core does:
- `revise` → fix the plan per the failures, loop.
- `open` → proceed. When the gate decision returns a non-null `record`,
  record it in an audit `note` event using the **standardized residue shape**
  so downstream phases can route it deterministically (gate.mjs emits
  `record: "residue"` on a high-scoring advisory fast-open and
  `record: "defect"` at the revision cap; the pass-path open has
  `record: null` and needs no note):
  - `data.type` — set verbatim to that gate `record` value (`residue` or
    `defect`), never a new ad hoc label.
  - `data.criterion` — the specific entry-contract criterion text or id the
    residue concerns (a non-empty string; this field, not `data.type` alone,
    is what makes a note routable — a type-only note is invisible to
    `residue-scan`).
  - `data.detail` — the free-form residue text, preserved verbatim so it can
    be reproduced downstream.
- `shut` (exit 1) → the phase failed: `CLI phase-end --run-dir <run_dir>
  --phase plan --status failed`, then `CLI run-end --target <path>
  --run-dir <run_dir> --status failed --reason-code verifier_blocking_cap
  --reason-detail "<summary>"`, post the status comment if issue-sourced (jira →
  `mcp__atlassian__addCommentToJiraIssue`; github → `gh issue comment <n>
  --repo <owner/repo>`, same render helper as step 8), and stop.

**6. Negotiate the entry contract** (spec §6's generator/verifier agreement,
done BEFORE implement starts). You draft the proposal either way: the
done-criteria implement will be held to, derived from the intake contract +
unit done-criteria, each tagged `blocking` or `advisory` (correctness,
security, data loss, build-breaking → blocking). Cap it near the intake
contract's size — every criterion must trace to an intake criterion or a unit
done-criterion; padding the contract inflates implement's verification cost.
Post-merge outcomes are NOT contract criteria (they're unverifiable pre-merge)
— put them in the handoff `notes` landing checklist.

- **Sizes S and M (fast path):** include the draft contract in EVERY step-5
  verifier round (so a revise round never leaves the contract unreviewed);
  the final round's approve/amend verdicts ARE the negotiation. No separate
  agent — a serial MID negotiator measured ~50k tokens and ~2 min for
  verdicts the verifier could issue in the same pass.
- **Size L:** spawn a fresh `entry_contract` agent (MID/sonnet, FULL
  reasoning) with the proposal, the plan, and the manifest; it approves or
  amends each criterion. One pass, no loop.
- Either path: you (single writer) apply the amendments, ground-check any
  factual claims in them against the repo before accepting, and audit a
  `note` event summarizing verdicts.

**7. Write the handoff** (`<run_dir>/handoffs/plan-to-implement.json`,
`handoff` schema): `from_phase: plan`, `to_phase: implement`, the negotiated
`entry_contract`, `artifacts` = plan.json + manifest (by path, with
descriptions). Validate it. On failure, read the printed error list, fix the
artifact, and re-validate. At most 2 repair attempts. If it still fails,
finalize the run as failed: `CLI run-end --target <path> --run-dir <run_dir>
--status failed --reason-code crash --reason-detail "artifact failed schema
validation: handoff"`, and stop.

**8. Close.** First `phase-end`, then the status comment (if issue-sourced,
one comment), then `run-end`. Do NOT hand-compose the comment markdown:
render it with `CLI render-status-comment` and pass its stdout as the comment
body, so the template's shape (heading emoji, Plan line with unit
count + blocking-criteria count, Residue line, Next line) is assembled by
script. Pass `--notes` as the JSON array of THIS run's own recorded
residue/defect notes (the notes step 5 wrote this run — no `audit.jsonl`
re-scan); the helper populates the **Residue** line from them and omits it
entirely when the array is empty. You still author the `--next` prose
yourself.

    BODY=$(CLI render-status-comment --phase plan --status succeeded --run-id <run_id> --plan-units <n> --plan-blocking <n> --notes '<json-array of residue notes, or []>' --next "<what happens next>")

Post it to the issue tracker — the render helper is source-neutral, only the
post differs (skip for adhoc/file). Carry the `issue_source` forward from the
manifest's `source` (`issue-<KEY>` → jira, `issue-<n>` numeric → github) or the
dispatcher:
- **jira:** `mcp__atlassian__addCommentToJiraIssue({ cloudId, issueIdOrKey: '<KEY>', commentBody: BODY })`
- **github:** `gh issue comment <n> --repo <owner/repo> --body "$BODY"`

Then close the record, passing the per-skill perf fields the v2 record tracks —
`--active-ms` (from `CLI tokens-collect`'s `active_ms`), `--agent-count`, and
`--skill-metrics` (plan slice: plan path, unit/task counts, revisions):

    CLI phase-end --run-dir <run_dir> --phase plan --status succeeded --rounds <n> --score <score> --size <size>
    CLI run-end --target <path> --run-dir <run_dir> --status succeeded --tokens-by-tier '{"LOW":<n>,"MID":<n>,"HIGH":<n>}' \
      --active-ms <n> \
      --agent-count '{"by_model":{"<model-id>":<n>},"by_phase":{"Plan":<n>}}' \
      --skill-metrics '{"planSlug":"<KEY>","planCount":<n>,"taskCount":<n>,"architectRevisions":<n>}'

(Wall-clock durations are stamped automatically. Tokens: you still OBSERVE
each spawn's raw `subagent_tokens` number yourself (from the Agent-tool usage
tag; estimate honestly where unobservable), but do NOT hand-sum them or
hand-write the tokens note. Feed the observed numbers to `CLI tokens-finalize`
— one `--tier <TIER>=<amount>[:estimated]` per observation — and use its
output directly: its `tokens_by_tier` is the `--tokens-by-tier` argument
above, and its `tokens_note` is the `data` payload for the tokens `note` audit
event. It omits untouched tiers and sets `estimated:true` iff any observation
was flagged `:estimated` — the anomalies scan keys off that flag:

    CLI tokens-finalize --tier MID=<n> --tier LOW=<n>:estimated
    CLI audit --target <path> --event '{"ts":"<now>","run_id":"<run_id>","phase":"plan","event":"note","data":<tokens_note from above>}'

Omit `tokens-finalize` and the note entirely only if you spawned no subagents
at all.)

**9. Report.** Tell the user: run id, units + order, entry-contract summary,
and that `harness-implement-core` can now run.

## Failure handling

- `CLI validate` exits 1 on the schema-validated artifact this phase produces
  (the plan→implement handoff) → read the printed error list, fix the
  artifact, and re-validate. At most 2 repair attempts. If it still fails,
  finalize the run as failed: `CLI run-end --target <path> --run-dir
  <run_dir> --status failed --reason-code crash --reason-detail "artifact
  failed schema validation: <schema-name>"`, and stop. `plan.json` is now
  schema'd too (`CLI validate --schema plan`) and the step-5 preflight enforces
  it, so a schema-invalid plan is caught and repaired in the verifier loop
  rather than here. An invalid or missing upstream manifest is not this phase's
  artifact to repair — it follows the Step 1 STOP path instead.
- User cancels mid-run → `CLI run-end --target <path> --run-dir <run_dir>
  --status cancelled --reason-code user_cancelled --reason-detail "<where>"`.
- Any unrecoverable error → `CLI phase-end --run-dir <run_dir> --phase plan
  --status failed`, `CLI run-end --target <path> --run-dir <run_dir> --status
  failed --reason-code crash --reason-detail "<error>"`. Never exit without a
  `run-end` — an `attempted` record left behind means a crash, and the sweep
  will mark it `abandoned`.
