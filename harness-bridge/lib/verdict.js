import { THRESHOLD } from './confidence.js'

export function verdictFor(finalScore, retriesUsed) {
  if (finalScore >= THRESHOLD) return { verdict: 'PROCEED', action: 'advance' }
  if (retriesUsed === 0) return { verdict: 'RE_ASK', action: 'refine' }
  return { verdict: 'EXIT', action: 'stop' }
}
