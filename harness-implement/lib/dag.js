// DAG file-conflict guard — verbatim from harness-implement/workflow.js:388-407
// Mutates tasks in place: if any parallel group has two tasks sharing a file,
// all tasks in that group are downgraded to sequential.
// Returns the same tasks array (for chaining in tests).
export function downgradeConflictingGroups(tasks) {
  const tasksByGroup = {}
  for (const task of tasks) {
    if (!tasksByGroup[task.groupId]) tasksByGroup[task.groupId] = []
    tasksByGroup[task.groupId].push(task)
  }
  for (const [, groupTasks] of Object.entries(tasksByGroup)) {
    if (groupTasks[0]?.block !== 'parallel' || groupTasks.length < 2) continue
    const seen = new Set()
    for (const task of groupTasks) {
      for (const f of task.files) {
        if (seen.has(f)) {
          for (const t of groupTasks) t.block = 'sequential'
          break
        }
        seen.add(f)
      }
    }
  }
  return tasks
}
