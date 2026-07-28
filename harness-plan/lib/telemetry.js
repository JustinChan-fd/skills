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
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'greenfield'
}

/**
 * Derive the telemetry repo root from a repoPath.
 *
 * process.env is unavailable in the workflow runtime, so the home dir cannot be read —
 * it is recovered by stripping the trailing /Desktop/Repos/<repo> from repoPath. A
 * worktree path (…/Desktop/Repos/wt-TARS-1271-…) strips the same way, so a conductor
 * run and a direct run land in the same telemetry dir.
 */
export function deriveTelemetryDir(repoPath) {
  const homeDir = (repoPath || '').replace(/\/Desktop\/Repos\/[^/]+\/?$/, '') || '/tmp'
  return `${homeDir}/Desktop/Repos/harness-telemetry`
}

/**
 * Build the telemetry file path for this run.
 *
 * Format: {telemetryDir}/v2/{repo}__{skill}__{issueKeyOrSlug}__{timestamp}.jsonl
 *
 * `v2/` is the ONLY directory the dashboard reads (harness-telemetry/server.js:10 and
 * build.js both scan it). This used to say `logs/`, which does not exist on disk — the
 * bug survived because this function had no callers and its test asserted the wrong dir.
 *
 * Segments separated by __ for unambiguous parsing:
 *   name.split('__') → [repo, skill, ticket, timestamp]
 *
 * telemetryDir: optional; derived from repoPath when absent.
 * repoName: canonical repo name — preferred over repoPath's tail so a conductor run
 *   reports `webtarsthree` rather than the worktree directory name.
 * issueKeyOrSlug: Jira key (e.g. TARS-1271) if available, else slugFromInput(rawText)
 * timestamp = compact UTC, e.g. 20260724T183042Z
 */
export function buildTelemetryPath({ telemetryDir, repoPath, skill, issueKey, rawText, timestamp, repoName }) {
  const dir  = telemetryDir || deriveTelemetryDir(repoPath)
  const repo = repoName || repoNameFromPath(repoPath)
  const key  = issueKey || slugFromInput(rawText)
  const ts   = timestamp || 'unknown-ts'
  const file = `${repo}__${skill}__${key}__${ts}.jsonl`
  return `${dir}/v2/${file}`
}

/**
 * Build the shell command to append one JSONL record to the telemetry path.
 * Uses `mkdir -p` so the directory (including /v2/) is created if missing.
 */
export function buildAppendCmd(telemetryPath, jsonLine) {
  const escaped = jsonLine.replace(/'/g, "'\\''")
  return `mkdir -p "$(dirname '${telemetryPath}')" && echo '${escaped}' >> '${telemetryPath}'`
}

/** Fields every v2 record must carry beyond the base shape. ADD-only; never remove. */
export function recordExtras({ retries = 0, errorLog = [] } = {}) {
  return { retries, errorLog }
}
