// Centralized telemetry helpers — mirrored inline in workflow.js PURE block.
// Authoritative for tests; workflow.js copies must stay identical.

/** Derive repo name from an absolute repoPath (last path segment). */
export function repoNameFromPath(repoPath) {
  if (!repoPath) return 'unknown-repo'
  return String(repoPath).replace(/\/$/, '').split('/').pop() || 'unknown-repo'
}

/**
 * Derive a short kebab-case slug from raw spec/greenfield text when no Jira key is available.
 * Takes the first non-empty line, strips punctuation, lower-cases, collapses whitespace to hyphens,
 * and truncates to 40 chars so file names stay readable.
 * Returns 'greenfield' if input is empty or produces nothing useful.
 */
export function slugFromInput(text) {
  if (!text) return 'greenfield'
  const first = String(text).split('\n').map(l => l.trim()).find(l => l.length > 0) || ''
  const slug = first
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // strip punctuation
    .trim()
    .replace(/\s+/g, '-')            // spaces → hyphens
    .replace(/-{2,}/g, '-')          // collapse double hyphens
    .slice(0, 40)
    .replace(/-+$/, '')              // trim trailing hyphens
  return slug || 'greenfield'
}

/**
 * Build the telemetry file path for this run.
 * Format: {telemetryDir}/{repo}-{skill}-{issueKeyOrSlug}-{timestamp}.jsonl
 * issueKeyOrSlug: Jira key (e.g. TARS-1271) if available, else slugFromInput(rawText)
 * timestamp = ISO 8601 compact UTC, e.g. 20260724T183042Z
 */
export function buildTelemetryPath({ telemetryDir, repoPath, skill, issueKey, rawText, timestamp }) {
  const repo = repoNameFromPath(repoPath)
  const key  = issueKey || slugFromInput(rawText)
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
