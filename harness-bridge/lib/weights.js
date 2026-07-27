function normalizeTo100(weights) {
  const ids = Object.keys(weights)
  const total = ids.reduce((s, id) => s + weights[id], 0)
  if (total === 0) return { ...weights }
  const out = {}
  let acc = 0
  ids.forEach((id, i) => {
    if (i === ids.length - 1) out[id] = 100 - acc
    else { const v = Math.round(weights[id] * 100 / total); out[id] = v; acc += v }
  })
  return out
}

export function loadWeights(defaultChecks, override) {
  const base = {}
  for (const c of defaultChecks) base[c.id] = c.weight
  if (!override) return base
  const merged = { ...base }
  for (const [id, w] of Object.entries(override)) if (id in merged) merged[id] = w
  return normalizeTo100(merged)
}

export function makeWeightChange({ handoff, checkId, oldWeight, newWeight, reason, triggeringRunId, ts }) {
  return { handoff, checkId, oldWeight, newWeight, reason, triggeringRunId, ts }
}

// Bounds the changed check (±15 from current, floor 1, ceiling 60), then distributes
// the remainder across the other checks proportionally so the total is exactly 100.
export function applyWeightChange(weights, change) {
  const { checkId } = change
  if (!(checkId in weights)) throw new Error(`unknown checkId ${checkId}`)
  const old = weights[checkId]
  let target = change.newWeight
  target = Math.max(old - 15, Math.min(old + 15, target))
  target = Math.max(1, Math.min(60, target))
  const others = Object.keys(weights).filter(id => id !== checkId)
  const otherSum = others.reduce((s, id) => s + weights[id], 0)
  const remaining = 100 - target
  const out = { [checkId]: target }
  let acc = 0
  others.forEach((id, i) => {
    if (i === others.length - 1) out[id] = remaining - acc
    else { const v = Math.round(weights[id] * remaining / (otherSum || 1)); out[id] = v; acc += v }
  })
  return out
}
