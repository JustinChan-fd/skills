# Handoff composition

A handoff is JSON at `.harness/runs/<run-id>/handoffs/<from>-to-<to>.json`,
validated against the `handoff` schema before the phase ends:

    node ~/.claude/skills/harness-core/tools/harness.mjs validate --schema handoff --file <path>

Rules:
- `entry_contract` is written BEFORE the consuming phase starts work. The
  producer proposes criteria; the phase verifier approves or amends; every
  criterion carries a tag: `blocking` (correctness, security, data loss,
  build-breaking) or `advisory` (everything else).
- `artifacts` lists every file the next phase needs, with one-line
  descriptions. If the next phase would have to guess where something is, the
  handoff is incomplete — that is a producer defect, not a consumer problem.
- `notes` carries context that fits nowhere else. Keep it short; durable facts
  belong in the manifest.
