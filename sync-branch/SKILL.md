---
name: sync-branch
description: Sync a feature branch with latest master. Use --branch <name> if on master.
model: anthropic.claude-haiku-4-5-20251001
---

# Sync Branch

Pull latest changes from main/master into the current feature branch.

## When to Use

When you need to bring a feature branch up to date with the latest changes from the main branch before continuing work.

## Arguments

- `--branch <name>` — checkout the named branch first, then sync it. Required when currently on main/master.

## Workflow

1. **Handle `--branch` arg**: If provided, checkout that branch first
2. **Verify state**: Confirm we're on a feature branch (not main/master); if still on main/master without `--branch`, show hint and stop
3. **Check for uncommitted changes**: Stash if needed, or abort
4. **Fetch latest**: `git fetch origin`
5. **FF-merge remote feature branch**: Pull in any teammate commits from `origin/<current-branch>` first
6. **Rebase onto main**: `git rebase origin/master` (or `origin/main`)
7. **Report result**: Show success or conflict state

## Implementation

```bash
# 0. Parse --branch arg
target_branch=""
if [[ "$1" == "--branch" && -n "$2" ]]; then
  target_branch="$2"
  git checkout "$target_branch"
fi

# 1. Get current branch
current_branch=$(git branch --show-current)
if [[ "$current_branch" == "main" || "$current_branch" == "master" ]]; then
  echo "Hint: you're on ${current_branch}. Use --branch <name> to sync a feature branch, e.g.:"
  echo "  /sync-branch --branch feat/my-feature"
  exit 0
fi

# 2. Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Uncommitted changes detected — stashing before sync"
  git stash push -m "sync-branch auto-stash"
  stashed=true
fi

# 3. Fetch latest
git fetch origin

# 4. Determine main branch name
main_branch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
if [[ -z "$main_branch" ]]; then
  main_branch="master"
fi

# 5. FF-merge remote feature branch (pull teammate commits first)
if git rev-parse --verify "origin/$current_branch" &>/dev/null; then
  if ! git merge --ff-only "origin/$current_branch"; then
    echo "Cannot fast-forward to origin/$current_branch — remote has diverged."
    echo "Resolve manually or ask a teammate before rebasing."
    if [[ "$stashed" == "true" ]]; then git stash pop; fi
    exit 1
  fi
fi

# 6. Rebase onto main
git rebase "origin/$main_branch"

# 7. Pop stash if we stashed
if [[ "$stashed" == "true" ]]; then
  git stash pop
fi
```

## Conflict Handling

If rebase encounters conflicts:
1. Report the conflicting files to the user
2. Ask if they want to resolve or abort (`git rebase --abort`)
3. Do NOT force-resolve conflicts without user input

## Guardrails

- Refuses to run on main/master (nothing to sync)
- Stashes uncommitted work before rebasing, pops after
- Uses rebase (not merge) to keep history clean
- Never force-pushes — user decides when to push
- Reports conflict state clearly if rebase fails
