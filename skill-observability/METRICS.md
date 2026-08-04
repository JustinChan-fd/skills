# METRICS.md — what every number means, and what to do with it

Companion to the records in `~/.claude/skill-runs/`. Read this when a number
surprises you, or before building a KPI on one. Written plain: each metric
says what it is, where it comes from, and what decision it supports.

The one mental model to keep: **a record measures a *run in a session*, not a
skill in isolation.** Three confounds follow from that — prompt-cache state,
session depth, and model — and most of the derived metrics below exist to
control for them.

Cache state is the big one and the least obvious: reading a cached token costs
1/12.5 of writing it, so the same skill costs ~8x more when the 5-minute cache
TTL has expired. **COST.md** derives this from 36,794 measured calls and is the
place to start if the marginal/carry split doesn't yet make sense. Session depth
turned out to be a *proxy* for cache state, not an independent confound — see
COST.md §4 for the measurement that retired it.

---

## The index line (`index.jsonl`) — one per run

| Field | What it is | What it's for |
| --- | --- | --- |
| `run_id` | Deterministic record id: `<session8>-<line_from>-<line_to>` | Primary key. Subagent activity anywhere joins back to its spawning run via `spawned_by_run_id = run_id` (see KPIs.md, "The data model"). |
| `skills` | Skill/command names detected in the turn | Group-by key for every KPI |
| `models` | Model ids that served API calls in the run | **Confound #2.** A $4 Fable 5 run ≈ $1.20 of identical work on Sonnet ($10/$50 vs $3/$15 per MTok). Never compare costs across models without filtering or normalizing on this field. |
| `tokens_grand_total` | Sum of all four directions (input + output + cache reads + cache writes), session + subagents | Volume of API traffic. NOT "what the run consumed of the context window" — see `boundary_total`. |
| `boundary_total` | Four-way sum of the **last** API call only | The context footprint at run end (~"how deep in the session was this?"). **Confound #1's measuring stick.** Also the number that reconciles with an external dispatcher's observation (alfred's `tokens_observed`). |
| `cost_total_usd` | `cost_marginal_usd + cost_context_carry_usd` | What you actually paid for this run. The budgeting number. |
| `cost_marginal_usd` | Cost of input + output + cache **writes** — spend the run itself caused | **The skill-efficiency number.** Comparable across runs of the same skill on the same model **when `attribution.cache_state` is `warm`** — a cold cache puts a full context re-write inside marginal, measured 8x. Filter on `attribution.marginal_comparable`. See COST.md. |
| `cost_context_carry_usd` | Cost of cache **reads** — re-reading context that mostly existed before the run | The session-depth tax. High carry is a property of *where* you ran the skill, not of the skill. |
| `cost_complete` | `false` if any model had no pricing entry | When false, `cost_total_usd` is null and `cost_known_models_usd` holds the partial sum. Filter these out of cost KPIs. |
| `wall_ms` | Last timestamp − first timestamp in the window | Latency as you experienced it. |
| `active_ms` | Same, but idle gaps are capped at 5 min each | Working time. `wall_ms − active_ms` ≈ time the run sat waiting on you. |
| `api_calls` | Assistant messages with usage in the window | Turn "chattiness". Rising api_calls with flat output often means thrash. |
| `subagents` | Subagent transcripts with new activity in the window | Delegation shape of the run. |
| `interrupted` | A tool result carried `interrupted: true` | You stopped something mid-run. |
| `trigger_event` / `error_type` | `Stop` (normal), `StopFailure` + error type, `SessionEnd` | Failure-rate KPIs. |
| `schema_version` | Record shape version | Filter/branch on this in dashboards when the shape evolves. |

## Full-record extras (`computed.*` in the dated JSON files)

- `tokens.by_model.<model>` — per-direction buckets: `input`, `output`,
  `cache_read`, `cache_creation_5m`, `cache_creation_1h`,
  `cache_creation_unattributed`, `api_calls`. The 5m/1h write distinction
  matters because they're billed differently (×1.25 vs ×2 of input rate);
  `unattributed` means the transcript omitted the TTL split — priced at 5m
  and flagged in `notes`.
- `cost.by_model.<model>` — the same marginal/carry split per model, plus the
  exact `rates` used (with `variant`: standard / fast / introductory).
- `duration.gap_cap_ms` — the idle cap (default 5 min) behind `active_ms`.
- `counts.tool_calls_by_name` — what the run actually did (`Bash: 12,
  Edit: 4, Agent: 1` tells a story `cost` alone doesn't).
- `counts.subagent_tokens_grand_total` — how much of the volume was delegated.
- `subagent_runs[]` — the join table: one row per agent with new activity in
  this window, carrying `spawned_by_run_id` (the run that launched it — even
  when the spend arrived records later), `spawned_this_run`, `agent_type`,
  `tool_use_id`, per-agent token/cost totals, and `models`. This is how
  "everything this skill run caused, including background agents" is
  assembled — the rollup query is in KPIs.md.
- `outcome` — trigger event, `SessionEnd` reason, `StopFailure.error_type`,
  interruption flag.
- `notes[]` — every degradation, structured. An empty array means the record
  is clean end-to-end.
- Everything under `raw` is the untouched evidence (verbatim per-call usage
  objects with request ids). When a computed number looks wrong, the raw
  section of the same file is how you check it.

---

## KPI recipes

**Skill efficiency (the main one).**
`median(cost_marginal_usd)` per skill, filtered to one model. Trend it across
skill edits: if a prompt change drops median marginal cost 30% at equal
outcome quality, the change paid for itself. Raw `cost_total_usd` can't do
this job — it mostly tracks session depth.

**True spend.**
`sum(cost_total_usd)` per day/skill. This is the bill. Marginal is for
comparing; total is for budgeting. They answer different questions — don't
substitute one for the other.

**Session-depth sensitivity.**
Plot `cost_context_carry_usd` (or carry share, `carry / total`) against
`boundary_total` per skill. A skill whose *marginal* cost also climbs with
`boundary_total` is genuinely degrading in deep sessions (e.g. re-reading
ever-more context into its own work) — that's a real optimization target, and
this plot is how you distinguish it from the ordinary carry tax.

**Filter to `marginal_comparable` first.** Mixing cold runs into this plot
manufactures a depth effect that isn't there: cold runs skew toward session
start, so their one-time cache-write cost reads as "marginal climbs at low
depth." That is exactly the artifact that produced an earlier wrong conclusion
here (COST.md §4).

**Latency.**
`median(active_ms)` per skill; `wall_ms − active_ms` for human-wait time.

**Failure rate.**
`count(trigger_event != 'Stop' OR interrupted) / count(*)` per skill.

**Delegation share.**
`subagent_tokens_grand_total / tokens_grand_total` — how much of a skill's
work is fanned out. A sudden shift here explains most sudden cost shifts.

**Is this skill still worth it?**
Cost side: median marginal cost × runs/week, trended. Value side is yours to
judge — but now the cost side is a number instead of a feeling.

---

## Edge cases and honest limits

1. **Marginal vs carry is an approximation, not billing truth.** The API
   bills reads and writes exactly as recorded (that part is exact). The
   *interpretation* — "writes = caused by the run, reads = pre-existing
   context" — is approximate: within a multi-call turn, later calls re-read
   what earlier calls wrote (turn-internal reads land in carry), and the
   system prompt written at session start lands in the first turn's marginal.
   Good enough to separate the confounds; don't treat cents-level differences
   as signal.
2. **Model changes what a dollar means.** Same work, different price:
   Fable 5 $10/$50, Opus 5 $5/$25, Sonnet 5 $3/$15, Haiku $1/$5 per MTok
   (in/out). Filter every cost comparison by `models`, or compare token
   volumes when models differ (with the caveat that tokenizers differ across
   model families too).
3. **Multi-skill turns.** Two skills in one turn produce one record with both
   names; token attribution between them is inherently ambiguous inside a
   turn. Count such runs in both groups or exclude them (they're flagged by
   `skills.length > 1`).
4. **A record is per-turn, not per-task.** A skill that converses across
   three turns produces up to three records (turns without a new invocation
   aren't logged by default). Sum by `session_id` + time window for task-level
   cost, or run `SKILL_OBS_LOG_ALL=1`.
5. **Background work between logged turns.** Subagent/workflow spend during
   *non-logged* turns is consumed by the cursor without a record (totals stay
   correct; detail is lost). `SKILL_OBS_LOG_ALL=1` closes this; a
   "log-on-nonzero-subagent-delta" trigger is an open question in README.
6. **First firing after mid-session install** covers the whole session so
   far — expect one oversized record per already-running session on install
   day.
7. **`tokens_grand_total` is not context consumption.** It's traffic: a
   500K-token context read 7 times contributes 3.5M. For "how big was the
   context", read `boundary_total`.
8. **Pricing is a snapshot.** Every record carries `pricing_version`; when
   rates change, edit `config/model-rates.json` (vendor table, transcribed
   verbatim), bump its `rates_version`, and old records remain re-priceable from
   their `raw` token counts. `lib/pricing.mjs` holds no numbers.
   The config also carries each model's id on **all three platforms**
   (`ids.anthropic` / `ids.bedrock` / `ids.vertex`) with an `id_conventions`
   block explaining the differences, because we reach Claude through the
   Keystone Bedrock gateway and a Bedrock id is not the Claude API id. Only the
   Claude API form is matched; the rest are normalized into it. Two id shapes
   were priced **null** before 2026-08-04: regional Bedrock inference profiles
   (`us.anthropic.claude-opus-5`, two dotted prefixes where the strip regex
   handled one) and Haiku 3.5 (whose real id inverts word order —
   `claude-3-5-haiku` — and now resolves via `prefix_aliases`).
11. **Absolute dollars may be ~10% low, uniformly.** Two independent 1.1x
    modifiers, neither detectable from the transcript. First-party: Claude 4.6+
    with `inference_geo: "us"` bills 1.1x, and `inference_geo` is a request
    field that never appears in the transcript. Bedrock: AWS invoices from its
    own rate card, and its regional / multi-region endpoints carry a 10% premium
    over global — and the transcript does not say which endpoint served a call.
    If the gateway pins a region, every figure here understates by ~10% — but
    uniformly, so comparisons hold and only absolute spend is affected. See
    COST.md §1.
12. **Token counts are not comparable across the 4.7 tokenizer boundary.**
    Claude 4.7+ produce ~30% more tokens for the same text than Sonnet 4.6 and
    earlier. Compare dollars across that line, tokens only within one
    generation.
9. **Costs for unknown models are null, never guessed.** `cost_complete:
   false` marks them; the token counts are still exact.
10. **Clock caveat.** Timestamps come from the transcript (harness clock).
    `wall_ms` on a run that spans a laptop sleep will include the sleep;
    `active_ms` caps it at 5 min per gap.
