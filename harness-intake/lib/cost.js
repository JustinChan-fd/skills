// Rates sourced from https://docs.claude.com/en/docs/about-claude/pricing (2026-07-25)
// Haiku 4.5:  $1.00/$5.00   per MTok in/out
// Sonnet 4.x: $3.00/$15.00  per MTok in/out
// Opus 4.5+:  $5.00/$25.00  per MTok in/out  (Opus 4.1 and earlier were $15/$75 — deprecated)
// Cache read:  0.10× input rate per model; cache write: 1.25× input rate per model
export const PRICE_TABLE_VERSION = '2026-07-25'

export const COST_RATES = {
  haiku:  { in: 1.00, out: 5.00,  cacheRead: 0.10, cacheWrite: 1.25  },
  sonnet: { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75  },
  opus:   { in: 5.00, out: 25.00, cacheRead: 0.50, cacheWrite: 6.25  },
}

export function rateFor(model) {
  const m = String(model)
  if (m.includes('opus'))  return COST_RATES.opus
  if (m.includes('haiku')) return COST_RATES.haiku
  return COST_RATES.sonnet
}

// computeCost: input+output cost using exact token counts.
// agentCountByModel: modelId→agent count (used for blended input rate when per-model input split unavailable).
// inputTokens: total input tokens (from subagentTokens - outputTokensTotal).
// outputTokensTotal: total output tokens (from budget.spent() delta).
// Returns { rateLockedUsd, priceTableVersion, nullReasons }.
// rateLockedUsd: cost snapshot at rates in effect at write time — tokens are ground truth for recomputation.
export function computeCost({ agentCountByModel, inputTokens, outputTokensTotal }) {
  const nullReasons = {}
  const entries = Object.entries(agentCountByModel || {})
  const totalAgents = entries.reduce((s, [, c]) => s + c, 0)

  if (!entries.length || !totalAgents) {
    nullReasons['cost.rateLockedUsd'] = 'no agentCountByModel'
    return { rateLockedUsd: null, priceTableVersion: PRICE_TABLE_VERSION, nullReasons }
  }

  const blendedInRate  = entries.reduce((s, [m, c]) => s + rateFor(m).in  * (c / totalAgents), 0)
  const blendedOutRate = entries.reduce((s, [m, c]) => s + rateFor(m).out * (c / totalAgents), 0)

  const inCost  = (inputTokens != null)      ? (inputTokens      / 1_000_000) * blendedInRate  : 0
  const outCost = (outputTokensTotal != null) ? (outputTokensTotal / 1_000_000) * blendedOutRate : 0

  if (inputTokens == null) nullReasons['tokens.total.input'] = 'subagentTokens not yet patched'

  const rateLockedUsd = parseFloat((inCost + outCost).toFixed(4))
  return { rateLockedUsd, priceTableVersion: PRICE_TABLE_VERSION, nullReasons }
}
