// RED first: this module does not exist yet.
//
// `--entry` used to take a jiraKey, resolved by SKILL.md prose:
//
//   splitManifest.groups.flatMap(g => g.subtasks).find(s => s.jiraKey === entryKey)
//
// harness-intake no longer creates Jira subtasks (decomps are phased commits on the PR), so
// nothing mints a jiraKey and every subtask's is undefined. That `.find` returns undefined for
// any input — and `undefined === undefined` is true, so an entryKey that is itself undefined
// matches the FIRST subtask rather than failing. A silently wrong subtask is worse than a
// missing one: the run proceeds and plans the wrong scope.
//
// The handle is now `id` (`G1-1`, `G2-1`). This module resolves it, tells the caller clearly
// when it cannot, and keeps reading manifests that predate the change.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveManifestEntry, listEntryIds, deriveIssueKey } from './manifest-entry.js'

const MANIFEST = {
  sourceIssue: 'TARS-1271',
  migrationPattern: 'axios → clientFetch',
  groundedReality: { summary: 'verified 92 files' },
  groups: [
    { groupId: 'G1', subtasks: [
      { id: 'G1-1', title: 'Migrate campaigns', description: 'do the thing', files: ['a.js'] },
      { id: 'G1-2', title: 'Migrate checkout', description: 'other thing', files: ['b.js'] },
    ] },
    { groupId: 'G2', subtasks: [
      { id: 'G2-1', title: 'Remove shim', description: 'cleanup', dependsOn: ['G1-1'] },
    ] },
  ],
}

// ── resolveManifestEntry ─────────────────────────────────────────────────────

test('resolves a subtask by its id', () => {
  assert.equal(resolveManifestEntry(MANIFEST, 'G1-2').entry.title, 'Migrate checkout')
})

test('resolves across groups, not just the first', () => {
  assert.equal(resolveManifestEntry(MANIFEST, 'G2-1').entry.title, 'Remove shim')
})

test('id matching is case-insensitive and tolerates surrounding whitespace', () => {
  // Typed by hand at a CLI, copied out of a summary box. `g1-1` is unambiguous.
  for (const k of ['g1-1', ' G1-1', 'G1-1 ']) {
    assert.equal(resolveManifestEntry(MANIFEST, k).entry.id, 'G1-1', `failed for ${JSON.stringify(k)}`)
  }
})

test('an unknown id returns an error naming the ids that DO exist', () => {
  // The failure a user actually hits is a typo or a stale id from an older manifest. Listing
  // the valid ones turns a dead end into a correction.
  const r = resolveManifestEntry(MANIFEST, 'G9-9')
  assert.equal(r.entry, null)
  assert.match(r.error, /G9-9/)
  assert.match(r.error, /G1-1.*G1-2.*G2-1/s, `available ids not listed: ${r.error}`)
})

test('a missing entryKey never silently matches a subtask', () => {
  // The precise bug in the old `.find(s => s.jiraKey === entryKey)`: with both sides
  // undefined it matched subtask #1 and planned the wrong scope with no warning.
  for (const k of [null, undefined, '']) {
    const r = resolveManifestEntry(MANIFEST, k)
    assert.equal(r.entry, null, `entryKey ${JSON.stringify(k)} matched something`)
    assert.match(r.error, /entry/i)
  }
})

test('a legacy manifest still resolves by jiraKey', () => {
  // Manifests written before the change are on disk and are valid input. Falling back keeps
  // them usable without a migration step.
  const legacy = { groups: [{ groupId: 'G1', subtasks: [{ jiraKey: 'TARS-1275', title: 'old' }] }] }
  assert.equal(resolveManifestEntry(legacy, 'TARS-1275').entry.title, 'old')
})

test('id wins over jiraKey when a manifest carries both', () => {
  const both = { groups: [{ groupId: 'G1', subtasks: [
    { id: 'G1-1', jiraKey: 'TARS-9', title: 'by id' },
    { id: 'G1-2', jiraKey: 'G1-1',   title: 'jiraKey collides with an id' },
  ] }] }
  assert.equal(resolveManifestEntry(both, 'G1-1').entry.title, 'by id')
})

test('the resolved entry inherits manifest-level fields the subtask lacks', () => {
  // The old SKILL.md prose stitched groundedReality and migrationPattern in by hand at the
  // call site. Doing it here means every caller gets it, and the researcher is never handed a
  // subtask stripped of the ground truth that outranks the ticket text.
  const { entry } = resolveManifestEntry(MANIFEST, 'G1-1')
  assert.equal(entry.migrationPattern, 'axios → clientFetch')
  assert.deepEqual(entry.groundedReality, { summary: 'verified 92 files' })
})

test('a subtask value always wins over the manifest-level one', () => {
  const m = { migrationPattern: 'top', groups: [{ subtasks: [{ id: 'G1-1', migrationPattern: 'own' }] }] }
  assert.equal(resolveManifestEntry(m, 'G1-1').entry.migrationPattern, 'own')
})

test('the resolved entry carries sourceIssue, so telemetry is filed under the real ticket', () => {
  // Without this the issueKey falls through to a slug of the description and the record lands
  // under a name no one can join back to TARS-1271.
  assert.equal(resolveManifestEntry(MANIFEST, 'G1-1').entry.sourceIssue, 'TARS-1271')
})

test('resolution does not mutate the manifest', () => {
  const before = JSON.stringify(MANIFEST)
  resolveManifestEntry(MANIFEST, 'G1-1')
  assert.equal(JSON.stringify(MANIFEST), before, 'the manifest on disk was edited in memory')
})

test('degenerate manifests return an error rather than throwing', () => {
  for (const bad of [null, undefined, {}, { groups: null }, { groups: [] }, { groups: [{}] }, { groups: [{ subtasks: null }] }, 'nope', 42]) {
    let r
    assert.doesNotThrow(() => { r = resolveManifestEntry(bad, 'G1-1') }, `threw on ${JSON.stringify(bad)}`)
    assert.equal(r.entry, null)
    assert.ok(r.error, `no error explaining the failure for ${JSON.stringify(bad)}`)
  }
})

// ── listEntryIds ─────────────────────────────────────────────────────────────

test('lists every id in manifest order', () => {
  assert.deepEqual(listEntryIds(MANIFEST), ['G1-1', 'G1-2', 'G2-1'])
})

test('falls back to jiraKey for legacy manifests, and skips subtasks with neither', () => {
  const mixed = { groups: [{ subtasks: [{ id: 'G1-1' }, { jiraKey: 'T-9' }, { title: 'no handle' }] }] }
  assert.deepEqual(listEntryIds(mixed), ['G1-1', 'T-9'])
})

test('listEntryIds is empty, never throwing, for degenerate input', () => {
  for (const bad of [null, undefined, {}, { groups: 'x' }, [], 42]) {
    assert.deepEqual(listEntryIds(bad), [], `not empty for ${JSON.stringify(bad)}`)
  }
})

// ── deriveIssueKey ───────────────────────────────────────────────────────────
//
// The workflow spelled this precedence inline, twice, with `manifestEntry?.jiraKey` in the
// middle — a field that is now always undefined. When a subtask description happens not to
// quote its ticket key (the common case: the description describes the work, not the ticket),
// that fall-through lands on a slug of the prose. The telemetry record is then filed under
// `migrate-campaigns-to-clientfetch` and cannot be joined to TARS-1271 or to the intake
// record from the same logical run, which is the whole point of a shared runId.

test('the ticket key in the input text wins', () => {
  assert.equal(deriveIssueKey({ input: 'TARS-1271: migrate the client', entry: { sourceIssue: 'MC-9' } }), 'TARS-1271')
})

test('falls back to the entry sourceIssue when the description never names the ticket', () => {
  // The common case, and the one the old jiraKey precedence got wrong.
  assert.equal(deriveIssueKey({ input: 'Migrate campaigns to clientFetch', entry: { sourceIssue: 'TARS-1271' } }), 'TARS-1271')
})

test('a legacy entry jiraKey is still honoured, after sourceIssue', () => {
  assert.equal(deriveIssueKey({ input: 'do work', entry: { jiraKey: 'TARS-1275' } }), 'TARS-1275')
  assert.equal(deriveIssueKey({ input: 'do work', entry: { sourceIssue: 'TARS-1271', jiraKey: 'TARS-1275' } }), 'TARS-1271')
})

test('a subtask id is never used as an issue key', () => {
  // `G1-1` is not a ticket. Filing telemetry under it would collide across every run of every
  // repo, since ids are per-manifest and start at G1-1 every time.
  assert.notEqual(deriveIssueKey({ input: 'do work', entry: { id: 'G1-1' } }), 'G1-1')
})

test('with nothing to go on it falls back to the slug, never to null', () => {
  // A slug is a poor key but a real one — the telemetry path needs a filename segment, and
  // null there produces `__null__` in a filename the dashboard then parses into four bad
  // segments.
  const k = deriveIssueKey({ input: 'Add dark mode to the dashboard', entry: null })
  assert.ok(k && k !== 'null', `unusable key: ${k}`)
  assert.doesNotMatch(k, /\s/, 'a filename segment must not contain whitespace')
})

test('degenerate input yields a usable key rather than throwing', () => {
  for (const c of [{}, { input: null, entry: null }, { input: '', entry: {} }, null, undefined]) {
    let k
    assert.doesNotThrow(() => { k = deriveIssueKey(c) }, `threw on ${JSON.stringify(c)}`)
    assert.ok(k, `empty key for ${JSON.stringify(c)}`)
  }
})
