// harness-bridge/lib/checks-a.js — Handoff A (intake → plan) checks
import { clamp01, mean, assertWeightsSum } from './checks-common.js'

const FILE_RE = /[\w./-]+\.[a-z]{1,4}\b/gi

function subtasksOf(m) { return (m.groups || []).flatMap(g => g.subtasks || []) }
function isL(m) { return m.size === 'L' }
function migrationTarget(m) {
  const p = m.migrationPattern || ''
  const idx = p.indexOf('→')
  if (idx < 0) return null
  return (p.slice(idx + 1).trim().split(/\s+/)[0] || '').replace(/[^\w.]/g, '') || null
}
function unionFilesA(m) {
  return new Set([...(m.files || []), ...subtasksOf(m).flatMap(s => [...(s.files || []), ...(s.sampleFiles || [])])])
}
function haystackA(m) {
  const parts = []
  for (const ac of m.acList || []) parts.push(ac.grepPattern || '', ac.shellCommand || '', ac.searchScope || '', ac.bullet || '')
  parts.push(m.scopePath || '', ...(m.files || []))
  for (const s of subtasksOf(m)) parts.push(s.scopePath || '', ...(s.files || []), ...(s.sampleFiles || []))
  return parts.join('\n')
}

function groundingEvidenceFresh(m) {
  const target = migrationTarget(m)
  const researchTyped = (m.acList || []).filter(ac => ['grep', 'find', 'shell', 'read'].includes(ac.researchType))
  const evid = researchTyped.length
    ? mean(researchTyped.map(ac => ac.verifiedCount > 0 ? 1 : (ac.grepPattern || ac.shellCommand ? 0.5 : 0)))
    : 1
  if (!target) return clamp01(0.7 * evid + 0.3)
  const found = haystackA(m).toLowerCase().includes(target.toLowerCase()) ? 1 : 0
  return clamp01(0.5 * found + 0.5 * evid)
}
function filesPopulatedA(m) {
  if (!isL(m)) return 1
  return mean(subtasksOf(m).map(s => (s.files && s.files.length) ? 1 : 0))
}
function acResearchExecutable(m) {
  const acs = m.acList || []
  if (!acs.length) return 0
  return mean(acs.map(ac => {
    if (ac.researchType === 'grep') return (ac.grepPattern || '').trim().length >= 2 ? 1 : 0
    if (ac.researchType === 'shell') return (ac.shellCommand || '').trim().length >= 4 ? 1 : 0
    if (ac.researchType === 'find' || ac.researchType === 'read') return (ac.shellCommand || ac.searchScope || '').trim().length >= 2 ? 1 : 0
    return 0
  }))
}
function sizeCorroboration(m) {
  const acs = m.acList || []
  const totalVerified = acs.reduce((s, ac) => s + (ac.verifiedCount || 0), 0)
  const fileCount = (m.files?.length || 0) + subtasksOf(m).reduce((s, x) => s + (x.fileCount || x.files?.length || 0), 0)
  const signals = [totalVerified, fileCount, acs.length].filter(x => x > 0)
  const corroborated = signals.length >= 2 ? 1 : 0
  const magnitude = Math.max(totalVerified, fileCount, acs.length)
  const proxy = magnitude > 60 ? 3 : magnitude > 15 ? 2 : magnitude > 4 ? 1 : 0
  const order = { XS: 0, S: 1, M: 2, L: 3 }
  const agree = m.size in order ? (Math.abs(order[m.size] - proxy) <= 1 ? 1 : 0) : 0
  return clamp01(0.6 * corroborated + 0.4 * agree)
}
function acReferencedFilesCovered(m) {
  const files = [...unionFilesA(m)]
  const refs = []
  for (const ac of m.acList || []) {
    const text = `${ac.bullet || ''} ${ac.searchScope || ''} ${ac.shellCommand || ''}`
    for (const mm of text.matchAll(FILE_RE)) {
      if (/\.(json|md|lock)$/i.test(mm[0])) continue
      refs.push(mm[0])
    }
  }
  if (!refs.length) return 1
  return mean(refs.map(r => files.some(f => f.endsWith(r) || f.includes(r)) ? 1 : 0))
}
function claimTruthConsistency(m) {
  const acs = (m.acList || []).filter(ac => ac.verifiedCount != null && ac.ticketClaimedCount > 0)
  if (!acs.length) return 1
  return mean(acs.map(ac => Math.abs(ac.verifiedCount - ac.ticketClaimedCount) / ac.ticketClaimedCount <= 0.20 ? 1 : 0))
}
function scopeGrounded(m) {
  const files = [...unionFilesA(m)]
  const scopes = [m.scopePath, ...(m.acList || []).map(ac => ac.searchScope)].filter(Boolean)
  if (!scopes.length) return 0.5
  if (!files.length) return 0.25
  return mean(scopes.map(sc => files.some(f => f.startsWith(sc) || f.includes(sc)) ? 1 : 0))
}
function sizeShapeConsistencyA(m) {
  if (!['XS', 'S', 'M', 'L'].includes(m.size)) return 0
  return (isL(m) === ((m.groups || []).length > 0)) ? 1 : 0
}

export const CHECKS_A = [
  { id: 'grounding-evidence-fresh',    weight: 24, fn: groundingEvidenceFresh },
  { id: 'files-populated',             weight: 20, fn: filesPopulatedA },
  { id: 'ac-research-executable',      weight: 18, fn: acResearchExecutable },
  { id: 'size-corroboration',          weight: 12, fn: sizeCorroboration },
  { id: 'ac-referenced-files-covered', weight: 10, fn: acReferencedFilesCovered },
  { id: 'claim-truth-consistency',     weight: 8,  fn: claimTruthConsistency },
  { id: 'scope-grounded',              weight: 5,  fn: scopeGrounded },
  { id: 'size-shape-consistency',      weight: 3,  fn: sizeShapeConsistencyA },
]
assertWeightsSum(CHECKS_A)  // fail fast at module load if weights drift off 100
