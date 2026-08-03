---
name: alfred
description: >-
  Run one work item to a deterministic verdict via Alfred, the standalone
  agentic harness. Use when the user says "alfred", "run alfred", "alfred
  work <ref>", or names a work item and asks for Alfred specifically ("have
  alfred do jarvis#4", "alfred this ticket"). Takes a jira key or browse URL
  (TARS-1353, https://site.atlassian.net/browse/TARS-1353), a GitHub issue
  reference (acme/jarvis#4, #4, an issue URL), or — under a github config
  only — a quoted sentence, which becomes a prompt-sourced item with no
  acceptance criteria and none invented. Alfred
  is a Node CLI: this skill's whole job is to run it and read what it says.
  Do NOT use for general implementation work — that is ordinary work, and
  wrapping it in Alfred adds a spawn and a gate for nothing.
---

# alfred

**Alfred is a program. You are not the harness — you invoke it.**

That sentence is the entire design. The predecessor this replaces asked a model
to *be* an unattended loop across a ~3,000-word skill file. Measured against a
single-context run on the same ticket, the orchestrated version cost **4.7x the
tokens, 4.6x the dollars, 6.8x the wall clock, and did not ship a PR.** The
cause was not bad prompting: one context reuses its prefix (cache_read was 95.6%
of the cheap arm's tokens) and each phase pays to rebuild its own.

So there is nothing here for you to simulate. The lock is a file, the poll is a
loop, the verdict is a checklist of shell commands, and all three already exist
in `lib/`. Paying model tokens to re-derive them is the mistake this whole
project is correcting.

## What to run

```
alfred/bin/alfred work <ref> [--repo <path>] [--run-root <path>] [--max-turns <n>]
                              [--wall-cap-minutes <n>] [--worker-bin <path>] [--dry-run]
                              [--allow-dirty]
```

From this repo that is `./alfred/bin/alfred`; installed as a skill it is
`~/.claude/skills/alfred/bin/alfred`. It needs `node` (v22+) and, for a real
run, `claude` on PATH. Zero dependencies otherwise.

`<ref>` is one argument, and **which refs are legal depends on the repo's
`source.kind`** — not on the shape you happen to type.

| `source.kind` | legal refs | fetched by |
|---|---|---|
| `github` | `acme/jarvis#4`, `#4`, an issue URL | `gh` |
| `jira` | `TARS-1353`, or a browse URL `https://<site>.atlassian.net/browse/TARS-1353` | the Atlassian MCP, via a `claude -p` spawn |

Under either kind, acceptance criteria are extracted by **one shared parser**
from a heading that says *acceptance criteria*. There is deliberately no
jira-specific reader: two parsers of the same tickets would grade github and
jira work by different rules.

**A ref of the wrong shape for the configured kind is refused (exit 2), not
reinterpreted.** A jira key under a jira config used to fall through to the
prompt path and return `ok: true` with zero criteria — a run that spends and
cannot be graded, since the gate's verdict is a conjunction over findings and no
criteria means nothing objected. Under a `jira` config there is no prompt path.

Two refusals worth knowing, because both look like pedantry until you hit them:

- **The ref must be the ticket alone.** `TARS-1353 but only the docs part` and
  `<url> but only the docs part` are both refused. Accepting them would resolve
  to the bare key and work the **entire** ticket while you asked for one slice —
  a scope expansion that looks like obedience, on a run nobody is watching. A
  narrower ask is not expressible as a ref; put it in the ticket.
- **A browse URL from another Atlassian site is refused** before any fetch. The
  configured host is derived from the epic URLs in `.alfred/config.json`, and the
  same key can exist on someone else's tenant.

Under a `github` config, anything that is not an issue reference is a
prompt-sourced item: it gets **no acceptance criteria, and none are invented**,
because the gate raises `ac_unmapped` once per criterion and a fabricated
criterion is a bar nobody set.

**Alfred never creates or switches a branch.** It works whatever is checked out,
in place, and the gate scores that tree — so check out the branch you want the
work on *before* invoking. It also refuses a dirty tree (exit 2) unless
`--allow-dirty`, because nothing on the observe→gate path asks *when* a change
arrived: a pre-existing edit is scored as the worker's, in both directions.

Flags (`alfred work --help` prints the authoritative list):

| flag | meaning |
|---|---|
| `--repo <path>` | repository to work in (default: cwd) |
| `--run-root <path>` | where run artifacts go (default: a sibling of the repo, never inside it — the gate scores the working tree) |
| `--max-turns <n>` | hand `--max-turns` to the worker |
| `--wall-cap-minutes <n>` | kill the worker after n minutes (default: 25) — this is the cap referred to below when a worker is killed mid-run |
| `--worker-bin <path>` | the binary to spawn (default: `claude`) |
| `--dry-run` | compose everything, spawn nothing, print the argv |
| `--allow-dirty` | grade a tree that already has uncommitted changes (refused by default) |

`--dry-run` composes the prompt and the argv, fetches and persists the ticket,
spawns nothing, and prints what it would have run. Use it when you want to check
the flags or the prompt without spending.

## A dirty tree is refused, and that is exit 2

Alfred **will not spawn against a working tree that already has uncommitted
changes.** The gate scores the diff against `HEAD` and nothing on that path asks
*when* a change arrived, so anything already in the tree is attributed to the
worker — which fails in both directions. A stale edit to a test file raises
`evidence_weakened` against a worker that never opened it, and a stale edit that
happens to satisfy a criterion is graded as delivered. The verdict is not worth
paying for either way, so the refusal lands **before the spawn**: exit 2, nothing
spent.

The refusal **names the dirty paths** and it **cleans nothing** — no stash, no
revert, no checkout. Commit them, move them, or pass `--allow-dirty` if the dirt
is deliberate (a run resumed by hand, a staged fixture). Untracked files count;
gitignored files do not, because those are exactly the ones the gate cannot see
either.

## Read the exit code, and do not collapse 1 and 2

| code | meaning | what to do |
|---|---|---|
| 0 | the gate passed | report it, with the run dir |
| 1 | a worker ran, spent money, and the gate found something | report the findings verbatim |
| 2 | **refused before spending anything** — bad input or bad config | fix the invocation; do not retry as-is |

The distinction is load-bearing and it is why the codes are three and not two. A
scheduler that reads a misconfiguration as a failed run retries it forever at
full price; one that reads a failed run as a misconfiguration stops retrying
work that failed honestly.

## Requirements

A `.alfred/config.json` in the target repo. Alfred **refuses** without one and
invents nothing — not the base branch, not the verify commands, not the
off-limits paths. That refusal is a bug fix: the ticket that motivated it had
base `feat/migrate-native-fetch-from-axios`, and a run that guessed `master`
would have opened a PR against the wrong tree at 3am with nobody watching.

## Your job around the invocation

**Before:** confirm the repo and the ref, and that a config exists. If the user
named a ticket without a repo, ask rather than guessing which one — `--repo`
defaults to **cwd**, silently, so an invocation from the wrong directory grades a
tree nobody meant to touch.

**Confirm to spend once, not once per tick.** A real invocation (no `--dry-run`)
spends money the moment it spawns, so ask before the *first* one. If the user
is running Alfred across several ticks — several tickets in sequence, or
repeated ticks toward one — do not ask again on tick two through n. A second
confirmation is not extra safety once the user has already said to proceed; it
is the thing that makes leaving a loop running unattended in the background
impossible. Get the one ask up front, then let the rest of the ticks run
without stopping for it.

Then run this pre-flight. It is short, it is all deterministic, and every item on
it is a refusal Alfred would otherwise hand back *after* the operator waited:

1. **`--dry-run` first.** It fetches and persists the ticket, spawns nothing, and
   prints the argv. Confirm the item resolved with criteria and
   `ac_problem: null` — a ticket whose criteria did not parse is a run the gate
   cannot grade, and that is cheaper to learn now.
2. **Confirm `--strict-mcp-config` is in the printed argv.** Without it the
   worker inherits the operator's MCP servers and, under `bypassPermissions`,
   holds **write** access to the very ticket it is graded against. The gate cannot
   see that: it scores the working-tree diff, and a Jira edit leaves no diff.
3. **Check the tree is clean the way Alfred checks it**, not with `git status` —
   the two disagree on ignored files by design:
   `node -e "import('./lib/run.mjs').then(async m => console.log(await m.treeIsDirty({repoRoot:'<repo>'})))"`.
   Expect `[]`. A stray temp file is enough to exit 2.
4. **Check the branch.** Alfred works what is checked out; it creates nothing.
5. **Check the telemetry sink has nothing staged**, and that the seat env is set
   by Alfred rather than inherited — this shell has `ANTHROPIC_DEFAULT_*` set
   ambiently, and an inherited seat is untestable and silently wrong.

Do **not** paste any of that back to the user as a checklist to run themselves.
It is your job, and the point of a program is that the operator types the ticket.

**After:** relay the verdict as it came out. Specifically:

- Report the findings **verbatim**, by rule name. `check_failed`,
  `scope_violation`, `ac_unmapped`, `ac_failed`, `ac_unsatisfiable`,
  `unverifiable_no_reason`, `mapping_implausible`, `unbacked_claim`,
  `off_limits`, `evidence_weakened` and `instrument_modified` mean different
  things and the operator acts on which one fired.
- Report `unverified` entries too. They do **not** fail the run — the gate's
  verdict is a conjunction over findings only — but a criterion nobody could
  check is exactly what a human most needs to see. Swallowing it is how
  "verified" comes to mean "nothing objected".
- Never restate a `FAIL` as a qualified success, and never call a run verified
  because the worker's own summary said so. The gate runs the commands itself,
  in a separate process, on the tree the worker left. That separation is the
  whole reason it cannot be argued out of a verdict — do not argue it out on the
  gate's behalf.
- If the worker was **killed at the wall cap**, say so. A killed run is not a
  graded run: `check_failed` is added for it precisely because from the tree's
  side, a worker stopped mid-sentence looks like one that chose to stop.

**Do not** re-run the work yourself when the gate fails. A failing gate is
information. Fix the ticket, the config, or the code — deliberately, with the
user — rather than trying again and hoping.

## What is not built yet

`alfred loop` **refuses** rather than exiting 0. It needs the lock file and the
source poll of `docs/PLAN.md` §2.2. Exiting 0 would be worse than refusing: once
cron is pointed at it, a silent success is a loop that appears to be patrolling
and is doing nothing at all.

Delivery is also absent — nothing here creates a branch, pushes, or opens a PR.
A run works the tree in place and is graded there. **Ask before anything
outward-facing**, and note that Alfred's own config carries
`delivery.never_merge`.

## Where things are

| | |
|---|---|
| design | `alfred/docs/PLAN.md` |
| the measurements behind it | `alfred/docs/HANDOFF.md` |
| the gate's checklist | `PLAN.md` §5, `lib/gate.mjs` |
| run artifacts | printed as `run dir:` — outside the repo, deliberately |
| the audit record | `record.json`, written beside `source.json` in the run dir — cost by model, the suite stamp, the gate's full findings (including complete command output), and `gaps[]` |

The run directory is **outside** the repository on purpose: the gate scores the
working-tree diff, so a `source.json` written under the repo root would be
counted as delivered work and raise `scope_violation` on a run that did nothing
wrong.
