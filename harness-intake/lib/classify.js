/**
 * classifyAcBullet — determine AC type flags from bullet text.
 * Used to pre-classify grouper inputs and post-verify stub injections
 * without LLM calls.
 */
export function classifyAcBullet(bullet) {
  const text = bullet.toLowerCase()
  // isValidation: 'no ' removed (matches any sentence), ' check'/'remain' tightened to avoid
  // false positives on implementation ACs like "No bare fetch() calls remain standardized"
  // 'ran clean' catches "npm install ran clean with no warnings" — a validation outcome, not a file-touch task
  const isCleanup    = text.includes('remov') || text.includes('delet') || text.includes('package.json') || text.includes('npm install')
  const isValidation = text.includes('verif') || text.includes('confirm') || text.includes('passing') || text.includes('clean install') || text.includes('ran clean') || text.includes('baseline') || /\bcheck\b/.test(text) || /\bremains?\b/.test(text)
  const isDeferred   = text.includes('abortcontroller') || text.includes('timeout') || text.includes('npm ')
  // isCleanup+isDeferred together always means a package-level validation step (e.g. npm install) —
  // treat as validation (no file list, not a Jira subtask)
  const isValidationFinal = isValidation || (isCleanup && isDeferred)
  const isMigration  = !isCleanup && !isValidationFinal && !isDeferred
  return { isCleanup, isValidation: isValidationFinal, isDeferred, isMigration }
}
