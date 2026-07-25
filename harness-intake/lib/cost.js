// Rates sourced from https://platform.claude.com/docs/en/about-claude/pricing (2026-07-24)
// Haiku 4.5: $1.00/$5.00 per MTok in/out
// Sonnet 4.x: $3.00/$15.00 per MTok in/out
// Opus 4.5+:  $5.00/$25.00 per MTok in/out  (Opus 4.1 and earlier were $15/$75 — deprecated)
export const COST_RATES = {
  haiku:  { in: 1.00, out: 5.00  },
  sonnet: { in: 3.00, out: 15.00 },
  opus:   { in: 5.00, out: 25.00 },
}

export function rateFor(model) {
  const m = String(model)
  if (m.includes('opus'))  return COST_RATES.opus
  if (m.includes('haiku')) return COST_RATES.haiku
  return COST_RATES.sonnet
}

// agentCountByModel: modelId→agent count. outputTokensTotal: total output tokens for the run.
// Tokens are split proportionally by agent count — immune to parallel() budget.spent() race
// (per-agent delta tracking overcounts sonnet when agents run concurrently).
// Output-only — budget.spent() tracks outputs only. Underestimates true cost (~4x) but self-contained.
export function computeCost(agentCountByModel, outputTokensTotal) {
  const entries = Object.entries(agentCountByModel)
  if (!entries.length || !outputTokensTotal) return 0
  const totalAgents = entries.reduce((s, [, c]) => s + c, 0)
  if (!totalAgents) return 0
  const blendedRate = entries.reduce((s, [m, c]) => s + rateFor(m).out * (c / totalAgents), 0)
  return parseFloat(((outputTokensTotal / 1_000_000) * blendedRate).toFixed(4))
}
