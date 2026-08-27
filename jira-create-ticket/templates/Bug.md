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
-->

### Overview
{1-3 sentences: what's broken and why it matters, plain language, no jargon dump}

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
