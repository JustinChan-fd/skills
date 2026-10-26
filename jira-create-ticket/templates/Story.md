<!--
Philosophy for every section: this ticket is the baseline a human or
agent picks up cold. Write only what's known — never pad with a full
investigation dump. Be concise, concrete, and actionable. Someone
reading this should immediately know what needs to change and why,
and what "done" looks like; they'll do their own research from here.

A Story describes work to be done, not a defect to reproduce — there
is no Steps to Reproduce section. If the story exists because of an
observed defect, put that context in Overview and link the ticket
that reported it.

Open questions (things that need a person's judgment, not a test) do
NOT belong in Acceptance Criteria — put them in Overview as a caveat,
or file them as a separate follow-up. Every AC bullet must be
independently checkable with no extra context.

Named surface, required: Overview must name at least one concrete
file, page, endpoint, or component — even when there's no concrete
finding and Evidence is being omitted. This ticket may be picked up
by research-loop's ticket-refine, whose Ground step starts with one
cheap grep against a named location before anything else; with
nothing concrete named, that step (and the ticket) has nowhere to
start and bounces immediately with zero investigation done. If
nothing concrete surfaced anywhere in the prompt or linked-ticket
context, this is not something to guess at or leave implicit — ask
the user for a surface via Step 7's AskUserQuestion before writing
this ticket.

Current vs. desired, required framing: state what currently exists/
happens and what should exist/happen instead, not just "what needs
to change." This framing is what lets a currency check (one grep,
before any deeper investigation) confirm the gap still exists as
described.

EXPERIMENTAL (added 1.4.0, clarified 1.4.1 — Story only): optional grouped
AC (parent bullet + indented children) and the Implementation Notes section
below are a pattern tried first on TARS-1565 to cut down on AC bloat and
separate testable conditions from implementation bookkeeping. Grouping is
for human/agent scanning clarity only — it must never be used to make a
ticket's real scope look smaller (parent-level bullets are what's counted
toward ticket size). If this holds up in practice (humans find it easier
to scan, no loss of per-condition testability, no count-gaming), port the
same split to the other templates (Bug, Task, TechStory, Spike,
InternalPackageSoftware) and remove this note. If it doesn't hold up,
revert Story.md to flat AC bullets and drop Implementation Notes.
-->

### Overview
{Current state: what exists/happens now, naming the specific file/page/
endpoint/component. Desired state: what should exist/happen instead, and
why it matters. 1-3 sentences, plain language, no jargon dump. If this
story exists because of an observed bug/limitation, name and link the
ticket that surfaced it.}

### Evidence
<!-- Omit this whole section if there's no concrete data/finding backing the need for
     this work. Don't pad it. -->
{investigation findings, logs, or a short table — whatever was actually observed}

### Acceptance Criteria
<!--
Default to flat bullets, ordered from the ticket's core goal down to features
that are nice-to-have enhancements not required for that goal to work. Group
into a bold parent bullet + indented children ONLY when it genuinely aids
scanning — several related conditions under one named feature, or a note the
implementer should acknowledge while satisfying that one criterion. This is
optional and for clarity, not a required shape — don't force grouping where
flat bullets already read fine, and don't use grouping to make a ticket look
smaller than it is (parent bullets are what get counted toward ticket size,
not the ticket's total condition count).

Still not numbered — conditions aren't sequential. Every parent/flat bullet
must be independently testable with no extra context; an indented child may
be its own testable sub-condition, or a plain acknowledgment note scoped to
its parent — not itself a separately-counted AC either way. No open
questions, no "confirm with X" — those go in Overview or a separate ticket.
File names, test locations, and other implementation context that isn't
itself a testable condition go in Implementation Notes below, not here —
don't let bookkeeping masquerade as AC.
-->
- {testable condition} — flat bullet, the default shape
- **{feature name}**: {testable condition} — grouped only because related
  conditions follow
  - {testable sub-condition of the same feature}
  - {acknowledgment note scoped to this criterion, not independently testable}
- **{enhancement feature name}** (does not block the above): {testable condition}

### Implementation Notes
<!--
Omit this whole section if there's nothing here. Context for whoever implements —
named files/modules, where tests should live, which existing component/hook to
reuse — that isn't itself an independently-checkable condition, so it doesn't
belong in Acceptance Criteria. Plain bullet list.
-->
- {file/module/test-location context}

### References
<!--
Omit this whole section if there's nothing to link. Don't pad it with a generic
"see the codebase" filler — only include a link if it actually helps whoever
picks this up next skip a step they'd otherwise have to do themselves.
Plain bullet list, one link per bullet, each with a one-phrase label saying what
it is (not just a bare URL). Typical contents: an API docs page (e.g. an OpenAPI/
Swagger tag page), a Confluence design/runbook page, third-party vendor docs, a
related/sibling ticket key (even if not a formal Jira link), or the PR/commit
that's directly relevant. Never re-link something already linked via the formal
Jira link relationship (Step 10) — that's redundant.
-->
- {label}: {url or ticket key}
