---
name: squash-commits
description: Squash commits with format "{JIRA-TICKET} - {ticket context}"
model: anthropic.claude-haiku-4-5-20251001
---

# Squash Commits

Simple skill to squash commits into a single commit with proper JIRA ticket formatting.

## When to Use

When you need to clean up commit history before merging by squashing multiple commits into one with a standardized format.

## Input Required

When invoked without arguments, prompt the user:

```
To squash commits, I need:
1. JIRA ticket number (e.g., MC-461)
2. Brief context for the ticket (e.g., "refactor API client")

You can provide both now, or I'll ask for them.
```

## Output Format

Commit message should follow:
```
{JIRA-TICKET} - {ticket context}
```

Examples:
- `MC-461 - refactor API client`
- `MC-523 - add user authentication`
- `BUG-101 - fix pagination edge case`

## Instructions

1. **Check current branch** - Get branch name to extract JIRA ticket if present
2. **Count commits** - Determine how many commits to squash (usually all commits ahead of main)
3. **Extract/Confirm ticket** - Try to extract from branch name (e.g., `MC-461-something` → `MC-461`), confirm with user
4. **Get context** - Ask user for brief ticket context if not provided
5. **Perform squash** - Use `git reset --soft` to squash, then commit with formatted message

## Implementation

```bash
# 1. Get current branch and check we're not on main/master
current_branch=$(git branch --show-current)
if [[ "$current_branch" == "main" || "$current_branch" == "master" ]]; then
  echo "Cannot squash commits on main/master branch"
  exit 1
fi

# 2. Count commits ahead of main
main_branch=$(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')
commit_count=$(git rev-list --count origin/$main_branch..HEAD)

if [[ $commit_count -eq 0 ]]; then
  echo "No commits to squash"
  exit 0
elif [[ $commit_count -eq 1 ]]; then
  echo "Only one commit present, nothing to squash"
  exit 0
fi

echo "Found $commit_count commits to squash"

# 3. Extract ticket from branch name (format: TICKET-123-description)
ticket=$(echo "$current_branch" | grep -oE '^[A-Z]+-[0-9]+')

# 4. Confirm ticket and get context from user
# (handled by conversation with user)

# 5. Squash commits
git reset --soft HEAD~$commit_count
git commit -m "$ticket - $context"
```

## Example Flow

**User invokes:** `/squash-commits`

**Assistant:**
```
To squash commits, I need:
1. JIRA ticket number (e.g., MC-461)  
2. Brief context (e.g., "refactor API client")

I see you're on branch `MC-461-refactor-api-client` with 5 commits ahead of main.
Extracted ticket: MC-461

Please provide the ticket context for the commit message.
```

**User:** `refactor API client for better error handling`

**Assistant:** Squashes commits and creates: `MC-461 - refactor API client for better error handling`

## Notes

- Uses `git reset --soft` to preserve all changes while squashing commits
- Automatically detects ticket number from branch name when following convention
- Always confirms ticket and context with user before committing
- Refuses to run on main/master branches
- Shows count of commits being squashed for transparency
