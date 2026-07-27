function normalizeTo100(weights) {
  const ids = Object.keys(weights)
  const n = ids.length
  if (n === 0) return {}
  const total = ids.reduce((s, id) => s + weights[id], 0)
  // All-zero (or fully-zero-after-floor): equal split so every weight is valid
  if (total === 0) {
    const base = Math.floor(100 / n)
    const out = {}
    ids.forEach((id, i) => { out[id] = base })
    // Distribute remainder 1 point at a time to the first (100 % n) entries
    const rem = 100 - base * n
    for (let i = 0; i < rem; i++) out[ids[i]]++
    return out
  }
  // Proportional distribution
  const out = {}
  let acc = 0
  ids.forEach((id, i) => {
    if (i === ids.length - 1) out[id] = 100 - acc
    else { const v = Math.round(weights[id] * 100 / total); out[id] = v; acc += v }
  })
  // Floor every weight at 1: take excess off the largest weights (most room)
  const underflowIds = ids.filter(id => out[id] < 1)
  if (underflowIds.length > 0) {
    const deficit = underflowIds.reduce((s, id) => s + (1 - out[id]), 0)
    for (const id of underflowIds) out[id] = 1
    // Take deficit from largest weights, reducing each by at most (weight - 1)
    const sorted = ids.filter(id => !underflowIds.includes(id)).sort((a, b) => out[b] - out[a])
    let remaining = deficit
    for (const id of sorted) {
      if (remaining <= 0) break
      const room = out[id] - 1
      const take = Math.min(room, remaining)
      out[id] -= take
      remaining -= take
    }
  }
  return out
}

export function loadWeights(defaultChecks, override) {
  const base = {}
  for (const c of defaultChecks) base[c.id] = c.weight
  if (!override) return base
  const merged = { ...base }
  for (const [id, w] of Object.entries(override)) if (id in merged) merged[id] = w
  // Clamp each merged weight to [1,60] before normalizing so huge/negative overrides
  // cannot produce zero or negative weights via the proportional distribution.
  for (const id of Object.keys(merged)) merged[id] = Math.max(1, Math.min(60, merged[id]))
  return normalizeTo100(merged)
}

export function makeWeightChange({ handoff, checkId, oldWeight, newWeight, reason, triggeringRunId, ts }) {
  return { handoff, checkId, oldWeight, newWeight, reason, triggeringRunId, ts }
}

// Bounds the changed check (±15 from current, floor 1, ceiling 60), then distributes
// the remainder across the other checks proportionally so the total is exactly 100.
// Invariant post-condition: sum === 100, every weight in [1, 60].
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
  // Floor every other check at 1; take the excess off the largest non-changed weights
  const underflowIds = others.filter(id => out[id] < 1)
  if (underflowIds.length > 0) {
    const deficit = underflowIds.reduce((s, id) => s + (1 - out[id]), 0)
    for (const id of underflowIds) out[id] = 1
    const sorted = others.filter(id => !underflowIds.includes(id)).sort((a, b) => out[b] - out[a])
    let remaining2 = deficit
    for (const id of sorted) {
      if (remaining2 <= 0) break
      const room = out[id] - 1
      const take = Math.min(room, remaining2)
      out[id] -= take
      remaining2 -= take
    }
  }
  return out
}
