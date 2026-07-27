export function clampAdjusted(score, adjusted) {
  if (adjusted == null || Number.isNaN(adjusted)) return score
  return Math.min(score, Math.max(0, adjusted))
}

export function parseHolePoker(raw) {
  const empty = { adjustedScore: null, reasons: [] }
  if (!raw || typeof raw !== 'string') return empty
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  const brace = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (brace < 0 || close < brace) return empty
  try {
    const obj = JSON.parse(text.slice(brace, close + 1))
    const adjustedScore = typeof obj.adjustedScore === 'number' ? obj.adjustedScore : null
    const reasons = Array.isArray(obj.reasons) ? obj.reasons.map(String) : []
    return { adjustedScore, reasons }
  } catch {
    return empty
  }
}
