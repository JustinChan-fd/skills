// The in-workflow audit write.
//
// Ported down from harness-run/workflow.js:382 (`finalizeStageTelemetry`), which is the
// only place this has ever actually worked. Before this module the append lived in each
// SKILL.md as prose the main agent was asked to run after Workflow() returned, and
// buildAppendCmd — the helper that would have done it — was exported from lib/ with zero
// callers. Nothing in code wrote a record.
//
// Workflow scripts have no filesystem API, so the write must be an agent(); these are the
// pure string builders that drive it, so the parts that can be tested, are.
//
// KEEP IN SYNC with the inline mirrors in workflow.js (`_buildWriteAgentPrompt`,
// `_buildDurationPatchCmd`) — inline-mirror.test.js fails the suite if they drift.

/**
 * The python3 one-liner that stamps a measured durationMs onto the record just appended.
 *
 * The agent takes its own end stamp (`time.time()`) rather than trusting a caller-supplied
 * duration. That is load-bearing: `args.durationMs` was never populated by any wrapper, so
 * every record left it null until a human noticed and asked for a patch — at which point
 * the end stamp was "when a human noticed", not "when the run ended". MC-1077's 239210ms is
 * that value. A plausible measurement of the wrong interval is worse than a null, because
 * it grows with how long the omission goes unseen and nothing on disk marks it as suspect.
 *
 * Values arrive as argv, never spliced into the command text, so a path or stamp can never
 * reach the shell as code.
 *
 * @returns {string|null} null when startTs is absent — without a start there is nothing to
 *   subtract, and `now - 0` would report ~57 years as a duration.
 */
export function buildDurationPatchCmd(telemetryPath, startTs) {
  if (!startTs) return null
  return `python3 -c "
import json, sys, time
path, start = sys.argv[1], int(sys.argv[2])
duration = int(time.time() * 1000) - start
lines = open(path).readlines()
if lines:
    last = json.loads(lines[-1])
    last['durationMs'] = duration
    lines[-1] = json.dumps(last) + '\\n'
    open(path, 'w').writelines(lines)
    print('DURATION_MS', duration)
" '${telemetryPath}' '${startTs}'`
}

/**
 * The prompt for the Debrief write agent.
 *
 * Records are stated as JSON data for the agent to write — they are never interpolated into
 * a shell command here, so a record containing `$(…)` or backticks is inert. The agent is
 * given buildAppendCmd's shape for the append itself, where single-quote escaping is the
 * one thing standing between a record and the shell.
 *
 * The record count is stated explicitly so a short write is detectable after the fact.
 */
export function buildWriteAgentPrompt({ telemetryPath, records, startTs }) {
  const lines = (Array.isArray(records) ? records : [records]).filter(Boolean).map(r => JSON.stringify(r))
  const patchCmd = buildDurationPatchCmd(telemetryPath, startTs)

  return `Write this skill's audit record to telemetry. ${patchCmd ? 'Two steps, in order. Do not skip either.' : 'One step.'}

STEP 1 — append each record below as one JSONL line to:
  ${telemetryPath}

Create parent directories if needed. Append, never overwrite — this file may already hold
records from earlier runs of the same ticket, and losing them is unrecoverable.

Records (${lines.length}), already serialized — write each verbatim, one per line, exactly as
given. Do not reformat, pretty-print, re-key, or "fix" them; a multi-line record corrupts the
JSONL and the dashboard silently drops the file:

${lines.join('\n')}

Command shape for step 1 (the payload is single-quote escaped; keep it that way):

mkdir -p "$(dirname '${telemetryPath}')" && echo '<record-json>' >> '${telemetryPath}'
${patchCmd ? `
STEP 2 — stamp the measured durationMs onto the LAST line of that file. Run this exactly as
written; it takes its own end stamp and subtracts the run's start (${startTs}). Do not
compute the duration yourself and do not substitute a value:

${patchCmd}
` : ''}
Report "TELEMETRY_OK" or "TELEMETRY_ERROR: <reason>". If step 1 fails, say so explicitly —
a silent failure here is the bug this agent exists to fix.`
}
