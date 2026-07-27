# Harness E2E Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a confidence-gated ticket→PR pipeline — a `harness-bridge` gate skill and a `harness-run` conductor that call `harness-intake`/`harness-plan`/`harness-implement` as skills — then run it end-to-end on TARS-1271 to a guardrailed draft PR.

**Architecture:** Two new skills in the `skills` repo. `harness-bridge` scores confidence that a downstream skill will succeed from an upstream artifact (pure-JS weighted checklist + one lower-only LLM "hole-poker"), stamps the manifest, and returns PROCEED/RE_ASK/EXIT. `harness-run` is an artifact-gated runbook (SKILL.md + `lib/conductor.js`) that provisions a worktree, sequences the skills, invokes the bridge between them, and aggregates telemetry. All `lib/` modules are pure ES modules with no Workflow globals, unit-tested with `node --test`.

**Tech Stack:** Node ESM (`"type":"module"`), `node --test` (no network/LLM in tests), the `Workflow` tool for skill workflows, `gh` CLI for the draft PR, Atlassian MCP for Jira reads.

## Global Constraints

- **Test runner:** `npm test` at repo root runs `node --test`; every `lib/` module has a sibling `*.test.js`. No network, no LLM calls in tests.
- **Skills stay independent:** no cross-skill imports. Shared-looking code is duplicated within each skill's own `lib/`. `lib/confidence.js` lives ONLY in `harness-bridge`.
- **`lib/` purity:** modules must not reference Workflow globals (`agent`, `phase`, `parallel`, `pipeline`, `log`) so they are unit-testable. `import()` is unavailable inside `workflow.js` — pure logic is mirrored into a `// ===== PURE (mirrors lib/) =====` block and the `lib/` copy is authoritative for tests.
- **Confidence threshold = 85.** Weights per handoff sum to **exactly 100** (asserted at load).
- **Weight-agency bounds (tonight only):** a weight moves at most ±15 per adjustment; no check may drop to 0 or exceed 60; re-normalize to exactly 100 after every change.
- **Telemetry v2 is gospel:** NEVER remove a field; skills may only ADD. New fields this plan adds: `confidence`, `verdict`, `flags`, `probeResults`, `retries`, `errorLog`, `weightChanges`.
- **Model repoint:** the "opus" seat → `claude-opus-5` (same price as 4.8). Sonnet seat stays `anthropic.claude-sonnet-4-6`; Haiku stays `claude-haiku-4-5-20251001`.
- **Telemetry write path:** `${homeDir}/Desktop/Repos/harness-telemetry/v2/${repo}__${skill}__${issueKey}__${runTs}.jsonl` (mirror the existing harness-plan pattern).
- **runId** = `${issueKey}-${runTs}`, shared across all records of one run.

## Repos & Branches (READ FIRST)

- **Build work → `skills` repo** at `/Users/206618626@bwt3.com/Desktop/Repos/skills`. Branch off `main`: `harness/e2e-orchestration`. Commit per task. Do NOT push/PR the skills repo unless the user asks — build lands locally and is exercised by the run.
- **The TARS-1271 run → `webtarsthree` repo** at `/Users/206618626@bwt3.com/Desktop/Repos/webtarsthree`. All work branches from **`origin/feat/migrate-native-fetch-from-axios`** (the epic's feature branch — NOT `master`/`main`). Provision an isolated git **worktree** so the user's dirty local branches are never touched.
- **Draft PR guardrails (verbatim):** push to a `harness/TARS-1271-*` branch; open a **DRAFT** PR with **base = `feat/migrate-native-fetch-from-axios`**; **NEVER merge, NEVER force-push, NEVER touch main, only webtarsthree, only TARS-1271.**
- **NEVER-list** (never self-decide; stop and surface): irreversible-destructive, security-auth-permission, cost-over-threshold, public-api-contract, out-of-scope, legal-compliance.
- **Stop on first success:** once the draft PR lands + `npm test` green + telemetry flowed, stop. **$500 hard ceiling** as backstop.

## File Structure

**New skill — `harness-bridge/`:**
| File | Responsibility |
|---|---|
| `SKILL.md` | Invocation, I/O contract, verdict handling, telemetry wrapper |
| `workflow.js` | Load artifact → score → hole-poker agent → stamp `-gated.json` → write telemetry |
| `lib/confidence.js` | `CHECKS_A`, `CHECKS_B` (each `{id,weight,fn}`), `scoreArtifact`, `THRESHOLD`, `assertWeightsSum` |
| `lib/gated.js` | `stampManifest`, `gatedPathFor` |
| `lib/verdict.js` | `verdictFor(finalScore, retriesUsed)` → `{verdict, action}` |
| `lib/weights.js` | `loadWeights`, `applyWeightChange` (bounds+renormalize), `makeWeightChange` |
| `lib/holepoker.js` | `clampAdjusted(score, adjusted)`, `parseHolePoker` — pure; LLM call lives in workflow.js |
| `lib/models.js` | `MODEL` (opus → claude-opus-5) |
| `lib/telemetry.js` | bridge v2 record builder + path helpers |
| `weights-override.json` | tonight-only weight overrides (`{A:{...},B:{...}}`); created as `{}` by harness-run if absent; defaults in `lib/confidence.js` are never edited |
| `lib/*.test.js` | one per module above |

**New skill — `harness-run/`:**
| File | Responsibility |
|---|---|
| `SKILL.md` | Runbook: Phase 0 worktree, sequence, verdict actions, aggregation, final report, guardrails |
| `lib/conductor.js` | `SEQUENCE`, `actionForVerdict`, `assembleRunSummary`, `weightEvolutionReport` |
| `lib/conductor.test.js` | tests |

**Modified:**
| File | Change |
|---|---|
| `harness-intake/lib/models.js`, `harness-plan/lib/models.js`, `harness-implement/lib/models.js` | opus → `claude-opus-5` |
| `harness-intake/workflow.js`, `harness-plan/workflow.js`, `harness-implement/workflow.js` | `opusModel` const → `claude-opus-5`; add `retries`+`errorLog` to record builder |
| `harness-intake/workflow.js` + `SKILL.md` | `--refine` mode |
| `harness-plan/workflow.js` + `SKILL.md` | `--refine` mode + re-sizing via manifest supremacy |

## Interface Index (locked signatures — later tasks rely on these)

```js
// harness-bridge/lib/confidence.js
export const THRESHOLD = 85
export const CHECKS_A  // [{ id:string, weight:int, fn:(artifact)=>number[0..1] }]
export const CHECKS_B
export function assertWeightsSum(checks)         // throws if Σweight !== 100
export function scoreArtifact(artifact, handoff, weightsOverride)
  // handoff: 'A'|'B'; weightsOverride: {checkId:weight}|null
  // → { score:int0..100, perCheck:[{id,value,weight,contribution}] }

// harness-bridge/lib/gated.js
export function gatedPathFor(origPath)           // '...-intake-manifest.json' → '...-intake-manifest-gated.json'
export function stampManifest(artifact, stamp)   // stamp:{confidence,verdict,flags,probeResults} → new object (original untouched)

// harness-bridge/lib/verdict.js
export function verdictFor(finalScore, retriesUsed)
  // → { verdict:'PROCEED'|'RE_ASK'|'EXIT', action:'advance'|'refine'|'stop' }

// harness-bridge/lib/weights.js
export function loadWeights(defaultChecks, override)   // override:{checkId:weight}|null → {checkId:weight} normalized to 100
export function makeWeightChange({handoff,checkId,oldWeight,newWeight,reason,triggeringRunId,ts})
export function applyWeightChange(weights, change)     // clamp ±15, floor>0, ceiling 60, renormalize to 100 → new weights

// harness-bridge/lib/holepoker.js
export function clampAdjusted(score, adjusted)   // → min(score, max(0, adjusted))
export function parseHolePoker(raw)              // {adjustedScore:number, reasons:string[]}

// harness-run/lib/conductor.js
export const SEQUENCE  // [{skill, role, handoff?}]
export function actionForVerdict(verdict, retriesUsed)  // → { next:'advance'|'refine'|'stop' }
export function assembleRunSummary(records)             // → { stages[], totalCostUsd, totalDurationMs, finalStatus }
export function weightEvolutionReport(initialWeights, weightChanges)
  // → printable markdown string (initial → final per handoff, every change with reason)
```

---
## Task 1: Repoint the "opus" seat → claude-opus-5

**Files:**
- Modify: `harness-intake/lib/models.js`, `harness-plan/lib/models.js`, `harness-implement/lib/models.js`
- Modify: `harness-intake/workflow.js`, `harness-plan/workflow.js:154`, `harness-implement/workflow.js` (the `opusModel` const)
- Test: the existing `harness-plan/lib/models.test.js` (+ intake/implement equivalents)

**Interfaces:**
- Produces: `MODEL.opus === 'claude-opus-5'` in all three skills.

- [ ] **Step 1: Update the failing test first (harness-plan/lib/models.test.js)**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL } from './models.js'

test('opus seat points at claude-opus-5', () => {
  assert.equal(MODEL.opus, 'claude-opus-5')
})
test('sonnet and haiku seats unchanged', () => {
  assert.equal(MODEL.sonnet, 'anthropic.claude-sonnet-4-6')
  assert.equal(MODEL.haiku, 'claude-haiku-4-5-20251001')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/206618626@bwt3.com/Desktop/Repos/skills && node --test harness-plan/lib/models.test.js`
Expected: FAIL — `MODEL.opus` is `'claude-opus-4-8'`.

- [ ] **Step 3: Update all three lib/models.js**

In each of `harness-intake/lib/models.js`, `harness-plan/lib/models.js`, `harness-implement/lib/models.js`, change the opus line to:

```js
export const MODEL = {
  opus:   'claude-opus-5',
  sonnet: 'anthropic.claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
}
```

- [ ] **Step 4: Update the inline `opusModel` const in each workflow.js**

In `harness-plan/workflow.js:154` (`const opusModel = 'claude-opus-4-8'`) and the equivalent lines in `harness-intake/workflow.js` and `harness-implement/workflow.js`, set the value to `'claude-opus-5'`. (Grep each file for `claude-opus-4-8` and replace all occurrences.)

Run: `grep -rn "claude-opus-4-8" harness-intake harness-plan harness-implement` → expected: no matches.

- [ ] **Step 5: Run tests**

Run: `cd /Users/206618626@bwt3.com/Desktop/Repos/skills && npm test`
Expected: PASS (models tests green; nothing else regresses).

- [ ] **Step 6: Commit**

```bash
git add harness-*/lib/models.js harness-*/workflow.js
git commit -m "harness: repoint opus seat to claude-opus-5

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Add `retries` + `errorLog` to the v2 telemetry record (all three skills)

**Files:**
- Modify: `harness-intake/workflow.js`, `harness-plan/workflow.js:59-92`, `harness-implement/workflow.js` (the `_buildV2Record` return object)
- Test: `harness-plan/lib/telemetry.test.js` (add a record-shape test via a small exported helper)

**Interfaces:**
- Produces: every v2 record now carries `retries: <int|0>` and `errorLog: <array>`. Existing fields untouched.

- [ ] **Step 1: Add a pure record-defaults helper to lib/telemetry.js (each skill) + test**

Add to `harness-plan/lib/telemetry.js`:

```js
/** Fields every v2 record must carry beyond the base shape. ADD-only; never remove. */
export function recordExtras({ retries = 0, errorLog = [] } = {}) {
  return { retries, errorLog }
}
```

Add to `harness-plan/lib/telemetry.test.js`:

```js
import { recordExtras } from './telemetry.js'
test('recordExtras defaults retries=0 and errorLog=[]', () => {
  assert.deepEqual(recordExtras(), { retries: 0, errorLog: [] })
})
test('recordExtras passes through provided values', () => {
  assert.deepEqual(recordExtras({ retries: 2, errorLog: [{ phase: 'x', message: 'y', ts: 't' }] }),
    { retries: 2, errorLog: [{ phase: 'x', message: 'y', ts: 't' }] })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test harness-plan/lib/telemetry.test.js`
Expected: FAIL — `recordExtras` not exported.

- [ ] **Step 3: Wire the fields into `_buildV2Record` in each workflow.js**

In `harness-plan/workflow.js`, in the object returned by `_buildV2Record` (ends around `:91` with `...extra,`), add before `...extra,`:

```js
    retries:    args.retries != null ? args.retries : 0,
    errorLog:   Array.isArray(args.errorLog) ? args.errorLog : [],
```

Mirror the same two lines in `harness-intake/workflow.js` and `harness-implement/workflow.js` record builders. Because `...extra` is spread last, a caller may still override these per-write.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add harness-*/lib/telemetry.js harness-*/lib/telemetry.test.js harness-*/workflow.js
git commit -m "harness: add retries + errorLog to v2 telemetry record (add-only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---
## Task 3: Scaffold the harness-bridge skill (models + telemetry libs)

**Files:**
- Create: `harness-bridge/lib/models.js`, `harness-bridge/lib/telemetry.js`
- Test: `harness-bridge/lib/models.test.js`

**Interfaces:**
- Produces: `MODEL` (opus→claude-opus-5); telemetry path helpers mirroring harness-plan.

- [ ] **Step 1: Create `harness-bridge/lib/models.js`**

```js
export const MODEL = {
  opus:   'claude-opus-5',
  sonnet: 'anthropic.claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
}
```

- [ ] **Step 2: Create `harness-bridge/lib/telemetry.js`** (mirror harness-plan/lib/telemetry.js)

```js
export function repoNameFromPath(repoPath) {
  if (!repoPath) return 'unknown-repo'
  return String(repoPath).replace(/\/$/, '').split('/').pop() || 'unknown-repo'
}
/** Bridge v2 telemetry path — mirrors harness-plan's inline pattern. */
export function bridgeTelemetryPath({ homeDir, repo, issueKey, runTs }) {
  return `${homeDir}/Desktop/Repos/harness-telemetry/v2/${repo}__harness-bridge__${issueKey}__${runTs}.jsonl`
}
export function buildAppendCmd(telemetryPath, jsonLine) {
  const escaped = jsonLine.replace(/'/g, "'\\''")
  return `mkdir -p "$(dirname '${telemetryPath}')" && echo '${escaped}' >> '${telemetryPath}'`
}
```

- [ ] **Step 3: Create `harness-bridge/lib/models.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL } from './models.js'
test('bridge opus seat is claude-opus-5', () => assert.equal(MODEL.opus, 'claude-opus-5'))
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/206618626@bwt3.com/Desktop/Repos/skills && node --test harness-bridge/lib/models.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/models.js harness-bridge/lib/telemetry.js harness-bridge/lib/models.test.js
git commit -m "harness-bridge: scaffold models + telemetry libs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `lib/confidence.js` — shared helpers + Handoff A checks + weight assertion

**Files:**
- Create: `harness-bridge/lib/confidence.js`
- Test: `harness-bridge/lib/confidence.test.js`

**Interfaces:**
- Produces: `THRESHOLD=85`, `CHECKS_A` (8 checks, Σweight=100), `assertWeightsSum`. `CHECKS_B` and `scoreArtifact` are added in Task 5.

- [ ] **Step 1: Write failing tests (`harness-bridge/lib/confidence.test.js`)**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { THRESHOLD, CHECKS_A, assertWeightsSum } from './confidence.js'

test('threshold is 85', () => assert.equal(THRESHOLD, 85))
test('Handoff A weights sum to exactly 100', () => assert.equal(assertWeightsSum(CHECKS_A), true))

const byId = (checks, id) => checks.find(c => c.id === id).fn

test('files-populated: L with empty subtask files scores 0 (bug #1)', () => {
  const m = { size: 'L', groups: [{ subtasks: [{ files: [] }, { files: [] }] }] }
  assert.equal(byId(CHECKS_A, 'files-populated')(m), 0)
})
test('files-populated: non-L is vacuously 1 (files deferred to plan)', () => {
  assert.equal(byId(CHECKS_A, 'files-populated')({ size: 'S', files: [] }), 1)
})
test('grounding-evidence-fresh: target present + verified beats absent', () => {
  const strong = { migrationPattern: 'axios → clientFetch', scopePath: 'src/client/clientFetch.ts',
    acList: [{ researchType: 'grep', grepPattern: 'axios', verifiedCount: 12 }] }
  const weak = { migrationPattern: 'axios → clientFetch',
    acList: [{ researchType: 'grep', grepPattern: 'axios', verifiedCount: 0 }] }
  assert.ok(byId(CHECKS_A, 'grounding-evidence-fresh')(strong) > byId(CHECKS_A, 'grounding-evidence-fresh')(weak))
})
test('size-shape-consistency: L requires groups', () => {
  assert.equal(byId(CHECKS_A, 'size-shape-consistency')({ size: 'L', groups: [] }), 0)
  assert.equal(byId(CHECKS_A, 'size-shape-consistency')({ size: 'S' }), 1)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test harness-bridge/lib/confidence.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `harness-bridge/lib/confidence.js` (helpers + CHECKS_A)**

```js
export const THRESHOLD = 85

const clamp01 = x => Math.max(0, Math.min(1, x))
const mean = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 1 // vacuous 1 for empty populations
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

export function assertWeightsSum(checks) {
  const sum = checks.reduce((s, c) => s + c.weight, 0)
  if (sum !== 100) throw new Error(`weights sum to ${sum}, expected 100`)
  return true
}
assertWeightsSum(CHECKS_A)
```

- [ ] **Step 4: Run tests**

Run: `node --test harness-bridge/lib/confidence.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/confidence.js harness-bridge/lib/confidence.test.js
git commit -m "harness-bridge: confidence Handoff A checks (Σ=100)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---
## Task 5: `lib/confidence.js` — Handoff B checks + `scoreArtifact`

**Files:**
- Modify: `harness-bridge/lib/confidence.js` (append CHECKS_B + scoreArtifact)
- Test: `harness-bridge/lib/confidence.test.js` (append)

**Interfaces:**
- Consumes: `CHECKS_A`, `assertWeightsSum` from Task 4.
- Produces: `CHECKS_B` (8 checks, Σweight=100), `scoreArtifact(artifact, handoff, weightsOverride)`.
- B artifact shape: `{ tasks:[{id,title,description,files[],tddRequired,acceptanceCriteria}], plans:[{id,dependsOn[]}], execution, size }`.

- [ ] **Step 1: Append failing tests**

```js
import { CHECKS_B, scoreArtifact } from './confidence.js'

test('Handoff B weights sum to exactly 100', () => assert.equal(assertWeightsSum(CHECKS_B), true))

const bId = id => CHECKS_B.find(c => c.id === id).fn
test('task-files-present-bounded: empty=0, 1-3=1, decays >3', () => {
  assert.equal(bId('task-files-present-bounded')({ tasks: [{ files: [] }] }), 0)
  assert.equal(bId('task-files-present-bounded')({ tasks: [{ files: ['a', 'b'] }] }), 1)
  assert.ok(bId('task-files-present-bounded')({ tasks: [{ files: ['a', 'b', 'c', 'd', 'e', 'f'] }] }) < 1)
})
test('task-spec-completeness: full task passes, prose-only fails', () => {
  const full = { tasks: [{ tddRequired: true, description: 'WHAT: x\nWHERE: src/a.ts:12 the fn\nHOW: mirror this pattern here now\n```js\nx()\n```\nDONE: expect(x()).toBe(1)' }] }
  const thin = { tasks: [{ tddRequired: false, description: 'just do the thing' }] }
  assert.equal(bId('task-spec-completeness')(full), 1)
  assert.equal(bId('task-spec-completeness')(thin), 0)
})
test('manifest-dag-consistency: unresolvable dependsOn fails', () => {
  assert.ok(bId('manifest-dag-consistency')({ plans: [{ id: 'p1', dependsOn: ['pX'] }], execution: 'sequential' }) < 1)
})
test('scoreArtifact returns 0..100 with perCheck contributions summing to score', () => {
  const r = scoreArtifact({ size: 'S', files: [], acList: [{ researchType: 'grep', grepPattern: 'axios', verifiedCount: 5 }], migrationPattern: 'axios → clientFetch', scopePath: 'src' }, 'A', null)
  assert.ok(r.score >= 0 && r.score <= 100)
  assert.equal(r.score, Math.round(r.perCheck.reduce((s, p) => s + p.contribution, 0)))
})
test('scoreArtifact honors weightsOverride', () => {
  const art = { tasks: [{ files: ['a'], description: 'x' }] }
  const base = scoreArtifact(art, 'B', null).score
  const boosted = scoreArtifact(art, 'B', { 'task-files-present-bounded': 60, 'task-spec-completeness': 0 }).score
  assert.notEqual(base, boosted)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test harness-bridge/lib/confidence.test.js`
Expected: FAIL — `CHECKS_B`/`scoreArtifact` not exported.

- [ ] **Step 3: Append to `harness-bridge/lib/confidence.js`**

```js
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
assertWeightsSum(CHECKS_B)

export function scoreArtifact(artifact, handoff, weightsOverride = null) {
  const checks = handoff === 'A' ? CHECKS_A : CHECKS_B
  const weightOf = id => (weightsOverride && id in weightsOverride)
    ? weightsOverride[id]
    : checks.find(c => c.id === id).weight
  const perCheck = checks.map(c => {
    const value = clamp01(c.fn(artifact))
    const weight = weightOf(c.id)
    return { id: c.id, value: +value.toFixed(4), weight, contribution: +(value * weight).toFixed(2) }
  })
  const score = Math.round(perCheck.reduce((s, p) => s + p.contribution, 0))
  return { score, perCheck }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test harness-bridge/lib/confidence.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/confidence.js harness-bridge/lib/confidence.test.js
git commit -m "harness-bridge: confidence Handoff B checks + scoreArtifact

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---
## Task 6: `lib/gated.js` — stamp the manifest as a new versioned file

**Files:**
- Create: `harness-bridge/lib/gated.js`
- Test: `harness-bridge/lib/gated.test.js`

**Interfaces:**
- Produces: `gatedPathFor(origPath)`, `stampManifest(artifact, stamp)`.

- [ ] **Step 1: Write failing tests (`harness-bridge/lib/gated.test.js`)**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gatedPathFor, stampManifest } from './gated.js'

test('gatedPathFor inserts -gated before .json', () => {
  assert.equal(gatedPathFor('/x/2026-07-27-TARS-1271-intake-manifest.json'),
    '/x/2026-07-27-TARS-1271-intake-manifest-gated.json')
})
test('gatedPathFor is idempotent', () => {
  assert.equal(gatedPathFor('/x/a-gated.json'), '/x/a-gated.json')
})
test('stampManifest adds fields without mutating the original', () => {
  const orig = { size: 'S', acList: [] }
  const stamped = stampManifest(orig, { confidence: 88, verdict: 'PROCEED', flags: [], probeResults: [] })
  assert.equal(stamped.gated, true)
  assert.equal(stamped.confidence, 88)
  assert.equal(stamped.verdict, 'PROCEED')
  assert.equal(orig.gated, undefined) // original untouched
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test harness-bridge/lib/gated.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `harness-bridge/lib/gated.js`**

```js
export function gatedPathFor(origPath) {
  if (/-gated\.json$/.test(origPath)) return origPath
  return origPath.replace(/\.json$/, '-gated.json')
}
export function stampManifest(artifact, { confidence, verdict, flags = [], probeResults = [] }) {
  return { ...artifact, gated: true, confidence, verdict, flags, probeResults }
}
```

- [ ] **Step 4: Run tests** — `node --test harness-bridge/lib/gated.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/gated.js harness-bridge/lib/gated.test.js
git commit -m "harness-bridge: gated manifest stamper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `lib/verdict.js` — PROCEED / RE_ASK / EXIT with one-retry budget

**Files:**
- Create: `harness-bridge/lib/verdict.js`
- Test: `harness-bridge/lib/verdict.test.js`

**Interfaces:**
- Consumes: `THRESHOLD` from confidence.js.
- Produces: `verdictFor(finalScore, retriesUsed)` → `{ verdict, action }`.
  - `finalScore >= 85` → `{ verdict:'PROCEED', action:'advance' }`
  - `< 85` and `retriesUsed === 0` → `{ verdict:'RE_ASK', action:'refine' }`
  - `< 85` and `retriesUsed >= 1` → `{ verdict:'EXIT', action:'stop' }`

- [ ] **Step 1: Write failing tests (`harness-bridge/lib/verdict.test.js`)**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verdictFor } from './verdict.js'

test('score >= 85 proceeds', () => assert.deepEqual(verdictFor(85, 0), { verdict: 'PROCEED', action: 'advance' }))
test('first miss re-asks (refine)', () => assert.deepEqual(verdictFor(70, 0), { verdict: 'RE_ASK', action: 'refine' }))
test('second miss exits', () => assert.deepEqual(verdictFor(70, 1), { verdict: 'EXIT', action: 'stop' }))
test('proceed even after a retry if score recovered', () => assert.deepEqual(verdictFor(90, 1), { verdict: 'PROCEED', action: 'advance' }))
```

- [ ] **Step 2: Run to verify it fails** — `node --test harness-bridge/lib/verdict.test.js` → FAIL.

- [ ] **Step 3: Implement `harness-bridge/lib/verdict.js`**

```js
import { THRESHOLD } from './confidence.js'

export function verdictFor(finalScore, retriesUsed) {
  if (finalScore >= THRESHOLD) return { verdict: 'PROCEED', action: 'advance' }
  if (retriesUsed === 0) return { verdict: 'RE_ASK', action: 'refine' }
  return { verdict: 'EXIT', action: 'stop' }
}
```

- [ ] **Step 4: Run tests** — `node --test harness-bridge/lib/verdict.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/verdict.js harness-bridge/lib/verdict.test.js
git commit -m "harness-bridge: verdict + one-retry budget

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---
## Task 8: `lib/weights.js` — override layer, bounds, renormalize, change log

**Files:**
- Create: `harness-bridge/lib/weights.js`
- Test: `harness-bridge/lib/weights.test.js`

**Interfaces:**
- Produces:
  - `loadWeights(defaultChecks, override)` — `override:{id:weight}|null` → `{id:weight}` normalized to 100.
  - `makeWeightChange({handoff,checkId,oldWeight,newWeight,reason,triggeringRunId,ts})` → the audit record for `weightChanges[]`.
  - `applyWeightChange(weights, change)` → new `{id:weight}` with the changed check bounded (±15/adj, floor 1, ceiling 60) and the rest renormalized so the total is exactly 100.
- Bounds are the Global Constraint "Weight-agency bounds (tonight only)".

- [ ] **Step 1: Write failing tests (`harness-bridge/lib/weights.test.js`)**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadWeights, makeWeightChange, applyWeightChange } from './weights.js'
import { CHECKS_A } from './confidence.js'

const sum = w => Object.values(w).reduce((s, x) => s + x, 0)

test('loadWeights(null) returns defaults summing to 100', () => {
  const w = loadWeights(CHECKS_A, null)
  assert.equal(sum(w), 100)
  assert.equal(w['grounding-evidence-fresh'], 24)
})
test('loadWeights renormalizes an override to exactly 100', () => {
  const w = loadWeights(CHECKS_A, { 'grounding-evidence-fresh': 40 })
  assert.equal(sum(w), 100)
})
test('applyWeightChange clamps to ±15 per adjustment', () => {
  const base = loadWeights(CHECKS_A, null)
  const out = applyWeightChange(base, { checkId: 'files-populated', newWeight: 90 }) // old 20 → clamped 35
  assert.equal(out['files-populated'], 35)
  assert.equal(sum(out), 100)
})
test('applyWeightChange respects ceiling 60 and floor 1', () => {
  const base = loadWeights(CHECKS_A, { 'grounding-evidence-fresh': 55 })
  // requesting +15 from 55 would be 70 → ceiling 60
  const out = applyWeightChange(base, { checkId: 'grounding-evidence-fresh', newWeight: 70 })
  assert.ok(out['grounding-evidence-fresh'] <= 60)
  assert.equal(sum(out), 100)
})
test('makeWeightChange returns the full audit shape', () => {
  const c = makeWeightChange({ handoff: 'A', checkId: 'x', oldWeight: 10, newWeight: 20, reason: 'y', triggeringRunId: 'r', ts: 't' })
  assert.deepEqual(Object.keys(c).sort(), ['checkId', 'handoff', 'newWeight', 'oldWeight', 'reason', 'triggeringRunId', 'ts'])
})
```

- [ ] **Step 2: Run to verify it fails** — `node --test harness-bridge/lib/weights.test.js` → FAIL.

- [ ] **Step 3: Implement `harness-bridge/lib/weights.js`**

```js
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
```

Note: only the adjusted check is hard-bounded; the proportional redistribution keeps the total at 100 but does not re-enforce the 1..60 band on the others (acceptable for tonight's single-check ±15 nudges — the drift is small and every change is logged).

- [ ] **Step 4: Run tests** — `node --test harness-bridge/lib/weights.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/weights.js harness-bridge/lib/weights.test.js
git commit -m "harness-bridge: weight override + bounds + renormalize

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---
## Task 9: `lib/holepoker.js` — adversarial skeptic (lower-only) parse + clamp

**Files:**
- Create: `harness-bridge/lib/holepoker.js`
- Test: `harness-bridge/lib/holepoker.test.js`

**Interfaces:**
- Produces:
  - `clampAdjusted(score, adjusted)` → `min(score, max(0, adjusted))` — the hole-poker may only LOWER the JS score, never raise it, and never below 0.
  - `parseHolePoker(raw)` → `{ adjustedScore, reasons[] }` — tolerant parse of the Sonnet skeptic's JSON (or text); on unparseable input returns `{ adjustedScore: null, reasons: [] }` so the caller falls back to the raw JS score.

- [ ] **Step 1: Write failing tests (`harness-bridge/lib/holepoker.test.js`)**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampAdjusted, parseHolePoker } from './holepoker.js'

test('clampAdjusted never raises the score', () => {
  assert.equal(clampAdjusted(80, 95), 80) // skeptic tried to raise → held at 80
})
test('clampAdjusted lowers when skeptic is lower', () => {
  assert.equal(clampAdjusted(80, 55), 55)
})
test('clampAdjusted floors at 0', () => {
  assert.equal(clampAdjusted(80, -10), 0)
})
test('parseHolePoker reads a clean JSON object', () => {
  const r = parseHolePoker('{"adjustedScore": 60, "reasons": ["files thin", "grep unverified"]}')
  assert.equal(r.adjustedScore, 60)
  assert.deepEqual(r.reasons, ['files thin', 'grep unverified'])
})
test('parseHolePoker tolerates fenced JSON', () => {
  const r = parseHolePoker('```json\n{"adjustedScore": 42, "reasons": []}\n```')
  assert.equal(r.adjustedScore, 42)
})
test('parseHolePoker returns null score on garbage (caller keeps JS score)', () => {
  const r = parseHolePoker('the plan looks fine to me')
  assert.equal(r.adjustedScore, null)
  assert.deepEqual(r.reasons, [])
})
```

- [ ] **Step 2: Run to verify it fails** — `node --test harness-bridge/lib/holepoker.test.js` → FAIL.

- [ ] **Step 3: Implement `harness-bridge/lib/holepoker.js`**

```js
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
```

- [ ] **Step 4: Run tests** — `node --test harness-bridge/lib/holepoker.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/holepoker.js harness-bridge/lib/holepoker.test.js
git commit -m "harness-bridge: hole-poker parse + lower-only clamp

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---
## Task 10: `harness-bridge/workflow.js` — the gate driver

**Files:**
- Create: `harness-bridge/workflow.js`
- Test: none directly (workflow.js uses injected Workflow globals; all pure logic it calls is tested in Tasks 4–9). A PURE mirror block is NOT needed here because the pure logic lives in `lib/` and — per Phase 0 probe — `workflow.js` imports it directly. If the Phase 0 probe showed imports do NOT resolve, mirror `scoreArtifact`/`clampAdjusted`/`parseHolePoker`/`verdictFor`/`gatedPathFor`/`stampManifest`/`loadWeights` into a `// ===== PURE (mirrors lib/) =====` block, keeping `lib/` authoritative.

**Interfaces:**
- Consumes (args): `{ artifactPath, handoff, retriesUsed, weightsOverride, homeDir, repo, repoPath, issueKey, runId, runTs, skillsCommit, startTs }`.
  - `handoff` ∈ `'A' | 'B'`. `artifactPath` is the upstream manifest to gate (`intake-manifest.json` for A; the plan `-manifest.json` + `p1.json` for B — B reads both, see Step 3).
- Consumes (lib): `scoreArtifact`, `THRESHOLD` (confidence.js); `clampAdjusted`, `parseHolePoker` (holepoker.js); `verdictFor` (verdict.js); `gatedPathFor`, `stampManifest` (gated.js); `loadWeights` (weights.js); `MODEL` (models.js); `bridgeTelemetryPath`, `buildAppendCmd`, `repoNameFromPath` (telemetry.js).
- Produces (return): `{ score, finalScore, verdict, action, perCheck, flags, probeResults, gatedPath, telemetryPath, outputTokensTotal, agentCountByModel, cliSummary }`.

- [ ] **Step 1: Build the B-artifact loader (pure, inline)**

Handoff B needs `{ tasks, plans, execution, size }`. The plan skill writes `p1.json` (tasks) and `-manifest.json` (plans/execution/size). The loader reads the manifest, then reads each `plans[].jsonPath` and flattens their tasks:

```js
function loadArtifact(handoff, raw) {
  if (handoff === 'A') return raw // intake-manifest.json shape, used as-is
  // handoff B: raw is the plan manifest; tasks are pulled from each plan's jsonPath (already inlined by the caller into raw._tasks)
  return {
    tasks: raw._tasks || [],
    plans: raw.plans || [],
    execution: raw.execution || 'sequential',
    size: raw.size || null,
  }
}
```

The SKILL.md wrapper (Task 11) is responsible for reading the JSON files off disk and passing the parsed manifest as `args.artifact` plus, for B, the concatenated tasks as `args.artifact._tasks`. workflow.js does not read files itself (keeps it pure-ish and testable through its callees).

- [ ] **Step 2: Write `harness-bridge/workflow.js`**

```js
import { scoreArtifact, THRESHOLD, CHECKS_A, CHECKS_B } from './lib/confidence.js'
import { clampAdjusted, parseHolePoker } from './lib/holepoker.js'
import { verdictFor } from './lib/verdict.js'
import { gatedPathFor, stampManifest } from './lib/gated.js'
import { loadWeights } from './lib/weights.js'
import { MODEL } from './lib/models.js'
import { bridgeTelemetryPath, buildAppendCmd, repoNameFromPath } from './lib/telemetry.js'

export const meta = {
  name: 'harness-bridge',
  description: 'Confidence gate between harness skills: score an upstream artifact, run one adversarial skeptic, emit PROCEED/RE_ASK/EXIT + a gated manifest.',
  phases: [{ title: 'Score' }, { title: 'Skeptic' }, { title: 'Gate' }],
}

const a = args || {}
const handoff = a.handoff === 'B' ? 'B' : 'A'
const retriesUsed = a.retriesUsed || 0
const errorLog = []

function loadArtifact(h, raw) {
  if (h === 'A') return raw
  return { tasks: raw._tasks || [], plans: raw.plans || [], execution: raw.execution || 'sequential', size: raw.size || null }
}

phase('Score')
const artifact = loadArtifact(handoff, a.artifact || {})
const checks = handoff === 'A' ? CHECKS_A : CHECKS_B
const weights = loadWeights(checks, a.weightsOverride || null)
const { score, perCheck } = scoreArtifact(artifact, handoff, weights)
log(`JS confidence (handoff ${handoff}): ${score}/100`)

// Flags: any check whose contribution is far below its weight is a weak spot the skeptic should probe.
const flags = perCheck.filter(p => p.value < 0.5).map(p => p.id)

phase('Skeptic')
// ONE adversarial skeptic. It may only LOWER the score. Give it the per-check breakdown + the artifact.
let adjustedScore = null
let reasons = []
try {
  const raw = await agent(
    `You are an adversarial reviewer. A pure-JS checklist scored an upstream ${handoff === 'A' ? 'intake' : 'plan'} artifact at ${score}/100 for readiness to hand to the next harness stage.

Per-check breakdown (id · value 0..1 · weight):
${perCheck.map(p => `- ${p.id}: ${p.value} · ${p.weight}`).join('\n')}

Artifact (JSON):
${JSON.stringify(artifact).slice(0, 12000)}

Your job: find holes the checklist missed — stale grounding, empty/placeholder files, assumed-but-unverified primitives, omitted companion edits, a concern folded into another task, single-source sizing. You may ONLY lower the score or leave it unchanged; you may NEVER raise it. If you find nothing, return the same score.

Respond with ONLY this JSON: {"adjustedScore": <int 0..${score}>, "reasons": ["...", "..."]}`,
    { label: `skeptic:${handoff}`, phase: 'Skeptic', model: MODEL.sonnet, effort: 'high' }
  )
  const parsed = parseHolePoker(raw)
  adjustedScore = parsed.adjustedScore
  reasons = parsed.reasons
} catch (err) {
  errorLog.push({ phase: 'skeptic', message: String(err?.message || err), ts: a.runTs })
}

const finalScore = clampAdjusted(score, adjustedScore)
const probeResults = reasons.map(r => ({ source: 'skeptic', reason: r }))
log(`Final confidence after skeptic: ${finalScore}/100${adjustedScore != null && adjustedScore < score ? ` (lowered from ${score})` : ''}`)

phase('Gate')
const { verdict, action } = verdictFor(finalScore, retriesUsed)
log(`Verdict: ${verdict} → ${action}`)

// Stamp + path. gatedPath is derived from the primary artifact path passed by the wrapper.
const gatedPath = a.artifactPath ? gatedPathFor(a.artifactPath) : null
const stamped = stampManifest(a.artifact || {}, { confidence: finalScore, verdict, flags, probeResults })

// Telemetry
const repo = a.repo || repoNameFromPath(a.repoPath)
const telemetryPath = bridgeTelemetryPath({ homeDir: a.homeDir, repo, issueKey: a.issueKey || 'intake', runTs: a.runTs })
const record = {
  schemaVersion: 2,
  runId: a.runId,
  skill: 'harness-bridge',
  skillsCommit: a.skillsCommit || 'unknown',
  ts: a.runTs,
  status: 'COMPLETE',
  outcome: verdict,
  sourceIssue: a.issueKey || null,
  repo,
  repoPath: a.repoPath || null,
  handoff,
  confidence: finalScore,
  jsScore: score,
  verdict,
  action,
  flags,
  probeResults,
  perCheck,
  weights,
  retries: retriesUsed,
  errorLog,
  weightChanges: a.weightChanges || [],
}
const line = JSON.stringify(record)

const cliSummary = [
  `╭─ harness-bridge (handoff ${handoff}) ─────────────`,
  `│ JS score:    ${score}/100`,
  `│ Final score: ${finalScore}/100  (threshold ${THRESHOLD})`,
  `│ Verdict:     ${verdict} → ${action}`,
  flags.length ? `│ Weak checks: ${flags.join(', ')}` : `│ Weak checks: none`,
  reasons.length ? `│ Skeptic:     ${reasons.slice(0, 3).join(' | ')}` : `│ Skeptic:     no holes found`,
  `╰────────────────────────────────────────────`,
].join('\n')

return {
  score, finalScore, verdict, action, perCheck, flags, probeResults,
  gatedPath, stamped, telemetryPath, telemetryLine: line, appendCmd: buildAppendCmd(telemetryPath, line),
  outputTokensTotal: null, agentCountByModel: { [MODEL.sonnet]: 1 },
  cliSummary,
}
```

Note: workflow.js returns `stamped`, `telemetryLine`, and `appendCmd` for the SKILL wrapper to persist (workflow scripts have no filesystem access). The wrapper writes the gated JSON with the Write tool and appends telemetry with Bash.

- [ ] **Step 3: Smoke-check the script parses** — `node --check harness-bridge/workflow.js` → exits 0 (syntax only; it will not run standalone because of injected globals).

- [ ] **Step 4: Run the full suite** — `npm test` → still green (no new tests here; the lib tests already cover the logic).

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/workflow.js
git commit -m "harness-bridge: gate driver (score → skeptic → verdict → stamp)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---
## Task 11: `harness-bridge/SKILL.md` — invocation, I/O contract, telemetry wrapper

**Files:**
- Create: `harness-bridge/SKILL.md`
- Create: `harness-bridge/CHANGELOG.md` (single line: `## v1 — initial confidence gate`)

**Interfaces:**
- Consumes: an upstream artifact path + `handoff` + `retriesUsed` + optional `weightsOverride`.
- Produces: writes `<artifact>-gated.json`, appends a bridge v2 telemetry record, prints `cliSummary`, and returns the verdict to `harness-run` (the only caller).

- [ ] **Step 1: Write `harness-bridge/SKILL.md`** with these sections (verbatim structure below):

````markdown
# harness-bridge

## Philosophy

**harness-bridge is the confidence gate between every harness stage.** It never does the work of intake, plan, or implement — it decides whether the *previous* stage's output is trustworthy enough to hand forward. It scores an upstream artifact with a frozen pure-JS checklist, runs exactly ONE adversarial skeptic (which may only lower the score), and emits a verdict:

| Verdict | Score | Action |
|---|---|---|
| **PROCEED** | ≥ 85 | Stamp a `-gated.json` and advance. Downstream treats the gated manifest as MORE truthful than the ticket (manifest supremacy). |
| **RE_ASK** | < 85, first miss | Autonomously re-research: re-run the upstream skill with `--refine`, then re-gate once. |
| **EXIT** | < 85, second miss | Stop and surface. Do not advance. |

One retry budget total. The gate is deterministic (weighted checklist); the skeptic can only make it more conservative.

## When to Use

harness-bridge is invoked by **harness-run** between stages — not directly by a human in normal flow. Two handoffs:

- **Handoff A** — intake → plan. Gates `intake-manifest.json`.
- **Handoff B** — plan → implement. Gates the plan `-manifest.json` + `p1.json`.

## Invocation

harness-run calls this skill with the upstream artifact already on disk. The wrapper reads the JSON, fires the workflow, and persists the outputs.

```js
// A: artifact = parsed intake-manifest.json
// B: artifact = parsed plan -manifest.json, PLUS artifact._tasks = concat of every plans[].jsonPath tasks[]
let artifact = JSON.parse(await Read(artifactPath))
if (handoff === 'B') {
  const tasks = []
  for (const p of artifact.plans || []) {
    const pj = JSON.parse(await Read(`${repoPath}/${p.jsonPath}`))
    tasks.push(...(pj.tasks || []))
  }
  artifact._tasks = tasks
}

const startTs = await Bash('python3 -c "import time; print(int(time.time()*1000))"').then(r => r.trim())
const result = await Workflow({
  scriptPath: '/Users/206618626@bwt3.com/.claude/skills/harness-bridge/workflow.js',
  args: {
    artifact, artifactPath, handoff,          // 'A' | 'B'
    retriesUsed,                              // 0 on first gate, 1 after one --refine
    weightsOverride: weightsOverride || null, // {checkId: weight} or null
    homeDir, repo, repoPath, issueKey, runId, runTs, skillsCommit, startTs,
  },
})
```

**Do not investigate the artifact independently while the workflow runs. Wait for `result`.**

## Persist the outputs (wrapper responsibility)

The workflow has no filesystem access. After it returns:

```js
// 1. Write the gated manifest (only meaningful on PROCEED; harmless otherwise)
if (result.gatedPath) {
  // Write result.stamped as prettified JSON to result.gatedPath (absolute)
}
// 2. Append telemetry (always — even on EXIT)
await Bash(result.appendCmd)
// 3. Print the summary
// print result.cliSummary verbatim
```

## Verdict handling (returned to harness-run)

harness-run reads `result.verdict` / `result.action` and does NOT re-implement the retry policy — `verdictFor` already encoded it:

- `PROCEED / advance` → pass `result.gatedPath` to the downstream skill.
- `RE_ASK / refine` → re-run the upstream skill with `--refine` (see harness-intake / harness-plan refine modes), then call harness-bridge again with `retriesUsed: 1`.
- `EXIT / stop` → halt the run, surface the weak checks (`result.flags`) and skeptic reasons (`result.probeResults`).

## Manifest supremacy (on PROCEED)

Once a manifest is gated PROCEED, downstream skills treat `<artifact>-gated.json` as ground truth over the original ticket text. If the gated manifest and the ticket disagree (e.g. file count, scope), the gated manifest wins — it was verified against the repo; the ticket was not. See [[feedback_harness_pillars]] (manifest-as-hypothesis, now promoted to verified truth post-gate).

## Telemetry

Bridge records are v2, written to `~/Desktop/Repos/harness-telemetry/v2/{repo}__harness-bridge__{issueKey}__{runTs}.jsonl`. Bridge adds these fields on top of the base v2 shape: `handoff, confidence, jsScore, verdict, action, flags, probeResults, perCheck, weights, retries, errorLog, weightChanges`. Never remove a field; skills may only ADD.

## Getting past a barrier

(Identical NEVER-list routine as the other harness skills — copy the "Getting past a barrier" section verbatim from harness-plan/SKILL.md.)
````

- [ ] **Step 2: Create `harness-bridge/CHANGELOG.md`**

```markdown
# harness-bridge changelog

## v1 — initial confidence gate
- Frozen pure-JS checklist (Handoff A: 8 checks; Handoff B: 8 checks), Σweight=100 each.
- One adversarial skeptic (Sonnet, lower-only).
- PROCEED (≥85) / RE_ASK (first miss) / EXIT (second miss), one retry budget.
- Gated manifest stamping + manifest supremacy downstream.
- Weight-agency override layer (tonight-only), bounded + renormalized + logged.
```

- [ ] **Step 3: Commit**

```bash
git add harness-bridge/SKILL.md harness-bridge/CHANGELOG.md
git commit -m "harness-bridge: SKILL.md invocation + I/O contract + telemetry wrapper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---
## Task 12: `--refine` mode on harness-intake

**Files:**
- Modify: `harness-intake/workflow.js` (thread a `refine` arg into the research/classification prompts)
- Modify: `harness-intake/SKILL.md` (parse `--refine`, pass the prior gate's weak points)

**Interfaces:**
- Consumes: `args.refine = { flags:[checkId], probeResults:[{source,reason}], priorManifestPath } | null`.
- Produces: a re-researched `intake-manifest.json` that specifically targets the weak checks the gate flagged. No new output fields — same manifest contract, better-grounded content.

- [ ] **Step 1: SKILL.md — parse `--refine`**

Add to the flag-parsing section of `harness-intake/SKILL.md`:

> **`--refine <priorManifestPath>`** — re-research mode, invoked by harness-run after a RE_ASK verdict. Load the prior manifest and the bridge's flags/probeResults, and pass them as `args.refine`. The workflow uses them to target its re-research at the specific weak checks (e.g. `grounding-evidence-fresh` low → re-run the grep with `verifiedCount`; `files-populated` low on an L → re-derive subtask files). This does not change the manifest contract — it produces a better-grounded manifest of the same shape.

Invocation delta:

```js
// when --refine is present:
const refine = {
  flags: bridgeResult.flags || [],
  probeResults: bridgeResult.probeResults || [],
  priorManifestPath,
}
// pass refine into the existing Workflow(...) args object (add `refine` key; default null otherwise)
```

- [ ] **Step 2: workflow.js — thread `refine` into prompts**

In `harness-intake/workflow.js`, read `const refine = args.refine || null` near the top where other args are destructured. Where the classification/AC-research prompt is built, append a targeted block when `refine` is set:

```js
const refineBlock = refine ? `

## REFINE PASS — the previous manifest was gated below threshold
The confidence gate flagged these weak checks: ${refine.flags.join(', ') || '(none named)'}.
Skeptic notes: ${(refine.probeResults || []).map(p => `- ${p.reason}`).join('\n') || '(none)'}.
Fix these specifically:
- grounding-evidence-fresh / ac-research-executable → actually RUN each AC's grep/shell and record verifiedCount; do not assume.
- files-populated → for an L split, every subtask must carry a non-empty files[]; derive them from the grep hits.
- size-corroboration → corroborate size from at least two signals (verified hit count AND file count), not a single Sonnet guess.
Produce a manifest that would now pass these checks.` : ''
// interpolate refineBlock into the intake reasoning prompt string
```

- [ ] **Step 3: Run tests** — `npm test` → green (no logic-under-test changed; this is prompt content).

- [ ] **Step 4: Smoke-check** — `node --check harness-intake/workflow.js` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add harness-intake/workflow.js harness-intake/SKILL.md
git commit -m "harness-intake: --refine re-research targeting gate-flagged weak checks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: `--refine` mode + manifest-supremacy re-sizing on harness-plan

**Files:**
- Modify: `harness-plan/workflow.js` (thread `refine`; re-size from the gated manifest)
- Modify: `harness-plan/SKILL.md` (parse `--refine`, document manifest supremacy)

**Interfaces:**
- Consumes: `args.refine = { flags, probeResults, priorPlanManifestPath, gatedIntakePath } | null`.
- Produces: a re-architected plan whose task specs target the flagged Handoff-B weaknesses, AND which re-sizes tasks off the **gated intake manifest** rather than the raw ticket (manifest supremacy).

- [ ] **Step 1: SKILL.md — parse `--refine` + document supremacy**

Add to `harness-plan/SKILL.md`:

> **`--refine <priorPlanManifestPath>`** — re-plan mode after a Handoff-B RE_ASK. Loads the prior plan manifest + the bridge flags/probeResults, and (critically) the **gated intake manifest** (`*-intake-manifest-gated.json`). The architect re-sizes and re-specifies tasks treating the gated manifest as ground truth — if the ticket says "118 files" but the gated manifest verified 92, the plan uses 92. This is **manifest supremacy**: a gated manifest outranks the ticket.

- [ ] **Step 2: workflow.js — thread `refine` and re-size from gated manifest**

Destructure `const refine = args.refine || null`. When present, (a) load the gated intake manifest's `size`/`files`/`acList` as the sizing source of truth, and (b) append a targeted architect block:

```js
const refineBlock = refine ? `

## REFINE PASS — the plan was gated below threshold at Handoff B
Weak checks: ${refine.flags.join(', ') || '(none named)'}.
Skeptic notes: ${(refine.probeResults || []).map(p => `- ${p.reason}`).join('\n') || '(none)'}.
Fix these specifically:
- task-spec-completeness → every task needs WHAT/WHERE/HOW and, when tddRequired, a literal DONE assertion + a fenced code snippet.
- task-files-present-bounded → every task carries 1–3 concrete files[]; split tasks that touch more.
- where-resolves-to-files → each WHERE names file:line that appears in that task's files[].
- companion-edit-closure → if a task imports a module, the file that must change to satisfy that import is also in some task's files[] (e.g. the auth middleware index.js re-export).
- concern-atomicity → one DONE per task; do not fold a distinct concern into another task.

## MANIFEST SUPREMACY
Use the GATED intake manifest as ground truth over the ticket for size and file scope:
${refine.gatedIntakePath ? '(gated manifest provided as args.gatedIntake)' : '(none)'}` : ''
```

Where the workflow currently reads `manifestEntry`/size, prefer `args.gatedIntake` fields when `refine` is set:

```js
const sizingSource = (refine && args.gatedIntake) ? args.gatedIntake : (manifestEntry || null)
// use sizingSource.size / sizingSource.files / sizingSource.acList downstream instead of ticket-derived values
```

The SKILL wrapper reads and passes `args.gatedIntake = JSON.parse(await Read(gatedIntakePath))` when `--refine` is set.

- [ ] **Step 3: Run tests** — `npm test` → green.

- [ ] **Step 4: Smoke-check** — `node --check harness-plan/workflow.js` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add harness-plan/workflow.js harness-plan/SKILL.md
git commit -m "harness-plan: --refine re-plan + manifest-supremacy re-sizing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---
## Task 14: `harness-run/lib/conductor.js` — sequence, verdict routing, aggregation, weight report

**Files:**
- Create: `harness-run/lib/conductor.js`
- Create: `harness-run/lib/models.js` (opus→claude-opus-5, mirror Task 3)
- Test: `harness-run/lib/conductor.test.js`

**Interfaces:**
- Produces:
  - `SEQUENCE` — the ordered stage list the runbook walks.
  - `actionForVerdict(verdict, retriesUsed)` → `{ next }` where `next ∈ 'advance' | 'refine' | 'stop'` (thin wrapper agreeing with `verdictFor`; used by the runbook narration so the sequence logic is unit-tested, not prose-only).
  - `assembleRunSummary(records)` → `{ stages, totalCostUsd, totalDurationMs, finalStatus }` aggregating each stage's telemetry record.
  - `weightEvolutionReport(initialWeights, weightChanges)` → a printable string: initial → final per handoff, every change with reason.

- [ ] **Step 1: Write failing tests (`harness-run/lib/conductor.test.js`)**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEQUENCE, actionForVerdict, assembleRunSummary, weightEvolutionReport } from './conductor.js'

test('SEQUENCE is intake → bridgeA → plan → bridgeB → implement', () => {
  assert.deepEqual(SEQUENCE.map(s => s.skill),
    ['harness-intake', 'harness-bridge', 'harness-plan', 'harness-bridge', 'harness-implement'])
})
test('actionForVerdict routes PROCEED/RE_ASK/EXIT', () => {
  assert.equal(actionForVerdict('PROCEED', 0).next, 'advance')
  assert.equal(actionForVerdict('RE_ASK', 0).next, 'refine')
  assert.equal(actionForVerdict('EXIT', 1).next, 'stop')
})
test('assembleRunSummary sums cost + duration and reports final status', () => {
  const recs = [
    { skill: 'harness-intake', cost: { rateLockedUsd: 0.5 }, durationMs: 1000, outcome: 'COMPLETE' },
    { skill: 'harness-bridge', confidence: 90, durationMs: 500, outcome: 'PROCEED' },
    { skill: 'harness-implement', cost: { rateLockedUsd: 2.0 }, durationMs: 3000, outcome: 'COMPLETE' },
  ]
  const s = assembleRunSummary(recs)
  assert.equal(s.totalCostUsd, 2.5)
  assert.equal(s.totalDurationMs, 4500)
  assert.equal(s.finalStatus, 'COMPLETE')
  assert.equal(s.stages.length, 3)
})
test('assembleRunSummary finalStatus is EXIT if any bridge exited', () => {
  const recs = [{ skill: 'harness-bridge', outcome: 'EXIT', durationMs: 10 }]
  assert.equal(assembleRunSummary(recs).finalStatus, 'EXIT')
})
test('weightEvolutionReport shows initial → final and each change', () => {
  const initial = { A: { 'files-populated': 20 }, B: { 'task-spec-completeness': 30 } }
  const changes = [{ handoff: 'A', checkId: 'files-populated', oldWeight: 20, newWeight: 30, reason: 'empty subtask files kept slipping', triggeringRunId: 'r1', ts: 't' }]
  const out = weightEvolutionReport(initial, changes)
  assert.match(out, /files-populated/)
  assert.match(out, /20 → 30/)
  assert.match(out, /empty subtask files/)
})
```

- [ ] **Step 2: Run to verify it fails** — `node --test harness-run/lib/conductor.test.js` → FAIL.

- [ ] **Step 3: Implement `harness-run/lib/conductor.js`**

```js
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
```

Also create `harness-run/lib/models.js` (identical to Task 3's models.js) and a one-line `harness-run/lib/models.test.js` asserting `MODEL.opus === 'claude-opus-5'`.

- [ ] **Step 4: Run tests** — `node --test harness-run/lib/conductor.test.js harness-run/lib/models.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add harness-run/lib/conductor.js harness-run/lib/conductor.test.js harness-run/lib/models.js harness-run/lib/models.test.js
git commit -m "harness-run: conductor sequence + verdict routing + run summary + weight report

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 15: `harness-run/SKILL.md` — the artifact-gated runbook

**Files:**
- Create: `harness-run/SKILL.md`
- Create: `harness-run/CHANGELOG.md`

**Interfaces:**
- Consumes: `/harness-run <jira-url-or-key> [--repo <path>] [--base <branch>]`.
- Produces: walks SEQUENCE, calling each child **as a skill** (never launching workflow.js directly), gating between stages via harness-bridge, aggregating telemetry, and printing the final run summary + weight-evolution report.

- [ ] **Step 1: Write `harness-run/SKILL.md`** with these sections:

````markdown
# harness-run

## Philosophy

**harness-run is the conductor, not a player.** It is an artifact-gated runbook — NOT a JS program that calls skills. It provisions an isolated worktree, then walks the fixed SEQUENCE (`lib/conductor.js`), invoking each child skill **as a skill** (`/harness-intake`, `/harness-plan`, `/harness-implement`) and running `/harness-bridge` between them as a confidence gate. It never launches any `workflow.js` directly. It aggregates every stage's telemetry and, at the end, prints a run summary and a weight-evolution report.

## The Sequence

```
Phase 0  provision worktree (off origin/<base>)
  ↓
harness-intake        → intake-manifest.json
  ↓  harness-bridge (Handoff A)   PROCEED / RE_ASK→refine intake / EXIT
harness-plan          → plan -manifest.json + p1.json
  ↓  harness-bridge (Handoff B)   PROCEED / RE_ASK→refine plan / EXIT
harness-implement     → code + tests
  ↓
guardrailed DRAFT PR + run summary + weight-evolution report
```

## Guardrails (NEVER cross without explicit human approval)

- **Draft PR only.** Push to a `harness/<ISSUE>-<slug>` branch; open a DRAFT PR with **base = the feature branch passed via `--base`** (default `feat/migrate-native-fetch-from-axios` for TARS-1271). NEVER merge, NEVER force-push, NEVER touch main/master.
- **Isolated worktree.** Base off `origin/<base>`; never touch the user's dirty local branches.
- **Fire children as skills.** Never launch a child `workflow.js` directly.
- **Stop on first success.** Once the PR lands + `npm test` green + telemetry flowed, STOP iterating.
- **Spend ceiling.** Hard stop if aggregate cost crosses the run's ceiling (default $500 tonight); stop-on-first-success is the primary brake.
- **NEVER-list categories** (irreversible-destructive, security-auth-permission, cost-over-threshold, public-api-contract, out-of-scope, legal-compliance) are never auto-decided — stop and surface.

## Phase 0 — Provision the worktree

```js
// resolve repoPath (webtarsthree for TARS-1271) and base branch
const base = flags.base || 'feat/migrate-native-fetch-from-axios'
const slug = `${issueKey.toLowerCase()}-e2e`
await Bash(`git -C ${repoPath} fetch origin ${base}`)
await Bash(`git -C ${repoPath} worktree add -b harness/${issueKey}-${runTs} ../wt-${issueKey}-${runTs} origin/${base}`)
// all subsequent child skills run with --repo pointing at the worktree path
```

## Walking the sequence

For each stage in `SEQUENCE` (from `lib/conductor.js`):

1. **Child skill** (intake/plan/implement): invoke as a slash-skill with `--repo <worktreePath>`, capture its manifest path and telemetry record.
2. **Bridge stage**: invoke `/harness-bridge` with the upstream artifact path + `handoff` + `retriesUsed` + current `weightsOverride`. Read `result.verdict`:
   - `actionForVerdict(verdict, retriesUsed).next === 'advance'` → pass `result.gatedPath` to the next child.
   - `=== 'refine'` → re-run the upstream child with `--refine` (passing `result.flags`, `result.probeResults`, and the gated intake path for plan), then re-gate with `retriesUsed: 1`.
   - `=== 'stop'` → halt; print the weak checks + skeptic reasons; do NOT advance.

## Weight agency (tonight only)

The frozen checklist is the jumping-off point. During the run, if a gate is visibly miscalibrated (e.g. it PROCEEDs on a plan that then stalls implement, or EXITs on a plan that is actually fine), harness-run MAY adjust a weight — under these guardrails:

**Override file wiring (do this in the runbook):** before the first gate, read `harness-bridge/weights-override.json`, creating it as `{}` if absent:

```js
let weightsOverride = {}
try { weightsOverride = JSON.parse(await Read('/Users/206618626@bwt3.com/.claude/skills/harness-bridge/weights-override.json')) }
catch { await Write('/Users/206618626@bwt3.com/.claude/skills/harness-bridge/weights-override.json', '{}\n'); weightsOverride = {} }
// shape: { A: {checkId: weight, ...}, B: {checkId: weight, ...} } — pass the per-handoff slice to each bridge call:
//   weightsOverride: (weightsOverride[handoff] && Object.keys(weightsOverride[handoff]).length) ? weightsOverride[handoff] : null
```

Pass that per-handoff slice as the bridge's `weightsOverride` arg (Task 11). To adjust mid-run, compute the new map with `applyWeightChange`, write it back to `weights-override.json` under its handoff key, record a `makeWeightChange({...})` event into the run's `allWeightChanges[]`, and pass it to the next gate call.

- Edit only `harness-bridge/weights-override.json` (the defaults in `lib/confidence.js` are NEVER edited).
- Use `applyWeightChange` semantics: ±15 per adjustment, floor 1, ceiling 60, renormalize to exactly 100.
- Log every change as a `weightChanges[]` event `{handoff, checkId, oldWeight, newWeight, reason, triggeringRunId, ts}` on the bridge telemetry record.
- Adjustments are for tonight's run only and are surfaced in the final report for human review.

## End of run

1. Aggregate all stage records with `assembleRunSummary(records)`; print the summary box.
2. Print `weightEvolutionReport(initialWeights, allWeightChanges)` — initial → final for both handoffs, every change with its reason.
3. If `finalStatus === 'COMPLETE'` and the draft PR landed and `npm test` is green → STOP (first success).

## Getting past a barrier

(Copy the NEVER-list "Getting past a barrier" section verbatim from harness-plan/SKILL.md.)
````

- [ ] **Step 2: `harness-run/CHANGELOG.md`**

```markdown
# harness-run changelog

## v1 — initial conductor
- Artifact-gated runbook: intake → bridgeA → plan → bridgeB → implement.
- Phase 0 worktree provisioning off origin/<base>.
- Guardrailed DRAFT PR (never merge/force-push/main).
- Weight-agency override (tonight-only) + final weight-evolution report.
```

- [ ] **Step 3: Commit**

```bash
git add harness-run/SKILL.md harness-run/CHANGELOG.md
git commit -m "harness-run: artifact-gated runbook SKILL.md + guardrails

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---
## Task 16: Run TARS-1271 end-to-end to a guardrailed DRAFT PR

**This task runs in the `webtarsthree` repo, not `skills`.** Everything above builds and tests the harness in the `skills` repo (branch `harness/e2e-orchestration`). This task exercises it.

**Files:** none created in `skills`. Output is a branch + DRAFT PR in `webtarsthree`, plus telemetry under `~/Desktop/Repos/harness-telemetry/v2/`.

**Preconditions (all must hold before starting):**
- All Tasks 1–15 committed on `skills` branch `harness/e2e-orchestration`; `npm test` green.
- `~/Desktop/Repos/webtarsthree` exists; `origin/feat/migrate-native-fetch-from-axios` is fetchable.
- `harness-bridge/weights-override.json` exists (may be `{}` — defaults).

**Guardrails (hard, verbatim):**
- DRAFT PR only. Base = `feat/migrate-native-fetch-from-axios`. NEVER merge, NEVER force-push, NEVER touch main/master. Only in webtarsthree, only for TARS-1271.
- Isolated worktree off `origin/feat/migrate-native-fetch-from-axios`; do not touch the user's dirty local branches.
- Fire harnesses as skills, never launch workflow.js directly.
- **Stop on first success** — stop once PR lands + `npm test` green + telemetry flowed.
- **$500 hard spend ceiling** (backstop; stop-on-first-success is the primary brake).
- Any NEVER-list category → stop and surface, do not self-decide.

- [ ] **Step 1: Confirm the base branch exists on origin**

```bash
git -C ~/Desktop/Repos/webtarsthree fetch origin feat/migrate-native-fetch-from-axios
git -C ~/Desktop/Repos/webtarsthree rev-parse origin/feat/migrate-native-fetch-from-axios
```
Expected: a commit SHA prints. If it errors, STOP and surface (do not fall back to master).

- [ ] **Step 2: Invoke the conductor as a skill**

```
/harness-run TARS-1271 --repo ~/Desktop/Repos/webtarsthree --base feat/migrate-native-fetch-from-axios
```

harness-run performs Phase 0 (worktree off `origin/feat/migrate-native-fetch-from-axios`), then walks the sequence. Let it run; do not investigate the repo in parallel while a child workflow is running.

- [ ] **Step 3: Honor each gate verdict**

- Handoff A PROCEED → plan runs on the gated intake manifest.
- Handoff A RE_ASK → intake re-runs with `--refine`; re-gate once; EXIT on second miss → STOP and surface.
- Handoff B PROCEED → implement runs on the gated plan.
- Handoff B RE_ASK → plan re-runs with `--refine` + manifest supremacy; re-gate once; EXIT on second miss → STOP and surface.

If any gate EXITs, stop here and present `result.flags` + `result.probeResults`; do not open a PR.

- [ ] **Step 4: Verify implement output in the worktree**

```bash
cd <worktreePath> && npm test
```
Expected: green. If red, do NOT open a non-draft PR; surface the failing tests. (A DRAFT PR with failing tests is acceptable to capture progress, clearly labeled.)

- [ ] **Step 5: Push the branch + open the DRAFT PR (guardrailed)**

```bash
git -C <worktreePath> push -u origin harness/TARS-1271-<runTs>
gh pr create --repo <origin-owner>/webtarsthree \
  --base feat/migrate-native-fetch-from-axios \
  --head harness/TARS-1271-<runTs> \
  --draft \
  --title "TARS-1271: migrate client HTTP layer (harness DRAFT)" \
  --body "$(cat <<'EOF'
Autonomous harness run (intake → bridge → plan → bridge → implement).

- Base: feat/migrate-native-fetch-from-axios (NOT master — epic work continues on the feature branch)
- Draft only; do not merge without human review.
- Telemetry: ~/Desktop/Repos/harness-telemetry/v2/
- Weight-evolution report: see run summary below.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
NEVER pass `--fill` on a non-draft, NEVER `gh pr merge`, NEVER `git push --force`.

- [ ] **Step 6: Print the final run summary + weight-evolution report**

From the aggregated stage records: `assembleRunSummary(records)` box, then `weightEvolutionReport(initialWeights, allWeightChanges)`. Confirm telemetry files exist:

```bash
ls -1 ~/Desktop/Repos/harness-telemetry/v2/webtarsthree__harness-*__TARS-1271__*.jsonl
```
Expected: intake, bridge (×up to 4), plan, implement records present.

- [ ] **Step 7: Stop-on-first-success**

If the DRAFT PR is open, `npm test` in the worktree is green, and telemetry flowed → STOP. Do not iterate further. Surface the PR URL, the summary box, and the weight report for the user's morning review.

---
