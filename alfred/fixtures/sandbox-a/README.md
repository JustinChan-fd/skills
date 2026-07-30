# `sandbox-a` — the ambiguous ticket

A synthetic notification service plus a ticket (`SBX-1`) whose central decision is
never stated. Used by Experiment 2 to ask whether phase separation pays on a
ticket shape where a single context might plausibly rush the decision.

`manifest.json` is the single source of truth. This README explains what the
fixture can and cannot distinguish. For the design rationale, see
`../../docs/SANDBOX.md`; for the experiment itself, `../../docs/EXPERIMENT-2.md`.

---

## What it is

`files/` holds a 14-file zero-dependency ESM service — three notification
channels, a formatter, guards, a vendored transport shim, a hand-written linter,
and 21 tests. `lib/fixture.mjs provision` builds it into a temp git repo.

Ground truth, **measured** (not asserted) on a fresh provision:

| | |
|---|---|
| files total | 14 |
| `.js`/`.mjs` anywhere | 12 |
| `.js` under `src/` | 8 |
| `node tools/lint.mjs` | 7 errors, 2 warnings, exit 1 |
| `node --test` | 3 files, 21 tests, 21 pass, exit 0 |

Every number above is re-measured on each run by
`alfred/test/sandbox-a-ground-truth.test.mjs`. Editing a fixture source file
without updating the manifest fails that suite. This is deliberate: the failure
mode this whole fixture exists to catch is a confidently-stated number nobody
checked.

---

## What it distinguishes

Six traps, each declared in `manifest.json` **before either arm ran**, and each
copying the *shape* of a trap observed in a real ticket (`TARS-1339`, `TARS-1272`)
rather than being invented:

1. **The unstated either/or** — the ticket names two structurally different
   designs and picks neither. Both are defensible; they differ in structure, so
   choosing wrong is rework. The channels differ for stated reasons (sms cannot
   back off, push must not retry), so a shared helper has to be parameterized far
   enough that it converges on the config-object option. Scored on whether the arm
   surfaced the decision and chose with a reason — not on which it chose.
2. **Wrong file count** — "12 source files across `src/`" against 8. 12 is the
   whole-repo count, so the number is right for a scope the sentence doesn't
   describe. Silence earns no credit.
3. **False premise stated as fact** — `src/legacy/mergeFields.js` is called
   "unused"; `src/format.js` imports it at line 3. Deleting it breaks all 3 test
   files.
4. **Looks-stale-but-load-bearing** — of "the two stale guard comments," guard A
   is genuinely dead and guard B is covered by tests.
5. **Unverifiable AC** — "no behavior changes," with no command that proves it,
   over exactly the paths the suite covers.
6. **Unsatisfiable AC** — "0 errors and 0 warnings," where all 7 errors are
   fixable but both warnings sit in `src/vendor/`, which the ticket declares off
   limits. Compounded: the ticket also claims lint is clean on main. It isn't, so
   the trap is only reachable by an arm that verified the premise.

Traps 3 and 4 are verified **by command, not by reading**:

- delete guard B → 2 test files fail
- delete guard A → 21/21 still pass
- delete `mergeFields.js` → 3 test files fail to load

The guard-A direction is the one that matters. Without it the trap would only
reward touching nothing; with it, the trap discriminates between an arm that ran
the tests and one that guessed.

---

## What it cannot tell us

- **Trap 6 has no defined correct outcome yet.** Task #20 — the policy for an
  unsatisfiable blocking AC — is undecided. Until it is, an arm can be scored on
  whether it *reported* the conflict, but not on whether it did the right thing
  about it. Don't read a trap-6 score as a verdict on behavior.
- **The cost half is weak here.** The 4.6x cost ratio measured on `TARS-1339`
  turned on `cache_read` across a large context (95.6% of the cheap arm's
  tokens). A 14-file repo may not reproduce that effect at all. Report the cost
  numbers, but do not let a small-repo ratio stand in for the measured 4.6x.
- **I planted the traps.** Both arms are graded against one model of what's hard.
  A failure mode not thought of is invisible here, and a real repo's hard parts
  (200-file diffs, a build system with opinions, legacy weirdness) are absent by
  construction.
- **Synthetic code is cleaner than real code.** An arm that looks competent here
  can still drown in `webtarsthree`.
- **Still n=1 per shape.** `sandbox-b` (should-be-pushed-back-on) and `sandbox-c`
  (multi-file feature) don't exist yet, and three shapes wouldn't be a
  distribution either.
- **It says nothing about whether the ticket is realistic.** The traps are real
  shapes, but their *density* — six in one small ticket — is not. A pipeline that
  handles this may still be tuned for a trap rate that doesn't occur.

---

## Working on the fixture

Test files under `files/test/` are stored with a trailing **`.src`** and stripped
on provision. This is load-bearing, not cosmetic: `node --test` sweeps any
`.js`/`.mjs`/`.cjs` inside a directory named `test` at any depth, and a nested
`package.json` does not stop it. Stored as `channels.test.js`, the fixture's tests
would run inside this repo's own `npm test` — so trap 4 would fail *this* repo
instead of the provisioned one. `alfred/test/fixture-layout.test.mjs` walks
`fixtures/` and fails on any file that would leak. Measured discovery rules are
tabulated in `../../docs/SANDBOX.md` §3.

Two rules earned the hard way while building this:

- **Measure, don't recall.** `file_count_src_only` was first written as 7 from
  memory; `find src -name '*.js' | wc -l` said 8. That is trap 2's own failure
  mode, committed by its author.
- **Tune the fixture, never the gate.** When ground truth came out wrong for the
  experiment's purpose (13 errors / 3 warnings, several inside off-limits files,
  which would have made "0 errors" unsatisfiable too and collapsed trap 6 into
  trap 5), the fix belonged in `files/`. Editing `tools/lint.mjs` to produce a
  nicer number would have made the gate a description of the fixture instead of a
  check on it.
