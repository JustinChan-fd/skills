# Part C: harness-run — The Conductor (SKILL.md + lib/conductor.js)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `harness-run` — the parent runbook that provisions a worktree, sequences intake → bridge → plan → bridge → implement, reads each artifact, acts on verdicts, handles RE_ASK retries, aggregates telemetry into a run summary, and produces a guardrailed draft PR.

**Architecture:** `harness-run/SKILL.md` is the entry point (invoked via `/harness-run`). `lib/conductor.js` is the pure, unit-tested orchestration logic: sequence table, verdict→action mapping, retry-budget accounting, run-summary assembly. The SKILL.md calls children **as skills** (never launches workflow.js directly) and reads disk artifacts between steps.

**Tech Stack:** Plain JS (ES modules), Node.js test runner, git CLI for worktree.

**Depends on:** Part A (confidence checks), Part B (weight-override)

---

## File Structure

```
harness-run/
├── SKILL.md                     # Runbook — the user invokes /harness-run <jira-url>
├── lib/
│   ├── conductor.js             # Sequence table, verdict→action, retry budget, run summary
│   ├── conductor.test.js        # Unit tests
│   ├── worktree.js              # Worktree provisioning helpers
│   └── worktree.test.js         # Worktree path/branch logic tests
└── workflow.js                  # (Not used — harness-run is a SKILL.md-only runbook)
```

---

### Task 1: Conductor core logic (`lib/conductor.js` + tests)

**Files:**
- Create: `harness-run/lib/conductor.js`
- Create: `harness-run/lib/conductor.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// harness-run/lib/conductor.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SEQUENCE,
  nextStep,
  handleVerdict,
  buildRunId,
  buildRunSummary,
} from './conductor.js'

describe('conductor', () => {
  describe('SEQUENCE', () => {
    test('has 5 ordered phases', () => {
      assert.equal(SEQUENCE.length, 5)
      assert.deepEqual(SEQUENCE.map(s => s.id), [
        'intake', 'bridge-a', 'plan', 'bridge-b', 'implement'
      ])
    })

    test('each phase has id, skill, and artifactPath pattern', () => {
      for (const phase of SEQUENCE) {
        assert(typeof phase.id === 'string')
        assert(typeof phase.skill === 'string')
        assert(typeof phase.artifactPattern === 'string')
      }
    })
  })

  describe('nextStep', () => {
    test('returns intake when currentPhase is null (start)', () => {
      const step = nextStep(null)
      assert.equal(step.id, 'intake')
    })

    test('returns bridge-a after intake', () => {
      const step = nextStep('intake')
      assert.equal(step.id, 'bridge-a')
    })

    test('returns plan after bridge-a', () => {
      const step = nextStep('bridge-a')
      assert.equal(step.id, 'plan')
    })

    test('returns bridge-b after plan', () => {
      const step = nextStep('plan')
      assert.equal(step.id, 'bridge-b')
    })

    test('returns implement after bridge-b', () => {
      const step = nextStep('bridge-b')
      assert.equal(step.id, 'implement')
    })

    test('returns null after implement (done)', () => {
      const step = nextStep('implement')
      assert.equal(step, null)
    })
  })

  describe('handleVerdict', () => {
    test('PROCEED advances to next phase', () => {
      const action = handleVerdict('PROCEED', 'bridge-a', 0)
      assert.equal(action.type, 'advance')
      assert.equal(action.nextPhase, 'plan')
    })

    test('RE_ASK on first attempt triggers refine of previous skill', () => {
      const action = handleVerdict('RE_ASK', 'bridge-a', 0)
      assert.equal(action.type, 'refine')
      assert.equal(action.refineTarget, 'intake')
      assert.equal(action.retryCount, 1)
    })

    test('EXIT stops the pipeline', () => {
      const action = handleVerdict('EXIT', 'bridge-a', 1)
      assert.equal(action.type, 'exit')
      assert(action.reason.includes('confidence'))
    })

    test('RE_ASK with retries=1 becomes EXIT', () => {
      // Second miss → EXIT per spec (budget is exactly one retry per handoff)
      const action = handleVerdict('RE_ASK', 'bridge-a', 1)
      assert.equal(action.type, 'exit')
    })
  })

  describe('buildRunId', () => {
    test('combines issueKey + timestamp', () => {
      const id = buildRunId('TARS-1271', '20260727T010000Z')
      assert.equal(id, 'TARS-1271-20260727T010000Z')
    })

    test('uses "run" prefix when no issueKey', () => {
      const id = buildRunId(null, '20260727T010000Z')
      assert.equal(id, 'run-20260727T010000Z')
    })
  })

  describe('buildRunSummary', () => {
    test('aggregates phase results into summary', () => {
      const phases = [
        { id: 'intake', status: 'COMPLETE', durationMs: 5000 },
        { id: 'bridge-a', status: 'PROCEED', durationMs: 2000, confidence: 92 },
        { id: 'plan', status: 'COMPLETE', durationMs: 15000 },
        { id: 'bridge-b', status: 'PROCEED', durationMs: 3000, confidence: 88 },
        { id: 'implement', status: 'COMPLETE', durationMs: 30000 },
      ]
      const summary = buildRunSummary('TARS-1271-run1', phases)
      assert.equal(summary.runId, 'TARS-1271-run1')
      assert.equal(summary.finalStatus, 'COMPLETE')
      assert.equal(summary.phases.length, 5)
      assert.equal(summary.totalDurationMs, 55000)
    })

    test('marks as FAILED when any phase exits', () => {
      const phases = [
        { id: 'intake', status: 'COMPLETE', durationMs: 5000 },
        { id: 'bridge-a', status: 'EXIT', durationMs: 2000, confidence: 60 },
      ]
      const summary = buildRunSummary('TARS-1271-run1', phases)
      assert.equal(summary.finalStatus, 'FAILED')
      assert.equal(summary.failedAt, 'bridge-a')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-run/lib/conductor.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```javascript
// harness-run/lib/conductor.js

/**
 * Sequence table — the ordered phases of a harness-run pipeline.
 * Each entry: { id, skill, artifactPattern, handoff? }
 *
 * - skill: the slash-command name to invoke (e.g. 'harness-intake')
 * - artifactPattern: glob/template for the disk artifact this phase produces
 * - handoff: which bridge handoff follows this phase ('A' after intake, 'B' after plan)
 */
export const SEQUENCE = [
  {
    id: 'intake',
    skill: 'harness-intake',
    artifactPattern: 'docs/manifests/*__harness-intake__*__manifest.json',
    handoff: 'A',
  },
  {
    id: 'bridge-a',
    skill: 'harness-bridge',
    artifactPattern: '*-gated.json',
    handoff: null,
  },
  {
    id: 'plan',
    skill: 'harness-plan',
    artifactPattern: 'docs/manifests/*-p1.json',
    handoff: 'B',
  },
  {
    id: 'bridge-b',
    skill: 'harness-bridge',
    artifactPattern: '*-gated.json',
    handoff: null,
  },
  {
    id: 'implement',
    skill: 'harness-implement',
    artifactPattern: null, // produces a PR, not a disk artifact
    handoff: null,
  },
]

/**
 * Get the next step in the sequence.
 * @param {string|null} currentPhase — current phase id, or null for start
 * @returns {object|null} — next phase object, or null if done
 */
export function nextStep(currentPhase) {
  if (currentPhase === null) return SEQUENCE[0]
  const idx = SEQUENCE.findIndex(s => s.id === currentPhase)
  if (idx === -1 || idx >= SEQUENCE.length - 1) return null
  return SEQUENCE[idx + 1]
}

/**
 * Map a bridge verdict + retry state to an action.
 *
 * @param {'PROCEED'|'RE_ASK'|'EXIT'} verdict
 * @param {string} currentPhase — 'bridge-a' or 'bridge-b'
 * @param {number} retryCount — how many retries have been used for this handoff
 * @returns {{ type: 'advance'|'refine'|'exit', nextPhase?, refineTarget?, retryCount?, reason? }}
 */
export function handleVerdict(verdict, currentPhase, retryCount) {
  if (verdict === 'PROCEED') {
    const next = nextStep(currentPhase)
    return { type: 'advance', nextPhase: next?.id || null }
  }

  if (verdict === 'EXIT' || retryCount >= 1) {
    return {
      type: 'exit',
      reason: `confidence gate failed at ${currentPhase} after ${retryCount} retry(ies)`,
    }
  }

  // RE_ASK — refine the skill that produced the upstream artifact
  const refineTarget = currentPhase === 'bridge-a' ? 'intake' : 'plan'
  return {
    type: 'refine',
    refineTarget,
    retryCount: retryCount + 1,
  }
}

/**
 * Build a run ID from issue key + timestamp.
 * @param {string|null} issueKey
 * @param {string} timestamp — e.g. '20260727T010000Z'
 * @returns {string}
 */
export function buildRunId(issueKey, timestamp) {
  const prefix = issueKey || 'run'
  return `${prefix}-${timestamp}`
}

/**
 * Build an aggregate run summary from all phase results.
 *
 * @param {string} runId
 * @param {Array<{id, status, durationMs, confidence?}>} phases
 * @returns {{ runId, finalStatus, failedAt?, totalDurationMs, phases }}
 */
export function buildRunSummary(runId, phases) {
  const failed = phases.find(p => p.status === 'EXIT' || p.status === 'FAILED')
  const totalDurationMs = phases.reduce((sum, p) => sum + (p.durationMs || 0), 0)

  return {
    runId,
    finalStatus: failed ? 'FAILED' : 'COMPLETE',
    failedAt: failed?.id || null,
    totalDurationMs,
    phases,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test harness-run/lib/conductor.test.js`
Expected: All 14 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-run/lib/conductor.js harness-run/lib/conductor.test.js
git commit -m "feat(harness-run): conductor core — sequence, verdict handling, run summary"
```

---

### Task 2: Worktree provisioning helpers (`lib/worktree.js` + tests)

**Files:**
- Create: `harness-run/lib/worktree.js`
- Create: `harness-run/lib/worktree.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// harness-run/lib/worktree.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorktreePath, buildWorktreeBranch, buildWorktreeCmd } from './worktree.js'

describe('worktree', () => {
  describe('buildWorktreePath', () => {
    test('builds path under .claude/worktrees/', () => {
      const path = buildWorktreePath('/Users/dev/repos/webtarsthree', 'TARS-1271', '20260727T010000Z')
      assert.equal(path, '/Users/dev/repos/webtarsthree/.claude/worktrees/harness-TARS-1271-20260727T010000Z')
    })

    test('uses "run" prefix when no issueKey', () => {
      const path = buildWorktreePath('/Users/dev/repos/webtarsthree', null, '20260727T010000Z')
      assert.equal(path, '/Users/dev/repos/webtarsthree/.claude/worktrees/harness-run-20260727T010000Z')
    })
  })

  describe('buildWorktreeBranch', () => {
    test('builds branch name with harness/ prefix', () => {
      const branch = buildWorktreeBranch('TARS-1271', '20260727T010000Z')
      assert.equal(branch, 'harness/TARS-1271-20260727T010000Z')
    })
  })

  describe('buildWorktreeCmd', () => {
    test('builds git worktree add command', () => {
      const cmd = buildWorktreeCmd({
        repoPath: '/Users/dev/repos/webtarsthree',
        worktreePath: '/Users/dev/repos/webtarsthree/.claude/worktrees/harness-TARS-1271-run1',
        branch: 'harness/TARS-1271-run1',
        baseBranch: 'feat/migrate-native-fetch-from-axios',
      })
      assert(cmd.includes('git worktree add'))
      assert(cmd.includes('harness/TARS-1271-run1'))
      assert(cmd.includes('origin/feat/migrate-native-fetch-from-axios'))
    })

    test('uses origin/ prefix on baseBranch', () => {
      const cmd = buildWorktreeCmd({
        repoPath: '/Users/dev/repos/webtarsthree',
        worktreePath: '/tmp/wt',
        branch: 'harness/test',
        baseBranch: 'main',
      })
      assert(cmd.includes('origin/main'))
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test harness-run/lib/worktree.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```javascript
// harness-run/lib/worktree.js

/**
 * Build the worktree directory path.
 *
 * @param {string} repoPath — absolute path to the repo root
 * @param {string|null} issueKey — e.g. 'TARS-1271'
 * @param {string} timestamp — e.g. '20260727T010000Z'
 * @returns {string}
 */
export function buildWorktreePath(repoPath, issueKey, timestamp) {
  const slug = issueKey || 'run'
  return `${repoPath}/.claude/worktrees/harness-${slug}-${timestamp}`
}

/**
 * Build the branch name for the worktree.
 *
 * @param {string|null} issueKey
 * @param {string} timestamp
 * @returns {string}
 */
export function buildWorktreeBranch(issueKey, timestamp) {
  const slug = issueKey || 'run'
  return `harness/${slug}-${timestamp}`
}

/**
 * Build the git worktree add command.
 * Bases off origin/<baseBranch> (isolated; never touches user's dirty local branch).
 *
 * @param {{ repoPath, worktreePath, branch, baseBranch }} params
 * @returns {string} — shell command
 */
export function buildWorktreeCmd({ repoPath, worktreePath, branch, baseBranch }) {
  const base = baseBranch.startsWith('origin/') ? baseBranch : `origin/${baseBranch}`
  return [
    `cd "${repoPath}"`,
    `git fetch origin`,
    `git worktree add -b "${branch}" "${worktreePath}" "${base}"`,
  ].join(' && ')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test harness-run/lib/worktree.test.js`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add harness-run/lib/worktree.js harness-run/lib/worktree.test.js
git commit -m "feat(harness-run): worktree provisioning helpers"
```

---

### Task 3: SKILL.md runbook

**Files:**
- Create: `harness-run/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```markdown
---
name: harness-run
description: Autonomous harness conductor — runs intake → bridge → plan → bridge → implement as one confidence-gated pipeline. Produces a guardrailed draft PR.
---

# harness-run

> **Invoke via `/harness-run <jira-url>`**

## What It Does

Orchestrates the full harness pipeline:
1. Provisions an isolated git worktree from `origin/feat/migrate-native-fetch-from-axios`
2. Calls `harness-intake` → reads `intake-manifest.json`
3. Calls `harness-bridge A` → PROCEED / RE_ASK / EXIT
4. Calls `harness-plan` (consuming the gated manifest) → reads plan JSON + manifest
5. Calls `harness-bridge B` → PROCEED / RE_ASK / EXIT
6. Calls `harness-implement` → guardrailed draft PR

On RE_ASK: runs probes, refines the upstream skill in `--refine` mode, re-gates (once).
On EXIT: stops, writes full telemetry, summarizes to user.

## Guardrails (VERBATIM, LOAD-BEARING)

- **DRAFT PR only** — push to `harness/TARS-1271-*` branch, open DRAFT PR
- **NEVER merge, NEVER force-push, NEVER touch main directly**
- **Only in webtarsthree, only for TARS-1271**
- Final PR target: `feat/migrate-native-fetch-from-axios` (NOT main)
- **Stop on first success** — green tests + telemetry flowed → stop
- **$500 hard spend ceiling** (backstop)
- **ALWAYS fire children as skills** — never launch workflow.js directly
- **NEVER-list** applies at all times

## How to Invoke

```
/harness-run https://fandango.atlassian.net/browse/TARS-1271
```

## Step-by-Step

### Phase 0 — Worktree Provisioning

```js
import { buildWorktreePath, buildWorktreeBranch, buildWorktreeCmd } from './lib/worktree.js'

const issueKey = 'TARS-1271'
const runTs = await Bash('python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime(\'%Y%m%dT%H%M%SZ\'))"').then(r => r.trim())
const runId = `${issueKey}-${runTs}`
const repoPath = '/Users/206618626@bwt3.com/Desktop/Repos/webtarsthree'
const baseBranch = 'feat/migrate-native-fetch-from-axios'

const worktreePath = buildWorktreePath(repoPath, issueKey, runTs)
const branch = buildWorktreeBranch(issueKey, runTs)
const cmd = buildWorktreeCmd({ repoPath, worktreePath, branch, baseBranch })
await Bash(cmd)
```

### Phase 1 — Intake

Invoke `/harness-intake` as a skill on the ticket. Read the resulting `intake-manifest.json` from `docs/manifests/`.

### Phase 2 — Bridge A

Invoke `/harness-bridge` with:
- `--handoff A`
- `--artifact <path-to-intake-manifest.json>`
- `--run-id ${runId}`

Read the `-gated.json` output. Check verdict.

### Phase 3 — Plan

Invoke `/harness-plan --intake <path-to-gated-manifest.json>`.
Read the resulting `p1.json` + `manifest.json`.

### Phase 4 — Bridge B

Invoke `/harness-bridge` with:
- `--handoff B`
- `--artifact <path-to-plan-p1.json>`
- `--manifest <path-to-manifest.json>`
- `--run-id ${runId}`

Read the `-gated.json` output. Check verdict.

### Phase 5 — Implement

Invoke `/harness-implement <path-to-plan-p1.json>`.
This produces the code changes in the worktree.

### Phase 6 — Draft PR

```bash
cd ${worktreePath}
git push origin ${branch}
gh pr create --base feat/migrate-native-fetch-from-axios --head ${branch} --draft \
  --title "harness: ${issueKey} — automated implementation" \
  --body "Automated by harness-run (${runId}). Review before merging."
```

### Verdict Handling

```js
import { handleVerdict } from './lib/conductor.js'

function onBridgeComplete(verdict, bridgePhase, retryCount) {
  const action = handleVerdict(verdict, bridgePhase, retryCount)
  switch (action.type) {
    case 'advance':
      // Continue to next phase
      break
    case 'refine':
      // Call the upstream skill with --refine flag, then re-gate
      break
    case 'exit':
      // Write telemetry, print summary, stop
      break
  }
}
```

### Run Summary + Telemetry

At the end (success or exit), aggregate all phase results:

```js
import { buildRunSummary } from './lib/conductor.js'
const summary = buildRunSummary(runId, phaseResults)
// Write to telemetry + print CLI summary
```

## Authorization Note

This runbook is TONIGHT-SCOPED for TARS-1271. Do not generalize without explicit approval.
```

- [ ] **Step 2: Commit**

```bash
git add harness-run/SKILL.md
git commit -m "feat(harness-run): SKILL.md conductor runbook"
```

---

## Summary — Part C delivers:

| File | Purpose |
|------|---------|
| `harness-run/lib/conductor.js` | Sequence table, verdict→action, retry budget, run summary |
| `harness-run/lib/worktree.js` | Worktree path/branch/command builders |
| `harness-run/SKILL.md` | The full runbook with guardrails |
| Tests for conductor + worktree | Full coverage |

**Total tasks: 3** | **Estimated time: 20–25 minutes**

**Next part:** Part D (`--refine` mode on harness-intake and harness-plan).
