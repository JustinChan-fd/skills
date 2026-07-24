---
name: open-in-vscode
description: Use when you want to open the repo, main branch, or a worktree in VS Code. Pass a branch name as an argument to target it; omit to open the most recently active worktree or main repo.
---

# open-in-vscode

Open the current repo or a worktree in VS Code.

## Usage

```
/open-in-vscode [branch-name]
```

- **No argument** — opens the worktree with the most recent git activity (latest commit timestamp across all worktrees), falling back to the main repo root if none found.
- **Branch argument** — opens the worktree for that branch. Partial matches work (e.g. `TARS-1300` matches `fix/tars-1300-...`).

## Steps

Run the script:

```bash
bash ~/.claude/skills/open-in-vscode/open-in-vscode.sh [branch-fragment]
```

The script handles everything — worktree lookup, main branch fallback, and calling `code <path>`. Report the output line back to the user.

## Example

```bash
# Open most recently active worktree
/open-in-vscode

# Open a specific branch
/open-in-vscode TARS-1300
/open-in-vscode phase-1-tier-1
```

## Notes

- Worktrees live under `.claude/worktrees/` in this repo.
- If `code` is not in PATH, remind the user to install the VS Code Shell Command (`Shell Command: Install 'code' command in PATH` from the Command Palette).
