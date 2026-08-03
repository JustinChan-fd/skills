# 2026-08 verdict archive

Evidence rescued out of `/tmp` on 2026-08-02, before the MVP rebuild.

Every file here was previously reachable only from `/tmp`, which does not survive a
reboot. The rebuild plan reads three of them during its backfill phase, so they were
copied into the repo *first* — the earlier draft of that plan scheduled the `/tmp`
cleanup before the phase that consumes them.

Nothing in this directory is Alfred runtime. It sits under `eval/` deliberately:
`eval/` is experiment scaffolding and is permitted to reference `harness-*`, while
`lib/` is not (see `test/isolation.test.mjs`).

| File | Origin | Consumed by |
|---|---|---|
| `qa-log.md` | `/tmp/alfred-verdict/qa-log.md` | `docs/RETROSPECTIVE.md` — the Alfred-vs-single-agent verdict, both experiments |
| `extract-metrics.mjs` | `/tmp/extract-metrics.mjs` | ad-hoc metric extraction during the experiments; kept as provenance for the recorded figures, not as a supported tool |
| `tars1351-single-agent-worker.log` | `/private/tmp/simple-agent-experiment/worker.log` | backfill of the TARS-1351 **single-agent** arm |

## Why the repo `.gitignore` carries a negation for this directory

The first `git add` here staged three of the four files. `*.log` (`.gitignore:9`, "Hook
runtime artifacts") silently swallowed the 344KB transcript — the copy out of `/tmp`
reported success, `git add` reported nothing, and the only real copy was still in the
directory this rescue exists to escape. A rescue that reports success while losing its
largest file is worse than no rescue.

Hence `!alfred/eval/archive/**/*.log`. Archived transcripts are append-only evidence, not
runtime output, and the two categories happened to share a suffix.

## Caveat on the figures in `qa-log.md`

The TARS-1351 Alfred cost figure is **contaminated** and must not be read as an
architecture result. Per `lib/router.mjs`, `--max-budget-usd` was removed on 2026-08-02
because it froze cache breakpoints, and on that run the flag is the likely majority cause
of $6.10 of $7.49 landing as uncached input. The thin runner does not pass the flag, so the
largest term in any before/after delta is a removed CLI flag.
