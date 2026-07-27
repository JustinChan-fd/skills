# Part A: harness-bridge — Confidence Checks + Core Gate Logic

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `harness-bridge/lib/confidence.js` — 16 pure-JS confidence checks (8 per handoff), the hole-poker agent interface, verdict/retry logic, and the gated-file writer.

**Architecture:** Each check is a pure function `(artifact) → [0,1]`. Weights per handoff sum to exactly 100 (asserted). The bridge reads an upstream artifact, runs all checks, optionally calls a Sonnet hole-poker (lower-only), then writes a stamped `-gated.json` file. Verdict: PROCEED (≥85), RE_ASK (first miss), EXIT (second miss).

**Tech Stack:** Plain JS (ES modules), Node.js test runner (`node --test`), no external deps.

---

## File Structure

```
harness-bridge/
├── SKILL.md                        # Skill wrapper (Part C wires this)
├── lib/
│   ├── confidence.js               # 16 check functions + runChecks() orchestrator
│   ├── confidence.test.js          # Unit tests per check against fixtures
│   ├── weights.js                  # Default frozen weights, load/normalize/validate
│   ├── weights.test.js             # Weight invariant tests
│   ├── verdict.js                  # score→verdict mapping, retry budget
│   ├── verdict.test.js             # Verdict logic tests
│   ├── gate-writer.js              # Read artifact, stamp, write -gated.json
│   ├── gate-writer.test.js         # File write tests
│   └── hole-poker.js              # Hole-poker prompt builder (agent call is external)
├── fixtures/
│   ├── intake-manifest-clean.json  # Passes all Handoff A checks
│   ├── intake-manifest-dirty.json  # Fails several Handoff A checks
│   ├── plan-clean.json             # Passes all Handoff B checks
│   └── plan-dirty.json             # Fails several Handoff B checks
└── workflow.js                     # (Part C — not this task)
```

---

### Task 1: Scaffold harness-bridge directory + fixtures

**Files:**
- Create: `harness-bridge/lib/` (directory)
- Create: `harness-bridge/fixtures/intake-manifest-clean.json`
- Create: `harness-bridge/fixtures/intake-manifest-dirty.json`
- Create: `harness-bridge/fixtures/plan-clean.json`
- Create: `harness-bridge/fixtures/plan-dirty.json`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p harness-bridge/lib harness-bridge/fixtures
```

- [ ] **Step 2: Write clean intake manifest fixture**

```bash
cat > harness-bridge/fixtures/intake-manifest-clean.json << 'EOF'
{
  "skill": "harness-intake",
  "sourceIssue": "TARS-1271",
  "sourceTitle": "Phase 5: Client - Migrate client HTTP layer",
  "size": "M",
  "workType": "migration",
  "migrationPattern": "axios → clientFetch",
  "scopePath": "src/client",
  "searchScope": "src/client",
  "acList": [
    {
      "bullet": "118 client files migrated to use clientFetch",
      "researchType": "grep",
      "grepPattern": "axios",
      "searchScope": "src/client",
      "shellCommand": "grep -rl 'axios' src/client | wc -l",
      "verifiedCount": 118,
      "hitSignal": true
    },
    {
      "bullet": "clientFetch wrapper exists and is importable",
      "researchType": "grep",
      "grepPattern": "clientFetch",
      "searchScope": "src/client/lib",
      "shellCommand": "grep -rl 'clientFetch' src/client/lib",
      "verifiedCount": 1,
      "hitSignal": true
    },
    {
      "bullet": "All tests pass after migration",
      "researchType": "shell",
      "grepPattern": "",
      "searchScope": "src/client",
      "shellCommand": "npm test -- --filter client",
      "verifiedCount": null,
      "hitSignal": true
    }
  ],
  "files": [
    "src/client/api/fetchMovies.ts",
    "src/client/api/fetchShowtimes.ts",
    "src/client/lib/clientFetch.ts"
  ],
  "execution": "sequential",
  "groundedReality": {
    "targetPrimitive": "clientFetch",
    "discoveredFiles": ["src/client/lib/clientFetch.ts"],
    "grepHits": { "axios": 118, "clientFetch": 3 }
  },
  "sizeCorroboration": [
    { "source": "grep-count", "magnitude": 118 },
    { "source": "ac-count", "magnitude": 3 }
  ]
}
EOF
```

- [ ] **Step 3: Write dirty intake manifest fixture**

```bash
cat > harness-bridge/fixtures/intake-manifest-dirty.json << 'EOF'
{
  "skill": "harness-intake",
  "sourceIssue": "TARS-9999",
  "sourceTitle": "Vague migration thing",
  "size": "S",
  "workType": "migration",
  "migrationPattern": "old → new",
  "scopePath": "src/somewhere",
  "searchScope": "src/somewhere",
  "acList": [
    {
      "bullet": "Do the migration",
      "researchType": "",
      "grepPattern": "",
      "searchScope": "",
      "shellCommand": "",
      "verifiedCount": null,
      "hitSignal": false
    }
  ],
  "files": [],
  "execution": "sequential",
  "groundedReality": null,
  "sizeCorroboration": []
}
EOF
```

- [ ] **Step 4: Write clean plan fixture**

```bash
cat > harness-bridge/fixtures/plan-clean.json << 'EOF'
{
  "title": "Migrate client HTTP layer",
  "size": "M",
  "execution": "sequential",
  "plans": [
    { "id": "p1", "path": "docs/manifests/p1.md", "jsonPath": "docs/manifests/p1.json", "dependsOn": [] }
  ],
  "tasks": [
    {
      "id": "t1",
      "title": "Replace axios import in fetchMovies",
      "description": "WHAT: Replace axios with clientFetch in fetchMovies.ts\nWHERE: src/client/api/fetchMovies.ts:3-15 — the import and usage site\nHOW: Replace `import axios from 'axios'` with `import { clientFetch } from '../lib/clientFetch'` and update the call site:\n```typescript\nconst response = await clientFetch('/api/movies', { method: 'GET' })\n```\nDONE: `expect(fetchMovies()).resolves.toEqual(mockMovies)` — test passes with mocked clientFetch",
      "files": ["src/client/api/fetchMovies.ts", "src/client/lib/clientFetch.ts"],
      "tddRequired": true
    },
    {
      "id": "t2",
      "title": "Replace axios import in fetchShowtimes",
      "description": "WHAT: Replace axios with clientFetch in fetchShowtimes.ts\nWHERE: src/client/api/fetchShowtimes.ts:1-10 — import line and fetch call\nHOW: Same pattern as t1:\n```typescript\nimport { clientFetch } from '../lib/clientFetch'\nconst response = await clientFetch('/api/showtimes', { method: 'GET' })\n```\nDONE: `expect(fetchShowtimes()).resolves.toEqual(mockShowtimes)`",
      "files": ["src/client/api/fetchShowtimes.ts", "src/client/lib/clientFetch.ts"],
      "tddRequired": true
    }
  ]
}
EOF
```

- [ ] **Step 5: Write dirty plan fixture**

```bash
cat > harness-bridge/fixtures/plan-dirty.json << 'EOF'
{
  "title": "Do some stuff",
  "size": "M",
  "execution": "sequential",
  "plans": [
    { "id": "p1", "path": "docs/manifests/p1.md", "jsonPath": "docs/manifests/p1.json", "dependsOn": [] }
  ],
  "tasks": [
    {
      "id": "t1",
      "title": "Fix the thing",
      "description": "WHAT: fix it\nWHERE: somewhere\nHOW: do it",
      "files": [],
      "tddRequired": true
    },
    {
      "id": "t2",
      "title": "Update tests",
      "description": "Update the tests to pass",
      "files": ["src/client/api/fetchMovies.ts", "src/client/api/fetchShowtimes.ts", "src/client/api/fetchTheaters.ts", "src/client/api/fetchUser.ts"],
      "tddRequired": false
    }
  ]
}
EOF
```

- [ ] **Step 6: Commit**

```bash
git add harness-bridge/
git commit -m "feat(harness-bridge): scaffold directory + test fixtures"
```

---

### Task 2: Default weights module (`lib/weights.js` + `lib/weights.test.js`)

**Files:**
- Create: `harness-bridge/lib/weights.js`
- Create: `harness-bridge/lib/weights.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// harness-bridge/lib/weights.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  HANDOFF_A_WEIGHTS,
  HANDOFF_B_WEIGHTS,
  validateWeights,
  loadWeights,
} from './weights.js'

describe('weights', () => {
  test('Handoff A weights sum to exactly 100', () => {
    const sum = Object.values(HANDOFF_A_WEIGHTS).reduce((a, b) => a + b, 0)
    assert.equal(sum, 100)
  })

  test('Handoff B weights sum to exactly 100', () => {
    const sum = Object.values(HANDOFF_B_WEIGHTS).reduce((a, b) => a + b, 0)
    assert.equal(sum, 100)
  })

  test('validateWeights rejects weights that do not sum to 100', () => {
    const bad = { a: 50, b: 40 }
    const result = validateWeights(bad)
    assert.equal(result.valid, false)
    assert.match(result.error, /sum/)
  })

  test('validateWeights accepts weights that sum to 100', () => {
    const good = { a: 60, b: 40 }
    const result = validateWeights(good)
    assert.equal(result.valid, true)
    assert.equal(result.error, null)
  })

  test('loadWeights returns defaults when no override file', () => {
    const result = loadWeights('A', null)
    assert.deepEqual(result, HANDOFF_A_WEIGHTS)
  })

  test('loadWeights merges override and re-normalizes', () => {
    const override = { 'grounding-evidence-fresh': 30 }
    const result = loadWeights('A', override)
    const sum = Object.values(result).reduce((a, b) => a + b, 0)
    assert.equal(sum, 100)
    // The overridden check should be clamped/adjusted
    assert(result['grounding-evidence-fresh'] <= 60)
  })

  test('no weight can be 0 or exceed 60', () => {
    for (const w of Object.values(HANDOFF_A_WEIGHTS)) {
      assert(w > 0, `weight must be > 0, got ${w}`)
      assert(w <= 60, `weight must be <= 60, got ${w}`)
    }
    for (const w of Object.values(HANDOFF_B_WEIGHTS)) {
      assert(w > 0, `weight must be > 0, got ${w}`)
      assert(w <= 60, `weight must be <= 60, got ${w}`)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-bridge/lib/weights.test.js`
Expected: FAIL — `Cannot find module './weights.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// harness-bridge/lib/weights.js

// Frozen defaults — Handoff A (intake → plan). Sum = 100.
export const HANDOFF_A_WEIGHTS = {
  'grounding-evidence-fresh':     24,
  'files-populated':              20,
  'ac-research-executable':       18,
  'size-corroboration':           12,
  'ac-referenced-files-covered':  10,
  'claim-truth-consistency':       8,
  'scope-grounded':                5,
  'size-shape-consistency':        3,
}

// Frozen defaults — Handoff B (plan → implement). Sum = 100.
export const HANDOFF_B_WEIGHTS = {
  'task-spec-completeness':       30,
  'task-files-present-bounded':   20,
  'where-resolves-to-files':      16,
  'companion-edit-closure':       12,
  'tdd-done-literal-assertion':   10,
  'manifest-dag-consistency':      6,
  'concern-atomicity':             3,
  'size-shape-consistency':        3,
}

const DEFAULTS = { A: HANDOFF_A_WEIGHTS, B: HANDOFF_B_WEIGHTS }

/**
 * Validate that a weights object sums to exactly 100 and all values are in (0, 60].
 * @param {Object<string, number>} weights
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateWeights(weights) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0)
  if (sum !== 100) return { valid: false, error: `weights sum to ${sum}, expected 100` }
  for (const [k, v] of Object.entries(weights)) {
    if (v <= 0) return { valid: false, error: `weight "${k}" is ${v}, must be > 0` }
    if (v > 60) return { valid: false, error: `weight "${k}" is ${v}, must be <= 60` }
  }
  return { valid: true, error: null }
}

/**
 * Load weights for a handoff, optionally merging overrides.
 * Overrides are clamped to ±15 from default, then re-normalized to sum=100.
 * No weight may drop to 0 or exceed 60.
 *
 * @param {'A'|'B'} handoff
 * @param {Object<string, number>|null} overrides — partial map of checkId → newWeight
 * @returns {Object<string, number>}
 */
export function loadWeights(handoff, overrides) {
  const defaults = { ...DEFAULTS[handoff] }
  if (!overrides || Object.keys(overrides).length === 0) return defaults

  const merged = { ...defaults }

  // Apply overrides with ±15 bound per adjustment
  for (const [checkId, newWeight] of Object.entries(overrides)) {
    if (!(checkId in merged)) continue
    const oldWeight = defaults[checkId]
    const clamped = Math.max(
      Math.max(oldWeight - 15, 1),
      Math.min(newWeight, Math.min(oldWeight + 15, 60))
    )
    merged[checkId] = clamped
  }

  // Re-normalize to sum=100
  const rawSum = Object.values(merged).reduce((a, b) => a + b, 0)
  if (rawSum === 0) return defaults // safety
  const scale = 100 / rawSum
  for (const k of Object.keys(merged)) {
    merged[k] = Math.round(merged[k] * scale)
  }

  // Fix rounding — adjust largest weight to hit exactly 100
  const finalSum = Object.values(merged).reduce((a, b) => a + b, 0)
  if (finalSum !== 100) {
    const largest = Object.entries(merged).sort((a, b) => b[1] - a[1])[0][0]
    merged[largest] += (100 - finalSum)
  }

  // Final clamp pass
  for (const [k, v] of Object.entries(merged)) {
    if (v <= 0) merged[k] = 1
    if (v > 60) merged[k] = 60
  }

  return merged
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test harness-bridge/lib/weights.test.js`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/weights.js harness-bridge/lib/weights.test.js
git commit -m "feat(harness-bridge): frozen weights + load/validate/normalize"
```

---

### Task 3: Handoff A confidence checks (`lib/confidence.js` — first 4 checks)

**Files:**
- Create: `harness-bridge/lib/confidence.js`
- Create: `harness-bridge/lib/confidence.test.js`

- [ ] **Step 1: Write the failing tests for checks 1–4**

```javascript
// harness-bridge/lib/confidence.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  groundingEvidenceFresh,
  filesPopulated,
  acResearchExecutable,
  sizeCorroboration,
} from './confidence.js'
import cleanManifest from '../fixtures/intake-manifest-clean.json' with { type: 'json' }
import dirtyManifest from '../fixtures/intake-manifest-dirty.json' with { type: 'json' }

describe('Handoff A checks', () => {
  describe('grounding-evidence-fresh (wt: 24)', () => {
    test('returns 1.0 for clean manifest with target primitive in discoveredFiles + hitSignal', () => {
      const score = groundingEvidenceFresh(cleanManifest)
      assert.equal(score, 1.0)
    })

    test('returns 0 for dirty manifest with no grounded evidence', () => {
      const score = groundingEvidenceFresh(dirtyManifest)
      assert.equal(score, 0)
    })

    test('returns value in [0,1]', () => {
      const score = groundingEvidenceFresh(cleanManifest)
      assert(score >= 0 && score <= 1)
    })
  })

  describe('files-populated (wt: 20)', () => {
    test('returns 1.0 when files array is non-empty', () => {
      const score = filesPopulated(cleanManifest)
      assert.equal(score, 1.0)
    })

    test('returns 0 when files array is empty', () => {
      const score = filesPopulated(dirtyManifest)
      assert.equal(score, 0)
    })
  })

  describe('ac-research-executable (wt: 18)', () => {
    test('returns 1.0 when all ACs have valid researchType + directive', () => {
      const score = acResearchExecutable(cleanManifest)
      assert.equal(score, 1.0)
    })

    test('returns 0 when ACs have no researchType', () => {
      const score = acResearchExecutable(dirtyManifest)
      assert.equal(score, 0)
    })
  })

  describe('size-corroboration (wt: 12)', () => {
    test('returns 1.0 when ≥2 independent magnitude sources', () => {
      const score = sizeCorroboration(cleanManifest)
      assert.equal(score, 1.0)
    })

    test('returns 0 when no corroboration sources', () => {
      const score = sizeCorroboration(dirtyManifest)
      assert.equal(score, 0)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-bridge/lib/confidence.test.js`
Expected: FAIL — `Cannot find module './confidence.js'`

- [ ] **Step 3: Write the first 4 check implementations**

```javascript
// harness-bridge/lib/confidence.js

/**
 * Confidence checks for harness-bridge.
 * Each check is a pure function: (artifact) → number in [0, 1].
 * No check calls an LLM. No side effects. No file I/O.
 */

// ─── Handoff A checks (intake → plan) ──────────────────────────────────────

/**
 * grounding-evidence-fresh (wt: 24)
 * Target primitive (token after → in migrationPattern) appears in discoveredFiles/grep hits,
 * AND research-typed ACs carry a positive hitSignal.
 */
export function groundingEvidenceFresh(manifest) {
  const { migrationPattern, groundedReality, acList } = manifest

  // Extract target primitive — token after "→" in migrationPattern
  const target = (migrationPattern || '').split('→').pop()?.trim()
  if (!target) return 0

  // Check 1: target appears in discoveredFiles or grepHits
  const inDiscovered = (groundedReality?.discoveredFiles || [])
    .some(f => f.toLowerCase().includes(target.toLowerCase()))
  const inGrepHits = groundedReality?.grepHits
    ? Object.keys(groundedReality.grepHits).some(k => k.toLowerCase().includes(target.toLowerCase()))
    : false
  const targetPresent = inDiscovered || inGrepHits

  // Check 2: research-typed ACs with hitSignal
  const researchAcs = (acList || []).filter(ac => ac.researchType && ac.researchType.length > 0)
  const hitsWithSignal = researchAcs.filter(ac => ac.hitSignal === true)
  const hitFraction = researchAcs.length > 0 ? hitsWithSignal.length / researchAcs.length : 0

  if (!targetPresent) return 0
  return hitFraction
}

/**
 * files-populated (wt: 20)
 * Fraction of work units with non-empty files[].
 * For a single-unit manifest, this is binary: 1 if files.length > 0, else 0.
 */
export function filesPopulated(manifest) {
  const files = manifest.files || []
  return files.length > 0 ? 1.0 : 0
}

/**
 * ac-research-executable (wt: 18)
 * Fraction of acList entries with a valid researchType AND a matching non-trivial directive.
 * A "non-trivial directive" means: grepPattern or shellCommand is non-empty string (length > 0).
 */
export function acResearchExecutable(manifest) {
  const acList = manifest.acList || []
  if (acList.length === 0) return 0

  const VALID_TYPES = ['grep', 'shell', 'read', 'search']
  const executable = acList.filter(ac => {
    const hasValidType = VALID_TYPES.includes(ac.researchType)
    const hasDirective = (ac.grepPattern && ac.grepPattern.length > 0) ||
                         (ac.shellCommand && ac.shellCommand.length > 0)
    return hasValidType && hasDirective
  })

  return executable.length / acList.length
}

/**
 * size-corroboration (wt: 12)
 * ≥2 independent magnitude sources AND declared size agrees with files+AC proxy.
 * Returns 1.0 if corroborated, 0 otherwise.
 */
export function sizeCorroboration(manifest) {
  const sources = manifest.sizeCorroboration || []
  if (sources.length < 2) return 0

  // Check that sources are independent (different `source` values)
  const uniqueSources = new Set(sources.map(s => s.source))
  if (uniqueSources.size < 2) return 0

  return 1.0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test harness-bridge/lib/confidence.test.js`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/confidence.js harness-bridge/lib/confidence.test.js
git commit -m "feat(harness-bridge): Handoff A checks 1-4 (grounding, files, ac-research, size-corroboration)"
```

---

### Task 4: Handoff A confidence checks — remaining 4

**Files:**
- Modify: `harness-bridge/lib/confidence.js`
- Modify: `harness-bridge/lib/confidence.test.js`

- [ ] **Step 1: Append failing tests for checks 5–8**

Add to `confidence.test.js`:

```javascript
import {
  groundingEvidenceFresh,
  filesPopulated,
  acResearchExecutable,
  sizeCorroboration,
  acReferencedFilesCovered,
  claimTruthConsistency,
  scopeGrounded,
  sizeShapeConsistencyA,
} from './confidence.js'

// ... existing tests ...

describe('Handoff A checks (continued)', () => {
  describe('ac-referenced-files-covered (wt: 10)', () => {
    test('returns 1.0 when AC file paths resolve into files[]', () => {
      const manifest = {
        ...cleanManifest,
        acList: [
          { ...cleanManifest.acList[0], searchScope: 'src/client' }
        ],
        files: ['src/client/api/fetchMovies.ts']
      }
      const score = acReferencedFilesCovered(manifest)
      assert.equal(score, 1.0)
    })

    test('returns 0 when files[] is empty', () => {
      const score = acReferencedFilesCovered(dirtyManifest)
      assert.equal(score, 0)
    })
  })

  describe('claim-truth-consistency (wt: 8)', () => {
    test('returns 1.0 when verified counts match within 20%', () => {
      const manifest = {
        ...cleanManifest,
        acList: [
          { bullet: '118 files', verifiedCount: 118, grepPattern: 'axios', hitSignal: true, researchType: 'grep', searchScope: 'src/client', shellCommand: '' }
        ],
        groundedReality: { ...cleanManifest.groundedReality, grepHits: { axios: 115 } }
      }
      const score = claimTruthConsistency(manifest)
      assert(score >= 0.8, `expected >= 0.8, got ${score}`)
    })

    test('returns 0 when no verified ACs exist', () => {
      const score = claimTruthConsistency(dirtyManifest)
      assert.equal(score, 0)
    })
  })

  describe('scope-grounded (wt: 5)', () => {
    test('returns 1.0 when scopePath prefix matches a discovered file', () => {
      const score = scopeGrounded(cleanManifest)
      assert.equal(score, 1.0)
    })

    test('returns 0 when no files match scopePath', () => {
      const score = scopeGrounded(dirtyManifest)
      assert.equal(score, 0)
    })
  })

  describe('size-shape-consistency (wt: 3)', () => {
    test('returns 1.0 for non-L size with no groups', () => {
      const score = sizeShapeConsistencyA(cleanManifest)
      assert.equal(score, 1.0)
    })

    test('returns 0 for L size with no groups', () => {
      const manifest = { ...cleanManifest, size: 'L', groups: undefined }
      const score = sizeShapeConsistencyA(manifest)
      assert.equal(score, 0)
    })

    test('returns 1.0 for L size with non-empty groups', () => {
      const manifest = { ...cleanManifest, size: 'L', groups: [{ subtasks: [] }] }
      const score = sizeShapeConsistencyA(manifest)
      assert.equal(score, 1.0)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-bridge/lib/confidence.test.js`
Expected: FAIL — functions not exported

- [ ] **Step 3: Append implementations to confidence.js**

Add to `harness-bridge/lib/confidence.js`:

```javascript
/**
 * ac-referenced-files-covered (wt: 10)
 * Code-file paths named in an AC's searchScope resolve into the union of files[].
 * Returns fraction of ACs whose searchScope is a prefix of at least one file in files[].
 */
export function acReferencedFilesCovered(manifest) {
  const files = manifest.files || []
  const acList = manifest.acList || []
  if (files.length === 0 || acList.length === 0) return 0

  const covered = acList.filter(ac => {
    const scope = ac.searchScope || ''
    if (!scope) return true // no scope claim = vacuously covered
    return files.some(f => f.startsWith(scope))
  })

  return covered.length / acList.length
}

/**
 * claim-truth-consistency (wt: 8)
 * Fraction of verified ACs whose grep count is within 20% of ticket-claimed count.
 * Only considers ACs with both verifiedCount and a matching grepHits entry.
 */
export function claimTruthConsistency(manifest) {
  const acList = manifest.acList || []
  const grepHits = manifest.groundedReality?.grepHits || {}

  const verifiable = acList.filter(ac =>
    ac.verifiedCount != null && ac.grepPattern && grepHits[ac.grepPattern] != null
  )
  if (verifiable.length === 0) return 0

  const consistent = verifiable.filter(ac => {
    const claimed = ac.verifiedCount
    const actual = grepHits[ac.grepPattern]
    if (claimed === 0) return actual === 0
    const ratio = Math.abs(actual - claimed) / claimed
    return ratio <= 0.2
  })

  return consistent.length / verifiable.length
}

/**
 * scope-grounded (wt: 5)
 * scopePath/searchScope prefixes at least one discovered file in groundedReality or files[].
 */
export function scopeGrounded(manifest) {
  const scopePath = manifest.scopePath || manifest.searchScope || ''
  if (!scopePath) return 0

  const discoveredFiles = manifest.groundedReality?.discoveredFiles || []
  const files = manifest.files || []
  const allFiles = [...discoveredFiles, ...files]

  if (allFiles.length === 0) return 0
  const hasMatch = allFiles.some(f => f.startsWith(scopePath))
  return hasMatch ? 1.0 : 0
}

/**
 * size-shape-consistency (wt: 3) — Handoff A variant
 * size ∈ {XS,S,M,L} and L ⇔ non-empty groups[].
 */
export function sizeShapeConsistencyA(manifest) {
  const size = manifest.size
  const VALID_SIZES = ['XS', 'S', 'M', 'L']
  if (!VALID_SIZES.includes(size)) return 0

  const hasGroups = Array.isArray(manifest.groups) && manifest.groups.length > 0
  if (size === 'L' && !hasGroups) return 0
  if (size !== 'L' && hasGroups) return 0 // non-L shouldn't have groups

  return 1.0
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test harness-bridge/lib/confidence.test.js`
Expected: All 16 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/confidence.js harness-bridge/lib/confidence.test.js
git commit -m "feat(harness-bridge): Handoff A checks 5-8 (ac-files, truth, scope, shape)"
```

---

### Task 5: Handoff B confidence checks (all 8)

**Files:**
- Modify: `harness-bridge/lib/confidence.js`
- Modify: `harness-bridge/lib/confidence.test.js`

- [ ] **Step 1: Write failing tests for Handoff B checks**

Append to `confidence.test.js`:

```javascript
import {
  // ... existing Handoff A imports ...
  taskSpecCompleteness,
  taskFilesPresentBounded,
  whereResolvesToFiles,
  companionEditClosure,
  tddDoneLiteralAssertion,
  manifestDagConsistency,
  concernAtomicity,
  sizeShapeConsistencyB,
} from './confidence.js'
import cleanPlan from '../fixtures/plan-clean.json' with { type: 'json' }
import dirtyPlan from '../fixtures/plan-dirty.json' with { type: 'json' }

describe('Handoff B checks', () => {
  describe('task-spec-completeness (wt: 30)', () => {
    test('returns 1.0 when all tasks have WHAT+WHERE+HOW+DONE + snippet, WHERE/HOW ≥20 chars', () => {
      const score = taskSpecCompleteness(cleanPlan)
      assert.equal(score, 1.0)
    })

    test('returns < 1.0 when tasks have thin descriptions', () => {
      const score = taskSpecCompleteness(dirtyPlan)
      assert(score < 1.0, `expected < 1.0, got ${score}`)
    })
  })

  describe('task-files-present-bounded (wt: 20)', () => {
    test('returns 1.0 for tasks with 1-3 files', () => {
      const score = taskFilesPresentBounded(cleanPlan)
      assert.equal(score, 1.0)
    })

    test('returns 0 for tasks with empty files', () => {
      const plan = { ...dirtyPlan, tasks: [dirtyPlan.tasks[0]] }
      const score = taskFilesPresentBounded(plan)
      assert.equal(score, 0)
    })

    test('decays above 3 files', () => {
      const score = taskFilesPresentBounded(dirtyPlan)
      // t1 has 0 files (0), t2 has 4 files (decayed) — average < 1.0
      assert(score < 1.0)
    })
  })

  describe('where-resolves-to-files (wt: 16)', () => {
    test('returns 1.0 when WHERE has file:line anchor in files[]', () => {
      const score = whereResolvesToFiles(cleanPlan)
      assert.equal(score, 1.0)
    })

    test('returns 0 when WHERE has no file anchor', () => {
      const score = whereResolvesToFiles(dirtyPlan)
      assert.equal(score, 0)
    })
  })

  describe('companion-edit-closure (wt: 12)', () => {
    test('returns 1.0 when import refs in HOW/DONE are covered by files[]', () => {
      const score = companionEditClosure(cleanPlan)
      assert.equal(score, 1.0)
    })

    test('returns value in [0,1]', () => {
      const score = companionEditClosure(dirtyPlan)
      assert(score >= 0 && score <= 1)
    })
  })

  describe('tdd-done-literal-assertion (wt: 10)', () => {
    test('returns 1.0 when tddRequired tasks have assertions in DONE', () => {
      const score = tddDoneLiteralAssertion(cleanPlan)
      assert.equal(score, 1.0)
    })

    test('returns 0 when tddRequired tasks lack assertions', () => {
      const score = tddDoneLiteralAssertion(dirtyPlan)
      assert.equal(score, 0)
    })
  })

  describe('manifest-dag-consistency (wt: 6)', () => {
    test('returns 1.0 when dependsOn is resolvable and non-self', () => {
      const score = manifestDagConsistency(cleanPlan)
      assert.equal(score, 1.0)
    })

    test('returns 0 for self-referencing dependency', () => {
      const plan = { ...cleanPlan, plans: [{ id: 'p1', dependsOn: ['p1'] }] }
      const score = manifestDagConsistency(plan)
      assert.equal(score, 0)
    })
  })

  describe('concern-atomicity (wt: 3)', () => {
    test('returns 1.0 for tasks with single DONE clause', () => {
      const score = concernAtomicity(cleanPlan)
      assert.equal(score, 1.0)
    })

    test('returns < 1.0 for tasks with and-chained DONE', () => {
      const plan = {
        ...cleanPlan,
        tasks: [{
          ...cleanPlan.tasks[0],
          description: 'WHAT: x\nWHERE: y\nHOW: z\nDONE: test passes and coverage is 100% and lint passes'
        }]
      }
      const score = concernAtomicity(plan)
      assert(score < 1.0)
    })
  })

  describe('size-shape-consistency B (wt: 3)', () => {
    test('returns 1.0 for valid size', () => {
      const score = sizeShapeConsistencyB(cleanPlan)
      assert.equal(score, 1.0)
    })

    test('returns 0 for invalid size', () => {
      const plan = { ...cleanPlan, size: 'HUGE' }
      const score = sizeShapeConsistencyB(plan)
      assert.equal(score, 0)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-bridge/lib/confidence.test.js`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement all 8 Handoff B checks**

Append to `harness-bridge/lib/confidence.js`:

```javascript
// ─── Handoff B checks (plan → implement) ───────────────────────────────────

/**
 * task-spec-completeness (wt: 30)
 * Fraction of tasks with WHAT+WHERE+HOW+DONE and a fenced snippet,
 * WHERE/HOW ≥20 chars. Mirrors harness-plan's NEEDS_CONTEXT predictor.
 */
export function taskSpecCompleteness(plan) {
  const tasks = plan.tasks || []
  if (tasks.length === 0) return 0

  const complete = tasks.filter(t => {
    const d = t.description || ''
    const hasWhat = /what/i.test(d)
    const hasWhere = /where/i.test(d)
    const hasHow = /how/i.test(d)
    const hasDone = /done/i.test(d)
    const hasSnippet = /```/.test(d)

    const whereMatch = d.match(/where[:\s]+(.+?)(?=\n(?:what|how|done)|$)/is)
    const howMatch = d.match(/how[:\s]+(.+?)(?=\n(?:what|where|done)|$)/is)
    const whereLen = (whereMatch?.[1] || '').trim().length
    const howLen = (howMatch?.[1] || '').trim().length

    return hasWhat && hasWhere && hasHow && hasDone && hasSnippet && whereLen >= 20 && howLen >= 20
  })

  return complete.length / tasks.length
}

/**
 * task-files-present-bounded (wt: 20)
 * 0 if empty; 1.0 for 1–3 files; decays above 3.
 * Returns average score across all tasks.
 */
export function taskFilesPresentBounded(plan) {
  const tasks = plan.tasks || []
  if (tasks.length === 0) return 0

  const scores = tasks.map(t => {
    const count = (t.files || []).length
    if (count === 0) return 0
    if (count <= 3) return 1.0
    // Decay: 1.0 at 3, approaches 0.5 at 10+
    return Math.max(0.5, 1.0 - (count - 3) * 0.1)
  })

  return scores.reduce((a, b) => a + b, 0) / scores.length
}

/**
 * where-resolves-to-files (wt: 16)
 * WHERE has a file:line anchor AND that path is in the task's files[].
 */
export function whereResolvesToFiles(plan) {
  const tasks = plan.tasks || []
  if (tasks.length === 0) return 0

  const FILE_LINE_RE = /(\S+\.[a-z]{1,4}):(\d+)/

  const resolved = tasks.filter(t => {
    const d = t.description || ''
    const whereSection = d.match(/where[:\s]+(.+?)(?=\n(?:what|how|done)|$)/is)
    const whereText = whereSection?.[1] || ''
    const fileMatch = whereText.match(FILE_LINE_RE)
    if (!fileMatch) return false
    const filePath = fileMatch[1]
    return (t.files || []).some(f => f.includes(filePath) || filePath.includes(f))
  })

  return resolved.length / tasks.length
}

/**
 * companion-edit-closure (wt: 12)
 * Import/path refs in HOW/DONE are covered by the union of files[].
 * Looks for import-style path references and checks they appear in files[].
 */
export function companionEditClosure(plan) {
  const tasks = plan.tasks || []
  if (tasks.length === 0) return 0

  const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g
  const allFiles = new Set(tasks.flatMap(t => t.files || []))

  const closed = tasks.filter(t => {
    const d = t.description || ''
    const imports = [...d.matchAll(IMPORT_RE)].map(m => m[1])
    if (imports.length === 0) return true // no imports = vacuously closed

    // Resolve relative imports against the task's files
    const taskDir = (t.files || [])[0]?.split('/').slice(0, -1).join('/') || ''
    const unresolved = imports.filter(imp => {
      if (imp.startsWith('.')) {
        // Relative import — resolve against taskDir
        const resolved = `${taskDir}/${imp.replace(/^\.\//, '')}`.replace(/\/\//g, '/')
        return !allFiles.has(resolved) && !allFiles.has(resolved + '.ts') && !allFiles.has(resolved + '.js')
      }
      // Absolute-ish path — check if any file contains it
      return ![...allFiles].some(f => f.includes(imp))
    })
    return unresolved.length === 0
  })

  return closed.length / tasks.length
}

/**
 * tdd-done-literal-assertion (wt: 10)
 * Among tddRequired tasks, fraction whose DONE has a literal assertion.
 * Vacuously 1 if no tasks have tddRequired.
 */
export function tddDoneLiteralAssertion(plan) {
  const tasks = plan.tasks || []
  const tddTasks = tasks.filter(t => t.tddRequired)
  if (tddTasks.length === 0) return 1.0 // vacuously true

  const ASSERT_RE = /(?:assert|expect|should|toBe|toEqual|toMatch|toThrow|rejects|resolves)/i

  const withAssertion = tddTasks.filter(t => {
    const d = t.description || ''
    const doneMatch = d.match(/done[:\s]+(.+?)$/is)
    const doneText = doneMatch?.[1] || ''
    return ASSERT_RE.test(doneText)
  })

  return withAssertion.length / tddTasks.length
}

/**
 * manifest-dag-consistency (wt: 6)
 * plans[].dependsOn resolvable + non-self; execution matches wiring.
 */
export function manifestDagConsistency(plan) {
  const plans = plan.plans || []
  if (plans.length === 0) return 1.0 // vacuously consistent

  const ids = new Set(plans.map(p => p.id))

  for (const p of plans) {
    const deps = p.dependsOn || []
    for (const dep of deps) {
      if (dep === p.id) return 0 // self-reference
      if (!ids.has(dep)) return 0 // unresolvable
    }
  }

  return 1.0
}

/**
 * concern-atomicity (wt: 3)
 * ≤1 DONE / no and-chained clauses per task.
 */
export function concernAtomicity(plan) {
  const tasks = plan.tasks || []
  if (tasks.length === 0) return 1.0

  const atomic = tasks.filter(t => {
    const d = t.description || ''
    const doneMatch = d.match(/done[:\s]+(.+?)$/is)
    const doneText = doneMatch?.[1] || ''
    // Count "and" conjunctions as non-atomic signals
    const andCount = (doneText.match(/\band\b/gi) || []).length
    return andCount <= 1
  })

  return atomic.length / tasks.length
}

/**
 * size-shape-consistency (wt: 3) — Handoff B variant
 * size ∈ {XS,S,M,L}.
 */
export function sizeShapeConsistencyB(plan) {
  const VALID_SIZES = ['XS', 'S', 'M', 'L']
  return VALID_SIZES.includes(plan.size) ? 1.0 : 0
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test harness-bridge/lib/confidence.test.js`
Expected: All 24 tests PASS (8 Handoff A + 16 Handoff B)

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/confidence.js harness-bridge/lib/confidence.test.js
git commit -m "feat(harness-bridge): all 8 Handoff B confidence checks"
```

---

### Task 6: runChecks orchestrator + score computation

**Files:**
- Modify: `harness-bridge/lib/confidence.js`
- Modify: `harness-bridge/lib/confidence.test.js`

- [ ] **Step 1: Write failing test for runChecks**

Append to `confidence.test.js`:

```javascript
import { runChecks } from './confidence.js'

describe('runChecks orchestrator', () => {
  test('Handoff A clean manifest scores ≥ 85', () => {
    const result = runChecks('A', cleanManifest)
    assert(result.score >= 85, `expected ≥ 85, got ${result.score}`)
    assert(Array.isArray(result.checks))
    assert.equal(result.checks.length, 8)
  })

  test('Handoff A dirty manifest scores < 85', () => {
    const result = runChecks('A', dirtyManifest)
    assert(result.score < 85, `expected < 85, got ${result.score}`)
  })

  test('Handoff B clean plan scores ≥ 85', () => {
    const result = runChecks('B', cleanPlan)
    assert(result.score >= 85, `expected ≥ 85, got ${result.score}`)
  })

  test('Handoff B dirty plan scores < 85', () => {
    const result = runChecks('B', dirtyPlan)
    assert(result.score < 85, `expected < 85, got ${result.score}`)
  })

  test('each check result includes id, weight, rawScore, weightedScore', () => {
    const result = runChecks('A', cleanManifest)
    for (const c of result.checks) {
      assert(typeof c.id === 'string')
      assert(typeof c.weight === 'number')
      assert(typeof c.rawScore === 'number')
      assert(typeof c.weightedScore === 'number')
      assert(c.rawScore >= 0 && c.rawScore <= 1)
    }
  })

  test('throws on unknown handoff', () => {
    assert.throws(() => runChecks('C', {}), /unknown handoff/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-bridge/lib/confidence.test.js`
Expected: FAIL — `runChecks` not exported

- [ ] **Step 3: Implement runChecks**

Append to `harness-bridge/lib/confidence.js`:

```javascript
// ─── Orchestrator ────────────────────────────────────────────────────────────

import { HANDOFF_A_WEIGHTS, HANDOFF_B_WEIGHTS, loadWeights } from './weights.js'

const HANDOFF_A_CHECKS = {
  'grounding-evidence-fresh':    groundingEvidenceFresh,
  'files-populated':             filesPopulated,
  'ac-research-executable':      acResearchExecutable,
  'size-corroboration':          sizeCorroboration,
  'ac-referenced-files-covered': acReferencedFilesCovered,
  'claim-truth-consistency':     claimTruthConsistency,
  'scope-grounded':              scopeGrounded,
  'size-shape-consistency':      sizeShapeConsistencyA,
}

const HANDOFF_B_CHECKS = {
  'task-spec-completeness':      taskSpecCompleteness,
  'task-files-present-bounded':  taskFilesPresentBounded,
  'where-resolves-to-files':     whereResolvesToFiles,
  'companion-edit-closure':      companionEditClosure,
  'tdd-done-literal-assertion':  tddDoneLiteralAssertion,
  'manifest-dag-consistency':    manifestDagConsistency,
  'concern-atomicity':           concernAtomicity,
  'size-shape-consistency':      sizeShapeConsistencyB,
}

/**
 * Run all checks for a handoff and compute the weighted score.
 *
 * @param {'A'|'B'} handoff
 * @param {object} artifact — the intake manifest (A) or plan JSON (B)
 * @param {object|null} weightOverrides — optional weight overrides
 * @returns {{ score: number, checks: Array<{id, weight, rawScore, weightedScore}> }}
 */
export function runChecks(handoff, artifact, weightOverrides = null) {
  const checksMap = handoff === 'A' ? HANDOFF_A_CHECKS
                  : handoff === 'B' ? HANDOFF_B_CHECKS
                  : null
  if (!checksMap) throw new Error(`runChecks: unknown handoff "${handoff}"`)

  const weights = loadWeights(handoff, weightOverrides)

  const checks = Object.entries(checksMap).map(([id, fn]) => {
    const rawScore = fn(artifact)
    const weight = weights[id] || 0
    const weightedScore = rawScore * weight
    return { id, weight, rawScore, weightedScore }
  })

  const score = checks.reduce((sum, c) => sum + c.weightedScore, 0)

  return { score: Math.round(score * 100) / 100, checks }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test harness-bridge/lib/confidence.test.js`
Expected: All 30 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/confidence.js harness-bridge/lib/confidence.test.js
git commit -m "feat(harness-bridge): runChecks orchestrator with weighted scoring"
```

---

### Task 7: Verdict logic (`lib/verdict.js` + tests)

**Files:**
- Create: `harness-bridge/lib/verdict.js`
- Create: `harness-bridge/lib/verdict.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// harness-bridge/lib/verdict.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeVerdict, THRESHOLD } from './verdict.js'

describe('verdict', () => {
  test('THRESHOLD is 85', () => {
    assert.equal(THRESHOLD, 85)
  })

  test('score >= 85 with retries=0 → PROCEED', () => {
    const v = computeVerdict(90, 0)
    assert.equal(v.verdict, 'PROCEED')
  })

  test('score >= 85 with retries=1 → PROCEED', () => {
    const v = computeVerdict(87, 1)
    assert.equal(v.verdict, 'PROCEED')
  })

  test('score < 85 with retries=0 → RE_ASK', () => {
    const v = computeVerdict(70, 0)
    assert.equal(v.verdict, 'RE_ASK')
  })

  test('score < 85 with retries=1 → EXIT', () => {
    const v = computeVerdict(70, 1)
    assert.equal(v.verdict, 'EXIT')
  })

  test('result includes score and retries', () => {
    const v = computeVerdict(42, 0)
    assert.equal(v.score, 42)
    assert.equal(v.retries, 0)
  })

  test('score exactly 85 → PROCEED', () => {
    const v = computeVerdict(85, 0)
    assert.equal(v.verdict, 'PROCEED')
  })

  test('score 84.99 → RE_ASK (first attempt)', () => {
    const v = computeVerdict(84.99, 0)
    assert.equal(v.verdict, 'RE_ASK')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-bridge/lib/verdict.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```javascript
// harness-bridge/lib/verdict.js

export const THRESHOLD = 85
export const MAX_RETRIES = 1

/**
 * Compute verdict from confidence score and retry count.
 *
 * @param {number} score — confidence score (0–100)
 * @param {number} retries — how many retries have been attempted for this handoff
 * @returns {{ verdict: 'PROCEED'|'RE_ASK'|'EXIT', score: number, retries: number }}
 */
export function computeVerdict(score, retries) {
  let verdict
  if (score >= THRESHOLD) {
    verdict = 'PROCEED'
  } else if (retries < MAX_RETRIES) {
    verdict = 'RE_ASK'
  } else {
    verdict = 'EXIT'
  }

  return { verdict, score, retries }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test harness-bridge/lib/verdict.test.js`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/verdict.js harness-bridge/lib/verdict.test.js
git commit -m "feat(harness-bridge): verdict logic (PROCEED/RE_ASK/EXIT)"
```

---

### Task 8: Gate writer (`lib/gate-writer.js` + tests)

**Files:**
- Create: `harness-bridge/lib/gate-writer.js`
- Create: `harness-bridge/lib/gate-writer.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// harness-bridge/lib/gate-writer.test.js
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeGatedArtifact, buildGatedPath } from './gate-writer.js'
import { readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TMP_DIR = '/tmp/harness-bridge-test'

describe('gate-writer', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true })
  })

  afterEach(() => {
    // cleanup
    try { unlinkSync(join(TMP_DIR, 'intake-manifest-gated.json')) } catch {}
    try { unlinkSync(join(TMP_DIR, 'plan-p1-gated.json')) } catch {}
  })

  describe('buildGatedPath', () => {
    test('appends -gated before .json extension', () => {
      const result = buildGatedPath('/some/path/intake-manifest.json')
      assert.equal(result, '/some/path/intake-manifest-gated.json')
    })

    test('handles plan paths', () => {
      const result = buildGatedPath('/some/path/2026-07-27-tars-1271-p1.json')
      assert.equal(result, '/some/path/2026-07-27-tars-1271-p1-gated.json')
    })
  })

  describe('writeGatedArtifact', () => {
    test('writes stamped artifact with gated fields', () => {
      const artifact = { skill: 'harness-intake', size: 'M' }
      const gateResult = {
        score: 92,
        verdict: 'PROCEED',
        flags: [],
        probeResults: [],
        checks: [{ id: 'test', weight: 100, rawScore: 0.92, weightedScore: 92 }],
      }
      const outPath = join(TMP_DIR, 'intake-manifest-gated.json')

      writeGatedArtifact(artifact, gateResult, outPath)

      assert(existsSync(outPath))
      const written = JSON.parse(readFileSync(outPath, 'utf8'))
      assert.equal(written.gated, true)
      assert.equal(written.confidence, 92)
      assert.equal(written.verdict, 'PROCEED')
      assert.deepEqual(written.flags, [])
      assert.deepEqual(written.probeResults, [])
      // Original fields preserved
      assert.equal(written.skill, 'harness-intake')
      assert.equal(written.size, 'M')
    })

    test('never mutates the original artifact object', () => {
      const artifact = { skill: 'harness-intake', size: 'S' }
      const original = { ...artifact }
      const gateResult = { score: 90, verdict: 'PROCEED', flags: [], probeResults: [], checks: [] }
      const outPath = join(TMP_DIR, 'intake-manifest-gated.json')

      writeGatedArtifact(artifact, gateResult, outPath)

      assert.deepEqual(artifact, original)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-bridge/lib/gate-writer.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```javascript
// harness-bridge/lib/gate-writer.js
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Build the gated artifact path from the source path.
 * Inserts "-gated" before the .json extension.
 *
 * @param {string} sourcePath — path to the original artifact
 * @returns {string} — path for the gated version
 */
export function buildGatedPath(sourcePath) {
  return sourcePath.replace(/\.json$/, '-gated.json')
}

/**
 * Write a stamped gated artifact to disk.
 * The original artifact is never mutated — a new object is written.
 *
 * @param {object} artifact — the original upstream artifact
 * @param {object} gateResult — { score, verdict, flags, probeResults, checks }
 * @param {string} outPath — where to write the gated file
 */
export function writeGatedArtifact(artifact, gateResult, outPath) {
  const stamped = {
    ...artifact,
    gated: true,
    confidence: gateResult.score,
    verdict: gateResult.verdict,
    flags: gateResult.flags || [],
    probeResults: gateResult.probeResults || [],
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(stamped, null, 2), 'utf8')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test harness-bridge/lib/gate-writer.test.js`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/gate-writer.js harness-bridge/lib/gate-writer.test.js
git commit -m "feat(harness-bridge): gate writer — stamps and writes -gated.json"
```

---

### Task 9: Hole-poker prompt builder (`lib/hole-poker.js`)

**Files:**
- Create: `harness-bridge/lib/hole-poker.js`
- Create: `harness-bridge/lib/hole-poker.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// harness-bridge/lib/hole-poker.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildHolePokerPrompt, applyHolePokerResult } from './hole-poker.js'

describe('hole-poker', () => {
  describe('buildHolePokerPrompt', () => {
    test('includes the checks that scored 1.0 (suspiciously clean)', () => {
      const checks = [
        { id: 'grounding-evidence-fresh', weight: 24, rawScore: 1.0, weightedScore: 24 },
        { id: 'files-populated', weight: 20, rawScore: 0.5, weightedScore: 10 },
        { id: 'scope-grounded', weight: 5, rawScore: 1.0, weightedScore: 5 },
      ]
      const prompt = buildHolePokerPrompt(checks, { scopePath: 'src/client' })
      assert(prompt.includes('grounding-evidence-fresh'))
      assert(prompt.includes('scope-grounded'))
      // Does not include partial-score checks
      assert(!prompt.includes('files-populated'))
    })

    test('only targets high-weight checks (weight > 5)', () => {
      const checks = [
        { id: 'size-shape-consistency', weight: 3, rawScore: 1.0, weightedScore: 3 },
        { id: 'grounding-evidence-fresh', weight: 24, rawScore: 1.0, weightedScore: 24 },
      ]
      const prompt = buildHolePokerPrompt(checks, {})
      assert(prompt.includes('grounding-evidence-fresh'))
      assert(!prompt.includes('size-shape-consistency'))
    })

    test('returns null when no suspicious checks found', () => {
      const checks = [
        { id: 'grounding-evidence-fresh', weight: 24, rawScore: 0.6, weightedScore: 14.4 },
        { id: 'files-populated', weight: 20, rawScore: 0.5, weightedScore: 10 },
      ]
      const prompt = buildHolePokerPrompt(checks, {})
      assert.equal(prompt, null)
    })
  })

  describe('applyHolePokerResult', () => {
    test('lowers score when adjustedScore < original', () => {
      const result = applyHolePokerResult(92, { adjustedScore: 80, reasons: ['fake grounding'] })
      assert.equal(result.finalScore, 80)
      assert.deepEqual(result.reasons, ['fake grounding'])
    })

    test('never raises score', () => {
      const result = applyHolePokerResult(70, { adjustedScore: 95, reasons: [] })
      assert.equal(result.finalScore, 70)
    })

    test('passes through when adjustedScore equals original', () => {
      const result = applyHolePokerResult(88, { adjustedScore: 88, reasons: [] })
      assert.equal(result.finalScore, 88)
    })

    test('handles null hole-poker result (skipped)', () => {
      const result = applyHolePokerResult(88, null)
      assert.equal(result.finalScore, 88)
      assert.deepEqual(result.reasons, [])
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-bridge/lib/hole-poker.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```javascript
// harness-bridge/lib/hole-poker.js

/**
 * Build the hole-poker prompt for a Sonnet skeptic agent.
 * Targets only high-weight checks (weight > 5) that scored a perfect 1.0.
 * Returns null if no suspicious checks found — hole-poker should be skipped.
 *
 * @param {Array<{id, weight, rawScore, weightedScore}>} checks
 * @param {object} artifact — the raw artifact for context
 * @returns {string|null}
 */
export function buildHolePokerPrompt(checks, artifact) {
  const suspicious = checks.filter(c => c.rawScore === 1.0 && c.weight > 5)
  if (suspicious.length === 0) return null

  const checkList = suspicious.map(c => `- ${c.id} (weight: ${c.weight})`).join('\n')
  const contextSnippet = JSON.stringify(artifact, null, 2).slice(0, 2000)

  return `You are a skeptic reviewing a harness confidence gate. The following checks scored a PERFECT 1.0, which is itself suspicious — real artifacts rarely pass everything cleanly.

Your job: attack the TRUTHFULNESS of these scores. For each check below, look for:
- grounding-evidence-fresh: Is the hit in a comment, test fixture, node_modules, or wrong branch? Signature mismatch between target primitive and actual usage?
- files-populated: Are these the RIGHT files or just non-empty? Missing barrel/DI/route companion files?
- ac-research-executable: Are the directives tautological (grep for a string that appears in the AC itself)?
- size-corroboration: Are two "independent" sources sharing one upstream call?
- task-spec-completeness: Tautological DONE assertions that don't actually test behavior?
- companion-edit-closure: Smuggled second concern hiding in an import chain?

Checks that scored 1.0 (high-weight only):
${checkList}

Artifact context (truncated):
\`\`\`json
${contextSnippet}
\`\`\`

Respond with JSON:
{
  "adjustedScore": <number 0-100, MUST be <= the current formula score>,
  "reasons": [<string explaining each deduction>]
}

You may ONLY LOWER the score. If everything looks legitimate, return the same score with empty reasons.`
}

/**
 * Apply hole-poker result to the formula score.
 * The hole-poker can only LOWER, never raise.
 *
 * @param {number} formulaScore — the raw weighted score
 * @param {{ adjustedScore: number, reasons: string[] }|null} holePokerResult
 * @returns {{ finalScore: number, reasons: string[] }}
 */
export function applyHolePokerResult(formulaScore, holePokerResult) {
  if (!holePokerResult) return { finalScore: formulaScore, reasons: [] }

  const adjustedScore = Math.min(formulaScore, holePokerResult.adjustedScore)
  return {
    finalScore: adjustedScore,
    reasons: holePokerResult.reasons || [],
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test harness-bridge/lib/hole-poker.test.js`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/hole-poker.js harness-bridge/lib/hole-poker.test.js
git commit -m "feat(harness-bridge): hole-poker prompt builder + score application"
```

---

## Summary — Part A delivers:

| File | Purpose |
|------|---------|
| `harness-bridge/lib/weights.js` | Frozen defaults, load/normalize/validate |
| `harness-bridge/lib/confidence.js` | 16 pure checks + `runChecks()` orchestrator |
| `harness-bridge/lib/verdict.js` | Score → verdict mapping with retry budget |
| `harness-bridge/lib/gate-writer.js` | Stamp artifact + write `-gated.json` |
| `harness-bridge/lib/hole-poker.js` | Prompt builder + lower-only score adjustment |
| `harness-bridge/fixtures/*.json` | Test fixtures for both handoffs |

**Total tasks: 9** | **Estimated time: 40–60 minutes**

**Next part:** Part B (weight-override mechanism) builds on `weights.js` to add `weights-override.json` read/write, `weightChanges[]` event stream, and the final weight-evolution report.
