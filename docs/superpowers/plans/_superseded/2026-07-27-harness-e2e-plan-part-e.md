# Part E: Telemetry v2 Additions + Model Repoint

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Add the §6 telemetry fields (`confidence`, `verdict`, `flags[]`, `probeResults[]`, `retries`, `errorLog[]`, `weightChanges[]`) to the bridge's v2 audit record. (2) Repoint the `opus` model constant from `claude-opus-4-8` to `claude-opus-5` across all three harness skills.

**Architecture:** The telemetry additions are bridge-only (new fields in its v2 record). The model repoint is a mechanical find-and-replace in `lib/models.js` across harness-intake, harness-plan, and harness-implement.

**Tech Stack:** Plain JS, Node.js test runner.

**Depends on:** Part A (bridge exists), existing harness skills.

---

## File Structure

```
harness-bridge/
├── lib/
│   └── telemetry.js            # Bridge telemetry record builder (v2 + new fields)
│   └── telemetry.test.js       # Tests

harness-intake/lib/models.js     # (modify — opus repoint)
harness-plan/lib/models.js       # (modify — opus repoint)
harness-implement/lib/models.js  # (modify — opus repoint)
```

---

### Task 1: Bridge telemetry record builder (`lib/telemetry.js` + tests)

**Files:**
- Create: `harness-bridge/lib/telemetry.js`
- Create: `harness-bridge/lib/telemetry.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// harness-bridge/lib/telemetry.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildBridgeRecord } from './telemetry.js'

describe('bridge telemetry', () => {
  const baseParams = {
    runId: 'TARS-1271-20260727T010000Z',
    handoff: 'A',
    status: 'PROCEED',
    sourceIssue: 'TARS-1271',
    repo: 'webtarsthree',
    repoPath: '/Users/dev/repos/webtarsthree',
    skillsCommit: 'abc123',
    durationMs: 2500,
    confidence: 92,
    verdict: 'PROCEED',
    flags: [],
    probeResults: [],
    retries: 0,
    errorLog: [],
    weightChanges: [],
  }

  test('produces a valid v2 record with schemaVersion 2.0', () => {
    const record = buildBridgeRecord(baseParams)
    assert.equal(record.schemaVersion, '2.0')
    assert.equal(record.skill, 'harness-bridge')
  })

  test('includes the §6 additions', () => {
    const record = buildBridgeRecord(baseParams)
    assert.equal(record.confidence, 92)
    assert.equal(record.verdict, 'PROCEED')
    assert.deepEqual(record.flags, [])
    assert.deepEqual(record.probeResults, [])
    assert.equal(record.retries, 0)
    assert.deepEqual(record.errorLog, [])
    assert.deepEqual(record.weightChanges, [])
  })

  test('includes standard v2 fields', () => {
    const record = buildBridgeRecord(baseParams)
    assert.equal(record.runId, 'TARS-1271-20260727T010000Z')
    assert.equal(record.sourceIssue, 'TARS-1271')
    assert.equal(record.repo, 'webtarsthree')
    assert.equal(record.durationMs, 2500)
    assert(record.ts)
  })

  test('includes handoff identifier', () => {
    const record = buildBridgeRecord(baseParams)
    assert.equal(record.handoff, 'A')
  })

  test('works for Handoff B with different values', () => {
    const record = buildBridgeRecord({
      ...baseParams,
      handoff: 'B',
      confidence: 78,
      verdict: 'RE_ASK',
      flags: ['task-spec-completeness', 'where-resolves-to-files'],
      retries: 1,
      errorLog: [{ phase: 'bridge-b', message: 'confidence below threshold', ts: '2026-07-27T01:00:00Z' }],
    })
    assert.equal(record.handoff, 'B')
    assert.equal(record.confidence, 78)
    assert.equal(record.verdict, 'RE_ASK')
    assert.equal(record.flags.length, 2)
    assert.equal(record.retries, 1)
    assert.equal(record.errorLog.length, 1)
  })

  test('includes weightChanges when adjustments made', () => {
    const record = buildBridgeRecord({
      ...baseParams,
      weightChanges: [
        { handoff: 'A', checkId: 'grounding-evidence-fresh', oldWeight: 24, newWeight: 30, reason: 'test', triggeringRunId: 'run1', ts: '2026-07-27T01:00:00Z' },
      ],
    })
    assert.equal(record.weightChanges.length, 1)
    assert.equal(record.weightChanges[0].checkId, 'grounding-evidence-fresh')
  })

  test('never removes existing v2 fields (invariant)', () => {
    const record = buildBridgeRecord(baseParams)
    const requiredFields = ['schemaVersion', 'runId', 'skill', 'ts', 'status', 'sourceIssue', 'repo', 'repoPath', 'durationMs']
    for (const field of requiredFields) {
      assert(field in record, `missing required field: ${field}`)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-bridge/lib/telemetry.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```javascript
// harness-bridge/lib/telemetry.js

const SKILLS_SCHEMA_VERSION = 'spec-v8'

/**
 * Build a v2 telemetry record for harness-bridge.
 * Follows the existing v2 shape + §6 additions.
 *
 * INVARIANT: the v2 schema is gospel. NEVER remove a field. Skills may only ADD.
 *
 * @param {{
 *   runId: string,
 *   handoff: 'A'|'B',
 *   status: string,
 *   sourceIssue: string,
 *   repo: string,
 *   repoPath: string,
 *   skillsCommit: string,
 *   durationMs: number,
 *   confidence: number,
 *   verdict: string,
 *   flags: string[],
 *   probeResults: Array<object>,
 *   retries: number,
 *   errorLog: Array<{phase, message, ts}>,
 *   weightChanges: Array<object>,
 * }} params
 * @returns {object} — v2 telemetry record
 */
export function buildBridgeRecord({
  runId,
  handoff,
  status,
  sourceIssue,
  repo,
  repoPath,
  skillsCommit,
  durationMs,
  confidence,
  verdict,
  flags,
  probeResults,
  retries,
  errorLog,
  weightChanges,
}) {
  return {
    // ── Standard v2 fields ──
    schemaVersion: '2.0',
    runId,
    skill: 'harness-bridge',
    skillsSchemaVersion: SKILLS_SCHEMA_VERSION,
    skillsCommit: skillsCommit || null,
    emitTrigger: 'skill',
    billingMode: 'api',
    ts: new Date().toISOString(),
    status,
    outcome: status === 'PROCEED' ? 'success' : status === 'EXIT' ? 'failed' : 'partial',
    sourceIssue,
    repo,
    repoPath,
    branch: null,
    durationMs,
    size: null,
    tokens: {
      byModel: {},
      total: { input: null, output: null, subagentTokens: null, cacheRead: null, cacheCreation: null },
    },
    agentCount: { byModel: {}, byPhase: {} },
    cost: { rateLockedUsd: null, priceTableVersion: '2026-07-25', nullReasons: {} },

    // ── §6 additions (bridge-specific) ──
    handoff,
    confidence,
    verdict,
    flags: flags || [],
    probeResults: probeResults || [],
    retries: retries ?? 0,
    errorLog: errorLog || [],
    weightChanges: weightChanges || [],
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test harness-bridge/lib/telemetry.test.js`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-bridge/lib/telemetry.js harness-bridge/lib/telemetry.test.js
git commit -m "feat(harness-bridge): v2 telemetry record with §6 additions"
```

---

### Task 2: Repoint opus model → `claude-opus-5` across all skills

**Files:**
- Modify: `harness-intake/lib/models.js`
- Modify: `harness-plan/lib/models.js`
- Modify: `harness-implement/lib/models.js`

- [ ] **Step 1: Verify current values**

Run:
```bash
grep -n "opus" harness-intake/lib/models.js harness-plan/lib/models.js harness-implement/lib/models.js
```
Expected: All three show `'claude-opus-4-8'`

- [ ] **Step 2: Update harness-intake/lib/models.js**

Replace the file content:

```javascript
// Model ID constants for harness-intake.
export const MODEL = {
  opus:   'claude-opus-5',
  sonnet: 'anthropic.claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
}
```

- [ ] **Step 3: Update harness-plan/lib/models.js**

Replace the file content:

```javascript
// Model ID constants for harness-plan.
// opusModel was 'claude-opus-4-8' — repointed to 'claude-opus-5' (2026-07-24 release, same price, stronger).
export const MODEL = {
  opus:   'claude-opus-5',
  sonnet: 'anthropic.claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
}
```

- [ ] **Step 4: Update harness-implement/lib/models.js**

Replace the file content:

```javascript
// Model ID constants for harness-implement.
export const MODEL = {
  opus:   'claude-opus-5',
  sonnet: 'anthropic.claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
}
```

- [ ] **Step 5: Verify all three updated**

Run:
```bash
grep "opus" harness-intake/lib/models.js harness-plan/lib/models.js harness-implement/lib/models.js
```
Expected: All three show `'claude-opus-5'`

- [ ] **Step 6: Run existing tests to confirm no breakage**

Run:
```bash
node --test harness-intake/lib/models.test.js
node --test harness-plan/lib/models.test.js
node --test harness-implement/lib/models.test.js
```
Expected: All PASS (model constants are just strings; no logic depends on the specific value)

- [ ] **Step 7: Commit**

```bash
git add harness-intake/lib/models.js harness-plan/lib/models.js harness-implement/lib/models.js
git commit -m "feat: repoint opus seat → claude-opus-5 (2026-07-24 release)"
```

---

## Summary — Part E delivers:

| File | Purpose |
|------|---------|
| `harness-bridge/lib/telemetry.js` | V2 record builder with §6 fields |
| `harness-*/lib/models.js` (×3) | Opus repointed to `claude-opus-5` |
| Tests | Bridge telemetry coverage |

**Total tasks: 2** | **Estimated time: 10–15 minutes**

**Next part:** Part F (integration stitch — wiring all parts together + TARS-1271 run).
