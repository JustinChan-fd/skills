export function buildStateFilePath(worktreePath, repo, issueKey, runTs) {
  return `${worktreePath}/docs/manifests/${repo}__harness-run__${issueKey}__${runTs}__run-state.json`
}

export function buildRunState({
  runId,
  parentRunId = null,
  lastCompletedStage,
  nextStage,
  artifacts,
  stageRecords,
  // Bridge-era fields. harness-run no longer produces weight changes, but they stay
  // in the shape (always empty) so bridge-era checkpoints remain resume-compatible.
  allWeightChanges = [],
  weightsOverride = {},
  worktreePath,
  runBranch,
  startTs,
  skillsCommit,
}) {
  return {
    schema: 'harness-run-state-v1',
    runId,
    parentRunId: parentRunId ?? null,
    lastCompletedStage,
    nextStage,
    artifacts,
    stageRecords: [...stageRecords],
    allWeightChanges: [...allWeightChanges],
    weightsOverride,
    worktreePath,
    runBranch,
    startTs,
    skillsCommit,
  }
}

// Returns true only when: resumeNextStage is set, is NOT the current stage (don't skip it —
// re-run from the checkpoint), IS in the later stages list, AND the required artifact is truthy.
export function shouldSkipStage(resumeNextStage, currentStage, laterStages, requiredArtifact) {
  if (!resumeNextStage) return false
  if (resumeNextStage === currentStage) return false
  if (!laterStages.includes(resumeNextStage)) return false
  return !!requiredArtifact
}

// Returns array of "key: path" strings for any artifact path that existsFn returns false for.
// null/undefined values are silently skipped (optional artifacts).
export function validateResumeArtifacts(artifacts, existsFn) {
  const missing = []
  for (const [k, v] of Object.entries(artifacts)) {
    if (v == null) continue
    if (!existsFn(v)) missing.push(`${k}: ${v}`)
  }
  return missing
}
