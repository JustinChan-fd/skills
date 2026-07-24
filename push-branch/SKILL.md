---
name: push-branch
description: Push branch to GitHub and create PR with auto-populated description
model: anthropic.claude-haiku-4-5-20251001
---

# Push Branch & Create PR

Push your current branch to GitHub and automatically create a PR with populated title and description.

## When to Use

When you've completed work on a feature branch and are ready to push your branch and create a PR.

## ⚠️ CRITICAL: Git Hooks Requirement

**`gh pr create` BYPASSES git hooks** (pre-commit, pre-push). This can allow linting issues, failing tests, and build errors to leak into PRs.

**MANDATORY ORDER:**
1. ✅ Push with `git push -u origin {branch}` FIRST (triggers pre-push hook)
2. ✅ THEN use `gh pr create` (branch already exists on remote)

**NEVER:**
- ❌ Use `gh pr create` without pushing first
- ❌ Use `git push --no-verify` or any flag that bypasses hooks
- ❌ Skip the push step "to save time"

**Why this matters:** The pre-push hook runs tests, linting (with auto-fix), and build checks. Bypassing it violates CLAUDE.md rules and causes linting issues to accumulate in PRs.

## Workflow

1. **Verify state**: Check current branch, extract JIRA ticket (e.g., `MC-461-something` → `MC-461`), count commits ahead of target branch
2. **Check for existing PR**: Run `gh pr list --head {branch}` to see if PR already exists
3. **Ask all questions upfront**: Use a single AskUserQuestion with all questions at once (see "Upfront Questions" below) — NO further user prompts after this point
4. **Push with hooks**: `git push -u origin {branch}` — WAIT FOR THIS TO COMPLETE SUCCESSFULLY
5. **Verify push succeeded**: Check exit code $? and confirm branch is on remote
6. **Generate PR content**: Create title and description from commit history/context, applying the version bump chosen in step 3
7. **Create or update PR**: Execute the action chosen in step 3 with `gh pr create`
8. **Jira Cleanup**: Only if a PR was created or updated — generate QA notes from the PR body, then transition ticket to Code Review with those QA notes (no user confirmation needed — see "Jira Cleanup" below)
9. **Output**: Success message with PR URL and Jira status

## Format Requirements

### PR Title
`{type}({JIRA-TICKET}): {description}`

The PR title becomes the squash commit message on merge, which determines the semantic version bump. See "Semantic Versioning" section below.

Examples:
- `feat(MC-564): Node.js BFF server replacing nginx` → minor bump
- `fix(MC-461): resolve pagination crash` → patch bump
- `feat(MC-500)!: remove legacy API endpoints` → major bump

### PR Body

```markdown
## Changes
- {concise bullet 1}
- {concise bullet 2}
- {concise bullet 3}

## QA Notes
Manual testing steps:

1. Navigate to `/actual/route/url` (use real paths, not "Page Name")
2. {action to perform}
3. {expected result}
4. {edge case if relevant}
```

## Semantic Versioning (IMPORTANT)

The CD pipeline auto-bumps version based on the **merge commit message** on `main`. Since GitHub uses the PR title as the squash commit message, the PR title directly controls the version bump:

- **Minor bump** (new feature): PR title must start with `feat(MC-XXX):` or `feat:`
  - Example: `feat(MC-564): Node.js BFF server replacing nginx`
- **Major bump** (breaking): PR title contains `!:` or `BREAKING CHANGE:`
  - Example: `feat(MC-XXX)!: remove legacy API`
- **Patch** (default): anything else (`fix:`, `chore:`, `docs:`, `refactor:`)

The version bump is collected in the upfront AskUserQuestion (see "Upfront Questions" below). Format the PR title based on the user's answer:
- Minor: `feat(MC-XXX): description`
- Patch: `fix(MC-XXX): description` or `chore(MC-XXX): description`
- Major: `feat(MC-XXX)!: description`

## Critical Rules

**Changes section:**
- ✅ 3-8 concise bullets, single flat list
- ❌ No subsections like "Core Architecture" or "API Changes"
- ❌ No "Files Changed" or "Migration Notes" sections
- Focus on **what** changed, not **how**

**QA Notes:**
- ✅ Use actual URLs: `/configuration/rating-classifications`
- ❌ Not page names: "Rating Classifications Page"

## Example Output

### Example 1: No existing PR

```
[AskUserQuestion: version bump + confirm push & create PR — answered upfront]

✅ Pushed branch to origin/MC-461-refactor-api-client

✅ PR created successfully!

🔗 https://github.com/your-org/catalog-ui-management/pull/123
```

### Example 2: PR already exists

```
[AskUserQuestion: version bump + PR action (existing PR #98) — answered upfront]

✅ Pushed branch to origin/MC-461-refactor-api-client

✅ Commits pushed to existing PR #98

🔗 https://github.com/your-org/catalog-ui-management/pull/98
```

## Upfront Questions

Before pushing or doing any work, ask **all** questions in a single AskUserQuestion call. No further user prompts after this point — execute the rest of the workflow unattended.

The number of questions and their options depend on whether a PR already exists (checked silently in step 2).

### Case 1: No existing PR

```
AskUserQuestion({
  questions: [
    {
      question: "What version bump should this PR trigger?",
      header: "Version bump",
      multiSelect: false,
      options: [
        { label: "Patch (fix/chore)", description: "Bug fix or maintenance — PR title uses fix:/chore:" },
        { label: "Minor (feat)", description: "New feature/capability — PR title uses feat:" },
        { label: "Major (breaking)", description: "Breaking change — PR title uses feat!:" }
      ]
    },
    {
      question: "Proceed with push and PR creation?",
      header: "Confirm",
      multiSelect: false,
      options: [
        { label: "Yes, push and create PR", description: "Push branch (triggers hooks) then create PR" },
        { label: "Push only, no PR", description: "Push branch but skip PR creation" },
        { label: "Cancel", description: "Do nothing" }
      ]
    }
  ]
})
```

### Case 2: PR already exists

```
AskUserQuestion({
  questions: [
    {
      question: "What version bump should this PR trigger?",
      header: "Version bump",
      multiSelect: false,
      options: [
        { label: "Patch (fix/chore)", description: "Bug fix or maintenance — PR title uses fix:/chore:" },
        { label: "Minor (feat)", description: "New feature/capability — PR title uses feat:" },
        { label: "Major (breaking)", description: "Breaking change — PR title uses feat!:" }
      ]
    },
    {
      question: "PR #{{number}} already exists. What would you like to do?",
      header: "PR Action",
      multiSelect: false,
      options: [
        { label: "Push to existing PR", description: "Push commits to existing PR #{{number}}" },
        { label: "Create new PR", description: "Create a new pull request (closes existing PR #{{number}})" },
        { label: "Push only, no PR change", description: "Push branch but skip PR operations" },
        { label: "Cancel", description: "Do nothing" }
      ]
    }
  ]
})
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

# Verify push succeeded
if [ $? -ne 0 ]; then
  echo "❌ Push failed (likely due to pre-push hook failure)"
  echo "Fix the issues above before creating PR"
  exit 1
fi

echo "✅ Pushed branch to origin/{branch}"
```

**Step 3: Generate PR content and show to user**

**Step 4: Present dynamic options based on PR existence** (see "Dynamic PR Options" above)

**Step 5: Execute chosen action**

### If "Yes, create PR" (no existing PR):
```bash
# Branch already pushed in Step 2, so gh won't push again
# This just creates the PR metadata on GitHub
gh pr create --title "MC-461 - refactor API client" --body "$(cat <<'EOF'
## Changes
- Bullet 1
- Bullet 2

## QA Notes
Manual testing steps:
1. Step 1
2. Step 2
EOF
)"
```

**Note:** Because we already pushed in Step 2, `gh pr create` will NOT push again - it only creates the PR record.

### If "Yes, push to existing PR":
Output: "✅ Commits pushed to existing PR #{number}"

### If "Yes, create new PR" (with existing PR):
```bash
# Close existing PR first
gh pr close {existing_pr_number} --comment "Superseded by new PR"

# Create new PR
gh pr create --title "MC-461 - refactor API client" --body "$(cat <<'EOF'
## Changes
- Bullet 1
- Bullet 2

## QA Notes
Manual testing steps:
1. Step 1
2. Step 2
EOF
)"
```

### If "No, not yet":
Output: "✅ Branch pushed successfully. PR operations skipped."

## Jira Cleanup

Runs automatically after a PR is created or updated. No user confirmation needed. Two sub-steps: generate QA notes from the PR body, then transition the ticket to Code Review with those notes.

**Skip entirely if:** push-only (no PR created/updated), no ticket key found in branch name, or PR creation failed.

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
- **Asks ALL questions upfront in a single AskUserQuestion before any action** — no mid-flow prompts
- **ALWAYS uses `git push` first to trigger pre-push hooks** (tests, linting, build)
- **Verifies push succeeded before proceeding to PR creation**
- **NEVER uses `git push --no-verify` or any hook-bypass flags**
- Detects existing PRs silently and includes relevant options in the upfront question
- Automatically generates PR description (no copy/paste needed)
- **Jira Cleanup runs only when a PR is created or updated** — generates QA notes from the PR body, then transitions ticket to Code Review; skipped entirely on push-only
- Uses Haiku model (text generation/formatting task)
- Outputs direct PR URL for immediate access
- Outputs Jira ticket URL if transition succeeds
- When creating new PR with existing one, explicitly closes old PR with comment
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
