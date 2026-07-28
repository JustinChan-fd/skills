// Branch-seeding & cleanup tooling for the verifier-calibration probe.
//
// Every function here is PURE command computation: it returns ordered op
// objects and never touches a git checkout itself. All side effects run
// through an injected executor (see runOps), so tests never mutate the real
// tools-resume-builder working tree.
//
// Hard contract: no generated op ever names `main`/`master` as a target or
// contains a push/merge verb — validateNoMainMutation enforces this
// mechanically (the "no probe artifacts land on main" criterion), and the
// seeded probe branches are throwaway locals that are NEVER pushed or merged.

/** Throwaway branch name for a defect. */
export function branchName(defect) {
  return `probe/${defect.defect_id}`;
}

/** Basename of a path (no dirs). */
function basename(p) {
  return String(p).split('/').pop();
}

/**
 * Neutral commit subject for a seeded defect — names only the touched file, so
 * `git log` never advertises that the branch carries a planted defect.
 */
export function commitSubject(defect) {
  const file = basename((defect.target_files ?? ['source'])[0]);
  return `chore: update ${file}`;
}

/**
 * Ordered ops to create the throwaway branch from the defect's OWN host_branch
 * tip and apply its patch. Stages ONLY the declared target files (never -A/-a)
 * so tools-resume-builder's pre-existing unrelated uncommitted state
 * (package-lock.json, .claude/launch.json) is never swept into a commit.
 *
 * @param {object} defect
 * @param {object} [opts]
 * @param {string} [opts.baseRef] - override the base ref (e.g. an origin/... ref
 *        for a host branch that only exists on the remote).
 */
export function createOps(defect, opts = {}) {
  const branch = branchName(defect);
  const baseRef = opts.baseRef || defect.host_branch;
  return [
    { kind: 'git', argv: ['fetch', 'origin'] },
    { kind: 'git', argv: ['checkout', '-b', branch, baseRef] },
    { kind: 'patch', defect_id: defect.defect_id, target_files: defect.target_files, edits: defect.patch },
    { kind: 'git', argv: ['add', ...defect.target_files] },
    // Neutral, non-tell commit subject: the seeded change must not announce
    // itself as a planted probe defect in `git log`, or a source-/history-
    // reading verifier is handed the answer for free (defeats blind
    // measurement). The message names the touched file only.
    { kind: 'git', argv: ['commit', '-m', commitSubject(defect)] },
  ];
}

/**
 * Ordered ops to tear the throwaway branch down: leave it first (you can't
 * delete the checked-out branch), then force-delete the local branch. No push,
 * no merge, ever.
 *
 * @param {object} defect
 * @param {object} [opts]
 * @param {string} [opts.returnRef] - ref to check out before deleting (default:
 *        the defect's host_branch; must never be main).
 */
export function cleanupOps(defect, opts = {}) {
  const branch = branchName(defect);
  const returnRef = opts.returnRef || defect.host_branch;
  return [
    { kind: 'git', argv: ['checkout', returnRef] },
    { kind: 'git', argv: ['branch', '-D', branch] },
  ];
}

/**
 * Full ordered plan for every defect, WITHOUT executing anything — inspect
 * before touching the real checkout.
 */
export function dryRun(defects, opts = {}) {
  return defects.map((d) => ({
    defect_id: d.defect_id,
    branch: branchName(d),
    create: createOps(d, opts[d.defect_id]?.create ?? {}),
    cleanup: cleanupOps(d, opts[d.defect_id]?.cleanup ?? {}),
  }));
}

const FORBIDDEN_VERBS = new Set(['push', 'merge']);

/**
 * Throw if any git op in the sequence targets main/master or uses a push/merge
 * verb. Returns true when the sequence is clean.
 */
export function validateNoMainMutation(ops) {
  for (const op of ops) {
    if (op.kind !== 'git') continue;
    const argv = op.argv ?? [];
    const subcommand = argv[0];
    if (FORBIDDEN_VERBS.has(subcommand)) {
      throw new Error(`forbidden git verb "${subcommand}" in probe op: ${argv.join(' ')}`);
    }
    const joined = argv.join(' ');
    if (/\bpush\b|\bmerge\b/.test(joined)) {
      throw new Error(`forbidden push/merge in probe op: ${joined}`);
    }
    for (const arg of argv) {
      if (arg === 'main' || arg === 'master' || /(^|\/)(main|master)$/.test(arg)) {
        throw new Error(`probe op must never target ${arg}: ${joined}`);
      }
    }
  }
  return true;
}

/**
 * Apply a defect's edit ops to a file's string content (pure). Supports:
 *   { op: 'append', text }            — concatenate text at the end
 *   { op: 'replace', find, replace }  — swap an exact substring (fail-loud if
 *                                       absent, so a drifted anchor never
 *                                       silently no-ops)
 */
export function applyEdits(content, edits) {
  let out = content;
  for (const edit of edits) {
    if (edit.op === 'append') {
      out += edit.text;
    } else if (edit.op === 'replace') {
      if (!out.includes(edit.find)) {
        throw new Error(`replace find string not found (drifted anchor?): ${JSON.stringify(edit.find.slice(0, 60))}`);
      }
      out = out.replace(edit.find, edit.replace);
    } else {
      throw new Error(`unknown edit op: ${edit.op}`);
    }
  }
  return out;
}

/**
 * Drive an ordered op list through an injected executor. The executor isolates
 * all side effects:
 *   executor.runGit(argv)   — run a git command in the target repo
 *   executor.applyPatch(op) — apply a { defect_id, target_files, edits } patch
 *
 * validateNoMainMutation is run first as a safety net so no push/merge/main op
 * can ever reach the executor.
 */
export function runOps(ops, executor) {
  validateNoMainMutation(ops);
  for (const op of ops) {
    if (op.kind === 'git') {
      executor.runGit(op.argv);
    } else if (op.kind === 'patch') {
      executor.applyPatch(op);
    } else {
      throw new Error(`unknown op kind: ${op.kind}`);
    }
  }
}
