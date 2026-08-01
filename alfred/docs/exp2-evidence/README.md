# Experiment 2 — raw evidence

Supporting artifacts for `../EXPERIMENT-2-RESULTS.md`. Nothing here is authored after
scoring; the phase scores and the projection were frozen mid-run on purpose, so that a
claim in the results doc can be checked against what was actually written at the time.

**One exception, and it is marked in place rather than left for a reader to notice.**
`armC-acmap-n3-score.md` gained a §6 amendment after scoring, when fixing #73 showed one of
its own statements to be too broad (it said the AC ids are *never* shown to a worker; that is
true of the arm C runner's prompt and false of `lib/prompt.mjs`). §2's original text is
preserved verbatim and the amendment sits below the next-steps list, per §9's
preserve-and-mark rule — a score sheet quietly edited to be right is no longer evidence of
what was believed at scoring time. No figure, count, or verdict changed.

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

The **gated** sonnet-5 n=3 run, 2026-07-31 — the first with `lib/gate.mjs` wired (#64).
Suite `2026-07-31.1`, so its figures are not comparable to the ungated rows above:

| file | what it is | when written |
|---|---|---|
| `armC-gated-n3-score.md` | all three runs scored against #65's four pre-declared signals | after the run |
| `armC-gated-n3-record.json` | the runner record, **verbatim, with the #66 pricing defect in it** | at run end |
| `armC-gated-run{1,2,3}-delivered.diff` | what each run changed | after the run |

**`armC-gated-n3-record.json`'s `usd` figures are wrong and are kept anyway.** Every one
sums the gated run with the previous night's ungated run of the same index — the #66
substring-match defect, fixed in `e320147`. The record says mean **$4.09 / REJECTED**; the
corrected figures are mean **$1.89 / ACCEPTED**. Per §9's preserve-and-mark rule the file
is not rewritten: the defect manufactured a rejection, and the same defect would have
manufactured an *acceptance* for anyone who deleted the older project dirs first, so the
wrong number is part of the provenance. The score sheet carries both columns and the
reconciliation.

The **ac_map-contract** sonnet-5 n=3 run, 2026-07-31 — the first with `instrument_modified`
wired (#68) and the ac_map contract reachable (#67). Suite `2026-07-31.2`, digest
`88b12fd0…17e5c0d6` **re-verified unchanged after the arm**, so its figures are not comparable
to the `.1` rows above:

| file | what it is | when written |
|---|---|---|
| `armC-acmap-n3-score.md` | all three runs scored; §3 is the self-certified-green measurement | after the run |
| `armC-acmap-n3-record.json` | the runner record, verbatim | at run end |
| `armC-acmap-run{1,2,3}-delivered.diff` | what each run changed to **tracked** files | after the run |
| `armC-acmap-run{1,2,3}-new-*` | the files each run **added** — `git diff` cannot see untracked files (#68's recorded gap), so a diff alone would omit the new retry module entirely | after the run |
| `armC-acmap-run{1,2,3}-ac-map.json` | the ac_map each worker wrote — **the evidence for #73** | at run end |

⚠ **A worker's test file copied in here gets COLLECTED BY OUR OWN SUITE.** Measured: copying
runs 2 and 3's new `*.test.js` verbatim took the repo from 1378/1378 to **1380 tests, 2
failing** — `ERR_MODULE_NOT_FOUND` on their relative imports, because the file now sits at a
different depth than the sandbox it was written for. Nothing was wrong with Alfred; the
*evidence* had joined the suite. Hence the `.test.js.txt` suffix on those two files: still
readable as evidence, no longer a test. Anything ending `.test.js` under `alfred/` is a repo
test regardless of which directory it is in.

**The three ac_maps are kept because they are the defect's evidence, not because they are
inputs.** All three are schema-valid with one entry per criterion, and all three drew
`ac_unmapped` on every criterion anyway: the gate joined on AC **id** while the arm C runner's
prompt prints only checkbox text (#73). Run 3's file is the one that matters most — it kept the
markdown backticks (`` `npm test` passes. ``) where runs 1 and 2 stripped them, which is the
measured proof that an exact-text fallback would still fail 2 of 3 and a normalizer is
required.

**They are now also the fix's regression fixture.** #73 was closed in `466e917`, and
`test/gate.test.mjs` carries these three keyings verbatim — including run 3's backticks. The
fix was checked against these files directly, not only against the tests: `ac_unmapped` goes
3 → **0** on each with no other finding appearing, while three on-topic paraphrases
(`"retry stuff"`, `"tests are fine"`, `"lint"`) are still rejected 3/3. Do not "tidy" these
into a single canonical map — the difference between run 3's and the other two is the whole
reason the fix normalizes rather than compares raw text.

**This record's `usd` figures are correct and independently corroborated.** Each run's
price-table figure agrees with the CLI's own `total_cost_usd` to six decimal places
($2.439392, $2.049787, $2.547346). Unlike the `.1` row above, nothing here needs a correction
column.

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
