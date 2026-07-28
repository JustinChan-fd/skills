// Deterministic enforcement of the per-task file bound.
//
// The rule existed only as prompt prose — `task-files-present-bounded → every task carries 1–3
// concrete files[]` — inside `refineBlock`, injected behind a `refine` flag that has been falsy
// at every call since the bridge was removed. Dead text, and a regression the bridge removal
// introduced rather than an architect defying a live rule.
//
// Measured cost: TARS-1271's T05 was one developer agent grinding a 102-entry files[] one
// Read+Edit at a time — 27 files in ~25 min before it abandoned per-file edits for improvised
// regex batch-rewriters and shipped a res.data-vs-res bug the conversion table stated verbatim.
//
// Prompt text cannot fix this on its own: an architect facing 102 files rationalizes past a
// flat "1–3 files" that supplies neither reason nor method. Schema-level `maxItems` was
// rejected too — it makes the agent retry blind with no instruction on HOW to split. So the
// enforcement is deterministic and runs after the architect returns.
//
// No new orchestration is needed. harness-implement already runs same-group tasks concurrently,
// downgrades to sequential ONLY when two parallel tasks in a group share a file, and lands one
// commit per group. Same groupId + block:'parallel' + disjoint files[] rides all three.
//
// KEEP IN SYNC with the inline `_splitOversizedTasks` mirror in workflow.js
// (inline-mirror.test.js enforces it).

/** Matches _FILE_BUDGET_CAP in workflow.js and intake's noOversized check (">8 files"). */
export const FILE_CAP = 8

/**
 * Directory portion of a path, '' for a bare filename.
 *
 * A function declaration rather than an arrow const on purpose: the inline-mirror harness
 * slices declarations out of workflow.js as text, and its const extractor can only balance a
 * bracketed initialiser — an arrow body gets truncated at the first newline and the mirror
 * fails to compile.
 */
function dirOf(f) {
  const i = String(f).lastIndexOf('/')
  return i === -1 ? '' : String(f).slice(0, i)
}

/**
 * Excel-style suffix: a…z, then aa, ab, … so ids stay unique past 26 chunks.
 *
 * A duplicate id is not cosmetic — harness-plan's revision loop and harness-implement both
 * locate tasks with `findIndex(t => t.id === …)`, so two chunks sharing an id means one gets
 * patched twice and the other never.
 */
function suffixFor(n) {
  let s = ''
  let i = n
  do { s = String.fromCharCode(97 + (i % 26)) + s; i = Math.floor(i / 26) - 1 } while (i >= 0)
  return s
}

/**
 * Group files by directory, then pack directories into chunks of at most `cap`.
 *
 * Directory-coherent rather than even N-way: files in one directory share imports and call
 * shapes, so one agent amortizes what it learns across them. An even split scatters
 * `campaigns/` across three agents that each rediscover the same pattern.
 *
 * A directory larger than `cap` is index-split within itself. Directories smaller than `cap`
 * are packed together — otherwise 12 single-file directories become 12 agents each paying full
 * context setup to edit one file, which is the opposite failure from the one being fixed.
 */
function chunkFiles(files, cap) {
  const byDir = new Map()
  for (const f of files) {
    if (!byDir.has(dirOf(f))) byDir.set(dirOf(f), [])
    byDir.get(dirOf(f)).push(f)
  }

  const chunks = []
  let current = []
  for (const group of byDir.values()) {
    if (group.length >= cap) {
      // Big directory: flush what is packed, then split this one on its own.
      if (current.length) { chunks.push(current); current = [] }
      for (let i = 0; i < group.length; i += cap) chunks.push(group.slice(i, i + cap))
      continue
    }
    if (current.length + group.length > cap) { chunks.push(current); current = [] }
    current.push(...group)
  }
  if (current.length) chunks.push(current)
  return chunks
}

/**
 * Rewrite the parent's DONE assertions so each chunk can verify itself.
 *
 * Load-bearing. T05's DONE was a repo-wide grep that cannot pass until all 102 files convert,
 * so no chunk could verify itself and every assertion failed until the last sibling finished —
 * verifying nothing intermediate.
 *
 * Three strategies, in order:
 *   1. Substitute the chunk's files for a path argument in the parent's criterion.
 *   2. If no path is substitutable, synthesize a per-file loop over the chunk's files.
 *   3. The last chunk additionally retains the parent's criteria verbatim as a closure check —
 *      it is the only chunk for which a repo-wide assertion can legitimately pass.
 */
function scopeCriteria(criteria, chunkFilesList, isLast) {
  const list = Array.isArray(criteria) ? criteria : []
  const fileList = chunkFilesList.join(' ')

  const scoped = list.map(c => {
    const text = String(c)
    // A bare path argument: `src/`, `src/client`, `./src/client/`. Deliberately does not match
    // a filename (a criterion naming one file is already scoped).
    const pathRe = /(^|\s)(\.?\/?(?:[\w.-]+\/)+[\w.-]*)(?=\s|$)/
    const m = text.match(pathRe)
    if (m && !/\.\w{1,4}$/.test(m[2])) {
      return text.replace(pathRe, `$1${fileList}`)
    }
    return `${text} — verified over this task's files only: ${fileList}`
  })

  if (isLast && list.length) {
    // Retained exactly once, and only here: a repo-wide check can only pass after every
    // sibling has landed, which is true for the last chunk alone.
    return [...scoped, ...list.map(String)]
  }
  return scoped
}

/**
 * Split any task whose files[] exceeds `cap` into same-group parallel siblings.
 *
 * Tasks at or under the cap are returned BY IDENTITY, not copied — a fileless task (the XS fast
 * path hardcodes `files: []`) and a small task must come back as the very same object, so a
 * downstream `===` never silently stops matching.
 *
 * @param {object[]} tasks
 * @param {number} cap - inclusive; `cap` files pass, `cap + 1` splits
 * @returns {object[]} tasks in input order, each oversized task replaced by its chunks
 */
export function splitOversizedTasks(tasks, cap = FILE_CAP) {
  if (!Array.isArray(tasks)) return []

  const out = []
  for (const task of tasks) {
    const files = Array.isArray(task?.files) ? task.files : null
    if (!files || files.length <= cap) { out.push(task); continue }

    const groups = chunkFiles(files, cap)
    groups.forEach((chunkList, i) => {
      const chunk = {
        ...task,
        id: `${task.id}${suffixFor(i)}`,
        title: `${task.title} (${dirOf(chunkList[0]) || 'files'}, ${chunkList.length} files)`,
        files: [...chunkList],
        // Inherited unchanged: this is what rides harness-implement's group-parallel path and
        // keeps the chunks landing as ONE commit.
        groupId: task.groupId,
        block: 'parallel',
        acceptanceCriteria: scopeCriteria(task.acceptanceCriteria, chunkList, i === groups.length - 1),
      }
      // dependsOn is inherited by the spread. Siblings must NOT depend on each other — that
      // would serialize them and undo the split.
      out.push(chunk)
    })
  }
  return out
}
