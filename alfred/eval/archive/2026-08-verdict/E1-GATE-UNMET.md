# Phase E is skipped. The gate that protects ~1GB of worktrees is unmet, and cannot be met tonight.

Measured 2026-08-03, after Phase C's backfill landed all five historical records in the sink.

## The gate

E1 requires, for **each** of `webtarsthree` and `jarvis`: 3 records in
`alfred-telemetry/log/<repo>/`, with **3 distinct `provenance.arm` values**, all shaped alike.

The plan's own instruction on failure is unambiguous, and is being followed rather than
reasoned around: *"~1GB is not urgent. If anything in E1 is unmet, skip Phase E entirely and
keep the disk."*

## What is actually in the sink

| repo | records | distinct arms | arms present | E1 met |
|---|---|---|---|---|
| webtarsthree | 3 | **1** | `alfred-thin` | no |
| jarvis | 1 | **1** | `alfred-thin` | no |
| skills | 1 | 1 | `alfred-thin` | n/a (not gated) |

webtarsthree hits the record COUNT and misses on arm DIVERSITY, which is the part that
matters — three records from one arm answer nothing that one record from one arm doesn't.

## Why no further run fixes this

E1 was written on the assumption that three arms would be *found* in the history. Phase C
measured that they are not there. All five historical records are `alfred-thin`, established
four independent ways (see `tools/backfill-records.mjs` for the full argument):

- every transcript's first user turn is Alfred's own composed prompt
- `git log -- lib/run.mjs` shows a single-session spawn from its first commit (8f271f9), with
  no phase-orchestration code anywhere in its history — so no recorded run *could* have been
  produced by the multi-agent arm
- `"name":"Task"` appears zero times in all five transcripts
- the `scan`/`reason` seat disclosure (068c3ac, 2026-08-01T2014Z) accounts for the
  seats=0/seats=2 split as a prompt change WITHIN one arm

So the missing arms are missing for a structural reason, not a bookkeeping one:

- **`alfred-multi-agent`** — the code that would emit this arm no longer exists, and never
  wrote a record carrying provenance (the `provenance` field is A5, which postdates it). There
  is no artifact to backfill.
- **`single-agent`** — the jarvis#7 control ran, but has **no `record.json`**. It needs a
  different extraction path entirely: a bare ~1.5MB `.jsonl` with no result line and no
  `total_cost_usd`. That work is real and is not Phase D.

A live run tonight adds one more `alfred-thin`. `distinct` stays 1. The gate stays shut.

## What would be destroyed if the gate were ignored

`jarvis-issue7-alfred/` holds the only copy of the real `NotesPageHeader.test.tsx` diff that
motivated A3's `evidence_weakened` fix. The records contain **no diffs**. Delete that worktree
and the fixed gate can never be run against the tree that exposed the bug — leaving A3
validated only against hand-built fixtures, which is `feedback_mocked_seam_blindness` applied
to the fix for a false positive whose entire claim is about a real diff.

That is the specific harm E1 exists to prevent, and it is why this file records a skip rather
than a judgement call about disk pressure.

## To open Phase E later, in order

1. Extract a `single-agent` record for jarvis#7 through `recordForRun` (needs the bare-`.jsonl`
   path: no result line, so `total_cost_usd` must come from summing transcript usage, and the
   absence of a vendor figure must be recorded as a gap rather than as `0`).
2. Accept in writing that `alfred-multi-agent` is unrecoverable, and amend E1 to require 2
   distinct arms rather than 3 — or drop the arm-diversity requirement and state what the
   remaining shape check is actually for.
3. Only then run E2/E3/E4, and in E4 capture the diffs FIRST (`git worktree remove`, never
   `rm -rf` — the worktrees hold uncommitted work and unpushed commits, and `remove` refusing
   is the guard, not an obstacle).
