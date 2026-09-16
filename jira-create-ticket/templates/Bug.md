<!--
Philosophy for every section: this ticket is the baseline a human or
agent picks up cold. Write only what's known — never pad with a full
investigation dump. Be concise, concrete, and actionable. Someone
reading this should immediately know what's wrong and what "done"
looks like; they'll do their own research from here.

Open questions (things that need a person's judgment, not a test) do
NOT belong in Acceptance Criteria — put them in Overview as a caveat,
or file them as a separate follow-up. Every AC bullet must be
independently checkable by a QA reader with no extra context.

Named surface, required: Overview must name at least one concrete
file, page, endpoint, or component — even when there's no full repro
and Evidence is being omitted. This ticket may be picked up by
research-loop's ticket-refine, whose Ground step starts with one
cheap grep against a named location before anything else; with
nothing concrete named, that step (and the ticket) has nowhere to
start and bounces immediately with zero investigation done. If
nothing concrete surfaced anywhere in the prompt or linked-ticket
context, this is not something to guess at or leave implicit — ask
the user for a surface via Step 7's AskUserQuestion before writing
this ticket.

Current vs. desired, required framing: state what currently happens
and what should happen instead, not just "what's broken." This
framing is what lets a currency check (one grep, before any deeper
investigation) confirm the gap still exists as described.
-->

### Overview
{Current behavior: what happens now, naming the specific file/page/endpoint/
component. Desired behavior: what should happen instead. 1-3 sentences,
plain language, no jargon dump.}

### Evidence
<!-- Omit this whole section if there's no concrete repro/error/data. Don't pad it. -->
{repro results, error text, or a short table — whatever was actually observed}

### Steps to Reproduce
<!--
Maps to the field marked fieldType: "adf" in this project's configs/<PROJECT>.json.
Build a real ADF orderedList — not plaintext with literal "1." "2." — one listItem
per step. Each step is one concrete action. Include an exact URL/path/query wherever
one exists so someone can copy-paste and go, not guess at navigation. After any step
with a visible result, add a bold "Expected:" step describing it.
-->
1. {action, with concrete URL/path/query if applicable}
2. **Expected:** {what should happen}

### Acceptance Criteria
<!--
Plain bullet list, not numbered — conditions aren't sequential. Each bullet is one
testable, unambiguous condition a QA person can check off with no extra context.
No open questions, no "confirm with X" — those go in Overview or a separate ticket.
-->
- {testable condition}
- {testable condition}

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
