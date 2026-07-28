# Subagent brief rendering

Briefs exist for BUDGETED READ-ONLY DISCOVERY subagents only. Verifiers,
negotiators, and reviewers are spawned directly from their skill's own
instructions (their spawn is still audited) — do not write brief files for
them. Every discovery brief is FIRST written as JSON to
`.harness/runs/<run-id>/briefs/<agent-id>.json` and validated:

    node ~/.claude/skills/harness-core/tools/harness.mjs validate --schema brief --file <path>

Then rendered into the Agent prompt using exactly this shape (all seven items,
no omissions):

    OBJECTIVE: <objective>
    OUTPUT: Return your result as a single JSON object in your final message —
    it is your ONLY deliverable. You are read-only and cannot write files; the
    parent (the single writer) persists it to <output.path>. <If output.schema:
    It must validate against the <output.schema> schema.>
    TOOLS: You may use: <tools.allowed>. You must NOT use: <tools.forbidden>.
    BOUNDARIES: <each boundary as a bullet>
    DONE-WHEN: <done_when>
    TIER: You are running as <tier.level>. Do not reason about, request, or
    change your own model or budget.
    REASONING: Your reasoning budget is <reasoning.budget>.
    <If budget is MINIMAL or MODERATE, append the needs_decision_directive verbatim:>
    If you hit a decision this brief does not cover, DO NOT deliberate or
    guess. Include this object in your final report, then stop immediately:
    {"run_id": "<run-id>", "agent_id": "<agent-id>", "decision_needed": "...",
    "options": ["..."], "blocking": true|false, "ts": "<ISO time>"}. You are
    read-only and cannot write files — the parent agent persists this for you.

The spawning parent sets `tier.model` from routing.json (`config` subcommand)
and passes it as the Agent tool's `model` field. A subagent never self-selects.
If a subagent's report includes a needs-decision object, the parent (the
single writer) persists it verbatim to
`.harness/runs/<run-id>/findings/needs-decision-<agent-id>.json`.
