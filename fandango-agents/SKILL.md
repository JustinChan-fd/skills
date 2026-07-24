---
name: fandango-agents
description: Use when the user invokes /fandango-agents or wants engineering_manager and test_manager to coordinate a task while tracking subagent observations for improvement
---

# Fandango Agents — Coordinator-Driven Development with Lessons Tracking

## Overview

Routes the user's task through `engineering_manager` and/or `test_manager` as coordinators, wires `superpowers:subagent-driven-development` to Fandango's specific agents for each role, observes subagent behavior throughout the session, and produces a lessons-learned report at the end.

**Core principle:** Real work reveals gaps that synthetic tests miss — track everything and report it.

## When to Use

- User invokes `/fandango-agents [task]`
- User wants full coordinator oversight on a non-trivial task
- User wants a post-session audit of subagent performance

## Role Map

This is the authoritative mapping of `superpowers:subagent-driven-development` roles to Fandango agents. Pass this table to every coordinator dispatch so they use the right agents and never fall back to generic subagents.

| subagent-driven-development role | Fandango agent | When |
|----------------------------------|---------------|------|
| Implementer (backend) | `senior_csharp_full_stack_engineer` | Backend services, API handlers, server logic, business logic, service integrations |
| Implementer (frontend) | `senior_frontend_engineer` | UI components, client routing, state management, styling, frontend framework integration |
| Spec compliance reviewer | `spec_compliance_reviewer` | After every implementer task |
| Code quality reviewer | `csharp_code_reviewer` | After spec compliance passes on backend tasks |
| Test writer — unit | `csharp_unit_test_writer` | Unit tests for business/utility logic (framework detected from project) |
| Test writer — integration | `dotnet_integration_test_writer` | Integration tests for API/service boundaries (framework detected from project) |
| Test writer — frontend unit | `client_unit_test_writer` | Component/UI unit tests (framework detected from project) |
| Test writer — E2E | `playwright_test_writer` | Browser flows, end-to-end user journeys |
| Visual regression verifier | `visual_regression_tester` | Before/after screenshots for CSS, layout, z-index fixes |
| Git workflow advisor | `git_workflow_advisor` | Branch sync, cherry-pick strategy, conflict resolution |
| Code researcher | `codebase_analyst` | Existing functionality, reuse candidates, bug investigation, before any implementation |
| Security reviewer | `security_analyst` | Auth, user input, redirects, cookies, security-sensitive config |
| Database / cache reviewer | `senior_database_engineer` | Database, caching, data modeling, service integration |
| UI / design implementer | `web_designer` | Figma decomposition, HTML/CSS layout, responsive behavior, accessibility |
| Accessibility auditor | `accessibility_analyst` | WCAG 2.1/2.2 audits, ARIA pattern review, A11y ticket completeness, keyboard/screen reader verification |
| Small task implementer | `junior_engineer` | Small well-scoped tasks, ticket review (gaps by severity + why-it-matters rationale), technical documentation after approach is clear; Jira ticket creation only when explicitly assigned |
| Datadog triage / error validation | `datadog_investigator` | Triaging Datadog error-tracking issues, distinguishing real bugs from bot/scraper noise or third-party errors, producing validation reports before Jira tickets are created |

## Process

### Phase 1: Parse the Task

Extract the task from the user message (everything after `/gn-agents`).

Classify the dominant concern:

| Concern | Primary Coordinator | Also Route To |
|---------|-------------------|---------------|
| Implementation (feature, fix, refactor) | `engineering_manager` | `test_manager` when tests are in scope |
| Testing (strategy, coverage, test writing) | `test_manager` | — |
| Full feature (impl + tests) | `engineering_manager` | `test_manager` for test phase |
| Architecture or design | `engineering_manager` | — |
| UI / design / Figma work | `engineering_manager` | — |
| Security review | `engineering_manager` | — |
| Database / cache / data-access work | `engineering_manager` | `test_manager` for coverage |
| Code research / reuse investigation | `codebase_analyst` (direct — no coordinator needed) | — |
| Git branch sync / conflict resolution | `git_workflow_advisor` (direct — no coordinator needed) | — |
| Accessibility audit / WCAG review | `accessibility_analyst` (direct — no coordinator needed) | `engineering_manager` if findings require implementation |
| Documentation / Jira ticket creation / reporting | `junior_engineer` (direct — no coordinator needed) | — |
| Datadog error triage / validation | `datadog_investigator` (direct — no coordinator needed) | `junior_engineer` for ticket creation if verified |

Announce: **"I'm using the fandango-agents skill. Routing to [coordinator(s)]. Observations will be tracked."**

### Phase 2: Dispatch Coordinator(s)

Dispatch the primary coordinator as a subagent with:
- The full task description
- Relevant codebase context (branch, files in scope, ticket reference if any)
- The Role Map above
- This instruction: _"Complete this task following `superpowers:subagent-driven-development`. Use the Role Map to select agents for each role — do not dispatch generic subagents. Report DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED when finished."_

If a secondary coordinator is needed (e.g., `test_manager` after `engineering_manager` finishes implementation), dispatch it once the primary reports DONE. Pass the same Role Map and instruction.

**Model override rule:** When dispatching `junior_engineer` for Jira update tasks covering 5 or more tickets, or any task with a large comment/description payload, pass `model: sonnet` in the dispatch. The default Haiku model's context window is exhausted quickly when MCP tool schemas are injected alongside large payloads.

### Phase 3: Observe Throughout

After **each subagent interaction completes**, log an observation entry. Keep a running mental tally in this format:

```
[agent: <name>] [finding: <one-line description>] [type: false-positive|false-negative|scope-creep|missed-tool|model-mismatch|good-catch|good-delegation]
```

**What to observe:**

- **Review agents** (`csharp_code_reviewer`, `spec_compliance_reviewer`, `security_analyst`): false positives (flagging correct code), false negatives (missing real issues)
- **Writer agents** (test writers, `senior_csharp_full_stack_engineer`, `senior_frontend_engineer`, `web_designer`, `junior_engineer`): assumed dependencies that didn't exist, over-built, under-built, incorrect tool choices
- **Advisory agents** (`codebase_analyst`, `senior_database_engineer`, `git_workflow_advisor`): missed reuse candidates, incorrect strategy recommendation, incomplete investigation
- **Coordinator agents** (`engineering_manager`, `test_manager`): wrong agent selected from Role Map, task decomposition quality, failure to dispatch `codebase_analyst` before implementation
- **All agents**: Did the model seem too slow/expensive for the complexity? Too fast/cheap and missed something?

Record **successes** too — "agent correctly identified X without being told" is signal.

### Phase 4: End-of-Session Report

When the task is fully complete, produce the lessons-learned report **before** closing out. Only skip the report if the task was trivially short (1 subagent, no issues).

```
## Session Lessons Learned

### Coordinator Summary
- Primary: [coordinator used]
- Secondary: [coordinator used, or "none"]
- Overall: [smooth / had friction / blocked]

### Subagent Observations

| Agent | Finding | Type | Recommended Action |
|-------|---------|------|--------------------|
| ...   | ...     | ...  | ...                |

### Suggested Agent Improvements

For each agent with findings that warrant a checklist or prompt change:

**[agent-name]**
- Issue: [what went wrong or could be clearer]
- Suggested edit: [specific change to the agent's instructions, checklist, or model]

### New Agent Suggestions

For each capability gap or repeated handoff that a dedicated agent could own:

**Suggested: [agent-name]**
- Purpose: [one sentence]
- Trigger: [when `engineering_manager` or `test_manager` would dispatch it]
- Model suggestion: [capability needed — reasoning, vision, code-specialist, etc.]

### Role Map Gaps

If any `subagent-driven-development` role had no suitable agent in the Role Map, or an agent was misused for a role it wasn't designed for:

| Role | Gap | Suggestion |
|------|-----|-----------|
| ...  | ... | ...       |

### Model Tuning Observations

Only if a model seemed clearly mismatched (not just slow):

| Agent | Current Model | Observation | Suggestion |
|-------|--------------|-------------|------------|
| ...   | ...          | ...         | ...        |
```

If there are no findings: write "No issues observed — all agents performed within expectations."

## Common Mistakes

**Dispatching coordinators without the Role Map.** Without it, coordinators fall back to generic subagents and bypass the Fandango webtarsthree agents entirely.

**Only logging failures.** Successes confirm the model/prompt is correctly sized and should be preserved.

**Logging vague observations.** "Agent was off" is useless. "Agent flagged optional chaining where the framework guarantees non-null" is actionable.

**Skipping the report because the task went smoothly.** A smooth session with zero observations IS the observation — record it so future comparison is possible.

**Dispatching both coordinators in parallel.** They coordinate sequentially: engineering first, then testing. The testing phase is causally downstream — `test_manager` needs the implementation `engineering_manager` produced.

## Red Flags

- Coordinator dispatches a generic "implementer" subagent instead of using the Role Map → Role Map was not passed in the dispatch prompt
- Review agent produces only Minor findings on a complex change → may be under-powered model
- Test writer produces tests that pass without a real implementation → mechanical test (not TDD)
- More than 2 back-and-forth loops on the same spec gap → spec was unclear; note this
- Role Map gap appears repeatedly → candidate for a new agent entry
