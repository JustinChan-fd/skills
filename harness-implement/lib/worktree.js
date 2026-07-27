/**
 * Resolve worktree setup strategy from args.
 * When the conductor (harness-run) already provisioned a worktree, skip creation.
 *
 * @param {object} args - workflow args (args.worktreePath, args.runBranch)
 * @param {string} branchName - derived branch name (implement/<planKey>)
 * @param {string|null} baseBranch - base branch passed by caller
 * @returns {{ skip: true, worktreePath, branch, baseBranch }
 *          | { skip: false }}
 */
export function resolveWorktreeArgs(args, branchName, baseBranch) {
  if (!args.worktreePath) return { skip: false }

  return {
    skip:         true,
    worktreePath: args.worktreePath,
    branch:       args.runBranch || branchName,
    baseBranch:   baseBranch || 'unknown',
  }
}
