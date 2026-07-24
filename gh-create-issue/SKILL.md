---
name: gh-create-issue
description: Use when the user wants to create one or more GitHub issues — bug reports, feature requests, tasks, or chores — directly in the remote repo via gh CLI.
---

# Create GitHub Issue

Create well-structured GitHub issues directly in the remote repo using `gh issue create`.

## When to Use

- User wants to file a bug, feature request, task, or chore
- User says "create an issue", "open a ticket", "log this as an issue"
- Capturing work items discovered during a session

## Title Format — MANDATORY

Every issue title **must** begin with a conventional-commit prefix:

| Prefix   | Use for                                                                 |
|----------|-------------------------------------------------------------------------|
| `bug:`   | Something is broken — incorrect or unexpected behaviour                 |
| `fix:`   | Iteration or improvement on something that works but isn't quite right  |
| `feat:`  | Brand new functionality that doesn't exist yet                          |
| `chore:` | Internal work, refactors, maintenance — no user-facing change           |
| `docs:`  | Documentation-only changes                                              |
| `test:`  | Test coverage or test infrastructure                                    |

**Choosing between `bug:`, `fix:`, and `feat:`:**
- `bug:` — it's broken. Users hit an error, wrong output, or crash.
- `fix:` — it works, but needs an iteration (wording, layout, UX polish, edge case).
- `feat:` — it doesn't exist yet. Net-new capability or screen.

**Format:** `{prefix}: {short imperative description}` (all lowercase after the colon)

Examples:
- `bug: completed todos resurface in next-day AI summary`
- `fix: consolidate redundant sections in summarize template`
- `feat: global search across all app data`
- `chore: consolidate Notes field to single textarea`

## Workflow

1. **Identify repo** — run `gh repo view --json name,nameWithOwner` to get the repo name and confirm target
2. **Determine type** — infer prefix from user description; ask only if genuinely ambiguous
3. **Create** — run `gh issue create` with prefixed title, body, labels, and `--project "{repo_name}"`
4. **Output** — print the issue URL

## Upfront Questions

Ask everything in one `AskUserQuestion` call. Only ask if the user has not already provided a title and description.

```
AskUserQuestion({
  questions: [
    {
      question: "What type of issue is this?",
      header: "Issue type",
      multiSelect: false,
      options: [
        { label: "bug", description: "Something is broken — incorrect or unexpected behaviour" },
        { label: "fix", description: "Iteration on something that works but isn't quite right" },
        { label: "feat", description: "Brand new functionality that doesn't exist yet" },
        { label: "chore", description: "Internal work, refactor, or maintenance — no user-facing change" },
        { label: "docs", description: "Documentation-only change" }
      ]
    }
  ]
})
```

> If the user already provided a title and description in their message, skip the question and proceed directly.

## Issue Body Template

Use this structure for every issue:

```markdown
## Summary
{1-2 sentence description of what this is and why it matters}

## Details
{bug: steps to reproduce + expected vs actual behaviour}
{feat: acceptance criteria as a checklist}
{chore: definition of done}
{docs: what needs to be written or updated}

## Notes
{optional: links, related files, workarounds, design refs — omit section if empty}
```

## Label Mapping

One label per issue, matched to the prefix.

| Prefix   | Label     |
|----------|-----------|
| `bug`    | `bug`     |
| `fix`    | `fix`     |
| `feat`   | `feature` |
| `chore`  | `chore`   |
| `docs`   | `docs`    |
| `test`   | `test`    |

## Implementation

```bash
# 1. Get repo name
REPO_NAME=$(gh repo view --json name --jq '.name')

# 2. Create issue
gh issue create \
  --title "{prefix}: {short description}" \
  --body "$(cat <<'EOF'
## Summary
{summary}

## Details
{details}

## Notes
{notes or omit section}
EOF
)" \
  --label "{label}" \        # omit --label for types with no matching label
  --project "$REPO_NAME"
```

## Output

```
✅ Issue created!
🔗 https://github.com/JustinChan-fd/jarvis/issues/{number}
```

## Guardrails

- Always confirm the repo with `gh repo view` before creating
- Never create on `main`-push flows — issues are repo-level, not branch-level
- If `gh` is not authenticated, surface the error clearly and stop
- Omit `--label` rather than guessing; don't invent labels not in the repo
- If the user provides a detailed description, use it verbatim in Details — don't summarise
- Never omit the conventional-commit prefix from the title
- Always pass `--project "$REPO_NAME"` to link the issue to the project board
- If `--project` fails with a missing scope error, prompt the user to run `gh auth refresh -s read:project` then retry
