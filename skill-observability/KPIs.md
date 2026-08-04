# KPIs.md — the analytics catalog

What a dashboard can surface from the fields we already log. Each KPI states
its formula (over `index.jsonl` lines and/or full records), its grain, and
what decision it informs. `METRICS.md` defines the fields themselves; this
file is what you *build* with them.

## The data model (how to join)

Three tables fall out of the logs:

```
runs            ← index.jsonl, one row per record
                  key: run_id      (also in every full record at run.run_id)
records         ← the dated *.json files, one per run
                  key: run_id      (file path is in runs.file)
subagent_runs   ← exploded from records[].computed.subagent_runs
                  keys: (run_id of the record it appeared in,
                         spawned_by_run_id — THE join back to the spawning run,
                         file — stable per agent across records,
                         tool_use_id — joins to the exact Agent/Task call
                                       in the spawning record's raw)
```

Join semantics — this is the "single skill run id" association:

- **`spawned_by_run_id = runs.run_id`** rolls every subagent (including spend
  that arrived in *later* records, because agents run in the background) up
  to the skill run that launched it.
- **`spawned_this_run`** distinguishes launch rows from continuation rows.
- **`spawned_by_run_id = null`** = agent spawned in a turn nobody logged
  (pre-install, or non-skill turn without `SKILL_OBS_LOG_ALL`). Report these
  as "unattributed" rather than dropping them silently.
- **`session_id` + `logged_at`** chains records into a session timeline for
  task-level rollups (a skill that converses across turns).

Full skill-run rollup (the query behind most KPIs below):

```
run_total(run_id) =
    runs.cost_total_usd                                   # session-side spend
  + Σ subagent_runs.cost_usd
      WHERE spawned_by_run_id = run_id                    # ALL its agents' spend,
        AND NOT spawned_this_run                          # arrived in later records
# (agents spawned this run are already inside cost_total_usd — do not add twice)
```

---

## 1 · Cost & efficiency

| KPI | Formula (grain) | Informs |
| --- | --- | --- |
| **Skill efficiency** | `median(cost_marginal_usd)` per `skills[0]` × model (run) | The headline per-skill number. Trend across skill edits; a drop at equal quality = the edit paid off. |
| **True spend** | `Σ cost_total_usd` per day / skill / model | The bill. Budget alerts hang off this. |
| **Full run cost** | `run_total(run_id)` above (run) | What a skill *really* costs including late-arriving subagent spend — the honest version of true spend for delegating skills. |
| **Carry share** | `cost_context_carry_usd / cost_total_usd` (run; aggregate = medians, not means) | >80% ⇒ cost is where-you-ran, not what-ran. High median per skill ⇒ that skill is habitually invoked deep in sessions — a usage-pattern insight, not a skill defect. |
| **Cost per output token** | `cost_marginal_usd / tokens.totals.output` (run, full record) | Efficiency normalized for how much the skill actually produced. |
| **Cache write TTL mix** | `Σ cache_creation_1h / (Σ cache_creation_5m + Σ cache_creation_1h)` (day/skill, full records) | 1h writes cost 2× vs 1.25×; a shift here explains marginal-cost drift with zero behavior change. |
| **Cross-model price check** | `median(cost_marginal_usd)` per model for the same skill (requires `models`) | "Would this skill be fine on Sonnet?" Compare marginal cost *and* your quality judgment; the ~3.3× Fable→Sonnet price gap is the prize. |
| **Unknown-pricing exposure** | `count(cost_complete = false) / count(*)` (week) | When it rises, `lib/pricing.mjs` needs a new model entry; those runs are invisible to cost KPIs until re-priced. |

## 2 · Performance & latency

| KPI | Formula (grain) | Informs |
| --- | --- | --- |
| **Skill latency** | `median(active_ms)`, `p90(active_ms)` per skill (run) | User-felt speed. p90 catches the bad tail that medians hide. |
| **Human-wait share** | `(wall_ms − active_ms) / wall_ms` (run) | High ⇒ the skill blocks on you (questions, permissions). A skill redesign target distinct from making it "faster". |
| **Chattiness** | `api_calls` per run; trend per skill | Rising calls with flat output = thrash (retries, flailing tool loops). |
| **Throughput** | `tokens.totals.output / active_ms` (run, full record) | Output per second of work; distinguishes "slow model" from "many round-trips". |
| **Tool intensity** | `tool_calls / api_calls` (run) | How much of each API round-trip is doing vs talking. |

## 3 · Reliability

| KPI | Formula (grain) | Informs |
| --- | --- | --- |
| **Failure rate** | `count(trigger_event = 'StopFailure') / count(*)` per skill (week) | Hard failures; split by `error_type` (rate limit vs auth vs API). |
| **Abandonment rate** | `count(interrupted OR trigger_event = 'SessionEnd') / count(*)` per skill | You killing runs is a quality signal no error log captures — the "I gave up on it" metric. |
| **Cost of failure** | `Σ cost_total_usd WHERE trigger_event ≠ 'Stop'` (week) | Money spent on runs that didn't finish. Justifies (or not) hardening work. |
| **Degradation rate** | `count(records where computed.notes ≠ [])` per Claude Code version (full records) | The format-drift canary: a new CC version spiking notes means the transcript schema moved. |

## 4 · Delegation & subagents (the join in action)

| KPI | Formula (grain) | Informs |
| --- | --- | --- |
| **Delegation share** | `Σ subagent_runs.tokens_grand_total (by spawned_by_run_id) / run_total tokens` (skill run) | How much of a skill's work is fanned out. Sudden shifts explain most sudden cost shifts. |
| **Subagent cost per skill run** | `Σ subagent_runs.cost_usd GROUP BY spawned_by_run_id` | The rolled-up "what did delegation cost this run" — the join's headline query. |
| **Agent-type mix** | `Σ cost_usd GROUP BY agent_type, skill` | Which agent types (Explore, general-purpose, …) each skill leans on, and what each costs. |
| **Straggler spend** | `Σ cost_usd WHERE NOT spawned_this_run` per skill | Spend arriving after the launching turn ended — the background-work tail. Large values argue for the log-on-nonzero-delta trigger (open question #1). |
| **Unattributed spend** | `Σ cost_usd WHERE spawned_by_run_id IS NULL` (week) | Delegated spend no skill run owns. Rising ⇒ consider `SKILL_OBS_LOG_ALL=1`. |
| **Fan-out width** | `count(subagent_runs WHERE spawned_this_run) per run_id`; p90 per skill | Parallelism shape; a skill whose width grows over versions is quietly getting more expensive. |
| **Delegation efficiency** | `subagent cost / run_total cost` vs skill latency, per skill | Did fanning out actually buy speed, or just multiply cost? |

## 5 · Context & caching

| KPI | Formula (grain) | Informs |
| --- | --- | --- |
| **Session depth at invocation** | `median(boundary_total)` per skill (run) | Where in sessions each skill gets used. Pairs with carry share. |
| **Depth sensitivity** | regression/plot of `cost_marginal_usd` vs `boundary_total` per skill | THE deep-session question: flat line = skill is depth-immune (carry tax only); rising marginal = skill genuinely degrades in deep sessions — a real optimization target. |
| **Cache hit ratio** | `cache_read / (input + cache_read)` (run, full records) | Should sit near 1.0 in ongoing sessions. A drop = a cache invalidator appeared (changed system prompt, tool set churn) — silently multiplies cost ~10× on the affected prefix. |
| **Context growth per run** | `boundary_total − lag(boundary_total) OVER session` (session timeline) | Which skills bloat the session for everything that follows them — a cost externality no per-run number shows. |

## 6 · Usage & adoption

| KPI | Formula (grain) | Informs |
| --- | --- | --- |
| **Run frequency** | `count(*)` per skill per week | Dead skills (retire?) vs hot paths (optimize these first). |
| **Skill spend ranking** | `Σ cost_total_usd` per skill per month, ranked | Where the money goes; the "is it still providing value" conversation starter. |
| **Invocation channel** | `count` by `raw.invocations[].kind` (slash_command vs skill_tool, full records) | Are skills user-driven or model-driven? Changes how you write trigger descriptions. |
| **Multi-skill turns** | `count(len(skills) > 1) / count(*)` | If material, attribution ambiguity (METRICS.md #3) matters; if ~0, ignore it. |

## 7 · Meta / data health

| KPI | Formula (grain) | Informs |
| --- | --- | --- |
| **Pricing coverage** | distinct `models` with null cost (week) | Maintenance signal for the pricing table. |
| **Schema mix** | `count(*) GROUP BY schema_version` | When the record shape evolves, dashboards branch on this. |
| **errors.log growth** | `wc -l .state/errors.log` over time | The logger's own health; should be near-flat. |
| **Repriced deltas** | recompute old records' cost at current `pricing_version` vs stored | "What would last month cost at today's rates" — honest trend lines across price changes. |

---

## Dashboard starter (minimal viable)

Load `index.jsonl` → one page, four tiles + two charts:

1. **Spend this week** (`Σ cost_total_usd`) with per-skill breakdown
2. **Top skill by median marginal cost** (efficiency leaderboard, per model)
3. **Failure + abandonment rate** per skill
4. **Unattributed subagent spend** (data-quality tile)
5. Chart: `cost_marginal_usd` vs `boundary_total` scatter, colored by skill
   (depth sensitivity)
6. Chart: per-skill median marginal cost over time (efficiency trend)

Everything above needs only `index.jsonl` except the depth scatter's marginal
detail, cache hit ratio, TTL mix, and the subagent rollups — those read the
full records (still just `jq` over a folder of JSON).
