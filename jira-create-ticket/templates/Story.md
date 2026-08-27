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
-->

### Overview
{1-3 sentences: what needs to change and why it matters, plain language, no jargon dump.
If this story exists because of an observed bug/limitation, name and link the ticket
that surfaced it.}

### Evidence
<!-- Omit this whole section if there's no concrete data/finding backing the need for
     this work. Don't pad it. -->
{investigation findings, logs, or a short table — whatever was actually observed}

### Acceptance Criteria
<!--
Plain bullet list, not numbered — conditions aren't sequential. Each bullet is one
testable, unambiguous condition someone can check off with no extra context.
No open questions, no "confirm with X" — those go in Overview or a separate ticket.
-->
- {testable condition}
- {testable condition}
