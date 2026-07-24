# Adversarial Review Skill

A multi-agent adversarial review system that catches logical contradictions, edge cases, and project-specific constraint violations in specs and plans.

## Quick Start

```bash
# Review a spec or plan
/adversarial-review docs/feature-spec.md

# Review current plan in conversation
/adversarial-review current plan

# Review code changes (auto-delegates to pr-review)
/adversarial-review current branch
```

## When to Use This

**Most valuable for:**
- ✅ Complex specs (>3 pages, multiple systems)
- ✅ High-risk changes (security, data model, architecture)
- ✅ Projects with documented constraints (CLAUDE.md, planning checklists)
- ✅ Cross-team specs with multiple stakeholders
- ✅ "Did I forget anything?" validation before execution

**Low value for:**
- ❌ Simple, isolated features
- ❌ Specs already validated by experienced humans
- ❌ No project constraints to check against

**Honest assessment**: Without project-specific context, this provides generic advice. With project docs (CLAUDE.md, AI_CONTEXT.md, planning-checklist.md), it catches constraint violations before they become bugs.

## What It Reviews

### Specs & Plans (with adaptive project context loading)
- **Logical contradictions**: Section A says X, Section B assumes not-X
- **Edge cases**: What if API is down, user has no data, concurrent edits, rate limits?
- **Project constraints**: Violations of rules in CLAUDE.md, planning-checklist.md, AI_CONTEXT.md
- **Unstated assumptions**: "This assumes X" but X is never specified
- **Security runtime risks**: Auth gaps, input validation, data exposure, OWASP Top 10
- **Scale failures**: N+1 queries, unbounded growth, cost explosions

### Code (Delegates to pr-review)
When reviewing code/branches/PRs, automatically invokes `/pr-review` for:
- Type safety, forbidden patterns, accessibility
- Error handling, code duplication
- GitHub Copilot simulation
- Test failures

## Architecture Decision: Code Delegation

**Why delegate to pr-review instead of duplicating logic?**

✅ **Single Responsibility** - pr-review is already optimized for code  
✅ **Maintainability** - code review logic lives in one place  
✅ **Cost-efficiency** - pr-review's token optimization ($0.11) shouldn't be duplicated  
✅ **Simplicity** - no duplicate multi-phase code logic  

This follows the "call other skill rather than duplicate" pattern.

## Cost

- Specs/Plans: ~$0.10-0.17 (with project context, depends on length)
- Code: ~$0.11 (delegates to pr-review)
- Runtime: ~25-35s (phases run in parallel)

## How It Works

**Invocation modes:**
- **Inline (live session):** `Skill tool with skill="adversarial-review"` — main session carries out each phase interactively.
- **Workflow (background, parallel):** `Workflow tool targeting workflow.js` — real background agents, explicit per-call model overrides. Used by orchestration scripts like `spec-to-pr-harness`.

**Review committee (3 seats, run in parallel):**

| Seat | Model | Responsibility |
|---|---|---|
| Logic-consistency | haiku | Contradictions, edge cases, constraint violations, assumptions |
| Runtime-risk | haiku | Scale/cost/failure modes only (security excluded) |
| Security | **sonnet** | Dedicated OWASP Top 10 pass — never downgraded to haiku |

**Phase 0**: Adaptive context loading ($0)
- Checks for CLAUDE.md, AI_CONTEXT.md, planning-checklist.md, memory
- No project docs? Review still checks logic/edge cases

**Phase 1 + 1.5 + 1.6** (parallel): Logic + Runtime-risk + Security committee

**Phase 2**: Adversarial challenge (Haiku, ~$0.02)
- Validates/rejects/adds findings from all 3 committee seats

**Phase 3**: Synthesis ($0)
- Merges findings, applies severity changes, adds "Known Blindspots" section

## Integration with Workflow

### Recommended Flow
1. **brainstorming** → adversarial-review → **executing-plans**
2. **writing-plans** → adversarial-review → **executing-plans**
3. Code changes → adversarial-review → **pr-review** (auto-delegated)

## Output

Review generates a structured report with:
- Summary (critical/major/minor/dismissed counts, actual cost/runtime)
- Critical issues (must fix before proceeding)
- Major issues (should address)
- Minor suggestions (nice to have)
- Dismissed findings (false positives explained)
- **Known Blindspots** (what this review cannot detect — avoids false confidence)

Reports saved to: `.claude/reviews/adversarial-[name]-[timestamp].md`

## Future Enhancements (Roadmap)

**Completed:**
- ✅ v1.1: Adaptive project context loading

**Future:**
- v1.2: Historical pattern learning
- v1.3: Pre-execution hook (auto-review before plan execution, opt-in)
- v1.4: `--focus` flags for targeted depth (`--focus=security`, `--focus=business`)
- v2.0: Opt-in expert agents (only if prompt is specific checklist with zero overlap)
