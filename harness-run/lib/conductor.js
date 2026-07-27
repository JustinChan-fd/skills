export const SEQUENCE = [
  { skill: 'harness-intake',    role: 'intake' },
  { skill: 'harness-bridge',    role: 'gateA', handoff: 'A' },
  { skill: 'harness-plan',      role: 'plan' },
  { skill: 'harness-bridge',    role: 'gateB', handoff: 'B' },
  { skill: 'harness-implement', role: 'implement' },
]

export function actionForVerdict(verdict, retriesUsed) {
  if (verdict === 'PROCEED') return { next: 'advance' }
  if (verdict === 'RE_ASK') return { next: 'refine' }
  return { next: 'stop' }
}

export function assembleRunSummary(records) {
  const stages = records.map(r => ({
    skill: r.skill,
    outcome: r.outcome ?? r.status ?? null,
    confidence: r.confidence ?? null,
    costUsd: r.cost?.rateLockedUsd ?? 0,
    durationMs: r.durationMs ?? 0,
  }))
  const totalCostUsd = +stages.reduce((s, x) => s + (x.costUsd || 0), 0).toFixed(4)
  const totalDurationMs = stages.reduce((s, x) => s + (x.durationMs || 0), 0)
  const exited = stages.some(x => x.outcome === 'EXIT')
  const failed = stages.some(x => x.outcome === 'FAILED' || x.outcome === 'CRASHED')
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
