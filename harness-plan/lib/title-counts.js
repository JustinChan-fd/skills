// Reconcile file counts stated in task titles against the array they claim to describe.
//
// TARS-1271's T05 read `Migrate all remaining src/client/pages/ source files (~76 files)` against
// a 102-entry files[]. The count was model-authored prose; the array was ground truth; nothing
// compared them.
//
// splitOversizedTasks already closed this for OVERSIZED tasks — each chunk title is built from
// `chunkList.length`, so a split task cannot lie. What remains is every task AT OR UNDER the cap,
// which keeps the architect's title verbatim. `T03 | 7 files | Migrate src/client/hooks/ (7
// source files)` from that same plan happens to agree, and nothing would have noticed if it did
// not. T05 was caught because it was extreme, not because it was detected.
//
// Deliberately NOT in scope: `fileCountEstimate` (workflow.js:898, :902, :1063, :1250). That is
// produced by the intake sizing agent, which runs before any files[] exists — there is no array
// to count, so "estimated" is the honest word and it stays. Deriving it from something would
// mean inventing a source.
//
// KEEP IN SYNC with the inline `_reconcileTitleCounts` mirror in workflow.js
// (inline-mirror.test.js enforces it).

/**
 * A file count stated in prose: an optional `~`, a number, up to three qualifier words, `files`.
 *
 * Anchored on the word `files` on purpose. An unanchored `\d+` would treat `fetch API v2`,
 * `TARS-1271` and `axios 0.21 → 1.6` as counts and corrupt them.
 *
 * NOT global. A `/g` regex reused through `.test()` carries `lastIndex` between calls, so every
 * second identical check returns false — the reconciler would correct alternating tasks and skip
 * the rest, with a green suite.
 */
export const COUNT_RE = /~?\s*(\d+)(\s+(?:[\w-]+\s+){0,3}?)files\b/

/**
 * One task, reconciled.
 *
 * @returns {{task: object, correction: ?{id: string, stated: number, actual: number}}}
 *   `task` is the input BY IDENTITY unless a count actually disagreed.
 */
function reconcileOne(task) {
  const files = Array.isArray(task?.files) ? task.files : null
  // A fileless task has nothing to reconcile against, and "(0 files)" is worse than silence —
  // harness-plan's XS fast path hardcodes `files: []` by design.
  if (!files || files.length === 0) return { task, correction: null }
  if (typeof task.title !== 'string') return { task, correction: null }

  const m = task.title.match(COUNT_RE)
  if (!m) return { task, correction: null }

  const stated = Number(m[1])
  const actual = files.length
  if (stated === actual) return { task, correction: null }

  // The qualifier words are preserved so `76 MockAdapter test files` stays readable, and the
  // tilde is dropped: the number is now derived, so calling it approximate would be false in a
  // new way.
  const title = task.title.replace(COUNT_RE, `${actual}${m[2]}files`)
  return { task: { ...task, title }, correction: { id: task.id, stated, actual } }
}

/**
 * Rewrite any task title whose stated file count disagrees with `files.length`.
 *
 * Tasks with a correct count, no count, or no files are returned BY IDENTITY — the common case
 * is "nothing to fix", and churning references there would make a downstream `===` silently stop
 * matching for no gain. Never mutates an input task: the caller still holds the architect's own
 * output and may log or diff against it.
 *
 * Malformed input degrades quietly rather than throwing. This runs inside the plan pipeline, and
 * failing a whole concern over a cosmetic title is strictly worse than a stale count.
 *
 * @param {object[]} tasks
 * @returns {object[]} tasks in input order
 */
export function reconcileTitleCounts(tasks) {
  if (!Array.isArray(tasks)) return []
  return tasks.map(t => reconcileOne(t).task)
}

/**
 * Count files across the final task list, for the synthesizer to state verbatim.
 *
 * The reconciler above fixes counts the ARCHITECT wrote. The synthesizer writes counts too — the
 * Summary paragraph and the Files in Scope table — and its prompt hands it `research.filesInScope`
 * sliced to 20 entries and nothing else. So on any plan touching more than 20 files it cannot
 * count; it can only estimate. Same defect as T05's title, one stage later, and structural rather
 * than occasional.
 *
 * `totalFiles` is DISTINCT files, not the sum of per-task lengths: after a split, siblings are
 * disjoint, but two unrelated tasks may legitimately touch one shared file, and summing would
 * claim more files than exist.
 *
 * @param {object[]} tasks
 * @returns {{totalFiles: number, taskCount: number, byTask: Object<string, number>, promptBlock: string}}
 */
export function fileCountSummary(tasks) {
  const list = Array.isArray(tasks) ? tasks.filter(t => t && typeof t === 'object') : []
  const distinct = new Set()
  const byTask = {}
  for (const t of list) {
    const files = Array.isArray(t.files) ? t.files : []
    // Every task appears, including fileless ones: an id absent from byTask reads as "not counted
    // yet" rather than "touches no files", which is exactly the gap a model fills with a guess.
    byTask[t.id] = files.length
    for (const f of files) distinct.add(f)
  }
  const totalFiles = distinct.size
  const promptBlock = [
    'FILE_COUNTS (authoritative — derived from the task files[] arrays; state these exactly, do not recount or round):',
    `- total distinct files in scope: ${totalFiles}`,
    `- tasks: ${list.length}`,
    ...Object.entries(byTask).map(([id, n]) => `- ${id}: ${n}`),
  ].join('\n')
  return { totalFiles, taskCount: list.length, byTask, promptBlock }
}

/**
 * As `reconcileTitleCounts`, but also returns what it changed.
 *
 * Silent correction just relocates the original silence — a number nothing reconciled against the
 * array. The workflow logs these so a corrected count is visible in the run, the same way
 * `splitOversizedTasks` logs a split.
 *
 * @returns {{tasks: object[], corrections: Array<{id: string, stated: number, actual: number}>}}
 */
reconcileTitleCounts.withReport = function withReport(tasks) {
  if (!Array.isArray(tasks)) return { tasks: [], corrections: [] }
  const out = []
  const corrections = []
  for (const t of tasks) {
    const { task, correction } = reconcileOne(t)
    out.push(task)
    if (correction) corrections.push(correction)
  }
  return { tasks: out, corrections }
}
