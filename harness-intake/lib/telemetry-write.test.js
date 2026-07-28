// RED-first tests for the in-workflow audit write (Phase 1a).
//
// Background: each child workflow used to *return* {telemetryPath, auditRecord} and write
// nothing. The append lived in SKILL.md as a JS snippet the MAIN agent was asked to run
// after Workflow() returned — so when the main context was long, or cliSummary read like a
// natural end of turn, the step was silently dropped and the run left no trace. The
// helper that would have done the write (buildAppendCmd) was exported from lib/ and
// called from zero workflow.js files.
//
// The write itself must be an agent() (workflow scripts have no filesystem API), so it is
// not directly unit-testable. What IS testable is the prompt that drives it, and that is
// what these tests pin down.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWriteAgentPrompt, buildDurationPatchCmd } from './telemetry-write.js'
import { buildAppendCmd } from './telemetry.js'

const PATH = '/Users/me/Desktop/Repos/harness-telemetry/v2/webtarsthree__harness-intake__TARS-1271__20260727T194141Z.jsonl'
const REC  = { schemaVersion: '2.0', skill: 'harness-intake', status: 'COMPLETE', durationMs: null }

test('buildWriteAgentPrompt names the exact telemetry path', () => {
  const p = buildWriteAgentPrompt({ telemetryPath: PATH, records: [REC], startTs: '1769500000000' })
  assert.ok(p.includes(PATH), 'prompt must name the destination path verbatim')
})

test('buildWriteAgentPrompt emits one JSONL line per record', () => {
  const recs = [REC, { ...REC, status: 'PARTIAL' }, { ...REC, status: 'FAILED' }]
  const p = buildWriteAgentPrompt({ telemetryPath: PATH, records: recs, startTs: '1769500000000' })
  for (const r of recs) assert.ok(p.includes(JSON.stringify(r)), `missing record ${r.status}`)
  assert.ok(/3/.test(p), 'prompt should state the record count so a short write is detectable')
})

test('buildWriteAgentPrompt records are single-line JSON — a pretty-printed record would corrupt the JSONL', () => {
  const nested = { ...REC, tokens: { total: { input: 1, output: 2 } }, agentCount: { byModel: { sonnet: 3 } } }
  const p = buildWriteAgentPrompt({ telemetryPath: PATH, records: [nested], startTs: '1' })
  const line = JSON.stringify(nested)
  assert.ok(!line.includes('\n'))
  assert.ok(p.includes(line))
})

test('buildWriteAgentPrompt instructs append, never overwrite', () => {
  const p = buildWriteAgentPrompt({ telemetryPath: PATH, records: [REC], startTs: '1' })
  assert.match(p, /append/i)
  assert.match(p, /never overwrite|do not overwrite/i)
})

// ---- durationMs: the field that cannot survive the old failure mode ----
//
// The workflow never measured duration — _buildV2Record read args.durationMs, which no
// wrapper passed, and left it null. On MC-1077 the value was filled in by a post-hoc
// patch whose end stamp was taken when a human noticed the log was missing, so the
// recorded 239210ms measured "run start → human noticed", not the run. That is worse
// than a null: it is plausible, and it inflates with how long the omission goes unseen.

test('buildWriteAgentPrompt tells the agent to measure duration itself from startTs', () => {
  const p = buildWriteAgentPrompt({ telemetryPath: PATH, records: [REC], startTs: '1769500000000' })
  assert.ok(p.includes('1769500000000'), 'startTs must reach the agent')
  assert.match(p, /durationMs/)
  assert.match(p, /time\.time\(\)/, 'must take its own end stamp rather than trust a caller')
})

test('buildWriteAgentPrompt omits the duration step entirely when startTs is absent', () => {
  // A null startTs must not become durationMs: <now> - 0, which would report ~57 years.
  // Note the record's own serialized `durationMs` key is still in the prompt — it is part of
  // the payload. What must be absent is the *instruction*: no STEP 2, no patch command.
  const p = buildWriteAgentPrompt({ telemetryPath: PATH, records: [REC], startTs: null })
  assert.ok(!/STEP 2/.test(p), 'no startTs → no duration step')
  assert.ok(!/time\.time\(\)/.test(p), 'no startTs → no end stamp')
  assert.ok(!/Two steps/.test(p), 'prompt must not promise a step it does not give')
  assert.ok(p.includes(PATH) && p.includes('STEP 1'), 'the append step still stands on its own')
})

test('buildDurationPatchCmd passes JSON via argv, never through shell interpolation', () => {
  const cmd = buildDurationPatchCmd(PATH, '1769500000000')
  // The record content must not be spliced into the command text; only path + startTs.
  assert.ok(cmd.includes(PATH))
  assert.ok(cmd.includes('1769500000000'))
  assert.match(cmd, /python3/)
  assert.match(cmd, /sys\.argv/, 'values arrive as argv, so quoting cannot break the payload')
})

test('buildDurationPatchCmd patches only the LAST line of the file', () => {
  const cmd = buildDurationPatchCmd(PATH, '1')
  assert.match(cmd, /lines\[-1\]/, 'must target the record just appended, not the whole file')
})

test('buildDurationPatchCmd returns null without a startTs', () => {
  assert.equal(buildDurationPatchCmd(PATH, null), null)
  assert.equal(buildDurationPatchCmd(PATH, ''), null)
})

// ---- quoting: the payload survives a hostile record ----

test('buildWriteAgentPrompt never interpolates a record into shell position', () => {
  // A record whose text contains $(...) or backticks must not be able to execute. The
  // prompt states the records as data for the agent to write; if the prompt itself built
  // a shell command with them spliced in, this string would be a command substitution.
  const hostile = { ...REC, error: `$(rm -rf /) \`whoami\` 'quoted' "dquoted"` }
  const p = buildWriteAgentPrompt({ telemetryPath: PATH, records: [hostile], startTs: '1' })
  assert.ok(p.includes(JSON.stringify(hostile)), 'record present as JSON data')
  assert.ok(!/echo '.*rm -rf/.test(p), 'record must not appear inside a shell echo in the prompt')
})

test('buildAppendCmd round-trips a record containing quotes, newlines and command substitution', () => {
  // buildAppendCmd is the fallback shape the agent is given; single-quote escaping is the
  // only thing standing between a record and the shell.
  const hostile = { a: `it's`, b: `he said "hi"`, c: 'line1\nline2', d: '$(whoami)', e: '`id`' }
  const line = JSON.stringify(hostile)
  const cmd  = buildAppendCmd('/tele/v2/f.jsonl', line)
  assert.ok(cmd.includes('mkdir -p'))
  // Every literal single quote from the payload is escaped as '\'' — so no odd number of
  // quotes can terminate the string early and expose $(...) to the shell.
  const payload = cmd.slice(cmd.indexOf("echo '") + 6, cmd.lastIndexOf("' >>"))
  assert.ok(!/(^|[^\\])'(?!\\'')/.test(payload.replace(/'\\''/g, '')), 'unescaped quote survives in payload')
  assert.ok(cmd.includes(`'\\''`), 'single quotes escaped in POSIX form')
})
