# harness-run changelog

## v2 — manifest-as-gospel conductor (2026-07-27)
- Removed harness-bridge from the sequence: intake → plan → implement. Each stage's
  manifest is ground truth for the next; no scoring gate, no RE_ASK loop, no refine
  passes. The bridge skill and its `lib/checks-*.js` are untouched on disk — re-add
  the gates behind an opt-in `--gate` flag once checks-B's schema contract matches
  harness-plan's task shape (checks-B wants one `description` string per task;
  harness-plan emits flat `what`/`where`/`how`/`done`/`snippets`).
- Child skills are invoked with the script-level `workflow({scriptPath}, args)` hook.
  The prior shape — an `agent()` whose prompt told it to call `Workflow` — silently
  never ran any child `workflow.js`, because subagents cannot nest `Workflow`. That
  was the single root cause of null DURATION/TOKENS/COST in the dashboard.
- Conductor takes over the two jobs each child's SKILL.md wrapper would do, since it
  bypasses those wrappers: stamping wall-clock `durationMs` and appending the audit
  record to the child's telemetry JSONL (`finalizeStageTelemetry`).
- Canonical repo name forwarded to every child as `repoName`, so child telemetry says
  `webtarsthree` rather than the worktree directory name.
- `assembleRunSummary` reads `outcome` only and never falls back to `status` — they
  are separate axes, and conflating them made the dashboard RESULT column unreadable.
- Plan-phase `input` is built by `lib/plan-input.js` from fields the intake manifest
  actually carries (`sourceTitle`, `groundedReality`, `acList`, `migrationPattern`,
  `scopePath`), preferring `groundedReality` and falling back to raw ticket text.
  It previously read `ticketSummary`/`summary`, neither of which exists on a real
  manifest, so harness-plan received a bare issue key and sized off nothing.
- Resume (`--resume`) and continuation (`--parent`) modes; run-state files keep the
  bridge-era `allWeightChanges`/`weightsOverride` fields (always empty) so
  checkpoints from bridge-era runs stay resume-compatible.

## v1 — initial conductor
- Artifact-gated runbook: intake → bridgeA → plan → bridgeB → implement.
- Phase 0 worktree provisioning off origin/<base>.
- Guardrailed DRAFT PR (never merge/force-push/main).
- Weight-agency override (tonight-only) + final weight-evolution report.
