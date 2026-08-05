---
name: alfred
description: Take a single unit of work — a plain prompt, a GitHub issue, or a Jira ticket — through implementation, gated verification, and PR, while capturing a complete run record (tokens, cache read/creation, cost) for every run. Use this skill whenever the user asks to "work a ticket", "land a PR", "run the loop", passes an issue URL/key expecting a finished PR, invokes it as the body of a batch/loop over tickets, or asks to track what an agentic run cost.
---

# Alfred (loop body)

This skill processes **exactly one work item per invocation**. It is the body of a loop, not the loop. Batch = an orchestrator invoking this skill once per ticket. Never process multiple tickets in one run.

Four rules override everything else:

1. **Always finish the run record.** Create it first, update it every phase, close it in every terminal state — success, needs_decision, too_large, blocked, or failed.
2. **Never open a PR that has not passed Phase 4.**
3. **When blocked, escalate — don't deliberate.** If you hit a decision you cannot make from the information in front of you, set `status: "needs_decision"`, write one paragraph stating the exact question and the options, go to Phase 6, and stop.
4. **The ticket is a hypothesis, not an authority.** Verify its claims against the repo (file counts, "already broken", "N files affected") before planning around them. Override a wrong claim; note the correction in `work-item.md`. Never create Jira subtasks from a ticket's own checklist — sub-items become phased commits on the PR, not new tickets.

**Asking the user:** in an interactive session, ask your question and wait. In a headless/batch run (`claude -p`, no user present), never wait — apply rule 3 instead. The recorded question IS the deliverable of that run.

**Never-decide list — always escalate, never guess:** irreversible/destructive operations (delete, drop, force-push, rewriting history); security, auth, permissions, or credential changes; public API/contract breaking changes; legal, compliance, or PII handling; anything past a cost or scope threshold the user set. These are business-risk calls, not technical ones — the repo cannot tell you the acceptable risk.

Stay repo-agnostic: detect conventions from the repo (README, CONTRIBUTING, CI config, test layout, existing branch names). Never assume a package manager, test command, or branch naming scheme without checking.

---

## Phase 0 — Run record + preflight

**Step 0.1 — Create the run record** before anything else:

```bash
RUN_ID="run-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
mkdir -p .runs/$RUN_ID
grep -qxF '.runs/' .git/info/exclude 2>/dev/null || echo '.runs/' >> .git/info/exclude
```

Write `.runs/$RUN_ID/run.json`:

```json
{
  "run_id": "<RUN_ID>",
  "started_at": "<ISO 8601 UTC now>",
  "ended_at": null,
  "input": { "type": "prompt | github_issue | jira_ticket", "ref": "<raw prompt, issue URL/number, or Jira key>", "title": "" },
  "repo": { "remote": "", "base_branch": "", "work_branch": "" },
  "status": "in_progress",
  "phases": [],
  "usage": null,
  "cost": null,
  "pr": null,
  "failure_reason": null
}
```

After each phase, append to `phases`: `{"phase": "<name>", "started_at": "...", "ended_at": "...", "outcome": "<one sentence>"}`.

**Disk is the source of truth.** If your context was compacted, or you are ever unsure of run state, re-read `run.json`, `work-item.md`, and `plan.md` before acting — never reconstruct state from conversation memory. A compaction is a resume, not a restart.

**Step 0.2 — Preflight.** Run these checks now, in order. Any failure → `status: "failed"`, `failure_reason` set to the failed check, go to Phase 6. Do not start work on a broken foundation.

```bash
git status --porcelain          # must be empty (clean tree). If not: stop — do not stash someone's work.
git fetch origin                 # must succeed (remote reachable)
git remote show origin | grep 'HEAD branch'   # record as base_branch in run.json
gh auth status                   # must succeed if input is a GitHub issue OR the PR will go to GitHub
```

If the input is a Jira key, confirm a Jira MCP/CLI is available now — not in Phase 1.

**Step 0.3 — Blocked check.** If the work item already carries a block marker from a prior run (GitHub label `alfred:blocked`, or a Jira label/flag of the same name), skip it: `status: "blocked"`, `failure_reason: "already blocked, awaiting human reply"`, go to Phase 6 without touching the tree. A human removing the marker is the only unblock gesture — do not re-attempt a blocked item to "see if it works now."

## Phase 1 — Intake (normalize; infer nothing you can look up)

**Step 1.1 — Identify type and fetch:**

| Input looks like | Type | Action |
|---|---|---|
| Free text, no issue reference | `prompt` | The text is the requirement |
| GitHub URL or `#123` | `github_issue` | `gh issue view <ref> --json title,body,labels,comments` — read comments; acceptance criteria often live there |
| Key like `ABC-123` | `jira_ticket` | Fetch via the Jira tooling confirmed in preflight |

**Step 1.2 — Dedup check.** Search for an existing open PR for this work item (`gh pr list --search "<issue number or ticket key>" --state open`). If one exists → `needs_decision` ("PR #N already open for this item — resume, replace, or abort?"). Never open a duplicate.

**Step 1.3 — Write `.runs/$RUN_ID/work-item.md`** with exactly these sections:

1. **Requirement** — restated in 2-5 sentences using the source's own words wherever possible. Do not embellish or expand scope.
2. **Acceptance criteria** — numbered list. Copy explicit criteria verbatim, marked `(explicit)`. Add an inferred criterion ONLY when the requirement is unverifiable without it, marked `(inferred)`. Fewer inferred criteria = better run; every inferred criterion is a guess the verifiers will hold you to.
3. **Out of scope** — what you will NOT do.
4. **Corrections** — any ticket claim that grep/repo inspection contradicted (e.g. "ticket says 12 files, repo has 3"), and which one you trusted (always the repo). Empty section is fine; a wrong claim silently accepted is not.

**Step 1.4 — Size gate (early exit — cheapest place to stop).** A ticket too large for one PR must exit HERE, before planning or code. Check these signals against the source ticket and your work-item.md:

Hard signals — ANY ONE triggers the exit:
- Jira issue type is Epic, or the GitHub issue carries an `epic` label
- The ticket body contains a checklist of more than 3 unchecked sub-tasks spanning different areas

Soft signals — TWO OR MORE trigger the exit:
- More than 7 explicit acceptance criteria
- The requirement contains multiple independent user-facing deliverables (each would make sense as its own PR)
- Satisfying it requires touching 3+ unrelated areas (e.g., frontend + backend + infra/migration)
- You cannot restate the requirement in 5 sentences without dropping a deliverable

On trigger: set `status: "too_large"`, and write `.runs/$RUN_ID/suggested-split.md` proposing 2-4 sub-tickets — for each, a title, a one-line scope, and which acceptance criteria it absorbs. Every original criterion must land in exactly one sub-ticket. **Do not create these as Jira subtasks or GitHub issues yourself** — propose the split as text; a human decides whether and how to file it. Then apply the asking rule: interactive → present the split and ask the user to break up the ticket; headless → the split file and status ARE the output. Go to Phase 6. Do not plan, do not code.

**Step 1.5 — Ambiguity check.** If the requirement is ambiguous in a way that would change the code you write, apply the asking rule from the top of this skill now. Do not implement a guess.

## Phase 2 — Plan (one plan, written down; no alternatives)

Write ONE plan in `.runs/$RUN_ID/plan.md` — the most direct approach that satisfies the acceptance criteria:

```markdown
# Plan
- Approach: <3-6 sentences: what changes, where, and how>
- Files touched (estimate): <list>
- Test plan: <which tests you will add/update and what each asserts>
- Risks: <bullet list>
```

Do not enumerate alternative plans or score options. If two approaches genuinely both satisfy the criteria, pick the one with the smaller diff and note the other in Risks in one line. If you cannot find ANY approach that satisfies the criteria with the repo as it is → `needs_decision`.

## Phase 3 — Implement

1. `git checkout -b <branch>` from the base branch recorded in preflight. Match the repo's existing branch naming (inspect `git branch -r`); default `<feat|fix|chore>/<short-slug>`.
2. Implement the plan. If mid-implementation the plan proves unviable, do not silently improvise a new architecture: update `plan.md` with what changed and why, note it in the run record, and continue only if the change is a narrow adjustment. A fundamentally different approach → `needs_decision`.
3. Commit in small, coherent units. Each commit must leave the repo in a state you could reset back to.
4. Detect and run the repo's own checks (test/lint/typecheck/build) locally. Fix failures you introduced before Phase 4.
5. Write the tests from the Test plan as part of this phase — they are implementation, not an afterthought.

## Phase 4 — Verify (gates, then reviewers)

Verification is two stages. **Stage A gates are deterministic pass/fail — all must pass before any Stage B reviewer runs.**

### Stage A — Gates (run yourself, in order)

Commit all work first — gates run on committed state only.

**Gate 1 — Existing tests (regression):** run the repo's full detected check suite. Everything that passed on the base branch must still pass. Any failure = gate failed.

**Gate 2 — New tests exist and pass:** `git diff <base_branch>...HEAD --stat` must include the test files from your Test plan, and running those tests must pass. If the ticket is genuinely test-exempt (docs-only, config-only, comment-only), record `"gate2": "exempt"` with a one-line reason. Missing tests for a behavior change = gate failed → write the tests, restart Stage A.

Record in the phase entry: `{"gates": {"gate1": "pass", "gate2": "pass|exempt"}}`. Both green → Stage B.

### Stage B — Reviewers (three subagents, in parallel, uncapped)

Launch three subagents with the Task/Agent tool, one per template below. No agent-dispatch tool available → run the same three templates yourself as sequential passes with no shared scratch state, recording each verdict before starting the next. Never skip a reviewer.

**Verdict format (all reviewers):** respond with ONLY this JSON, no prose before or after:

```json
{"verdict": "pass" | "revise", "findings": [{"severity": "blocker" | "major" | "minor", "location": "<file:line or area>", "description": "<specific, actionable>"}]}
```

A `revise` verdict requires at least one blocker or major finding. Minor-only findings = `pass` with findings listed.

Before launching, save the diff once: `git diff <base_branch>...HEAD > .runs/$RUN_ID/diff.patch`. Pass reviewers FILE PATHS, not pasted contents — subagents share the filesystem and read in their own context, which keeps the parent context small.

**Reviewers 1 and 2 receive paths to:** `work-item.md`, `plan.md`, and `diff.patch`, plus their charter:

- **Reviewer 1 — Correctness:** "For EACH numbered acceptance criterion in the work item, state whether the diff satisfies it, citing file and line evidence. Any unsatisfied or partially satisfied criterion is a blocker."
- **Reviewer 2 — Quality:** "Review the diff for readability, naming, duplication, and consistency with this repo's existing patterns (read neighboring code first to establish the patterns). Deviations from repo idioms are major; style nits are minor."

**Reviewer 3 — Fresh-context QA receives ONLY the paths to work-item.md and diff.patch** — not plan.md, not any narrative, not other reviewers' output — plus this charter:

"You are QA with no knowledge of how or why this was built. Assume the change is broken and try to prove it: edge cases and boundary inputs (empty, null, max-size, unicode, concurrent); misuse paths; swallowed or mis-typed errors; security surfaces (auth, input validation, secrets, injection); readings of the work item this diff does NOT satisfy; behavior changes with no test asserting them. Untested behavior change = major. Security gap or reproducible break = blocker. Every finding must include the input or sequence that breaks it."

**Reviewer failure rules (apply mechanically):**

- Output is not parseable as the verdict JSON → re-ask that reviewer once with "Your previous response was not valid verdict JSON. Respond again with only the JSON." Still unparseable → record `{"verdict": "revise", "findings": [{"severity": "major", "location": "reviewer", "description": "reviewer returned unparseable output"}]}` and continue.
- Reviewer returns nothing / stalls (no output after a reasonable wait — treat ~10 minutes as the ceiling) → relaunch that reviewer once. Stalls again → `needs_decision` ("reviewer <name> failed twice; verification incomplete"), go to Phase 6. Do not open the PR on partial verification.

### Revision loop (follow exactly)

1. Record the cycle in the phase entry: `{"cycle": 1, "gates": {...}, "verdicts": {"correctness": "...", "quality": "...", "qa": "..."}, "blockers": <n>, "majors": <n>}`.
2. All three `pass` → Phase 5.
3. Otherwise: fix every blocker and major (minors optional), commit, re-run **both gates** (cheap; any fix can regress), then re-run only the reviewers that said `revise`. If a fix changed behavior beyond what the findings pointed at, also re-run Fresh-context QA.
4. Maximum 3 cycles. After cycle 3 with any gate failing or `revise` remaining → `needs_decision`, summarize unresolved items, skip Phase 5, go to Phase 6.

**A green gate proves the fix's existence, not its tightness.** If a Stage A regression test could pass on the code both before and after your fix, it is not testing the fix — before closing Gate 2, break your own fix in the most plausible wrong direction once and confirm the test you just wrote catches it, then restore.

## Phase 5 — PR (push, open PR, Jira cleanup — no prompts, ever)

This phase never asks the user anything, in interactive or headless mode alike — every decision below is a deterministic rule, not a judgment call. That's what makes it safe to run unattended.

**Step 5.1 — Version bump (determines the PR title prefix).** Never ask; derive it:

- `jira_ticket` input: issue type **Bug** → patch (`fix`); **Story/Task** → minor (`feat`). (Epic never reaches here — Phase 1.4 exits first.) Override to major (`feat!`) if a `breaking-change` label is present, or an acceptance criterion documents a removed/renamed public API or contract.
- `github_issue` / `prompt` input: default to patch (`fix`/`chore`). Minor (`feat`) only if the issue carries a `feature`/`enhancement` label, or the plan's Approach describes new user-facing capability rather than a fix. Same breaking-change override as above → major.

**Step 5.2 — Check for an existing PR:** `gh pr list --head <work_branch> --json number --jq '.[0].number'`. If one exists, this run is adding commits to it, not opening a new one — skip to 5.4 after the push.

**Step 5.3 — Push:** `git push -u origin <work_branch>`. Do this BEFORE `gh pr create` — `gh pr create` can push via the GitHub API itself if the branch is missing remotely, and that path runs no git hooks. Pushing first keeps pre-push hooks (tests, lint, build) in the loop. Never use `--no-verify` or any hook-bypass flag. Push failure (pre-push hook rejected it) → fix the issue and retry; do not bypass.

**Step 5.4 — Open or update the PR:**

- No existing PR: `gh pr create --draft` (always draft unless the repo's own convention says otherwise — an unattended run should never look ready for review by default) with title `{type}({TICKET}): {description}` per Step 5.1 (omit the ticket segment for `prompt` input with no ticket). Link the source: `Closes #<n>` for GitHub.
- Existing PR: commits from Step 5.3 already landed on it via the push — no new `gh pr create` call needed.

**PR body**, in order: what/why summary → acceptance criteria checklist with evidence → verification summary (gate results, reviewers run, cycles used, findings resolved) → check results → a `## QA Notes` section with numbered manual-testing steps (this section is Jira Cleanup's source of truth in 5.6).

**Step 5.5 — Record in run.json:** `{"url": "...", "number": <n>, "branch": "..."}` under `pr`.

**Step 5.6 — Jira Cleanup (only when `input.type == "jira_ticket"` AND a PR was created or updated in this phase):**

1. Convert the PR body's `## QA Notes` section into ADF (numbered list, `Expected:` lines bolded). No QA Notes section → minimal fallback `{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"See PR: <url>"}]}]}`.
2. Fetch the ticket's current status and subtasks (`getJiraIssue`, fields `["status","subtasks"]`) and available transitions (`getTransitionsForJiraIssue`).
3. If current status is "To Do", transition to "In Progress" first, then to "Code Review"/"Ready for Code Review" with the QA notes ADF attached. Otherwise transition directly to Code Review.
4. For each subtask: same transition, no QA notes (the parent holds them for the whole story).
5. Errors here (Jira unreachable, no transition found, ticket not found) never block the PR success output — log and continue; the PR is the deliverable, Jira status is a courtesy update.

## Phase 6 — Close the run record (cost capture; runs in EVERY terminal state)

**Source A (preferred, documented):** when invoked via `claude -p --output-format json`, the final result payload includes `total_cost_usd`, a per-model breakdown, `session_id`, and `usage`. The orchestrator tees it to `.runs/$RUN_ID/result.json`; if present, copy its numbers.

**Source B (fallback, observed behavior — best effort):** locate this session's transcript JSONL under `~/.claude/projects/<project-dir>/` (most recently modified file for the current project; hooks expose `transcript_path` if configured). Sum per-message `usage` fields: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and cost.

Finalize `run.json`:

```json
"ended_at": "<ISO 8601 UTC>",
"status": "success | needs_decision | too_large | blocked | failed",
"usage": {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
"cost": {"total_usd": 0.0, "source": "result_json | transcript | unavailable", "per_model": {}}
```

Keep the four token classes separate — cache read vs. creation is what makes cache-hit-rate analysis possible later. Neither source available → `"source": "unavailable"`, never omit the field. Cross-run aggregation is a separate follow-up script; your obligation is one complete, schema-consistent `run.json` per run.

## Batch usage (for the orchestrator, not this skill)

One invocation per ticket:

```bash
for TICKET in ABC-101 ABC-102 ABC-103; do
  claude -p "Use the alfred skill on $TICKET" \
    --output-format json > "batch-results/$TICKET.json"
done
```

The wrapper should check the result JSON's `subtype`/status field, not just the exit code — a refusal or stall does not always produce a nonzero exit. A run that closes `status: "blocked"` should be skipped on later ticks of the same loop, not retried, until a human clears the block marker.

## Failure handling

- Task fails or is blocked → still run Phase 6. `status: "failed"` or `status: "blocked"` + `failure_reason` is valuable data; a missing run record is not.
- Partial work → leave the branch pushed without a PR and note the last good commit in the run record so a resumed run can continue from it.
- **Blocked item protocol:** when you reach `needs_decision` in a headless run with no clear path forward (not the ordinary ambiguity-check ask, but a genuine dead end — unsatisfiable acceptance criteria, missing repo access, or verification that cannot converge in 3 cycles), also comment on the source ticket/issue naming the exact obstacle, and apply a block marker (GitHub label `alfred:blocked`, or the Jira equivalent) so a later batch tick skips it instead of re-attempting the same failure. Do not stack duplicate comments on repeat detection (Step 0.3 handles that) — one comment per genuine block, ever.
