<!--
Seeded 2026-09-08 from TARS-1434 (Docker base-image bullseye→bookworm migration).

Internal Package Software is an INVENTORY/TRACKING record, not a unit of work like
Bug/Story/Task. It documents a CODE change that is never seen running as deployed
application code on PRD — a Dockerfile's base image or pinned apt/dependency
versions, an internal library version bump, a build-tooling recipe/config consumed
by another app's build — what it is, why it changed, and where it's consumed.

This is NOT the type for:
- The build/CI pipeline definition itself (.github/workflows/*.yml, Jenkinsfile) —
  that's process orchestration, not package inventory. Goes to Task instead.
- Test files (*.test.*, specs) — those are product work and stay Story even though
  they don't run on PRD as application code either.
- Non-code changes (docs, ticket housekeeping, a manual vendor-UI toggle) — those
  are Task's job, not this type's.

There is no Steps to Reproduce section (it isn't a defect to reproduce) and
Acceptance Criteria reads as a verification checklist for the package change, not
test conditions for new application behavior.

Philosophy for every section: this ticket is the baseline a human or agent picks up
cold. Write only what's known — never pad with a full investigation dump. Be concise,
concrete, and actionable.
-->

### Overview
{What the package is, what changed about it (version/base-image/dependency bump,
migration, etc.), and why — plain language. If this exists because of an observed
break (e.g. an upstream EOL, a broken build), name and link the ticket/PR/run that
surfaced it.}

### Evidence
<!-- Omit this whole section if there's nothing concrete to point at. Don't pad it. -->
{Specific findings: failing run/build links, the root cause, related tickets in other
projects (e.g. an SRE ticket that added a new registry image, a sibling repo's PR that
hit and fixed the same issue) — link, don't transcribe.}

### Where It's Consumed
<!-- Omit if there's only one obvious consumer and it's already named in Overview. -->
{Which repo(s)/service(s)/build pipeline(s) pull in this package — file paths if it's
narrow (e.g. specific Dockerfiles), or a note if it's broader than this one repo.}

### Acceptance Criteria
<!--
Plain bullet list, not numbered — conditions aren't sequential. Each bullet is one
testable, unambiguous condition. No open questions, no "confirm with X" — those go
in Overview or a separate ticket.
-->
- {testable condition — e.g. "CI build using the new package version passes"}
- {testable condition}

### References
<!--
Omit this whole section if there's nothing to link. Don't pad it with a generic
"see the codebase" filler — only include a link if it actually helps whoever
picks this up next skip a step they'd otherwise have to do themselves.
Plain bullet list, one link per bullet, each with a one-phrase label saying what
it is (not just a bare URL). Typical contents: the upstream package/base-image's
own release notes or changelog, a registry/vendor docs page, a related/sibling
ticket in another project that hit or fixed the same issue, or the PR in the
consuming repo. Never re-link something already linked via the formal Jira link
relationship (Step 10) — that's redundant.
-->
- {label}: {url or ticket key}
