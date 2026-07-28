// Resolving `--entry <id>` against an intake manifest.
//
// This used to be three lines of SKILL.md prose:
//
//   splitManifest.groups.flatMap(g => g.subtasks).find(s => s.jiraKey === entryKey)
//
// Two things were wrong with it. The field is gone — harness-intake stopped creating Jira
// subtasks (decomps are phased commits on the PR), so nothing mints a jiraKey and every
// subtask's is undefined. And the comparison fails open: `undefined === undefined` is true, so
// a missing entryKey matched the FIRST subtask and the run planned the wrong scope with no
// warning. A silently wrong entry is worse than an unresolvable one.
//
// It also stitched `groundedReality` and `migrationPattern` onto the entry by hand at the call
// site, which meant any other caller got a subtask stripped of the ground truth that is
// supposed to outrank the ticket text. That stitching lives here now.
//
// KEEP IN SYNC with the inline mirrors in workflow.js (inline-mirror.test.js enforces it):
// resolveManifestEntry/listEntryIds run in the SKILL.md wrapper before Workflow() is fired,
// but deriveIssueKey runs inside the workflow and is mirrored there.

import { slugFromInput } from './telemetry.js'

/** Every subtask across every group, in manifest order. Degenerate input yields []. */
function allSubtasks(manifest) {
  const groups = manifest && typeof manifest === 'object' ? manifest.groups : null
  if (!Array.isArray(groups)) return []
  return groups.flatMap(g => (Array.isArray(g?.subtasks) ? g.subtasks : [])).filter(s => s && typeof s === 'object')
}

/** The handle a subtask is addressable by: its id, or a legacy jiraKey. */
function handleFor(subtask) {
  return subtask?.id || subtask?.jiraKey || null
}

/**
 * Every addressable id in the manifest, in order.
 *
 * Used to build the "available ids" half of a resolution error, and by callers that want to
 * list what can be planned. Subtasks with neither an id nor a legacy jiraKey are skipped —
 * they are unaddressable, so offering them would be a dead end.
 */
export function listEntryIds(manifest) {
  return allSubtasks(manifest).map(handleFor).filter(Boolean)
}

/**
 * The ticket key this run should be filed under.
 *
 * Precedence, and why each step is where it is:
 *
 *   1. A `[A-Z]+-\d+` in the input text — the most specific statement available, and what a
 *      user typing a URL or pasting a ticket expects.
 *   2. The entry's `sourceIssue` — the parent ticket the manifest was built from. This is the
 *      step that was missing: the middle of the old chain was `manifestEntry?.jiraKey`, now
 *      always undefined, so a subtask description that does not happen to quote its own ticket
 *      key fell straight through to the slug. The record then lands under
 *      `migrate-campaigns-to-clientfetch` and cannot be joined to TARS-1271 or to the intake
 *      record of the same logical run — which defeats the shared runId.
 *   3. A legacy `jiraKey`, for manifests written before subtask creation was removed.
 *   4. A slug of the input.
 *
 * A subtask `id` is deliberately NOT in this chain. `G1-1` is not a ticket, and ids restart at
 * G1-1 in every manifest, so filing telemetry under one would collide across unrelated runs.
 *
 * Never returns null: the value becomes a filename segment, and a null there yields
 * `__null__` in a path the dashboard parses into four bad `__` segments.
 */
export function deriveIssueKey(opts) {
  // Read off a local rather than destructuring in the signature: a parameter default only
  // applies to `undefined`, so `deriveIssueKey(null)` would throw on destructure. Callers pass
  // `{input, entry: manifestEntry}` where manifestEntry is routinely null.
  const { input, entry } = opts || {}
  const fromText = String(input || '').match(/\b([A-Z]+-\d+)\b/)?.[1]
  return fromText || entry?.sourceIssue || entry?.jiraKey || slugFromInput(input)
}

/**
 * Find the subtask `entryKey` names.
 *
 * Returns `{entry, error}` rather than throwing or returning bare null: the caller is a
 * SKILL.md wrapper that has to print something a human can act on, and "not found" plus the
 * list of ids that do exist is the difference between a dead end and a corrected command.
 *
 * Matching is case-insensitive and trims whitespace, because these ids are typed at a CLI or
 * copied out of a summary box — `g1-1` is unambiguous and rejecting it buys nothing.
 *
 * `id` is checked before `jiraKey` in a single pass over all subtasks, so a legacy jiraKey that
 * happens to collide with a new-style id cannot shadow the real one.
 *
 * The returned entry is a shallow copy with manifest-level `migrationPattern`,
 * `groundedReality` and `sourceIssue` filled in where the subtask lacks them. The subtask's own
 * value always wins — it is the more specific statement. Nothing is mutated: the manifest is a
 * file the caller may still write back.
 */
export function resolveManifestEntry(manifest, entryKey) {
  const key = typeof entryKey === 'string' ? entryKey.trim() : entryKey
  if (!key) {
    return { entry: null, error: 'no --entry given: an L manifest has several subtasks and there is no sensible default. Pass --entry <id>, e.g. --entry G1-1.' }
  }

  const subtasks = allSubtasks(manifest)
  if (!subtasks.length) {
    return { entry: null, error: `manifest has no groups[*].subtasks[] to resolve --entry ${key} against — is this an XS/S/M manifest? Those have no subtasks; drop --entry.` }
  }

  const want = String(key).toLowerCase()
  const byId = subtasks.find(s => String(s.id || '').toLowerCase() === want)
  const found = byId || subtasks.find(s => String(s.jiraKey || '').toLowerCase() === want)

  if (!found) {
    const ids = listEntryIds(manifest)
    return { entry: null, error: `no subtask with id "${key}". Available: ${ids.join(', ') || '(none addressable)'}` }
  }

  return {
    entry: {
      ...found,
      migrationPattern: found.migrationPattern || manifest.migrationPattern || null,
      groundedReality:  found.groundedReality  || manifest.groundedReality  || null,
      sourceIssue:      found.sourceIssue      || manifest.sourceIssue      || null,
    },
    error: null,
  }
}
