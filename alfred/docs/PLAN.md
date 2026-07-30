# Alfred — v3 design plan

Status: **plan only. No code written. Not approved.**
Inputs: `alfred/docs/HANDOFF.md` (every number cited here is measured there).
Date: 2026-07-29.

---

## 0. The one-sentence thesis

**Claude Code is already the harness.** Alfred adds only the two things it
genuinely lacks — *accounting* and *unattended scheduling* — and adds a
deterministic *gate* to grade the result from outside. It does not re-implement
orchestration, because orchestration is what cost 4.6x and still didn't ship.

Measured basis (HANDOFF §1): one `claude -p` context did TARS-1339 in **$1.12 /
3.6m** and pushed; the four-phase harness spent **$5.15 / 24.6m** producing a
plan and shipped nothing. 95.6% of the cheap arm's tokens were `cache_read` —
one context reuses its prefix, four phases each rebuild theirs.

**Scope discipline that follows from this:** every piece below is a *pure
function or a shell script*. If a component needs an LLM to decide something,
that is a signal it belongs inside the worker context, not in Alfred.

---

## 1. Standalone constraint

Alfred lives at `skills/alfred/`. It is a directory in the existing repo, not
a new git repo — it inherits the root `package.json` (`harness-skills`, private,
`"type": "module"`, `"test": "node --test"`, **zero dependencies**).

**Hard rule, both directions:**

- Alfred `import`s nothing from `harness-core`.
- `harness-core` `import`s nothing from Alfred.
- No shared config file, no shared `.harness/` directory, no shared run dirs.

`harness-core` stays exactly as it is — it is the evidence that produced this
plan. When someone asks "why is there no verifier loop," the answer is a
directory they can read, not a paragraph I wrote.

Values are **copied, not linked**. The price table gets duplicated into
`alfred/config/prices.json` with its own version stamp. A duplicated 60-line
table is cheaper than a coupling.

### Proposed layout

```
alfred/
  bin/alfred                 # single entrypoint: work | loop | report | gate
  lib/
    config.mjs                # load + validate .alfred/config.json
    tokens.mjs                # transcript → by_model sums, peak, active_ms
    report.mjs                # (transcript, subagentsDir, config) → record
    gate.mjs                  # (config, acMap, gitState, cmdResults) → verdict
    router.mjs                # config + escalation → CLI flags
    fixture.mjs               # provision / reset a sandbox from a fixture
    prices.mjs                # model id normalization + cost math
  config/prices.json          # copied table, version stamped
  test/*.test.mjs
  fixtures/tars-1339/         # see §7 — in-git vs generated is OPEN
  docs/{HANDOFF,PLAN}.md
```

`bin/alfred` is one script with subcommands so the slash command and cron
invoke the *same* code path. There is no second implementation of the trigger.

---

## 2. The four pieces

```
launchd/cron ──▶ bin/alfred loop ──┐
/loop  ────────▶ (shells out)       │  lock → poll source → pick 1 → resolve base
alfred work TARS-1339 ─────────────┘
                     │ spawn
                     ▼
        claude -p  ← ONE context. reads .alfred/config.json.
                     may delegate subagents (tiered, ceilinged).
                     │ exits
                     ▼
        gate   ← deterministic checklist, runs AFTER the worker,
                 in a separate process, on the worker's artifacts
                     │
                     ▼
        report ← transcript + subagents/*.jsonl → record → telemetry sink
```

### 2.1 `alfred work <item>` — the trigger

A shell script. Responsibilities, in order:

1. Load and validate `.alfred/config.json`; refuse with a named error if absent
   or invalid. **No defaults invented for a missing config** — an unattended 3am
   run guessing the base branch is worse than not running.
2. Resolve the work item to `{id, title, body, acceptance_criteria[], source}`
   and **write the raw fetched payload to disk** before doing anything with it.
3. Resolve the base branch (config rule; may be an epic branch — TARS-1271 and
   TARS-1339 both were).
4. Build CLI flags via `router.mjs`.
5. `exec claude -p` with the prompt, and **wait**.
6. Run `gate`.
7. Run `report`.
8. Exit with the gate's verdict as the exit code.

**Step 2's write-to-disk is non-negotiable and is a bug fix, not a feature.**
HANDOFF §"Also found": in `harness-core` the raw ticket is persisted nowhere —
`manifest.json` carries a one-line `source.excerpt`. Fetch-once-with-no-copy
means **no run is replayable**. Alfred writes `run/<id>/source.json` first.

### 2.2 `alfred loop` — scheduling

The only genuinely absent capability (HANDOFF §5 table). Same script, plus:

- A **lock file** with a pid + timestamp; a stale lock (pid dead) is reclaimed,
  a live one exits 0 quietly. Two ticks must never work the same item.
- Poll the configured source, filter by config predicate, pick **one** item.
  Cadence is `loop.poll_interval_minutes` in config (§4), **default 30** — the one
  operational number the persona brief fixed ("he patrols the horizon every 30
  minutes"). It lives in config rather than in code or in `docs/PERSONA.md` because
  an operator will want it different per repo, and a prose doc is a poor place to
  keep a value people change.
- Blocked items are skipped; when nothing workable remains the loop **terminates**
  rather than waking to re-skip forever. `lib/blocked.mjs` `planTick` decides this
  (see §8.5 and `docs/BLOCKED.md`).
- Nothing picked → exit 0 silently. A no-op tick must be indistinguishable from
  a healthy tick to the scheduler.
- Delegate to the `work` path. `loop` adds selection; it does not add behavior.

`harness-loop-core`'s ~3,000-word `SKILL.md` asking an LLM to *be* the loop
("You are ONE TICK of an unattended loop") is what this replaces. The loop is
`while`, a lock, and a poll. Paying model tokens to simulate that is the purest
form of the mistake this whole plan is correcting.

`/loop` the slash command is a thin wrapper that shells out to `bin/alfred
loop`. It carries no logic of its own.

### 2.3 The worker — `claude -p`, one context

Alfred's contribution here is *what it hands over*, not orchestration:

- The ticket, verbatim, plus its AC as an enumerated list.
- `.alfred/config.json` contents (commands, off-limits paths, PR template).
- An `--append-system-prompt` carrying the standing rules: audit the ticket's
  claims before acting; a false premise is a finding, not an obstacle; never
  claim a check passed without having run it.
- Subagent tiers via `--agents <json>`, each with a token ceiling.
- `--fallback-model` — required for unattended ticks; a 3am capacity error must
  not silently produce a dead tick.

The worker may delegate. HANDOFF §4 proves delegation stays fully accounted:
subagent turns are **not** in the parent transcript (0 sidechain entries in a
3-agent session) but live at
`<project-dir>/<session-id>/subagents/agent-<id>.jsonl` with a sibling
`.meta.json` carrying `{agentType, description, toolUseId, spawnDepth}`.
`toolUseId` joins each one back to the exact parent tool call.

**Counter-lesson, priced:** the three unbounded research digs in the session
that produced HANDOFF cost **$11.98** — all opus-5, 3.2–3.9M tokens each. That
is more than the harness run being criticized. Delegation gets a **cheap default
tier and a hard token ceiling**, or it becomes the new 4.6x.

### 2.4 `gate` — deterministic verification

Runs **after** the worker exits, **in a separate process**, reading only
artifacts. It cannot be argued out of a verdict by the agent it is grading.

What was deleted from `harness-core`'s verifier, and why: **scores, rounds,
plateau thresholds, and self-assessed confidence are gone.** The thing that
failed was *LLM self-scoring* — it stamped a stakeholder falsehood `verified`
after sampling one file. Verification itself was never the problem. So the gate
keeps verification and drops the self-assessment.

Checklist, all mechanical (detail in §5):

1. Every config-declared repo check exits 0.
2. Every AC is either **mapped to a command that ran and passed**, or
   **explicitly marked `unverifiable` with a reason**. Silence is a fail.
3. Scope assertion — files touched ⊆ declared scope, ∩ off-limits = ∅.
4. No-fabrication — every claim of the form "X passes" has a recorded command
   with an exit code.
5. Any claim one command settles gets settled, not asserted.

Verdict: `{pass, findings[], unverified[]}`. The gate **never edits the repo**
and never re-runs the worker. It reports.

### 2.5 `report` — accounting

A pure function: `(transcriptPath, subagentsDir, config, expected) → record`.
No I/O in the core; the two entry points do the I/O.

**Two entry points, one implementation:**

- **Stop hook** (`alfred report --from-hook`, reads the payload on stdin).
  Verified this session to fire under `claude -p`. Payload carries
  `session_id, transcript_path, cwd, prompt_id, permission_mode,
  hook_event_name, stop_hook_active, last_assistant_message,
  background_tasks, session_crons`.
- **Script** (`alfred report --transcript <p> --session <id>`) for backfill and
  for grading a transcript after the fact.

The hook path means **hand-run sessions get dashboard numbers too** — you get
accounting for the thing you were already doing instead of it, which is exactly
the shape the measurement argues for.

**The hook payload deletes two-thirds of the old collector.** Everything in
`tokens-collect.mjs` under `subagentsDirForSession`, `discoverLoopTranscript`,
`discoverSubagentForRun` (with `observedTotal` fingerprinting and the
four-strategy `via` widening) exists *only* because nothing told it which
transcript was the run's. The hook is told. That whole layer does not get
ported — see the open question in §8.2 before assuming this.

Record shape (fields, not final JSON):

```
session   { id, run_id, repo, branch, base, cwd, started_at, ended_at, wall_ms }
work      { source, item_id, title, ac_count }
tokens    { by_model: {<id>: {in,out,cache_read,cache_creation}},
            peak_context, active_ms, lines, skipped }
subagents [ { agent_id, agentType, description, toolUseId, spawnDepth,
              by_model, wall_ms } ]
cost      { by_model: {<id>: usd}, total_usd, price_table_version }
gate      { pass, findings[], unverified[] }
delivery  { commits[], pushed_to, pr_url|null }
```

`by_phase` is **absent by design.** There are no phases. If a dashboard panel
needs phases, the honest answer is one bar.

---

## 2.6 Build order — DECIDED 2026-07-29

**The ambiguous-ticket fixture comes before any of M0–M7.** Reasoning: the 4.7x
is n=1 on the simplest ticket shape, and an ambiguous ticket is the one shape
where the pipeline could genuinely pay. Nothing in `lib/` exists yet, so this is
the cheapest moment the answer can arrive. Finding out after M4 means a gate and
a router built on a premise that didn't hold.

See `docs/EXPERIMENT-2.md` for the design. **The experiment can overturn §2.**
Explicit possible outcomes, committed to in advance:

| result | what it means | what changes |
|---|---|---|
| single context ≈ or beats pipeline | thesis holds on a second shape | build M0–M7 as written |
| pipeline wins on *quality*, single wins on cost | ambiguity needs a thinking step, not four phases | add **one** pre-step inside the worker context, not a phase graph |
| pipeline wins decisively | phase separation earns its cost on ambiguity | §2 is wrong; route by ticket shape |

## 3. TDD sequence

Standing directive: *"lets try remaining TDD and deterministic as much as
possible."* So: every milestone below is **a list of test names written and
watched fail, before any implementation.** Milestones are ordered so each one is
independently useful — if we stop after M2 we still have something that pays.

Determinism rules for the whole suite:

- No network. No live Jira, no live GitHub, no live `claude`.
- No wall-clock reads in assertions — timestamps come from fixtures.
- Fixtures are files on disk; tests build temp dirs and clean them up.
- **The test suite must not touch `~/.harness/telemetry`.** The known hazard:
  `harness-core`'s tests wrote to the production sink, and `syncRun`'s
  `git add -A -- log` absorbs unrelated staged changes. Alfred's sink path is
  injected, and the default in tests is a temp bare repo.

### M0 — prices (smallest thing that has a real bug in its history)

Chosen first because it is where a silent `$NaN` already happened once.

```
test('price keys are in/out/cache_read/cache_write — not input/output')
test('a dated model id normalizes by stripping -\d{8}$ before lookup')
test('an anthropic.-prefixed id normalizes too')
test('an unknown model id yields a named unpriced result, never NaN and never 0')
test('cost math uses cache_write (5m TTL) and never cache_write_1h')
test('the loaded table carries a version stamp and the record records it')
```

The `NaN`-not-zero test is the important one: a zero cost is plottable and
false, which is worse than a hole. Same reasoning as `timing.mjs`'s
`pr_precedes_run` — withhold the number, flag the input.

### M1 — tokens (spec ported from `harness-core`'s earned cases)

These test names are **lifted verbatim from `harness-core/test/tokens-collect.test.mjs`**
because each one encodes a real bug that was found the expensive way. Porting
the *cases* is free; porting the *code* is the open question in §8.2.

The dedupe seven (the `message.id` double-count that inflated every figure ~2.2x):

```
test('two lines sharing one message.id count that API call once')
test('four lines sharing one message.id count that API call once (real split-block shape)')
test('usage rows with no message.id are each counted, never collapsed together')
test('id-less iterations[] sub-entries still all count under a deduplicated parent line')
test('peak_context is unchanged by deduplication — the fingerprint must not move')
test('two distinct message.ids in one file are both counted — dedupe must not over-collapse')
test('active_ms and timestamps are unchanged by deduplication')
```

Sums and windows:

```
test('sums token usage by model x direction across a transcript')
test('iterations[] sub-entries are summed in addition to top-level message.usage')
test('slices to a caller-supplied start/end ISO window, excluding out-of-window lines')
test('reports per-call timestamp min/max and a gap-capped active-time sum')
test('the gap cap is a named documented parameter with a sensible default')
test('an unrecognized model id is still summed under its own id (tiering happens later)')
```

peak_context:

```
test('peak_context is the largest single call context, not the sum and not the last call')
test('peak_context ignores the start/end window that sums honour')
test('peak_context counts iterations[] sub-entries as their own calls')
test('missing cache keys coerce to 0 rather than NaN')
test('a transcript with no usage entries reports peak_context 0, not -Infinity')
```

Degradation — **never throw, always structured**:

```
test('garbage/malformed transcript returns a structured failure result, never throws')
test('a missing path returns a structured not-found result, never throws')
test('an empty or unparseable transcript still carries a numeric peak_context')
```

Privacy, carried forward as a hard rule:

```
test('return value contains no raw transcript text anywhere in its object graph')
```

*The parser reads no content.* This is why fixtures can be committed at all.

### M2 — report

```
test('the Stop hook payload alone locates the transcript — no filesystem discovery')
test('subagent files are read from <session>/subagents/ and attributed by toolUseId')
test('spawnDepth is preserved so nested delegation stays attributable')
test('a session that spawned nothing yields subagents: [] and still reports totals')
test('a missing subagents dir is not an error — it is zero subagents')
test('parent totals and subagent totals are reported separately, never conflated')
test('cost is computed per model from the copied table and totalled')
test('a hand-run session with no Alfred work item still produces a valid record')
test('by_phase is absent from the record — there are no phases')
test('the sink path is injected; nothing writes to ~/.harness/telemetry in tests')
test('report failure cannot fail the run — it exits 0 and records its own error')
```

The last one is the pure-sidecar rule, carried over verbatim from the OTel
constraint: capture failure must never fail a tick.

Regression test from arm 0's real numbers, as an end-to-end anchor:

```
test('arm 0 fixture transcript reports 2,207,405 tokens and $1.12 (+/- rounding)')
```

That single assertion is worth the whole suite. It fails loudly if any change to
dedupe, normalization, or the price table moves the headline number.

### M3 — config

```
test('a valid .alfred/config.json loads and every field is typed')
test('a missing config is a named refusal, not a set of invented defaults')
test('an unknown top-level key is a validation error, not ignored')
test('base-branch resolution returns the configured epic branch, not master')
test('base-branch resolution falls back only when config says it may')
test('off-limits paths are globs and are resolved relative to repo root')
test('a config declaring no verification commands is invalid — the gate needs at least one')
test('loop.poll_interval_minutes defaults to 30 when the loop block is absent')
test('an explicit poll interval overrides the default')
test('a zero or negative poll interval is a validation error, not a hot loop')
```

The interval tests are three propositions, not one: that the default exists, that
config beats the default, and that a nonsense value is refused. A single
"interval is 30" test would pass a build in which config was ignored entirely.

The epic-branch test exists because TARS-1271 got this wrong: the base was
`feat/migrate-native-fetch-from-axios`, not `master`, and a phased epic ticket
resolving to `master` produces a PR against the wrong tree.

### M4 — gate

```
test('all declared checks exit 0 → pass')
test('one declared check exits non-zero → fail, naming the check and its output')
test('an AC with no mapping and no unverifiable marker → fail (silence is not a pass)')
test('an AC marked unverifiable with a reason → pass, and appears in unverified[]')
test('an AC marked unverifiable with no reason → fail')
test('a claim of "X passes" with no recorded command + exit code → fail (no-fabrication)')
test('a file touched outside declared scope → fail, naming the file')
test('a file touched in an off-limits path → fail, naming the pattern it matched')
test('the gate never writes to the repo — the working tree is byte-identical after')
test('the gate verdict is a pure function of its inputs — same inputs, same verdict')
test('the gate has no model call and no network access')
```

The last three are the whole point. `harness-core`'s verifier produced a false
`verified` because it was an LLM grading with a score. This one is a function.

Two TARS-1339-specific gate tests, from the real findings:

```
test('an AC demanding "0 warnings" against a tree with 2 pre-existing warnings is reported unsatisfiable, not passed')
test('an AC of the form "no behavior changes" with only a formatter run recorded lands in unverified[], not pass')
```

The second is the AC #2 case: 147 files, 526 insertions, 435 deletions, and
**both arms and I left it unverified.** A gate that silently passes it is
reproducing exactly the bug being fixed.

### M5 — router

```
test('worker model comes from config; sonnet is the default when config is silent')
test('--fallback-model is always present for loop-launched runs')
test('subagent tiers become an --agents JSON payload with per-tier ceilings')
test('no tier defaults to opus — the expensive tier must be named explicitly')
test('escalation to opus emits exactly one logged event with a reason')
test('flag construction is pure: config in, argv array out, no spawn')
```

`no tier defaults to opus` is the $11.98 lesson as an assertion.

### M6 — fixture / eval harness

```
test('provisioning a fixture yields the documented start-state sha')
test('reset restores every ref to its documented sha after a run mutated them')
test('a fixture missing .gitignore is rejected at provision time')
test('a fixture missing package.json is rejected at provision time')
test('result refs land under refs/arm-results/ and are never fetched by a plain clone')
test('the answer branches are absent from the provisioned clone')
```

Every one of these is a hazard that **actually fired** (HANDOFF §3): the saved
fixture was contaminated because arm 0 pushed to the epic branch; a missing
`.gitignore` makes biome hard-error; a missing `package.json` silently disables
biome's React domain and produces 18 phantom warnings that corrupt trap (c)
*while looking plausible*. Provision-time rejection is cheaper than debugging a
plausible-looking wrong number.

### M7 — loop

```
test('a live lock makes a second tick exit 0 without working')
test('a stale lock (dead pid) is reclaimed')
test('no eligible item → exit 0, silent, indistinguishable from a healthy tick')
test('exactly one item is picked even when several are eligible')
test('the raw fetched source payload is written to disk before any interpretation')
test('the loop path and the work path share one implementation')
```

---

## 4. `.alfred/config.json` — schema

Per repo, committed, **the source of truth**. This was the user's call and it was
right: it replaces what a phase used to re-derive every run, at zero tokens.

```jsonc
{
  "version": 1,
  "repo": "webtarsthree",

  "source": {
    "kind": "jira" | "github",
    "jira": { "cloud": "...", "project": "TARS", "epic": "TARS-1271",
              "jql": "..." },
    "github": { "owner": "...", "repo": "...", "labels": ["ready"] }
  },

  "loop": {
    // cadence for `alfred loop`. 30 is the persona brief's number (§2 of
    // docs/PERSONA.md); it is config because operators change it per repo.
    "poll_interval_minutes": 30,
    // the marker a blocked item carries. lib/blocked.mjs BLOCKED_LABEL.
    "blocked_label": "alfred:blocked"
  },

  "base": {
    // in order; first match wins. epic branches are the normal case, not
    // the exception — do not default to the default branch.
    "rules": [
      { "when_epic": "TARS-1271", "branch": "feat/migrate-native-fetch-from-axios" },
      { "default": "master" }
    ]
  },

  "branch_prefix": "alfred/",

  "verify": {
    // name → command. every one must exit 0. at least one required.
    "lint":  "node_modules/.bin/biome check src/",
    "test":  "npm test",
    "build": "npm run build"
  },

  "delivery": {
    "mode": "pr" | "push",        // 1339's AC #4 said push to the epic branch
    "pr_template": ".github/pull_request_template.md",
    "never_merge": true            // standing rule: harness never merges its own PRs
  },

  "off_limits": ["node_modules/**", ".husky/**", "**/*.snap"],

  "models": {
    "worker": "claude-sonnet-4-6",
    "fallback": "claude-sonnet-4-6",
    "agents": {
      "scan":  { "model": "claude-haiku-4-5", "max_tokens": 200000 },
      "reason":{ "model": "claude-sonnet-4-6", "max_tokens": 500000 }
    }
  },

  "telemetry": { "sink": "~/.harness/telemetry", "repo_slug": "webtarsthree" }
}
```

Notes:

- `delivery.mode` exists because of a correction I had to make about my own
  metric: **arm 0 opened no PR *correctly*** — AC #4 said commit directly to the
  epic branch. The delivery bit is "did what the ticket asked," not "was there a
  PR." A config that only knows how to open PRs would grade a correct run as a
  failure.
- `never_merge: true` is the standing rule made mechanical.
- `models.agents` has **no opus entry by default.** Escalation is explicit.

---

## 5. The gate checklist, in detail

Inputs, all files on disk after the worker exits — never the worker's opinion:

| input | source |
|---|---|
| declared checks | `config.verify` |
| check results | the gate runs them itself |
| AC list | `run/<id>/source.json` (the raw payload) |
| AC→command map | **OPEN — see §8.1** |
| files touched | `git diff --name-only <base>...HEAD` |
| worker claims | `REPORT.md` + `run/<id>/commands.jsonl` |

Rules:

1. **Checks.** Run every `config.verify` entry. Any non-zero → fail, with the
   check name and its output. The gate runs them; it does not read the worker's
   report of having run them.
2. **AC coverage.** Each AC resolves to exactly one of:
   `passed(command, exit 0)` / `failed(command, exit N)` /
   `unverifiable(reason)` / `unsatisfiable(evidence)`. **A fifth state does not
   exist. Silence is `fail`.** The `unsatisfiable` state is what TARS-1339's
   AC #1 needs — it demands 0 warnings against a tree with 2 pre-existing ones.
3. **Scope.** `touched ⊆ declared` and `touched ∩ off_limits = ∅`.
4. **No fabrication.** Scan claims for verification language; each must join to
   a recorded command with an exit code. An unbacked claim is a finding, even
   when it happens to be true — because you cannot tell which from the artifact.
5. **Settle the settleable.** Any claim one command decides gets that command
   run. This is the trap-(d) fix: intake stamped *"master is clean at 0 errors"*
   `verified` after sampling **one file** and never running biome on master.
   Master had **5 errors**. One command would have settled it.

Verdict is data, not a score:

```
{ pass: boolean, findings: [{rule, detail, evidence}], unverified: [{ac, reason}] }
```

`unverified` being non-empty does **not** auto-fail — it is the honest channel
for "a human must look." What fails is an AC that is neither verified nor
declared unverifiable. The distinction is the entire design.

---

## 6. Router

A table and two flags. Not a service, not a phase, not a model call.

| seat | model | why |
|---|---|---|
| worker | `config.models.worker`, default sonnet-4-6 | arm 0 did 1339 on sonnet for $1.12 |
| fallback | `config.models.fallback` | capacity error at 3am must not kill the tick |
| `scan` subagent | haiku-4-5, ceiling | mechanical reads |
| `reason` subagent | sonnet-4-6, ceiling | needs judgment |
| adjudicator | opus-5, **explicit only** | one logged escalation event, with a reason |

Consistent with the standing position: **sonnet in every seat, Opus as
adjudicator rather than fallback**, and the metric is *tokens per delivered
issue* — not tokens per run, which rewards not shipping.

Every tier carries `max_tokens`. The $11.98 counter-lesson is that an unbounded
subagent is the most expensive object in the system.

---

## 7. Fixtures and evals

### Format

```
fixtures/<slug>/
  origin.git/          bare, ref-surgical — answer branches absent
  ticket-prompt.txt    verbatim ticket + AC, exactly what the arm receives
  ground-truth.json    per-tree assertions, machine-checkable
  refs.json            ref → sha, for reset
  README.md            what this fixture distinguishes, and what it cannot
```

`ground-truth.json` for tars-1339 encodes what HANDOFF §2 measured:

| tree | assertion |
|---|---|
| epic tip `8257ff7f` | 201 errors, 2 warnings, 2 infos |
| `master` `a06a0b59` | **5 errors**, 4 warnings, 4 infos |
| epic + `825e9391` | 2 errors |
| arm 0 final | 2 infos, exit 0 |

Plus the trap table as scored assertions:

| trap | ticket claims | reality | scoreable as |
|---|---|---|---|
| a | 148 files | 144 | did the arm state a count, and was it right |
| b | autofix covers all 201 | leaves 2 | did it find the 2 |
| c | both biome-ignores stale | only `useSemanticElements` is | did it keep the load-bearing one |
| d | "master is clean at 0 errors" | 5 errors | did it check master, and report it |
| e | "no behavior changes" (AC #2) | **unverified by everyone** | did it verify or declare unverifiable |

Trap (e) is new here — it is the fifth assertion HANDOFF §2 says the fixture
needs. Trap (c) is verified by deletion: removing the surviving
`noStaticElementInteractions` yields `Found 1 warning`, because
`role={disabled ? undefined : 'button'}` at `PendingReviewCard.jsx:129` makes
the *conditional* role the reason one suppression is dead and the other is not.
`harness-core`'s plan said "All biome-ignore comments … are removed" — **a
harness following its own plan literally ships a contract violation.** That is
what an eval is for.

### Missing shapes — the honest limit

TARS-1339 covers exactly one shape: *trivially specified + false premise in the
ticket*. **The 4.7x is n=1 on the simplest possible ticket.** Three shapes are
needed before "drop the pipeline" generalizes:

1. **Ambiguous ticket** — the case where intake's ceremony might genuinely pay.
   **This is the one that could falsify the plan**, which is why it should be
   built first, not last.
2. **Ticket that should be pushed back on** — does the arm stop instead of
   confidently building the wrong thing?
3. **Multi-file feature with real tests** — 1339 was formatting; nothing in it
   exercised design judgment.

I am not going to pretend the plan is validated. It is *well-supported on one
shape* and the fixture that would test it hardest doesn't exist yet.

---

## 8. Open questions

**Four of six decided 2026-07-29** (§8.1, §8.2, §8.4, and sequencing). Two
remain open: §8.3 and §8.5.

### 8.1 AC→command mapping — DECIDED: hybrid

**The worker proposes an `ac_map`; the gate never invents a mapping and refuses
silence.** Every AC must resolve to a command that ran, or a `unverifiable`
declaration carrying a reason. This is what §5 rule 2 already assumes, so §5
stands as written.

The conflict of interest is real and stays named: the worker is authoring input
to its own grading. Two mitigations, both mechanical:

- The gate **runs the proposed commands itself** and ignores the worker's claimed
  results. A dishonest `ac_map` can only propose a command; it cannot fake an
  exit code.
- An `ac_map` entry whose command does not mention the AC's subject at all is a
  finding (`mapping_implausible`), not a pass. On 1339, mapping AC #2 ("no
  behavior changes") to `biome check` would trip this — a formatter cannot settle
  a behavior question.

Rejected: *derived* (a wrong mapping silently passing an AC is the exact shape of
the false-`verified` bug) and *human-authored per ticket* (fights the unattended
loop, which is the point of the whole thing).

### 8.2 `tokens-collect` port strategy — DECIDED: port the tests, write fresh

Port the test cases named in §3/M1 as Alfred's spec; TDD ~80 lines fresh. The
Stop hook payload eliminates the discovery two-thirds, and a wholesale port would
carry that dead code past its own passing tests.

**The risk this accepts:** an edge case that exists in the old code but has no
named test. Mitigation — before M1 is called done, diff Alfred's behavior against
`collectFromFile` on the arm 0 transcript and the subagent-driver fixture. Same
inputs must produce the same sums. That is the M2 anchor test
(`2,207,405` tokens / `$1.12`) doing double duty.

### 8.3 Fixture in git, or regenerated by script? — OPEN

6.7MB bare repo. In-git = reproducible forever, bloats the repo, and needs a
privacy read on every blob. Script-generated = small, but depends on the live
repo still having those shas — and the live TARS-1339 is already
`status: Development Complete`, so the tree has moved on. That argues for
in-git, but it's your repo.

### 8.4 Codename — DECIDED: Alfred

### 8.5 `harness-core` #20 — unsatisfiable or amended blocking AC — DECIDED

**Stop the run, comment on the ticket, label it `alfred:blocked`. Later ticks skip
blocked items; when nothing workable remains, terminate the loop.** A human replies
and removes the label to unblock.

Full policy, rationale and reason codes: **`docs/BLOCKED.md`**. Implementation:
`lib/blocked.mjs`, 21 tests in `test/blocked.test.mjs`, each of the five guards
falsified individually.

TARS-1339 was the instance that made this concrete rather than hypothetical: **AC #1
is not satisfiable as written** (0 warnings against a tree carrying 2 pre-existing
ones), and **AC #4 asks for a direct push, not a PR.** `sandbox-a`'s AC3 reproduces
the same shape deliberately.

---

## 9. Inspired by, does not import — what each idea cost to learn

`harness-core` is not deleted, and this section is why. Each row is an idea worth
keeping and the price paid to find it.

| idea kept | where it was learned | what it cost |
|---|---|---|
| **Ticket-skepticism as a first-class job** | intake stamped *"master is clean at 0 errors"* `verified`; master had 5 errors | a whole phase whose only job it was, failing at it |
| **Accounting must be a pure sidecar** | OTel constraint work; capture failure cannot fail a tick | designed right the first time, kept |
| **`message.id` dedupe** | every cost figure was ~2.2x inflated | one full re-audit of every number ever reported |
| **Withhold bad numbers, don't clamp them** | `timing.mjs`'s `pr_precedes_run` | a dashboard that would have plotted something false |
| **`NaN`-not-zero on unpriced models** | `in`/`out` vs `input`/`output` key mismatch | a `$NaN` in a report |
| **Price ids need normalization** | collector emits `claude-haiku-4-5-20251001`; table has `claude-haiku-4-5` | silent unpriced rows |
| **Config as source of truth** | your call, and correct | would have been re-derived per phase, forever |
| **Base branch is often an epic branch** | TARS-1271 | a PR against the wrong tree |
| **Reconciliation needs a tolerance with a floor** | `TOLERANCE_FRACTION 0.05` + 60s floor | short runs permanently "unreconciled" for no reason |
| **A gate must run outside the thing it grades** | the false `verified` | the central lesson of v2 |
| **Delegation needs ceilings** | 3 unbounded research agents | **$11.98** in one session |
| **Phases destroy cache reuse** | arm 0 vs harness | **4.6x cost, 6.8x wall, and no PR** |
| **Raw source must be persisted** | `manifest.json` keeps a one-line excerpt | no harness run is replayable |
| **Fixtures must reset between runs** | arm 0 pushed to the epic branch mid-save | a contaminated fixture, caught by luck |
| **Fixtures need `.gitignore` + `package.json`** | 18 phantom biome warnings | a wrong number that looked plausible |
| **The loop is `while`, not a prompt** | `harness-loop-core`'s 3,000-word SKILL.md | model tokens spent simulating a `while` loop |

Two things `harness-core` got right that this plan simply keeps: **determinism
over LLM** wherever a command can decide, and **size-based routing** rather than
one model for everything.

---

## 10. What I am not confident about

Stated plainly, because the plan is stronger if these are on the record:

1. **n=1.** The measurement is one ticket, and the simplest shape there is. The
   ambiguous-ticket fixture is the experiment that could overturn §2's structure,
   and it does not exist yet.
2. **The gate's AC mapping is the load-bearing unknown** (§8.1). Get it wrong and
   the gate is theater with better manners than the last one.
3. **The worker's freedom to delegate is unbounded in prompt space.** Ceilings
   cap tokens per subagent; nothing yet caps *how many* it spawns. That needs a
   number, and I don't have a measured basis for one.
4. **`unverified[]` not auto-failing is a judgment call** I made in §5. It is the
   honest channel, but an unattended loop that accumulates `unverified` items
   nobody reads is how you get a second false `verified` — just slower.
