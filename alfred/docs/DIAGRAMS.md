# Alfred — diagrams

Companion to `PLAN.md`. Nothing here is new design; it is the plan drawn.

---

## 1. The whole run

```
  THREE ENTRY POINTS ─────────────────────────────────────────┐
                                                              │
   launchd / cron ─────▶ bin/alfred loop ──┐                 │
   /loop (slash cmd) ──▶ (shells out) ──────┤  ONE SCRIPT.    │
   alfred work TARS-1339 ──────────────────┘  no second impl │
                                              │              │
                                              ▼              │
                            ┌──────────────────────────────┐  │
                            │ 1. load .alfred/config.json │  │
                            │    missing → REFUSE          │  │
                            │    (never invent defaults    │  │
                            │     at 3am)                  │  │
                            └──────────────┬───────────────┘  │
                                           ▼                  │
                            ┌──────────────────────────────┐  │
     jira / gh issues ─────▶│ 2. fetch work item           │  │
                            │    write raw payload to disk │──┼─▶ run/<id>/source.json
                            │    BEFORE interpreting it    │  │   (makes the run replayable —
                            └──────────────┬───────────────┘  │    v2 kept a 1-line excerpt,
                                           ▼                  │    so no v2 run can be replayed)
                            ┌──────────────────────────────┐  │
                            │ 3. resolve base branch       │  │
                            │    epic branch is NORMAL     │  │
                            │    (TARS-1271 was not master)│  │
                            └──────────────┬───────────────┘  │
                                           ▼                  │
                            ┌──────────────────────────────┐  │
                            │ 4. router.mjs → argv[]       │  │
                            │    pure: config in, flags out│  │
                            └──────────────┬───────────────┘  │
                                           ▼                  │
   ╔═══════════════════════════════════════════════════════════════════════╗
   ║  5.  claude -p    ← ONE CONTEXT. one cache prefix.                    ║
   ║                                                                       ║
   ║      ┌────────────────────────────────────────────┐                   ║
   ║      │ reads config, ticket, AC list              │                   ║
   ║      │ audits the ticket's claims first           │                   ║
   ║      │ writes REPORT.md + ac_map + commands.jsonl │                   ║
   ║      └───────────┬────────────────────────────────┘                   ║
   ║                  │ may delegate (tiered, ceilinged)                   ║
   ║        ┌─────────┼─────────┐                                          ║
   ║        ▼         ▼         ▼                                          ║
   ║     scan      reason     scan          ← haiku / sonnet.              ║
   ║    (capped)  (capped)  (capped)          NO opus by default           ║
   ║                                          ($11.98 lesson)              ║
   ╚═══════════════════════════════════════════════════════════════╤═══════╝
                                           exits                   │
                                           ▼                       │
                            ┌──────────────────────────────┐       │
                            │ 6. GATE  (separate process)  │       │
                            │    runs the commands ITSELF  │       │
                            │    pure fn. no model. no net.│       │
                            │    cannot be talked out of   │       │
                            │    a verdict by the agent    │       │
                            │    it is grading             │       │
                            └──────────────┬───────────────┘       │
                                           ▼                       │
                            ┌──────────────────────────────┐       │
                            │ 7. REPORT  ◀─────────────────┼───────┘
                            │    transcript + subagents/   │   (also reachable
                            │    → record → sink           │    via Stop hook)
                            └──────────────┬───────────────┘
                                           ▼
                                  ~/.harness/telemetry
                                           │
                                           ▼
                                      dashboard
```

---

## 2. Where the numbers come from

The join that makes delegation safe to allow. **Subagent turns are not in the
parent transcript** — verified: 0 sidechain entries in a 3-agent session.

```
  ~/.claude/projects/<munged-cwd>/
  │
  ├── <session-id>.jsonl ──────────────────▶ parent turns, per-call usage
  │                                            │
  └── <session-id>/subagents/                  │
      ├── agent-a1.jsonl ──────────────┐       │
      ├── agent-a1.meta.json ──────┐   │       │
      │     { agentType,           │   │       │
      │       description,         │   │       │
      │       toolUseId,  ─────────┼───┼───────┘  joins to the EXACT
      │       spawnDepth }         │   │          parent tool call
      ├── agent-b2.jsonl           │   │
      └── agent-b2.meta.json       │   │
                                   ▼   ▼
                          ┌────────────────────────┐
                          │      report.mjs        │
                          │  pure fn, no I/O core  │
                          └───────────┬────────────┘
                                      ▼
       ┌─────────────────────────────────────────────────────────┐
       │ session   id, repo, branch, base, wall_ms               │
       │ work      source, item_id, ac_count                     │
       │ tokens    by_model{in,out,cache_read,cache_creation},    │
       │           peak_context, active_ms                       │
       │ subagents [ per agent: by_model, spawnDepth, toolUseId ] │
       │ cost      by_model → usd, total, price_table_version    │
       │ gate      pass, findings[], unverified[]                │
       │ delivery  commits[], pushed_to, pr_url|null             │
       │                                                         │
       │ by_phase  ── ABSENT BY DESIGN. there are no phases.     │
       └─────────────────────────────────────────────────────────┘

  TWO ENTRY POINTS, ONE IMPLEMENTATION:

    Stop hook ──▶ alfred report --from-hook   (payload on stdin:
      │                                          session_id, transcript_path, cwd)
      │           ↳ so HAND-RUN sessions get dashboard numbers too
      │
    script ────▶ alfred report --transcript <p> --session <id>
                  ↳ backfill, and grading a transcript after the fact
```

The hook payload is handed `transcript_path` directly. That is what deletes the
entire discovery layer v2 needed (`discoverLoopTranscript`,
`discoverSubagentForRun`, `observedTotal` fingerprinting, four-strategy
widening) — all of it existed only because nothing told it which file was the
run's.

---

## 3. The gate

```
   worker artifacts                       gate (separate process)
   ────────────────                       ───────────────────────
   REPORT.md          ─────┐
   ac_map             ─────┤
   commands.jsonl     ─────┼──▶  ┌──────────────────────────────────┐
   git diff --name-only ───┤     │ 1. run every config.verify cmd   │
   run/<id>/source.json ───┘     │    ITSELF ── ignores the worker's │
   .alfred/config.json ───▶     │    claimed results               │
                                 └───────────────┬──────────────────┘
                                                 ▼
                                 ┌──────────────────────────────────┐
                                 │ 2. every AC → exactly one state  │
                                 └───────────────┬──────────────────┘
                                                 ▼
        ┌────────────┬────────────┬──────────────────┬────────────────┐
        ▼            ▼            ▼                  ▼                ▼
    passed        failed     unverifiable      unsatisfiable       (silence)
   cmd exit 0   cmd exit N   + REASON          + evidence            │
        │            │            │                  │               │
        │            ▼            ▼                  ▼               ▼
        │          FAIL      → unverified[]    → unverified[]      FAIL
        │                      pass, flagged     pass, flagged   ← there is no
        │                      for a human       for a human       fifth state
        │                            ▲                 ▲
        │                            │                 └── 1339 AC #1:
        │                            └── 1339 AC #2:        "0 warnings" vs a tree
        │                                "no behavior         with 2 pre-existing.
        │                                changes" — both      Not satisfiable as
        │                                arms AND I left      written.
        │                                this unverified.
        ▼
   ┌──────────────────────────────────────────────────────┐
   │ 3. scope:      touched ⊆ declared, ∩ off_limits = ∅   │
   │ 4. no-fabrication: every "X passes" → recorded exit   │
   │ 5. settle the settleable: if one command decides it,  │
   │    run the command                                    │
   │      ↳ v2 stamped "master is clean at 0 errors"       │
   │        VERIFIED after sampling ONE file.              │
   │        master had 5 errors. one command settles it.   │
   └───────────────────────────┬──────────────────────────┘
                               ▼
              { pass, findings[], unverified[] }

   DELETED from v2's verifier:  scores · rounds · plateau thresholds ·
                                self-assessed confidence
   KEPT:                        verification
   because what failed was LLM SELF-SCORING, not verifying.
```

---

## 4. Why one context — the measured shape

```
   v2: four phases, four cache prefixes        v3: one context, one prefix
   ─────────────────────────────────────       ────────────────────────────

   intake    ▓▓▓▓▓▓▓ build prefix              worker ▓░░░░░░░░░░░░░░░░░░░
             ░░░░ work                                 │
   plan      ▓▓▓▓▓▓▓▓▓ build AGAIN                     └─ build once, then
             ░░░░░ work                                   read it 95.6% of
   implement ▓▓▓▓▓▓▓▓ build AGAIN                         the time
             ░░░ work
   verify    ▓▓▓▓▓▓ build AGAIN
             ░░ work
                                             ▓ = cache_creation (paid)
                                             ░ = cache_read (~10x cheaper)

   MEASURED, same ticket, same collector, same price table:

   tokens   10,422,619  ████████████████████████  │  2,207,405  █████
   cost         $5.15   ████████████████████████  │      $1.12  █████
   wall         24.6m   ████████████████████████  │       3.6m  ████
   shipped?    NO PR    ✗                         │  commit+push ✓

                        4.7x tok · 4.6x cost · 6.8x wall — and it didn't ship

   ⚠  n=1, on the simplest ticket shape there is. EXPERIMENT-2 is the
      attempt to falsify this on an ambiguous ticket, which is the shape
      where phase separation could genuinely pay.
```

---

## 5. Build order

```
   ┌──────────────────────────────────────────────────────────────┐
   │  EXPERIMENT 2  ── ambiguous ticket, both arms                │  ← FIRST.
   │  can overturn everything below it                            │    nothing in
   └───────────────────────────┬──────────────────────────────────┘    lib/ exists
                               │                                       yet, so this
        ┌──────────────────────┼──────────────────────┐                is the cheapest
        ▼                      ▼                      ▼                moment to find
   thesis holds        quality only            pipeline wins           out
        │              (expected)                    │
        ▼                      ▼                     ▼
   build as written    add ONE pre-step        §2 is wrong;
                       INSIDE the worker       route by ticket shape
                       (not a phase graph)

   then:

   M0 prices ──▶ M1 tokens ──▶ M2 report ──┐
   (unblocked)   (spec = v2's earned        │
                  test names, impl fresh)   │
                                            ▼
   M3 config ──▶ M4 gate ──▶ M5 router ──▶ M6 fixtures ──▶ M7 loop
                  ▲
                  └── needed the AC-mapping decision. now: hybrid.

   every milestone = test names written and WATCHED FAIL first.
```

---

## 6. Layout, and the wall

```
   skills/
   ├── harness-core/          ← UNTOUCHED. this is the evidence.
   │   ├── tools/lib/            when someone asks "why no verifier loop?",
   │   ├── config/routing.json   the answer is a directory they can read
   │   └── test/  (38 files)
   │                          ╔═════════════════════════════════════╗
   │                          ║  NO IMPORTS ACROSS, EITHER WAY.     ║
   │                          ║  values COPIED, not linked.         ║
   │                          ║  a duplicated 60-line price table   ║
   │                          ║  is cheaper than a coupling.        ║
   │                          ╚═════════════════════════════════════╝
   ├── alfred/
   │   ├── bin/alfred           work | loop | report | gate
   │   ├── lib/
   │   │   ├── config.mjs        load + validate
   │   │   ├── tokens.mjs        transcript → sums
   │   │   ├── report.mjs        pure fn → record
   │   │   ├── gate.mjs          pure fn → verdict
   │   │   ├── router.mjs        config → argv[]
   │   │   ├── fixture.mjs       provision / RESET
   │   │   └── prices.mjs        normalize + cost
   │   ├── config/prices.json    copied, version stamped
   │   ├── test/*.test.mjs       node --test, zero deps
   │   ├── fixtures/
   │   │   ├── tars-1339/        specified + false premise
   │   │   └── <ambiguous>/      ← EXPERIMENT 2. does not exist yet.
   │   └── docs/{HANDOFF,PLAN,EXPERIMENT-2,DIAGRAMS}.md
   │
   └── package.json           inherited: type module, node --test, ZERO deps
```

Fixture shapes still missing (`PLAN.md` §7): **ambiguous** (experiment 2),
**should-be-pushed-back-on**, **multi-file feature with real tests**.
