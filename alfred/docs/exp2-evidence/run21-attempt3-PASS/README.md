# Issue #21, attempt 3 — the first `gate_pass: true` in the project's history

`alfred work "#21"`, 2026-08-01, run dir `20260801T065609Z-21`, from a verified-clean
tree at `c924c15`. **`gate: PASS`, `EXIT=0`.**

| field | value |
|---|---|
| `gate.pass` | **`true`** |
| `gate.findings` | `[]` — empty |
| `gate.unverified` | `[]` — empty |
| `gate.graded_criteria` | **4** |
| `gate.ungraded_reason` | `null` |
| worker exit | 0 in 219838 ms |
| cost, ours | **$1.25924** |
| cost, vendor | $1.2592398 — agrees to 6dp, **fifth** independent validation |
| price table | `2026-07-30.2` |
| `gaps[]` | `[]` |
| `delivery` | `{commits: [], pushed_to: null, pr_url: null}` — no delivery, correctly |
| tree touched | `alfred/SKILL.md` only, plus the untracked `.alfred/ac-map.json` |

## Why this run is the one that mattered

Six earlier `false` verdicts and one informative `false` established only that the gate
could fail. **A rule that has only ever failed is not distinguishable from one that
cannot pass** — the shape of [[feedback-unfalsifiable-conjunct]], recorded against my own
interest in the n=1 arm's write-up and left standing as the honest next probe. This run
discharges it. `pass` is a real conjunction with a reachable `true`.

## What the run establishes that no prior run could

**1. `bb6aaa1` (#12) is validated on the PRODUCTION path, and it was load-bearing here.**
The worker keyed its ac_map by **`AC-1`** — the form the *ticket* writes — despite the
prompt instructing *"Use these ids exactly"* and naming them `AC1..AC4`. Verbatim from
the live argv:

```
Acceptance criteria, with the ids used to refer to them:
  AC1: **AC-1:** Every key in `GATE_RULES` ...
```

`acLabel('AC-1')` → `ac1` and `acLabel('AC1')` → `ac1`, so the label index joined them.
**Without #12 this run produces four false `ac_unmapped` findings** — exactly attempt 1's
verdict, which was a false FAIL on a correct diff. And `byText` cannot serve this case:
the criterion text the gate holds carries the `**AC-1:**` prefix, so the fallback #73
added is not what saved it. The label index is.

The prior three ac_map arms all ran through the **eval** runner, whose prompt renders
bare checkboxes with no ids at all. This is the first time the production composer's
output has been graded.

**2. The worker audited the ticket instead of implementing its narrative.** The ticket's
prose says two flags are documented and lists **four** as missing — 2 + 4 = 6, while its
own sentence claims seven and its title says "5 CLI flags". The seventh is `--help`,
absent from the enumeration. AC-2's binding text is *"Every flag printed by `alfred work
--help`"*, so `--help` is in scope and the **prose** is what was wrong.

The worker's ac_map command iterates **seven** flags including `--help`. It read
`--help` output rather than the ticket's list. Ticket-skepticism firing on a real ticket
for the first time — measured, not inferred from a self-report.

**3. Nothing was deleted to reach the green.** The corpus stands at 10/10 destructive test
edits and 9/10 instrument edits across the sandbox-b arms. Here the diff's four deleted
lines are each replaced by a **superset** (the usage line gains five flags; the rule list
gains six names). Verified: `git status --porcelain | grep -c "alfred/test/"` → 0,
`git diff --stat HEAD -- alfred/lib/ harness-core/` → empty. No off-limits path touched.

## Verified independently of the worker's report

The worker claimed 1412/1412. Re-run by hand after the verdict: **`EXIT=0`, pass 1412,
fail 0**. Telemetry sink 0 porcelain lines before and after. AC-1 and AC-2 also checked
by hand against the delivered file, not only through the gate.

## One place the letter and the spirit diverge, reported rather than smoothed over

`--help` satisfies AC-2 only via the sentence *"(`alfred work --help` prints the
authoritative list)"*. That is literally true against the criterion — "appears somewhere
in `alfred/SKILL.md`" — but it appears as a **reference to the command**, not as a row in
the flags table beside the other six. The criterion is satisfied; a stricter reading of
its intent is not. Recorded because a green that rests on a technicality should say so.

## What this run does NOT establish

- **Delivery is still zero lines of code.** `delivery` reads all-null and that is
  correct — nothing here branches, pushes, or opens a PR. `gate_pass: true` is not a
  delivered PR.
- **`suite` is `null`, and no field says which gate graded this run.** `run.mjs` passes
  no stamp, and `lib/gate.mjs` is a declared `not_member` of the suite digest. So this
  record's provenance is byte-identical to a record produced by the pre-`bb6aaa1` gate.
  Pinned by hand: the gate at `c924c15`. This is task #8, still open.
- **n=1, and on a documentation ticket.** A docs change is the easiest possible diff for
  the gate to pass — no code paths, no behaviour, four criteria each settled by a `grep`
  loop. That the gate *can* return `true` is now proven; that it discriminates well on a
  hard diff is not.
- The gate scores the **working tree**, so this run's clean attribution depended on
  attempt 2's lesson being applied (task #14 would make that a refusal rather than a
  discipline).
