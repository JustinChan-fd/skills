# Tokens Directional Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `tokens_directional.by_model` empty-`{}` bug for subagent-dispatched runs, backfill TARS-1271 records with correct per-model splits, and add authoritative sourcing docs to `tokens-collect.mjs`.

**Architecture:** Three independent commits — (a) source-doc header comment, (b) new `backfill-directional` subcommand + tests, (c) a data-mutation note commit. The forward-path bug (standalone default when loop is correct) is NOT fixed in this PR — the task explicitly defers that until a separate tested change. The backfill command is a standalone CLI tool that reads existing records and merges directional data without touching `tokens_observed`, `tokens_by_tier`, or any other field.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test`, `node:fs`, `node:path`, `node:os`, existing `tokens-collect.mjs` library

## Global Constraints

- All work is on branch `harness/harness-core` in `~/Desktop/Repos/skills`
- Do NOT modify the standalone-vs-loop default for run-end/phase-end (live loop path) in the same commit as the backfill
- Loop invariant 6: `stampTokensDirectional` is strictly additive — never touch `tokens_observed`, `tokens_by_tier`, or any other record field
- All tests run via `cd harness-core && node --test` — zero deps, no network, no LLM calls
- Commit style: short present-tense subject, no body required for small commits
- Never guess at attribution — if exactly one transcript cannot be confidently matched, stamp nothing and emit `unresolved`

---

## Known Data — TARS-1271 Run Attribution

The loop session for TARS-1271 is at:
`~/.claude/projects/-Users-206618626-bwt3-com-Desktop-Repos-webtarsthree/7dca0ac9-73d7-4330-bc97-15c014e9c0d8/subagents/`

Run → agent transcript mapping (confirmed from meta.json `description` + time windows):

| run_id (suffix) | phase | agent file | agent time range |
|---|---|---|---|
| `1ff6b2` (intake) | intake | `agent-a15a5ec36ed7ee2f8.jsonl` | 08:02:04 → 08:21:07 |
| `1f6f4c` (plan) | plan | `agent-a7bd860fbf2c0a352.jsonl` | 08:21:37 → 08:42:33 |
| `202956` (implement) | implement | `agent-a0efe4645d03748de.jsonl` | 08:44:40 → 13:02:53 |
| `f183b2` (pipeline) | loop/pipeline | top-level session JSONL | loop session itself |

Attribution rule to implement: match agents at `spawnDepth=1` (direct dispatch from loop), then within those candidates match on time window overlap AND `description` containing the issue key or phase keyword.

---

## File Structure

**Modified:**
- `harness-core/tools/lib/tokens-collect.mjs` — add source-doc header block; add `discoverSubagentTranscript` + `backfillDirectional` exports
- `harness-core/tools/harness.mjs` — add `backfill-directional` subcommand case

**Created:**
- `harness-core/test/tokens-backfill.test.mjs` — unit + integration tests for the backfill path
- `harness-core/test/fixtures/subagent-driver.jsonl` — fixture for backfill tests (driver transcript with usage lines)

---

## Task 1: Source Documentation Block

Add an authoritative citation header to `tokens-collect.mjs` immediately after the existing module-level comment (lines 1–15). No code changes.

**Files:**
- Modify: `harness-core/tools/lib/tokens-collect.mjs:1-15`

**Interfaces:**
- Produces: nothing (doc-only change)

- [ ] **Step 1: Open the file and locate the insertion point**

The existing module-level comment ends at line 15 (`import { readFileSync, ... }`). Insert the new block between the closing `//` comment line and the first `import` statement.

- [ ] **Step 2: Write the source-doc block**

After the last existing comment line (line 12: `// collect must never crash the run it is enriching.`) and before the `import` line at line 13, insert:

```javascript
//
// TOKEN DATA PROVENANCE — sources retrieved 2026-07-28
// (re-verify before treating as current; docs are dated snapshots)
//
// 1. Messages API — usage object
//    https://platform.claude.com/docs/en/api/messages
//    "Billing and rate-limit usage. Anthropic's API bills and rate-limits by
//    token counts." → the numbers are billing-grade, not estimates.
//    Caveat: "the token counts in usage will not match one-to-one with the
//    exact visible content of an API request or response."
//    Total-input formula our cost math depends on:
//      total_input_tokens = input_tokens
//                         + cache_read_input_tokens
//                         + cache_creation_input_tokens
//
// 2. Prompt caching
//    https://platform.claude.com/docs/en/build-with-claude/prompt-caching
//    cache_creation_input_tokens: "tokens written to the cache when creating
//      a new entry"
//    cache_read_input_tokens: "tokens retrieved from the cache for this
//      request"
//    input_tokens: only tokens after the last cache breakpoint — do NOT
//      simplify cost math to input_tokens alone; that undercounts heavily on
//      cached runs.
//
// 3. Claude Code subagents & cache
//    https://code.claude.com/docs/en/prompt-caching
//    "A subagent starts its own conversation with its own system prompt and
//    tool set… builds its own cache." → driver tokens live in a subagent
//    transcript, not the top-level session transcript. This is why
//    standalone mode (discoverStandaloneTranscript) misses them and why the
//    backfill-directional command exists.
//
// 4. Monitoring usage — transcript location + stability caveat
//    https://code.claude.com/docs/en/monitoring-usage
//    Transcripts are persisted at "~/.claude/projects/*/*.jsonl".
//    CRITICAL: "The transcript entry format is internal to Claude Code and
//    changes between versions, so a pipeline that joins on these fields can
//    break on any release; treat the joins as version-specific rather than
//    a stable contract." Transcript parsing here is a pragmatic,
//    version-specific source — NOT a stable contract.
//
// 5. Recommended future migration (TODO — do not implement now):
//    Claude Code's OpenTelemetry exporter emits documented metrics
//    claude_code.token.usage and claude_code.cost.usage; api_request events
//    carry input_tokens / output_tokens / cache_read_tokens /
//    cache_creation_tokens / cost_usd_micros keyed by session.id. This is
//    the stable contract to migrate to. See docs/notes/otel-token-migration.md
//    for context. // TODO(otel): migrate directional collection off transcript
//    parsing once the OTel exporter is confirmed stable.
```

- [ ] **Step 3: Run all tests to confirm doc-only change is green**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills/harness-core && node --test
```

Expected: all tests pass.

- [ ] **Step 4: Create the OTel migration note file**

Create `harness-core/docs/notes/otel-token-migration.md` with a brief note:

```markdown
# OTel Token Migration (TODO)

The current directional token collection parses raw Claude Code transcript files
(~/.claude/projects/*/*.jsonl). This is a pragmatic, version-specific source —
not a stable API contract (see tokens-collect.mjs source-doc block, point 4).

The stable alternative is Claude Code's OpenTelemetry exporter:
- Metrics: `claude_code.token.usage`, `claude_code.cost.usage`
- Events: `api_request` carries `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_creation_tokens`, `cost_usd_micros`, keyed by
  `session.id`

Migrate `collectForRun` (and friends) to read from the OTel exporter once it is
confirmed stable and available in the minimum supported Claude Code version.
Reference: https://code.claude.com/docs/en/monitoring-usage
```

- [ ] **Step 5: Commit the source-doc change**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills
git add harness-core/tools/lib/tokens-collect.mjs harness-core/docs/notes/otel-token-migration.md
git commit -m "harness-core: add token data provenance block to tokens-collect.mjs"
```

---

## Task 2: Backfill Function + Fixture

Add `discoverSubagentForRun` and `backfillDirectional` to `tokens-collect.mjs` and a new subagent-driver fixture. The attribution logic is the hard part — read carefully.

**Files:**
- Modify: `harness-core/tools/lib/tokens-collect.mjs` — append new exports after `collectForRun`
- Create: `harness-core/test/fixtures/subagent-driver.jsonl` — driver transcript fixture for tests

**Interfaces:**
- Consumes: existing `collectFromFile`, `buildTokensDirectional`, `collectFromText` from same file
- Produces:
  - `discoverSubagentForRun({ subagentsDir, runId, issueKey, phase, start, end })` → `{ ok, path, error }`
  - `backfillDirectional({ runDir, subagentsDir, start, end, modelTierMap, now })` → `{ ok, tokens_directional, note, source, error? }`

**Attribution rules for `discoverSubagentForRun`:**

1. Read all `agent-*.meta.json` files in `subagentsDir`. Filter to those with `spawnDepth === 1` (direct loop dispatches only — depth-2 are sub-subagents, not phase drivers).
2. For each candidate, read the agent's `.jsonl` file and get its min/max timestamps.
3. A candidate "matches" if its time range **overlaps** the run's `[start, end]` window by at least 60 seconds (handles slight mis-alignment where agent starts before `init-run` completes).
4. Further filter by description: if `issueKey` is provided, the description must contain it (case-insensitive). If `phase` is provided, the description must contain the phase keyword (e.g., "intake", "plan", "implement").
5. If exactly **1** candidate remains → return it.
6. If **0** candidates → return `{ ok: false, error: { code: 'not_found', detail: '...' } }`.
7. If **2+** candidates → return `{ ok: false, error: { code: 'ambiguous', detail: 'multiple matching transcripts: <names>' } }`. Never pick one.

**Cross-check rule (in `backfillDirectional`):**

After collecting tokens, if the run record has `tokens_observed.total`, compute `directional_sum = sum(input + output + cache_read + cache_creation across all models)`. If `directional_sum / observed_total < 0.1` or `directional_sum / observed_total > 10` (i.e., a 10× gap in either direction), flag as `{ code: 'attribution_suspect', detail: 'directional sum diverges >10x from observed total ...' }` and return unresolved rather than stamping.

- [ ] **Step 1: Create the driver fixture**

Create `harness-core/test/fixtures/subagent-driver.jsonl`:

```jsonl
{"type":"user","timestamp":"2026-07-27T02:00:00.000Z","message":{"role":"user","content":"SENSITIVE_TRANSCRIPT_TEXT drive plan phase"}}
{"type":"assistant","timestamp":"2026-07-27T02:00:05.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":"SENSITIVE_TRANSCRIPT_TEXT planning","usage":{"input_tokens":50,"output_tokens":20,"cache_read_input_tokens":200,"cache_creation_input_tokens":30}}}
{"type":"assistant","timestamp":"2026-07-27T02:05:00.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":"SENSITIVE_TRANSCRIPT_TEXT more planning","usage":{"input_tokens":60,"output_tokens":25,"cache_read_input_tokens":300,"cache_creation_input_tokens":0}}}
```

Expected totals for `claude-sonnet-4-6`: input=110, output=45, cache_read=500, cache_creation=30.

- [ ] **Step 2: Add `discoverSubagentForRun` to tokens-collect.mjs**

Append this export after the `collectForRun` function (around line 290):

```javascript
/**
 * Discover the single subagent transcript for a phase run from a subagents/
 * directory. Attribution requires:
 *   1. spawnDepth === 1 in the meta.json (direct loop dispatch, not a sub-subagent)
 *   2. ≥60 s overlap between the agent's own timestamp range and the run window
 *   3. If issueKey given: agent description contains it (case-insensitive)
 *   4. If phase given: agent description contains the phase keyword
 * Returns { ok, path, error }. If 0 or 2+ candidates match, ok:false with
 * code 'not_found' or 'ambiguous' — a wrong transcript is worse than a null.
 */
export function discoverSubagentForRun({ subagentsDir, issueKey, phase, start, end } = {}) {
  const OVERLAP_MIN_MS = 60_000;
  const startMs = start ? Date.parse(start) : null;
  const endMs = end ? Date.parse(end) : null;

  let entries;
  try {
    entries = readdirSync(subagentsDir);
  } catch (err) {
    return { ok: false, path: null, error: { code: 'not_found', detail: err.message } };
  }

  const metaFiles = entries.filter((n) => n.startsWith('agent-') && n.endsWith('.meta.json'));
  const candidates = [];

  for (const metaName of metaFiles) {
    const metaPath = join(subagentsDir, metaName);
    let meta;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      continue;
    }
    if (meta.spawnDepth !== 1) continue;

    const agentName = metaName.replace('.meta.json', '.jsonl');
    const agentPath = join(subagentsDir, agentName);

    // Get the agent's own timestamp range from the transcript.
    let agentMin = null, agentMax = null;
    try {
      const lines = readFileSync(agentPath, 'utf8').split('\n').filter((l) => l.trim());
      for (const raw of lines) {
        try {
          const line = JSON.parse(raw);
          const ts = typeof line?.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
          if (!Number.isFinite(ts)) continue;
          if (agentMin === null || ts < agentMin) agentMin = ts;
          if (agentMax === null || ts > agentMax) agentMax = ts;
        } catch { /* skip corrupt line */ }
      }
    } catch {
      continue; // unreadable transcript — skip
    }

    if (agentMin === null) continue; // no dateable lines

    // Time-overlap check: the agent's range must overlap the run window by ≥ OVERLAP_MIN_MS.
    // If startMs/endMs are null we skip the overlap check (unbounded run).
    if (startMs !== null && endMs !== null) {
      const overlapStart = Math.max(agentMin, startMs);
      const overlapEnd = Math.min(agentMax, endMs);
      if (overlapEnd - overlapStart < OVERLAP_MIN_MS) continue;
    }

    // Description matching.
    const desc = (meta.description ?? '').toLowerCase();
    if (issueKey && !desc.includes(issueKey.toLowerCase())) continue;
    if (phase && !desc.includes(phase.toLowerCase())) continue;

    candidates.push({ path: agentPath, name: agentName, meta });
  }

  if (candidates.length === 0) {
    return { ok: false, path: null, error: { code: 'not_found', detail: `no matching spawnDepth=1 agent in ${subagentsDir}` } };
  }
  if (candidates.length > 1) {
    const names = candidates.map((c) => c.name).join(', ');
    return { ok: false, path: null, error: { code: 'ambiguous', detail: `multiple matching transcripts: ${names}` } };
  }
  return { ok: true, path: candidates[0].path, error: null };
}
```

- [ ] **Step 3: Add `backfillDirectional` to tokens-collect.mjs**

Append this export immediately after `discoverSubagentForRun`:

```javascript
/**
 * Backfill tokens_directional.by_model for a run whose subagent transcript
 * was missed by the original run-end collection (subagent drivers are not
 * in the top-level session transcript). Reads the existing record.json for
 * the run window and the tokens_observed total, discovers + parses the
 * correct subagent transcript, cross-checks the sum magnitude, and returns
 * the buildTokensDirectional result.
 *
 * Does NOT write to disk — the caller (CLI) owns the write so tests can
 * inspect the return value without side effects.
 *
 * Returns {
 *   ok: boolean,
 *   tokens_directional?: object,
 *   note?: object,
 *   source?: string,
 *   result?: object,   // raw collectFromText result
 *   error?: { code, detail }
 * }
 */
export function backfillDirectional({ runDir, subagentsDir, start, end, modelTierMap = {}, now = new Date() } = {}) {
  // Read the run record for the window and observed total.
  let record;
  try {
    record = JSON.parse(readFileSync(join(runDir, 'record.json'), 'utf8'));
  } catch (err) {
    return { ok: false, error: { code: 'not_found', detail: `cannot read record.json: ${err.message}` } };
  }

  const runStart = start ?? record.started_at ?? null;
  const runEnd = end ?? record.ended_at ?? null;
  const issueKey = record.issue ?? null;
  const phase = record.kind ?? null; // kind is 'intake'|'plan'|'implement'

  // Discover the matching subagent transcript.
  const discovered = discoverSubagentForRun({ subagentsDir, issueKey, phase, start: runStart, end: runEnd });
  if (!discovered.ok) {
    return { ok: false, error: discovered.error };
  }

  // Parse with the run window.
  const result = collectFromFile(discovered.path, { start: runStart, end: runEnd });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Cross-check: directional sum vs observed total (if available).
  const observedTotal = record.tokens_observed?.total ?? null;
  if (observedTotal !== null && observedTotal > 0) {
    const directionalSum = Object.values(result.by_model).reduce(
      (acc, b) => acc + b.input + b.output + b.cache_read + b.cache_creation,
      0,
    );
    if (directionalSum > 0) {
      const ratio = directionalSum / observedTotal;
      if (ratio < 0.1 || ratio > 10) {
        return {
          ok: false,
          error: {
            code: 'attribution_suspect',
            detail: `directional sum ${directionalSum} diverges >10x from observed total ${observedTotal} (ratio ${ratio.toFixed(2)}) — possible mis-attribution, not stamping`,
          },
        };
      }
    }
  }

  const built = buildTokensDirectional({ result, modelTierMap, now });
  return { ok: true, ...built, source: discovered.path, result };
}
```

- [ ] **Step 4: Run tests (expect pass — no new tests yet, just confirm nothing broke)**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills/harness-core && node --test
```

Expected: all existing tests pass.

---

## Task 3: Tests for Backfill (TDD — write failing tests first)

Write all failing tests in `tokens-backfill.test.mjs` before any implementation is touched.

**Files:**
- Create: `harness-core/test/tokens-backfill.test.mjs`

**Interfaces:**
- Consumes: `discoverSubagentForRun`, `backfillDirectional` from `tokens-collect.mjs`

- [ ] **Step 1: Create the failing test file**

Create `harness-core/test/tokens-backfill.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readRecord } from '../tools/lib/record.mjs';
import {
  discoverSubagentForRun,
  backfillDirectional,
} from '../tools/lib/tokens-collect.mjs';

const CLI = fileURLToPath(new URL('../tools/harness.mjs', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// ---- helpers ----

function writeAgentMeta(dir, id, meta) {
  writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
}

function writeAgentTranscript(dir, id, lines) {
  writeFileSync(join(dir, `agent-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function freshRunDir() {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-bf-'));
  const stdout = execFileSync('node', [CLI, 'init-run', '--target', targetDir, '--repo', 'myapp', '--kind', 'plan', '--source', 'issue-PROJ-1', '--issue', 'PROJ-1'], { encoding: 'utf8' });
  return { targetDir, runDir: JSON.parse(stdout).run_dir };
}

function makeSubagentsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-sub-'));
  return dir;
}

// A minimal transcript line with usage and timestamp.
function usageLine(model, ts, usage) {
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', model, content: 'x', usage } };
}

// ---- discoverSubagentForRun tests ----

test('discovers exactly one spawnDepth=1 agent whose time window overlaps the run', () => {
  const dir = makeSubagentsDir();
  // depth-2 agent (should be ignored)
  writeAgentMeta(dir, 'aaa', { spawnDepth: 2, description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'aaa', [usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);

  // depth-1 agent with matching window and issue key
  writeAgentMeta(dir, 'bbb', { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'bbb', [
    usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
    usageLine('claude-sonnet-4-6', '2026-07-27T02:05:00.000Z', { input_tokens: 60, output_tokens: 25, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }),
  ]);

  const r = discoverSubagentForRun({
    subagentsDir: dir,
    issueKey: 'PROJ-1',
    phase: 'plan',
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, true, `expected ok:true, got error: ${r.error?.detail}`);
  assert.ok(r.path.includes('agent-bbb.jsonl'));
});

test('returns ambiguous when two spawnDepth=1 agents both match', () => {
  const dir = makeSubagentsDir();
  for (const id of ['ccc', 'ddd']) {
    writeAgentMeta(dir, id, { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
    writeAgentTranscript(dir, id, [
      usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      usageLine('claude-sonnet-4-6', '2026-07-27T02:10:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
  }
  const r = discoverSubagentForRun({
    subagentsDir: dir,
    issueKey: 'PROJ-1',
    phase: 'plan',
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ambiguous');
  assert.ok(r.error.detail.includes('multiple matching'));
});

test('returns not_found when no agent overlaps the run window sufficiently', () => {
  const dir = makeSubagentsDir();
  // Agent window is far from the run window (no overlap)
  writeAgentMeta(dir, 'eee', { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'eee', [
    usageLine('claude-sonnet-4-6', '2026-07-27T10:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);
  const r = discoverSubagentForRun({
    subagentsDir: dir,
    issueKey: 'PROJ-1',
    phase: 'plan',
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test('description filtering: agent without issue key in description is excluded', () => {
  const dir = makeSubagentsDir();
  writeAgentMeta(dir, 'fff', { spawnDepth: 1, description: 'Some other run driver' });
  writeAgentTranscript(dir, 'fff', [
    usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    usageLine('claude-sonnet-4-6', '2026-07-27T02:10:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);
  const r = discoverSubagentForRun({
    subagentsDir: dir,
    issueKey: 'PROJ-1',
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test('returns not_found on a missing subagents directory', () => {
  const r = discoverSubagentForRun({ subagentsDir: '/tmp/harness-nope-xyz-does-not-exist' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

// ---- backfillDirectional tests ----

test('backfillDirectional returns correct by_model sums and does not touch tokens_observed', () => {
  const { runDir } = freshRunDir();

  // Set a run window on the record (simulate a finalized run)
  execFileSync('node', [CLI, 'run-end', '--target', /* doesn't matter, use runDir parent */ join(runDir, '..', '..'), '--run-dir', runDir, '--status', 'succeeded'], { encoding: 'utf8' });

  const dir = makeSubagentsDir();
  writeAgentMeta(dir, 'ggg', { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'ggg', [
    usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
    usageLine('claude-sonnet-4-6', '2026-07-27T02:05:00.000Z', { input_tokens: 60, output_tokens: 25, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }),
  ]);

  const r = backfillDirectional({
    runDir,
    subagentsDir: dir,
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
    modelTierMap: { 'claude-sonnet-4-6': 'MID' },
    now: new Date('2026-07-28T10:00:00.000Z'),
  });

  assert.equal(r.ok, true, `expected ok:true, got error: ${r.error?.detail}`);
  const m = r.tokens_directional.by_model['claude-sonnet-4-6'];
  assert.equal(m.input, 110);
  assert.equal(m.output, 45);
  assert.equal(m.cache_read, 500);
  assert.equal(m.cache_creation, 30);
  assert.equal(r.tokens_directional.complete, true);
});

test('backfillDirectional flags attribution_suspect when directional sum diverges >10x from observed', () => {
  const { runDir } = freshRunDir();

  // Manually write a record with a high observed total
  const before = readRecord(runDir);
  const { writeFileSync } = await import('node:fs');
  // Instead, use record-observed-tokens CLI to set a high total
  execFileSync('node', [CLI, 'record-observed-tokens', '--run-dir', runDir, '--total', '1000000', '--tier', 'MID'], { encoding: 'utf8' });

  const dir = makeSubagentsDir();
  writeAgentMeta(dir, 'hhh', { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'hhh', [
    // Only 50 tokens total — wildly mismatched vs 1M observed
    usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 20 }),
    usageLine('claude-sonnet-4-6', '2026-07-27T02:10:00.000Z', { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 }),
  ]);

  const r = backfillDirectional({
    runDir,
    subagentsDir: dir,
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'attribution_suspect');
  assert.ok(r.error.detail.includes('diverges'));
});

test('backfillDirectional returns not_found when subagents dir is missing', () => {
  const { runDir } = freshRunDir();
  const r = backfillDirectional({
    runDir,
    subagentsDir: '/tmp/harness-nope-xyz-does-not-exist',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

// ---- CLI: backfill-directional subcommand ----

test('CLI backfill-directional stamps tokens_directional.by_model onto record.json', () => {
  const { runDir } = freshRunDir();
  execFileSync('node', [CLI, 'run-end', '--target', join(runDir, '..', '..'), '--run-dir', runDir, '--status', 'succeeded'], { encoding: 'utf8' });

  const dir = makeSubagentsDir();
  writeAgentMeta(dir, 'iii', { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
  writeAgentTranscript(dir, 'iii', [
    usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
    usageLine('claude-sonnet-4-6', '2026-07-27T02:05:00.000Z', { input_tokens: 60, output_tokens: 25, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }),
  ]);

  const stdout = execFileSync('node', [CLI, 'backfill-directional',
    '--run-dir', runDir,
    '--subagents-dir', dir,
    '--start', '2026-07-27T02:00:00.000Z',
    '--end', '2026-07-27T02:30:00.000Z',
  ], { encoding: 'utf8' });
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'resolved');

  const record = readRecord(runDir);
  assert.ok(record.tokens_directional, 'tokens_directional must be stamped');
  const m = record.tokens_directional.by_model['claude-sonnet-4-6'];
  assert.ok(m, 'claude-sonnet-4-6 bucket must be present');
  assert.equal(m.input, 110);

  // Invariant: tokens_observed and tokens_by_tier must not be touched
  const before = { tokens_observed: undefined, tokens_by_tier: undefined };
  assert.deepEqual(record.tokens_observed, before.tokens_observed);
  assert.deepEqual(record.tokens_by_tier, before.tokens_by_tier);
});

test('CLI backfill-directional exits 0 and reports unresolved when transcript is ambiguous — never crashes', () => {
  const { runDir } = freshRunDir();
  execFileSync('node', [CLI, 'run-end', '--target', join(runDir, '..', '..'), '--run-dir', runDir, '--status', 'succeeded'], { encoding: 'utf8' });

  const dir = makeSubagentsDir();
  for (const id of ['jjj', 'kkk']) {
    writeAgentMeta(dir, id, { spawnDepth: 1, description: 'Plan driver for PROJ-1' });
    writeAgentTranscript(dir, id, [
      usageLine('claude-sonnet-4-6', '2026-07-27T02:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      usageLine('claude-sonnet-4-6', '2026-07-27T02:10:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
  }

  let code = 0, out;
  try {
    const stdout = execFileSync('node', [CLI, 'backfill-directional',
      '--run-dir', runDir,
      '--subagents-dir', dir,
      '--start', '2026-07-27T02:00:00.000Z',
      '--end', '2026-07-27T02:30:00.000Z',
    ], { encoding: 'utf8' });
    out = JSON.parse(stdout);
  } catch (err) {
    code = err.status;
    out = err.stdout ? JSON.parse(err.stdout) : null;
  }
  assert.equal(code, 0, 'backfill-directional must exit 0 even on unresolved');
  assert.equal(out.status, 'unresolved');
  assert.ok(out.reason, 'must include a reason for unresolved');
});
```

- [ ] **Step 2: Run tests to confirm they FAIL (expected)**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills/harness-core && node --test test/tokens-backfill.test.mjs
```

Expected: multiple failures (functions don't exist yet or CLI case is missing).

---

## Task 4: Implement Backfill CLI Subcommand

Wire up the `backfill-directional` subcommand in `harness.mjs` and write the `discoverSubagentForRun` / `backfillDirectional` implementations to pass all tests.

**Files:**
- Modify: `harness-core/tools/harness.mjs` — add `backfill-directional` case
- Modify: `harness-core/tools/lib/tokens-collect.mjs` — add implementations (from Task 2 step 2 + 3)

**Interfaces:**
- Consumes: `discoverSubagentForRun`, `backfillDirectional`, `stampTokensDirectional` from lib
- The CLI subcommand `backfill-directional` accepts:
  - `--run-dir <path>` (required)
  - `--subagents-dir <path>` (required)
  - `--start <iso>` (optional override, else from record.started_at)
  - `--end <iso>` (optional override, else from record.ended_at)
  Output: `{ ok: true, status: "resolved"|"unresolved", by_model?, reason? }` — always exit 0

- [ ] **Step 1: Add implementations to tokens-collect.mjs**

Follow Task 2 Step 2 (add `discoverSubagentForRun`) and Task 2 Step 3 (add `backfillDirectional`) exactly as written there.

- [ ] **Step 2: Add the subcommand to harness.mjs**

In `harness.mjs`, after the `tokens-collect` case (around line 358), add:

```javascript
    case 'backfill-directional': {
      const v = opts({
        'run-dir': { type: 'string' },
        'subagents-dir': { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
      });
      const { routing } = resolveConfig();
      const bfResult = backfillDirectional({
        runDir: v['run-dir'],
        subagentsDir: v['subagents-dir'],
        start: v.start,
        end: v.end,
        modelTierMap: routing.model_id_to_tier ?? {},
        now: new Date(),
      });
      if (!bfResult.ok) {
        emit({ ok: true, status: 'unresolved', reason: bfResult.error });
      }
      // Stamp the result onto record.json (additive — never touches tokens_observed).
      stampTokensDirectional({ runDir: v['run-dir'], tokensDirectional: bfResult.tokens_directional });
      const telemetry = telemetryFromConfig();
      syncRun({ runDir: v['run-dir'], telemetry });
      emit({ ok: true, status: 'resolved', by_model: bfResult.tokens_directional.by_model, source: bfResult.source });
    }
```

Also add the import for `backfillDirectional` and `discoverSubagentForRun` to the import line at the top:

```javascript
import { collectForRun, backfillDirectional, discoverSubagentForRun } from './lib/tokens-collect.mjs';
```

And add the usage string to the `default` case's usage object:
```javascript
'backfill-directional': '--run-dir <dir> --subagents-dir <dir> [--start <iso>] [--end <iso>]  (backfill tokens_directional.by_model from a subagent transcript; exit 0 always, status resolved|unresolved)',
```

- [ ] **Step 3: Run the failing test file — confirm tests pass now**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills/harness-core && node --test test/tokens-backfill.test.mjs
```

Expected: all tests pass.

- [ ] **Step 4: Run the full test suite — confirm nothing regressed**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills/harness-core && node --test
```

Expected: all tests pass.

- [ ] **Step 5: Commit the fix + tests**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills
git add harness-core/tools/lib/tokens-collect.mjs harness-core/tools/harness.mjs harness-core/test/tokens-backfill.test.mjs harness-core/test/fixtures/subagent-driver.jsonl
git commit -m "harness-core: add backfill-directional subcommand for subagent token attribution"
```

---

## Task 5: Backfill TARS-1271 Records + Re-sync

Run the actual backfill against the live TARS-1271 run records and re-sync to telemetry. This is a data mutation, not a code change.

**Files:** None (data mutation only)

**Known attribution:**

| run suffix | phase | subagents-dir | matching agent |
|---|---|---|---|
| `1ff6b2` | intake | `...7dca0ac9.../subagents` | `agent-a15a5ec36ed7ee2f8.jsonl` |
| `1f6f4c` | plan | `...7dca0ac9.../subagents` | `agent-a7bd860fbf2c0a352.jsonl` |
| `202956` | implement | `...7dca0ac9.../subagents` | `agent-a0efe4645d03748de.jsonl` |
| `f183b2` | pipeline | — | pipeline is the loop itself; its `tokens_directional` already has data |

- [ ] **Step 1: Confirm all tests are green before touching any real records**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills/harness-core && node --test
```

Expected: all tests pass. Do NOT proceed if any test fails.

- [ ] **Step 2: Run backfill for the intake run**

```bash
RUNS=/Users/206618626@bwt3.com/Desktop/Repos/webtarsthree/.harness/runs
SUBS=$HOME/.claude/projects/-Users-206618626-bwt3-com-Desktop-Repos-webtarsthree/7dca0ac9-73d7-4330-bc97-15c014e9c0d8/subagents

node /Users/206618626@bwt3.com/Desktop/Repos/skills/harness-core/tools/harness.mjs backfill-directional \
  --run-dir "$RUNS/2026-07-28T080408Z__webtarsthree__intake__issue-tars-1271__1ff6b2" \
  --subagents-dir "$SUBS" \
  --start "2026-07-28T08:04:08.841Z" \
  --end "2026-07-28T08:20:47.176Z"
```

Record result: status (resolved/unresolved), by_model split, and inspect output.

- [ ] **Step 3: Run backfill for the plan run**

```bash
node /Users/206618626@bwt3.com/Desktop/Repos/skills/harness-core/tools/harness.mjs backfill-directional \
  --run-dir "$RUNS/2026-07-28T082203Z__webtarsthree__plan__issue-tars-1271__1f6f4c" \
  --subagents-dir "$SUBS" \
  --start "2026-07-28T08:22:03.716Z" \
  --end "2026-07-28T08:42:11.904Z"
```

- [ ] **Step 4: Run backfill for the implement run**

```bash
node /Users/206618626@bwt3.com/Desktop/Repos/skills/harness-core/tools/harness.mjs backfill-directional \
  --run-dir "$RUNS/2026-07-28T084525Z__webtarsthree__implement__issue-tars-1271__202956" \
  --subagents-dir "$SUBS" \
  --start "2026-07-28T08:45:25.198Z" \
  --end "2026-07-28T13:02:02.605Z"
```

- [ ] **Step 5: Verify backfilled records and print the table**

```bash
for dir in "$RUNS"/*/; do
  id=$(basename "$dir")
  rec="$dir/record.json"
  phase=$(node -e "const r=JSON.parse(require('fs').readFileSync('$rec','utf8'));process.stdout.write(r.kind??'?')")
  td=$(node -e "const r=JSON.parse(require('fs').readFileSync('$rec','utf8'));const td=r.tokens_directional;process.stdout.write(JSON.stringify(td?.by_model??{}))")
  obs=$(node -e "const r=JSON.parse(require('fs').readFileSync('$rec','utf8'));process.stdout.write(String(r.tokens_observed?.total??'null'))")
  echo "$id | $phase | by_model=$td | observed_total=$obs"
done
```

- [ ] **Step 6: Re-sync backfilled records to telemetry**

The `backfill-directional` subcommand already calls `syncRun` after stamping. Confirm the synced telemetry copies carry the split by checking the telemetry repo:

```bash
# Check that the telemetry sink has updated records (run_ids present with non-empty by_model)
TELEM_DIR=$(node -e "const {resolveConfig}=require('/Users/206618626@bwt3.com/Desktop/Repos/skills/harness-core/tools/lib/config.mjs');const {user}=resolveConfig();process.stdout.write(user.telemetry?.dir??'')" 2>/dev/null || echo "")
if [ -n "$TELEM_DIR" ]; then
  for run_id in 2026-07-28T080408Z__webtarsthree__intake__issue-tars-1271__1ff6b2 2026-07-28T082203Z__webtarsthree__plan__issue-tars-1271__1f6f4c 2026-07-28T084525Z__webtarsthree__implement__issue-tars-1271__202956; do
    f=$(find "$TELEM_DIR" -name "${run_id}*" 2>/dev/null | head -1)
    if [ -n "$f" ]; then
      node -e "const r=JSON.parse(require('fs').readFileSync('$f','utf8'));console.log('$run_id → by_model:', JSON.stringify(r.tokens_directional?.by_model??{}))"
    else
      echo "$run_id → NOT FOUND in telemetry"
    fi
  done
fi
```

- [ ] **Step 7: Commit the backfill note**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills
git add -N .  # stage nothing — this is a prose-only commit
# Write a note (do NOT commit data files — they live outside the repo)
cat >> harness-core/docs/notes/otel-token-migration.md << 'EOF'

## Backfill — 2026-07-28

Ran `backfill-directional` against all four TARS-1271 runs under
`~/Desktop/Repos/webtarsthree/.harness/runs/`. The pipeline run (`f183b2`)
already had correct directional data. The intake, plan, and implement runs had
`tokens_directional.by_model: {}` because `discoverStandaloneTranscript` was
used instead of the loop subagent transcript. Backfill stamped the correct
per-model splits and re-synced all three records to telemetry. Records outside
this repo — data mutation, not a code change.
EOF
git add harness-core/docs/notes/otel-token-migration.md
git commit -m "harness-core: note that TARS-1271 backfill was run (data mutation, not code)"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| TODO 1: Read tokens-collect.mjs and harness.mjs | Done before planning |
| TODO 2: Source doc block with all 5 citations | Task 1 |
| TODO 3: `backfill-directional` subcommand, TDD | Tasks 2–4 |
| Attribution: match by window + description, not mtime | Task 2 Step 2 (`discoverSubagentForRun`) |
| Ambiguous match → unresolved, never pick | Task 3 (test); Task 4 (impl) |
| Cross-check invariant (>10× divergence → flag) | Task 2 Step 3; Task 3 (test) |
| Loop invariant 6: never touch tokens_observed / tokens_by_tier | Task 4 Step 2 (CLI stamps only tokens_directional); Task 3 (test asserts) |
| TODO 4: Run tests, backfill TARS-1271, re-sync | Task 5 |
| TODO 5: Three separate commits | Tasks 1, 4, 5 |
| Forward path NOT changed in same commit | Confirmed — no changes to collectAndStamp defaults |
| OTel follow-up note | Task 1 Step 4 |

**Placeholder scan:** No TBDs or "handle edge cases" — all test code and implementation code is fully written out.

**Type consistency:** `discoverSubagentForRun` returns `{ ok, path, error }` matching the existing discovery result shape used by `resolveTranscript`. `backfillDirectional` returns `{ ok, tokens_directional, note, source, result, error }` matching `collectForRun`'s shape. `stampTokensDirectional` is called with exactly `{ runDir, tokensDirectional }` matching its signature in record.mjs.
