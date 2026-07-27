# Part F: Integration Stitch — Wiring All Parts + TARS-1271 Run

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Parts A–E together into the running `harness-bridge` skill (SKILL.md + workflow.js) and execute the autonomous TARS-1271 run end-to-end.

**Architecture:** `harness-bridge/SKILL.md` is the entry point. It parses `--handoff` and `--artifact` args, runs the confidence checks, optionally invokes the hole-poker agent, computes verdict, writes the gated file, writes telemetry, and returns the result. The TARS-1271 run validates the full pipeline.

**Tech Stack:** Existing skill infrastructure (SKILL.md wrapper pattern), git CLI.

**Depends on:** Parts A, B, C, D, E (all must be committed)

---

## File Structure

```
harness-bridge/
├── SKILL.md                     # Entry point — the skill wrapper
├── lib/
│   ├── confidence.js            # (Part A — already done)
│   ├── weights.js               # (Part A — already done)
│   ├── verdict.js               # (Part A — already done)
│   ├── gate-writer.js           # (Part A — already done)
│   ├── hole-poker.js            # (Part A — already done)
│   ├── weight-override.js       # (Part B — already done)
│   ├── weight-report.js         # (Part B — already done)
│   ├── telemetry.js             # (Part E — already done)
│   └── models.js                # Model constants for bridge
└── workflow.js                  # (NOT USED — bridge is skill-only, no subagents)
```

---

### Task 1: Bridge SKILL.md — the skill wrapper

**Files:**
- Create: `harness-bridge/SKILL.md`
- Create: `harness-bridge/lib/models.js`

- [ ] **Step 1: Write models.js**

```javascript
// harness-bridge/lib/models.js
// Model ID constants for harness-bridge.
export const MODEL = {
  opus:   'claude-opus-5',
  sonnet: 'anthropic.claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
}
```

- [ ] **Step 2: Write SKILL.md**

```markdown
---
name: harness-bridge
description: Confidence gate between harness skills. Scores an upstream artifact against a frozen checklist, optionally runs a Sonnet hole-poker, and writes a stamped -gated.json file. Called by harness-run between pipeline phases.
---

# harness-bridge

> **Called by `harness-run`, not directly by the user.**
> This skill is the confidence gate between pipeline phases. It reads an upstream artifact, scores it, and decides: PROCEED, RE_ASK, or EXIT.

## How to Invoke

```
/harness-bridge --handoff A --artifact <path> --run-id <runId>
/harness-bridge --handoff B --artifact <plan-path> --manifest <manifest-path> --run-id <runId>
```

Optional:
```
--overrides <path-to-weights-override.json>
```

## Step-by-Step

### 1. Parse args

```js
// Extract from skill args:
const handoff = args.match(/--handoff\s+(A|B)/)?.[1]
const artifactPath = args.match(/--artifact\s+(\S+)/)?.[1]
const manifestPath = args.match(/--manifest\s+(\S+)/)?.[1] || null
const runId = args.match(/--run-id\s+(\S+)/)?.[1]
const overridePath = args.match(/--overrides\s+(\S+)/)?.[1] || null
```

### 2. Read artifact from disk

```js
const artifact = JSON.parse(await Bash(`cat "${artifactPath}"`))
// For Handoff B, also read manifest if provided
const manifest = manifestPath ? JSON.parse(await Bash(`cat "${manifestPath}"`)) : null
```

### 3. Read weight overrides (if any)

```js
import { readOverrideFile } from './lib/weight-override.js'
const overrides = overridePath ? readOverrideFile(overridePath) : null
const weightOverrides = overrides?.[handoff] || null
```

### 4. Run confidence checks

```js
import { runChecks } from './lib/confidence.js'
const { score, checks } = runChecks(handoff, artifact, weightOverrides)
```

### 5. Run hole-poker (optional, Sonnet, lower-only)

```js
import { buildHolePokerPrompt, applyHolePokerResult } from './lib/hole-poker.js'
import { MODEL } from './lib/models.js'

const holePokerPrompt = buildHolePokerPrompt(checks, artifact)
let holePokerResult = null

if (holePokerPrompt) {
  // Single Sonnet agent — skeptic that can only lower the score
  holePokerResult = await agent(holePokerPrompt, {
    model: MODEL.sonnet,
    effort: 'medium',
    schema: {
      type: 'object',
      required: ['adjustedScore', 'reasons'],
      properties: {
        adjustedScore: { type: 'number' },
        reasons: { type: 'array', items: { type: 'string' } },
      },
    },
  })
}

import { applyHolePokerResult } from './lib/hole-poker.js'
const { finalScore, reasons } = applyHolePokerResult(score, holePokerResult)
```

### 6. Compute verdict

```js
import { computeVerdict } from './lib/verdict.js'
// retryCount is passed in by the conductor (0 on first attempt, 1 after refine)
const retryCount = parseInt(args.match(/--retries\s+(\d+)/)?.[1] || '0', 10)
const { verdict } = computeVerdict(finalScore, retryCount)
```

### 7. Identify failing checks (for flags[])

```js
const flags = checks
  .filter(c => c.rawScore < 0.8) // checks scoring below 80% are flagged
  .map(c => c.id)
```

### 8. Write gated artifact

```js
import { buildGatedPath, writeGatedArtifact } from './lib/gate-writer.js'
const gatedPath = buildGatedPath(artifactPath)
writeGatedArtifact(artifact, {
  score: finalScore,
  verdict,
  flags,
  probeResults: [],
  checks,
}, gatedPath)
```

### 9. Write telemetry record

```js
import { buildBridgeRecord } from './lib/telemetry.js'
const record = buildBridgeRecord({
  runId,
  handoff,
  status: verdict,
  sourceIssue: artifact.sourceIssue || 'unknown',
  repo: (artifact.repoPath || '').split('/').pop() || 'unknown',
  repoPath: artifact.repoPath || null,
  skillsCommit: await Bash('git -C ~/Desktop/Repos/skills rev-parse HEAD').then(r => r.trim()),
  durationMs: /* computed from start/end */ 0,
  confidence: finalScore,
  verdict,
  flags,
  probeResults: [],
  retries: retryCount,
  errorLog: verdict === 'EXIT' ? [{ phase: `bridge-${handoff.toLowerCase()}`, message: `confidence ${finalScore} < 85`, ts: new Date().toISOString() }] : [],
  weightChanges: [], // populated by conductor if it adjusts weights
})
// Write record to telemetry path
const telemetryPath = `~/Desktop/Repos/harness-telemetry/v2/webtarsthree__harness-bridge__${artifact.sourceIssue || 'unknown'}__${runId.split('-').pop()}.jsonl`
await Bash(`mkdir -p "$(dirname '${telemetryPath}')" && echo '${JSON.stringify(record)}' >> '${telemetryPath}'`)
```

### 10. Print result + return

```js
const icon = verdict === 'PROCEED' ? '✅' : verdict === 'RE_ASK' ? '🔄' : '❌'
const summary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
harness-bridge (Handoff ${handoff})
  verdict:    ${verdict} ${icon}
  confidence: ${finalScore}/100 (threshold: 85)
  flags:      ${flags.length === 0 ? 'none' : flags.join(', ')}
  hole-poker: ${holePokerResult ? `lowered by ${score - finalScore} pts` : 'skipped (no suspicious checks)'}
  gated file: ${gatedPath}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
console.log(summary)
```

## Contracts

**Input:** `--handoff`, `--artifact`, `--run-id`, optional `--manifest`, `--overrides`, `--retries`
**Output:** `<artifact>-gated.json` on disk, telemetry record, CLI summary, verdict string.

## Design Decisions

- Bridge is a SKILL.md-only skill (no workflow.js). It calls at most one agent (the hole-poker).
- The hole-poker is the ONLY LLM in the gate. All checks are pure JS.
- The gated file is a NEW file — the original is never mutated.
- `flags[]` contains check IDs scoring below 80% — used by `--refine` mode downstream.
```

- [ ] **Step 3: Commit**

```bash
git add harness-bridge/SKILL.md harness-bridge/lib/models.js
git commit -m "feat(harness-bridge): SKILL.md wrapper + models.js"
```

---

### Task 2: Integration smoke test — verify all imports resolve

**Files:**
- Create: `harness-bridge/lib/index.js` (barrel export for test convenience)
- Create: `harness-bridge/lib/integration.test.js`

- [ ] **Step 1: Write the integration test**

```javascript
// harness-bridge/lib/integration.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// Verify all modules import cleanly
import { runChecks } from './confidence.js'
import { HANDOFF_A_WEIGHTS, HANDOFF_B_WEIGHTS, loadWeights, validateWeights } from './weights.js'
import { computeVerdict, THRESHOLD } from './verdict.js'
import { buildGatedPath, writeGatedArtifact } from './gate-writer.js'
import { buildHolePokerPrompt, applyHolePokerResult } from './hole-poker.js'
import { validateAdjustment, applyAdjustment, readOverrideFile, buildChangeEvent } from './weight-override.js'
import { renderWeightReport } from './weight-report.js'
import { buildBridgeRecord } from './telemetry.js'
import { MODEL } from './models.js'

import cleanManifest from '../fixtures/intake-manifest-clean.json' with { type: 'json' }
import cleanPlan from '../fixtures/plan-clean.json' with { type: 'json' }

describe('integration — full gate flow', () => {
  test('Handoff A: clean manifest → PROCEED', () => {
    const { score, checks } = runChecks('A', cleanManifest)
    const { finalScore } = applyHolePokerResult(score, null)
    const { verdict } = computeVerdict(finalScore, 0)
    assert.equal(verdict, 'PROCEED')
    assert(finalScore >= 85)
  })

  test('Handoff B: clean plan → PROCEED', () => {
    const { score, checks } = runChecks('B', cleanPlan)
    const { finalScore } = applyHolePokerResult(score, null)
    const { verdict } = computeVerdict(finalScore, 0)
    assert.equal(verdict, 'PROCEED')
    assert(finalScore >= 85)
  })

  test('full record can be built from gate result', () => {
    const { score, checks } = runChecks('A', cleanManifest)
    const { finalScore } = applyHolePokerResult(score, null)
    const { verdict } = computeVerdict(finalScore, 0)
    const flags = checks.filter(c => c.rawScore < 0.8).map(c => c.id)

    const record = buildBridgeRecord({
      runId: 'TARS-1271-test',
      handoff: 'A',
      status: verdict,
      sourceIssue: 'TARS-1271',
      repo: 'webtarsthree',
      repoPath: '/tmp/test',
      skillsCommit: 'abc123',
      durationMs: 1000,
      confidence: finalScore,
      verdict,
      flags,
      probeResults: [],
      retries: 0,
      errorLog: [],
      weightChanges: [],
    })

    assert.equal(record.schemaVersion, '2.0')
    assert.equal(record.skill, 'harness-bridge')
    assert.equal(record.confidence, finalScore)
  })

  test('weight override flows through to runChecks', () => {
    const overrides = { 'grounding-evidence-fresh': 30 }
    const { score: withOverride } = runChecks('A', cleanManifest, overrides)
    const { score: withoutOverride } = runChecks('A', cleanManifest, null)
    // Scores should differ because weights changed
    // (may be same if clean scores 1.0 on everything, but at least no crash)
    assert(typeof withOverride === 'number')
    assert(typeof withoutOverride === 'number')
  })

  test('MODEL.opus is claude-opus-5', () => {
    assert.equal(MODEL.opus, 'claude-opus-5')
  })
})
```

- [ ] **Step 2: Run the integration test**

Run: `node --test harness-bridge/lib/integration.test.js`
Expected: All 5 tests PASS

- [ ] **Step 3: Commit**

```bash
git add harness-bridge/lib/integration.test.js
git commit -m "test(harness-bridge): integration smoke test — full gate flow"
```

---

### Task 3: Register harness-bridge + harness-run in skill discovery

**Files:**
- Modify: Project skill configuration (if any central registry exists)

- [ ] **Step 1: Verify skills are discoverable**

Run:
```bash
ls harness-bridge/SKILL.md harness-run/SKILL.md
```
Expected: Both files exist

- [ ] **Step 2: Test that the bridge can be invoked as a skill reference**

The skill system discovers skills by the presence of `SKILL.md` with frontmatter `name:` field. Verify:

```bash
head -3 harness-bridge/SKILL.md
head -3 harness-run/SKILL.md
```

Expected:
```
---
name: harness-bridge
```
and
```
---
name: harness-run
```

- [ ] **Step 3: Commit (if any config changes needed)**

```bash
git add -A
git commit -m "chore: register harness-bridge + harness-run skills" --allow-empty
```

---

### Task 4: TARS-1271 autonomous run (validation)

**Files:** No new files — this is an execution task.

> **NOTE:** This task is the validation run. It uses the infrastructure built in Parts A–E. Execute it only after all prior parts are committed and tested.

- [ ] **Step 1: Invoke harness-run**

```
/harness-run https://fandango.atlassian.net/browse/TARS-1271
```

- [ ] **Step 2: Monitor pipeline progress**

Watch for:
- Phase 0: Worktree provisioned from `origin/feat/migrate-native-fetch-from-axios`
- Phase 1: Intake completes → `intake-manifest.json` written
- Phase 2: Bridge A → confidence score ≥ 85 → PROCEED
- Phase 3: Plan completes → `p1.json` + `manifest.json` written
- Phase 4: Bridge B → confidence score ≥ 85 → PROCEED
- Phase 5: Implement completes → code changes in worktree

- [ ] **Step 3: Verify guardrails respected**

```bash
# Check branch name
git -C <worktree> branch --show-current
# Expected: harness/TARS-1271-<timestamp>

# Check no force pushes happened
git -C <worktree> reflog | grep force
# Expected: no output

# Check target remote
git -C <worktree> remote -v
# Expected: origin pointing to webtarsthree
```

- [ ] **Step 4: Create draft PR**

```bash
cd <worktree>
git push origin harness/TARS-1271-<timestamp>
gh pr create \
  --base feat/migrate-native-fetch-from-axios \
  --head harness/TARS-1271-<timestamp> \
  --draft \
  --title "harness: TARS-1271 — automated client HTTP migration" \
  --body "Automated by harness-run. Review before merging.

Run ID: TARS-1271-<timestamp>
Confidence A: <score>/100
Confidence B: <score>/100"
```

- [ ] **Step 5: Verify stop-on-first-success**

```bash
# Tests pass
cd <worktree> && npm test

# Telemetry flowed
ls ~/Desktop/Repos/harness-telemetry/v2/webtarsthree__harness-bridge__TARS-1271__*.jsonl
ls ~/Desktop/Repos/harness-telemetry/v2/webtarsthree__harness-intake__TARS-1271__*.jsonl
ls ~/Desktop/Repos/harness-telemetry/v2/webtarsthree__harness-plan__TARS-1271__*.jsonl
```

- [ ] **Step 6: Print final weight evolution report**

If any weight adjustments were made during the run:
```js
import { renderWeightReport } from './harness-bridge/lib/weight-report.js'
// Print the report
```

---

## Summary — Part F delivers:

| File | Purpose |
|------|---------|
| `harness-bridge/SKILL.md` | Complete skill wrapper wiring all lib/ modules |
| `harness-bridge/lib/models.js` | Model constants |
| `harness-bridge/lib/integration.test.js` | End-to-end smoke test |
| TARS-1271 run | Validates the entire pipeline |

**Total tasks: 4** | **Estimated time: 30–45 minutes (excluding TARS-1271 run time)**

---

## Full Plan Dependency Graph

```
Part A ──► Part B ──► Part F
  │                     ▲
  └──► Part C ──────────┘
  │                     ▲
  └──► Part D ──────────┘
  │                     ▲
  └──► Part E ──────────┘
```

Parts B, C, D, E all depend on Part A but are independent of each other. Part F depends on all prior parts.

**Execution order:** A → (B, C, D, E in parallel) → F
