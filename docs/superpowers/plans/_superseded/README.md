# Superseded plan drafts

These are earlier drafts of the harness-e2e-orchestration plan, kept for reference — **not for execution**.

- `2026-07-27-harness-e2e-plan-part-{a..f}.md` — an earlier, more granular per-component decomposition (finer TDD steps + explicit clean/dirty manifest fixtures) that was never stitched into a single doc. It uses a **different interface design** than the canonical plan (`runChecks` + a default-weights `lib/weights.js` module, vs the canonical `scoreArtifact` + `loadWeights`). Do not concatenate it with the canonical plan — the interface names conflict.
- `plans-copy-of-design-doc.md` — a stray duplicate of the design doc. The canonical design lives at `../../specs/2026-07-27-harness-e2e-orchestration-design.md`.

**Canonical, executable plan:** `../2026-07-27-harness-e2e-orchestration.md`

If you want even finer TDD granularity or the ready-made manifest fixtures from the part-* series, mine them by hand — but keep one interface design; don't mix.
