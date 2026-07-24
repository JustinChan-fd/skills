# harness-intake — Decision & Change Log

A running journal of paradigm shifts, key decisions, and bug fixes. Most recent first.

---

## 2026-07-24 — Pre-coordinator dedup + path normalization

**Problem:** Coordinator was receiving 41 subtask drafts (304 file refs, 45k chars) and stalling on all 6 retry attempts (180s each). Two root causes:
1. 36/41 drafts had absolute paths (`/Users/.../src/client/foo.js`) mixed with 5 relative-path drafts — coordinator couldn't detect they were the same file, so couldn't resolve conflicts.
2. The JS overlap-ratio dedup only ran *after* the coordinator — the coordinator was doing that work itself with model tokens.

**Fix:** Pre-normalize all file paths to repo-relative before the coordinator sees them. Then run the overlap-ratio dedup (same logic as post-coordinator) *before* the coordinator call. In the TARS-1271 run this reduced 41 drafts → ~10-18, cutting prompt size ~60%.

**Principle:** The coordinator's only job is semantic: which subtask *better describes* a conflicted file's purpose, and whether a file is misclassified. Everything mechanical (dedup by file overlap, path normalization) should happen in JS before the LLM is involved.

---

## 2026-07-24 — durationMs epoch-overflow guard

**Problem:** When `_workflowStartTs` was null (haiku start-ts agent failed) and `args.startTs` was not passed, the python expression computed `time.time()*1000 - 0` = current epoch ms (~1.78T), producing nonsensical duration values like `1783075135718`.

**Fix:** Added sanity clamp — reject any result > 36,000,000 ms (10 hours). Emit `null` instead. The dashboard already handles `null` gracefully.

---

## 2026-07-23 — spec-v8 era: 8 quality issue fixes (runs 3–6)

Iterative fixes across multiple runs to drive quality issues from 15 down toward ~4:

1. **acBullet enforcement** — Haiku research agents occasionally put findings summaries ("Found 3 files in /Users/...") into `acBullet` instead of copying the original AC text. Fixed by overwriting `acBullet` from `acList[i].bullet` after Phase 1 (index alignment guaranteed by `parallel()` order).

2. **Empty ejected stub pruning** — After `_ejectTestFiles` stripped all test files from a migration batch, the now-empty shell survived dedup. Fixed by filtering `rawProposed` for non-empty migration stubs post-ejection.

3. **Zero-file stub Phase C context** — Zero-coverage AC stubs now include a useful note about Phase C's broader-pattern retry count, so implementers know whether to investigate further.

4. **Phase C first-word suppression** — Phase C's last-resort fallback searches for just the first word of the grep pattern (e.g. "axios" alone), matching comments, package.json, test mocks. This was updating `verifiedCount` and causing non-deterministic L/M size flips between runs. Fixed: first-word results set `phaseCFirstWordOnly = true` but do NOT update `verifiedCount`. Only full-pattern and case-insensitive variants count.

5. **triageSizeOverride tracking** — When Work Intelligence corrects the ticket's triage estimate, the override is now tracked as `{ triageSize, groundedSize, reason }` and surfaced in cliSummary: `triage: estimated L → verified M (ticket claims overridden by research)`.

6. **Ejection-resolved misclassification suppression** — Coordinator flags test files in migration batches; `_ejectTestFiles` resolves them. Surfacing both was redundant noise in `qualityIssues`. Fixed with `TEST_MISCLASS_RE` filter when `ejectionResolved = true`.

7. **Group display order** — `Object.entries(groupMap)` returns insertion order, causing G2 to display before G1. Fixed with explicit `GROUP_ORDER = ['G1', 'G2', 'G3']` sort.

8. **Done-condition + stub deduplication** — `isDeferred` ACs with no files were added to `doneConditionAcs`, but the post-verify stub injector also created a stub for them. Fixed by checking `doneConditionAcs.includes(missingBullet)` before stub creation.

---

## 2026-07-22 — spec-v8 era begins

**Era marker:** `skillsSchemaVersion: 'spec-v8'` added to all audit records.

**Architecture at spec-v8 start:**
- Haiku groupers (one per AC, parallel) produce subtask drafts
- Opus coordinator merges, resolves conflicts, detects misclassifications
- Deterministic JS assigns groupId/dependsOn/canRunInParallel (moved out of model output after G1/G2/G3 inversions)
- `_ejectTestFiles` post-coordinator deterministic step strips `*.test/spec.[jt]sx?` from migration batches and injects a cleanup subtask
- `COMPLETE_FRAMING_CORRECTED` status when ticket claims are overridden by verified grep counts (correct harness behavior, not a defect)
- Dual-write audit pattern: `~/.claude/harness-*-runs.jsonl` (legacy) + `~/Desktop/Repos/harness-telemetry/logs/{repo}__{skill}__{ticket}__{timestamp}.jsonl`

**Key insight from TARS-1271:** Ticket claimed 118 files; research consistently finds ~32. Harness correctly sizes M (not L). `triageSizeOverride` surfacing makes this visible rather than silent.

---

## Pre-spec-v8 — Original design:root → grouper+coordinator split

**Problem:** A single "design:root" Opus agent received all AC research findings and produced the full subtask split in one shot. As ticket complexity grew, the prompt approached context limits and output quality degraded.

**Fix:** Split into two stages:
1. **Grouper phase** — one Haiku agent per AC, each producing subtasks for that AC's files only. Parallel, cheap.
2. **Coordinator phase** — one Opus agent receives all grouper drafts and resolves conflicts between ACs.

This cut coordinator input ~5-6x vs design:root. groupId/dependsOn were initially produced by the coordinator but caused consistent G1/G2/G3 inversions — moved to deterministic JS.

---

## Original paradigm — single-agent split

**Status:** Retired. The original harness-intake was a single large prompt that classified the ticket, grepped for files, and produced the full split plan in one agent call. Replaced by the multi-phase pipeline (classify → research → groupers → coordinator) to handle L-sized tickets reliably.
