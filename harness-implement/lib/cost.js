// Cost math — verbatim rate logic from harness-plan/workflow.js:49-52
// These rates are per-million output tokens (USD).
export const COST_RATES = { opus: 75, haiku: 1.25, default: 15 }

export function rateFor(model) {
  if (String(model).includes('opus'))  return COST_RATES.opus
  if (String(model).includes('haiku')) return COST_RATES.haiku
  return COST_RATES.default
}

export function computeCost(tokensByModel) {
  return parseFloat(
    Object.entries(tokensByModel)
      .reduce((sum, [model, tokens]) => sum + (tokens / 1_000_000) * rateFor(model), 0)
      .toFixed(4)
  )
}
