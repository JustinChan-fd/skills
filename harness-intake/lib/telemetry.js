// Centralized telemetry helpers — mirrored inline in workflow.js PURE block.
// Authoritative for tests; workflow.js copies must stay identical.

/** Derive repo name from an absolute repoPath (last path segment). */
export function repoNameFromPath(repoPath) {
  if (!repoPath) return 'unknown-repo'
  return String(repoPath).replace(/\/$/, '').split('/').pop() || 'unknown-repo'
}

/**
 * Build the telemetry file path for this run.
 * Format: {telemetryDir}/{repo}-{skill}-{issueKey}-{timestamp}.jsonl
 * timestamp = ISO 8601 compact UTC, e.g. 20260724T183042Z
 */
export function buildTelemetryPath({ telemetryDir, repoPath, skill, issueKey, timestamp }) {
  const repo = repoNameFromPath(repoPath)
  const key  = issueKey || 'no-ticket'
  const ts   = timestamp || 'unknown-ts'
  const file = `${repo}-${skill}-${key}-${ts}.jsonl`
  return `${telemetryDir}/${file}`
}

/**
 * Build the shell command to append one JSONL record to the telemetry path.
 * Uses `mkdir -p` so the directory is created if it doesn't exist.
 */
export function buildAppendCmd(telemetryPath, jsonLine) {
  const escaped = jsonLine.replace(/'/g, "'\\''")
  return `mkdir -p "$(dirname '${telemetryPath}')" && echo '${escaped}' >> '${telemetryPath}'`
}
