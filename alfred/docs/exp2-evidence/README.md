# Experiment 2 — raw evidence

Supporting artifacts for `../EXPERIMENT-2-RESULTS.md`. Nothing here is authored after
scoring; the phase scores and the projection were frozen mid-run on purpose, so that a
claim in the results doc can be checked against what was actually written at the time.

| file | what it is | when written |
|---|---|---|
| `armA-score.md` | arm A's Axis 1 + mechanical sheet | after arm A exited, **before** arm B was read |
| `armB-intake-score.md` | intake phase, per-trap | mid-run, before implement returned |
| `armB-plan-score.md` | plan phase, per-trap, running tally | mid-run, before implement returned |
| `armB-projection.md` | pace projection + a falsifiable prediction | minute 26, before any cap could fire |
| `method-notes.md` | the §2.6 provenance decision | 16:16Z, mid-run |
| `results-draft.md` | the draft written while arm B was still live | superseded by `../EXPERIMENT-2-RESULTS.md` |
| `armA.json` / `armB.json` | provisioned fixture state (head, tree, branch) — **not results**, see below | at provision time |
| `watchdog.log` | every poll, both arms, including the kill line | live |
| `armB-differential-oracle.mjs` | **arm B's own** equivalence oracle | by arm B, during implement |
| `armB-implement-record.json` | the `status=attempted phases=[] wall_ms=null` record | by arm B; never finalized (SIGTERM) |

## Three things to know before reading

**`armA.json` and `armB.json` are named after arms and contain no arm results.** Both hold
the same eight *provisioning* fields — `slug`, `root`, `repo`, `origin`, `branch`, `head`,
`tree` — and are byte-identical apart from paths. No score, no cost, no verdict. A reader
who opens `armA.json` expecting arm A's result finds fixture state.

**Considered and rejected 2026-07-30 (#49): renaming them.** `provision-armA.json` would
read better, and the cost is wrong. These are frozen mid-run evidence, and §9's rule is
**preserve-and-mark over delete** — a rename severs the correspondence between the filename
and the six places the run and its scoring already refer to, for a cosmetic gain. It is also
the wrong direction of fix: the durable answer is that results become a **machine-readable
record** (#47) rather than prose, at which point these files stop being mistaken for
results because actual result files exist. Marked here rather than moved.

What the naming *did* cause, and is now fixed: `lib/model-changes.mjs` cited the score
sheet at a path that got de-duplicated away, and nothing checked that a ledger citation
resolves. `test/model-changes.test.mjs` now fails when one does not.

## Two more things to know before reading

**`armB-differential-oracle.mjs` is arm B's artifact, copied verbatim — and it does not
run as-is.** It was mid-rename from `console.log` to an `emit` helper when the spend cap
killed the arm three seconds later (file mtime 09:20:16, kill 09:20:19), so the call sites
exist and the definition does not. The `ReferenceError` is **my killer's artifact, not a
defect in arm B's work**. Supplying the one missing line
(`const emit = (m) => process.stdout.write(\`${m}\n\`)`) is what produced the 6-divergence
and 0-divergence figures in §5.

**`watchdog.log` contains three `WATCH start` lines.** The watchdog died with a session
twice and was restarted; that is method failure §2.7, and the reset wall clock it caused is
why the log's early `wall=` readings understate arm B's true age. The `$1.072` spend
readings before 16:19 are the §2.8 bug — 6% of the real spend — not a record of what arm B
had cost.
