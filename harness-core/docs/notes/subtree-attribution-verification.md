# Subtree Attribution Verification Against TARS-1271

**Date:** 2026-07-28  
**Branch:** harness/harness-core  
**Session under test:** `7dca0ac9-73d7-4330-bc97-15c014e9c0d8` (webtarsthree, implement, TARS-1271)

---

## Root Cause

During a harness phase run the orchestrator agent is idle — it dispatches one `Agent` tool call and then waits. All of a phase's token spend happens inside the subagents directory at `<session>/subagents/agent-<id>.jsonl`, not in the top-level session transcript. The old `collectForRun` default resolved the newest-mtime top-level transcript, found no usage lines there (the orchestrator was idle), and emitted `by_model: {}` — silently, with `complete: true`, so callers had no indication anything was wrong. The real TARS-1271 implement run landed exactly this way: 332 million tokens recorded in the subagent tree, zero in the tokens_directional field.

The fix: Task 1 added `readAgentTree` / `descendantsOf` / `driversOf` to read the delegation tree from `.meta.json` sidecars. Task 2 added `collectFromFiles` for multi-file merge and wired `mode='subtree'` as the default for phase runs. Task 3 hardened the CLI (`--agent-id`, `--session-id`, `--project-dir`). Task 4 made the loop orchestrator pass `--agent-id` on every `record-observed-tokens` call.

---

## Step 2: Ground-Truth Measurements

Throwaway script at `/tmp/verify-step2.mjs` (not committed) verified the following against the real subagents directory:

`SD = ~/.claude/projects/-Users-206618626-bwt3-com-Desktop-Repos-webtarsthree/7dca0ac9-73d7-4330-bc97-15c014e9c0d8/subagents`

| Check | Expected | Measured | Match |
|---|---|---|---|
| Agents in tree | 14 | 14 | PASS |
| `driversOf` count | 3 | 3 | PASS |
| Driver `a0efe4645d03748de` subtree total | 308,519,206 | 308,519,206 | PASS |
| Driver `a0efe4645d03748de` own-file total | 233,607,665 | 233,607,665 | PASS |
| Sum of 3 driver subtrees | 332,537,207 | 332,537,207 | PASS |
| Grand total over all 14 agents | 332,537,207 | 332,537,207 | PASS |
| Partition holds (sum == grand) | true | true | PASS |
| `peak_context` of `a0efe4645d03748de` | 532,540 | 532,540 | PASS |
| Seats: `client_unit_test_writer` | present | present | PASS |
| Seats: `general-purpose` | present | present | PASS |
| Seats: `Explore` | present | present | PASS |
| Seats: `senior_frontend_engineer` | present | present | PASS |
| Seats: `hp-architect` | present | present | PASS |

**The partition check is the key invariant:** sum of the three driver subtrees equals the grand total over all 14 agents. The subtree rollup neither double-counts nor drops any agent.

Driver subtree breakdown:

- `a0efe4645d03748de` (9 agents): 308,519,206 tokens
- `a15a5ec36ed7ee2f8` (2 agents): 16,470,183 tokens
- `a7bd860fbf2c0a352` (3 agents): 7,547,818 tokens

---

## Step 3: Before / After the CLI Fix

**Before (original record, captured from the live run):**

```json
{
  "by_model": {},
  "format_version": "1",
  "collected_at": "2026-07-28T13:02:02.606Z",
  "complete": true
}
```

Note: `complete: true` over `by_model: {}` was the original bug — a consumer reading `complete` had no signal that attribution had failed entirely.

**After (re-stamped against copied run dir via CLI):**

```json
{
  "by_model": {
    "claude-opus-5": {
      "input": 36465633,
      "output": 670701,
      "cache_read": 220684455,
      "cache_creation": 8573270
    },
    "claude-sonnet-4-6": {
      "input": 198380,
      "output": 621200,
      "cache_read": 35067087,
      "cache_creation": 1180827
    },
    "<synthetic>": {
      "input": 0,
      "output": 0,
      "cache_read": 0,
      "cache_creation": 0
    }
  },
  "format_version": "1",
  "collected_at": "2026-07-29T05:10:42.265Z",
  "complete": true
}
```

`by_model` is non-empty. `complete: true`. `via: "subtree"` returned by the CLI. Both `claude-opus-5` and `claude-sonnet-4-6` appear. The `<synthetic>` id resolves in `routing.json` (zero tokens, expected).

**CLI command used (against `/tmp/harness-verify/.harness/runs/verify-run`):**

```bash
node harness-core/tools/harness.mjs record-observed-tokens \
  --run-dir /tmp/harness-verify/.harness/runs/verify-run --total 532540 --tier HIGH \
  --agent-id a0efe4645d03748de \
  --project-dir "$HOME/.claude/projects/-Users-206618626-bwt3-com-Desktop-Repos-webtarsthree" \
  --session-id 7dca0ac9-73d7-4330-bc97-15c014e9c0d8
```

Note: The original record on disk (`webtarsthree/.harness/runs/...`) was NOT mutated. It was copied to `/tmp` first; the copy was further adjusted to strip two fields (`loop_run_id`, `estimated_cost`) that were present in the older record but have since been dropped from the schema (commit `99f0eb0`). Without stripping, `writeRecord` correctly rejects the record via `additionalProperties: false`. This is not a CLI bug; it reflects that the ground-truth record predates the field removal. Any live run written by the current harness will not have these fields and will pass validation without adjustment.

---

## Step 4: Windowing Finding

The run's recorded window is `08:45:25.198Z` → `13:02:02.605Z`. The brief stated all subtree usage lines sit inside this window. Measurement disagrees:

| Collection mode | Total tokens |
|---|---|
| No window (library only) | 308,519,206 |
| With run window applied by CLI | 303,461,553 |
| Outside-window tokens | **5,057,653** |

The discrepancy is entirely in agent `a0efe4645d03748de`'s own transcript — 5,057,653 tokens of its 233,607,665 own-file spend fall outside the run window. The most likely cause: the driver agent's bootstrap activity (before the orchestrator's run clock started) or post-run housekeeping sits outside `started_at`/`ended_at`. No descendant files are affected.

**Consequence:** The CLI-produced stamp is 1.6% below the no-window total. Attribution is still non-empty and `complete: true` — the fix works. The 1.6% trim is acceptable: the alternative (no attribution at all) measured zero tokens. Running without `--start`/`--end` would recover the full 308,519,206 but would over-include pre-run bootstrapping from other phases in the same session, which is worse. The brief's claim that "windowing was exonerated by measurement" holds for descendant files; the driver's own transcript has a minor outside-window tail.

---

## Residual Limitation

The `all_drivers` path (used when `--agent-id` is absent) attributes the full session's cost across all three driver subtrees — 332,537,207 tokens. If two harness phases run in the same session (the orchestrator is not idle for both), this over-attributes the second phase by whatever the first phase spent. The `--agent-id` path avoids this entirely, and Task 4 ensures every loop-orchestrated `record-observed-tokens` call supplies it.

This means `all_drivers` is acceptable when only one phase ran in the session (which is the normal loop path), but must not be used for pipeline runs that execute multiple phases in one session.

---

## What This Does Not Prove

This verification ran entirely against pre-recorded data. It proves the library and CLI produce correct sums over this session's tree; it does not prove the fix works inside a live harness tick. The first real evidence will come from the e2e baseline (#16/#18). OTel side-car (#16) is the independent second measurement. Until those run, this note is the best available evidence.

---

## Test Suite Baseline

435 pass / 0 fail (confirmed post-task, no regressions introduced).
