---
name: review-pr-feedback
description: Process unresolved PR review comments — triage, implement, test, resolve threads, post summary
model: anthropic.claude-sonnet-4-6
---

# Review PR Feedback

Process unresolved PR review comments from any reviewer (Copilot, humans, other agents). Idempotent — only touches unresolved threads, safe to re-run after staggered reviews.

**Announce at start:** "I'm using the review-pr-feedback skill to process unresolved PR comments."

## When to Use

- ✅ After Copilot review drops comments
- ✅ After human reviewer leaves feedback
- ✅ After a second round of reviews on the same PR
- ✅ Re-run after fixing one batch to catch new comments

## When NOT to Use

- ❌ Comments require architectural decisions (discuss first, then fix)
- ❌ PR has merge conflicts (resolve conflicts first)
- ❌ Review feedback is "rewrite this entirely" (that's a new task, not a fix)

---

## Workflow

### Phase 1: Detect PR & Fetch Unresolved Threads

**Auto-detect PR from current branch:**

```bash
PR_NUMBER=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
REPO_OWNER=$(gh repo view --json owner --jq '.owner.login')
REPO_NAME=$(gh repo view --json name --jq '.name')
```

If `PR_NUMBER` is empty, ask user for the PR number.

**Fetch unresolved threads via GraphQL:**

```bash
gh api graphql -f query='
{
  repository(owner: "'"$REPO_OWNER"'", name: "'"$REPO_NAME"'") {
    pullRequest(number: '"$PR_NUMBER"') {
      reviewThreads(first: 50) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              body
              path
              line
              author { login }
            }
          }
        }
      }
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)'
```

**Output format to parse:**
```
THREAD_ID | FILE_PATH | LINE | AUTHOR | COMMENT_BODY
```

If 0 unresolved threads: "No unresolved review comments found on PR #X. Nothing to do."

### Phase 1.5: Load Project Context

**Load codebase conventions and patterns** to inform triage and implementation. Check for these files in order, load what exists, skip what doesn't:

```bash
PROJECT_CONTEXT=""

# Core project instructions
if [ -f "CLAUDE.md" ]; then 
  PROJECT_CONTEXT+="$(cat CLAUDE.md)\n\n"
fi

# Domain-specific rules (common in this user's projects)
if [ -f "docs/AI_CONTEXT.md" ]; then 
  PROJECT_CONTEXT+="$(cat docs/AI_CONTEXT.md)\n\n"
fi

# Testing patterns
if [ -f "docs/testing/README.md" ]; then 
  PROJECT_CONTEXT+="$(head -200 docs/testing/README.md)\n\n"  # First 200 lines cover scaffolds and patterns
fi

# Server patterns (if any server files touched)
if [ -f "docs/server/patterns.md" ]; then 
  PROJECT_CONTEXT+="$(cat docs/server/patterns.md)\n\n"
fi
```

**Use this context for:**
- Triage assessments in Phase 2 (e.g., "our CLAUDE.md forbids `jest.mock('axios')`" → mark as ✅ Valid)
- Implementation decisions in Phase 3
- Subagent prompts in escalation cases (pass PROJECT_CONTEXT verbatim)

**Token budget:** ~5-10K tokens if all docs exist. If total exceeds 15K tokens, truncate each to first 100 lines.

### Phase 2: Triage (Quick, User-Driven)

Present comments **grouped by file**. For each comment, show:

```
### file.js (3 comments)

1. **Line 64** (@copilot): `req.remoteAddress` is not standard on IncomingMessage...
   Assessment: ✅ Valid — use `req.socket.remoteAddress` instead

2. **Line 72** (@copilot): `res.headers` is not a property on ServerResponse...
   Assessment: ✅ Valid — use `res.getHeader('content-length')`

3. **Line 47** (@reviewer): This check won't handle querystrings...
   Assessment: ⚠️ Questionable — depends on whether /health ever gets query params
```

**Assessment criteria** (informed by PROJECT_CONTEXT from Phase 1.5):
- ✅ **Valid** — Comment identifies a real issue that aligns with our documented patterns, or catches a violation of conventions in CLAUDE.md/AI_CONTEXT.md
- ⚠️ **Questionable** — Comment is technically correct but may not matter for our use case, or conflicts with project conventions (check docs)
- ❌ **False positive** — Comment is wrong about our setup (explain why briefly, cite PROJECT_CONTEXT if relevant)

**Ask user:** Use AskUserQuestion with options:
- "Implement all valid (recommended)" — implement ✅ items, skip ❌, ask about ⚠️
- "Let me pick" — user selects which to implement
- "Implement everything" — do them all regardless of assessment

### Phase 3: Implement (Sequential, Direct)

For each accepted comment:

1. **Read the file** at the relevant line
2. **Consult PROJECT_CONTEXT** from Phase 1.5 for conventions (already loaded — no need to re-read docs)
3. **Make the fix** — typically 1-10 lines, following project conventions
4. **Track what was done** — store `{ file, line, issue, fix }` for the summary

**Note:** PROJECT_CONTEXT is already loaded in Phase 1.5, so you don't need to Read docs again here unless you need a section that wasn't included in the initial load.

**Escalation rule:** If a single comment requires **>30 lines changed** OR **touches multiple files**, STOP and flag to user:

> "This one is bigger than a quick fix — [explain scope]. Handle it separately after this batch, or should I proceed?"

If user says proceed, delegate to a subagent with guardrails (see Guardrails section below).

### Phase 4: Test

Run **once** after all fixes are applied:

```bash
# If any server/ files were touched:
npm run test:server

# If any src/ files were touched:
npm run test
```

**If tests fail:**
1. Identify which fix likely caused the failure (match test file to changed file)
2. Check if test assertion needs updating (test was asserting old behavior)
3. Ask user: "Test X failed after fixing Y. Fix the test / revert the change / investigate?"

### Phase 5: Commit + Push + Resolve Threads

**Single commit for all fixes:**

```bash
git add -A
git commit -m "fix(MC-XXX): address PR review feedback

- bullet per fix
- bullet per fix

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
git push
```

Extract ticket number from branch name (e.g., `feature/MC-564-...` → `MC-564`).

**Resolve each implemented thread:**

```bash
for thread_id in $IMPLEMENTED_THREAD_IDS; do
  gh api graphql -f query="
    mutation {
      resolveReviewThread(input: { threadId: \"$thread_id\" }) {
        thread { id isResolved }
      }
    }"
done
```

**Dismiss skipped/rejected threads with a reply:**

For threads assessed as ❌ false positive or intentionally skipped, post a single-line reply explaining why, then resolve the thread. This prevents stale unresolved threads from piling up for the user to manually close.

```bash
for thread_id in $SKIPPED_THREAD_IDS; do
  # Post a one-line dismissal reply on the thread's PR review comment
  gh api graphql -f query="
    mutation {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: \"$thread_id\", body: \"$DISMISSAL_REASON\" }) {
        comment { id }
      }
    }"
  # Then resolve it
  gh api graphql -f query="
    mutation {
      resolveReviewThread(input: { threadId: \"$thread_id\" }) {
        thread { id isResolved }
      }
    }"
done
```

The dismissal reply should be a single sentence — e.g., "False positive — this line already asserts `toHaveLength(1)` after the merge conflict fix." Keep it factual, not defensive.

### Phase 6: Post Summary Comment

```bash
gh pr comment $PR_NUMBER --body "$SUMMARY"
```

---

## Summary Comment Template

```markdown
## PR Review Feedback — Resolution Summary

All N review comments addressed in commit `<SHA>`.

### ✅ Implemented

| # | File | Issue | Fix |
|---|------|-------|-----|
| 1 | `file.js:line` | Brief issue description | → What was done |

### ❌ Not Implemented

| # | File | Issue | Reason |
|---|------|-------|--------|
| 1 | `file.js:line` | Brief issue description | Why it was skipped |

(Or "None — all N comments were valid and addressed." if all implemented)
```

**Rules for the table:**
- Keep "Issue" column to <80 chars (truncate with ellipsis if needed)
- Keep "Fix" column actionable: "→ use `res.getHeader()`" not "→ Fixed"
- Keep "Reason" column honest: "False positive — our setup handles this via X" not just "Skipped"

---

## Guardrails (Escalation Cases Only)

When delegating to a subagent (comment requires >30 lines):

1. **File-scoped** — Subagent may ONLY modify the specific file mentioned. If a fix requires other files, report back with `STATUS: NEEDS_ESCALATION`.

2. **Pass PROJECT_CONTEXT** — Include the full PROJECT_CONTEXT string from Phase 1.5 in the subagent prompt under a `## Project Conventions` section. The subagent must follow these conventions when making changes.

3. **Diff-size limit** — Change must be <30 lines. If still larger, report back.

4. **Tests required** — Run relevant test suite after change. Report `TESTS: PASS` or `TESTS: FAIL (output)`.

**Example subagent prompt structure:**
```
Fix the issue at {file}:{line}.

Issue: {comment body}

## Project Conventions
{PROJECT_CONTEXT from Phase 1.5}

Requirements:
- Only modify {file}
- Keep changes under 30 lines
- Run tests after change
- Report TESTS: PASS or TESTS: FAIL
```

**Agent selection** (from `.claude/agents/`):
| Domain | Agent |
|--------|-------|
| Server routes/middleware/services | `junior_engineer` |
| Security (leaks, auth, headers) | `junior_engineer` |
| Frontend (components, a11y, CSS) | `senior_frontend_engineer` |
| Documentation | `junior_engineer` |
| Config/infra | `junior_engineer` |

---

## Idempotency

- **Only processes `isResolved: false` threads** — already-resolved comments are invisible
- **Safe to re-run** — new reviews that arrive after the first run will show up on the next invocation
- **Summary comment is per-run** — each invocation posts its own summary (doesn't edit previous ones)
- **Commit is per-run** — each invocation creates its own commit with only that run's fixes

---

## Common Mistakes

- ❌ Resolving a thread without explanation (implemented threads are resolved silently; skipped threads get a one-line reply before resolving)
- ❌ Updating a test assertion without understanding why it changed (investigate first)
- ❌ Implementing a "fix" that contradicts documented patterns (read docs first)
- ❌ Force-pushing after resolving threads (thread resolution references the SHA)
- ❌ Combining with unrelated changes in the same commit (keep the commit focused)
- ❌ Skipping the user triage step (always confirm before implementing)
