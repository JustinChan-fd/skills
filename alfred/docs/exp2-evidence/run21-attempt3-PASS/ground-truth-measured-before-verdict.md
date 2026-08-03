# Issue #21 ground truth, measured 2026-08-01 BEFORE the verdict arrived

Measured from the tree the worker was spawned against, so the verdict can be read
against numbers rather than against recollection. Recorded before the run finished
deliberately: an audit written after seeing the worker's report is an audit of the
report.

## AC-1 — GATE_RULES has 11 keys

`LC_ALL=C grep -a -n -A20 "GATE_RULES" alfred/lib/gate.mjs`:

```
check_failed  ac_unmapped  ac_failed  ac_unsatisfiable  unverifiable_no_reason
mapping_implausible  unbacked_claim  scope_violation  off_limits
evidence_weakened  instrument_modified
```

SKILL.md's findings section names five. **The ticket's "six undocumented" is exact.**
Note `grep -a` is required — `gate.mjs` no longer carries a NUL (removed in `3bf6363`)
but `alfred/test/gate.test.mjs` still does, deliberately, as a composite-key separator.

## AC-2 — `alfred work --help` prints SEVEN flags, and the ticket's prose under-counts

```
--dry-run  --help  --max-turns  --repo  --run-root  --wall-cap-minutes  --worker-bin
```

The ticket says two are documented (`--repo`, `--dry-run`) and lists **four** as missing
(`--run-root`, `--max-turns`, `--wall-cap-minutes`, `--worker-bin`). 2 + 4 = **6**, not
the 7 its own sentence claims. The seventh is **`--help`**, absent from the enumeration.
The issue title says "5 CLI flags", which matches neither 4 nor 5-of-7.

**AC-2's binding text is "Every flag printed by `alfred work --help`"** — so `--help`
is in scope and the prose is what is wrong, not the criterion. A worker that documents
only the four named flags satisfies the ticket's *narrative* and FAILS its *criterion*.

This is the ticket-skepticism signal on this run: the criterion and the prose that
motivates it disagree, and only one of them is what the gate re-runs.

## AC-3 — record.json is real and lands beside source.json

`5f5aedb` (#10). Run dir is `dirname(resolve(repoRoot))/.alfred-runs/<stamp>-<ref>`,
i.e. `Desktop/Repos/.alfred-runs/` — outside the repo on purpose, so a `source.json`
under the repo root is not scored as delivered work.

## AC-4 — npm test

1412/1412 at HEAD `c924c15` before the spawn. The worker is running this itself; the
production telemetry sink was verified clean (0 porcelain lines) mid-run.

## What this run tests that no prior run did

The three ac_map arms all ran through the **eval** runner, whose prompt renders bare
markdown checkboxes with no ids — which is why `byText` existed. The production
composer does render them; measured verbatim from the live argv:

```
Acceptance criteria, with the ids used to refer to them:
  AC1: **AC-1:** Every key in `GATE_RULES` ...
  AC2: ...  AC3: ...  AC4: ...
Use these ids exactly when you write `.alfred/ac-map.json`.
```

So: the ticket writes `AC-1`, the prompt names `AC1`, and the criterion text carries
the `**AC-1:**` prefix inside it. This exercises **`bb6aaa1`'s label normalization on
the production path** — the case `byText` cannot serve, because the text the worker
would copy (`**AC-1:** Every key...`) is the text the gate holds too, prefix included.
