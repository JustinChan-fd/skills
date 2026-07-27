# Harness E2E Orchestration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the orchestration layer that turns three independently-runnable harness skills into one autonomous, confidence-gated ticket→PR pipeline.

**Architecture:** A new `harness-bridge` skill (confidence gate), a new `harness-run` skill (conductor), `--refine` mode on existing skills, telemetry v2 additions, and model repoint — all validated by an end-to-end TARS-1271 run.

**Tech Stack:** Plain JS (ES modules), Node.js test runner, git CLI, existing harness skill infrastructure.

---

## Plan Structure

This plan is split into 6 independent parts to stay within output limits. Execute in dependency order:

```
Part A ──► Part B ──► Part F
  │                     ▲
  └──► Part C ──────────┘
  │                     ▲
  └──► Part D ──────────┘
  │                     ▲
  └──► Part E ──────────┘
```

**Execution order:** A → (B, C, D, E in parallel) → F

---

## Part Index

| Part | File | Scope | Tasks | Est. Time |
|------|------|-------|-------|-----------|
| **A** | [plan-part-a.md](./2026-07-27-harness-e2e-plan-part-a.md) | `harness-bridge` core — 16 confidence checks, weights, verdict, gate-writer, hole-poker | 9 | 40–60 min |
| **B** | [plan-part-b.md](./2026-07-27-harness-e2e-plan-part-b.md) | Weight-override mechanism — read/write/validate/report | 2 | 15–20 min |
| **C** | [plan-part-c.md](./2026-07-27-harness-e2e-plan-part-c.md) | `harness-run` conductor — sequence, verdict handling, worktree, SKILL.md | 3 | 20–25 min |
| **D** | [plan-part-d.md](./2026-07-27-harness-e2e-plan-part-d.md) | `--refine` mode on intake + plan | 3 | 20–25 min |
| **E** | [plan-part-e.md](./2026-07-27-harness-e2e-plan-part-e.md) | Telemetry v2 additions + opus→opus-5 repoint | 2 | 10–15 min |
| **F** | [plan-part-f.md](./2026-07-27-harness-e2e-plan-part-f.md) | Integration stitch — SKILL.md wiring + TARS-1271 validation run | 4 | 30–45 min |

**Total: 23 tasks** | **Estimated total: 2.5–3 hours**

---

## Spec Coverage Mapping

| Spec Section | Covered By |
|---|---|
| §3.1 I/O contract | Part A (Task 8: gate-writer) |
| §3.2 Confidence formula (all 16 checks) | Part A (Tasks 3–6) |
| §3.3 Hole-poker | Part A (Task 9) |
| §3.4 Verdicts & retry budget | Part A (Task 7) |
| §3.5 --refine mode | Part D (Tasks 1–3) |
| §3.6 Weight agency | Part B (Tasks 1–2) |
| §4 harness-run (conductor) | Part C (Tasks 1–3) |
| §4 Phase 0 (worktree) | Part C (Task 2) |
| §5 Manifest supremacy / re-sizing | Part D (existing harness-plan handles this) |
| §6 Telemetry v2 additions | Part E (Task 1) |
| §7 Model routing (opus→5) | Part E (Task 2) |
| §8 Guardrails | Part C (SKILL.md) + Part F (Task 4) |
| §10.9 Autonomous TARS-1271 run | Part F (Task 4) |

---

## How to Execute

### Option 1: Sequential (safest)

Execute parts in order: A → B → C → D → E → F. Each part is self-contained with its own commit points.

### Option 2: Parallel after Part A

1. Execute Part A (the dependency for everything)
2. Execute Parts B, C, D, E in parallel (independent of each other)
3. Execute Part F (integration requires all others complete)

### For each part:

1. Open the part file
2. Execute tasks in order (they are dependency-ordered within each part)
3. Each task has explicit test commands and commit points
4. All tests must pass before moving to the next task

---

## Guardrails (LOAD-BEARING — verbatim from spec §8)

- Autonomous push/PR authorized **ONLY** as: **DRAFT PR, guardrailed** — push to a `harness/TARS-1271-*` branch, open a **DRAFT** PR
- **NEVER merge, NEVER force-push, NEVER touch main directly, only in webtarsthree, only for TARS-1271**
- Final PR merges back to **`feat/migrate-native-fetch-from-axios`** (NOT main)
- **Stop on first success** — green tests + telemetry flowed → stop
- **$500 hard spend ceiling** (backstop)
- **ALWAYS fire harnesses as skills, never launch `workflow.js` directly**
- **NEVER-list** always applies (irreversible-destructive, security, cost, public-api, out-of-scope, legal)
