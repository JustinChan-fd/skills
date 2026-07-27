# Clean-session run prompt

Paste the block below into a fresh Claude Code session started in `~/Desktop/Repos/skills`.

---

Execute the implementation plan at `docs/superpowers/plans/2026-07-27-harness-e2e-orchestration.md`.

**The only files you need — read these first, in order:**
1. The plan: `docs/superpowers/plans/2026-07-27-harness-e2e-orchestration.md` (read top to bottom — the header's Global Constraints, Repos & Branches, and Interface Index are binding).
2. The design doc it references: `docs/superpowers/specs/2026-07-27-harness-e2e-orchestration-design.md`.

`docs/superpowers/plans/` contains exactly these two files (the plan above and this run prompt). There is no other plan, no draft series, no alternate interface design — if you find yourself reading anything else as a source of truth for the interface, stop; this plan's Interface Index is authoritative.

**Execution method:** Use `superpowers:subagent-driven-development` (fresh subagent per task, review between tasks). Tasks 1–15 build and test the harness in THIS `skills` repo; do them in order. Each task ends green (`npm test`) and is committed on the branch below before moving on.

**Branch:** The build branch `harness/e2e-orchestration` already exists and has the plan committed — stay on it. Do NOT push or PR the skills repo unless I ask; the build lands locally and is exercised by Task 16.

**Phase 0 probe (do this before Task 1):** confirm whether `workflow.js` can `import` from `./lib/`. Create `harness-bridge/lib/_probe.js` (`export const ok = 1`) and a scratch Workflow script that imports it. If the import resolves, proceed as written. If it does NOT, mirror each `workflow.js`'s pure logic into a `// ===== PURE (mirrors lib/) =====` block and keep `lib/` authoritative for tests (as the existing skills already do). Delete `_probe.js` after.

**This is an unattended overnight run.** Do NOT stop to ask me for approval at any point — I am asleep. Build Tasks 1–15, then attempt Task 16 autonomously under the hard guardrails below. The guardrails (draft-only, never merge/force-push, never touch main, base branch, $500 ceiling, stop-on-first-success, NEVER-list surfacing) are what make unattended execution safe — honor them exactly and you are pre-authorized to run without me. The ONLY things that stop the run are: the skill-discovery fallback below, a NEVER-list category, a confidence-gate EXIT, or the $500 ceiling.

**Before Task 16 — skill discovery (the one allowed stop):** `harness-bridge` and `harness-run` are built during this session (Tasks 3–15). Skills live at `~/.claude/skills/`, which is a symlink to this repo's working tree, so the files are on disk the moment they're written — no merge to `main` is needed and `main` is irrelevant to what loads. BUT a slash command created mid-session may not be invocable until the session reloads. When you reach Task 16, **attempt to invoke `/harness-run` — try it.** If it IS recognized, proceed with the full guardrailed run. If it is NOT recognized, STOP: write a short `docs/superpowers/plans/TASK-16-READY.md` note saying the build is complete and committed and the live run must be started in a fresh session, and leave everything committed on the branch. Do NOT fall back to launching `workflow.js` directly. (I will run Task 16 manually in the morning if this happens.)

**Task 16 is the live run — HARD GUARDRAILS (pre-authorized, autonomous — do not ask, just honor these):**
- Runs in `~/Desktop/Repos/webtarsthree`, NOT skills. Branch from `origin/feat/migrate-native-fetch-from-axios` (the epic feature branch — NEVER master/main) via an isolated git worktree; never touch my dirty local branches.
- Invoke the pipeline as a skill: `/harness-run TARS-1271 --repo ~/Desktop/Repos/webtarsthree --base feat/migrate-native-fetch-from-axios`. Always fire harnesses as skills; never launch a `workflow.js` directly.
- Output is a **DRAFT** PR only: push to `harness/TARS-1271-*`, open a DRAFT PR with base `feat/migrate-native-fetch-from-axios`. **NEVER merge, NEVER force-push, NEVER touch main/master. Only webtarsthree, only TARS-1271.**
- **Stop on first success:** once the draft PR is open + `npm test` green in the worktree + telemetry flowed to `~/Desktop/Repos/harness-telemetry/v2/`, STOP. Do not iterate further.
- **$500 hard spend ceiling** as a backstop.
- Any NEVER-list category (irreversible-destructive, security-auth-permission, cost-over-threshold, public-api-contract, out-of-scope, legal-compliance) → STOP and surface, do not self-decide.
- If either confidence gate EXITs (second miss), STOP and surface the weak checks + skeptic reasons; do not open a PR.

**Weight agency (tonight only):** you may adjust bridge weights mid-run if a gate is visibly miscalibrated — but only via `harness-bridge/weights-override.json` (never edit the default `weight:` literals in `lib/checks-a.js` / `lib/checks-b.js`), bounded ±15 per change / floor 1 / ceiling 60 / renormalize to 100, and log every change as a `weightChanges[]` event. At the very end, print the weight-evolution report (initial → final per handoff, every change with its reason).

**When done:** report the draft PR URL, the run-summary box, the weight-evolution report, and confirm the five telemetry records (intake, bridge×N, plan, implement) exist. That's what I'll review.
