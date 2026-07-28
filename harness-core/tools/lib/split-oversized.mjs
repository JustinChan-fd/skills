// Deterministic enforcement of the per-task file bound.
//
// Splitting an oversized task's files[] into same-group parallel siblings is a
// mechanical operation that prompt prose could not hold: an architect facing
// 102 files rationalizes past a flat "1-3 files" rule that supplies neither
// reason nor method, and a schema maxItems just makes the agent retry blind. So
// the split runs in code, after the architect returns.
// SOURCE (why code, not prose): https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
//   "Many applications require the deterministic reliability that only code can provide."
//
// harness-implement already runs same-group tasks concurrently, downgrades to
// sequential only when two parallel tasks in a group share a file, and lands
// one commit per group. Same groupId + block:'parallel' + disjoint files[]
// rides all three — no new orchestration.
// Folded from the Desktop harness-plan/lib/split-oversized.js (its Workflow
// inline mirror is deleted — this is the single home now).

/** The per-task file cap: `cap` files pass, `cap + 1` splits. Matches intake's noOversized check (">8 files"). */
export const FILE_CAP = 8;

/** Directory portion of a path, '' for a bare filename. */
function dirOf(f) {
  const i = String(f).lastIndexOf('/');
  return i === -1 ? '' : String(f).slice(0, i);
}

/**
 * Excel-style suffix: a…z, then aa, ab, … so ids stay unique past 26 chunks.
 *
 * A duplicate id is not cosmetic — harness-plan's revision loop and harness-implement both
 * locate tasks with `findIndex(t => t.id === …)`, so two chunks sharing an id means one gets
 * patched twice and the other never.
 */
function suffixFor(n) {
  let s = '';
  let i = n;
  do {
    s = String.fromCharCode(97 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
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
  const byDir = new Map();
  for (const f of files) {
    if (!byDir.has(dirOf(f))) byDir.set(dirOf(f), []);
    byDir.get(dirOf(f)).push(f);
  }

  const chunks = [];
  let current = [];
  for (const group of byDir.values()) {
    if (group.length >= cap) {
      if (current.length) {
        chunks.push(current);
        current = [];
      }
      for (let i = 0; i < group.length; i += cap) chunks.push(group.slice(i, i + cap));
      continue;
    }
    if (current.length + group.length > cap) {
      chunks.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Rewrite the parent's DONE assertions so each chunk can verify itself.
 *
 * Load-bearing. A repo-wide grep DONE cannot pass until all files convert, so no chunk could
 * verify itself and every assertion would fail until the last sibling finished — verifying
 * nothing intermediate.
 *
 * Three strategies, in order:
 *   1. Substitute the chunk's files for a path argument in the parent's criterion.
 *   2. If no path is substitutable, synthesize a per-file loop over the chunk's files.
 *   3. The last chunk additionally retains the parent's criteria verbatim as a closure check —
 *      it is the only chunk for which a repo-wide assertion can legitimately pass.
 */
function scopeCriteria(criteria, chunkFilesList, isLast) {
  const list = Array.isArray(criteria) ? criteria : [];
  const fileList = chunkFilesList.join(' ');

  const scoped = list.map((c) => {
    const text = String(c);
    const pathRe = /(^|\s)(\.?\/?(?:[\w.-]+\/)+[\w.-]*)(?=\s|$)/;
    const m = text.match(pathRe);
    if (m && !/\.\w{1,4}$/.test(m[2])) {
      return text.replace(pathRe, `$1${fileList}`);
    }
    return `${text} — verified over this task's files only: ${fileList}`;
  });

  if (isLast && list.length) {
    return [...scoped, ...list.map(String)];
  }
  return scoped;
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
  if (!Array.isArray(tasks)) return [];

  const out = [];
  for (const task of tasks) {
    const files = Array.isArray(task?.files) ? task.files : null;
    if (!files || files.length <= cap) {
      out.push(task);
      continue;
    }

    const groups = chunkFiles(files, cap);
    groups.forEach((chunkList, i) => {
      const chunk = {
        ...task,
        id: `${task.id}${suffixFor(i)}`,
        title: `${task.title} (${dirOf(chunkList[0]) || 'files'}, ${chunkList.length} files)`,
        files: [...chunkList],
        groupId: task.groupId,
        block: 'parallel',
        acceptanceCriteria: scopeCriteria(task.acceptanceCriteria, chunkList, i === groups.length - 1),
      };
      out.push(chunk);
    });
  }
  return out;
}
