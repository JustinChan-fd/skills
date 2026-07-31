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

Arm C's artifacts, added as the runs happened. Two seats, named in the filenames, because
`armC1` on sonnet-5 and `armC-opus-run1` on opus-5 are different configurations and a
reader who conflates them reads a model comparison as a repeat:

| file | what it is | when written |
|---|---|---|
| `armC1-record.json` | sonnet-5 run 1's runner record | at run end |
| `armC1-worker.json` | sonnet-5 run 1's raw `--output-format json` | by the CLI |
| `armC1-delivered.diff` | what sonnet-5 run 1 changed | after the run |
| `armC1-new-src-retry.js` | the `src/retry.js` sonnet-5 run 1 added | after the run |
| `armC-opus-run1-record.json` | opus-5 run 1's runner record — **carries the full worker prompt** | at run end |
| `armC-opus-run1-score.md` | opus-5 run 1 scored per trap, vs §4.1 | after the run |
| `armC-opus-run1-delivered.diff` | what opus-5 run 1 changed | after the run |
| `armC-opus-run1-new-src-retry.js` | the `src/retry.js` opus-5 run 1 added | after the run |

**`armC1-record.json`'s `$1.974173` is superseded, and is kept anyway.** It was priced
before #59 fixed the introductory-rate defect; the same run at the decided $3/$15 table is
**$2.961259** (= 1.974173 × 1.5), which is the CLI's own `total_cost_usd`. Per §9's
preserve-and-mark rule the file is not rewritten — the figure is what the runner actually
reported at the time, and `armC-opus-run1-score.md` states the correction where the
comparison is made.

**`armC-opus-run1-record.json` contains the worker's full prompt, and that is deliberate.**
§4.1 records a comparability gap: arm A's exact prompt was never captured, so "what did arm
C get that arm A did not?" is answerable from one side only. Arm C's side is now on disk
verbatim rather than reconstructable. It also makes the §4.1 claim checkable — that nothing
in the prompt says the ticket is flawed or that pushing back is expected. `worker.log` in
that file is a **path**, not log content.

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
