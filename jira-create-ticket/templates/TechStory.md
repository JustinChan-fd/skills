<!--
Philosophy for every section: this ticket is the baseline a human or
agent picks up cold. Write only what's known — never pad with a full
investigation dump. Be concise, concrete, and actionable. Someone
reading this should immediately know what needs to change and why,
and what "done" looks like; they'll do their own research from here.

Tech Story is for a code change that deploys and runs as application
code on PRD but has no user-facing behavior change and isn't fixing a
defect — a refactor, an internal data-model migration, extracting or
consolidating a module, a dependency bump that touches app code paths,
cross-cutting technical debt. Contrast with Story (net-new user-facing
capability), Bug (a defect/crash), and Internal Package Software
(never runs as deployed application code at all — see that template).
There is no Steps to Reproduce section — this isn't a defect to
reproduce.

Verifiable current architecture, required: state what the code
currently does structurally (not user-facing behavior) precisely
enough that someone could confirm it by reading the named file(s).
research-loop's ticket-refine verifies a Tech Story's claims about
current architecture against the actual code before anything else —
a vague or unverifiable architectural claim here is exactly what that
step exists to catch, at the cost of a bounce instead of a smooth
pickup.

Named surface, required: Overview must name at least one concrete
file, module, or component — even when there's no concrete finding
and Evidence is being omitted. With nothing concrete named,
ticket-refine's Ground step (one cheap grep against a named location,
before any deeper investigation) has nowhere to start and bounces
immediately with zero investigation done. If nothing concrete
surfaced anywhere in the prompt or linked-ticket context, ask the
user for one via Step 7's AskUserQuestion before writing this ticket.

Open questions (things that need a person's judgment, not a test) do
NOT belong in Acceptance Criteria — put them in Overview as a caveat,
or file them as a separate follow-up. Every AC bullet must be
independently checkable with no extra context.
-->

### Overview
{Current architecture: what the code structurally does now, naming the
specific file(s)/module(s)/component(s). Desired architecture: what it
should look like instead, and why (maintainability, a blocked
follow-on change, a dependency constraint, etc.). 1-3 sentences, plain
language, no jargon dump.}

### Evidence
<!-- Omit this whole section if there's no concrete finding backing the need for
     this work. Don't pad it. -->
{investigation findings, a dependency/version constraint, or a short table —
whatever was actually observed}

### Acceptance Criteria
<!--
Plain bullet list, not numbered — conditions aren't sequential. Each bullet is one
testable, unambiguous condition someone can check off with no extra context.
No open questions, no "confirm with X" — those go in Overview or a separate ticket.
For a Tech Story, "testable" usually means: existing test suites still pass, a
specific new/changed structural property holds (e.g. "module X no longer imports Y"),
or a measurable outcome (e.g. "build time drops below Z").
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
Swagger tag page), a Confluence design/runbook/ADR page, third-party vendor docs,
a related/sibling ticket key (even if not a formal Jira link), or the PR/commit
that's directly relevant. Never re-link something already linked via the formal
Jira link relationship (Step 10) — that's redundant.
-->
- {label}: {url or ticket key}
