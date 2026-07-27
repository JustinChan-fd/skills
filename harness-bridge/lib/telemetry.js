export function repoNameFromPath(repoPath) {
  if (!repoPath) return 'unknown-repo'
  return String(repoPath).replace(/\/$/, '').split('/').pop() || 'unknown-repo'
}
/** Bridge v2 telemetry path — mirrors harness-plan's inline pattern. */
export function bridgeTelemetryPath({ homeDir, repo, issueKey, runTs }) {
  return `${homeDir}/Desktop/Repos/harness-telemetry/v2/${repo}__harness-bridge__${issueKey}__${runTs}.jsonl`
}
export function buildAppendCmd(telemetryPath, jsonLine) {
  const escaped = jsonLine.replace(/'/g, "'\\''")
  return `mkdir -p "$(dirname '${telemetryPath}')" && echo '${escaped}' >> '${telemetryPath}'`
}
