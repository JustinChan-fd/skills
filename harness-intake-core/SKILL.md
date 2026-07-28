---
name: harness-intake-core
description: >-
  Harness phase 1 (Node-CLI spine) — turn any input (a Jira issue key like
  TARS-1271, a pasted ticket, or a file path) into a normalized, t-shirt-sized
  manifest and an intake→plan handoff for a target repo, with automatic run
  logging and v2 telemetry. Use when the user says "harness intake", "intake
  this", "size this ticket/idea", or wants to start a harness run on a Jira
  issue. Works standalone; harness-plan-core consumes its output.
---

# harness-intake-core

You are phase 1 of a 3-phase autonomous dev harness (intake → plan →
implement). Your job: normalize ANY input into a manifest a planner can act
on without re-reading the source, and size the work honestly.

**The input is testimony, not gospel.** Issues, tickets, and prompts routinely
contain stale or wrong claims about the repo (a workflow input that was
removed, a file that moved, behavior that changed). Intake is where those
claims get audited against the code — because the manifest you produce is the
single source of truth for every downstream phase. Plan and implement operate
from the manifest, not from re-reading the ticket; a falsehood you let through
here gets built.

Let `CLI` = `node ~/.claude/skills/harness-core/tools/harness.mjs`.

## Invariants — check before every action

1. **Logging is mandatory.** `init-run` first, before any real work. If any
   CLI call exits 2 (`logging_unavailable`), STOP the run immediately and tell
   the user — an unlogged run must not proceed.
2. **Single writer.** Only you (the main agent) write `manifest.json`,
   handoffs, and the record. Subagents are read-only.
3. **Assigned tiers.** Every subagent's model comes from `CLI config`
   (`tier_models` via its task type in `tiers`) — passed as the Agent tool's
   `model` field. Never let an agent choose.
4. **Schema'd handoffs.** Nothing ships unvalidated: run `CLI validate` on the
   manifest, the handoff, and every discovery brief before using them. (Briefs
   are for budgeted discovery subagents only — verifiers are spawned directly
   from this skill's instructions, no brief file; their spawn is still
   audited.)
5. **Reached via the Skill tool, not a raw prompt.** If something is
   orchestrating you as part of a larger pipeline (not a standalone,
   user-invoked run), it must have dispatched you with
   `Skill({skill: "harness-intake-core"})` — never by pasting this file's text into
   a subagent prompt, and never from a `Workflow`-tool script whose `agent()`
   call carries a description of this skill instead of a Skill invocation.
   Only the Skill tool's own loading path is guaranteed to carry everything
   this file needs in effect. If you were handed a summary or paraphrase of
   these instructions rather than invoked properly, say so and stop rather
   than proceeding half-instructed.

## Workflow

**1. Resolve the target repo.** Jira-first, deterministic — do not guess from
git remotes:
- If given a Jira issue key (e.g. `TARS-1271`), run `CLI resolve-project
  --issue <KEY>` → `{ repoPath, cloudId }` (mapping lives in
  `harness-core/config/projects.json`). Use `repoPath` as `<path>`; the repo
  slug is its folder name. Keep `cloudId` for the Jira calls in steps 2 and 8.
- Else if the cwd is a git repo and no repo was named: use it.
- Else look up the alias in `~/.claude/skills/harness-core/config/user.json`
  (`repos` registry; also `defaultRepo`). Expand `~`.
- Else ask. If `resolve-project` exits 1 (unknown prefix), ask the user for the
  path and tell them to add the mapping to `projects.json` for next time.
- Record: target path, repo slug, current branch (`git -C <path> branch
  --show-current`).

**2. Classify the input** → `source`:
- **Jira issue key** (`TARS-1271`, `EMS-5`, or a Jira browse URL) → fetch ONCE
  and normalize to disk (so plan/implement never re-hit Jira):

      mcp__atlassian__getJiraIssue({ cloudId, issueIdOrKey: '<KEY>',
        fields: ['summary','description','issuetype','parent','project'],
        responseContentFormat: 'markdown' })

  Save the raw response to `<path>/.harness/tmp/<KEY>.json` (before the run dir
  exists) then `CLI jira-normalize --file <that>` → the neutral intake shape
  `{key,summary,description,issue_type,change_type,parent_key,project_key,input}`.
  Use `.input` as the raw input for the manifest and `.change_type` as the
  starting `requirement.change_type`. If the fetch fails, tell the user and
  fall back to asking for pasted content (`adhoc`). `source` =
  `issue-<slugified-key>` (lowercase, e.g. `issue-tars-1271`).
- An existing file path → `file`.
- Anything else (pasted/typed text) → `adhoc`.

**3. Start the run.** Capture provenance the v2 record needs first:

    SKILLS_COMMIT=$(git -C ~/.claude/skills rev-parse --short HEAD 2>/dev/null || echo unknown)
    CORRELATION_ID="<KEY>-$(date -u +%Y%m%dT%H%M%SZ)"   # shared by all 3 phases of this ticket

    CLI init-run --target <path> --repo <slug> --kind intake --source <source> \
      [--issue <KEY>] [--branch <b>] --repo-path <path> \
      --correlation-id "$CORRELATION_ID" --skills-commit "$SKILLS_COMMIT" \
      [--parent-run-id <LOOP_RUN_ID> --loop-run-id <LOOP_RUN_ID>]

Pass `--issue <KEY>` for a Jira source (the real key, e.g. `TARS-1271` — it
rides in the record while the slug rides in the run-id). Pass
`--parent-run-id`/`--loop-run-id` ONLY when harness-loop dispatched you (it
supplies the pipeline tick's run-id); a standalone run leaves them off and
still stamps `correlation_id` so its three phases join. Capture `run_id` and
`run_dir`. All artifacts go under `run_dir`.

**4. Discovery (read-only, budgeted).** Get budgets via `CLI config`. Size is
unknown until step 5, so use the S-size `max_parallel_readers` (the minimum)
for discovery. Spawn read-only subagents ONLY if the repo is non-trivial to
scan; for small repos, read directly. Each subagent needs a brief:
- Write `<run_dir>/briefs/<agent-id>.json` per the `brief` schema; task type
  `read_only_discovery` (LOW tier / haiku, MINIMAL reasoning).
- Validate it, then render the prompt with `CLI render-brief --file
  <run_dir>/briefs/<agent-id>.json` (it reproduces `templates/brief.md`'s
  seven-item shape by script — do not hand-render it) and spawn with
  `model: haiku`, read-only agent type (Explore).
- Audit each spawn:

      CLI audit --target <path> --event '{"ts":"<now>","run_id":"<run_id>","phase":"intake","agent_id":"<agent-id>","event":"spawn","data":{"tier":"LOW","task_type":"read_only_discovery"}}'

- If a subagent returns a needs-decision object: persist it to
  `findings/needs-decision-<agent-id>.json` yourself, then resolve it
  (answer inline or tighten the brief and re-issue), and audit a
  `needs_decision` event. Never leave one unresolved at phase end.

**5. Claims audit, then write the manifest** (`<run_dir>/manifest.json`,
`manifest` schema).

First the audit: extract every checkable claim the input makes about the repo
— named files/paths, workflow inputs and steps, config values, APIs,
"X already does Y" statements — and verify each against the code. Record all
of them in the manifest's `claims_audit` array (`verified` / `corrected` /
`unverifiable`, with one line of evidence). A corrected claim must also be
corrected everywhere it surfaces in the requirement (summary, details,
acceptance criteria) — never repeat the input's wording for a claim you know
is false.

Then the manifest fields:
- `requirement.summary` — one sentence; `acceptance_criteria` — testable
  bullets derived from the input; `details` — anything the planner needs that
  the summary drops.
- `requirement.change_type` — the conventional-commit bucket this change
  belongs to (`feat|fix|docs|ci|chore|refactor|perf|test`). Take it from the
  input's own prefix when it has one (an issue titled `fix: …`); otherwise
  classify by substance, not phrasing — a request worded as a feature is a
  `fix` if it remedies a defect (data loss, a11y gaps, violated
  expectations). Downstream this drives the PR title, and repos with
  semantic-versioning automation key off it.
- `size` — S/M/L with a stated rationale. Honest heuristics: S = single
  concern, few files, no schema/API changes; M = multiple files or one
  subsystem, some risk; L = cross-cutting, schema/API changes, or unknowns
  that need investigation.
- `repo_scan` — stack, key paths relevant to this requirement, notes. This is
  the planner's ONLY research input, so make it sufficient: name the concrete
  integration points (files, functions/steps, existing components or their
  absence) that planning this requirement needs. Prefer symbol/step names over
  line numbers — line numbers rot and downstream verifiers waste rounds
  nitpicking them.
- `constraints` — anything the input or repo imposes (versions, style, "don't
  touch X").
- `CLI validate --schema manifest --file <run_dir>/manifest.json` must pass —
  on failure, see **Failure handling** below for the retry rule.

**6. Verifier loop.** FIRST run the deterministic preflight and fix every
finding before spending any verifier tokens (mechanical defects — dangling
paths, empty criteria, unresolvable evidence — are cheaper to catch with a
script than with a fresh LLM round):

    CLI preflight --phase intake --run-dir <run_dir>

Exit 1 → fix the manifest per the findings, re-run until clean. Then spawn a
FRESH-context verifier (task type
`verifier_intake`: MID tier / sonnet, FULL reasoning — never cap verifier
reasoning). Give it ONLY: the manifest, the raw input, and the repo path. Its
job — ground-truth checks:
- Every file/path the manifest references exists in the repo.
- Every acceptance criterion traces to the input (no invented requirements,
  none dropped).
- The claims audit is COMPLETE and correct: no checkable repo claim in the
  input is missing from `claims_audit`, and each verdict holds up against the
  code (an audited-but-wrong verdict is a blocking failure).
- Size rationale matches the repo evidence.
It returns a score 0–1 and a list of failures tagged `blocking`/`advisory`.
Audit a `spawn` event when you dispatch the verifier (its `data.task_type`
is mandatory — a spawn event without a non-empty `task_type` is rejected as
`invalid_audit_entry`) and a `verifier_round` event after EVERY round — pass
rounds included, with round, score, result, and failures in `data` (the `CLI
anomalies` integrity scan checks succeeded runs for one `verifier_round` per
round used and a verifier `spawn`):

    CLI audit --target <path> --event '{"ts":"<now>","run_id":"<run_id>","phase":"intake","agent_id":"<verifier-agent-id>","event":"spawn","data":{"tier":"MID","task_type":"verifier_intake"}}'

Then gate mechanically (always pass the score — a high-scoring round with
only advisory failures opens immediately with residue instead of burning
another verifier round):

    CLI gate --size <size> --rounds <round> --result <pass|advisory-fail|blocking-fail> --score <score>

- `revise` → fix the manifest per the failures, loop.
- `open` → proceed. When the gate decision returns a non-null `record`,
  record it in an audit `note` event using the **standardized residue shape**
  so downstream phases can route it deterministically (gate.mjs emits
  `record: "residue"` on a high-scoring advisory fast-open and
  `record: "defect"` at the revision cap; the pass-path open has
  `record: null` and needs no note):
  - `data.type` — set verbatim to that gate `record` value (`residue` or
    `defect`), never a new ad hoc label.
  - `data.criterion` — the specific acceptance-criterion text or id the
    residue concerns (a non-empty string; this field, not `data.type` alone,
    is what makes a note routable — a type-only note is invisible to
    `residue-scan`).
  - `data.detail` — the free-form residue text, preserved verbatim so it can
    be reproduced downstream.
- `shut` (exit 1) → the phase failed: `CLI phase-end --run-dir <run_dir>
  --phase intake --status failed`, then `CLI run-end --target <path>
  --run-dir <run_dir> --status failed --reason-code verifier_blocking_cap
  --reason-detail "<summary>"`, post the status comment to Jira if
  Jira-sourced (`mcp__atlassian__addCommentToJiraIssue`, same render helper as
  step 8), and stop.

**7. Write the handoff** (`<run_dir>/handoffs/intake-to-plan.json`, `handoff`
schema, per `templates/handoff.md`): `from_phase: intake`, `to_phase: plan`,
`entry_contract` = the acceptance criteria as tagged criteria (correctness/
security/data-loss/build-breaking → `blocking`, else `advisory`), `artifacts`
= manifest + raw input file if any. Validate it — on failure, see **Failure
handling** below for the retry rule.

**8. Close the phase.** First `phase-end`, then the status comment (if
Jira-sourced, ONE comment per `templates/status-comment.md` — posted before
run-end so the run record's window contains it), then `run-end`. Do NOT
hand-compose the comment markdown: render it with `CLI render-status-comment`
and pass its stdout as the Jira comment body, so the template's shape (heading
emoji, Size line, Residue line, Next line) is assembled by script. Pass
`--notes` as the JSON array of THIS run's own recorded residue/defect notes
(the notes step 6 wrote this run — no `audit.jsonl` re-scan); the helper
populates the **Residue** line from them and omits it entirely when the array
is empty. You still author the `--next` prose yourself.

    BODY=$(CLI render-status-comment --phase intake --status succeeded --run-id <run_id> --size <size> --size-rationale "<one-line rationale>" --notes '<json-array of residue notes, or []>' --next "<what happens next>")

Then post it to Jira (Jira-sourced runs only; skip for adhoc/file):

    mcp__atlassian__addCommentToJiraIssue({ cloudId, issueIdOrKey: '<KEY>', commentBody: BODY })

Then close the record. Pass the per-skill perf fields the v2 record tracks —
`--active-ms` (gap-capped active time, from `CLI tokens-collect`'s
`active_ms`), `--agent-count` (agents by model/phase you spawned), and
`--skill-metrics` (intake slice: manifest path, size, split flag):

    CLI phase-end --run-dir <run_dir> --phase intake --status succeeded --rounds <n> --score <verifier score> --size <size>
    CLI run-end --target <path> --run-dir <run_dir> --status succeeded --tokens-by-tier '{"LOW":<n>,"MID":<n>,"HIGH":<n>}' \
      --active-ms <n> \
      --agent-count '{"by_model":{"<model-id>":<n>},"by_phase":{"Intake":<n>,"Discovery":<n>}}' \
      --skill-metrics '{"intakeManifestPath":"<run_dir>/manifest.json","size_from_intake":"<size>","splitRequired":false}'

(`run-end` finalizes, pushes telemetry, and sweeps orphaned records — it runs
even when telemetry is unconfigured. Wall-clock durations are stamped
automatically. Tokens: you still OBSERVE each spawn's raw `subagent_tokens`
number yourself (from the Agent-tool usage tag — background-task
notifications report it, synchronous Agent results may not, in which case
estimate honestly); do NOT hand-sum them or hand-write the tokens note. Feed
the observed numbers to `CLI tokens-finalize` — one `--tier
<TIER>=<amount>[:estimated]` per observation — and use its output directly:
its `tokens_by_tier` is the `--tokens-by-tier` argument above, and its
`tokens_note` (present whenever you spawned ≥1 subagent) is the `data` payload
for the tokens `note` audit event. `tokens-finalize` omits untouched tiers and
sets `estimated:true` iff any observation was flagged `:estimated` — the
anomalies scan keys off that flag:

    CLI tokens-finalize --tier LOW=<n>:estimated --tier MID=<n>
    CLI audit --target <path> --event '{"ts":"<now>","run_id":"<run_id>","phase":"intake","event":"note","data":<tokens_note from above>}'

Omit `tokens-finalize` and the note entirely only if you spawned no subagents
at all.)

**9. Report.** Tell the user: run id, size + rationale, acceptance criteria
count, claims-audit results (especially corrections — they're the headline),
where the manifest lives, and that `harness-plan-core` can now run.

## Failure handling

- `CLI validate` exits 1 → read the printed error list, fix the artifact, and
  re-validate. At most 2 repair attempts. If it still fails, finalize the run
  as failed: `CLI run-end --target <path> --run-dir <run_dir> --status failed
  --reason-code crash --reason-detail "artifact failed schema validation:
  <schema-name>"`, and stop.
- User cancels mid-run → `CLI run-end --target <path> --run-dir <run_dir>
  --status cancelled --reason-code user_cancelled --reason-detail "<where>"`.
- Any unrecoverable error → `CLI phase-end --run-dir <run_dir> --phase intake
  --status failed`, `CLI run-end --target <path> --run-dir <run_dir> --status
  failed --reason-code crash --reason-detail "<error>"`. Never exit without a
  `run-end` — an `attempted` record left behind means a crash, and the sweep
  will mark it `abandoned`.
