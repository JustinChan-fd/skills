// Structural guard: the manifest write cannot silently vanish, and neither can its pairing
// with the telemetry write.
//
// Same crude source-text search as debrief-write.test.js, and the same stated limit: this
// proves the call site exists, not that it executed. It is here because the manifest write
// was, until now, the *identical* shape as the bug that phase fixed — SKILL.md steps 6 and 11
// asked the main agent to write the manifest after Workflow() returned, so a long context or
// a summary box that read like an end-of-turn dropped it with no trace.
//
// The manifest is worse to lose than the telemetry record. A missing record costs a dashboard
// row; a missing manifest strands the run, because `harness-plan --intake` reads that exact
// path and there is no other copy on disk.
//
// The pairing assertion is the load-bearing one: both artifacts belong to the same run, so a
// return that writes one and not the other is a half-finished run, and that asymmetry is
// exactly what a future edit would introduce by accident.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../workflow.js', import.meta.url), 'utf8')

/**
 * Every region ending in a top-level `return {`, keyed by the write calls inside it.
 *
 * Regions are cut at each `_writeAuditRecord(` call rather than at a phase marker: the XS/S/M
 * early exit is not inside trackPhase('Debrief') at all (it returns before Research runs), so
 * a Debrief-anchored scan would miss the path most likely to be forgotten.
 */
function returnRegions(src) {
  const regions = []
  const re = /await _writeAuditRecord\(/g
  let m
  while ((m = re.exec(src))) {
    // Back up to the start of the enclosing statement block we care about: the nearest
    // preceding `const auditRecord` is where this return's bookkeeping begins.
    const head = src.lastIndexOf('const auditRecord', m.index)
    const rest = src.slice(head === -1 ? m.index : head)
    const end = rest.search(/\n\s*return \{/)
    regions.push(rest.slice(0, end === -1 ? rest.length : end))
  }
  return regions
}

test('workflow.js has a region for every audit write', () => {
  assert.ok(returnRegions(SRC).length >= 2, 'expected at least the XS/S/M skip and the L path')
})

test('every run that writes telemetry also writes its manifest', () => {
  // The pairing. Both artifacts describe one run; a return that emits one without the other
  // is a run that cannot be picked up downstream (no manifest) or cannot be audited (no record).
  const regions = returnRegions(SRC)
  regions.forEach((region, i) => {
    assert.match(
      region,
      /_writeIntakeManifest\(/,
      `region ${i + 1}/${regions.length} writes a telemetry record but never writes the manifest — ` +
      `harness-plan --intake has nothing to read, and the run is stranded`
    )
  })
})

test('the manifest write goes through the mirrored builders, not an ad-hoc string', () => {
  assert.match(SRC, /function _writeIntakeManifest\s*\(/, 'no inline _writeIntakeManifest definition')
  assert.match(SRC, /_buildManifestWritePrompt\(/, 'must use the mirrored prompt builder')
  assert.match(SRC, /_buildManifestPath\(/, 'must use the mirrored path builder')
})

test('the manifest write agent is cheap, labelled, and pinned to Debrief', () => {
  const fn = SRC.slice(SRC.indexOf('async function _writeIntakeManifest'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1)
  assert.match(body, /claude-haiku/, 'writing a file verbatim must not burn a reasoning seat')
  assert.match(body, /label:/, 'must carry its own label so it is visible in the progress tree')
  assert.match(body, /phase:\s*'Debrief'/, 'must group under Debrief with the telemetry write')
})

test('_writeIntakeManifest returns the path it wrote, so the record and summary can name it', () => {
  const fn = SRC.slice(SRC.indexOf('async function _writeIntakeManifest'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1)
  assert.match(body, /return\s+(manifestPath|path)\b/, 'the caller needs the path for intakeManifestPath')
})

test('a manifest write failure is loud but never fatal', () => {
  // Opposite trade-off from telemetry: losing the manifest strands the run, so it must be
  // logged prominently. But throwing here would discard a successful split that has already
  // been computed and printed, which is strictly worse than reporting the failure.
  const fn = SRC.slice(SRC.indexOf('async function _writeIntakeManifest'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1)
  assert.match(body, /try\s*\{/, 'the agent call must be wrapped')
  assert.match(body, /catch/, 'must not throw out of Debrief')
  assert.match(body, /log\(/, 'a silent failure here is the whole bug being fixed')
})

test('the record names the manifest path, so an audit row points at its own manifest', () => {
  // Without this, the only link between a telemetry row and the manifest it produced is a
  // filename convention two skills have to agree on by hand.
  assert.match(SRC, /intakeManifestPath/, 'the audit record never carries intakeManifestPath')
})

// ── The Jira gate is gone ─────────────────────────────────────────────────────
//
// Decomps are phased commits on the PR now, not Jira issues, so nothing mints a jiraKey.
// These guard against the dead contract creeping back in — a stale `jiraKey` reference would
// read as an available handle to whoever maintains harness-plan next, and it resolves to
// undefined on every subtask.

test('the workflow never reads or writes jiraKey / jiraUrl', () => {
  // Live references only: `.jiraKey`, `jiraKey:`, `jiraKey =`, `['jiraKey']`. Prose mentioning
  // the field is fine and in fact wanted — the comment at the id-assignment site explains why
  // the handle changed, and banning the word outright would delete that explanation to satisfy
  // a regex. What must not survive is code, because it resolves to undefined on every subtask.
  //
  // Four live forms, each confirmed caught by mutation (a guard that cannot fail is worse
  // than no guard): a property read (`entry.jiraKey` — no trailing punctuation to key off), a
  // bracket access (`x['jiraUrl']`), an object key or assignment (`jiraKey:`, `jiraKey =`), and
  // a destructure (`const { jiraKey } = s`), which the first three all miss.
  const live = /\.jira(?:Key|Url)\b|\[\s*['"]jira(?:Key|Url)['"]\s*\]|\bjira(?:Key|Url)\s*(?:[:=](?!=)|[,}])/g
  const hits = []
  SRC.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return       // comment line
    if (live.test(line)) hits.push(`${i + 1}: ${line.trim()}`)
    live.lastIndex = 0
  })
  assert.deepEqual(hits, [], `a removed field is still read/written — it is always undefined:\n${hits.join('\n')}`)
})

test('the summary does not tell the user to create Jira subtasks', () => {
  const m = SRC.match(/next:\s+[^\n]*/g) || []
  for (const line of m) {
    assert.doesNotMatch(line, /jira/i, `next-step line still routes through Jira: ${line}`)
  }
})

test('every subtask carries an id, assigned before the manifest is built', () => {
  // `--entry` addresses subtasks by id. Assigning after intakeManifest is built would put
  // ids on the in-memory objects only if they happen to be the same references — a
  // correctness argument that should not be load-bearing, so the order is asserted instead.
  //
  // Anchored on `\n_assignSubtaskIds(` — a bare top-level call. Matching the name alone would
  // also match the mirror's own `function _assignSubtaskIds(groups) {`, so deleting the call
  // site left this green (mutation-confirmed) while no subtask got an id.
  const assignAt = SRC.search(/\n_assignSubtaskIds\(/)
  const manifestAt = SRC.indexOf('const intakeManifest = {', assignAt === -1 ? 0 : assignAt)
  assert.ok(assignAt !== -1, 'the workflow never calls _assignSubtaskIds — only defines it')
  assert.ok(manifestAt !== -1, 'no intakeManifest built after id assignment')
  assert.ok(assignAt < manifestAt, 'ids must be stamped before the manifest that carries them is built')
})
