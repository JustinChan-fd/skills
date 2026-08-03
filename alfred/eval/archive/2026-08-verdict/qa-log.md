# Alfred verdict Q&A log

Context: user is questioning whether Alfred (multi-agent harness) is worth continuing to build,
given Sonnet 5/Opus 5's built-in reasoning may make the harness redundant scaffolding. Logging
Q&A here so nothing is lost across the back-and-forth before a final call is made.

---

## Q1: "My original goal was a process/skill/workflow that runs on a loop, checking Jira/GH every
n time period, deciding whether to pick up the next ticket in queue. Do I have that today?"

**A: No.**

- `alfred loop` exists as a CLI command name but is a deliberate stub — it refuses to run:
  "alfred loop is not yet built: it needs the lock file and the source poll of PLAN.md §2.2.
  Refusing rather than exiting 0, because a scheduler cannot tell a silent success from a tick
  that patrolled and found nothing." (lib/cli.mjs ~line 272)
- `alfred schedule` (--start/--stop/--status/--dry-run) does not exist as a command at all.
- No polling, lock-file, or queue-decision logic exists anywhere in router.mjs or cli.mjs
  (grep-confirmed).
- What exists today: `alfred work "<ticket>"` — a single, manually-invoked run against ONE named
  ticket. That's it.
- Tasks #18 (loop: one tick) and #19 (schedule subcommands) are both still [pending] on the
  board — this was already known/tracked as not-yet-built, not a surprise regression.

So the piece that runs ("work one ticket, gate it") has real defects we found this session
(evidence_weakened false positive, AC heading blindness). The piece that was the actual original
goal (autonomous loop deciding what to pick up next) was never started.

## Q2: "Every time the process runs autonomously, I wanted every run metric/snapshot/data point
aggregated and logged to a local folder for future KPI analysis. Do I have that today?"

**A: Partial yes on the write-path, but real gaps around it.**

Working:
- record.json is a genuinely rich per-run artifact (tokens by model, cache read/creation, cost
  matched to vendor to 6dp, gate findings, AC grading, delivery status, wall time).
- lib/telemetry.mjs's syncRecord pushes it to a real git-cloned sink
  (~/.harness/telemetry/log/<repo>/<run_id>.json), wired as Step 7c in run.mjs.
- Confirmed webtarsthree's config has remote/dir set and its runs (e.g.
  20260802T082954Z-TARS-1351.json) are actually landing in the sink.

Gaps:
- The jarvis experiment repos (jarvis-issue7-alfred) have NO telemetry block configured — checked,
  it's null. That comparison run never reached the sink; we only have its metrics because the
  standalone /tmp/extract-metrics.mjs script pulled straight from the worker log, bypassing the
  sink entirely.
- The dashboard meant to turn logged JSON into KPI views is broken — harness-telemetry/build.js
  refuses to run: "v2/ was retired on 2026-07-28; log/ is now the only sink. Repointing this
  script at log/ is issue #1." Files land, nothing aggregates/visualizes them yet.
- This only fires through `alfred work`. Since the autonomous loop (Q1) doesn't exist, "every
  autonomous run" has zero instances today regardless of the sink being ready.

Net: the schema + write-path is real and validated to 6dp. The auto-config-per-repo, the
aggregation/dashboard layer, and the actual autonomous run history to aggregate are all missing.

## Q3: "Alfred's value is the verification scoring + metrics aggregation. Can we build these as
standalone skills/mechanical pieces that just get triggered within whatever process/workflow we
end up going with?"

**A: Yes — and this is already proven, not just theoretical.**

/tmp/extract-metrics.mjs already did this: imported report.mjs's recordForRun directly, ran it
against a plain `claude -p` single-agent worker log (no Alfred orchestration involved), got the
same validated record shape, cost matched to vendor to 6dp on historical runs.

Confirmed via import graph: gate.mjs, report.mjs, telemetry.mjs only import Node builtins + lib/
siblings (paths.mjs, tokens.mjs, prices.mjs, gaps.mjs, suite.mjs, transcript.mjs). None import
run.mjs/router.mjs/cli.mjs/prompt.mjs — the actual multi-agent orchestration layer. They're
already plain functions over data (worker log in, record out; diffstat+config in, findings out;
record in, sink-synced out) — not architecturally coupled to Alfred's worker-spawn loop.

Three separable pieces:
1. Metrics extraction (report.mjs -> recordForRun) — harness-agnostic, proven.
2. Gate/verification (gate.mjs -> checkEvidence etc.) — needs its 2 known bugs fixed first
   (raw-deletion-count blindness, AC heading regex), but already just a function over data.
3. Sink sync (telemetry.mjs -> syncRecord) — unconditionally safe, proven end-to-end on
   webtarsthree.

Real move: stop building multi-agent orchestration around these, call them as a lightweight
post-hoc step from whatever single-session skill/workflow gets chosen instead. Smaller build
than what exists today.

## Q4: "Can we create many forms of Alfred / process/skill/workflow that just 'import' the
verification scoring + metrics aggregation pieces, so any process can opt in, show up in the
logs folder, and present in the dashboard all-runs list? Any invocation we deem necessary to
track can opt in or not."

**A: Yes, and it's closer to real than expected — checked the actual signatures.**

- buildRecord(transcriptPath, subagentsDir, session, work, gate, delivery, suite, sink,
  workerCostUsd, error) — all params optional/nullable, nothing requires Alfred's run-dir shape
  or worker-spawn structure. recordForRun (what extract-metrics.mjs used) is even thinner: worker
  log + cwd + session id, no Alfred concepts.
- syncRecord(runDir, telemetry, record) — only requires record.session.repo and
  record.session.run_id to exist. Any caller supplying those two fields lands in the same sink,
  same log/<repo>/<run_id>.json layout, alongside Alfred's own runs.

So "any skill/workflow opts in, shows up in the same logs folder, appears in the same dashboard"
= package these 3 functions as a tiny standalone module (no Alfred CLI, no run.mjs, no
worker-spawn) with one call, e.g. recordAndSync({ transcriptPath, session, gate, telemetry }).
Any skill calls it optionally at the end of its own run.

Two things stand between that and reality today (neither is a redesign, both are scoped fixes
to existing code):
1. Dashboard still broken (build.js "issue #1") — more log/ entries don't help until this is
   fixed, nothing renders them yet.
2. Gate's 2 known bugs (evidence_weakened false positive, AC heading regex) need fixing before
   "verification scoring" is safe to let every opted-in skill inherit.

Net: the decoupling the user is asking about is already true of the code's shape — it's not
architecturally coupled to Alfred's orchestration — it just isn't packaged/exposed as a
standalone thing yet.

## Q5: "Can't Alfred be redesigned to just be a light orchestrator that opts into these pieces?
Could we create Alfred-2 (code focus), Alfred-3 (docs focus) as sharply-focused skills/agents?
Could Alfred itself be the router deciding which subagent/agent spins up based on ticket type?"

**A: Mechanically yes on the thin-orchestrator idea — consistent with Q3/Q4's finding that the
verification/metrics pieces don't depend on Alfred's orchestration. But pushback on the router +
multi-Alfred framing: it risks recreating the same problem under new names.**

- Thin runner: take a ticket, pick a system prompt, run ONE Claude Code session, call
  recordAndSync() at the end. Real simplification, consistent with everything found so far.

- Alfred-2/Alfred-3 as SEPARATE SYSTEMS: questioned whether they need to be separate systems at
  all. If the mechanical pieces are decoupled, "code-focused" vs "docs-focused" isn't an
  architecture difference, it's a PROMPT difference — two skills, different system prompts, same
  recordAndSync() call. Naming them "Alfred-2"/"Alfred-3" invites building two more orchestration
  layers for what's actually just a paragraph of instructions difference. Recommend: one thin
  runner + N prompt variants, not N systems.

- Alfred-as-ROUTER deciding what spins up: flagged as the highest-risk part. Ticket-type
  classification ("code ticket vs docs ticket") is almost certainly the "known rule, known
  inputs" case per [[feedback_model_tier_philosophy]] — a label/keyword check, not a reasoning
  task. If "Alfred the router" becomes a persistent process making judgment calls about
  dispatch, that's a harness above the workers again — same shape, moved up one level. Router
  should be a plain function (label -> prompt variant), not an agent, unless real ambiguity is
  hit (no clean ticket label, genuinely unclear type) — add judgment only then, don't assume it
  upfront.

Net recommendation: ONE thin caller + small set of prompt variants + mechanical (non-LLM)
dispatch rule, all sharing the same three library calls (metrics extraction, gate/verification,
sink sync).

## Q6: "Tickets from different teams have different AC formats. Maybe Alfred should only run
with a high-confidence understanding of the ticket ask + AC. If it doesn't meet threshold, exit
early, log the run + why, message the user. Ideally Alfred only works on already-refined
tickets, but this gates early and exits out instead."

**A: Strong idea, directly fixes something we found broken this session.**

- On jarvis#7, extractAcceptanceCriteria silently returned ac_count:0 when the heading regex
  missed "## Details" — no loud failure, just 0 graded criteria, and the run only failed for an
  unrelated reason (the evidence_weakened false positive). Had that not fired, a run with ZERO
  graded criteria would have passed silently. An early, explicit refusal is strictly better than
  that silent gap.

- Caveat, same lesson as the whole session: don't make the confidence score a bare self-report.
  "Are you confident?" invites the same false-yes risk as "did you verify this passes?" Fix:
  require the confidence claim to come with grounding that's mechanically checkable — have the
  model quote the specific ACs it found FROM the actual ticket text, plus a confidence score, and
  have plain code (not another model call) verify each quote actually appears in the ticket body.
  Hallucination/paraphrase-instead-of-quote becomes detectable without trusting self-assessment.

- This reframing quietly replaces the "broaden the AC heading regex" fix that was about to get
  filed as a task — instead of hardening a regex against infinite ticket-format variance forever,
  let a model read the ticket in whatever format, extract ACs with quoted grounding, gate on
  well-groundedness + confidence, refuse early when ungrounded/low-confidence.

- Fits the Q3-Q5 shape: a pre-flight check, separate from the post-hoc verification/metrics
  pieces. Should log the same way — even an early exit gets a sink record (e.g. gate_pass:false,
  reason: low-confidence AC extraction) so false-refusal rate is trackable over time, not just
  false-pass rate.

- Directly serves "Alfred should only work on already-refined tickets" — pushes responsibility
  for ticket quality onto the ticket, rather than the harness compensating for a bad ticket.

## Q7: "My normal scenario would be '/alfred {URL}' or '/loop alfred checking on {epic} every n
{time frame} until all tickets are done and in PR'. Does everything discussed fit this? Simplest
thing = use first-class /loop + build metrics aggregation as a portable mechanism within a skill,
capturing initial data at start, aggregating at end."

**A: Yes, cleanest synthesis so far — with one load-bearing gap to flag.**

Fits cleanly:
- /loop as scheduler replaces the never-built alfred-loop/alfred-schedule (Q1) — don't need to
  build that machinery, it's a first-class primitive already.
- Per-tick work = the thin orchestrator from Q5: one skill invoked each tick that (a) runs the
  confidence-gated AC check (Q6) first, exits early + logs if it fails, (b) does implementation
  as a single session, (c) calls recordAndSync() (Q3/Q4) at the end.
- Start-snapshot + end-aggregate maps directly onto existing record shape — a start-of-run
  identity stamp + end-of-run buildRecord/syncRecord call. Should land even on early
  confidence-gate exits so refusals are as trackable as passes.

Gap to flag before building on this:
- /loop's underlying mechanics (ScheduleWakeup/CronCreate) are explicitly SESSION-SCOPED per
  their own tool descriptions: "session-only... nothing is written to disk, and the job is gone
  when Claude exits," recurring jobs auto-expire after 7 days even while alive. So this works
  while an active session is running, self-terminates after ~1 week regardless, and stops if the
  session closes. Real gap against "fire and walk away for a week+" — true unattended operation
  needs scheduling to live OUTSIDE the session (real system cron invoking `claude -p`
  headlessly), not /loop itself.
- /loop doesn't give you "check epic, find next unclaimed ticket, skip blocked, know when done"
  for free — that queue-decision logic (already designed: feedback_blocked_policy memory —
  stop/comment/label/skip/terminate) still needs to be written as the tick's own
  prompt/skill instructions. /loop is the heartbeat; the queue logic is still yours to specify.

Net: "until all tickets are done" should be read as "until done, capped at ~7 days of
session-bound looping," not indefinite unattended operation, unless scheduling moves outside
the session.

## Q8: "To clarify, I plan to only invoke Alfred locally in terminals, single-use or within a
first-class /loop. This is because I want to keep this work local and land PRs as if I'm
developing normally and submitting PRs. Does this make things easier?"

**A: Yes for infrastructure/scheduling, no reduction in verification bar — if anything, higher
stakes.**

Easier:
- Resolves the Q7 session-scoping gap entirely — /loop being session-bound (~7 day cap, dies
  with the session) is now the CORRECT fit, not a limitation, since the user is at the terminal
  or leaving /loop running while present, not expecting unattended multi-day operation.
- No new auth/infra needed — gh + git credentials already live locally (confirmed working: the
  single-agent arm used `gh issue view` directly), Jira OAuth already on disk. Local-only just
  uses what's already there. No service accounts, no remote secrets, no hosting.
- Thin orchestrator (Q5) simplifies further: just a skill in the user's own shell, own
  credentials, own local clone — no dispatch boundary to design.

NOT easier / raises the bar:
- "Land PRs as if developing normally" moves task #17 (branch/commit/draft PR) from simulated
  to REAL. Every experiment this session was explicitly non-destructive (standing constraint:
  no pushes, no real PRs). Real delivery = real git pushes + real `gh pr create` against actual
  repos — a different risk tier, the kind of hard-to-reverse/visible action that needs explicit
  confirmation before wiring in, not a quiet flip.
- Because of that: the 2 known gate bugs (evidence_weakened false positive, AC-heading
  blindness) and the Q6 confidence-gate idea move from "fix eventually" to PREREQUISITE. A false
  positive today just blocks; a false negative once delivery is real means a bad PR lands on a
  real repo under the user's name. Local-only + real PRs sharpens the case for fixing the gate
  first, doesn't relax it.

## Q9: "Alfred doesn't launch subagents. By design? Cost, efficiency, or both? If subagents
become necessary, what types of agents help Alfred do its job? For long autonomous runs, do we
need subagents to prevent hitting max input/output token limits?"

**A: Both design and cost, confirmed via code + comments. Subagents help cost/isolation, NOT
directly the token-ceiling problem — that's a different lever.**

- By design: router.mjs header states philosophy directly — PLAN §6 "A table and two flags. Not
  a service, not a phase, not a model call." Worker runs as ONE continuous session; scan/reason
  seats are ADVERTISED via --agents so the worker CAN delegate if it judges useful, nothing
  forces it. Every run this session (jarvis#7, TARS-1351) showed subagent_count:0 — the worker
  never chose to delegate. Alfred isn't itself supposed to be a multi-agent orchestrator; the
  model decides internally.

- Cost is a real driver, not just efficiency: documented incident in router.mjs — "the $11.98
  lesson (an unbounded subagent burning 3.9M tokens)." Hard rule: no subagent seat may route to
  Opus (agentsPayload throws if attempted) — Opus is explicit/logged escalation only, never a
  default seat. Real, measured gap: --agents CLI flag only honors `model`, silently swallows
  maxTokens/token_budget/any other key (see reference_claude_cli_budget_flags memory). Alfred
  tracks its own token_budget per seat but nothing enforces it — a spawned subagent CAN run away
  today with nothing built-in to stop it.

- If subagents become necessary: the 2 existing seats point at the right shape — `scan` (cheap,
  read-only lookup: does X exist, find where Y is called) and `reason` (bit more judgment, still
  bounded: classify an AC as deferred vs actionable). Both Haiku-tier, matches
  feedback_model_tier_philosophy: mechanical/pattern-matching -> cheap seat, open-ended judgment
  -> main driver, true escalation-worthy ambiguity -> Opus, explicitly logged.

- Token-limit question: subagents are NOT the mechanism for avoiding hard context ceilings —
  that's handled by compaction/summarization + the turn/wall-clock caps (--max-turns,
  --wall-cap-minutes) already in place. Subagents help COST (cheap seat for mechanical
  sub-tasks) and ISOLATION (a subagent's investigation doesn't pollute main session context),
  which indirectly extends how long a main session can run before filling up — but the actual
  backstop against a runaway is the turn/wall-clock cap, not subagent architecture.

## Q10: "The metrics are the single most valuable thing to me and upper management. Seeing how
each run costs and comparing results to assess value needs to run flawlessly. At the moment, do
the metrics written give me metrics for an ENTIRE TERMINAL SESSION I'm in, OR only track the
moment I invoke alfred?"

**A: Only the moment you invoke Alfred — confirmed in code.**

- run.mjs line 467: `const sessionId = newSessionId()` — a FRESH session id is generated every
  time `alfred work` is called, passed to the worker via --session-id and to claude's own SDK
  transcript path (~/.claude/projects/<cwd-slug>/<sessionId>.jsonl via transcript.mjs's
  transcriptPathFor).
- Each `alfred work` invocation = its own brand-new transcript file. recordForRun/buildRecord
  only ever reads that ONE file. Two separate `alfred work` calls in the same terminal session
  (even back to back) = two separate session ids, two separate transcripts, two separate
  record.json's. Nothing aggregates "everything that happened in this terminal today."

Why this matters for the stated goal (cost comparison / value assessment for upper management):
- This is actually CORRECT for cost-PER-TICKET comparison (want ticket A's cost separate from
  ticket B's, not blended).
- But if a rolled-up view is also wanted — "this epic cost $X across N tickets, Y hours
  wall-clock" — that aggregation does NOT exist today. Would need to be built as a separate step
  that reads all record.json's written during a /loop run and sums/aggregates them, keyed by
  something like the loop's own run/epic identity. Not automatic from the current
  per-invocation design.
