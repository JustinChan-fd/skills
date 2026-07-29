# Subagent Subtree Token Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make directional token capture read the transcripts that actually hold the harness's tokens — the driver subagent and its whole descendant subtree — instead of a newest-mtime top-level transcript that structurally cannot contain them.

**Architecture:** Three additive layers on `tools/lib/`. (1) A new `agent-tree.mjs` reads the `agent-<id>.meta.json` sidecars in a session's `subagents/` directory and returns the parent→child tree, so a driver's cost can be rolled up over its descendants. (2) `tokens-collect.mjs` gains a `subtree` resolution mode that returns a *list* of transcript paths and merges their per-model sums, plus a `subagentsDirForSession` derivation so the caller never depends on a skill remembering to pass `--subagents-dir`. (3) `harness.mjs` threads `CLAUDE_CODE_SESSION_ID` and a new `--agent-id` on `record-observed-tokens`, so the orchestrator — which is the only party that knows the driver's agent id — can overwrite the driver's best-effort stamp with an exact one.

**Tech Stack:** Node 22 built-ins only (`node:fs`, `node:path`, `node:os`, `node:test`). No new dependency in `package.json`. ESM `.mjs` throughout.

## Global Constraints

- **No new dependency in `harness-core/package.json`.** Node built-ins only.
- **Additive to the record.** `tokens_directional`'s subschema in `run-record.schema.json` is `additionalProperties: false` — do not add fields to it. Provenance (`via`, `source`) is emitted by the CLI, never stamped.
- **Never throw from a collect path.** Every failure degrades to a `complete: false` `tokens_directional` with a note code. `run-end` wraps `collectAndStamp` in try/catch and must stay best-effort.
- **Never regress the clobber guard.** `stampTokensDirectional` skips the write when the incoming `by_model` is empty and the record already has model sums (`record.mjs:142`). A best-effort stamp must never be replaced by an empty one.
- **Roll forward, no backfill.** Pre-existing run records stay as they are. Do not write migrations.
- **`by_model` keys keep the transcript's own model-id spelling.** Tier resolution normalizes for *lookup* only (`model-tier.mjs`); it never rewrites keys.
- **Tests are `node:test`**, run with `cd harness-core && npm test`. Baseline at plan start: **403 pass / 0 fail**.
- Existing exported names in `tokens-collect.mjs` must keep working: `resolveTranscript`, `collectForRun`, `collectFromFile`, `discoverLoopTranscript`, `discoverStandaloneTranscript`, `discoverSubagentForRun`, `backfillDirectional`, `buildTokensDirectional`, `projectDirForCwd`, `mungeProjectDir`, `FINGERPRINT_BAND`, `FORMAT_VERSION`, `DEFAULT_GAP_CAP_MS`.

## Background: the measured facts this plan is built on

All figures below were measured against the four TARS-1271 run dirs in
`~/Desktop/Repos/webtarsthree/.harness/runs/` and the session transcripts in
`~/.claude/projects/-Users-206618626-bwt3-com-Desktop-Repos-webtarsthree/`. They are
the verification bar in Task 5 — do not re-derive them, reuse them.

1. **100% of harness token spend is in subagent transcripts.** Summing every usage
   line inside each run's own window: orchestrator-only = **0 tokens** for
   implement, plan, and intake. Subagents = 303,461,553 / 6,861,569 / 14,979,578.
   The orchestrator dispatches and waits; it is idle for the phase it measures.

2. **So `discoverStandaloneTranscript` cannot work for a phase run.** On the
   implement run it resolved `9506315d-…jsonl` — an unrelated *later* session —
   with **0** usage lines in the window. All six newest top-level transcripts had 0.

3. **The window was never the problem.** That run's window was 256.6 minutes
   (`08:45:25.198Z` → `13:02:02.605Z`). Windowing is out of scope (see #19).

4. **`subagent_tokens` fingerprints the driver exactly.** For the implement run,
   `tokens_observed.total = 532540` matched exactly one agent's `peak_context`:
   `532540`, ratio **1.000**, unique in the 0.95–1.05 band. Intake's `126669` and
   plan's `115357` are likewise depth-1 peaks. Every depth-1 agent is a phase
   driver, and the Agent-tool `subagent_tokens` tag equals that driver's own
   `peak_context`.

5. **Reading only the driver's own transcript undercounts by 24%.** Driver
   `a0efe4645d03748de`: own 233,607,665 vs subtree **308,519,206** (own is 75.7%).
   The subtree rollup is what a phase actually cost.

6. **Driver subtrees partition the session exactly.** Sum of the three depth-1
   subtrees = 332,537,207 = grand total across all 14 agents. No orphans, no
   double-counting.

7. **The `.meta.json` sidecar carries seat identity and the tree.** Every
   `agent-<id>.jsonl` has a sibling `agent-<id>.meta.json`:
   ```json
   {"agentType":"client_unit_test_writer","description":"Write TDD tests for ems pages",
    "toolUseId":"toolu_bdrk_016tcCwoc9n7N2UxQ1cUkWnC","parentAgentId":"a0efe4645d03748de",
    "spawnDepth":2,"model":"sonnet"}
   ```
   `parentAgentId` is absent (or not a key in the directory) for depth-1 agents.

8. **`CLAUDE_CODE_SESSION_ID` is in the Bash env** and
   `<projectDirForCwd(cwd)>/<sessionId>/subagents` exists — verified live.

9. **`complete: true` over `by_model: {}` is already fixed** by the
   `empty_collection` guard at `tokens-collect.mjs:415`. Do not re-fix it.

## File Structure

| File | Responsibility |
|---|---|
| `harness-core/tools/lib/agent-tree.mjs` | **NEW.** Read `.meta.json` sidecars → `{ agents, childrenOf, descendantsOf, driversOf }`. Pure, filesystem-reading, never throws. No token math. |
| `harness-core/test/agent-tree.test.mjs` | **NEW.** Tests for the above against a temp fixture directory. |
| `harness-core/tools/lib/tokens-collect.mjs` | **MODIFY.** Add `subagentsDirForSession`, `resolveTranscripts` (plural), `mergeByModel`, `collectFromFiles`; extend `collectForRun` with `mode: 'subtree'` + `agentId` + `sessionId`. |
| `harness-core/test/tokens-collect.test.mjs` | **MODIFY.** Tests for the new resolution + merge behaviour. |
| `harness-core/tools/harness.mjs` | **MODIFY.** `collectAndStamp` derives session/subagents dir and defaults phase runs to subtree mode; `record-observed-tokens` gains `--agent-id`; `TOKENS_COLLECT_OPTS` gains `agent-id` + `session-id`. |
| `harness-core/test/tokens-collect-cli.test.mjs` | **MODIFY.** CLI-level tests for `--agent-id` plumbing. |
| `harness-loop-core/SKILL.md` | **MODIFY.** Step 6 passes `--agent-id` from the dispatch result. |

Task boundaries: Task 1 is a standalone pure lib with its own tests (a reviewer can
reject it without touching collection). Task 2 is the collection layer that consumes
it. Task 3 is the CLI wiring. Task 4 is the skill contract. Task 5 is verification
against real data. Each ends with an independently testable deliverable.

---

### Task 1: `agent-tree.mjs` — read the delegation tree from `.meta.json` sidecars

**Files:**
- Create: `harness-core/tools/lib/agent-tree.mjs`
- Test: `harness-core/test/agent-tree.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks. Node built-ins only.
- Produces, relied on by Task 2:
  - `readAgentTree(subagentsDir)` → `{ ok: boolean, agents: Map<string, AgentMeta>, error: {code,detail}|null }`
    where `AgentMeta = { id, agentType: string|null, model: string|null, parentAgentId: string|null, spawnDepth: number|null, description: string|null }`
  - `childrenOf(tree, id)` → `string[]` (agent ids, sorted ascending for determinism)
  - `descendantsOf(tree, id)` → `string[]` — `id` **plus** all transitive descendants, `id` first, rest sorted. Cycle-safe.
  - `driversOf(tree)` → `string[]` — ids whose `parentAgentId` is null or names an agent absent from the tree (sorted).

- [ ] **Step 1: Write the failing test**

Create `harness-core/test/agent-tree.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAgentTree, childrenOf, descendantsOf, driversOf } from '../tools/lib/agent-tree.mjs';

// Mirrors the real shape observed in
// ~/.claude/projects/<munged>/<session>/subagents/agent-<id>.meta.json
function fixture(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-tree-'));
  for (const [id, meta] of Object.entries(spec)) {
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
    writeFileSync(join(dir, `agent-${id}.jsonl`), '');
  }
  return dir;
}

// driver a1 -> {b1, b2}; b1 -> c1. Second driver a2 with no children.
const TREE = {
  a1: { agentType: 'general-purpose', model: 'opus', spawnDepth: 1 },
  a2: { agentType: 'general-purpose', model: 'sonnet', spawnDepth: 1 },
  b1: { agentType: 'hp-researcher', model: 'sonnet', spawnDepth: 2, parentAgentId: 'a1' },
  b2: { agentType: 'hp-architect', model: 'sonnet', spawnDepth: 2, parentAgentId: 'a1' },
  c1: { agentType: 'Explore', model: 'sonnet', spawnDepth: 3, parentAgentId: 'b1' },
};

test('readAgentTree parses every sidecar into AgentMeta', () => {
  const t = readAgentTree(fixture(TREE));
  assert.equal(t.ok, true);
  assert.equal(t.agents.size, 5);
  assert.deepEqual(t.agents.get('b1'), {
    id: 'b1', agentType: 'hp-researcher', model: 'sonnet',
    parentAgentId: 'a1', spawnDepth: 2, description: null,
  });
  assert.equal(t.agents.get('a1').parentAgentId, null);
});

test('childrenOf returns direct children sorted', () => {
  const t = readAgentTree(fixture(TREE));
  assert.deepEqual(childrenOf(t, 'a1'), ['b1', 'b2']);
  assert.deepEqual(childrenOf(t, 'c1'), []);
});

test('descendantsOf includes self first, then transitive descendants', () => {
  const t = readAgentTree(fixture(TREE));
  assert.deepEqual(descendantsOf(t, 'a1'), ['a1', 'b1', 'b2', 'c1']);
  assert.deepEqual(descendantsOf(t, 'b1'), ['b1', 'c1']);
  assert.deepEqual(descendantsOf(t, 'a2'), ['a2']);
});

test('descendantsOf of an unknown id returns just that id', () => {
  const t = readAgentTree(fixture(TREE));
  assert.deepEqual(descendantsOf(t, 'nope'), ['nope']);
});

test('driversOf returns depth-1 agents; subtrees partition the tree', () => {
  const t = readAgentTree(fixture(TREE));
  const drivers = driversOf(t);
  assert.deepEqual(drivers, ['a1', 'a2']);
  // Fact 6: driver subtrees partition the session exactly — no orphans, no overlap.
  const covered = drivers.flatMap((d) => descendantsOf(t, d));
  assert.equal(covered.length, new Set(covered).size, 'no agent counted twice');
  assert.deepEqual([...covered].sort(), [...t.agents.keys()].sort());
});

test('an orphan whose parent is absent from the dir is treated as a driver', () => {
  const t = readAgentTree(fixture({
    x1: { agentType: 'general-purpose', spawnDepth: 2, parentAgentId: 'gone' },
  }));
  assert.deepEqual(driversOf(t), ['x1']);
});

test('a parentAgentId cycle terminates instead of hanging', () => {
  const t = readAgentTree(fixture({
    p: { agentType: 'a', parentAgentId: 'q' },
    q: { agentType: 'b', parentAgentId: 'p' },
  }));
  assert.deepEqual(descendantsOf(t, 'p'), ['p', 'q']);
});

test('a malformed sidecar is skipped, not fatal', () => {
  const dir = fixture({ ok1: { agentType: 'general-purpose' } });
  writeFileSync(join(dir, 'agent-bad.meta.json'), '{ not json');
  const t = readAgentTree(dir);
  assert.equal(t.ok, true);
  assert.equal(t.agents.size, 1);
  assert.equal(t.agents.has('bad'), false);
});

test('a missing directory returns ok:false with not_found, never throws', () => {
  const t = readAgentTree(join(tmpdir(), 'definitely-not-here-9c1f'));
  assert.equal(t.ok, false);
  assert.equal(t.error.code, 'not_found');
  assert.equal(t.agents.size, 0);
});

test('a directory with jsonl but no sidecars returns ok:false no_metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-tree-'));
  writeFileSync(join(dir, 'agent-z9.jsonl'), '');
  const t = readAgentTree(dir);
  assert.equal(t.ok, false);
  assert.equal(t.error.code, 'no_metadata');
});

test('readAgentTree ignores non-agent files and nested dirs', () => {
  const dir = fixture({ k1: { agentType: 'general-purpose' } });
  writeFileSync(join(dir, 'notes.md'), '# hi');
  mkdirSync(join(dir, 'nested'));
  const t = readAgentTree(dir);
  assert.deepEqual([...t.agents.keys()], ['k1']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd harness-core && node --test test/agent-tree.test.mjs`
Expected: FAIL — `Cannot find module '../tools/lib/agent-tree.mjs'`

- [ ] **Step 3: Write the implementation**

Create `harness-core/tools/lib/agent-tree.mjs`:

```javascript
/**
 * Read the subagent delegation tree for one Claude Code session.
 *
 * Every subagent transcript at <subagentsDir>/agent-<id>.jsonl has a sibling
 * <subagentsDir>/agent-<id>.meta.json written by the harness's host CLI:
 *
 *   {"agentType":"client_unit_test_writer","description":"...",
 *    "toolUseId":"toolu_...","parentAgentId":"a0efe4645d03748de",
 *    "spawnDepth":2,"model":"sonnet"}
 *
 * `parentAgentId` reconstructs the delegation tree, which is what makes a phase's
 * true cost computable: a driver's own transcript is only ~76% of what its subtree
 * spent (measured: driver own 233,607,665 vs subtree 308,519,206). Rolling up over
 * `descendantsOf` is the difference between undercounting a phase by a quarter and
 * getting it right.
 *
 * Like the sidecar format itself, this file's shape is internal to Claude Code and
 * is NOT a stable contract — it can change on any release. Every field is read
 * defensively and a malformed or missing sidecar degrades rather than throwing.
 * This module does no token math; it only answers "who spawned whom".
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const META_RE = /^agent-(.+)\.meta\.json$/;

/**
 * @returns {{ok: boolean, agents: Map<string, object>, error: {code: string, detail: string}|null}}
 * Never throws. `agents` is always a Map (empty when !ok).
 */
export function readAgentTree(subagentsDir) {
  const agents = new Map();
  if (!subagentsDir) {
    return { ok: false, agents, error: { code: 'not_found', detail: 'no subagents dir given' } };
  }
  let entries;
  try {
    entries = readdirSync(subagentsDir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, agents, error: { code: 'not_found', detail: `cannot read ${subagentsDir}: ${err.code ?? err.message}` } };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = META_RE.exec(entry.name);
    if (!m) continue;
    const id = m[1];
    let raw;
    try {
      raw = JSON.parse(readFileSync(join(subagentsDir, entry.name), 'utf8'));
    } catch {
      continue; // A malformed sidecar loses one agent, not the whole tree.
    }
    if (!raw || typeof raw !== 'object') continue;
    agents.set(id, {
      id,
      agentType: typeof raw.agentType === 'string' ? raw.agentType : null,
      model: typeof raw.model === 'string' ? raw.model : null,
      parentAgentId: typeof raw.parentAgentId === 'string' ? raw.parentAgentId : null,
      spawnDepth: Number.isFinite(raw.spawnDepth) ? raw.spawnDepth : null,
      description: typeof raw.description === 'string' ? raw.description : null,
    });
  }
  if (agents.size === 0) {
    return { ok: false, agents, error: { code: 'no_metadata', detail: `no agent-*.meta.json sidecars in ${subagentsDir}` } };
  }
  return { ok: true, agents, error: null };
}

/** Direct children of `id`, sorted for deterministic output. */
export function childrenOf(tree, id) {
  const out = [];
  for (const [childId, meta] of tree?.agents ?? []) {
    if (meta.parentAgentId === id) out.push(childId);
  }
  return out.sort();
}

/**
 * `id` plus every transitive descendant — `id` first, the rest sorted.
 * Cycle-safe: a parentAgentId loop terminates via the `seen` set rather than
 * recursing forever. An unknown `id` returns just `[id]`, so a caller that
 * knows an agent id the sidecars do not still gets that one transcript.
 */
export function descendantsOf(tree, id) {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    for (const child of childrenOf(tree, queue.shift())) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  const rest = [...seen].filter((x) => x !== id).sort();
  return [id, ...rest];
}

/**
 * Agents with no parent *present in this directory* — the phase drivers. An
 * agent whose parentAgentId names someone absent counts as a driver too, so an
 * incomplete directory still partitions rather than dropping a subtree.
 */
export function driversOf(tree) {
  const ids = [...(tree?.agents?.keys() ?? [])];
  return ids
    .filter((id) => {
      const parent = tree.agents.get(id).parentAgentId;
      return parent === null || !tree.agents.has(parent);
    })
    .sort();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd harness-core && node --test test/agent-tree.test.mjs`
Expected: PASS, 11 tests.

Then the whole suite: `cd harness-core && npm test`
Expected: 403 → 414 pass / 0 fail.

- [ ] **Step 5: Perturbation check — prove the tests are load-bearing**

Make each change, run `node --test test/agent-tree.test.mjs`, confirm a FAILURE, then revert:

1. In `descendantsOf`, change `const rest = [...seen].filter((x) => x !== id).sort();` to `const rest = [...seen].filter((x) => x !== id);` — insertion order happens to match here, so this may PASS. If it does, say so in the report rather than claiming a failure; ordering is asserted only where it is guaranteed.
2. In `descendantsOf`, delete the `if (seen.has(child)) continue;` line → the cycle test must hang or fail. (Use a timeout; a hang is a failure.)
3. In `driversOf`, drop `|| !tree.agents.has(parent)` → the orphan test must fail.
4. In `readAgentTree`, remove the `agents.size === 0` block → the `no_metadata` test must fail.

Report the actual result of each, including any that do not fail.

- [ ] **Step 6: Commit**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills
git add harness-core/tools/lib/agent-tree.mjs harness-core/test/agent-tree.test.mjs
git commit -m "harness-core: read subagent delegation tree from meta.json sidecars (#17)"
```

---

### Task 2: subtree resolution and multi-file merge in `tokens-collect.mjs`

**Files:**
- Modify: `harness-core/tools/lib/tokens-collect.mjs`
- Test: `harness-core/test/tokens-collect.test.mjs`

**Interfaces:**
- Consumes from Task 1: `readAgentTree`, `descendantsOf`, `driversOf` from `./agent-tree.mjs`.
- Produces, relied on by Task 3:
  - `subagentsDirForSession({ sessionId, projectDir, cwd, home })` → `string|null` — `<projectDir>/<sessionId>/subagents`, deriving `projectDir` from `cwd` when absent. Returns `null` without a `sessionId`.
  - `resolveTranscripts(opts)` → `{ ok, paths: string[], error: {code,detail}|null, via: string|null }` where `via` ∈ `'explicit' | 'subtree' | 'fingerprint_subtree' | 'fingerprint' | 'newest_mtime' | 'all_drivers'`.
  - `mergeByModel(results)` → `{ by_model, peak_context, active_ms }` — sums per model across results; `peak_context` is the **max**, not a sum.
  - `collectFromFiles(paths, opts)` → same shape as `collectFromFile` but merged over many files.
  - `collectForRun` accepts additional `agentId`, `sessionId` and `mode: 'subtree'`; its return gains nothing new beyond the existing `{ tokens_directional, note, source, via }`.
- `resolveTranscript` (singular) keeps its exact current signature and behaviour — `resolveTranscripts` is additive. Existing callers and tests must not change.

**Resolution precedence for `mode: 'subtree'`** (implement exactly this order):
1. `agentId` given → `descendantsOf(tree, agentId)` → `via: 'subtree'`.
2. No `agentId`, but `observedTotal > 0` → `discoverSubagentForRun` to identify the driver, then roll up its subtree → `via: 'fingerprint_subtree'`.
3. Neither → all `driversOf(tree)` subtrees, i.e. every agent in the dir → `via: 'all_drivers'`.
   Fact 6 says driver subtrees partition the session, so this is the whole session's
   subagent spend with no double-counting. It over-attributes when two phases share
   one session, which is strictly better than the 0-token undercount it replaces.
4. Tree unreadable → return its error. Do **not** silently fall back to
   newest-mtime standalone: fact 2 established that path resolves an unrelated
   session's transcript, and a wrong number is worse than a noted absence.

- [ ] **Step 1: Write the failing tests**

Append to `harness-core/test/tokens-collect.test.mjs`:

```javascript
// ---- subtree resolution (#17) ----

import {
  subagentsDirForSession, resolveTranscripts, mergeByModel, collectFromFiles,
} from '../tools/lib/tokens-collect.mjs';

// One usage line, shaped like a real transcript entry.
function usageLine({ ts, model, input = 0, output = 0, cacheRead = 0, cacheCreation = 0 }) {
  return JSON.stringify({
    timestamp: ts,
    message: {
      model,
      usage: {
        input_tokens: input, output_tokens: output,
        cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation,
      },
    },
  });
}

/** Build a <dir>/<session>/subagents fixture. spec: id -> {meta, lines[]} */
function sessionFixture(spec, sessionId = 'sess-1') {
  const projectDir = mkdtempSync(join(tmpdir(), 'proj-'));
  const subagentsDir = join(projectDir, sessionId, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  for (const [id, { meta, lines }] of Object.entries(spec)) {
    writeFileSync(join(subagentsDir, `agent-${id}.meta.json`), JSON.stringify(meta ?? {}));
    writeFileSync(join(subagentsDir, `agent-${id}.jsonl`), (lines ?? []).join('\n') + '\n');
  }
  return { projectDir, subagentsDir, sessionId };
}

const TS = '2026-07-28T10:00:00.000Z';
// driver d1 (own 100 in) -> kid k1 (own 40 in); unrelated driver d2 (own 7 in).
const SPEC = {
  d1: { meta: { agentType: 'general-purpose', spawnDepth: 1 },
        lines: [usageLine({ ts: TS, model: 'claude-opus-5', input: 100, output: 10 })] },
  k1: { meta: { agentType: 'hp-researcher', spawnDepth: 2, parentAgentId: 'd1' },
        lines: [usageLine({ ts: TS, model: 'claude-sonnet-4-6', input: 40, output: 4 })] },
  d2: { meta: { agentType: 'general-purpose', spawnDepth: 1 },
        lines: [usageLine({ ts: TS, model: 'claude-opus-5', input: 7, output: 1 })] },
};

test('subagentsDirForSession joins project dir, session id, subagents', () => {
  const dir = subagentsDirForSession({ sessionId: 'abc', projectDir: '/p' });
  assert.equal(dir, join('/p', 'abc', 'subagents'));
});

test('subagentsDirForSession derives the project dir from cwd', () => {
  const dir = subagentsDirForSession({ sessionId: 'abc', cwd: '/Users/x/Repos/foo', home: '/Users/x' });
  assert.equal(dir, join('/Users/x/.claude/projects/-Users-x-Repos-foo', 'abc', 'subagents'));
});

test('subagentsDirForSession returns null without a session id', () => {
  assert.equal(subagentsDirForSession({ projectDir: '/p' }), null);
});

test('subtree mode with an agentId collects the driver AND its descendants', () => {
  const { subagentsDir } = sessionFixture(SPEC);
  const r = resolveTranscripts({ mode: 'subtree', subagentsDir, agentId: 'd1' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'subtree');
  assert.deepEqual(r.paths.map((p) => basename(p)), ['agent-d1.jsonl', 'agent-k1.jsonl']);
});

test('subtree mode without an agentId falls back to every driver subtree', () => {
  const { subagentsDir } = sessionFixture(SPEC);
  const r = resolveTranscripts({ mode: 'subtree', subagentsDir });
  assert.equal(r.via, 'all_drivers');
  assert.deepEqual(
    r.paths.map((p) => basename(p)).sort(),
    ['agent-d1.jsonl', 'agent-d2.jsonl', 'agent-k1.jsonl'],
  );
});

test('subtree mode prefers the fingerprint when observedTotal identifies a driver', () => {
  const { subagentsDir } = sessionFixture(SPEC);
  // d1's own peak_context is 110 (100 input + 10 output).
  const r = resolveTranscripts({ mode: 'subtree', subagentsDir, observedTotal: 110 });
  assert.equal(r.via, 'fingerprint_subtree');
  assert.deepEqual(r.paths.map((p) => basename(p)), ['agent-d1.jsonl', 'agent-k1.jsonl']);
});

test('subtree mode refuses rather than falling back to standalone newest-mtime', () => {
  const r = resolveTranscripts({ mode: 'subtree', subagentsDir: join(tmpdir(), 'nope-4a2f') });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
  assert.deepEqual(r.paths, []);
});

test('an explicit transcript still wins in subtree mode', () => {
  const { subagentsDir } = sessionFixture(SPEC);
  const r = resolveTranscripts({ mode: 'subtree', subagentsDir, transcript: '/x/y.jsonl', agentId: 'd1' });
  assert.equal(r.via, 'explicit');
  assert.deepEqual(r.paths, ['/x/y.jsonl']);
});

test('resolveTranscripts wraps the singular resolver for non-subtree modes', () => {
  const { projectDir } = sessionFixture(SPEC);
  writeFileSync(join(projectDir, 'top.jsonl'), '');
  const r = resolveTranscripts({ projectDir });
  assert.equal(r.via, 'newest_mtime');
  assert.equal(r.paths.length, 1);
});

test('mergeByModel sums per model and takes the MAX peak_context', () => {
  const merged = mergeByModel([
    { ok: true, by_model: { a: { input: 1, output: 2, cache_read: 3, cache_creation: 4 } }, peak_context: 100, active_ms: 10 },
    { ok: true, by_model: { a: { input: 5, output: 0, cache_read: 0, cache_creation: 0 }, b: { input: 9, output: 0, cache_read: 0, cache_creation: 0 } }, peak_context: 250, active_ms: 20 },
  ]);
  assert.deepEqual(merged.by_model.a, { input: 6, output: 2, cache_read: 3, cache_creation: 4 });
  assert.deepEqual(merged.by_model.b, { input: 9, output: 0, cache_read: 0, cache_creation: 0 });
  // peak_context is a high-water mark of one context window, never a sum.
  assert.equal(merged.peak_context, 250);
  assert.equal(merged.active_ms, 30);
});

test('mergeByModel ignores failed results but keeps the good ones', () => {
  const merged = mergeByModel([
    { ok: false, by_model: {}, peak_context: 0 },
    { ok: true, by_model: { a: { input: 2, output: 0, cache_read: 0, cache_creation: 0 } }, peak_context: 5 },
  ]);
  assert.deepEqual(Object.keys(merged.by_model), ['a']);
  assert.equal(merged.by_model.a.input, 2);
});

test('collectFromFiles merges a real driver subtree across two files', () => {
  const { subagentsDir } = sessionFixture(SPEC);
  const r = collectFromFiles(
    [join(subagentsDir, 'agent-d1.jsonl'), join(subagentsDir, 'agent-k1.jsonl')],
    {},
  );
  assert.equal(r.ok, true);
  assert.equal(r.by_model['claude-opus-5'].input, 100);
  assert.equal(r.by_model['claude-sonnet-4-6'].input, 40);
});

test('collectFromFiles on an empty list fails with no_usage, never throws', () => {
  const r = collectFromFiles([], {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_usage');
});

test('collectForRun in subtree mode stamps a non-empty by_model from the subtree', () => {
  const { subagentsDir } = sessionFixture(SPEC);
  const { tokens_directional, note, via } = collectForRun({
    mode: 'subtree', subagentsDir, agentId: 'd1',
    modelTierMap: { 'claude-opus-5': 'HIGH', 'claude-sonnet-4-6': 'MID' },
  });
  assert.equal(note, null);
  assert.equal(tokens_directional.complete, true);
  assert.equal(via, 'subtree');
  assert.deepEqual(Object.keys(tokens_directional.by_model).sort(), ['claude-opus-5', 'claude-sonnet-4-6']);
});
```

Add `mkdirSync` and `basename` to that file's existing imports if absent.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd harness-core && node --test test/tokens-collect.test.mjs`
Expected: FAIL — no export named `subagentsDirForSession`.

- [ ] **Step 3: Write the implementation**

In `harness-core/tools/lib/tokens-collect.mjs`, add the import at the top with the others:

```javascript
import { readAgentTree, descendantsOf, driversOf } from './agent-tree.mjs';
```

Add after `discoverStandaloneTranscript`:

```javascript
/**
 * The subagents directory for one session: <projectDir>/<sessionId>/subagents.
 *
 * Derivation, not configuration. `CLAUDE_CODE_SESSION_ID` is present in the env of
 * every Bash call the harness makes, and `projectDirForCwd` already maps a cwd to
 * its transcript directory — so the caller can always compute this. The previous
 * design required a skill to remember `--mode loop --subagents-dir`; no skill file
 * ever did, which is half of why #17 went unnoticed. Deriving it removes the
 * LLM from a deterministic lookup.
 */
export function subagentsDirForSession({ sessionId, projectDir, cwd, home } = {}) {
  if (!sessionId) return null;
  const dir = projectDir ?? (cwd ? projectDirForCwd(cwd, { home }) : null);
  if (!dir) return null;
  return join(dir, sessionId, 'subagents');
}
```

Add after `resolveTranscript`:

```javascript
/**
 * Resolve the transcript LIST for a run. `resolveTranscript` (singular) is kept
 * unchanged for existing callers; this is the plural form the subtree mode needs.
 *
 * Why a list: a phase driver's own transcript is not the phase's cost. Measured on
 * the TARS-1271 implement run, the driver's own spend was 233,607,665 against a
 * subtree total of 308,519,206 — reading one file undercounts by 24%. Driver
 * subtrees partition the session exactly (sum of subtrees == grand total across
 * every agent), so rolling up over `descendantsOf` neither drops nor double-counts.
 *
 * Subtree precedence:
 *   1. explicit `transcript`            -> via 'explicit'
 *   2. `agentId`                        -> via 'subtree'            (exact identity)
 *   3. `observedTotal > 0`              -> via 'fingerprint_subtree' (identify, then roll up)
 *   4. neither                          -> via 'all_drivers'        (whole session)
 *
 * There is deliberately NO fallback from subtree mode to standalone newest-mtime.
 * That path resolved an unrelated later session's transcript on the run that
 * exposed #17, and 100% of harness spend lives in subagent transcripts anyway
 * (orchestrator-only spend inside a phase window measured 0 tokens across three
 * stages) — so falling back would trade a noted absence for a wrong number.
 */
export function resolveTranscripts(opts = {}) {
  const { transcript, mode, subagentsDir, agentId, observedTotal } = opts;
  if (transcript) return { ok: true, paths: [transcript], error: null, via: 'explicit' };
  if (mode !== 'subtree') {
    const single = resolveTranscript(opts);
    return { ok: single.ok, paths: single.ok ? [single.path] : [], error: single.error, via: single.via };
  }
  const tree = readAgentTree(subagentsDir);
  if (!tree.ok) return { ok: false, paths: [], error: tree.error, via: null };

  const pathsFor = (ids) => ids.map((id) => join(subagentsDir, `agent-${id}.jsonl`));

  if (agentId) {
    return { ok: true, paths: pathsFor(descendantsOf(tree, agentId)), error: null, via: 'subtree' };
  }
  if (Number.isFinite(observedTotal) && observedTotal > 0) {
    const hit = discoverSubagentForRun({ subagentsDir, observedTotal });
    if (hit.ok) {
      const id = basename(hit.path).replace(/^agent-/, '').replace(/\.jsonl$/, '');
      return { ok: true, paths: pathsFor(descendantsOf(tree, id)), error: null, via: 'fingerprint_subtree' };
    }
    // An unmatched fingerprint degrades to every driver rather than to nothing:
    // the whole session's subagent spend is a superset of this run's, where
    // newest-mtime standalone was measured to be a disjoint set.
  }
  const all = driversOf(tree).flatMap((d) => descendantsOf(tree, d));
  return { ok: true, paths: pathsFor([...new Set(all)]), error: null, via: 'all_drivers' };
}

/**
 * Merge several `collectFromFile` results into one. Per-model directional fields
 * are summed; `active_ms` is summed; `peak_context` takes the MAX because it is a
 * high-water mark of a single context window — summing peaks across agents would
 * invent a context size no agent ever held, and would break the fingerprint match
 * that reads it back.
 */
export function mergeByModel(results) {
  const by_model = {};
  let peak_context = 0;
  let active_ms = 0;
  for (const r of results) {
    if (!r?.ok) continue;
    for (const [model, sums] of Object.entries(r.by_model ?? {})) {
      const acc = (by_model[model] ??= emptyBucket());
      // DIRECTIONS is an object mapping our field name -> the transcript's usage
      // key; its KEYS are the bucket fields. Reuse it rather than re-listing them.
      for (const k of Object.keys(DIRECTIONS)) acc[k] += sums[k] ?? 0;
    }
    peak_context = Math.max(peak_context, r.peak_context ?? 0);
    active_ms += r.active_ms ?? 0;
  }
  return { by_model, peak_context, active_ms };
}

/**
 * `collectFromFile` over many paths, merged. An unreadable path is skipped, not
 * fatal: one missing transcript in a subtree should degrade the sum, not void it.
 * Returns the same shape as `collectFromFile`.
 */
export function collectFromFiles(paths, opts = {}) {
  const results = (paths ?? []).map((p) => collectFromFile(p, opts));
  const merged = mergeByModel(results);
  if (Object.keys(merged.by_model).length === 0) {
    return {
      ok: false, by_model: {}, peak_context: 0, active_ms: 0,
      error: { code: 'no_usage', detail: `no model usage across ${paths?.length ?? 0} transcript(s)` },
    };
  }
  return { ok: true, ...merged, error: null };
}
```

`DIRECTIONS` (line 77) and `emptyBucket()` (line 84) are existing module-level
helpers — reuse both rather than re-listing the four field names. Note
`DIRECTIONS` is an **object** (`{input: 'input_tokens', …}`), so iterate
`Object.keys(DIRECTIONS)`, not the object itself. Add `basename` to the existing
`import { join } from 'node:path'` (line 64).

Then in `collectForRun`, accept and thread the two new options. Change its
signature to include `agentId` and `sessionId`, and replace its
`resolveTranscript` + `collectFromFile` pair with the plural forms:

```javascript
export function collectForRun({ transcript, mode, subagentsDir, projectDir, cwd, home, start, end, gapCapMs, modelTierMap, observedTotal, agentId, sessionId, now = new Date() } = {}) {
  // Derive the subagents dir when the caller did not pass one but can name the
  // session — see subagentsDirForSession for why this is derived, not configured.
  const dir = subagentsDir ?? subagentsDirForSession({ sessionId, projectDir, cwd, home });
  const resolved = resolveTranscripts({
    transcript, mode, subagentsDir: dir, projectDir, cwd, home, observedTotal, agentId,
  });
  const result = resolved.ok
    ? collectFromFiles(resolved.paths, { start, end, gapCapMs })
    : { ok: false, by_model: {}, peak_context: 0, active_ms: 0, error: resolved.error };
  const built = buildTokensDirectional({ result, modelTierMap, now });
  return { ...built, source: resolved.ok ? (resolved.paths[0] ?? null) : null, via: resolved.via ?? null, result };
}
```

**Two return-shape invariants to preserve** (the current signature is
`{ ...built, source, via, result }`):

- **Keep the `result` key.** `test/tokens-backfill.test.mjs:201` documents the
  no-transcript fallback's missing `peak_context` as a live hazard that the
  `peak_context <= 0` guard in `discoverSubagentForRun` catches. The new
  `{ ok: false, …, peak_context: 0, … }` fallback now sets it explicitly, which is
  strictly better — but do not drop the key, and do not change that test.
- **Keep `source` null when resolution failed**, as today. Use the first resolved
  path for the multi-path case; the subtree's driver sorts first
  (`descendantsOf` returns self first), so `paths[0]` is the driver.

Finally, replace the stale `NOT YET REACHED ON ANY LIVE RUN` paragraph in
`resolveTranscript`'s doc comment with:

```javascript
 * SUPERSEDED FOR LIVE COLLECTION by `resolveTranscripts` + `mode: 'subtree'`.
 * This singular resolver remains for explicit-path and backfill callers. Its
 * standalone newest-mtime branch must NOT be used for a phase run: the
 * orchestrator is idle while a phase runs (measured: 0 tokens inside the phase
 * window across three stages), so the newest top-level transcript is at best
 * unrelated. See issue #17.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd harness-core && node --test test/tokens-collect.test.mjs`
Expected: PASS, including all pre-existing tests in that file.

Then: `cd harness-core && npm test`
Expected: 414 → 428 pass / 0 fail. Report the real numbers.

- [ ] **Step 5: Perturbation check**

Each change must produce a FAILURE. Revert after each; report actual results:

1. In `mergeByModel`, change `peak_context = Math.max(...)` to `peak_context += r.peak_context ?? 0` → the MAX test must fail.
2. In `resolveTranscripts`, change the `agentId` branch to return only that one path (`pathsFor([agentId])`) → the descendants test must fail.
3. In `resolveTranscripts`, make the `!tree.ok` branch fall through to `resolveTranscript` standalone → the refuse test must fail.
4. In `collectFromFiles`, delete the empty-`by_model` block → the `no_usage` test must fail.

- [ ] **Step 6: Commit**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills
git add harness-core/tools/lib/tokens-collect.mjs harness-core/test/tokens-collect.test.mjs
git commit -m "harness-core: collect directional tokens over a driver's subagent subtree (#17)"
```

---

### Task 3: CLI wiring — derive the session, accept `--agent-id`, re-collect exactly

**Files:**
- Modify: `harness-core/tools/harness.mjs` — `collectAndStamp` (~line 76), `TOKENS_COLLECT_OPTS` (~line 107), `record-observed-tokens` (~line 351)
- Test: `harness-core/test/tokens-collect-cli.test.mjs`

**Interfaces:**
- Consumes from Task 2: `collectForRun` with `agentId` / `sessionId` / `mode: 'subtree'`; `subagentsDirForSession`.
- Produces, relied on by Task 4: `harness.mjs record-observed-tokens --agent-id <id>` re-collects and re-stamps `tokens_directional` from that agent's subtree, and its emitted JSON gains `directional_recollected: boolean` and `via: string|null`.

**Design notes the implementer must honour:**
- `collectAndStamp` defaults `mode` to `'subtree'` when the caller passed no
  explicit `--mode` and no `--transcript`. An explicit `--mode`/`--transcript`
  always wins, so `backfill-directional` and hand invocations are unaffected.
- `sessionId` comes from `v['session-id'] ?? process.env.CLAUDE_CODE_SESSION_ID ?? null`.
- **Do not weaken the clobber guard.** `stampTokensDirectional` already skips an
  empty incoming `by_model` when the record holds sums. That is what makes
  "best-effort at run-end, exact at record-observed-tokens" safe.
- `record-observed-tokens` must write `tokens_observed` **first**, then re-collect,
  so the fingerprint path has the number available even when `--agent-id` is absent.
- Re-collection is best-effort: wrap in try/catch and never fail the subcommand.

- [ ] **Step 1: Write the failing tests**

Append to `harness-core/test/tokens-collect-cli.test.mjs`, matching that file's existing
helper style for invoking the CLI and building a run dir:

```javascript
// ---- #17: subtree collection + exact agent-id re-collection ----

test('tokens-collect defaults a phase run to subtree mode via the session env', () => {
  // A run whose cwd maps to a project dir containing <session>/subagents with
  // one driver + one child. No --mode, no --subagents-dir: the CLI derives both.
  const { runDir, cwd, sessionId } = makeSubtreeRun();   // helper: see below
  const out = runCli(['tokens-collect', '--run-dir', runDir, '--cwd', cwd], {
    env: { CLAUDE_CODE_SESSION_ID: sessionId },
  });
  assert.equal(out.ok, true);
  assert.equal(out.via, 'all_drivers');
  assert.ok(Object.keys(out.tokens_directional.by_model).length > 0, 'by_model must not be empty');
});

test('record-observed-tokens --agent-id re-collects that agent subtree exactly', () => {
  const { runDir, cwd, sessionId, driverId } = makeSubtreeRun();
  const out = runCli([
    'record-observed-tokens', '--run-dir', runDir, '--total', '110', '--tier', 'HIGH',
    '--agent-id', driverId, '--cwd', cwd,
  ], { env: { CLAUDE_CODE_SESSION_ID: sessionId } });
  assert.equal(out.directional_recollected, true);
  assert.equal(out.via, 'subtree');
  assert.equal(out.tokens_observed.total, 110);
  const rec = JSON.parse(readFileSync(join(runDir, 'record.json'), 'utf8'));
  // Both the driver's model and its child's model must be present — the whole subtree.
  assert.deepEqual(Object.keys(rec.tokens_directional.by_model).sort(),
    ['claude-opus-5', 'claude-sonnet-4-6']);
  assert.equal(rec.tokens_directional.complete, true);
});

test('record-observed-tokens without --agent-id still records observed tokens', () => {
  const { runDir } = makeSubtreeRun();
  const out = runCli(['record-observed-tokens', '--run-dir', runDir, '--total', '500', '--tier', 'HIGH']);
  assert.equal(out.tokens_observed.total, 500);
  assert.equal(out.directional_recollected, false);
});

test('an unresolvable --agent-id leaves an existing good stamp intact', () => {
  const { runDir, cwd, sessionId, driverId } = makeSubtreeRun();
  // Establish a good stamp first.
  runCli(['record-observed-tokens', '--run-dir', runDir, '--total', '110', '--tier', 'HIGH',
    '--agent-id', driverId, '--cwd', cwd], { env: { CLAUDE_CODE_SESSION_ID: sessionId } });
  const before = JSON.parse(readFileSync(join(runDir, 'record.json'), 'utf8')).tokens_directional;
  // Now a bogus agent id: the clobber guard must protect the good sums.
  runCli(['record-observed-tokens', '--run-dir', runDir, '--total', '110', '--tier', 'HIGH',
    '--agent-id', 'does-not-exist', '--cwd', cwd], { env: { CLAUDE_CODE_SESSION_ID: sessionId } });
  const after = JSON.parse(readFileSync(join(runDir, 'record.json'), 'utf8')).tokens_directional;
  assert.deepEqual(after.by_model, before.by_model, 'good sums must survive a bad re-collect');
});

test('an explicit --transcript still overrides subtree defaulting', () => {
  const { runDir, cwd, sessionId, transcriptPath } = makeSubtreeRun();
  const out = runCli(['tokens-collect', '--run-dir', runDir, '--cwd', cwd,
    '--transcript', transcriptPath], { env: { CLAUDE_CODE_SESSION_ID: sessionId } });
  assert.equal(out.via, 'explicit');
});
```

The implementer writes `makeSubtreeRun()` in that test file. It must: create a temp
repo cwd with `.harness/runs/<id>/record.json` (valid per `run-record.schema.json`,
with `started_at` and `ended_at` bracketing the fixture timestamps), create
`<home>/.claude/projects/<munged cwd>/<sessionId>/subagents/` containing
`agent-<driverId>.{jsonl,meta.json}` (model `claude-opus-5`, 100 input / 10 output,
`spawnDepth: 1`) and `agent-<kidId>.{jsonl,meta.json}` (model `claude-sonnet-4-6`,
40 input / 4 output, `parentAgentId: <driverId>`), and return
`{ runDir, cwd, sessionId, driverId, transcriptPath }`. Follow how the file's
existing tests set `HOME`/`--cwd` for the CLI; if they cannot override `HOME`, pass
`--project-dir` explicitly instead and note that in the report.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd harness-core && node --test test/tokens-collect-cli.test.mjs`
Expected: FAIL — `--agent-id` is not a known option / `directional_recollected` undefined.

- [ ] **Step 3: Write the implementation**

In `harness.mjs`, extend the option table:

```javascript
const TOKENS_COLLECT_OPTS = {
  transcript: { type: 'string' }, mode: { type: 'string' },
  'subagents-dir': { type: 'string' }, 'project-dir': { type: 'string' },
  cwd: { type: 'string' }, 'gap-cap-ms': { type: 'string' },
  start: { type: 'string' }, end: { type: 'string' },
  'agent-id': { type: 'string' }, 'session-id': { type: 'string' },
};
```

In `collectAndStamp`, default the mode and thread the new values:

```javascript
function collectAndStamp(v, routing) {
  const runDir = v['run-dir'];
  const record = readRecord(runDir);
  const now = new Date();
  const sessionId = v['session-id'] ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
  // Default a phase run to subtree collection. The old default (standalone
  // newest-mtime top-level transcript) cannot find harness tokens at all: the
  // orchestrator is idle while a phase runs, so 100% of the spend is in
  // <session>/subagents/agent-*.jsonl. An explicit --mode or --transcript still
  // wins, which keeps backfill and hand invocations on their existing paths.
  const mode = v.mode ?? (v.transcript ? undefined : 'subtree');
  const { tokens_directional, note, source, via } = collectForRun({
    transcript: v.transcript,
    mode,
    subagentsDir: v['subagents-dir'],
    projectDir: v['project-dir'],
    cwd: v.cwd ?? process.cwd(),
    sessionId,
    // Exact identity when the orchestrator knew it (record-observed-tokens
    // --agent-id); otherwise the fingerprint or all-drivers path.
    agentId: v['agent-id'] ?? null,
    start: v.start ?? record.started_at ?? null,
    end: v.end ?? record.ended_at ?? now.toISOString(),
    gapCapMs: v['gap-cap-ms'] !== undefined ? Number(v['gap-cap-ms']) : undefined,
    modelTierMap: routing.model_id_to_tier ?? {},
    observedTotal: record.tokens_observed?.total ?? null,
    now,
  });
  stampTokensDirectional({ runDir, tokensDirectional: tokens_directional });
  if (note) {
    appendAudit(dirname(dirname(runDir)), {
      ts: now.toISOString(),
      run_id: record.run_id,
      event: 'note',
      data: { type: 'tokens', estimated: true, complete: false, reason: note.code, detail: note.detail },
    });
  }
  return { complete: tokens_directional.complete, degraded: !!note, source, via };
}
```

Rewrite the `record-observed-tokens` case:

```javascript
    case 'record-observed-tokens': {
      const v = opts({
        'run-dir': { type: 'string' }, total: { type: 'string' }, tier: { type: 'string' },
        source: { type: 'string' }, ...TOKENS_COLLECT_OPTS,
      });
      const record = recordObservedTokens({
        runDir: v['run-dir'],
        total: Number(v.total),
        tier: v.tier,
        source: v.source ?? 'agent_tool_usage_tag',
      });
      // The orchestrator is the ONLY party that knows which agent ran this phase:
      // the Agent-tool dispatch result carries `agentId`, and a subagent's own env
      // does not (its CLAUDE_CODE_SESSION_ID is the parent's). So this is the one
      // call site that can attribute exactly. The driver already stamped
      // best-effort at its own run-end; this overwrites it with authoritative sums.
      // Best-effort: never fail the cost update over enrichment, and never clobber
      // a good stamp with an empty one (stampTokensDirectional guards that).
      let recollected = false;
      let via = null;
      if (v['agent-id']) {
        try {
          const { routing } = resolveConfig();
          const summary = collectAndStamp(v, routing);
          recollected = true;
          via = summary.via ?? null;
        } catch {
          /* enrichment only; tokens_observed is already written */
        }
      }
      const telemetry = telemetryFromConfig();
      const sync = syncRun({ runDir: v['run-dir'], telemetry });
      emit({
        status: record.status,
        tokens_by_tier: record.tokens_by_tier,
        tokens_observed: record.tokens_observed,
        directional_recollected: recollected,
        via,
        synced: sync.synced,
      });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd harness-core && node --test test/tokens-collect-cli.test.mjs`
Expected: PASS.

Then: `cd harness-core && npm test`
Expected: 428 → 433 pass / 0 fail. Report the real numbers.

- [ ] **Step 5: Perturbation check**

Each must FAIL; revert after each and report actual results:

1. In `collectAndStamp`, change `const mode = v.mode ?? (v.transcript ? undefined : 'subtree')` to `const mode = v.mode` → the subtree-defaulting test must fail.
2. In `record-observed-tokens`, drop the `if (v['agent-id'])` re-collect block → the re-collect test must fail.
3. Move `recordObservedTokens(...)` to *after* the re-collect block → confirm whether any test catches the ordering. If none does, say so explicitly rather than implying coverage.

- [ ] **Step 6: Commit**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills
git add harness-core/tools/harness.mjs harness-core/test/tokens-collect-cli.test.mjs
git commit -m "harness-core: derive session for subtree collect, add --agent-id re-collection (#17)"
```

---

### Task 4: pass `--agent-id` from the loop orchestrator

**Files:**
- Modify: `harness-loop-core/SKILL.md` — step 6, around line 167

**Interfaces:**
- Consumes from Task 3: `record-observed-tokens --agent-id <id>`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Read the current step 6 text**

Run: `grep -n "record-observed-tokens" harness-loop-core/SKILL.md` and read ~15
lines either side. The step currently passes `--run-dir`, `--total`, `--tier`.

- [ ] **Step 2: Update the instruction**

Add `--agent-id` to the documented invocation, and state where the value comes
from. The orchestrator already reads `subagent_tokens` off the dispatch result; the
`agentId` field sits on the same result object. Keep the file's existing voice and
formatting. The instruction must convey:

- Pass `--agent-id <agentId from the Agent dispatch result for this phase's driver>`.
- It is the same result object the `subagent_tokens` total is read from.
- If the id is unavailable (hand-run, crashed driver), omit the flag — collection
  degrades to the fingerprint or all-drivers path rather than failing.

Do **not** add a `--mode`/`--subagents-dir` instruction. Those are derived now; the
whole point of Task 3's defaulting is that no skill has to remember them.

- [ ] **Step 3: Verify no other skill passes the superseded flags**

Run: `grep -rn -e "--subagents-dir" -e "--mode loop" --include='*.md' . | grep -v node_modules`
Expected: no *instructional* occurrences in skill files. Documentation of the
backfill CLI is fine. Report what you find.

- [ ] **Step 4: Commit**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills
git add harness-loop-core/SKILL.md
git commit -m "harness-loop-core: pass --agent-id to record-observed-tokens (#17)"
```

---

### Task 5: verify against the real TARS-1271 ground truth

**Files:**
- Create: `harness-core/docs/notes/subtree-attribution-verification.md`

This task writes no product code. It proves the fix works against data already on
disk — no live pipeline run required. Every expected number comes from the
Background section; they were measured before this plan was written.

**Interfaces:**
- Consumes: the finished CLI from Task 3.
- Produces: the verification note. Nothing consumes it.

- [ ] **Step 1: Confirm the ground-truth data is still present**

```bash
SD="$HOME/.claude/projects/-Users-206618626-bwt3-com-Desktop-Repos-webtarsthree/7dca0ac9-73d7-4330-bc97-15c014e9c0d8/subagents"
ls -1 "$SD"/*.meta.json | wc -l    # expect 14
ls -1 "$HOME/Desktop/Repos/webtarsthree/.harness/runs" | wc -l   # expect 4
```

If either is gone, STOP and report — do not fabricate the numbers.

- [ ] **Step 2: Verify the tree and the rollup reproduce the measured facts**

Write a throwaway script (do not commit it) that uses `readAgentTree`,
`driversOf`, `descendantsOf`, and `collectFromFiles` against `$SD`, and assert:

| Check | Expected |
|---|---|
| agents in the tree | 14 |
| `driversOf` count | 3 |
| driver `a0efe4645d03748de` subtree total (all 4 directions) | **308,519,206** |
| that driver's own-file total | **233,607,665** |
| sum of the 3 driver subtrees | **332,537,207** |
| grand total over all 14 agents | **332,537,207** (equal — partition holds) |
| `peak_context` of `a0efe4645d03748de` | **532,540** |
| seats present | `client_unit_test_writer`, `general-purpose`, `Explore`, `senior_frontend_engineer`, `hp-architect` |

- [ ] **Step 3: Verify the CLI produces a non-empty stamp where it previously produced `{}`**

Copy the failed implement run dir to a temp location (do **not** mutate the
original — it is the evidence), then run the real CLI against the copy:

```bash
cp -R "$HOME/Desktop/Repos/webtarsthree/.harness/runs/2026-07-28T084525Z__webtarsthree__implement__issue-tars-1271__202956" /tmp/verify-run
node harness-core/tools/harness.mjs record-observed-tokens \
  --run-dir /tmp/verify-run --total 532540 --tier HIGH \
  --agent-id a0efe4645d03748de \
  --project-dir "$HOME/.claude/projects/-Users-206618626-bwt3-com-Desktop-Repos-webtarsthree" \
  --session-id 7dca0ac9-73d7-4330-bc97-15c014e9c0d8
node -e "const r=require('/tmp/verify-run/record.json'); console.log(JSON.stringify(r.tokens_directional,null,2))"
```

Assert: `by_model` is **non-empty** (it was `{}`), contains `claude-opus-5` and
`claude-sonnet-4-6`, and `complete` is `true`. The `<synthetic>` id may also appear
— that is expected and must resolve to a tier (routing.json has it).

If `--project-dir`/`--session-id` are not both honoured, that is a Task 3 gap:
report it as a finding rather than working around it.

- [ ] **Step 4: Confirm the copy's window does not exclude the subtree**

The record's window is `08:45:25.198Z` → `13:02:02.605Z`; the subtree's usage lines
sit inside it (measured: 752/147/147/140/86/85/81/51/22 lines in-window). Confirm
the stamped sums are non-zero, which proves windowing is not interfering — this is
the evidence that closes the window half of #19.

- [ ] **Step 5: Write the note**

Create `harness-core/docs/notes/subtree-attribution-verification.md` recording:
the root cause (one paragraph), the ground-truth table from Step 2 with
measured-vs-expected, the before/after of the implement record's `by_model`, and
the residual limitation stated plainly — **`all_drivers` over-attributes when two
phases share one session**, which is acceptable because the alternative measured
0 tokens, and `--agent-id` avoids it entirely on the loop path.

Also note what this does **not** prove: the fix has not run inside a live tick. The
first real tick is still the e2e baseline, and #16's OTel side-car is the
independent second measurement.

- [ ] **Step 6: Commit**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills
git add harness-core/docs/notes/subtree-attribution-verification.md
git commit -m "harness-core: document subtree attribution verification against TARS-1271 (#17)"
```

---

## Self-Review

**Spec coverage.** #17's two halves: the derive-the-subagents-dir half is Task 2
(`subagentsDirForSession`) + Task 3 (defaulting `mode` to `'subtree'`, reading
`CLAUDE_CODE_SESSION_ID`); the exact-identification half is Task 3's `--agent-id`
plus Task 4's skill contract. #19's surviving item — refuse-on-empty on the live
path — is Task 2's `collectFromFiles` returning `no_usage` and
`resolveTranscripts` refusing rather than falling back, matching
`backfillDirectional`. #19's window half is dropped by decision (windowing was
exonerated by measurement) and its `complete: true` half already shipped. The
subtree rollup (fact 5) is not in either ticket as filed — it was found while
diagnosing, and shipping the fix without it would leave a 24% undercount, so it is
in scope here.

**Placeholder scan.** Every code step carries real code. The two places an
implementer must write something not spelled out are called out explicitly with
their requirements: `makeSubtreeRun()` in Task 3 Step 1, and the throwaway
verification script in Task 5 Step 2 (with its full expected-value table).

**Type consistency.** `readAgentTree` returns `{ok, agents: Map, error}` and is
consumed as `tree.agents` / `tree.ok` in Task 2. `resolveTranscripts` returns
`paths` (plural array) throughout; `resolveTranscript` keeps `path` (singular) and
is untouched. `collectFromFiles` returns the `collectFromFile` shape so
`buildTokensDirectional` needs no change. `via` values are the same six strings in
Task 2's implementation, its tests, and Task 3's emitted JSON.

**One risk worth naming.** Task 2 changes `collectForRun`, which three call sites
share (phase-end 228, run-end 260, tokens-collect 370). The mode defaulting lives
in `collectAndStamp`, so all three change behaviour together — intended, and the
reason Task 5 verifies at CLI level rather than only in unit tests.
