<!--
Seeded from Bug.md's generic shape (2026-09-02, MC-1297) for a maintenance/
sync-style Task with no repro/error to point at. Refine per-project as real
Task tickets accumulate.

Philosophy for every section: this ticket is the baseline a human or
agent picks up cold. Write only what's known — never pad with a full
investigation dump. Be concise, concrete, and actionable.
-->

### Overview
{1-3 sentences: what changed or needs to change, and why, plain language}

### Evidence
<!-- Omit this whole section if there's nothing concrete to point at. Don't pad it. -->
{file paths, commit refs, or specific observations - not a full investigation dump}

### Acceptance Criteria
<!--
Plain bullet list, not numbered - conditions aren't sequential. Each bullet is one
testable, unambiguous condition. No open questions, no "confirm with X" - those go
in Overview or a separate ticket.
-->
- {testable condition}
- {testable condition}

### References
<!--
Omit this whole section if there's nothing to link. Don't pad it with a generic
"see the codebase" filler — only include a link if it actually helps whoever
picks this up next skip a step they'd otherwise have to do themselves.
Plain bullet list, one link per bullet, each with a one-phrase label saying what
it is (not just a bare URL). Typical contents: a Confluence page, a vendor-UI
config screen this task references, a related/sibling ticket key, or the source
this task's instructions came from. Never re-link something already linked via
the formal Jira link relationship (Step 10) — that's redundant.
-->
- {label}: {url or ticket key}
