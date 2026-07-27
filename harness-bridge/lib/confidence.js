import { clamp01 } from './checks-common.js'
import { CHECKS_A } from './checks-a.js'
import { CHECKS_B } from './checks-b.js'

export const THRESHOLD = 85

// Re-export so consumers import everything scoring-related from one place.
export { CHECKS_A } from './checks-a.js'
export { CHECKS_B } from './checks-b.js'
export { assertWeightsSum, clamp01, mean } from './checks-common.js'

export function scoreArtifact(artifact, handoff, weightsOverride = null) {
  const checks = handoff === 'A' ? CHECKS_A : CHECKS_B
  const weightOf = id => (weightsOverride && id in weightsOverride)
    ? weightsOverride[id]
    : checks.find(c => c.id === id).weight
  const perCheck = checks.map(c => {
    const value = clamp01(c.fn(artifact))
    const weight = weightOf(c.id)
    return { id: c.id, value: +value.toFixed(4), weight, contribution: +(value * weight).toFixed(2) }
  })
  const score = Math.round(perCheck.reduce((s, p) => s + p.contribution, 0))
  return { score, perCheck }
}
