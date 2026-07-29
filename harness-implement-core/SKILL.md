---
name: harness-implement-core
description: >-
  Harness phase 3 (Node-CLI spine) — execute a plan's units against the target
  repo, verify the built artifact end-to-end with a HIGH-tier verifier, and open
  a GitHub PR (never merge), with automatic run logging and v2 telemetry. Use
  when the user says "harness implement", "implement the plan", or after
  harness-plan-core has produced a plan and entry contract. Works standalone
  given any plan.
---

# harness-implement-core

You are phase 3 of the harness (intake → plan → implement). Your job: make
the plan real, prove it against the entry contract, and deliver a PR.

Let `CLI` = `node ~/.claude/skills/harness-core/tools/harness.mjs`.

## Invariants

Same five as every phase — logging first and fatal on exit 2; single writer
for all `.harness/` artifacts; tiers assigned from `CLI config`; every
artifact validated; and reached via `Skill({skill: "harness-implement-core"})`,
never a raw prompt or a `Workflow`-tool script standing in for a proper Skill
invocation. Plus two of your own: **never commit to the base branch** — all
work happens on a run branch; and **open the PR, never merge it** — delivery
ends at an open PR for human review (an autonomous loop must not self-merge).

## Workflow

**1. Locate the upstream run.** Find `plan.json` and
`handoffs/plan-to-implement.json` (user-given run id/path, else newest
`*__plan__*` run in the target's `.harness/runs/`). The handoff's
`entry_contract` is what you will be verified against — if `plan.json` is
missing or fails `CLI validate --schema plan --file <plan_path>`, OR the
handoff is missing or fails `CLI validate --schema handoff --file
<handoff_path>`, STOP and point the user at harness-plan-core (do not
reconstruct the plan by guessing; that's the producer's defect).

**2. Start your own run** (`--kind implement`; `--source` takes the CLI's
literal form — `issue-<n>`, `adhoc`, or `file` — matching the source segment
of the upstream run ids), then create the work branch from `BASE_BRANCH`:

    git -C <target> checkout <BASE_BRANCH>
    git -C <target> checkout -b harness/<run-id-shortid>-<slug-of-requirement>

`BASE_BRANCH` comes from your invocation (the loop resolves it deterministically
from config and passes it in). It is NOT always the repo default: a ticket that
is one phase of an epic bases on the EPIC FEATURE BRANCH, whose prior phases are
not on the default branch — branch off the default there and your work branch is
missing its own prerequisites and your PR targets a base that never had them. If
your invocation named no `BASE_BRANCH`, use the repo default and SAY SO in your
report; do not infer an epic branch from the plan prose or the branch list.

**3. Execute units in plan order.** The manifest + plan are your truth — do
not re-read the original issue (it may contain claims intake corrected) and
do not re-research the repo. For each unit:
- Light preflight first: confirm the unit's `locations` and named integration
  points still match reality (a direct read, seconds not minutes). If reality
  has drifted from the plan, adapt minimally, audit a `note` event describing
  the divergence, and continue — the plan serves the code, not vice versa.
  Spawn read-only discovery subagents only when a unit needs genuine
  investigation (same brief protocol and budgets as the other phases).
- Implement it yourself (you are the single writer of code in this phase).
- Run the unit's `done_criteria` checks as you go (tests, build, lint —
  whatever the repo provides).
- Commit per unit: `git commit -m "harness(<unit-id>): <unit title>"`.
- Audit each unit: event `note`, `data: {"unit": "<id>", "status": "done"}`.
- A unit that cannot be completed → audit it, mark remaining units skipped,
  and jump to step 6 with `partial`.

**3.5. Ship a verification harness with your work.** Before spawning the
verifier, write runnable checks to `<run_dir>/verify/`: the exact commands
and small scripts YOU used to prove the work (gate command, build-with-env
variants, a serve-and-probe script, targeted greps) plus a one-screen
`verify/README.md` mapping each entry-contract criterion to the check that
exercises it. Measured runs showed the HIGH-tier verifier spending half its
phase re-deriving scaffolding the implementer had already built — fresh
context should mean fresh JUDGMENT, not fresh tooling.

**4. Verifier loop (the hard gate).** Fresh-context verifier, task type
`verifier_implement` — HIGH tier / opus, FULL reasoning; the tier is a FLOOR
(never economize here). Hand it the `<run_dir>/verify/` harness and tell it:
use the provided tooling to gather evidence fast, but form your own judgment
— rerun the checks yourself, distrust their coverage, and add any check the
contract needs that the implementer didn't provide (a missing check is
itself reportable). It must judge from EVIDENCE, not diff-reading:
- Run the repo's own test suite / build.
- Drive the built artifact end-to-end: start the app and exercise the entry
  contract's criteria via the browser or API client — "unit tests pass" alone
  is insufficient evidence for a blocking criterion.
- Check every `entry_contract` criterion, in order, and report per-criterion
  pass/fail with the evidence used. A criterion that is unsatisfiable at
  verification time by construction (a post-merge outcome that leaked into
  the contract) gets verdict `deferred`, is excluded from the gate result,
  and is listed in the PR as the landing checklist — never report it as a
  failure the gate would try to revise.
Score 0–1 + failures tagged by their criterion's tag, plus a gate-ready
`result` (`pass` when no non-deferred failures; else by highest-severity
tag). Audit a `spawn` event for EVERY subagent you dispatch in this phase —
the verifier included (`data.task_type: "verifier_implement"`) — and a
`verifier_round` event after EVERY round, pass rounds included (the `CLI
anomalies` integrity scan checks succeeded runs for one `verifier_round` per
round used and a verifier `spawn`; a measured run skipped the verifier spawn
audit and now trips that scan). Then (always pass the score — a high-scoring
advisory-only round opens immediately with residue instead of burning
another HIGH-tier round):

    CLI gate --size <size> --rounds <round> --result <pass|advisory-fail|blocking-fail> --score <score>

- `revise` → fix precisely the failed criteria, loop.
- `open` with a non-null gate `record` → record it via an audit `note` using
  the **standardized residue shape**, then proceed. gate.mjs emits
  `record: "residue"` on a high-scoring advisory fast-open and
  `record: "defect"` at the revision cap (the pass-path open is
  `record: null` and needs no note). Use the shape so the PR body's
  "Advisory residue" section (step 5) and the status comment's Residue line
  (step 6) can reproduce it verbatim:
  - `data.type` — set verbatim to that gate `record` value (`residue` or
    `defect`), never a new ad hoc label.
  - `data.criterion` — the specific entry-contract criterion text or id the
    residue concerns (a non-empty string; this field, not `data.type` alone,
    is what makes a note routable — a type-only note is invisible to
    `residue-scan`).
  - `data.detail` — the free-form residue text, preserved verbatim so it can
    be reproduced downstream.
- `shut` (exit 1) → the phase failed: `CLI phase-end --run-dir <run_dir>
  --phase implement --status failed`, then `CLI run-end --target <path>
  --run-dir <run_dir> --status failed --reason-code verifier_blocking_cap
  --reason-detail "<summary>"`, push the branch anyway (work is not lost),
  post the status comment if issue-sourced (jira →
  `mcp__atlassian__addCommentToJiraIssue`; github → `gh issue comment <n>
  --repo <owner/repo>`), and stop.

**5. Deliver — open the PR, never merge.** The code repo is GitHub either way,
so the PR is created with `gh pr create`. Do NOT hand-assemble the PR body
markdown: render it with `CLI render-pr-body` and capture its stdout into a
variable-free `gh pr create --body "$(...)"` invocation. You still author the
prose `--summary` yourself; the helper assembles the invariant shape (a
`Closes #<issue>` line, the entry-contract results table, the landing
checklist, the run id, and the Advisory-residue section). Pass the
entry-contract results as `--result-rows` (a JSON array of `{criterion, tag,
result, evidence}`), the post-merge landing checklist as `--landing`, and
`--notes` as the JSON array of THIS run's own recorded residue/defect notes:

    git push -u origin <branch>
    gh pr create --base <BASE_BRANCH> --title "<change_type>: <ID> <requirement summary>" --body "$(CLI render-pr-body --change-type <change_type> --issue <ID> --summary "<your prose summary>" --run-id <run_id> --result-rows '<json>' --landing '<json>' --notes '<json-array of residue notes, or []>')"

`<ID>` is the work-item id — the Jira KEY (`TARS-1271`) or the GitHub issue
NUMBER (`2`) — and goes in BOTH the PR title and the `--summary` prose (e.g.
"Implements #2." / "Implements TARS-1271.") so the PR is traceable. The
`Closes #<ID>` line render-pr-body emits behaves differently by source, and
both behaviors are correct:
- **github:** `Closes #2` is a valid GitHub auto-close keyword — the issue
  closes automatically when a human merges the PR (never on open, so the
  never-merge invariant holds; nothing auto-closes just from pushing).
- **jira:** `Closes #TARS-1271` is NOT a valid numeric ref in the code repo, so
  GitHub ignores it — it degrades to a plain reference, and the Jira issue is
  transitioned in Jira by a human after review, as before.

**Do not merge the PR** — delivery ends here.

**The `## Advisory residue` section** is emitted by `render-pr-body` directly
below the run-id line. It lists every `residue`/`defect` note THIS implement
run itself recorded in step 4 (one bullet per gate round that opened with
residue), reproducing that note's own `data.criterion` and `data.detail`
**verbatim** — no paraphrasing, so a downstream reader (and a follow-up plan
run's `residue-scan`) sees exactly what the gate flagged. Source the notes
from this run's own audit events (pass them as `--notes`); no `audit.jsonl`
re-scan is needed for a run's own residue. The helper **omits the entire
section — heading and all — when the `--notes` array is empty** (a clean
gate); never emit an empty `## Advisory residue` heading.

The title's `<change_type>` prefix comes from the manifest's
`requirement.change_type` (fall back to the source issue's own title prefix,
else `chore`) — NEVER a harness-branded prefix. Squash-merges take the PR
title as the commit subject, and repos with conventional-commit automation
(semantic version bumps, changelogs) key off that prefix; a non-semantic
prefix silently downgrades their releases.

**6. Close.** First `phase-end`, then the status comment (if issue-sourced,
one comment: outcome + PR link), then `run-end`. Do NOT hand-compose the
comment markdown: render it with `CLI render-status-comment` and pass its
stdout as the comment body, so the template's shape (heading emoji, PR
line, Residue line, Next line) is assembled by script. Pass `--notes` as the
JSON array of THIS run's own recorded residue/defect notes (the same notes
that fed step 5's PR-body section — no `audit.jsonl` re-scan); the helper
populates the **Residue** line from them and omits it entirely when the array
is empty. You still author the `--next` prose yourself. The render helper is
source-neutral; only the post differs (carry `issue_source` from the manifest's
`source` or the dispatcher):

    BODY=$(CLI render-status-comment --phase implement --status <succeeded|partial|failed> --run-id <run_id> --pr-url <url> --notes '<json-array of residue notes, or []>' --next "<outcome, or why the run stopped>")
    # issue_source==jira:   mcp__atlassian__addCommentToJiraIssue({ cloudId, issueIdOrKey: '<KEY>', commentBody: BODY })
    # issue_source==github: gh issue comment <n> --repo <owner/repo> --body "$BODY"
    CLI phase-end --run-dir <run_dir> --phase implement --status <succeeded|partial|failed> --rounds <n> --score <score> --size <size>
    CLI run-end --target <path> --run-dir <run_dir> --status <same> [--reason-code <code> --reason-detail "<why>"] --tokens-by-tier '{"LOW":<n>,"MID":<n>,"HIGH":<n>}' \
      --active-ms <n> \
      --agent-count '{"by_model":{"<model-id>":<n>},"by_phase":{"Implement":<n>,"Verify":<n>}}' \
      --skill-metrics '{"planPath":"<plan_path>","branch":"<branch>","tasksTotal":<n>,"tasksPassed":<n>,"tasksBlocked":<n>,"criticalFindings":<n>,"testsPassed":<bool>,"typeCheckPassed":<bool>}'

`partial` requires a reason (usually `subagent_budget_exhausted` or a unit
blocker described in `--reason-detail`). Wall-clock durations are stamped
automatically. Tokens: you still OBSERVE each spawn's raw `subagent_tokens`
number yourself (from the Agent-tool usage tag; estimate honestly where
unobservable), but do NOT hand-sum them or hand-write the tokens note. Feed
the observed numbers to `CLI tokens-finalize` — one `--tier
<TIER>=<amount>[:estimated]` per observation (the verifier rounds are HIGH) —
and use its output directly: its `tokens_by_tier` is the `--tokens-by-tier`
argument above, and its `tokens_note` is the `data` payload for the tokens
`note` audit event. It omits untouched tiers and sets `estimated:true` iff any
observation was flagged `:estimated` — the anomalies scan keys off that flag:

    CLI tokens-finalize --tier HIGH=<n> --tier MID=<n>
    CLI audit --target <path> --event '{"ts":"<now>","run_id":"<run_id>","phase":"implement","event":"note","data":<tokens_note from above>}'

Omit `tokens-finalize` and the note entirely only if you spawned no subagents
at all.

**7. Report.** Tell the user: run id, per-criterion verification results, PR
URL, and anything `partial`/`deferred` (including the landing checklist).

## Failure handling

Identical to the other phases (`cancelled`/`user_cancelled`,
`failed`/`crash`, never exit without `run-end`) — plus: leave the work branch
pushed on any non-success so no code is lost, and say so in the report.
