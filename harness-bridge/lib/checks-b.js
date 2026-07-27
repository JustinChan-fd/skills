import { clamp01, mean, assertWeightsSum } from './checks-common.js'

// ── Handoff B (plan → implement) ─────────────────────────────────────────────
function failsQualityContract(desc, tddRequired) {
  const d = desc || ''
  return !/what/i.test(d) || !/where/i.test(d) || !/how/i.test(d) || (tddRequired && !/done/i.test(d)) || !/```/.test(d)
}
function failsThinSpec(desc) {
  const d = desc || ''
  const whereLen = (d.match(/where[:\s]+(.+?)(?=\n(?:what|how|done)|$)/is)?.[1] || '').trim().length
  const howLen = (d.match(/how[:\s]+(.+?)(?=\n(?:what|where|done)|$)/is)?.[1] || '').trim().length
  return whereLen < 20 || howLen < 20 || !/```/.test(d)
}
const FILELINE_RE = /([\w./-]+\.[a-z]{1,4}):(\d+)/i
const IMPORT_RE = /(?:from|require\()\s*['"]([^'"]+)['"]/g
const ASSERT_RE = /(expect\(|assert|toBe|toEqual|===|\.status\b|status\s*\(?\s*\d{3}|resolves|rejects)/i

function taskSpecCompleteness(a) {
  const tasks = a.tasks || []
  if (!tasks.length) return 0
  return mean(tasks.map(t => (!failsQualityContract(t.description, t.tddRequired) && !failsThinSpec(t.description)) ? 1 : 0))
}
function taskFilesPresentBounded(a) {
  const tasks = a.tasks || []
  if (!tasks.length) return 0
  return mean(tasks.map(t => {
    const n = (t.files || []).length
    if (n === 0) return 0
    if (n <= 3) return 1
    return clamp01(3 / n)
  }))
}
function whereResolvesToFiles(a) {
  const tasks = a.tasks || []
  if (!tasks.length) return 0
  return mean(tasks.map(t => {
    const where = (t.description || '').match(/where[:\s]+(.+?)(?=\n(?:what|how|done)|$)/is)?.[1] || ''
    const m2 = where.match(FILELINE_RE)
    if (!m2) return 0
    return (t.files || []).some(f => f.endsWith(m2[1]) || f.includes(m2[1])) ? 1 : 0.5
  }))
}
function companionEditClosure(a) {
  const tasks = a.tasks || []
  const allFiles = new Set(tasks.flatMap(t => t.files || []))
  const refs = []
  for (const t of tasks) for (const mm of (t.description || '').matchAll(IMPORT_RE)) {
    const p = mm[1]
    if (p.startsWith('.') || p.includes('/')) refs.push(p.split('/').pop())
  }
  if (!refs.length) return 1
  return mean(refs.map(r => [...allFiles].some(f => f.includes(r)) ? 1 : 0))
}
function tddDoneLiteralAssertion(a) {
  const tdd = (a.tasks || []).filter(t => t.tddRequired)
  if (!tdd.length) return 1
  return mean(tdd.map(t => {
    const done = (t.description || '').match(/done[:\s]+([\s\S]+?)$/is)?.[1] || ''
    return ASSERT_RE.test(done) ? 1 : 0
  }))
}
function manifestDagConsistency(a) {
  const plans = a.plans || []
  if (!plans.length) return 0
  const ids = new Set(plans.map(p => p.id))
  const resolvable = plans.every(p => (p.dependsOn || []).every(d => d !== p.id && ids.has(d)))
  const anyDep = plans.some(p => (p.dependsOn || []).length > 0)
  const exec = a.execution
  const execOk = plans.length === 1 ? exec === 'sequential'
    : anyDep ? (exec === 'sequential' || exec === 'mixed') : exec === 'parallel'
  return clamp01((resolvable ? 0.6 : 0) + (execOk ? 0.4 : 0))
}
function concernAtomicity(a) {
  const tasks = a.tasks || []
  if (!tasks.length) return 1
  return mean(tasks.map(t => {
    const d = t.description || ''
    const doneCount = (d.match(/done[:\s]/gi) || []).length
    const done = d.match(/done[:\s]+([\s\S]+?)$/is)?.[1] || ''
    const chained = /\band\b/i.test(done) && done.length > 60
    return (doneCount <= 1 && !chained) ? 1 : 0
  }))
}
function sizeShapeConsistencyB(a) {
  if (!a.size) return 0.5
  return ['XS', 'S', 'M', 'L'].includes(a.size) ? 1 : 0
}

export const CHECKS_B = [
  { id: 'task-spec-completeness',      weight: 30, fn: taskSpecCompleteness },
  { id: 'task-files-present-bounded',  weight: 20, fn: taskFilesPresentBounded },
  { id: 'where-resolves-to-files',     weight: 16, fn: whereResolvesToFiles },
  { id: 'companion-edit-closure',      weight: 12, fn: companionEditClosure },
  { id: 'tdd-done-literal-assertion',  weight: 10, fn: tddDoneLiteralAssertion },
  { id: 'manifest-dag-consistency',    weight: 6,  fn: manifestDagConsistency },
  { id: 'concern-atomicity',           weight: 3,  fn: concernAtomicity },
  { id: 'size-shape-consistency',      weight: 3,  fn: sizeShapeConsistencyB },
]
assertWeightsSum(CHECKS_B)  // fail fast at module load if weights drift off 100
