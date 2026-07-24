---
name: adversarial-review
description: Multi-agent adversarial review for specs, plans, and code - acts as defense against hasty approval
version: 2.0.0
# model: field here is non-binding — per-phase model dispatch is controlled by workflow.js
---

# Adversarial Review Skill

**Purpose**: Catch logical contradictions, edge cases, and project-specific violations in specs/plans before execution.

**Scope**: 
- Specs & Plans: Logic consistency, edge cases, project constraint violations, assumptions surfacing
- Code: Delegates to `/pr-review` skill for cost-optimized code review
- Acts as "second opinion" defense layer

**Cost**: ~$0.10-0.17 for specs/plans (with context loading, depends on length). Code changes: ~$0.10-0.20 depending on diff size.

## When to Use This Skill

**Most valuable for:**
- ✅ Complex specs (>3 pages, multiple systems interacting)
- ✅ High-risk changes (security, data model, architecture)
- ✅ Cross-team specs (multiple stakeholders with different assumptions)
- ✅ Projects with documented constraints (CLAUDE.md, planning checklists)
- ✅ When rushing and need "did I forget anything?" validation

**Low value for:**
- ❌ Simple, isolated features ("add a button")
- ❌ Specs already validated by experienced humans
- ❌ No project constraints exist to check against

**Honest assessment**: Without project-specific context, this provides generic security/performance advice. With project context (CLAUDE.md, planning docs), it catches constraint violations before they become bugs.

---

## Content Detection & Routing

### Step 1: Determine Review Type

Check what's being reviewed:

```bash
# If user provides file path
if [[ "$INPUT" =~ \.(md|txt)$ ]]; then
  CONTENT=$(cat "$INPUT")
  TYPE="document"
elif [[ "$INPUT" =~ ^(spec|plan|requirement|design) ]]; then
  TYPE="document"
elif [[ "$INPUT" == "current branch" ]] || [[ "$INPUT" == "PR" ]] || [[ "$INPUT" == "diff" ]]; then
  TYPE="code"
else
  # Ask user for clarification
  echo "What should I review? (spec/plan/code/branch)"
fi
```

### Step 2: Route to Appropriate Review

**If TYPE = "code"**:

Run these steps:
1. Get the diff: `git diff main...HEAD -- ':!package-lock.json' ':!*.min.js' ':!dist/' ':!build/' ':!*.snap'`
2. Load project context (same as Phase 0 below)
3. Run 3 parallel review agents against the diff:
   - **Logic/correctness** (haiku): logic bugs, null checks, broken edge cases, constraint violations from project context
   - **Runtime** (haiku): N+1, memory leaks, unbounded loops — skip security
   - **Security** (sonnet): OWASP Top 10 — never downgrade to haiku
4. Run `npm test -- --run` and include any failures as critical findings
5. Synthesize into the same report format as document review (Critical / Major / Minor)
6. EXIT

**If TYPE = "document"**:
→ Continue to Phase 0 below

---

## How It Works

Invoke via the `Skill` tool or `/adversarial-review`. The main session carries out each phase inline. The spec-to-pr-harness has its own inlined review logic for plan and code review — it does not call this skill.

The review committee for document review has **3 seats**:
1. **Logic-consistency** (haiku) — contradictions, edge-cases, constraint violations, assumptions (Phase 1)
2. **Runtime-risk** (haiku) — scale/cost/failure modes only; security explicitly excluded (Phase 1.5)
3. **Security** (sonnet) — dedicated OWASP Top 10 pass; never haiku (judgment-quality floor required)

---

## Document Review Flow (Specs & Plans)

### Phase 0: Load Project Context (Main Session, $0)

**Purpose**: Find project-specific constraints to check against. Without this, review is generic advice.

**Adaptive loading** (check existence, load what's available, skip what's not):

```bash
# Check for common project documentation
PROJECT_CONTEXT=""

# Core project instructions
if [ -f "CLAUDE.md" ]; then 
  PROJECT_CONTEXT+="Project Instructions:\n$(cat CLAUDE.md)\n\n"
fi

# Domain-specific rules (common in this user's projects)
if [ -f "docs/AI_CONTEXT.md" ]; then 
  PROJECT_CONTEXT+="Critical Rules:\n$(cat docs/AI_CONTEXT.md)\n\n"
fi

# Planning requirements
if [ -f "docs/planning-checklist.md" ]; then 
  PROJECT_CONTEXT+="Planning Checklist:\n$(cat docs/planning-checklist.md)\n\n"
fi

# Recent project memory (first 30 lines = high-priority items)
if [ -f ".claude/memory/MEMORY.md" ]; then 
  PROJECT_CONTEXT+="Project Memory:\n$(head -30 .claude/memory/MEMORY.md)\n\n"
fi

# If no context found, note it explicitly
if [ -z "$PROJECT_CONTEXT" ]; then
  PROJECT_CONTEXT="No project-specific constraints found. Review will focus on logical consistency and edge cases only."
fi
```

**Token budget**: ~5-10K tokens for project context (if it exists). Extract only constraint/requirement sections if docs are large.

**Pass to agents**: Include `PROJECT_CONTEXT` in Phase 1 and Phase 1.5 prompts.

---

### Phase 1: Logical Consistency & Completeness

**Agent**: `claude-haiku-4-5-20251001` (~35K in, ~5K out, $0.05)

**Purpose**: Find logical contradictions, missing edge cases, and violations of project-specific constraints.

**Prompt** (keep <2K tokens):

```
Review this spec/plan against project context. Output JSON only:
[
  {
    "section": "section name or 'general'",
    "category": "contradiction|edge-case|constraint-violation|assumption|ambiguity",
    "severity": "critical|major|minor",
    "issue": "Brief description",
    "suggestion": "Specific improvement"
  }
]

Focus on:
1. Logical contradictions: Section A says X, Section B assumes Y (mutually exclusive)
2. Edge cases: What if API is down? User has no data? Concurrent edits? Rate limit hit? Zero/negative values?
3. Project constraint violations: Does this violate rules in project context below?
4. Unstated assumptions: "This assumes X" but X is never specified or guaranteed
5. Ambiguous instructions: Multiple engineers would implement this differently

PROJECT CONTEXT:
[PROJECT_CONTEXT from Phase 0]

DOCUMENT TO REVIEW:
[DOCUMENT CONTENT]
```

**Note**: If PROJECT_CONTEXT is empty, Phase 1 still checks for contradictions, edge cases, and assumptions — just without project-specific constraints.

**Parse output**: Expect JSON array of findings.

### Phase 1.5: Runtime Risk Assessment (Scale & Cost only)

**Agent**: `claude-haiku-4-5-20251001` (~35K in, ~5K out, $0.05)

**Purpose**: Identify runtime scale and cost failure modes. **Mutually exclusive with Phase 1** (Phase 1 checks document logic) and **mutually exclusive with the Security seat** (security is its own dedicated Phase 1 agent — see committee description above).

**Prompt** (keep <2K tokens):

```
Review this spec/plan for scale and cost runtime risks. Output JSON only:
[
  {
    "section": "section name or 'general'",
    "category": "dos-risk|scale-failure|cost-explosion|single-point-of-failure|memory-leak",
    "severity": "critical|major|minor",
    "issue": "Brief description",
    "suggestion": "Specific improvement"
  }
]

Check ONLY runtime scale and cost behavior:
- N+1 queries or unbounded loops that grow with data
- Memory leaks or unbounded growth (caches without expiry, no pagination)
- Cost explosion (API calls in loops, missing caching, over-provisioning)
- Single point of failure (no fallback if X is down)
- Thundering herd or fan-out amplification

Skip security findings (auth, injection, data exposure) — those go to the dedicated security reviewer.
Skip document clarity/logic — that's Phase 1's job.

PROJECT CONTEXT:
[PROJECT_CONTEXT from Phase 0]

DOCUMENT TO REVIEW:
[DOCUMENT CONTENT]
```

**Note**: Runs in parallel with Phase 1 and the Security agent (no added time).

**Parse output**: Expect JSON array of security/scale findings.

### Phase 1.6: Security Review (Dedicated Seat)

**Agent**: `claude-sonnet-4-6` (NOT haiku — security requires judgment-quality model)

**Purpose**: OWASP Top 10 pass. Security findings must not be diluted into the runtime-risk reviewer's scope. This is a dedicated seat.

**Prompt** (keep <2K tokens):

```
You are a security reviewer. Review this spec/plan for security vulnerabilities using the OWASP Top 10. Output JSON only:
[
  {
    "section": "section name or 'general'",
    "category": "auth-gap|input-validation|data-exposure|injection|rate-limiting|misconfiguration|insecure-design",
    "owasp": "A01:2021 - Broken Access Control (or whichever applies)",
    "severity": "critical|major|minor",
    "issue": "Brief description",
    "suggestion": "Specific improvement"
  }
]

Check for:
- Authentication/authorization gaps and privilege escalation
- Input validation: User-supplied data without sanitization?
- Data exposure: PII, tokens, keys logged or transmitted insecurely?
- Rate limiting: Can endpoints be abused with repeated requests?
- Injection: SQL, command, XSS, template injection risks?
- Security misconfigurations: Insecure defaults, unnecessary features enabled?
- Insecure design: Missing security controls at the design level?

Skip scale/cost/performance findings — those go to the runtime-risk reviewer.

PROJECT CONTEXT:
[PROJECT_CONTEXT from Phase 0]

DOCUMENT TO REVIEW:
[DOCUMENT CONTENT]
```

**Note**: Runs in parallel with Phase 1 and Phase 1.5. Model is always sonnet or higher — never downgrade security review to haiku.

---

### Phase 2: Adversarial Challenge

**Agent**: `claude-haiku-4-5-20251001` (~15K in, ~3K out, $0.02)

**Prompt** (keep <1K tokens):

```
Challenge these findings. Output JSON:
{
  "validated": [/* findings that are correct */],
  "rejected": [/* findings with "reason" field */],
  "new": [/* missed issues */],
  "severity_changes": [/* findings with updated severity + "reason" */]
}

For each finding:
1. Is it actually a problem? (false positives?)
2. Is severity correct? (critical vs major vs minor)
3. Is suggestion actionable and correct?
4. What edge cases or risks were missed?
5. Are there alternative approaches that are better?

[PHASE 1 + PHASE 1.5 FINDINGS JSON]
```

**Parse output**: Expect validated/rejected/new findings + severity changes.

### Phase 3: Synthesis (Main Session, $0)

1. **Merge findings**: validated + new - rejected + severity_changes

2. **Categorize**:
   - Critical: Blocks execution (security gaps, logical contradictions, constraint violations)
   - Major: Should address before proceeding (edge cases, ambiguity, unstated assumptions)
   - Minor: Nice to have (style, additional considerations)

3. **Calculate actual cost**: Track token usage from Phase 1, 1.5, and 2 agent calls. Surface in report.

4. **Generate report**:

```markdown
# Adversarial Review: [document name]

**Type**: Spec / Plan / Design  
**Date**: [timestamp]  
**Cost**: $X.XX ([actual tokens]K tokens), [actual runtime]s  
**Project Context**: [Loaded / Not Available]

## Summary

- Critical: X issues (must fix before proceeding)
- Major: Y issues (should address)
- Minor: Z issues (nice to have)
- Dismissed: W findings (false positives)

## Critical (X) - Must fix before execution

### [Section Name]
1. **[category]**: [issue]  
   → Suggestion: [suggestion]  
   → Impact: [why this blocks execution]

## Major (X) - Should address

[same format]

## Minor (X) - Nice to have

[same format]

## Dismissed (X)

1. [issue] → Reason: [why rejected by adversarial review]

## Known Blindspots

This review **cannot** detect:
- Business viability (is this solving the right problem?)
- UX feasibility (will users understand this?)
- Domain-specific constraints not in project docs
- Issues requiring deep expertise (legal, compliance, specialized domains)
- Whether simpler alternatives exist

**If this is high-risk, consider:**
- Human review from domain expert
- Prototype validation before full implementation
- Phased rollout with monitoring
```

5. **Ask user**: "Address critical issues now, or save report?"
   - If "now": Create tasks for critical issues
   - If "save": Write to `.claude/reviews/adversarial-[name]-[timestamp].md`

6. **Error handling**: If any agent returns malformed JSON or fails, surface the raw output with a warning rather than failing silently. Note which phase failed in the report.

---

## Token Optimization Checklist

- [ ] **Phase 0**: If project docs >20KB, extract only sections with "rules", "forbidden", "requirements", "checklist" headers
- [ ] **Phase 1 + 1.5**: For docs >20KB, pass only sections with content-bearing headers, strip code examples unless reviewing implementation correctness
- [ ] **Phase 2**: Gets findings JSON only (no original document, no project context)
- [ ] **JSON output**: All agents output JSON only, no prose
- [ ] **Early stop**: If Phase 1 finds >30 critical issues, stop and report "document needs major rework"
- [ ] **Model selection**: Use Haiku for all phases (cost-effective for text review)
- [ ] **Parallelization**: Run Phase 1 + 1.5 in parallel (no time penalty)

**Cost by document size** (with project context):

- Small (1-5 pages): $0.08-0.12 (+$0.02 for context loading)
- Medium (5-15 pages): $0.12-0.17 (+$0.02 for context loading)
- Large (15-30 pages): $0.17-0.27 (+$0.02 for context loading)

**Without project context**: Subtract $0.02 from estimates above.

---

## Usage Examples

### Review a spec file
```
/adversarial-review docs/feature-spec.md
```

### Review current plan
```
/adversarial-review current plan
```

### Review code changes (delegates to pr-review)
```
/adversarial-review current branch
→ Detects code, invokes /pr-review automatically
```

### Review inline content
```
/adversarial-review
[paste spec/plan content]
```

---

## Integration with Other Skills

- **brainstorming** → adversarial-review → **executing-plans**
  - After brainstorming creates a plan, use adversarial-review before execution
- **writing-plans** → adversarial-review → **executing-plans**
  - After writing a plan, use adversarial-review before execution
- **Code changes** → adversarial-review → **pr-review**
  - Detects code and delegates to pr-review automatically

---

## Roadmap

**Completed:**
- ✅ v1.1: Adaptive project context loading (CLAUDE.md, AI_CONTEXT.md, planning-checklist.md, memory)

**Future enhancements:**
- v1.2: Historical pattern learning (analyze past memory entries for recurring issues)
- v1.3: Pre-execution hook (auto-review before EnterPlanMode exits, opt-in)
- v1.4: `--focus` flags for targeted depth (`--focus=security`, `--focus=business`)
- v2.0: Specialized expert agents — **only add if prompt is a 5-10 item checklist with zero overlap to existing phases**

**Expert agent rule**: A new expert (e.g., "UX expert", "cost expert") is only worth adding if:
1. Its prompt is a numbered checklist of specific checks
2. Zero overlap with existing Phase 1/1.5 prompts
3. User opts in with a flag (not default, avoids noise)

Generic "act as X expert" prompts create signal dilution and redundant findings — avoid.
