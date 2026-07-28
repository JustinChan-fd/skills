# harness-core

Shared deterministic spine for harness-intake / harness-plan /
harness-implement / harness-loop (the parent orchestrator — ticks the other
three in sequence). Not a skill itself — there is deliberately no SKILL.md
here.

## Why a Node CLI, not inline prose (Anthropic sources — retrieved 2026-07-27)

The whole architecture rests on one documented principle: **thin prose
SKILL.md files that shell out to executable scripts** for anything that must be
deterministic. The determinism lives once, in `tools/lib/*.mjs` + `schemas/`,
and is exercised by `node --test` — it never has to be re-derived by the model
per run. Sources (re-verify before treating as current; docs are dated
snapshots):

1. Agent Skills overview —
   <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>
   > "Executable scripts (fill_form.py, validate.py) that Claude runs using
   > bash, providing deterministic operations without loading their code into
   > context."
   Claude Code Skills also have "Full network access — the same network access
   as any other program on the user's computer" → why the Jira MCP, `gh`, and
   `git` all work from here.
2. Skills best practices —
   <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>
   > "Prefer scripts for deterministic operations: Write `validate_form.py`
   > rather than asking Claude to generate validation code."
   (also the plan-validate-execute pattern and "Provide utility scripts").
3. Engineering blog, Equipping agents for the real world with Agent Skills —
   <https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>
   > "Many applications require the deterministic reliability that only code
   > can provide."

This maps 1:1 to the harness pillar "Determinism over LLM for mechanical work":
the architecture *is* that pillar expressed structurally.

- `config/routing.json` — size budgets, task→tier map, reasoning budgets.
  System constants; changing them is changing the harness.
- `config/user.json` — machine-local (gitignored): repo registry, telemetry
  repo. Copy `user.example.json` and fill in.
- `schemas/` — JSON Schemas for every cross-agent artifact.
- `templates/` — brief / handoff / status-comment renderings.
- `tools/harness.mjs` — the CLI every skill shells out to.
  Exit codes: 0 ok · 1 validation/decision failure · 2 FATAL logging failure
  (the running skill must halt the run).
- `test/` — run with: `node --test "harness-core/test/**/*.test.mjs"` (zero deps, no
  network, no LLM calls).

## Invocation — always via the Skill tool

This rule applies to all four harness skills (`harness-loop`,
`harness-intake`, `harness-plan`, `harness-implement`), whether run standalone
or orchestrated: dispatch each one with `Skill({skill: "<name>"})`. Never
substitute a plain file `Read` of its `SKILL.md` handed to a subagent, and
never reimplement any part of the pipeline as a `Workflow`-tool script whose
`agent()` calls carry a paraphrased prompt instead of a real Skill
invocation. Only the Skill tool's own loading path is guaranteed to carry
everything a skill needs in effect — a manual Read or a Workflow script
quoting the file's text can silently drop context the skill depends on.
`harness-loop`'s driver-dispatch step is the one place today that invokes the
other three; it follows this rule so every future orchestrator should too.

## Individual vs. aggregate metrics

Each run's own `record.json` carries `tokens_by_tier` — that run's own
self-reported token spend (its nested subagent calls only; a run cannot see
its own total dispatch cost from inside its own context). This must keep
working standalone, with zero dependency on an orchestrator. When a run is
dispatched by something that CAN observe its total from outside (e.g.
harness-loop watching the Agent-tool call return), that caller may add
`tokens_observed` alongside it via `CLI record-observed-tokens` — additively,
never overwriting `tokens_by_tier`. Aggregation (summing observed totals
across a whole tick) is the orchestrator's job, done at its own level
(`loop.jsonl`), not baked back into the individual run record.
