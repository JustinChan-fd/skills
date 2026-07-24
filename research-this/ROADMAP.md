# Token-Optimized Research - Roadmap

## Current Version: MVP (v0.1)

**Status:** ✅ Baseline tested, skill written, awaiting verification testing

**Scope:**

- Manual task classification (simple/moderate/complex)
- Model selection criteria documented
- Orchestrator pattern (conceptual)
- Basic workflow for spawning agents with appropriate models

---

## Phase 1: MVP Features ✅

- [x] Model selection criteria table (Haiku/Sonnet/Opus)
- [x] Task classification examples
- [x] Orchestrator pattern (TypeScript conceptual)
- [x] Quick reference decision tree
- [x] Common mistakes from baseline testing
- [x] Real-world impact calculations
- [x] Integration with Claude Code Agent tool

**Deliverables:**

- `SKILL.md` with frontmatter, overview, patterns, examples
- Baseline testing completed (3 scenarios)
- Token savings calculated (37% reduction example)

---

## Phase 2: Enhanced Classification (Future)

**Goal:** More sophisticated task classification beyond simple/moderate/complex

**Features:**

- [ ] Token estimation formula (based on task type)
- [ ] Complexity scoring rubric (0-100 scale)
- [ ] Auto-detect code reading requirements (grep/find mentions)
- [ ] Multi-dimensional classification:
  - Requires codebase context? (yes/no)
  - Requires novel reasoning? (yes/no)
  - Repetitive generation? (yes/no)
  - Time-sensitive? (yes/no)
- [ ] Edge case handling (task seems simple but needs context)

**Why not MVP:** Manual classification works for most cases. Enhanced classification adds complexity without proportional value yet.

**Trigger for Phase 2:** Users frequently misclassify tasks, leading to quality issues or inefficiency.

---

## Phase 3: Dynamic Model Swapping (Future)

**Goal:** Switch models mid-execution based on observed complexity

**Features:**

- [ ] Detect when Haiku is struggling (incomplete output, errors)
- [ ] Automatic escalation to Sonnet
- [ ] Detect when Sonnet is underutilized (trivial operations)
- [ ] Automatic de-escalation to Haiku for subtasks
- [ ] Token usage monitoring per agent
- [ ] Real-time cost tracking

**Why not MVP:** Adds orchestration complexity. Manual selection is safer and more predictable.

**Trigger for Phase 3:** Users report wasted tokens on tasks that started complex but became simple (or vice versa).

---

## Phase 4: Batch Optimization (Future)

**Goal:** Optimize multiple agents running in parallel

**Features:**

- [ ] Group similar tasks to same agent (reduce context switching)
- [ ] Shared context loading (load AI_CONTEXT once, spawn multiple agents)
- [ ] Priority queuing (critical Opus tasks first, batch Haiku tasks)
- [ ] Agent pooling (reuse agents for similar task types)
- [ ] Cross-agent token accounting (total session cost)

**Why not MVP:** Requires coordination layer between agents. Most workloads are small enough that per-agent optimization suffices.

**Trigger for Phase 4:** Users regularly spawn 10+ agents and hit rate limits or budget concerns.

---

## Phase 5: Cost-Aware Orchestration (Future)

**Goal:** Optimize for cost, not just tokens

**Features:**

- [ ] Budget constraints (max $X per session)
- [ ] Cost-per-task tracking
- [ ] Model pricing updates (fetch latest Anthropic pricing)
- [ ] Cost vs speed tradeoffs (Haiku is slower but cheaper)
- [ ] Budget warnings (approaching limit)
- [ ] Cost report generation (session summary)

**Why not MVP:** Token optimization is good proxy for cost. Explicit cost tracking adds accounting overhead.

**Trigger for Phase 5:** Users need to justify AI spend to management or optimize for specific budget.

---

## Phase 6: Multi-Provider Support (Future)

**Goal:** Extend beyond Claude models to other providers

**Features:**

- [ ] OpenAI model support (GPT-4, GPT-4-turbo, GPT-3.5)
- [ ] Gemini model support (Pro, Flash, Ultra)
- [ ] Provider selection criteria (Claude for reasoning, Gemini for code)
- [ ] Cross-provider orchestration (best model for each task)
- [ ] Unified token accounting across providers
- [ ] Fallback chains (Claude → Gemini → OpenAI)

**Why not MVP:** Claude models cover most use cases. Multi-provider adds API complexity and authentication overhead.

**Trigger for Phase 6:** Users need specific capabilities from other providers (Gemini's long context, GPT-4's vision).

---

## Phase 7: Learning & Adaptation (Future)

**Goal:** Learn from usage patterns to improve classification

**Features:**

- [ ] Track actual token usage per task type
- [ ] Compare predicted vs actual complexity
- [ ] Adjust classification rules based on history
- [ ] User feedback loop ("this task should have used Sonnet")
- [ ] Personalized optimization (user A prefers speed, user B prefers cost)
- [ ] A/B testing (try both models, pick best)

**Why not MVP:** Requires persistent storage and ML. Manual rules work well enough initially.

**Trigger for Phase 7:** Large dataset of task→model→outcome mappings exists, and patterns emerge that improve accuracy.

---

## Testing Roadmap

**Phase 1 Testing (MVP):** ✅ In progress

- [x] Baseline scenarios (no skill)
- [ ] Verification scenarios (with skill) ← **NEXT**
- [ ] Rationalization plugging (close loopholes)
- [ ] Deployment verification

**Phase 2+ Testing:**

- Each phase requires new baseline + verification tests
- Focus on edge cases that trigger phase development
- Measure: token savings, quality consistency, user satisfaction

---

## Success Metrics

**MVP Success Criteria:**

- Agents correctly classify tasks as simple/moderate/complex
- Haiku used for ≥50% of simple tasks (baseline: 0%)
- Token usage reduced by ≥30% on mixed workloads
- No quality degradation (Haiku handles simple tasks well)
- Users adopt pattern without heavy prompting

**Long-term North Star:**

- Token efficiency improves 40-60% vs baseline
- 95%+ quality consistency across all model choices
- Users trust orchestration and don't override
- Cost savings translate to broader AI adoption

---

## Contributing & Iteration

**Feedback welcome on:**

- Classification criteria clarity
- Model selection accuracy
- Missing use cases
- Phase prioritization

**How to provide feedback:**

- File issues in skill repository
- Test with real workloads and report results
- Suggest new phases or features
- Share token savings data

**Current maintainer:** User (local skill, not published yet)

---

## Version History

**v0.1 (2026-05-19) - MVP**

- Initial skill creation
- Baseline testing completed (3 scenarios)
- Model selection criteria documented
- Orchestrator pattern provided
- Awaiting verification testing

**Future versions:** See phase roadmap above
