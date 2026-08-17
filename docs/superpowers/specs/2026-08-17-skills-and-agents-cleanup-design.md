# Skills & Agents Cleanup — Design

**Date:** 2026-08-17
**Status:** Awaiting review

## Goal

Shrink the skills repo and the agent folder to what is actually used. Retire the
harness / token-tracking effort as **not viable** and stop carrying anything that
only existed to serve it.

**Guiding principle:** if a file only existed to serve the harness or
token-tracking, or is no longer referenced by anything kept, it goes.

## Context

- `~/.claude/skills` is a **symlink to this repo**, so the repo *is* the live skill
  set. Skill/file deletions here are git-recoverable.
- Agents live in `~/.claude/agents/` — a **separate, non-versioned** directory.
  Agent deletions are permanent, so the folder is **backed up before any cut**.
- The 7 superpowers-named skills in this repo are **redundant** — all 7 are present
  in the enabled `superpowers@claude-plugins-official` plugin. Deleting the repo
  copies keeps `superpowers:<name>` working; only the bare-name aliases disappear.
- Decisions were driven by real usage: agent dispatch counts from session history
  and skill invocation counts from `skill-runs` records.

## Manifest

### Agents (`~/.claude/agents/`) — 19 → 3

- **Keep (3):** `codebase_analyst`, `senior_frontend_engineer`, `junior_engineer`
- **Delete (16):** `accessibility_analyst`, `client_unit_test_writer`,
  `csharp_code_reviewer`, `csharp_unit_test_writer`, `datadog_investigator`,
  `dotnet_integration_test_writer`, `engineering_manager`, `git_workflow_advisor`,
  `playwright_test_writer`, `security_analyst`,
  `senior_csharp_full_stack_engineer`, `senior_database_engineer`,
  `spec_compliance_reviewer`, `test_manager`, `visual_regression_tester`,
  `web_designer`
- No new agent (`qa_engineer` deferred). Test-writing and code-review are simply
  uncovered for now; can be re-added later.

### Skills (repo) — delete (16)

- **Flagged:** `alfred`, `skill-observability`, `fandango-agents`
- **Redundant superpowers copies:** `brainstorming`,
  `finishing-a-development-branch`, `subagent-driven-development`,
  `systematic-debugging`, `test-driven-development`,
  `verification-before-completion`, `writing-plans`
- **Unused customs:** `add-endpoint`, `gh-create-issue`, `prompt-after-compact`,
  `research-this`, `squash-commits`, `sync-keystone-models`

### Skills (repo) — keep (6)

`adversarial-review`, `qa-notes`, `push-branch`, `review-pr-feedback`,
`open-in-vscode`, `sync-branch`

### Harness / token-tracking artifacts — delete

- `docs/` (SDD plan history, incl. `docs/superpowers/plans/*` — token-attribution,
  tier-normalization, etc.). **Note:** this spec lives under `docs/` and is removed
  with it; it survives in git history as the record of the cleanup.
- `.superpowers/sdd/` (110 harness SDD task/review artifacts)

### Non-skill clutter — delete

- `create-branch.md` (unreferenced)
- `config.js` (orphaned once `sync-keystone-models` is cut)
- `package.json`, `package-lock.json`, `node_modules/` (only served
  `skill-observability` tests; nothing else imports)

### Keep

- `findings/` (used by the kept `adversarial-review` skill)

## Required companion edits (make the deletions safe)

1. **`~/.claude/settings.json`** — remove the 3 hook entries (Stop, StopFailure,
   SessionEnd) that invoke the deleted
   `skill-observability/hooks/skill-run-logger.mjs`. Without this, every
   stop/session-end fires a broken `node` command.
2. **`review-pr-feedback/SKILL.md`** — its agent-selection table references
   `security_analyst` (deleted). Drop that row. `junior_engineer` and
   `senior_frontend_engineer` remain valid (kept).

## Safety & execution notes

- Work on a **branch** (currently on `main`).
- **Back up `~/.claude/agents/`** (e.g. copy to a timestamped tar/dir outside the
  repo) before deleting any agent — that directory is not version-controlled.
- Skill/doc/clutter deletions are recoverable from git history.
- Commit the cleanup separately from this spec.

## Verification (after execution)

- Kept skills still resolve: `adversarial-review`, `qa-notes`, `push-branch`,
  `review-pr-feedback`, `open-in-vscode`, `sync-branch`.
- `superpowers:*` skills still load (plugin-backed).
- No hook in `settings.json` points at a missing path; a session stop fires cleanly.
- Kept agents present in `~/.claude/agents/`; the 16 removed are gone; backup exists.
- `review-pr-feedback` no longer names a deleted agent.

## Out of scope

- Memory files under `~/.claude/projects/.../memory/` (durable layer; untouched
  unless separately requested — several reference the now-retired harness).
- `cache-arm` / `cache-compare` skill registrations — not present on disk anywhere;
  nothing to delete in the repo.
- The `superpowers@claude-plugins-official` plugin itself (stays enabled).
