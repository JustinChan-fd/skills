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
 * Build the telemetry file path for this run.
 *
 * Format: {telemetryDir}/logs/{repo}__{skill}__{issueKeyOrSlug}__{timestamp}.jsonl
 *
 * Segments separated by __ for unambiguous parsing:
 *   name.split('__') → [repo, skill, ticket, timestamp]
 *
 * issueKeyOrSlug: Jira key (e.g. TARS-1271) if available, else slugFromInput(rawText)
 * timestamp = compact UTC, e.g. 20260724T183042Z
 */
export function buildTelemetryPath({ telemetryDir, repoPath, skill, issueKey, rawText, timestamp }) {
  const repo = repoNameFromPath(repoPath)
  const key  = issueKey || slugFromInput(rawText)
  const ts   = timestamp || 'unknown-ts'
  const file = `${repo}__${skill}__${key}__${ts}.jsonl`
  return `${telemetryDir}/logs/${file}`
}

/**
 * Build the shell command to append one JSONL record to the telemetry path.
 * Uses `mkdir -p` so the directory (including /logs/) is created if missing.
 */
export function buildAppendCmd(telemetryPath, jsonLine) {
  const escaped = jsonLine.replace(/'/g, "'\\''")
  return `mkdir -p "$(dirname '${telemetryPath}')" && echo '${escaped}' >> '${telemetryPath}'`
}

const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$/

/**
 * Eject test files from isMigration:true subtasks into a separate test-mock batch.
 *
 * Mutates `subtasks` in place (removes test files from migration batches, updates
 * estimatedFileCount). Returns new test-mock subtask(s) to inject (may be empty).
 *
 * @param {Array}  subtasks  - coordinator subtask drafts (mutated)
 * @param {string} issueKey  - Jira key prefix (e.g. 'TARS-1271') or ''
 * @param {string} scopePath - fallback scopePath for the test-mock subtask
 * @returns {Array} new subtasks to push (zero or more test-mock subtasks)
 */
export function ejectTestFiles(subtasks, issueKey, scopePath) {
  const ejected = []
  for (const s of subtasks) {
    if (!s.isMigration) continue
    const testFiles = (s.files || []).filter(f => TEST_FILE_RE.test(f))
    if (testFiles.length === 0) continue
    s.files = s.files.filter(f => !TEST_FILE_RE.test(f))
    s.estimatedFileCount = s.files.length
    ejected.push(...testFiles)
  }
  const unique = [...new Set(ejected)]
  if (unique.length === 0) return []
  const chunks = unique.length > 8
    ? Array.from({ length: Math.ceil(unique.length / 8) }, (_, i) => unique.slice(i * 8, (i + 1) * 8))
    : [unique]
  return chunks.map((chunk, i) => ({
    title: `${issueKey ? issueKey + ': ' : ''}Update test mocks for migration${chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : ''}`,
    description: 'Update test file mocks to reflect the migration pattern change. These files were ejected from production migration batches.',
    scopePath: scopePath || '',
    files: chunk,
    estimatedFileCount: chunk.length,
    targetSize: chunk.length <= 4 ? 'XS' : 'S',
    isMigration: false,
    isCleanup: true,
    isValidation: false,
    isDeferred: false,
    needsReview: false,
  }))
}

/** Fields every v2 record must carry beyond the base shape. ADD-only; never remove. */
export function recordExtras({ retries = 0, errorLog = [] } = {}) {
  return { retries, errorLog }
}
