# Part D: --refine Mode on harness-intake + harness-plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--refine <gated-path>` mode to both `harness-intake` and `harness-plan`. When the bridge gates at RE_ASK, the conductor calls the upstream skill in refine mode. Refine reads the flagged parts from the gated artifact, re-synthesizes only those, and writes a NEW versioned file (never overwrites the original).

**Architecture:** Each skill's SKILL.md gains a new flag. The workflow receives `refineFrom` in args, detects it, and runs a targeted sub-pipeline that only touches flagged checks. The output is a new versioned file with the same shape as the original but improved on the flagged dimensions.

**Tech Stack:** Modifications to existing SKILL.md files + workflow args. New `lib/refine.js` in each skill for the delta logic.

**Depends on:** Part A (bridge produces `-gated.json` with `flags[]`)

---

## File Structure

```
harness-intake/
├── SKILL.md                     # (modify — add --refine flag documentation)
├── lib/
│   ├── refine.js               # Refine logic: read gated, extract flags, build targeted prompts
│   └── refine.test.js          # Tests
└── workflow.js                  # (modify — add refine detection + early-exit path)

harness-plan/
├── SKILL.md                     # (modify — add --refine flag documentation)
├── lib/
│   ├── refine.js               # Refine logic for plan: targeted re-synthesis
│   └── refine.test.js          # Tests
└── workflow.js                  # (modify — add refine detection + early-exit path)
```

---

### Task 1: harness-intake refine logic (`lib/refine.js` + tests)

**Files:**
- Create: `harness-intake/lib/refine.js`
- Create: `harness-intake/lib/refine.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// harness-intake/lib/refine.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractRefineTargets,
  buildRefinePrompt,
  buildRefinedManifestPath,
  mergeRefinedFields,
} from './refine.js'

describe('intake refine', () => {
  describe('extractRefineTargets', () => {
    test('extracts failing check IDs from gated artifact', () => {
      const gated = {
        gated: true,
        confidence: 72,
        verdict: 'RE_ASK',
        flags: ['grounding-evidence-fresh', 'files-populated'],
        probeResults: [],
        skill: 'harness-intake',
        files: [],
      }
      const targets = extractRefineTargets(gated)
      assert.deepEqual(targets, ['grounding-evidence-fresh', 'files-populated'])
    })

    test('returns empty array when no flags', () => {
      const gated = { gated: true, confidence: 90, verdict: 'PROCEED', flags: [] }
      const targets = extractRefineTargets(gated)
      assert.deepEqual(targets, [])
    })
  })

  describe('buildRefinePrompt', () => {
    test('includes failing checks in the prompt', () => {
      const targets = ['grounding-evidence-fresh', 'files-populated']
      const manifest = { scopePath: 'src/client', migrationPattern: 'axios → clientFetch' }
      const prompt = buildRefinePrompt(targets, manifest)
      assert(prompt.includes('grounding-evidence-fresh'))
      assert(prompt.includes('files-populated'))
      assert(prompt.includes('src/client'))
    })

    test('returns targeted instructions for each failing check', () => {
      const targets = ['grounding-evidence-fresh']
      const manifest = { scopePath: 'src/client', migrationPattern: 'axios → clientFetch' }
      const prompt = buildRefinePrompt(targets, manifest)
      assert(prompt.includes('clientFetch'))
      assert(prompt.includes('grep'))
    })
  })

  describe('buildRefinedManifestPath', () => {
    test('appends -v2 to the original path', () => {
      const path = buildRefinedManifestPath('/repo/docs/manifests/intake-manifest.json', 1)
      assert.equal(path, '/repo/docs/manifests/intake-manifest-v2.json')
    })

    test('increments version number', () => {
      const path = buildRefinedManifestPath('/repo/docs/manifests/intake-manifest.json', 2)
      assert.equal(path, '/repo/docs/manifests/intake-manifest-v3.json')
    })
  })

  describe('mergeRefinedFields', () => {
    test('overwrites only targeted fields from refine result', () => {
      const original = {
        skill: 'harness-intake',
        files: [],
        groundedReality: null,
        acList: [{ bullet: 'test', researchType: '', grepPattern: '' }],
        size: 'M',
      }
      const refined = {
        files: ['src/client/api/fetchMovies.ts'],
        groundedReality: { targetPrimitive: 'clientFetch', discoveredFiles: ['src/client/lib/clientFetch.ts'] },
      }
      const merged = mergeRefinedFields(original, refined)
      assert.deepEqual(merged.files, ['src/client/api/fetchMovies.ts'])
      assert.equal(merged.groundedReality.targetPrimitive, 'clientFetch')
      // Non-targeted fields preserved
      assert.equal(merged.skill, 'harness-intake')
      assert.equal(merged.size, 'M')
    })

    test('never mutates original', () => {
      const original = { skill: 'harness-intake', files: [] }
      const copy = { ...original, files: [...original.files] }
      mergeRefinedFields(original, { files: ['new.ts'] })
      assert.deepEqual(original, copy)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-intake/lib/refine.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```javascript
// harness-intake/lib/refine.js

/**
 * Extract the failing check IDs from a gated artifact.
 * These are the dimensions that need re-synthesis.
 *
 * @param {object} gatedArtifact — the -gated.json contents
 * @returns {string[]} — array of check IDs that failed
 */
export function extractRefineTargets(gatedArtifact) {
  return gatedArtifact.flags || []
}

/**
 * Map each failing check ID to a targeted action the refine agent should take.
 * Returns a structured prompt for the refine agent.
 */
const CHECK_TO_ACTION = {
  'grounding-evidence-fresh': (manifest) =>
    `GROUNDING: The target primitive "${(manifest.migrationPattern || '').split('→').pop()?.trim()}" was not found in discovered files or grep hits. Run: grep -rl '${(manifest.migrationPattern || '').split('→').pop()?.trim()}' ${manifest.scopePath || '.'} and update groundedReality.discoveredFiles + grepHits.`,

  'files-populated': (manifest) =>
    `FILES: The files[] array is empty. Run: find ${manifest.scopePath || '.'} -name "*.ts" -o -name "*.tsx" | head -20 and populate the files[] array with actual file paths that need modification.`,

  'ac-research-executable': (manifest) =>
    `AC RESEARCH: One or more acList entries lack a valid researchType + directive. Review each AC and add grepPattern or shellCommand that can actually verify the claim.`,

  'size-corroboration': (manifest) =>
    `SIZE: Fewer than 2 independent magnitude sources. Add sizeCorroboration[] entries from: file count (find/wc), grep hit count, AC count, import graph depth.`,

  'ac-referenced-files-covered': (manifest) =>
    `AC FILES: AC searchScope paths don't resolve into files[]. Ensure every AC's searchScope is a prefix of at least one entry in files[].`,

  'claim-truth-consistency': (manifest) =>
    `TRUTH: Ticket-claimed counts don't match grep-verified counts (>20% delta). Re-run the shell commands and update verifiedCount in acList.`,

  'scope-grounded': (manifest) =>
    `SCOPE: scopePath "${manifest.scopePath}" doesn't match any discovered file. Verify the path exists and update scopePath or discover files under it.`,

  'size-shape-consistency': (manifest) =>
    `SHAPE: size/groups mismatch. If size=L, groups[] must be non-empty. If size≠L, groups[] must be absent.`,
}

/**
 * Build a refine prompt targeting only the failing checks.
 *
 * @param {string[]} targets — failing check IDs
 * @param {object} manifest — the original manifest
 * @returns {string}
 */
export function buildRefinePrompt(targets, manifest) {
  const actions = targets
    .map(t => CHECK_TO_ACTION[t]?.(manifest))
    .filter(Boolean)

  return `You are refining an intake manifest that failed confidence checks. DO NOT re-run the full intake — only fix the specific issues below.

Failing checks:
${targets.map(t => `- ${t}`).join('\n')}

Required actions:
${actions.map((a, i) => `${i + 1}. ${a}`).join('\n')}

Current manifest context:
- scopePath: ${manifest.scopePath || '(none)'}
- migrationPattern: ${manifest.migrationPattern || '(none)'}
- files count: ${(manifest.files || []).length}
- acList count: ${(manifest.acList || []).length}

Return a JSON object with ONLY the fields you are updating. Do not return the full manifest — only the delta.`
}

/**
 * Build the path for the refined manifest (versioned, never overwrites).
 *
 * @param {string} originalPath — path to the original manifest
 * @param {number} attempt — retry number (1-based: first refine = 1)
 * @returns {string}
 */
export function buildRefinedManifestPath(originalPath, attempt) {
  const version = attempt + 1
  return originalPath.replace(/\.json$/, `-v${version}.json`)
}

/**
 * Merge refined fields into the original manifest.
 * Only overwrites keys present in `refined`. Never mutates original.
 *
 * @param {object} original — the original manifest
 * @param {object} refined — partial object with only the updated fields
 * @returns {object} — new merged manifest
 */
export function mergeRefinedFields(original, refined) {
  return { ...original, ...refined }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test harness-intake/lib/refine.test.js`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-intake/lib/refine.js harness-intake/lib/refine.test.js
git commit -m "feat(harness-intake): --refine mode delta logic"
```

---

### Task 2: harness-plan refine logic (`lib/refine.js` + tests)

**Files:**
- Create: `harness-plan/lib/refine.js`
- Create: `harness-plan/lib/refine.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// harness-plan/lib/refine.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractRefineTargets,
  buildRefinePrompt,
  buildRefinedPlanPath,
  identifyWeakTasks,
} from './refine.js'

describe('plan refine', () => {
  describe('extractRefineTargets', () => {
    test('extracts failing check IDs from gated plan', () => {
      const gated = {
        gated: true,
        confidence: 75,
        verdict: 'RE_ASK',
        flags: ['task-spec-completeness', 'where-resolves-to-files'],
      }
      const targets = extractRefineTargets(gated)
      assert.deepEqual(targets, ['task-spec-completeness', 'where-resolves-to-files'])
    })
  })

  describe('identifyWeakTasks', () => {
    test('finds tasks with thin WHERE/HOW when task-spec-completeness fails', () => {
      const plan = {
        tasks: [
          { id: 't1', description: 'WHAT: x\nWHERE: a\nHOW: b\nDONE: c', files: ['a.ts'] },
          { id: 't2', description: 'WHAT: do something meaningful here\nWHERE: src/client/api/fetchMovies.ts:3-15 long enough\nHOW: Replace the import with a longer description here\nDONE: test passes', files: ['src/client/api/fetchMovies.ts'] },
        ],
      }
      const weak = identifyWeakTasks(plan, ['task-spec-completeness'])
      // t1 has thin WHERE/HOW (< 20 chars)
      assert(weak.some(t => t.id === 't1'))
    })

    test('finds tasks with no file:line anchor when where-resolves-to-files fails', () => {
      const plan = {
        tasks: [
          { id: 't1', description: 'WHAT: x\nWHERE: somewhere vague\nHOW: do stuff\nDONE: done', files: [] },
        ],
      }
      const weak = identifyWeakTasks(plan, ['where-resolves-to-files'])
      assert(weak.some(t => t.id === 't1'))
    })

    test('returns empty when no weak tasks found', () => {
      const plan = {
        tasks: [
          { id: 't1', description: 'WHAT: x\nWHERE: src/client/api/fetchMovies.ts:3-15 long description here\nHOW: Replace the import statement with clientFetch wrapper call\nDONE: expect(result).toEqual(expected)\n```ts\ncode\n```', files: ['src/client/api/fetchMovies.ts'] },
        ],
      }
      const weak = identifyWeakTasks(plan, ['task-spec-completeness'])
      assert.equal(weak.length, 0)
    })
  })

  describe('buildRefinePrompt', () => {
    test('includes weak task IDs and target checks', () => {
      const weakTasks = [{ id: 't1', title: 'Fix thing', description: 'WHAT: x\nWHERE: y\nHOW: z' }]
      const targets = ['task-spec-completeness']
      const prompt = buildRefinePrompt(targets, weakTasks)
      assert(prompt.includes('t1'))
      assert(prompt.includes('task-spec-completeness'))
      assert(prompt.includes('WHERE'))
    })
  })

  describe('buildRefinedPlanPath', () => {
    test('appends -v2 to plan path', () => {
      const path = buildRefinedPlanPath('/repo/docs/manifests/2026-07-27-tars-1271-p1.json', 1)
      assert.equal(path, '/repo/docs/manifests/2026-07-27-tars-1271-p1-v2.json')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-plan/lib/refine.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```javascript
// harness-plan/lib/refine.js

/**
 * Extract failing check IDs from the gated plan artifact.
 *
 * @param {object} gatedArtifact
 * @returns {string[]}
 */
export function extractRefineTargets(gatedArtifact) {
  return gatedArtifact.flags || []
}

/**
 * Identify tasks that are weak on the failing dimensions.
 * Returns only the tasks that need re-synthesis.
 *
 * @param {object} plan — the plan JSON
 * @param {string[]} targets — failing check IDs
 * @returns {Array<object>} — weak tasks
 */
export function identifyWeakTasks(plan, targets) {
  const tasks = plan.tasks || []
  const FILE_LINE_RE = /(\S+\.[a-z]{1,4}):(\d+)/

  return tasks.filter(t => {
    const d = t.description || ''

    for (const target of targets) {
      switch (target) {
        case 'task-spec-completeness': {
          const whereMatch = d.match(/where[:\s]+(.+?)(?=\n(?:what|how|done)|$)/is)
          const howMatch = d.match(/how[:\s]+(.+?)(?=\n(?:what|where|done)|$)/is)
          const whereLen = (whereMatch?.[1] || '').trim().length
          const howLen = (howMatch?.[1] || '').trim().length
          const hasSnippet = /```/.test(d)
          if (whereLen < 20 || howLen < 20 || !hasSnippet) return true
          break
        }
        case 'where-resolves-to-files': {
          const whereMatch = d.match(/where[:\s]+(.+?)(?=\n(?:what|how|done)|$)/is)
          const whereText = whereMatch?.[1] || ''
          if (!FILE_LINE_RE.test(whereText)) return true
          break
        }
        case 'task-files-present-bounded': {
          if ((t.files || []).length === 0) return true
          break
        }
        case 'tdd-done-literal-assertion': {
          if (t.tddRequired) {
            const doneMatch = d.match(/done[:\s]+(.+?)$/is)
            const doneText = doneMatch?.[1] || ''
            if (!/(?:assert|expect|should|toBe|toEqual)/i.test(doneText)) return true
          }
          break
        }
        case 'companion-edit-closure': {
          // Would need import analysis — flag all tasks with imports for review
          if (/from\s+['"]/.test(d) && (t.files || []).length < 2) return true
          break
        }
      }
    }
    return false
  })
}

/**
 * Build a refine prompt targeting weak tasks.
 *
 * @param {string[]} targets — failing check IDs
 * @param {Array<object>} weakTasks — tasks that need improvement
 * @returns {string}
 */
export function buildRefinePrompt(targets, weakTasks) {
  const taskList = weakTasks.map(t =>
    `- ${t.id} "${t.title || ''}": current description:\n  ${(t.description || '').slice(0, 200)}`
  ).join('\n')

  const checkActions = targets.map(t => {
    switch (t) {
      case 'task-spec-completeness':
        return 'Ensure every task has WHAT + WHERE (≥20 chars with file:line) + HOW (≥20 chars) + DONE + a fenced code snippet (```)'
      case 'where-resolves-to-files':
        return 'Every WHERE must have a file:line anchor (e.g. src/client/api/fetchMovies.ts:3-15) that exists in the task files[]'
      case 'task-files-present-bounded':
        return 'Every task must have 1-3 files in files[]. If >3, split the task.'
      case 'tdd-done-literal-assertion':
        return 'Every tddRequired task DONE must contain a literal assertion (expect/assert/toBe/toEqual)'
      case 'companion-edit-closure':
        return 'Every import path referenced in HOW/DONE must appear in the union of files[] across all tasks'
      default:
        return `Fix: ${t}`
    }
  }).join('\n')

  return `You are refining a plan that failed confidence checks. Only fix the weak tasks listed below — do NOT re-write the entire plan.

Failing checks:
${targets.map(t => `- ${t}`).join('\n')}

Required fixes:
${checkActions}

Weak tasks to revise:
${taskList}

For each weak task, return a revised task object with improved description. Only return the tasks you changed — not the full plan.`
}

/**
 * Build path for the refined plan (versioned).
 *
 * @param {string} originalPath
 * @param {number} attempt — 1-based
 * @returns {string}
 */
export function buildRefinedPlanPath(originalPath, attempt) {
  const version = attempt + 1
  return originalPath.replace(/\.json$/, `-v${version}.json`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test harness-plan/lib/refine.test.js`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-plan/lib/refine.js harness-plan/lib/refine.test.js
git commit -m "feat(harness-plan): --refine mode delta logic"
```

---

### Task 3: Update SKILL.md documentation for both skills

**Files:**
- Modify: `harness-intake/SKILL.md`
- Modify: `harness-plan/SKILL.md`

- [ ] **Step 1: Add --refine documentation to harness-intake SKILL.md**

Add after the "How to Invoke" / "When to Use" section in `harness-intake/SKILL.md`:

```markdown
### --refine mode (called by harness-run, not user-facing)

```
/harness-intake --refine <path-to-gated-manifest.json>
```

When the bridge gates a manifest at RE_ASK, `harness-run` calls intake in refine mode:
1. Reads the `-gated.json` to find `flags[]` (failing check IDs)
2. Runs targeted probes for ONLY the failing dimensions
3. Writes a NEW versioned manifest (e.g. `intake-manifest-v2.json`)
4. Never overwrites the original

The conductor then re-gates the new version.
```

- [ ] **Step 2: Add --refine documentation to harness-plan SKILL.md**

Add after the "How to Invoke" section in `harness-plan/SKILL.md`:

```markdown
### --refine mode (called by harness-run, not user-facing)

```
/harness-plan --refine <path-to-gated-plan.json>
```

When the bridge gates a plan at RE_ASK, `harness-run` calls plan in refine mode:
1. Reads the `-gated.json` to find `flags[]` (failing check IDs)
2. Identifies weak tasks (those failing the flagged checks)
3. Re-synthesizes only the weak tasks with targeted prompts
4. Writes a NEW versioned plan (e.g. `p1-v2.json`)
5. Never overwrites the original

The conductor then re-gates the new version.
```

- [ ] **Step 3: Commit**

```bash
git add harness-intake/SKILL.md harness-plan/SKILL.md
git commit -m "docs: add --refine mode documentation to intake + plan skills"
```

---

## Summary — Part D delivers:

| File | Purpose |
|------|---------|
| `harness-intake/lib/refine.js` | Extract targets, build prompts, merge refined fields |
| `harness-plan/lib/refine.js` | Identify weak tasks, build targeted re-synthesis prompts |
| SKILL.md updates | Document the --refine flag for both skills |
| Tests for both | Coverage of target extraction, prompt building, path versioning |

**Total tasks: 3** | **Estimated time: 20–25 minutes**

**Next part:** Part E (telemetry v2 additions + model repoint).
