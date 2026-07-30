# Experiment 2 — results

Two context topologies, one deliberately ambiguous ticket with six planted traps.
Rubric and predictions frozen before either arm ran (EXPERIMENT-2.md §2, §3).

**Neither arm is Alfred.** Arm A is a bare `claude -p`; arm B is `harness-core`, the
paradigm being replaced. Arm C (Alfred) could not run: no `bin/alfred`, worker, gate,
or config loader exists — blocked on M0–M4. Any claim about Alfred specifically is a
measurement nobody took.

## 1. Headline

| | arm A — one context | arm B — four phases |
|---|---|---|
| cost | **$0.617** | _pending_ (lower bound $0.383; see §2.5 — subagent tokens are invisible until return) |
| wall | **~2 min** | _pending_ |
| exit | clean, exit 0, empty stderr | _pending_ |
| substantive files changed | **0** | _pending_ |
| Axis 1 (ambiguity) | **2** — top of scale | _pending_ |
| Axis 2 (`delivered-work`) | **FAIL** | _pending_ |
| traps caught | 2 of 5 (3, 4) | intake: 3 of 5 + 1 partial (2, 3, 4; 6 partial) |

## 2. The finding that does not depend on arm B's exit

**Arm A scored the top of Axis 1 and delivered nothing.** It surfaced the ambiguity,
named three approaches, recommended one with a stated reason, and asked a human. In
`claude -p` there is nobody to answer, so the run ended at the question — $0.617
spent, zero files changed, a mechanical sheet **byte-identical to the null arm's**.

My pre-registered prediction was that arm A would score **1**: notice the ambiguity
and resolve it silently. It scored **2** — better than predicted on the axis being
tested, and zero on delivery. Wrong in both directions at once.

That combination is the result. A topology can be excellent at recognizing what it
does not know and still be useless, because recognizing it is where it stops. The
goal is to land a PR.

**Arm B's intake caught trap 2, which I predicted no phase would catch** — and caught
it as a named artifact field (`claims_audit`), correcting four of the ticket's six
factual claims unprompted. §3's hoped-for finding ("ticket-skepticism absent from
both shapes") is dead: it is absent from one shape and structural in the other.

## 3. Method failures found during the run

Four, all recorded in EXPERIMENT-2.md before scoring:

1. **§2.3** — the stall detector measured transcript bytes; arm B's subagent writes
   nothing until it returns. Would have killed a healthy arm at minute 15 and
   recorded the artifact as a topology property.
2. **§2.5** — fixing that made the stall detector nearly inert, and the spend cap
   reads a lower bound because subagent tokens are invisible mid-phase. The cap
   cannot fire when spend accumulates fastest.
3. **§2.2 correction** — I claimed the infrastructure rule was written "before I
   could know which arm it favours." The timestamps disprove it by 102 seconds.
4. **§2.6** — my own doc commits rewrote arm B's `harness_sha` mid-run, because
   `harness-core` is a subdirectory of `skills`, not its own repo. Provenance
   metadata contaminated; code was not.

Plus one scorer defect: `delivered-work` passed on a `.gitignore`-only diff,
contradicting §2.2's pre-registered rule. Fixed TDD-first, 4 tests, 5 falsifications.

## 4. Winner

_pending arm B's exit._

## 5. What this does not settle

n=2 topologies, one ticket. Arm C absent. The ticket is synthetic and I planted the
traps, so catching them does not show either shape catches traps nobody thought of.
Trap 6's behavioral half is unscorable until #20's policy is exercised. Axis 1 is
scored by me, and I hold a thesis.
