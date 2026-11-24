---
name: push-branch
description: Push branch to GitHub and create or update a PR with auto-populated description. Runs unattended (no prompts); infers version bump and create-vs-update.
model: haiku
---

# Push Branch & Create PR

Push your current branch to GitHub and automatically create a PR with populated title and description. **Runs unattended — never prompts.** Everything a prompt used to decide is inferred (see "Inference Rules").

## When to Use

When you've completed work on a feature branch and are ready to push your branch and create or update a PR. Used both by hand and by the dev-loop's `ticket-to-pr` skill (Phase 5).

## Arguments

All optional. With none, the skill infers everything from the branch and commit history.

| Argument | Effect |
|---|---|
| `--title "<title>"` + a `Body:` block | **Content supplied.** The caller already reasoned about the PR; use the title and body **verbatim**. No title/body generation, no bump inference (the title's type prefix is the intended bump, which the version guard checks). Only mechanical work remains: version guard, push, create-or-edit, output. |
| `--update-pr` | If a PR already exists, regenerate and replace its title and body. Without this (and without supplied content) an existing PR is left untouched. |
| `--push-only` | Push the branch, skip all PR and Jira operations. |
| `--new-pr` | If a PR already exists, close it with a "Superseded" comment and open a fresh one. Never inferred — explicit only. |
| `--no-jira` | Skip Jira Cleanup. The dev-loop passes this because `loop-runner.ts` owns the Jira transition. |

## ⚠️ CRITICAL: Git Hooks Requirement

**`gh pr create` BYPASSES git hooks** (pre-commit, pre-push). This can allow linting issues, failing tests, and build errors to leak into PRs.

**MANDATORY ORDER:**
1. ✅ Push with `git push -u origin {branch}` FIRST (triggers pre-push hook)
2. ✅ THEN use `gh pr create` / `gh pr edit` (branch already exists on remote)

**NEVER:**
- ❌ Use `gh pr create` without pushing first
- ❌ Use `git push --no-verify` or any flag that bypasses hooks
- ❌ Skip the push step "to save time"

**Why this matters:** The pre-push hook runs tests, linting (with auto-fix), and build checks. Bypassing it violates CLAUDE.md rules and causes linting issues to accumulate in PRs.

## Workflow

1. **Verify state**: Check current branch (refuse on main/master), extract JIRA ticket (e.g., `MC-461-something` → `MC-461`), count commits ahead of target branch
2. **Check for existing PR**: `gh pr list --head {branch} --json number --jq '.[0].number'`
3. **Resolve mode** from arguments + step 2 (see "Inference Rules"). If the bump can't be determined, STOP here — before pushing.
3a. **Version guard** (see "Version guard"): when the intended bump is minor or major, make sure the branch name or a label will actually produce it. Renaming the branch is the first option and must happen here, before the first push.
4. **Push with hooks**: `git push -u origin {branch}` — WAIT FOR THIS TO COMPLETE SUCCESSFULLY; on failure STOP
5. **Verify push succeeded**: Check exit code and confirm branch is on remote
6. **Get PR content**: use supplied title/body verbatim, or generate from commit history/context (skipped when leaving an existing PR untouched)
7. **Create or update PR** per the resolved mode
7a. **Bump label (MANDATORY for minor/major when the version guard applies)**: once a PR exists — newly created, updated, or an existing PR you only pushed to — ensure the `bump:minor` / `bump:major` label exists in the repo and is on the PR (`gh pr edit {n} --add-label bump:minor`). This runs **regardless of the branch name**. Verify with `gh pr view {n} --json labels --jq '.labels[].name'` and include the result in the output. Never add it to a patch PR.
8. **Jira Cleanup**: Only if a PR was created or updated and `--no-jira` was not passed — generate QA notes from the PR body, then transition ticket to Code Review (no confirmation — see "Jira Cleanup" below)
9. **Output**: Success message with PR URL, the bump line, and Jira status

## Inference Rules

Replaces the old upfront questions. No `AskUserQuestion` anywhere.

### Version bump (only when generating the title yourself)

Determine the commit type from, in order: the newest commit on the branch with a conventional prefix (`feat`, `fix`, `chore`, `docs`, `refactor`, …), then the branch name prefix.

- `feat` → minor · a `!` after the type/scope or a `BREAKING CHANGE:` footer → major · anything else conventional → patch
- **No conventional type found → STOP before pushing** with: `Cannot infer version bump: no conventional commit type on this branch. Re-run with --title "type(TICKET): description".` This is the only case where the skill halts on inference. Never silently default to patch.
- Always print the result as one line, e.g. `Bump: patch (from fix(MC-461))`. Informational; it does not pause anything. When the version guard applies, the line states whether the pipeline will really honor it (see below).

### Version guard

Some repos version through `fandango/gha-reusable-workflows` `semantic-version-calculate.yml`. That workflow does **not** read the PR title first. In priority order it uses: a `bump:major|minor|patch` PR label, then the **source branch name** of the merge commit (`feat/*` or `feature/*` → minor, `fix/*` or `bugfix/*` → patch, `breaking/*` or `major/*` → major), then commit messages. In `webtarsthree` the commit-message step never yields a minor or major (its tag lookup misses the `-beta` tags), so a `feat(...)` title on a plain `TICKET-123-name` branch merges as a patch. Evidence: #552 and the other Okta waves.

**Applies only when** `grep -lE 'semantic-version-calculate\.yml' .github/workflows/*.yml` finds a match. Otherwise skip the guard and the bump line stays as before.

**Intended bump** is the one resolved above: `feat` → minor, `!` or `BREAKING CHANGE:` → major, anything else → patch. A patch needs no guard (it is what every other path falls back to). For minor and major, check the branch:

| Intended | Branch is fine if it starts with |
|---|---|
| minor | `feat/` or `feature/` |
| major | `breaking/` or `major/` |

**The label is ALWAYS added for a minor or major bump, even when the branch name is already fine.** A correct branch name alone is not enough: a later rename or a squash merge can drop it, and the label is the guard the workflow reads first. So a fine branch skips step 1 below but never step 2. Print `Bump: minor (branch feat/…, label bump:minor)`.

If the branch is not fine, fix it without prompting. Use both guards: the rename is first, and the label is added too once the PR exists, so either one is enough if the other is missed:

1. **Rename the branch (first option).** Allowed only when all of these hold: no PR exists for the branch (step 2), the branch is not on the remote (`git ls-remote --heads origin {branch}` is empty), and it is not part of a stack (`gh stack view` fails, meaning no stack). Run `git branch -m {branch} {prefix}/{rest}`, where `{prefix}` is `feat` (minor) or `breaking` (major) and `{rest}` is the old name with any one leading `word/` segment removed. Then use the new name for the push and the PR. Print `Renamed branch {old} → {new} so the version workflow sees a {prefix}/ branch`. The ticket key is still found because it is searched for anywhere in the name, not only at the start.
2. **Label (always, once the PR exists).** Whether or not step 1 renamed the branch, for a minor or major bump make sure the repo has the label (`gh label create bump:minor --color 0E8A16 --description "Minor version bump on merge"` if `gh label list` lacks it; `bump:major` likewise) and add it with `gh pr edit {n} --add-label bump:minor`. Create the PR first when there is none yet, then add the label. A repeat run is harmless: adding a label that is already there changes nothing. Print `Added label bump:minor` (and, when step 1 could not rename, `branch {name} cannot be renamed, so the label is the only guard`). The workflow reads this label first and it overrides the branch name, so never add `bump:minor` to a PR that should be a patch.
3. **Warn only (last resort).** If neither works, print `Bump: patch — {type} title will NOT bump {minor|major}; add the bump label or use a feat/ branch`. Never print a minor or major bump line that the pipeline will not honor.

For a stack, the version run reads the top PR's branch or label, so apply the guard to the top PR only.

### Create vs. update

| Situation | Action |
|---|---|
| No existing PR | Push, then `gh pr create` (unless `--push-only`) |
| Existing PR, content supplied or `--update-pr` | Push, then `gh pr edit {n} --title … --body …` |
| Existing PR, neither | Push only. Output `Pushed to existing PR #{n} (description unchanged)`. Title/body are never overwritten implicitly — a human may have edited them. |
| Existing PR, `--new-pr` | Push, `gh pr close {n} --comment "Superseded by new PR"`, then `gh pr create` |

## Format Requirements

### PR Title
`{type}({JIRA-TICKET}): {description}`

The PR title is the conventional-commit summary people read in history and states the intended bump. In repos that use `semantic-version-calculate.yml` it does not by itself set the version: see "Semantic Versioning" and "Version guard".

Examples:
- `feat(MC-564): Node.js BFF server replacing nginx` → minor bump
- `fix(MC-461): resolve pagination crash` → patch bump
- `feat(MC-500)!: remove legacy API endpoints` → major bump

### PR Body

```markdown
## Jira Ticket
https://fandango.atlassian.net/browse/{JIRA-TICKET}

## Changes
- {concise bullet 1}
- {concise bullet 2}
- {concise bullet 3}

## QA Notes
Manual testing steps:

1. Navigate to `/actual/route/url` (use real paths, not "Page Name")
2. {action to perform}
3. Expected: {expected result}
4. {edge case if relevant}
```

The `## Jira Ticket` section is always first, linking to the ticket key extracted from the branch name. If no ticket key is found, omit it entirely. When content is supplied, the caller's body is used exactly as given — do not add, drop, or reorder sections.

## Semantic Versioning (IMPORTANT)

Repos that call `gha-reusable-workflows` `semantic-version-calculate.yml` decide the bump on the merge to `master`/`main` in this order:

1. **PR label** `bump:major`, `bump:minor` or `bump:patch` (checked first, wins over everything).
2. **Source branch name** of the merge commit: `feat/*`, `feature/*` → minor · `fix/*`, `bugfix/*` → patch · `breaking/*`, `major/*` → major.
3. **Commit messages**: `feat(...)` → minor, `!:` / `BREAKING CHANGE:` → major, otherwise patch. In `webtarsthree` this step does not work (its tag lookup misses the `-beta` tags and it scans the whole history), so it can only produce a patch.

So the title states the intent, but the branch prefix or label delivers it. History: `feature/` branches with `fix(...)` or `chore(...)` titles bumped minor (3.10.0, 3.13.0); every `feat(...)` title on a plain `TICKET-123-name` branch bumped patch. Run the "Version guard" before pushing.

Other repos that version differently (squash merge with title-based bumping) keep the old rule: the PR title's type prefix (`feat` → minor, `!:` / `BREAKING CHANGE:` → major, others → patch) is the bump.

## Critical Rules

**Changes section:**
- ✅ 3-8 concise bullets, single flat list
- ❌ No subsections like "Core Architecture" or "API Changes"
- ❌ No "Files Changed" or "Migration Notes" sections
- Focus on **what** changed, not **how**

**QA Notes:**
- ✅ Use actual URLs: `/configuration/rating-classifications`
- ❌ Not page names: "Rating Classifications Page"

**Never write into the title/body:** absolute filesystem paths (leaks the home directory), raw env var values, `.env`/`.envrc` content, or any credential/token/key/password value. Repo-relative paths only; report presence/shape of secrets, never the value.

**Always pass the title and body inline** (`--title "…" --body "$(cat <<'EOF' … EOF)"`), never `--body-file`. The dev-loop's `block-secret-comments.sh` hook scans the command string for secret-shaped content; a body read from a file would bypass it.

## Example Output

### Example 1: No existing PR

```
Bump: minor (from feat(MC-461))
✅ Pushed branch to origin/MC-461-refactor-api-client
✅ PR created successfully!
🔗 https://github.com/your-org/catalog-ui-management/pull/123
```

### Example 1b: Version guard renames the branch (repo uses semantic-version-calculate.yml)

```
Renamed branch TARS-1586-okta-auth-docs → feat/TARS-1586-okta-auth-docs so the version workflow sees a feat/ branch
Bump: minor (branch feat/TARS-1586-okta-auth-docs, label bump:minor)
✅ Pushed branch to origin/feat/TARS-1586-okta-auth-docs
✅ PR created successfully!
✅ Added label bump:minor (verified on PR)
🔗 https://github.com/fandango/webtarsthree/pull/557
```

### Example 1c: Branch already fine (feature/…) — label is still added

```
Bump: minor (branch feature/TARS-1633-adjusted-score-critics, label bump:minor)
✅ Pushed branch to origin/feature/TARS-1633-adjusted-score-critics
✅ PR created successfully!
✅ Added label bump:minor (verified on PR)
🔗 https://github.com/fandango/webtarsthree/pull/584
```

### Example 2: PR already exists, nothing supplied

```
Bump: patch (from fix(MC-461))
✅ Pushed branch to origin/MC-461-refactor-api-client
✅ Pushed to existing PR #98 (description unchanged)
🔗 https://github.com/your-org/catalog-ui-management/pull/98
```

## Implementation

**Step 1: Check for existing PR**
```bash
EXISTING_PR=$(gh pr list --head {branch} --json number --jq '.[0].number')
```

**Step 2: Push branch with git (MANDATORY - triggers hooks)**
```bash
# CRITICAL: Use git push, NOT gh pr create --push
git push -u origin {branch}

if [ $? -ne 0 ]; then
  echo "❌ Push failed (likely due to pre-push hook failure)"
  echo "Fix the issues above before creating PR"
  exit 1
fi

echo "✅ Pushed branch to origin/{branch}"
```

**Step 3: Create or update, per "Create vs. update"**

New PR (branch already pushed, so `gh` only creates the PR record):
```bash
gh pr create --title "fix(MC-461): refactor API client" --body "$(cat <<'EOF'
## Jira Ticket
https://fandango.atlassian.net/browse/MC-461

## Changes
- Bullet 1
- Bullet 2

## QA Notes
Manual testing steps:

1. Step 1
2. Expected: result
EOF
)"
```

Existing PR being updated:
```bash
gh pr edit {existing_pr_number} --title "..." --body "$(cat <<'EOF'
...same body shape...
EOF
)"
```

`--new-pr` only: `gh pr close {existing_pr_number} --comment "Superseded by new PR"` first, then `gh pr create` as above.

## Jira Cleanup

Runs automatically after a PR is created or updated (unless `--no-jira`). No user confirmation needed. Two sub-steps: generate QA notes from the PR body, then transition the ticket to Code Review with those notes.

**Skip entirely if:** `--no-jira` was passed, push-only, existing PR left with description unchanged, no ticket key found in branch name, or PR creation failed.

### Sub-step A: Generate QA Notes from PR body

The PR body's `## QA Notes` section (written by push-branch itself) is the source of truth. Parse it into ADF.

**Source:** the `## QA Notes` section of the PR body created in step 7. It contains `Manual testing steps:` followed by a numbered list.

**Convert to ADF** using this structure (same format as the `/qa-notes` skill):

```js
const qaNotesAdf = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Manual testing steps:", marks: [{ type: "strong" }] }]
    },
    {
      type: "orderedList",
      attrs: { order: 1 },
      content: [
        // One listItem per numbered step from the PR body's QA Notes section.
        // Steps starting with "Expected:" get bold marks:
        {
          type: "listItem",
          content: [{
            type: "paragraph",
            content: [
              { type: "text", text: "Expected:", marks: [{ type: "strong" }] },
              { type: "text", text: " {rest of expected line}" }
            ]
          }]
        },
        // All other steps are plain text:
        {
          type: "listItem",
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "{step text}" }]
          }]
        }
      ]
    }
  ]
};
```

If the PR body has no `## QA Notes` section, use a minimal fallback:
```js
{ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `See PR: ${prUrl}` }] }] }
```

### Sub-step B: Transition ticket (and subtasks) to Code Review

**Step 1: Get current ticket status and subtasks**
```js
const issue = await getJiraIssue({
  cloudId: "fandango.atlassian.net",
  issueIdOrKey: "TARS-461",  // extracted from branch name
  fields: ["status", "subtasks"]
});
const currentStatus = issue.fields.status.name;
const subtasks = issue.fields.subtasks ?? [];  // array of { key, fields: { status } }
```

**Step 2: Get available transitions**
```js
const transitions = await getTransitionsForJiraIssue({
  cloudId: "fandango.atlassian.net",
  issueIdOrKey: "TARS-461"
});
const inProgressTransition = transitions.transitions.find(t => t.name === "In Progress");
const codeReviewTransition = transitions.transitions.find(t => t.name === "Ready for Code Review");
```

**Step 3: Transition the parent ticket**

If `currentStatus === "To Do"`: transition to "In Progress" first, then "Code Review".
Otherwise: transition directly to "Code Review".

```js
if (currentStatus === "To Do" && inProgressTransition) {
  await transitionJiraIssue({
    cloudId: "fandango.atlassian.net",
    issueIdOrKey: "TARS-461",
    transition: { id: inProgressTransition.id }
  });
}

await transitionJiraIssue({
  cloudId: "fandango.atlassian.net",
  issueIdOrKey: "TARS-461",
  transition: { id: codeReviewTransition.id },
  fields: {
    customfield_13504: [{ id: "14310" }],  // Covered Information Data Inventory: No Impact
    customfield_14226: qaNotesAdf           // QA Notes — ADF built in Sub-step A
  }
});
```

**Step 4: Transition subtasks (if any) — no QA notes**

For each subtask, fetch its available transitions and apply the same Code Review transition. Leave QA notes blank — the parent ticket holds the QA notes for the whole story.

```js
for (const subtask of subtasks) {
  const subtaskTransitions = await getTransitionsForJiraIssue({
    cloudId: "fandango.atlassian.net",
    issueIdOrKey: subtask.key
  });
  const subtaskInProgress = subtaskTransitions.transitions.find(t => t.name === "In Progress");
  const subtaskCodeReview = subtaskTransitions.transitions.find(t => t.name === "Ready for Code Review");

  if (!subtaskCodeReview) continue;  // skip if transition not available

  if (subtask.fields.status.name === "To Do" && subtaskInProgress) {
    await transitionJiraIssue({
      cloudId: "fandango.atlassian.net",
      issueIdOrKey: subtask.key,
      transition: { id: subtaskInProgress.id }
    });
  }

  await transitionJiraIssue({
    cloudId: "fandango.atlassian.net",
    issueIdOrKey: subtask.key,
    transition: { id: subtaskCodeReview.id }
    // No QA notes — parent ticket holds them
  });
}
```

### Error Handling

- If `getJiraIssue` fails: log error, skip Jira cleanup, show only GitHub PR link
- If ticket not found: skip silently
- If transition fails: show error but don't block PR success output
- If a subtask transition fails: log the subtask key and error, continue with remaining subtasks
- Jira errors never block the PR success output

### Example Output

**PR created + Jira updated (no subtasks):**
```
✅ PR created successfully!
🔗 https://github.com/org/webtarsthree/pull/103

✅ Moved TARS-461 to Code Review
📋 https://fandango.atlassian.net/browse/TARS-461
```

**PR created + two-step Jira transition:**
```
✅ PR created successfully!
🔗 https://github.com/org/webtarsthree/pull/103

✅ Moved TARS-461 from To Do → In Progress → Code Review
📋 https://fandango.atlassian.net/browse/TARS-461
```

**PR created + parent and subtasks transitioned:**
```
✅ PR created successfully!
🔗 https://github.com/org/webtarsthree/pull/103

✅ Moved TARS-461 to Code Review
✅ Moved subtasks to Code Review: TARS-462, TARS-463
📋 https://fandango.atlassian.net/browse/TARS-461
```

**Push only (no PR):**
```
✅ Branch pushed successfully. PR operations skipped.
```
_(No Jira cleanup runs — Jira Cleanup only triggers when a PR is created or updated.)_


## Guardrails

- Refuses to run on main/master branches
- **Never prompts.** No `AskUserQuestion`; the only halts are a failed push and an un-inferable version bump (both before/at push, with a clear message)
- **ALWAYS uses `git push` first to trigger pre-push hooks** (tests, linting, build)
- **Verifies push succeeded before proceeding to PR creation**
- **NEVER uses `git push --no-verify` or any hook-bypass flags**
- **Never overwrites an existing PR's title/body implicitly** — only with supplied content or `--update-pr`
- **Never closes a PR implicitly** — only with `--new-pr`
- **Always labels minor/major PRs** (`bump:minor` / `bump:major`) when the repo uses `semantic-version-calculate.yml` — even if the branch is already `feat/`/`feature/` — and verifies the label landed before reporting success
- Supplied content is used verbatim; nothing is regenerated
- Automatically generates PR description when no content is supplied (no copy/paste needed)
- **Jira Cleanup runs only when a PR is created or updated and `--no-jira` is absent** — skipped entirely on push-only, on "existing PR, description unchanged", and when no ticket key is in the branch name
- Uses Haiku model (mechanical work only; when a caller supplies content, all reasoning already happened upstream)
- Outputs direct PR URL for immediate access
- Jira errors don't block PR success output

## Common Mistakes to Avoid

1. **❌ Using `gh pr create` without git push first**
   - `gh pr create` will auto-push but BYPASSES hooks
   - Always `git push` first, then `gh pr create`

2. **❌ Continuing after push failure**
   - If `git push` fails (usually due to pre-push hook), STOP
   - Fix the failing tests/linting issues
   - Don't bypass with `--no-verify`

3. **❌ Assuming gh CLI respects hooks**
   - `gh` is a GitHub API client, not a git wrapper
   - It pushes directly to GitHub API, skipping git hook infrastructure
