import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { THRESHOLD, CHECKS_A, CHECKS_B, scoreArtifact, assertWeightsSum } from './confidence.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = name => JSON.parse(readFileSync(join(HERE, '..', 'fixtures', name), 'utf8'))

test('threshold is 85', () => assert.equal(THRESHOLD, 85))
test('facade re-exports both handoffs, each Σ=100', () => {
  assert.equal(assertWeightsSum(CHECKS_A), true)
  assert.equal(assertWeightsSum(CHECKS_B), true)
})
test('scoreArtifact returns 0..100 with perCheck contributions summing to score', () => {
  const r = scoreArtifact(fixture('intake-manifest-clean.json'), 'A', null)
  assert.ok(r.score >= 0 && r.score <= 100)
  assert.equal(r.score, Math.round(r.perCheck.reduce((s, p) => s + p.contribution, 0)))
})
test('fixture-level: clean clears the bar, dirty falls short — both handoffs', () => {
  assert.ok(scoreArtifact(fixture('intake-manifest-clean.json'), 'A', null).score >= 85)
  assert.ok(scoreArtifact(fixture('intake-manifest-dirty.json'), 'A', null).score < 50)
  assert.ok(scoreArtifact(fixture('plan-clean.json'), 'B', null).score >= 85)
  assert.ok(scoreArtifact(fixture('plan-dirty.json'), 'B', null).score < 50)
})
test('scoreArtifact honors weightsOverride', () => {
  const art = fixture('plan-dirty.json')
  const base = scoreArtifact(art, 'B', null).score
  const boosted = scoreArtifact(art, 'B', { 'task-files-present-bounded': 60, 'task-spec-completeness': 0 }).score
  assert.notEqual(base, boosted)
})
