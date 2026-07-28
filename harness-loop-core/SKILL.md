---
name: harness-loop-core
description: >-
  One tick of the autonomous harness loop (Node-CLI spine) — recover any
  stranded run, pick the lowest open Jira issue without a delivered PR, and
  drive the full intake→plan→implement pipeline on it with fresh-context
  drivers at pinned model tiers. Use when the user says "harness loop", "run
  the loop", "loop tick", or from a scheduled session. Safe to invoke
  repeatedly: a tick with nothing to do is a no-op.
---

# harness-loop-core

You are ONE TICK of an unattended loop. Your contract: leave the system in a
state the NEXT tick can pick up from disk alone — no matter where you die.
Everything you decide comes from `loop-state`, never from memory of prior
ticks.

Let `CLI` = `node ~/.claude/skills/harness-core/tools/harness.mjs`.

## Loop invariants

1. **Lock discipline.** Exactly one pipeline in flight per target repo. The
   lock is `<target>/.harness/loop.lock`; you MUST remove it on every exit
   path, including failures and skips-after-acquire.
2. **Disk is the only state.** Next actions come from `CLI loop-state`;
   recovery comes from run dirs. Never assume a phase ran because a prior
   tick "should have" run it.
3. **Pinned driver models — a default policy, not an absolute.** The
   driver-model table below is the DEFAULT policy for a tick (cheap
   orchestration where verifiers carry quality; the strong model where
   product code gets written). An experiment arm MAY vary this default for a
   given dispatch, but only when that variation is stamped explicitly as the
   run record's `routing_policy` (via `CLI init-run --routing-policy`, see the
   Experiment arms section below); an unstamped dispatch always runs the
   default. Verifier and subagent tiers come from routing config and are NOT
   affected by this — neither by the default nor by any arm.
4. **Sequential, synchronous.** One driver at a time, dispatched with
   `run_in_background: false`. Never two phases or two issues concurrently.
5. **Dispatch phases as skills, never as a raw file read or a Workflow
   script.** Each driver's very first action is `Skill({skill:
   "harness-intake-core" | "harness-plan-core" | "harness-implement-core"})`.
   Reading the target SKILL.md yourself and handing the driver its text, or
   reimplementing this ladder as a `Workflow` script whose `agent()` calls
   carry a prompt instead of a Skill invocation, both skip whatever the Skill
   tool's own loading path carries that a plain file Read doesn't — don't
   substitute either.
6. **Individual-level data is never overwritten, only aggregated.** A driver's
   own self-reported figures (e.g. `tokens_by_tier` in its `record.json`) must
   keep working standalone, with no dependency on this loop ever having run.
   harness-loop's job is to aggregate and summarize those numbers (and to
   help a child skill finalize itself during stranded-run cleanup) — never to
   replace what a run already said about itself. See step 6/7's token
   handling for the concrete case.

## Tick workflow

**1. Resolve the target repo AND its issue source** from the invocation
argument (alias in `~/.claude/skills/harness-core/config/user.json` `repos`
registry, or a path), else `defaultRepo`. No target resolvable → report and
stop. Read the resolved repo's `issue_source` from that same registry — it is
`jira` or `github` (unset defaults to `jira`; the CLI helper `issueSourceFor`
encodes this). For a `github` repo, also read its `github` field (the
`owner/repo` slug). This `ISSUE_SOURCE` (and `GITHUB_SLUG` when github) governs
step 4's pick-work-item, the driver prompts' input shape, and every
status-comment sink — pass it into every driver prompt.

**2. Take the lock.** If `<target>/.harness/loop.lock` exists and its mtime
is under 2 hours old → another tick is mid-pipeline: report "tick skipped:
pipeline in flight" and STOP (do not remove it). If it exists but is 2+
hours old, the prior tick died: delete it and continue (step 4's stranded
handling cleans up its run). The `.harness/` dir may not exist yet on a
never-before-run repo (`init-run` creates it later, but the lock precedes it),
so ensure it first, then write the lock:

    mkdir -p <target>/.harness
    date -u +%Y-%m-%dT%H:%M:%SZ > <target>/.harness/loop.lock

**3. Sweep** (finalizes and syncs orphaned records deterministically):

    CLI sweep --target <target>

**4. Pick the work item.** List the target's open issues ascending by number,
then take the FIRST whose `CLI loop-state --target <target> --issue <ID>`
reports `next` != `done`. The listing depends on `ISSUE_SOURCE`; `loop-state`
and everything after it are identical either way (the state derives from
`record.issue` on disk, which is source-neutral).

- **`ISSUE_SOURCE == jira`:** resolve the project key + cloudId from the target
  (the `projects.json` prefix whose `repoPath` is this target), then via the
  Jira MCP:

      mcp__atlassian__searchJiraIssuesUsingJql({ cloudId,
        jql: 'project = <KEY> AND statusCategory != Done ORDER BY key ASC',
        fields: ['key'], maxResults: 50 })

  The work-item id is the Jira KEY (e.g. `TARS-1271`).

- **`ISSUE_SOURCE == github`:** no cloudId / project-key resolution — list the
  repo's open issues by number:

      gh issue list --repo <GITHUB_SLUG> --state open --json number,title --jq 'sort_by(.number)'

  The work-item id is the issue NUMBER (e.g. `2`). Beware: `gh issue list` also
  returns PRs on some setups — the `--json number` of an issue is fine, but do
  NOT treat a PR as a work item; the `number,title` projection over
  `gh issue list` is issues-only.

For each id in order, run `CLI loop-state --target <target> --issue <ID>` and
take the FIRST whose `next` is not `done`. Issues at `done` have a delivered PR
— transitioning the issue's tracker state is the user's business, skip them.
No candidate → no-op tick: append the loop log line (step 7), remove the lock,
report, stop.

**5. Repo hygiene — resolve the base branch, then sync to it.** The base is
NOT always `main`: a ticket that is one phase of an epic targets the EPIC
FEATURE BRANCH, and diffing against `main` would falsely read the epic's
not-yet-merged work as missing (a measured run flagged TARS-1271's clientFetch
wrapper as a blocking prerequisite when it existed on the feature branch). So:
- Determine the base: if the ticket's description or parent epic names a
  feature/integration branch (or `git -C <target> branch -a` shows an obvious
  epic branch the ticket's work belongs to), that is the base; else `main`.
- `git -C <target> fetch origin`, then checkout + fast-forward the base branch
  (`git -C <target> checkout <base> && git -C <target> pull --ff-only`).
- Pass the resolved base into every driver prompt so implement branches from it
  (implement creates its work branch from the current branch — leave the base
  checked out).
Run `git -C <target> status --short` and note any pre-existing uncommitted
local changes: they must be left untouched and NEVER committed by any driver
(pass this warning into every driver prompt).

**6. Climb the ladder.** Starting from the work item's `next`, run phases in
order (intake → plan → implement), one fresh-context driver each:

| phase | driver model | skill the driver executes |
|---|---|---|
| intake | `sonnet` | `Skill({skill: "harness-intake-core"})` |
| plan | `sonnet` | `Skill({skill: "harness-plan-core"})` |
| implement | `opus` | `Skill({skill: "harness-implement-core"})` |

**Open the pipeline run FIRST (parent-loop association).** Before the first
driver, open THIS tick's own pipeline run — it is the header row that ties the
three phase runs together on the dashboard:

    CLI init-run --target <target> --repo <slug> --kind pipeline --source issue-<slug-of-KEY> --issue <KEY> --repo-path <target> --correlation-id "<KEY>-<runTs>"

Capture its `run_id` as `LOOP_RUN_ID` and its `run_dir` as `LOOP_RUN_DIR` (you
finalize it in step 7), and reuse the SAME `CORRELATION_ID` (`<KEY>-<runTs>`,
generated once here) for every phase. Pass BOTH into every driver's `init-run` (via the prompt's input):
`--parent-run-id <LOOP_RUN_ID> --loop-run-id <LOOP_RUN_ID> --correlation-id
<CORRELATION_ID>`. That is what makes `parent_run_id`/`loop_run_id`/
`correlation_id` join the intake, plan, and implement records under this tick.
Finalize the pipeline run in step 7 (`CLI run-end` with the tick's outcome).

- If `loop-state` reported a `stranded` run for this issue, the FIRST
  dispatch is the recovery variant of that run's phase (see prompt template
  below) instead of a fresh start.
- **Immediately after EVERY driver returns** (before re-running `loop-state`):
  the `Agent(...)` call's result carries a `<usage>subagent_tokens: N</usage>`
  tag — N is that dispatch's true total cost, observed by you, not the driver.
  The driver's own `run-end` could only self-report the subagent_tokens of
  its OWN nested spawns (verifier rounds) as `tokens_by_tier` — it cannot see
  its own total from inside its own context. Do NOT overwrite that figure —
  it's the individual run's own raw report and must keep standing on its own
  for anyone debugging that run in isolation, with no dependency on this
  orchestrator ever having run. Add your observation ALONGSIDE it instead:

      CLI record-observed-tokens --run-dir <run_dir from the driver's own report> --total <N> --tier <TIER> --source agent_tool_usage_tag

  `<TIER>` is `MID` for intake/plan (sonnet) and `HIGH` for implement (opus),
  per `tier_models` in `~/.claude/skills/harness-core/config/routing.json`.
  Keep each phase's N — step 7's `tokens` field needs the sum for this tick.
  A dispatch that died before returning has no N to record; leave its
  `record.json` for the next tick's stranded handling, same as today. This is
  harness-loop's whole role here: aggregate and summarize what each run
  already reported about itself, never author over it.
- After EVERY driver returns, re-run `CLI loop-state` and act on `next`:
  advanced → dispatch the next phase; unchanged with the phase now `failed`
  → stop climbing (do not cascade a broken pipeline); unchanged and still
  `attempted` → the driver died mid-phase: leave it for the next tick's
  stranded handling, stop climbing.
- Hard cap: at most 4 driver dispatches per tick (one recovery + three
  phases). At the cap, close the tick normally.

**7. Close the tick — ALWAYS, on every path:**

Scan recent telemetry for red flags and **capture the scan's JSON to a file**
(scan window widened from the old 3-record peek to 20 — a single tick can
touch several runs, and a 3-record window silently drops older ones; drop the
flag entirely if you want the routing default of 50). Redirect stdout with
`>` and never pipe — a pipe would mask the scan's own exit code, and that exit
code is `1` precisely when findings exist (that is the normal, expected case
here, not a failure — the redirect still captures the full JSON):

    CLI anomalies --repo <repo-slug> --limit 20 > <target>/.harness/anomalies-scan.json

Then compose and append the loop.jsonl line with a single `CLI loop-record`
call — do NOT extract the anomalies count with a `node -e` one-liner or
hand-build the JSON line. `loop-record` reads the anomalies count out of the
captured scan file (exactly the old one-liner's `findings.length`, computed by
code, never estimated) and reads each dispatched run's `tokens_observed` — the
numbers you already persisted in step 6 via `record-observed-tokens`;
loop-record discovers nothing new, it only reads them back and sums them —
then appends the composed line to `<target>/.harness/loop.jsonl`:

    CLI loop-record --target <target> --issue <KEY> --actions '["<phase>:<status>",...]' --outcome delivered|advanced|failed|noop|interrupted --anomalies-scan <target>/.harness/anomalies-scan.json [--pr-url <url>] [--phase-run <phase>=<run_dir> ...]

Then finalize THIS tick's pipeline run (opened in step 6) so the parent record
carries the tick's outcome and syncs:

    CLI run-end --target <target> --run-dir <LOOP_RUN_DIR> --status <succeeded if delivered/advanced, failed if the pipeline failed, cancelled if interrupted>

Pass one `--phase-run <phase>=<run_dir>` for every phase THIS tick dispatched,
in order (omit them all for a noop tick). loop-record builds the exact line
shape (ts/issue/actions/outcome/pr_url/anomalies/tokens); a phase whose run has
no `tokens_observed` (a stranded run recovered from a PRIOR tick, whose
`subagent_tokens` you never witnessed) is emitted with a `null` `by_phase`
entry and listed in `unknown_phases` automatically — do not guess or backfill
it. This is the line shape it produces:

    {"ts":"<now>","issue":<n>,"actions":["<phase>:<status>",...],"outcome":"delivered|advanced|failed|noop|interrupted","pr_url":"<url or null>","anomalies":<count>,"tokens":{"total":<n or null>,"by_phase":{"<phase>":<n or null>,...},"unknown_phases":["<phase>",...],"source":"agent_tool_usage_tag"}}

**Token accounting — read before filling in `tokens`.** Two different numbers
exist for the same dispatch and they do NOT reconcile with each other; do not
average or mix them:

- **Orchestrator-observed (authoritative for this log):** after each driver
  `Agent(...)` call returns, its tool result carries a `<usage>subagent_tokens:
  N</usage>` tag. That N is the one number you directly witnessed — not
  computed, not self-reported. It's the same N you already persisted per-run
  via `CLI record-observed-tokens` in step 6 (that run's `tokens_observed`
  field). You do NOT sum these by hand: `loop-record` reads each dispatched
  run's `tokens_observed` back off disk (via the `--phase-run` pairs you pass
  it) and computes `tokens.total` and per-phase `tokens.by_phase` itself. This
  loop log is an aggregation of numbers already recorded at the individual
  run level, not a second, competing measurement.
- **Driver self-reported (`tokens_by_tier`, stored in that run's `record.json`
  via `run-end --tokens-by-tier`):** the driver sums the `subagent_tokens` of
  its OWN nested Agent calls (e.g. verifier rounds). This is structurally
  unable to include the driver's own reading/writing/reasoning tokens — a
  subagent cannot see its own total dispatch cost from inside its own context,
  only the orchestrator can, after the dispatch returns. It stays intact in
  `record.json` (never overwritten) as that run's own individual-level detail
  — useful on its own for anyone debugging that one run standalone — but
  treat it as a per-run detail here, never as this tick's cost figure.
- If a phase was recovered from a stranded run made in a PRIOR tick (so you
  never observed its `subagent_tokens`), its run has no `tokens_observed` on
  disk, so `loop-record` emits that phase's `by_phase` entry as `null` and
  lists it in `unknown_phases` automatically — do not guess or backfill from
  the driver's self-report.

Remove the lock. Then report: issue worked, phases run with rounds/scores,
PR URL if delivered, the tick's token total (and any unknown phases),
anomalies findings, and what the next tick will do. If a push-notification
tool is available and a PR was delivered, send one with the PR title and URL.

## Experiment arms (routing_policy)

Driver-model A/B experiments are stamped, never implicit. The driver-model
table in step 6 is the DEFAULT arm; any dispatch that deviates from it is an
experiment arm and MUST record which arm it ran under via the run record's
`routing_policy` field (stamped with `CLI init-run --routing-policy <arm>`,
per invariant 3). An unstamped run (`routing_policy: null`) is the default
policy by definition.

**Arm-assignment protocol.**

- **One arm per tick.** A single tick never mixes arms across its phases;
  whatever arm is active governs every dispatch that tick makes. This sits
  cleanly on top of invariant 4's sequential, synchronous dispatch — one arm,
  one driver at a time.
- **Assignment schemes** (pick exactly one per experiment; do not interleave):
  either *alternate per issue* (issue N → arm A, issue N+1 → arm B, …), or run
  *paired reruns of the same issue on throwaway branches* (run the issue once
  under each arm, then discard the branches). Paired reruns hold the issue
  constant across arms; per-issue alternation spreads arms across the natural
  backlog.
- **Every dispatch under an active arm is INTENDED to stamp `routing_policy`**
  via the `CLI init-run --routing-policy` flag, so each resulting record is
  attributable to its arm end-to-end (through the loop-state and telemetry-sync
  paths).

**What this change does NOT wire up (honest scope).** This section documents
the stamping MECHANISM and the protocol for its intended future use — it is
NOT an already-operational, end-to-end-wired experiment. This work does not
thread `--routing-policy` through harness-intake/SKILL.md's, harness-plan/
SKILL.md's, or harness-implement/SKILL.md's own `CLI init-run` calls, nor
through this file's own "Driver prompt template" dispatch injection point below
— none of those four files are modified by this change. Until that wiring lands
in the dedicated future arm-enabling issue, every live loop dispatch still runs
the default policy and records `routing_policy: null`; the flag exists and is
tested, but no live call site passes it yet. Actually turning arms on is
explicitly deferred, consistent with the no-arms-yet constraint.

**Arm-analysis contract.** When arms do eventually run, their results are read
against this fixed contract (complements step 7's token accounting):

- The **primary metric is tokens/issue, INCLUDING all verifier rounds** — the
  full cost of delivering an issue under an arm, not just the driver's own
  dispatch. A cheaper driver that provokes extra verifier rounds is not
  cheaper; the verifier rounds are counted in.
- **Secondary metrics are rounds-used and probe-calibrated catch rate** — how
  many verifier rounds an arm needed, and its defect-catch rate measured
  against the calibration probe (never a raw self-reported verifier score).
- **Near-ceiling verifier scores alone are explicitly rejected as sufficient
  evidence.** A 0.97 does not settle an arm; a high score with no
  probe-calibrated catch-rate backing is not acceptance-grade evidence on its
  own.
- **Accumulation runs to a stated precision target, not a fixed sample count.**
  Keep pairing arms until the tokens/issue difference is resolved to a
  pre-set precision (confidence interval), rather than stopping at an arbitrary
  fixed n.

This document takes **no position on the MID-vs-HIGH FLOOR question** — whether
the implement driver's floor should be MID or HIGH is the operator's call to
arbitrate after future arm results, not something this loop skill decides.

## Driver prompt template

Every driver dispatch uses this shape (fresh-context, synchronous, model per
the table):

> You are a FRESH-CONTEXT DRIVER for one phase of an autonomous dev harness.
> You have no memory of any prior harness runs — execute the skill exactly
> as written, not from any assumption.
>
> 1. Invoke the Skill tool for this phase: `Skill({skill: "<phase-skill-name>"})`
>    (one of `harness-intake-core` | `harness-plan-core` |
>    `harness-implement-core`). Do NOT substitute a plain file Read of its
>    SKILL.md — only the Skill tool's own loading path is guaranteed to carry
>    everything the skill actually needs in effect; a manual Read can silently
>    miss it.
> 2. Execute it step by step, exactly, with this input: <work-item id (Jira KEY
>    e.g. TARS-1271, or GitHub issue number e.g. 2) | upstream run id and its
>    artifact paths>. When you call `CLI init-run`, pass `--parent-run-id
>    <LOOP_RUN_ID> --loop-run-id <LOOP_RUN_ID> --correlation-id
>    <CORRELATION_ID>` (values below) so this phase joins the tick's pipeline
>    run.
> 3. The target repo is <target path> (alias <alias> in
>    ~/.claude/skills/harness-core/config/user.json); the base branch is
>    <resolved base from step 5>. LOOP_RUN_ID=<...>, CORRELATION_ID=<...>.
>    ISSUE_SOURCE=<jira|github>; for github, GITHUB_SLUG=<owner/repo>. The
>    skill branches its fetch/normalize and status-comment sink on ISSUE_SOURCE
>    — pass these through.
>
> Operational rules (from measured driver failures — follow strictly):
> - Dispatch EVERY subagent synchronously (run_in_background: false); wait
>   for each result before continuing.
> - Spell out every shell command fully; never define shell variables or
>   aliases. The CLI is always invoked literally as:
>   node ~/.claude/skills/harness-core/tools/harness.mjs <subcommand> ...
> - Pre-existing uncommitted local changes in the target repo (listed here:
>   <git status output>) must be left untouched and never committed.
> - Pipes mask exit codes; check the command's own exit status when it
>   matters.
> - The skill's audit/gate/preflight/phase-end/run-end calls are mandatory,
>   in the skill's order: spawn event for every subagent including
>   verifiers, verifier_round after EVERY round (pass rounds included),
>   structured estimated:true/false tokens note.
> - <phase-specific truths: for plan/implement, the manifest/plan are the
>   truth — never re-read the source issue; carry forward any intake
>   claims-audit corrections verbatim. For implement: PR title prefix from
>   the manifest's change_type + the work-item id. If ISSUE_SOURCE==jira, the
>   Jira key rides in the title and summary only (NO GitHub Closes-# — the Jira
>   issue transitions in Jira after review). If ISSUE_SOURCE==github, the PR
>   body's `Closes-#<number>` is desired (auto-closes the issue on merge) —
>   render-pr-body already emits it from --issue <number>. Either way, open the
>   PR but NEVER merge it.>
>
> When completely done (after run-end), report: run_id, run_dir, verifier
> rounds + final score, tokens_by_tier (and whether estimated), <phase
> deliverable: size+claims audit | units+contract | branch+PR URL +
> per-criterion results>, and anything unusual.

**Recovery variant** (stranded run): replace item 2 with —

> 2. A prior driver died mid-phase. Its run dir is <run_dir>. Re-establish
>    state from disk (record.json, audit.jsonl, artifacts present) and
>    either FINISH the phase from where the evidence shows it stopped, or —
>    if the work cannot be trusted or completed — finalize it as failed per
>    the skill's failure handling (phase-end + run-end with reason). Never
>    leave the record in `attempted`.

## Failure handling

- A driver dies (session limit, stall, crash): do NOT retry in this tick.
  Re-run `loop-state`; write the loop log line with outcome `interrupted`;
  remove the lock; report. The next tick recovers.
- You (the tick) hit an unrecoverable error: remove the lock, append the
  loop log line, report. The lock's 2-hour staleness window is the backstop
  if you die before reaching this.
- Budget sanity: one tick never works more than one issue. Ticks are cheap
  to skip; limits reset — the loop's cadence comes from the scheduler, the
  serialization comes from the lock and the ladder.
