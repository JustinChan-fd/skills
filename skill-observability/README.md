# skill-observability

Deterministic, portable observability for skill runs. Every time a slash
command or the Skill tool runs in a Claude Code session, a hook-driven Node
script snapshots that run — token usage, cost, cache behavior, subagents,
duration, outcome — into one JSON file per run, with **raw untouched values
strictly separated from computed ones**. Not itself a skill (no SKILL.md, like
`alfred-core`): it is engine-level infrastructure that any skill benefits from
without opting in, because the trigger is the harness, not the skill.

## Quick start

Requirements: Node 18+ and Claude Code. Nothing to `npm install` — zero
dependencies.

```sh
# 1. Put this folder anywhere permanent (it is not copied; hooks point at it)
unzip skill-observability.zip -d ~/tools        # or clone the repo

# 2. Wire the hooks (writes 3 entries into ~/.claude/settings.json; idempotent)
node ~/tools/skill-observability/install.mjs

# 3. (optional) sanity-check: 17 tests, no network, no LLM calls
node --test ~/tools/skill-observability/test/*.test.mjs

# 4. Use Claude Code normally. Run any slash command / skill, end the turn,
#    then look at the log pool:
ls ~/.claude/skill-runs/                        # dated folders + index.jsonl
cat ~/.claude/skill-runs/index.jsonl            # one summary line per run
```

That's the whole setup — new sessions on this machine (every terminal, every
repo) are covered from now on. Verify it's live: run `/anything`, end the
turn, and a `2026-…/…__<skill>__<session>-<from>-<to>.json` file appears.

Configuration (env vars, set wherever you launch Claude Code):

| Var | Default | Effect |
| --- | --- | --- |
| `SKILL_OBS_DIR` | `~/.claude/skill-runs` | Where records land |
| `SKILL_OBS_LOG_ALL` | unset | `1` = snapshot **every** turn, not only skill turns (recommended while validating) |

Day-2 operations:

- **Iterate**: edit any file in this folder — the next turn-end uses the new
  code automatically (the logger is spawned fresh per firing; no reinstall).
- **Move the folder**: re-run `install.mjs` (the hook entries store an
  absolute path).
- **Troubleshoot**: failures never surface in your session by design; check
  `~/.claude/skill-runs/.state/errors.log`.
- **Uninstall**: delete the three `skill-run-logger.mjs` entries from the
  `hooks` section of `~/.claude/settings.json`. Logs are plain files; keep or
  delete them independently.

## Flow

```
 YOUR DAY (no daemon — nothing "runs")
┌─────────┐ ┌─────────┐ ┌─────────┐
│Terminal1│ │Terminal2│ │Terminal N│
│ repo A  │ │ repo B  │ │ any repo │
└────┬────┘ └────┬────┘ └────┬────┘
     └──────────┬┴───────────┘
                ▼
     ┌─────────────────────┐
     │ Claude Code harness │
     │  (the always-on bit)│
     └──────────┬──────────┘
                │ writes constantly
                ▼
  ~/.claude/projects/<slug>/
    <session>.jsonl            ← transcript
    <session>/subagents/*.jsonl

════════ TURN ENDS ════════
  Stop | StopFailure | SessionEnd
                │
                ▼ (hook fires, stdin:
                │  session_id, transcript
                │  path, cwd)
     ┌─────────────────────┐
     │ skill-run-logger.mjs│
     │ spawn → ~50ms → exit│
     └──────────┬──────────┘
                ▼
  1. slice transcript from
     this session's cursor
                ▼
  2. skill or /command
     in this window?
        │             │
       NO            YES
        │             │
        ▼             ▼
  advance cursor   3. snapshot raw:
  only, no record     usage, cache
        │             5m/1h, subagents
        │             ▼
        │          4. compute: tokens,
        │             cost, duration
        │             ▼
        │          5. write record +
        │             index line
        │             ▼
        └────► 6. advance cursors,
               exit 0 (always)
                │
                ▼
  ~/.claude/skill-runs/   ← ALL sessions
    index.jsonl             pool here
    2026-08-04/*.json
    .state/  (cursors, errors.log)
                │
                ▼
     dashboard / KPIs:
     cost per skill run, tokens,
     duration, failure rate
```

Key properties: install once at user level and every session on the machine
is covered (the trigger is the harness, not the project); the logger is
spawned fresh per firing, so edits to this folder are live on the next
turn-end with no reinstall; concurrent terminals never collide (per-session
cursor files, shared append-only pool).

## Why hooks (the research, condensed)

The requirement was: deterministic JS that runs *immediately after* a run —
success, failure, or early exit, identically — using only native mechanisms.
The options considered:

| Mechanism | Verdict |
| --- | --- |
| **Hooks (`Stop`/`StopFailure`/`SessionEnd`)** | ✅ Chosen. The only native trigger with *guaranteed* execution — a skill's own instructions are model-followed, a hook is harness-executed. `Stop` fires at end of every turn, `StopFailure` when a turn dies on an API/auth/rate-limit error (carries `error_type`), `SessionEnd` on interrupt/exit. One script on all three ⇒ success, failure, and early exit flow through the identical code path. Hooks receive `session_id`, `transcript_path`, `cwd` on stdin — everything needed to locate the data. |
| Transcript parsing (data source) | ✅ Used. `~/.claude/projects/<slug>/<session>.jsonl` is written unconditionally, no configuration, and carries verbatim `message.usage` per assistant turn — including the per-TTL cache split (`cache_creation.ephemeral_5m/1h_input_tokens`), `service_tier`, `speed`, `iterations[]`, model id, `requestId`, timestamps. Subagent transcripts are siblings at `<session>/subagents/agent-*.jsonl` with a `meta.json` (agentType, spawnDepth, toolUseId). ⚠️ The docs mark this format internal and version-dependent — so the parser is defensive (any failure degrades to a note, never a crash), every record stamps `environment.claude_code_version`, and raw lines are copied verbatim so records survive re-interpretation. |
| Cost from the harness | ❌ Not available. Hooks receive no cost object; `/usage` is interactive-only. Cost must be computed from token counts × a pricing table — done here, versioned (`pricing_version`) so historical records can be re-priced. |
| OTel (`CLAUDE_CODE_ENABLE_TELEMETRY`) | ❌ Rejected for this use, consistent with `docs/specs/2026-07-31-otel-spike-findings.md`: enabled by process env the harness doesn't own per-run, attaches account PII to every record, and has no built-in file exporter. Transcripts need zero configuration. |
| `PostToolUse` matcher on `Skill` | Not needed. Transcript scanning already sees both Skill tool_use blocks *and* `<command-name>` slash-command tags (which never pass through PostToolUse), in one code path. |

## How it works

```
Stop / StopFailure / SessionEnd
        │  stdin: {session_id, transcript_path, cwd, hook_event_name, ...}
        ▼
hooks/skill-run-logger.mjs
  1. slice transcript from this session's cursor → EOF   (never re-reads old turns)
  2. detect invocations: Skill tool_use blocks + <command-name> tags
  3. read subagent transcript deltas (per-agent cursors)
  4. if a skill ran (or SKILL_OBS_LOG_ALL=1): build record, atomic-write JSON,
     append a computed-only summary line to index.jsonl
  5. advance cursors either way; ALWAYS exit 0 (errors → .state/errors.log)
```

The cursor discipline is what makes the numbers trustworthy: each token is
attributed to exactly one record, subagent spend in non-skill turns is
consumed (not leaked into the next skill record), and a hook double-fire is a
no-op.

## Install

```sh
node skill-observability/install.mjs            # user-level ~/.claude/settings.json
node skill-observability/install.mjs --project  # this repo's .claude/settings.json
node skill-observability/install.mjs --dry-run  # preview
```

Idempotent; refuses to touch an unparseable settings file. Because
`~/.claude/skills` symlinks to this repo, the wired path is stable across
sessions. Config via env: `SKILL_OBS_DIR` (default `~/.claude/skill-runs`),
`SKILL_OBS_LOG_ALL=1` to snapshot every turn instead of only skill turns.

## Log layout

```
~/.claude/skill-runs/
  index.jsonl                                   # 1 computed-only summary line per run — load this for dashboards
  2026-08-04/
    20260804T101512Z__gh-issue-create__c43df68b-29-97.json   # full snapshot
  .state/                                       # per-session cursors + errors.log
```

The `-29-97` suffix is the transcript window (`line_from`-`line_to`) and is what
makes the name unique — the timestamp is second-resolution, and two firings
inside one second did collide, silently overwriting the first record while
`index.jsonl` kept both lines. The window pair is the same one carried in
`run_id` and `run.window`.

## Record shape — raw vs computed

Normative schema: `schema/skill-run.schema.json`. The contract:

- **`raw`** — verbatim material only. The hook stdin payload; every
  `message.usage` object exactly as the transcript recorded it (per-TTL cache
  split, `service_tier`, `speed`, `server_tool_use`, `iterations[]`), keyed by
  `uuid`/`requestId`/`timestamp`; full subagent usage deltas + `meta.json`;
  Agent/Task `toolUseResult` observations; invocation evidence. Nothing under
  `raw` is transformed. A record is a faithful sub-snapshot of the session.
- **`computed`** — derived values only, all re-derivable from `raw`:
  - `tokens`: by-model × direction buckets with the 5m/1h cache-write split
    kept separate (and an `unattributed` bucket when the transcript omitted
    the split — flagged, never silently priced), `grand_total`, and
    `boundary_total` (final-turn four-way sum — the dispatch-boundary quantity
    from `docs/specs/2026-07-31-token-measurement-contract.md`, so these
    records reconcile against alfred's `tokens_observed`).
  - `cost`: per-model USD + total, `pricing_version`, cache multipliers
    (write 5m ×1.25, 1h ×2, read ×0.1). Unknown model ⇒ `usd: null`,
    `complete: false`, a note — never a guessed number.
  - `duration`: wall clock + gap-capped active time (5-min cap, same
    convention as alfred-core).
  - `counts`: API calls, tool calls by name, subagents, subagent token share.
  - `outcome`: trigger event, `SessionEnd` reason / `StopFailure.error_type`,
    interrupted-tool flag.
  - `notes[]`: every degradation, structured.

Counting policy (stated in each record): when `usage.iterations[]` is present
it is summed **instead of** the top-level usage (the API documents iterations
as the per-attempt source of truth) — never both, which would double-count.

## Understanding the numbers

**Read `COST.md` first if the cost numbers don't make sense.** It derives the
whole cost model from 36,794 measured API calls: the four token counters, the
one fact that makes caching confusing (reading a cached token costs 1/12.5 of
writing it), and why the same skill can cost 8× more purely because you paused
for six minutes. It also answers "existing vs new vs resumed session" directly,
and records a wrong conclusion it replaced.

**Read `METRICS.md`** — a field-by-field glossary of every metric, the KPI
recipes they support, and the honest limits (three confounds: prompt-cache
state, session depth, and model pricing; the marginal-vs-carry split and
`marginal_comparable` control for the first two, the `models` field for the
third).

**Read `KPIs.md`** — the analytics catalog for the future dashboard: the
runs / records / subagent_runs data model with its join keys (`run_id`,
`spawned_by_run_id`, `tool_use_id`), ~30 KPIs with formulas across cost,
performance, reliability, delegation, context, adoption, and data health,
plus a minimal-viable dashboard starter.

## KPIs this enables

From `index.jsonl` alone: cost per skill run (`cost_total_usd`), tokens per
run, wall/active time per run, cache efficiency (from full records:
`cache_read / (input + cache_read)`), subagent share, failure rate by skill
(`trigger_event`/`error_type`), trend over `pricing_version`-normalized cost.
Compare a skill's median run cost before/after a prompt change to answer "is
this skill still worth it" quantitatively.

Filter on `marginal_comparable` before you average a marginal cost. It is on the
index line for that reason: a cold run pays 12.5x per token to write the prompt
cache a warm run merely reads, so an unfiltered mean over `cost_marginal_usd`
measures *when you happened to run the skill*, not the skill. The index also
carries `repo`, `invocation_kinds`, `git_branch`, and `claude_code_version`, so
grouping by any of those needs no record reads either.

## Sources — how this design was arrived at

Recorded so future changes can re-check the ground truth rather than trusting
this README. Three kinds of evidence fed the design:

**1. Official docs (mechanism + pricing):**
- Hooks reference & guide — `code.claude.com/docs/en/hooks.md`,
  `hooks-guide.md`: event list (`Stop`, `StopFailure` + `error_type`,
  `SessionEnd`, `PostToolUse` matchers incl. `Skill`/`Task`), stdin payload
  fields, settings syntax, per-project vs user scope.
- Sessions — `code.claude.com/docs/en/sessions.md`: transcript location and
  the explicit warning that the JSONL format is internal and can change
  between releases (why the parser is defensive and records stamp
  `claude_code_version`).
- Costs & monitoring — `code.claude.com/docs/en/costs.md`,
  `monitoring-usage.md`: confirmed hooks receive **no** cost object anywhere;
  cost must be computed from tokens. OTel metric names + the PII attributes on
  every export.
- Pricing — `platform.claude.com/docs/en/pricing.md` (via the claude-api
  reference skill, captured 2026-08-04): base rates per model; cache
  multipliers — read ×0.1, 5-minute write ×1.25, 1-hour write ×2; Sonnet 5
  introductory window (**noted but deliberately not implemented** — we price
  Sonnet 5 at its $3/$15 sticker on every date; see the model's `note` in
  `config/model-rates.json`); Opus 5 fast-mode rates.

**2. Empirical verification in a live session (this repo, 2026-08-04):**
- Probed a real transcript: confirmed per-line schema (`message.usage` with
  `cache_creation.ephemeral_5m/1h_input_tokens`, `service_tier`, `speed`,
  `iterations[]`, `requestId`, `uuid`, `timestamp`, `isSidechain`).
- Confirmed subagent layout `<session>/subagents/agent-*.jsonl` +
  `agent-*.meta.json` by spawning an agent and reading the files.
- Confirmed hook wiring shape from a live `launcher-settings.json` and two
  installed Stop-hook scripts reading `stop_hook_active`/`transcript_path`
  from stdin.
- Smoke-tested the finished logger against the building session's own
  transcript: 99 API calls, two models, mixed cache TTLs, one subagent,
  zero degradation notes.

**3. Prior art in this repo:**
- `alfred-core/tools/lib/tokens-collect.mjs` — transcript parsing patterns,
  gap-capped active time, discovery pitfalls (issue #16).
- `docs/specs/2026-07-31-token-measurement-contract.md` — the
  boundary-total quantity this system also computes, so records reconcile
  with alfred's `tokens_observed`.
- `docs/specs/2026-07-31-otel-spike-findings.md` — why OTel was rejected:
  env-controlled enablement the harness doesn't own per-run, account PII on
  every record, no file exporter, vs transcripts written unconditionally.

Rejected alternatives, for the record: a *skill* that logs (model-followed,
not guaranteed — the whole point is deterministic execution); *OTel* (above);
*PostToolUse matcher on `Skill`* alone (misses slash commands, which never
pass through PostToolUse; transcript scanning sees both in one code path).

## Open questions

Things deliberately left unresolved — good candidates for iteration once
real data accumulates:

1. **Workflow support.** Detection currently matches `Skill` tool_use +
   slash-command tags. A `Workflow` tool_use match arm is ~10 lines, but
   background workflows span turns: spend during non-logged turns is
   consumed by the cursor without a record. Proposed fix: also log any turn
   whose subagent delta is nonzero, tagged as a continuation, so a workflow
   becomes a chain of records summed by session. Also verify workflow agents
   write into the same `subagents/` dir (confirmed for the Agent tool only).
2. **Log-everything by default?** `SKILL_OBS_LOG_ALL=1` captures all turns.
   Is total-usage visibility worth the volume, or is skill-only the right
   default? What retention/rotation policy once the pool grows (records are
   a few KB–MB each)?
3. **Format drift.** The transcript schema is officially internal. Should a
   canary test pin the observed schema and fail loudly on a new Claude Code
   version, rather than degrading silently to notes?
4. **Multi-skill turns.** A turn invoking two skills yields one record with
   both names — token attribution between them is inherently ambiguous
   within a turn. Acceptable, or should invocation-level heuristics split it?
5. **Cross-machine sync.** alfred-core syncs run records to a telemetry git
   repo. Should `~/.claude/skill-runs/` sync the same way for a single
   dashboard across machines?
6. **Pricing maintenance.** The table is hand-captured with a
   `pricing_version`. Worth a periodic check against the live pricing page,
   or is re-pricing old records on demand enough?
7. **Dashboard.** `index.jsonl` is dashboard-ready but nothing renders it
   yet. Minimal static HTML over the pool? Fold into alfred's existing
   telemetry dashboard?
8. **Remote sessions.** Cloud/web sessions have their own container
   `~/.claude` — records only accumulate there if the repo is present and
   installed. Is local-only acceptable, or should remote sessions sync back?

## Tests

```sh
node --test skill-observability/test/*.test.mjs
```

Zero deps, no network, no LLM calls. Includes an end-to-end suite that
executes the real hook binary against a fixture transcript tree (session +
subagents) and asserts on cursor behavior across repeated firings. Also
validated live against a real session transcript (99 API calls, two models,
mixed 5m/1h cache writes, one subagent) with zero degradation notes.

## Verifying the store

```sh
node skill-observability/bin/verify-logs.mjs        # exits 1 on any problem
```

The tests prove the **writer** is right against fixtures. This proves the
**store** is right against whatever actually accumulated on disk — including
records written by older code, which no test can retroactively cover. Run it
before trusting a dashboard build; it's the check that earns the trust, since
every defect on this project so far was found by replaying real records rather
than by a green test.

What it enforces:

- **The index does not lie.** Every indexed file exists, every file on disk is
  indexed, no duplicate `run_id`. (This broke for real: two records written in
  the same second collided, leaving two index lines pointing at one file.)
- **The partition reconciles.** `attributed + unattributed` *is* the window, not
  a filter of it. Tokens are integers so this is checked **exactly**; costs are
  6dp-rounded per bucket so they get a 1e-5 tolerance. A tolerance tighter than
  the data's own precision is a bug in the checker — a 1e-9 one produced three
  false positives on real records.
- **Join keys resolve.** `unattributed_belongs_to_run_id` names a record that
  exists, or is null. A dangling key is worse than none: it invites a silent
  inner-join drop.
- **Windows never overlap** within a session — the property that guarantees no
  token is counted twice. Gaps are normal (unlogged non-skill turns); overlaps
  never are.
- **`marginal_comparable` is derived, never asserted** — it must agree with
  `cache_state`.

Pre-attribution records are skipped explicitly and counted in the output, not
defaulted to zero: a checker that silently treats a missing block as empty would
report a clean store that isn't actually comparable.

The failure paths are exercised, not assumed — each of the five classes above
was reproduced by corrupting a copy of the real store and confirming the exact
message fires.
