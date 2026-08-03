# Alfred — plan inputs (handoff, 2026-07-29)

Everything measured before `alfred/docs/PLAN.md` was written. Nothing here is
inferred; each number has the command that produced it in the session log.

Alfred is **standalone**: no import in either direction with `harness-core`.
`harness-core` stays untouched as evidence of what was learned.

## 1. The measurement that decided v3

Same collector code (`collectFromFile`) over both arms, same price table
(`harness-core/config/routing.json` `model_prices_usd_per_mtok`, v2026-07-29.1).

| | arm 0 standalone | harness (intake+plan) |
|---|---|---|
| tokens | **2,207,405** | 10,422,619 |
| cost | **$1.12** | $5.15 |
| wall | **216s (3.6m)** | 24.6m |
| delivered | commit + push, `biome` exit 0 | **no PR** |

Ratios: **4.7x tokens, 4.6x cost, 6.8x wall — and the harness did not ship.**

Arm 0 standalone was *cheaper than arm 0 with the harness's plan handed to it*
($1.12 vs $1.66 / 3,803,243 tok / 6m48s). Reading the handoff artifacts cost
more context than deriving the work.

Why: **cache_read was 2,110,234 = 95.6% of arm 0's tokens.** One context reuses
its prefix; four phases each pay to rebuild theirs.

Arm 0 raw (`by_model`, sonnet-4-6): input 32, output 10,742, cache_read
2,110,234, cache_creation 86,397. `peak_context` 86,708, `active_ms` 211,281,
131 transcript lines, 0 skipped.
Transcript: `~/.claude/projects/-private-tmp-arm0-fixture-repo/13b9eb74-df70-493c-a243-9e3950e2e62e.jsonl`

**Caveat: n=1, on the simplest possible ticket shape.** An ambiguous ticket is
where intake's ceremony could still pay. Do not generalize past this shape.

## 2. Ground truth — TARS-1339 fixture

`node_modules/.bin/biome check src/` (biome 2.3.8), measured per tree:

| tree | result |
|---|---|
| epic tip `8257ff7f` (start state) | 201 errors, 2 warnings, 2 infos |
| `master` (`a06a0b59`) | **5 errors, 4 warnings, 4 infos** |
| epic + `825e9391` cherry-picked | **2 errors** |
| arm 0 final tree | 2 infos, exit 0 |

### The four traps, and how arm 0 scored

| trap | claim | reality | arm 0 |
|---|---|---|---|
| a | 148 files | 144 | n/a (changed 147 — own scope) |
| b | autofix covers all 201 | leaves 2 (`mergeFields.js`, `.test.js`) | **caught** |
| c | both biome-ignores stale | only `useSemanticElements` is | **caught** |
| d | "master is clean at 0 errors" | 5 errors | **partial** |

- **Trap (d) is in the TICKET, not intake's invention.** The stakeholder wrote
  it. Intake stamped a stakeholder falsehood `verified` after sampling one file
  (`celebrities.createCelebrity.js`) and never running biome on master. That is
  ticket-skepticism failing at its only job.
- **Trap (c) verified by deletion:** removing the surviving
  `noStaticElementInteractions` suppression yields `Found 1 warning` — it is
  load-bearing. Cause: `role={disabled ? undefined : 'button'}` at
  `src/client/pages/user-ratings/reviews/PendingReviewCard.jsx:129` — the
  *conditional* role is why `useSemanticElements` is dead and the other is not.
  The harness's plan u2 said "All biome-ignore comments … are removed" — a
  harness following its own plan literally ships a contract violation.
- **Trap (d), arm 0's partial:** `REPORT.md` §2 correctly names the
  `PendingReviewCard` warning as pre-existing on master, so it checked master
  for that file; it did not report master's 5 errors, so it never generalized
  the premise failure.

### Two AC findings neither arm nor I fully settled

1. **AC #1 is not satisfiable as written.** It demands "0 errors and 0
   warnings"; the epic tip carries 2 warnings + 2 infos the ticket never
   mentions. The cherry-pick alone cannot reach it. Arm 0's summary claimed "0
   errors, 0 warnings" while 2 infos remained — biome exits 0, so the AC passes
   on the tool's verdict, but the claim is softer than stated.
2. **AC #2 "no behavior changes" is UNVERIFIED** by both arms and by me. 147
   files, 526 insertions, 435 deletions; `tv.suppressAll.js` (24 lines) and
   `tv.suppressAll.test.js` (12) are the ones to check. The `mergeFields.js`
   diff I read is pure reflow. This is the fifth assertion the fixture needs.

## 3. Fixture — `~/.harness/fixtures/tars-1339` (6.7MB)

```
origin.git/            bare, ref-surgical
ticket-prompt.txt      verbatim ticket + AC (256 words, what arm 0 received)
arm0-report.md         arm 0's own REPORT.md
```

Refs exposed (only what the ticket legitimately names):

| ref | sha |
|---|---|
| `refs/heads/feat/migrate-native-fetch-from-axios` | `8257ff7f` (start state) |
| `refs/heads/master` | `a06a0b59` |
| `refs/heads/chore/pre-push-lint-autofix-825e9391` | `825e9391` |
| `refs/arm-results/arm0-2026-07-29` | `4f1f9f2f` (not fetched by clone) |

**Excluded deliberately:** `fix/TARS-1339-biome-lint-errors` (exists on
*origin* in the live repo) and `harness/4da73e-*`. Both contain the finished
answer; a plain clone lets any arm shortcut to it.

### Hazards, all hit for real

- **Reset between runs.** Arm 0 pushed to the epic branch, moving the "start
  state" ref to the solved commit. Caught while saving. Run 2 contaminates
  run 3 unless the runner restores refs.
- **`.gitignore` must be present** or biome hard-errors (`vcs.useIgnoreFile: true`).
- **`package.json` must be present** or biome's React domain stays off and you
  get 18 phantom `suppressions/unused` warnings — silently corrupts trap (c).
  The more dangerous footgun: it looks plausible.
- `.husky/` removed — the eval measures the arm, not the hook.
- `node_modules` copied (357MB) for the biome 2.3.8 binary; not committable.
- Live ticket is `status: Development Complete`. The real repo has moved on;
  the fixture is the only stable ground.

## 4. Mechanisms verified this session

### The Stop hook fires under `claude -p`

Tested with a scratch `--settings` file. Payload keys:
`session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name,
stop_hook_active, last_assistant_message, background_tasks, session_crons`

**Consequence:** the reporter is handed `transcript_path`, `session_id`, `cwd`
directly. The entire discovery layer in `tokens-collect.mjs`
(`subagentsDirForSession`, `discoverLoopTranscript`, `discoverSubagentForRun`
with `observedTotal` fingerprinting, and the four-strategy `via` widening)
exists only because nothing told it which transcript was the run's. Alfred
does not need it.

### Subagents are fully measurable, separately

Subagent turns are **not** in the parent transcript (0 sidechain entries in a
session that spawned 3). They live at:

```
<project-dir>/<session-id>/subagents/agent-<id>.jsonl      full transcript, per-call usage
<project-dir>/<session-id>/subagents/agent-<id>.meta.json  {agentType, description, toolUseId, spawnDepth}
```

`toolUseId` joins back to the exact parent tool call; `spawnDepth` keeps nesting
attributable. So a single worker context can delegate (compaction, output caps)
and stay fully accounted.

**Counter-lesson:** the 3 research digs this session cost **$11.98** — all
opus-5, 3.2–3.9M tokens each, unbounded. Delegation needs a cheap default tier
and a token ceiling. Unbounded agents are where the money goes.

### CLI flags confirmed present (2.1.220)

`--agents <json>` (inline agent defs → subagent tiers with no harness code),
`--fallback-model` (needed for unattended 3am ticks), `--model`, `--settings`,
`--append-system-prompt[-file]`, `--permission-mode`, `--add-dir`,
`--allowedTools`/`--disallowedTools`, `--resume`, `--from-pr`.

### Repo conventions to inherit

Root `package.json`: `harness-skills`, private, `"type": "module"`,
`"test": "node --test"`, **zero dependencies**. `harness-core` has no
`package.json` of its own. Node v22.19.0.

## 5. Architecture agreed

Claude Code is already the harness. Of the four things `harness-core` added,
two were re-implementations of what it already does better — and those two are
the 4.6x.

| we built | already existed | verdict |
|---|---|---|
| phase orchestration (4 contexts, handoff schemas) | loop exists; phases were ours | **drop** |
| verifier rounds + scores + gate | no | **drop** (produced the false `verified`) |
| token/cost accounting | transcript has it, nothing aggregates | **keep, move out of loop** |
| scheduling / unattended | genuinely absent | **keep — the whole point** |

Four pieces:

```
launchd/cron ──▶ bin/alfred loop ──┐
/loop  ────────▶ (same script)      │  lock? poll source, pick 1, resolve base
alfred work TARS-1339 ─────────────┘
                     │ spawn
                     ▼
        claude -p  ← ONE context, reads .alfred/config.json,
                     may delegate subagents (tiered, capped)
                     │ exits
                     ▼
        gate   ← deterministic checklist, runs AFTER the worker
                 (cannot be talked out of a verdict by the agent it grades)
                     │
                     ▼
        report ← transcript + subagents/*.jsonl → record → telemetry sink
```

- **Trigger is one script; the slash command shells out to it.** No second
  implementation. `harness-loop-core`'s 3,000-word SKILL.md asking an LLM to
  *be* the loop is what this replaces.
- **Gate** = repo checks exit 0 (from config) + **every AC mapped to a command
  or explicitly marked unverifiable** (this is what catches AC #2) + scope
  assertion (harness-core #8) + no-fabrication check (#7) + any claim one
  command settles gets settled (#22). **Deleted:** scores, rounds, plateau
  thresholds, self-assessed confidence. The failure was LLM self-scoring, not
  verification.
- **Router** is a table plus two flags, not a service: worker model from config
  (default sonnet), `--fallback-model`, subagent tiers via `--agents` JSON with
  ceilings, escalation to Opus as one explicit logged event.
- **`report`** (name chosen over "sidecar"): pure function
  `(transcript, subagentsDir, config, expected) → record`. Two entry points,
  one implementation — Stop hook (`--from-hook`, reads stdin) and script
  (`--transcript --session`). The hook path means **hand-run sessions also get
  dashboard numbers**.
- **`.alfred/config.json`** per repo — issue source, base-branch resolution
  (incl. epic branches), lint/test/build commands, PR template, off-limits
  paths. Config as source of truth, replacing what a phase used to re-derive.

## 6. Open — do not decide unilaterally

1. **AC→command mapping: derivable or authored per ticket?** On 1339, 3 of 4
   map cleanly; AC #2 maps to "run tests + diff for non-format edits" —
   mechanical but not obvious. The gate's determinism depends on this. Design
   carefully; do not hand-wave.
2. **`tokens-collect` port strategy.** Lean: port the *test cases* (the 7
   dedupe tests, the gap-cap, skip-don't-crash) as Alfred's spec and TDD ~80
   lines fresh, since the hook payload kills the discovery two-thirds.
   Alternative: port wholesale, test only the delta — less risk of losing an
   earned edge case, carries dead code.
3. **Fixture in git vs regenerated by script** (6.7MB bare repo).
4. **Codename** — Alfred proposed; Errand / Ferry / Porter as alternates.
5. **harness-core #20 carries over:** an unsatisfiable or amended blocking AC
   (1339's AC #1 and #4) — hard stop, human gate, or new blocking event class?
   Explicitly the user's policy call.

## 7. Fixture shapes still missing

TARS-1339 covers *trivially specified + false premise in ticket*. It cannot
distinguish arms on:

- **ambiguous ticket** — the case where intake's ceremony might genuinely pay.
  Without it, "drop the pipeline" stays n=1.
- **ticket that should be pushed back on** — does the arm stop instead of
  building the wrong thing?
- **multi-file feature with real tests** — 1339 was formatting; nothing
  exercised design judgment.

## 8. Price table

Copy `model_prices_usd_per_mtok` to `alfred/config/prices.json`, version
stamped. Keys are **`in` / `out` / `cache_read` / `cache_write` /
`cache_write_1h`** (not `input`/`output` — this bit once, producing `$NaN`).
Gateway pins a 5m TTL, so `cache_write` is the right column.
sonnet-4-6 = 3 / 15 / 0.3 / 3.75. Collector emits dated ids
(`claude-haiku-4-5-20251001`) absent from the table — normalize by stripping
`-\d{8}$` for pricing.
