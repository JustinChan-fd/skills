#!/usr/bin/env bash
# Usage: open-in-vscode.sh [branch-fragment]
# Opens the matching worktree (or main repo) in VS Code.

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$REPO_ROOT" ]]; then
  echo "Error: not inside a git repository" >&2
  exit 1
fi

# Resolve the main (primary) worktree path — the first entry in worktree list.
# This is stable regardless of which worktree the script runs from.
MAIN_WORKTREE=$(git worktree list --porcelain | awk '/^worktree / { print $2; exit }')

QUERY="${1:-}"

# Build list of worktrees: "path branch" per line
WORKTREES=$(git worktree list --porcelain | awk '
  /^worktree / { path = $2 }
  /^branch /   { branch = $2; print path " " branch }
  /^bare$/     { print path " (bare)" }
')

if [[ -z "$QUERY" ]]; then
  # No argument: find the non-main worktree with the most recent commit.
  # Skip the main repo root so we prefer actual feature worktrees.
  BEST_PATH=""
  BEST_TS=0
  while IFS=' ' read -r wt_path wt_branch; do
    [[ "$wt_path" == "$MAIN_WORKTREE" ]] && continue  # skip main checkout
    TS=$(git -C "$wt_path" log -1 --format="%ct" 2>/dev/null)
    [[ -z "$TS" ]] && continue
    if (( TS > BEST_TS )); then
      BEST_TS=$TS
      BEST_PATH=$wt_path
    fi
  done <<< "$WORKTREES"

  TARGET="${BEST_PATH:-$REPO_ROOT}"
else
  # Argument given: match against branch name or path (case-insensitive)
  MATCH=""
  while IFS=' ' read -r wt_path wt_branch; do
    if echo "$wt_branch $wt_path" | grep -qi "$QUERY"; then
      MATCH="$wt_path"
      break
    fi
  done <<< "$WORKTREES"

  if [[ -z "$MATCH" ]]; then
    echo "Error: no worktree or branch matching '$QUERY'" >&2
    echo "Available:" >&2
    git worktree list >&2
    exit 1
  fi
  TARGET="$MATCH"
fi

echo "Opening $TARGET"
code "$TARGET"
