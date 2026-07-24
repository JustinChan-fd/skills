---
name: prompt-after-compact
description: Generate a continuation prompt for picking up work after compacting
model: anthropic.claude-sonnet-4-6
---

# Continue Prompt Generator

Generates a well-formatted continuation prompt to use after compacting the conversation.

## When to Use

Before compacting your conversation when you want to preserve context for the next session.

## Output Format

Provide a continuation prompt in this structure:

```
# Continuation from [date]

## Current Work
[Brief description of what we're working on - ticket/feature/bug]

## Progress
- [x] Completed items
- [ ] In progress items
- [ ] Remaining items

## Current State
- Branch: [branch name]
- Files modified: [key files]
- Last action: [what was just done]

## Next Steps
[What should happen next, in priority order]

## Important Context
[Any critical context, decisions, or blockers that must carry forward]
```

## Instructions

1. **Review recent conversation** - Look back at the last 5-10 exchanges
2. **Identify the main task** - What's the overarching goal?
3. **Capture progress** - What's done vs. what remains?
4. **Note current state** - Branch, files, last action taken
5. **Define next steps** - Clear actionable items in priority order
6. **Include critical context** - Decisions, constraints, blockers

## Example

```
# Continuation from 2026-05-19

## Current Work
MC-461: Refactoring API client to improve type safety and error handling

## Progress
- [x] Analyzed current API client structure
- [x] Identified type safety gaps
- [ ] Implement new typed API client
- [ ] Update consuming components
- [ ] Add error boundary handling

## Current State
- Branch: MC-461-refactor-api-client
- Files modified: None yet (planning phase)
- Last action: Completed analysis of current implementation

## Next Steps
1. Create new typed API client in src/api/
2. Add proper error types and handling
3. Migrate existing API calls incrementally
4. Update tests

## Important Context
- Must maintain backward compatibility during migration
- Error handling should use React Error Boundaries
- TypeScript strict mode is enabled
```

## Tips

- **Be concise** - One line per item where possible
- **Be specific** - "Implement UserAPI" not "work on API"
- **Include branch** - Makes it easy to resume work
- **Note blockers** - If waiting on something, say so explicitly
- **Use checkboxes** - Makes progress visible at a glance
