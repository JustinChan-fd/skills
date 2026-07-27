// The sequence harness-run actually walks (manifest-as-gospel, 2026-07-27).
// Each stage's manifest is ground truth for the next — no scoring gate between.
export const SEQUENCE = [
  { skill: 'harness-intake',    role: 'intake' },
  { skill: 'harness-plan',      role: 'plan' },
  { skill: 'harness-implement', role: 'implement' },
]

// The bridge-gated sequence. Not walked today: the RE_ASK loop death-spiralled and
// checks-B's schema contract does not match harness-plan's task shape. Retained as
// the target shape for the opt-in --gate flag, alongside actionForVerdict below.
export const GATED_SEQUENCE = [
  { skill: 'harness-intake',    role: 'intake' },
  { skill: 'harness-bridge',    role: 'gateA', handoff: 'A' },
  { skill: 'harness-plan',      role: 'plan' },
  { skill: 'harness-bridge',    role: 'gateB', handoff: 'B' },
  { skill: 'harness-implement', role: 'implement' },
]

// Bridge-era. Unused while GATED_SEQUENCE is unused; kept for the --gate path.
export function actionForVerdict(verdict, retriesUsed) {
  if (verdict === 'PROCEED') return { next: 'advance' }
  if (verdict === 'RE_ASK' && retriesUsed === 0) return { next: 'refine' }
  return { next: 'stop' }
}

export function assembleRunSummary(records) {
  const stages = records.map(r => ({
    skill: r.skill,
    // `outcome` only. Never fall back to r.status — status carries lifecycle
    // values (COMPLETE, COMPLETE_FRAMING_CORRECTED) on a different axis, and
    // conflating them is what made the dashboard RESULT column unreadable.
    outcome: r.outcome ?? null,
    confidence: r.confidence ?? null,
    costUsd: r.cost?.rateLockedUsd ?? 0,
    durationMs: r.durationMs ?? 0,
  }))
  const totalCostUsd = +stages.reduce((s, x) => s + (x.costUsd || 0), 0).toFixed(4)
  const totalDurationMs = stages.reduce((s, x) => s + (x.durationMs || 0), 0)
  // Normalize outcomes to lowercase for comparison; original values are preserved in stages[].outcome
  const outcomes = stages.map(x => (x.outcome == null ? null : String(x.outcome).toLowerCase()))
  const withOutcome = outcomes.filter(o => o !== null)
  if (withOutcome.length === 0) return { stages, totalCostUsd, totalDurationMs, finalStatus: 'UNKNOWN' }
  const exited  = outcomes.some(o => o === 'exit')
  const failed  = outcomes.some(o => o === 'failed' || o === 'crashed' || o === 'partial')
  const finalStatus = exited ? 'EXIT' : failed ? 'FAILED' : 'COMPLETE'
  return { stages, totalCostUsd, totalDurationMs, finalStatus }
}

export function weightEvolutionReport(initialWeights, weightChanges) {
  const byHandoff = { A: [], B: [] }
  for (const c of weightChanges || []) (byHandoff[c.handoff] || (byHandoff[c.handoff] = [])).push(c)
  const lines = ['# Weight-evolution report (tonight)', '']
  for (const h of ['A', 'B']) {
    lines.push(`## Handoff ${h}`)
    const init = initialWeights[h] || {}
    // apply changes in order to derive final
    const final = { ...init }
    for (const c of byHandoff[h]) final[c.checkId] = c.newWeight
    lines.push('| check | initial | final |', '|---|---|---|')
    for (const id of Object.keys(init)) lines.push(`| ${id} | ${init[id]} | ${final[id] ?? init[id]} |`)
    lines.push('')
    if (byHandoff[h].length) {
      lines.push('Changes:')
      for (const c of byHandoff[h]) lines.push(`- \`${c.checkId}\` ${c.oldWeight} → ${c.newWeight} — ${c.reason} (run ${c.triggeringRunId})`)
    } else {
      lines.push('No weight changes this run.')
    }
    lines.push('')
  }
  return lines.join('\n')
}
