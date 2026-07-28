// RED first: this module does not exist yet.
//
// Two jobs, both previously done outside the workflow:
//
//   1. Subtask identity. Until now the only stable handle a subtask had was `jiraKey`,
//      minted by a `createJiraIssue` call in SKILL.md. With Jira creation removed (decomps
//      are phased commits on the PR, not Jira issues) that handle vanishes, and `dependsOn`
//      is a list of TITLES — long, punctuated, and rewritten whenever the split agent
//      rewords. assignSubtaskIds gives every subtask a deterministic `G<n>-<i>` id.
//
//   2. The manifest write itself. SKILL.md steps 6 and 11 asked the MAIN AGENT to write
//      the manifest after Workflow() returned — the identical shape as the telemetry append
//      that silently never ran for the entire bridge era. Same fix: build the path and the
//      agent prompt here, in testable pure functions, and have the workflow spawn the agent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assignSubtaskIds,
  buildManifestPath,
  buildManifestWritePrompt,
} from './manifest-write.js'

// ── assignSubtaskIds ─────────────────────────────────────────────────────────

test('ids are per-group and 1-based, in array order', () => {
  const groups = [
    { groupId: 'G1', subtasks: [{ title: 'a' }, { title: 'b' }] },
    { groupId: 'G2', subtasks: [{ title: 'c' }] },
  ]
  assignSubtaskIds(groups)
  assert.deepEqual(groups[0].subtasks.map(s => s.id), ['G1-1', 'G1-2'])
  assert.deepEqual(groups[1].subtasks.map(s => s.id), ['G2-1'])
})

test('the counter resets per group, so G2 starts at 1 not 3', () => {
  // The whole point of a per-group id: G2-1 reads as "first task of the second wave".
  // A global counter would make it G2-3 and the id would stop carrying that meaning.
  const groups = [
    { groupId: 'G1', subtasks: [{}, {}] },
    { groupId: 'G2', subtasks: [{}, {}] },
  ]
  assignSubtaskIds(groups)
  assert.deepEqual(groups[1].subtasks.map(s => s.id), ['G2-1', 'G2-2'])
})

test('a subtask groupId overrides the group it is nested under', () => {
  // propagateManifestFields sets s.groupId; the group wrapper is derived from it. If the
  // two ever disagree the subtask's own value is the one harness-plan reads, so it wins.
  const groups = [{ groupId: 'G1', subtasks: [{ groupId: 'G2' }] }]
  assignSubtaskIds(groups)
  assert.equal(groups[0].subtasks[0].id, 'G2-1')
})

test('an existing id is never overwritten', () => {
  // Re-running over an already-identified manifest must be a no-op, or a second pass
  // silently renumbers ids that dependsOn/--entry already point at.
  const groups = [{ groupId: 'G1', subtasks: [{ id: 'G1-7' }, {}] }]
  assignSubtaskIds(groups)
  assert.deepEqual(groups[0].subtasks.map(s => s.id), ['G1-7', 'G1-2'])
})

test('ids are unique across the whole manifest', () => {
  const groups = [
    { groupId: 'G1', subtasks: [{}, {}, {}] },
    { groupId: 'G2', subtasks: [{}, {}] },
    { groupId: 'G3', subtasks: [{}] },
  ]
  assignSubtaskIds(groups)
  const ids = groups.flatMap(g => g.subtasks.map(s => s.id))
  assert.equal(new Set(ids).size, ids.length)
})

test('returns the same array it was handed, mutated in place', () => {
  // The workflow builds `groups` then passes it straight into intakeManifest, so this must
  // mutate rather than copy — a returned clone would leave the manifest id-less.
  const groups = [{ groupId: 'G1', subtasks: [{}] }]
  assert.equal(assignSubtaskIds(groups), groups)
  assert.equal(groups[0].subtasks[0].id, 'G1-1')
})

test('missing groupId falls back to G? rather than emitting undefined-1', () => {
  const groups = [{ subtasks: [{}] }]
  assignSubtaskIds(groups)
  assert.equal(groups[0].subtasks[0].id, 'G?-1')
})

test('degenerate inputs are inert — never throws', () => {
  for (const bad of [null, undefined, [], 'nope', 42, [{}], [{ subtasks: null }]]) {
    assert.doesNotThrow(() => assignSubtaskIds(bad), `threw on ${JSON.stringify(bad)}`)
  }
})

// ── buildManifestPath ────────────────────────────────────────────────────────
//
// Mirrors buildTelemetryPath's __-delimited convention so both artifacts of one run carry
// the same four segments and sort together.

test('path is {repoPath}/docs/manifests/{repo}__harness-intake__{key}__{ts}__manifest.json', () => {
  assert.equal(
    buildManifestPath({ repoPath: '/Users/me/Desktop/Repos/webtarsthree', issueKey: 'TARS-1271', timestamp: '20260728T022825Z' }),
    '/Users/me/Desktop/Repos/webtarsthree/docs/manifests/webtarsthree__harness-intake__TARS-1271__20260728T022825Z__manifest.json',
  )
})

test('the path is absolute — a relative one silently writes to the wrong repo', () => {
  // SKILL.md called this out in prose ("Path must be absolute ... NOT docs/manifests/").
  // Prose could not enforce it; this can.
  const p = buildManifestPath({ repoPath: '/Users/me/Desktop/Repos/x', issueKey: 'A-1', timestamp: 'ts' })
  assert.ok(p.startsWith('/'), `not absolute: ${p}`)
})

test('repoName overrides the repoPath tail, so a worktree run is not named after its dir', () => {
  assert.match(
    buildManifestPath({ repoPath: '/Users/me/Desktop/Repos/wt-TARS-1271-20260727T194141Z', repoName: 'webtarsthree', issueKey: 'TARS-1271', timestamp: 'ts' }),
    /\/manifests\/webtarsthree__harness-intake__/,
  )
})

test('a missing issueKey falls back to the literal "intake", never "null"', () => {
  const p = buildManifestPath({ repoPath: '/r/Desktop/Repos/x', issueKey: null, timestamp: 'ts' })
  assert.ok(p.includes('__intake__'), p)
  assert.ok(!p.includes('null'), p)
})

test('a missing timestamp still yields a usable path', () => {
  const p = buildManifestPath({ repoPath: '/r/Desktop/Repos/x', issueKey: 'A-1' })
  assert.ok(p.endsWith('__manifest.json'), p)
  assert.ok(!p.includes('undefined'), p)
})

// ── buildManifestWritePrompt ─────────────────────────────────────────────────

test('the prompt names the path and carries the serialized manifest', () => {
  const manifest = { skill: 'harness-intake', size: 'M', groups: [] }
  const prompt = buildManifestWritePrompt({ manifestPath: '/r/docs/manifests/m.json', manifest })
  assert.ok(prompt.includes('/r/docs/manifests/m.json'))
  assert.ok(prompt.includes('"skill": "harness-intake"'), 'manifest not present as JSON')
})

test('the manifest is pretty-printed — this file is read by humans and by --intake', () => {
  const prompt = buildManifestWritePrompt({ manifestPath: '/r/m.json', manifest: { a: { b: 1 } } })
  assert.ok(prompt.includes('\n  "a"'), 'not indented')
})

test('the prompt says overwrite, and forbids append explicitly', () => {
  // The opposite of the telemetry prompt, which must append. Getting these backwards
  // corrupts one artifact or the other: appending to a JSON document produces a file no
  // parser accepts, and overwriting a JSONL log destroys every prior run.
  //
  // An earlier version of this test banned the word "append" outright, which the
  // implementation failed for the right reason — it says "Do NOT append". Naming the wrong
  // mode and rejecting it is stronger than staying silent about it, so what this asserts is
  // that every mention of appending is negated, not that none exists.
  const prompt = buildManifestWritePrompt({ manifestPath: '/r/m.json', manifest: {} })
  assert.match(prompt, /overwrite|replace/i)
  assert.match(prompt, /(do not|don't|never)\s+append/i, 'append is not explicitly forbidden')
  // The telemetry prompt's exact instruction, which must never appear here.
  assert.ok(!/append, never overwrite/i.test(prompt), 'carries the JSONL append instruction')
})

test('the prompt tells the agent to create the parent directory', () => {
  const prompt = buildManifestWritePrompt({ manifestPath: '/r/docs/manifests/m.json', manifest: {} })
  assert.match(prompt, /mkdir -p|create.*director/i)
})

test('the prompt asks for a MANIFEST_OK / MANIFEST_ERROR verdict', () => {
  const prompt = buildManifestWritePrompt({ manifestPath: '/r/m.json', manifest: {} })
  assert.ok(prompt.includes('MANIFEST_OK'))
  assert.ok(prompt.includes('MANIFEST_ERROR'))
})

test('a manifest carrying shell metacharacters is inert', () => {
  // Manifest strings come from ticket text and agent output — `$(…)`, backticks and quotes
  // all reach this builder. They are data for a Write tool, never shell.
  const manifest = { sourceTitle: `$(id) \`whoami\` 'q' "d"`, groups: [] }
  const prompt = buildManifestWritePrompt({ manifestPath: '/r/m.json', manifest })
  assert.ok(prompt.includes('$(id)'), 'payload should be stated verbatim as data')
  assert.ok(!/echo .*\$\(id\).*>>/.test(prompt), 'payload reached shell position')
})

test('null manifest or path returns null rather than a prompt to write nothing', () => {
  assert.equal(buildManifestWritePrompt({ manifestPath: null, manifest: { a: 1 } }), null)
  assert.equal(buildManifestWritePrompt({ manifestPath: '/r/m.json', manifest: null }), null)
})
