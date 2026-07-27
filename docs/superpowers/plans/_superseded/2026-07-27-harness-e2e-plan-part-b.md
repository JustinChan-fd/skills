# Part B: Weight-Override Mechanism + Weight Evolution Report

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the ability for `harness-run` to adjust confidence weights mid-run (§3.6), with guardrails: override layer (not rewrite), re-normalize to 100, ±15 max movement, 0/60 bounds, full change logging, and a final weight-evolution report.

**Architecture:** `weights-override.json` is a simple file the conductor writes; `lib/weights.js` (from Part A) already handles merging. This part adds: read/write of the override file, `weightChanges[]` event stream, bound enforcement, and a report renderer.

**Tech Stack:** Plain JS (ES modules), Node.js test runner, fs for file I/O.

**Depends on:** Part A (`harness-bridge/lib/weights.js`)

---

## File Structure

```
harness-bridge/
├── lib/
│   ├── weights.js              # (Part A — add applyOverride + validateAdjustment)
│   ├── weights.test.js         # (Part A — add new tests)
│   ├── weight-override.js      # Read/write weights-override.json + change logging
│   ├── weight-override.test.js # Tests for override mechanism
│   ├── weight-report.js        # Final weight-evolution report renderer
│   └── weight-report.test.js   # Report tests
└── weights-override.json       # Runtime override file (created at runtime, not committed)
```

---

### Task 1: Override validation + bounded adjustment (`lib/weight-override.js` + tests)

**Files:**
- Create: `harness-bridge/lib/weight-override.js`
- Create: `harness-bridge/lib/weight-override.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// harness-bridge/lib/weight-override.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateAdjustment,
  applyAdjustment,
  readOverrideFile,
  writeOverrideFile,
  buildChangeEvent,
} from './weight-override.js'
import { HANDOFF_A_WEIGHTS } from './weights.js'
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs'

const TMP_DIR = '/tmp/harness-bridge-override-test'
const TMP_FILE = `${TMP_DIR}/weights-override.json`

describe('weight-override', () => {
  describe('validateAdjustment', () => {
    test('rejects movement > ±15', () => {
      const result = validateAdjustment('grounding-evidence-fresh', 24, 50)
      assert.equal(result.valid, false)
      assert.match(result.error, /±15/)
    })

    test('rejects new weight ≤ 0', () => {
      const result = validateAdjustment('scope-grounded', 5, -1)
      assert.equal(result.valid, false)
      assert.match(result.error, /> 0/)
    })

    test('rejects new weight > 60', () => {
      const result = validateAdjustment('grounding-evidence-fresh', 24, 65)
      assert.equal(result.valid, false)
      assert.match(result.error, /≤ 60/)
    })

    test('accepts valid adjustment within bounds', () => {
      const result = validateAdjustment('grounding-evidence-fresh', 24, 30)
      assert.equal(result.valid, true)
      assert.equal(result.error, null)
    })

    test('accepts maximum allowed upward movement', () => {
      const result = validateAdjustment('grounding-evidence-fresh', 24, 39)
      assert.equal(result.valid, true)
    })

    test('accepts minimum allowed downward movement', () => {
      const result = validateAdjustment('grounding-evidence-fresh', 24, 9)
      assert.equal(result.valid, true)
    })
  })

  describe('applyAdjustment', () => {
    test('returns new overrides map with adjustment applied', () => {
      const current = {}
      const result = applyAdjustment(current, 'A', 'grounding-evidence-fresh', 30)
      assert.equal(result.A['grounding-evidence-fresh'], 30)
    })

    test('preserves existing overrides for other checks', () => {
      const current = { A: { 'files-populated': 25 } }
      const result = applyAdjustment(current, 'A', 'grounding-evidence-fresh', 30)
      assert.equal(result.A['files-populated'], 25)
      assert.equal(result.A['grounding-evidence-fresh'], 30)
    })

    test('handles Handoff B', () => {
      const current = {}
      const result = applyAdjustment(current, 'B', 'task-spec-completeness', 35)
      assert.equal(result.B['task-spec-completeness'], 35)
    })
  })

  describe('buildChangeEvent', () => {
    test('produces a structured change event', () => {
      const event = buildChangeEvent({
        handoff: 'A',
        checkId: 'grounding-evidence-fresh',
        oldWeight: 24,
        newWeight: 30,
        reason: 'grounding check too lenient on TARS-1271',
        triggeringRunId: 'TARS-1271-20260727T010000Z',
      })
      assert.equal(event.handoff, 'A')
      assert.equal(event.checkId, 'grounding-evidence-fresh')
      assert.equal(event.oldWeight, 24)
      assert.equal(event.newWeight, 30)
      assert(event.reason.includes('grounding'))
      assert.equal(event.triggeringRunId, 'TARS-1271-20260727T010000Z')
      assert(typeof event.ts === 'string')
    })
  })

  describe('readOverrideFile / writeOverrideFile', () => {
    test('returns empty object when file does not exist', () => {
      const result = readOverrideFile('/tmp/nonexistent-override.json')
      assert.deepEqual(result, {})
    })

    test('round-trips write and read', () => {
      mkdirSync(TMP_DIR, { recursive: true })
      const overrides = { A: { 'grounding-evidence-fresh': 30 }, B: {} }
      writeOverrideFile(TMP_FILE, overrides)
      const read = readOverrideFile(TMP_FILE)
      assert.deepEqual(read, overrides)
      try { unlinkSync(TMP_FILE) } catch {}
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-bridge/lib/weight-override.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```javascript
// harness-bridge/lib/weight-override.js
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_MOVEMENT = 15
const MIN_WEIGHT = 1
const MAX_WEIGHT = 60

/**
 * Validate a single weight adjustment against bounds.
 *
 * @param {string} checkId
 * @param {number} currentWeight — the default or current weight
 * @param {number} newWeight — the proposed new weight
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateAdjustment(checkId, currentWeight, newWeight) {
  const movement = Math.abs(newWeight - currentWeight)
  if (movement > MAX_MOVEMENT) {
    return { valid: false, error: `"${checkId}" moves ${movement} (max ±15)` }
  }
  if (newWeight <= 0) {
    return { valid: false, error: `"${checkId}" would be ${newWeight} (must be > 0)` }
  }
  if (newWeight > MAX_WEIGHT) {
    return { valid: false, error: `"${checkId}" would be ${newWeight} (must be ≤ 60)` }
  }
  return { valid: true, error: null }
}

/**
 * Apply a single weight adjustment to the overrides map.
 * Returns a NEW map (no mutation).
 *
 * @param {object} currentOverrides — { A?: {...}, B?: {...} }
 * @param {'A'|'B'} handoff
 * @param {string} checkId
 * @param {number} newWeight
 * @returns {object} — updated overrides map
 */
export function applyAdjustment(currentOverrides, handoff, checkId, newWeight) {
  return {
    ...currentOverrides,
    [handoff]: {
      ...(currentOverrides[handoff] || {}),
      [checkId]: newWeight,
    },
  }
}

/**
 * Build a structured change event for the weightChanges[] stream.
 *
 * @param {{ handoff, checkId, oldWeight, newWeight, reason, triggeringRunId }} params
 * @returns {object}
 */
export function buildChangeEvent({ handoff, checkId, oldWeight, newWeight, reason, triggeringRunId }) {
  return {
    handoff,
    checkId,
    oldWeight,
    newWeight,
    reason,
    triggeringRunId,
    ts: new Date().toISOString(),
  }
}

/**
 * Read weight overrides from a JSON file.
 * Returns empty object if file doesn't exist.
 *
 * @param {string} filePath
 * @returns {object}
 */
export function readOverrideFile(filePath) {
  if (!existsSync(filePath)) return {}
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Write weight overrides to a JSON file.
 *
 * @param {string} filePath
 * @param {object} overrides
 */
export function writeOverrideFile(filePath, overrides) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(overrides, null, 2), 'utf8')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test harness-bridge/lib/weight-override.test.js`
Expected: All 11 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/weight-override.js harness-bridge/lib/weight-override.test.js
git commit -m "feat(harness-bridge): weight-override validation, apply, read/write"
```

---

### Task 2: Weight evolution report (`lib/weight-report.js` + tests)

**Files:**
- Create: `harness-bridge/lib/weight-report.js`
- Create: `harness-bridge/lib/weight-report.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// harness-bridge/lib/weight-report.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderWeightReport } from './weight-report.js'
import { HANDOFF_A_WEIGHTS, HANDOFF_B_WEIGHTS } from './weights.js'

describe('weight-report', () => {
  test('renders report with no changes', () => {
    const report = renderWeightReport({
      initialWeightsA: HANDOFF_A_WEIGHTS,
      initialWeightsB: HANDOFF_B_WEIGHTS,
      finalWeightsA: HANDOFF_A_WEIGHTS,
      finalWeightsB: HANDOFF_B_WEIGHTS,
      weightChanges: [],
    })
    assert(report.includes('Weight Evolution Report'))
    assert(report.includes('No weight changes'))
  })

  test('renders report with changes showing before/after', () => {
    const finalA = { ...HANDOFF_A_WEIGHTS, 'grounding-evidence-fresh': 30, 'files-populated': 18 }
    const changes = [
      {
        handoff: 'A',
        checkId: 'grounding-evidence-fresh',
        oldWeight: 24,
        newWeight: 30,
        reason: 'too lenient on TARS-1271',
        triggeringRunId: 'TARS-1271-run1',
        ts: '2026-07-27T01:00:00Z',
      },
    ]
    const report = renderWeightReport({
      initialWeightsA: HANDOFF_A_WEIGHTS,
      initialWeightsB: HANDOFF_B_WEIGHTS,
      finalWeightsA: finalA,
      finalWeightsB: HANDOFF_B_WEIGHTS,
      weightChanges: changes,
    })
    assert(report.includes('grounding-evidence-fresh'))
    assert(report.includes('24'))
    assert(report.includes('30'))
    assert(report.includes('too lenient'))
    assert(!report.includes('No weight changes'))
  })

  test('report is valid markdown', () => {
    const report = renderWeightReport({
      initialWeightsA: HANDOFF_A_WEIGHTS,
      initialWeightsB: HANDOFF_B_WEIGHTS,
      finalWeightsA: HANDOFF_A_WEIGHTS,
      finalWeightsB: HANDOFF_B_WEIGHTS,
      weightChanges: [],
    })
    // Should start with heading
    assert(report.startsWith('#'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-bridge/lib/weight-report.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```javascript
// harness-bridge/lib/weight-report.js
import { HANDOFF_A_WEIGHTS, HANDOFF_B_WEIGHTS } from './weights.js'

/**
 * Render a human-readable weight evolution report.
 *
 * @param {{
 *   initialWeightsA: object,
 *   initialWeightsB: object,
 *   finalWeightsA: object,
 *   finalWeightsB: object,
 *   weightChanges: Array<{handoff, checkId, oldWeight, newWeight, reason, triggeringRunId, ts}>
 * }} params
 * @returns {string} — markdown report
 */
export function renderWeightReport({
  initialWeightsA,
  initialWeightsB,
  finalWeightsA,
  finalWeightsB,
  weightChanges,
}) {
  const lines = []
  lines.push('# Weight Evolution Report')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')

  // Handoff A table
  lines.push('## Handoff A — intake → plan')
  lines.push('')
  lines.push('| Check | Initial | Final | Δ |')
  lines.push('|-------|---------|-------|---|')
  for (const [id, initial] of Object.entries(initialWeightsA)) {
    const final = finalWeightsA[id] ?? initial
    const delta = final - initial
    const deltaStr = delta === 0 ? '—' : (delta > 0 ? `+${delta}` : `${delta}`)
    lines.push(`| ${id} | ${initial} | ${final} | ${deltaStr} |`)
  }
  lines.push('')

  // Handoff B table
  lines.push('## Handoff B — plan → implement')
  lines.push('')
  lines.push('| Check | Initial | Final | Δ |')
  lines.push('|-------|---------|-------|---|')
  for (const [id, initial] of Object.entries(initialWeightsB)) {
    const final = finalWeightsB[id] ?? initial
    const delta = final - initial
    const deltaStr = delta === 0 ? '—' : (delta > 0 ? `+${delta}` : `${delta}`)
    lines.push(`| ${id} | ${initial} | ${final} | ${deltaStr} |`)
  }
  lines.push('')

  // Change log
  lines.push('## Change Log')
  lines.push('')
  if (weightChanges.length === 0) {
    lines.push('No weight changes during this run.')
  } else {
    lines.push('| # | Handoff | Check | Old → New | Reason | Run ID | Time |')
    lines.push('|---|---------|-------|-----------|--------|--------|------|')
    weightChanges.forEach((c, i) => {
      lines.push(`| ${i + 1} | ${c.handoff} | ${c.checkId} | ${c.oldWeight} → ${c.newWeight} | ${c.reason} | ${c.triggeringRunId} | ${c.ts} |`)
    })
  }
  lines.push('')

  return lines.join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test harness-bridge/lib/weight-report.test.js`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/weight-report.js harness-bridge/lib/weight-report.test.js
git commit -m "feat(harness-bridge): weight evolution report renderer"
```

---

## Summary — Part B delivers:

| File | Purpose |
|------|---------|
| `harness-bridge/lib/weight-override.js` | Validate, apply, read/write override JSON, change events |
| `harness-bridge/lib/weight-report.js` | Markdown report of initial → final weights + change log |
| Tests for both | Full coverage of bounds, normalization, rendering |

**Total tasks: 2** | **Estimated time: 15–20 minutes**

**Next part:** Part C (`harness-run` conductor) uses the bridge as a child skill call and sequences the full pipeline.
