// The in-workflow manifest write, and the subtask identity it depends on.
//
// Both halves exist because the same mistake was made twice. The telemetry append lived in
// SKILL.md as prose the main agent was asked to run after Workflow() returned, and for the
// whole bridge era it silently did not happen — a missing record was indistinguishable from a
// stage that never ran. The manifest write is the same shape (SKILL.md steps 6 and 11), and
// it is the artifact the ENTIRE downstream chain keys off: no manifest, no `--intake`, no
// harness-plan. So it moves into the workflow's Debrief for the same reason.
//
// Subtask identity moved for a different reason. Until now the only stable handle a subtask
// had was `jiraKey`, minted by a createJiraIssue call behind a human confirmation gate. With
// Jira creation removed — decomps are phased commits on the PR, not Jira issues — that handle
// is gone, and the fallback was the title: long, colon-and-paren laden, and rewritten
// whenever the split agent rewords. `G1-2` is stable, sortable, and legible as a CLI arg.
//
// Workflow scripts have no filesystem API, so the write itself must be an agent(). These are
// the pure builders that drive it.
//
// KEEP IN SYNC with the inline mirrors in workflow.js (inline-mirror.test.js enforces it).

/**
 * Stamp a deterministic `id` onto every subtask: `G1-1`, `G1-2`, `G2-1`, …
 *
 * Per-group and 1-based, so the id states which wave the task belongs to and where it sits
 * inside it — `G2-1` reads as "first task of the second wave". A global counter would render
 * that same task `G2-3` and the id would carry no wave information.
 *
 * The subtask's own `groupId` wins over the enclosing group's. `propagateManifestFields` sets
 * it per subtask and the group wrapper is derived FROM it, so if the two ever disagree the
 * subtask's value is what harness-plan actually reads.
 *
 * An existing id is left alone: a second pass over an already-identified manifest must be a
 * no-op, or ids that `dependsOn` and `--entry` already point at get silently renumbered.
 *
 * Mutates in place and returns the same array — the workflow passes `groups` straight into
 * `intakeManifest`, so a returned clone would leave the manifest on disk id-less.
 */
export function assignSubtaskIds(groups) {
  if (!Array.isArray(groups)) return groups
  for (const group of groups) {
    const subtasks = group?.subtasks
    if (!Array.isArray(subtasks)) continue
    let n = 0
    for (const s of subtasks) {
      n++
      if (!s || typeof s !== 'object' || s.id) continue
      s.id = `${s.groupId || group?.groupId || 'G?'}-${n}`
    }
  }
  return groups
}

/**
 * Where the intake manifest goes.
 *
 * Same `__`-delimited convention as buildTelemetryPath, so both artifacts of one run carry
 * the same four segments and sort together:
 *   {repoPath}/docs/manifests/{repo}__harness-intake__{key}__{ts}__manifest.json
 *
 * Absolute by construction. SKILL.md asked for that in prose ("Path must be absolute … NOT
 * docs/manifests/") because a relative path resolves against whatever cwd the main agent
 * happened to hold; prose could not enforce it, a function can.
 *
 * repoName is preferred over the repoPath tail so a conductor worktree run writes
 * `webtarsthree__…` rather than `wt-TARS-1271-…__…`.
 */
export function buildManifestPath({ repoPath, repoName, issueKey, timestamp }) {
  const repo = repoName || (repoPath || '').replace(/\/$/, '').split('/').pop() || 'repo'
  const key  = issueKey || 'intake'
  const ts   = timestamp || 'unknown-ts'
  return `${repoPath}/docs/manifests/${repo}__harness-intake__${key}__${ts}__manifest.json`
}

/**
 * The prompt for the Debrief manifest-write agent.
 *
 * The manifest is stated as pretty-printed JSON data for the agent to write with the Write
 * tool — never interpolated into a shell command. Manifest strings come from ticket text and
 * agent output, so `$(…)`, backticks and quotes all pass through here; as data they are inert.
 *
 * Pretty-printed on purpose: this file is read by humans reviewing a split and by
 * `harness-plan --intake`, and a one-line 13KB JSON blob is hostile to the former.
 *
 * States OVERWRITE explicitly, which is the opposite of the telemetry prompt's APPEND. One
 * manifest is one JSON document per run and appending to it produces a file no parser
 * accepts; the telemetry file is JSONL and overwriting it destroys prior runs. Getting the
 * two backwards corrupts one artifact or the other, so neither leaves it implied.
 *
 * @returns {string|null} null when there is nothing to write, so the caller can skip the
 *   agent rather than spawn one to write nothing.
 */
export function buildManifestWritePrompt({ manifestPath, manifest }) {
  if (!manifestPath || !manifest) return null

  return `Write this skill's intake manifest to disk. One step.

Write the JSON below to exactly this absolute path, using the Write tool:
  ${manifestPath}

Create the parent directory first if it does not exist (mkdir -p "$(dirname '${manifestPath}')").

OVERWRITE the file if it already exists — this is one JSON document describing one run, not
a log. Do NOT append: appending produces a file no JSON parser will accept, and
\`harness-plan --intake\` reads this path directly.

Write the content verbatim, exactly as given. Do not reformat, re-key, summarize, add fields,
or "fix" anything — every field here is part of the handoff contract with harness-plan, and a
dropped key becomes a silently missing scope boundary downstream:

${JSON.stringify(manifest, null, 2)}

Report "MANIFEST_OK <path>" or "MANIFEST_ERROR: <reason>". If the write fails, say so
explicitly — the whole downstream chain reads this file, so a silent failure here strands the
run with no way to continue.`
}
