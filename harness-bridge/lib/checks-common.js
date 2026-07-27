// harness-bridge/lib/checks-common.js — handoff-agnostic pure helpers
export const clamp01 = x => Math.max(0, Math.min(1, x))
export const mean = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 1 // vacuous 1 for empty populations

export function assertWeightsSum(checks) {
  const sum = checks.reduce((s, c) => s + c.weight, 0)
  if (sum !== 100) throw new Error(`weights sum to ${sum}, expected 100`)
  return true
}
