import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStateFilePath, buildRunState, shouldSkipStage, validateResumeArtifacts, normalizeResumeStage, resolveWorktreeTarget } from './run-state.js'

// ---- resolveWorktreeTarget (resume must reuse the ORIGINAL worktree) ----

const DERIVED = { worktreePath: '/Repos/wt-TARS-1271-20260727T220000Z', runBranch: 'harness/TARS-1271-20260727T220000Z' }
const CHECKPOINT = { worktreePath: '/Repos/wt-TARS-1271-20260727T194141Z', runBranch: 'harness/TARS-1271-20260727T194141Z' }

test('resolveWorktreeTarget: fresh run (no state) uses the derived path/branch', () => {
  assert.deepEqual(resolveWorktreeTarget(null, DERIVED), { ...DERIVED, reused: false })
})

test('resolveWorktreeTarget: resume prefers the checkpoint worktree over the newly derived one', () => {
  // runTs is new on every invocation, so the derived name never matches the
  // worktree the original run provisioned. Skipping Provision while pointing at
  // the derived path means every later stage reads from a directory that does
  // not exist — the plan-manifest read fails first.
  const got = resolveWorktreeTarget(CHECKPOINT, DERIVED)
  assert.equal(got.worktreePath, CHECKPOINT.worktreePath)
  assert.equal(got.runBranch, CHECKPOINT.runBranch)
  assert.equal(got.reused, true)
})

test('resolveWorktreeTarget: a checkpoint missing worktreePath falls back to derived', () => {
  const got = resolveWorktreeTarget({ runBranch: CHECKPOINT.runBranch }, DERIVED)
  assert.equal(got.worktreePath, DERIVED.worktreePath)
  assert.equal(got.runBranch, CHECKPOINT.runBranch)
})

test('resolveWorktreeTarget: a checkpoint missing runBranch falls back to derived branch', () => {
  const got = resolveWorktreeTarget({ worktreePath: CHECKPOINT.worktreePath }, DERIVED)
  assert.equal(got.worktreePath, CHECKPOINT.worktreePath)
  assert.equal(got.runBranch, DERIVED.runBranch)
})

test('resolveWorktreeTarget: empty-string fields in the checkpoint are treated as absent', () => {
  const got = resolveWorktreeTarget({ worktreePath: '', runBranch: '' }, DERIVED)
  assert.deepEqual(got, { ...DERIVED, reused: false })
})

test('resolveWorktreeTarget: reused is false when nothing was actually carried over', () => {
  assert.equal(resolveWorktreeTarget({}, DERIVED).reused, false)
})

test('resolveWorktreeTarget: collapses a literal ".." segment carried in the checkpoint', () => {
  // Bridge-era checkpoints stored worktreePath as `${repoPath}/../wt-<...>`. A literal
  // `..` breaks the homeDir regex the child telemetry-path builders run against
  // repoPath, which is why the fresh-run derivation resolves the parent dir explicitly.
  const got = resolveWorktreeTarget(
    { worktreePath: '/Users/me/Desktop/Repos/webtarsthree/../wt-TARS-1271-20260727T194141Z' },
    DERIVED,
  )
  assert.equal(got.worktreePath, '/Users/me/Desktop/Repos/wt-TARS-1271-20260727T194141Z')
  assert.ok(!got.worktreePath.includes('..'))
})

test('resolveWorktreeTarget: collapses multiple ".." segments', () => {
  const got = resolveWorktreeTarget({ worktreePath: '/a/b/../c/d/../wt-x' }, DERIVED)
  assert.equal(got.worktreePath, '/a/c/wt-x')
})

test('resolveWorktreeTarget: a path with no ".." is left byte-identical', () => {
  const got = resolveWorktreeTarget({ worktreePath: '/Repos/wt-clean' }, DERIVED)
  assert.equal(got.worktreePath, '/Repos/wt-clean')
})

test('resolveWorktreeTarget: normalized checkpoint path equal to derived still reports reused=false', () => {
  const got = resolveWorktreeTarget(
    { worktreePath: '/Repos/webtarsthree/../wt-TARS-1271-20260727T220000Z', runBranch: DERIVED.runBranch },
    DERIVED,
  )
  assert.equal(got.worktreePath, DERIVED.worktreePath)
  assert.equal(got.reused, false)
})

test('resolveWorktreeTarget: never mutates the derived object', () => {
  const derived = { ...DERIVED }
  resolveWorktreeTarget(CHECKPOINT, derived)
  assert.deepEqual(derived, DERIVED)
})

// ---- normalizeResumeStage (bridge-era checkpoint compatibility) ----

test('normalizeResumeStage maps gate-A onto plan', () => {
  assert.equal(normalizeResumeStage('gate-A'), 'plan')
})
test('normalizeResumeStage maps gate-B onto implement', () => {
  assert.equal(normalizeResumeStage('gate-B'), 'implement')
})
test('normalizeResumeStage is case-insensitive', () => {
  assert.equal(normalizeResumeStage('GATE-B'), 'implement')
  assert.equal(normalizeResumeStage('gateb'), 'implement')
})
test('normalizeResumeStage passes current stage names through untouched', () => {
  for (const s of ['intake', 'plan', 'implement', 'pr']) assert.equal(normalizeResumeStage(s), s)
})
test('normalizeResumeStage passes null/undefined through as null', () => {
  assert.equal(normalizeResumeStage(null), null)
  assert.equal(normalizeResumeStage(undefined), null)
})

test('a bridge-era gate-B checkpoint skips plan instead of re-running it', () => {
  // Real shape from a 2026-07-27 run-state.json: lastCompletedStage=plan, nextStage=gate-B.
  // Before normalization 'gate-B' matched no laterStages list, so nothing was skipped
  // and the resumed run re-ran harness-plan from scratch.
  assert.equal(shouldSkipStage('gate-B', 'plan', ['implement', 'pr'], '/path/to/plan-manifest.json'), true)
  assert.equal(shouldSkipStage('gate-B', 'intake', ['plan', 'implement', 'pr'], '/path/to/intake.json'), true)
  // ...but does NOT skip implement — that is where it resumes.
  assert.equal(shouldSkipStage('gate-B', 'implement', ['pr'], true), false)
})
test('a bridge-era gate-A checkpoint skips intake but not plan', () => {
  assert.equal(shouldSkipStage('gate-A', 'intake', ['plan', 'implement', 'pr'], '/intake.json'), true)
  assert.equal(shouldSkipStage('gate-A', 'plan', ['implement', 'pr'], '/plan.json'), false)
})

// ---- buildStateFilePath ----

test('buildStateFilePath produces correct __ delimited path', () => {
  const p = buildStateFilePath('/wt/path', 'webtarsthree', 'TARS-1271', '20260727T165041Z')
  assert.equal(p, '/wt/path/docs/manifests/webtarsthree__harness-run__TARS-1271__20260727T165041Z__run-state.json')
})

test('buildStateFilePath ends with __run-state.json', () => {
  const p = buildStateFilePath('/any', 'repo', 'PROJ-1', 'ts')
  assert.ok(p.endsWith('__run-state.json'))
})

test('buildStateFilePath uses docs/manifests subdir', () => {
  const p = buildStateFilePath('/base', 'myrepo', 'X-1', '20260101T000000Z')
  assert.ok(p.includes('/docs/manifests/'))
})

// ---- buildRunState ----

test('buildRunState has schema harness-run-state-v1', () => {
  const s = buildRunState({ runId: 'r1', lastCompletedStage: 'intake', nextStage: 'gate-A', artifacts: {}, stageRecords: [], allWeightChanges: [], weightsOverride: {}, worktreePath: '/wt', runBranch: 'harness/x', startTs: null, skillsCommit: 'abc' })
  assert.equal(s.schema, 'harness-run-state-v1')
})

test('buildRunState includes all expected top-level fields', () => {
  const s = buildRunState({ runId: 'r1', parentRunId: 'p1', lastCompletedStage: 'intake', nextStage: 'gate-A', artifacts: { intakeManifestPath: '/a' }, stageRecords: [], allWeightChanges: [], weightsOverride: {}, worktreePath: '/wt', runBranch: 'b', startTs: 'ts', skillsCommit: 'sha' })
  assert.equal(s.runId, 'r1')
  assert.equal(s.parentRunId, 'p1')
  assert.equal(s.lastCompletedStage, 'intake')
  assert.equal(s.nextStage, 'gate-A')
  assert.deepEqual(s.artifacts, { intakeManifestPath: '/a' })
  assert.equal(s.worktreePath, '/wt')
  assert.equal(s.runBranch, 'b')
  assert.equal(s.startTs, 'ts')
  assert.equal(s.skillsCommit, 'sha')
})

test('buildRunState parentRunId is null when not passed', () => {
  const s = buildRunState({ runId: 'r1', lastCompletedStage: 'x', nextStage: 'y', artifacts: {}, stageRecords: [], allWeightChanges: [], weightsOverride: {}, worktreePath: '/w', runBranch: 'b', startTs: null, skillsCommit: 'c' })
  assert.equal(s.parentRunId, null)
})

test('buildRunState stageRecords is a copy — push to original does not affect state', () => {
  const orig = [{ stage: 'intake' }]
  const s = buildRunState({ runId: 'r1', lastCompletedStage: 'x', nextStage: 'y', artifacts: {}, stageRecords: orig, allWeightChanges: [], weightsOverride: {}, worktreePath: '/w', runBranch: 'b', startTs: null, skillsCommit: 'c' })
  orig.push({ stage: 'added-after' })
  assert.equal(s.stageRecords.length, 1)
})

test('buildRunState allWeightChanges is a copy', () => {
  const orig = [{ handoff: 'A' }]
  const s = buildRunState({ runId: 'r1', lastCompletedStage: 'x', nextStage: 'y', artifacts: {}, stageRecords: [], allWeightChanges: orig, weightsOverride: {}, worktreePath: '/w', runBranch: 'b', startTs: null, skillsCommit: 'c' })
  orig.push({ handoff: 'B' })
  assert.equal(s.allWeightChanges.length, 1)
})

// ---- shouldSkipStage ----

test('shouldSkipStage: null resumeNextStage → false (fresh run, never skip)', () => {
  assert.equal(shouldSkipStage(null, 'intake', ['gate-A', 'plan'], '/artifact'), false)
})

test('shouldSkipStage: resumeNextStage === currentStage → false (re-run the checkpoint stage)', () => {
  assert.equal(shouldSkipStage('plan', 'plan', ['implement', 'pr'], '/artifact'), false)
})
test('shouldSkipStage: identity holds after legacy normalization too', () => {
  // 'gate-B' normalizes to 'implement', so the implement stage must still re-run
  assert.equal(shouldSkipStage('gate-B', 'implement', ['pr'], '/artifact'), false)
})

test('shouldSkipStage: resumeNextStage is in laterStages AND artifact is truthy → true (skip)', () => {
  assert.equal(shouldSkipStage('plan', 'intake', ['plan', 'gate-B', 'implement'], '/some/manifest'), true)
})

test('shouldSkipStage: resumeNextStage in laterStages BUT artifact is null → false (re-run, artifact missing)', () => {
  assert.equal(shouldSkipStage('plan', 'intake', ['plan', 'gate-B'], null), false)
})

test('shouldSkipStage: resumeNextStage in laterStages BUT artifact is undefined → false', () => {
  assert.equal(shouldSkipStage('plan', 'intake', ['plan', 'gate-B'], undefined), false)
})

test('shouldSkipStage: resumeNextStage is not in laterStages and not currentStage → false', () => {
  // resumeNextStage is earlier than currentStage — should not skip
  assert.equal(shouldSkipStage('intake', 'gate-A', ['plan', 'gate-B'], '/artifact'), false)
})

// ---- validateResumeArtifacts ----

test('validateResumeArtifacts: all paths present → []', () => {
  const exists = p => p === '/a' || p === '/b'
  const result = validateResumeArtifacts({ intakeManifestPath: '/a', planManifestPath: '/b' }, exists)
  assert.deepEqual(result, [])
})

test('validateResumeArtifacts: one path missing → surfaced entry', () => {
  const exists = p => p === '/a'
  const result = validateResumeArtifacts({ intakeManifestPath: '/a', planManifestPath: '/missing' }, exists)
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('planManifestPath'))
  assert.ok(result[0].includes('/missing'))
})

test('validateResumeArtifacts: null values in artifacts are skipped (optional)', () => {
  const exists = () => true
  const result = validateResumeArtifacts({ intakeManifestPath: null, planManifestPath: null }, exists)
  assert.deepEqual(result, [])
})

test('validateResumeArtifacts: undefined values in artifacts are skipped', () => {
  const exists = () => true
  const result = validateResumeArtifacts({ intakeManifestPath: undefined }, exists)
  assert.deepEqual(result, [])
})

test('validateResumeArtifacts: multiple missing paths all surfaced', () => {
  const exists = () => false
  const result = validateResumeArtifacts({ a: '/x', b: '/y' }, exists)
  assert.equal(result.length, 2)
})

test('validateResumeArtifacts: empty artifacts → []', () => {
  const result = validateResumeArtifacts({}, () => true)
  assert.deepEqual(result, [])
})
