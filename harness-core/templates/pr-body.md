# Implement PR body

Render with `CLI render-pr-body`; never hand-assemble. The reviewer-facing
shape is the one specified by `push-branch/SKILL.md` "Format Requirements", so a
harness PR is indistinguishable from a hand-pushed one:

    Closes #<ID>.

    <driver-authored prose summary>

    ## Changes

    - <bullet>
    - <bullet>

    ## QA Notes

    Manual testing steps:

    1. <step>
    2. **Expected:** <observable outcome>

    <details>
    <summary>Harness verification detail</summary>

    **Entry-contract results**

    | Criterion | Tag | Result | Evidence |
    | --- | --- | --- | --- |
    | <criterion> | blocking | pass | <evidence> |

    **Landing checklist**

    - [ ] <post-merge item>

    **Advisory residue**

    - **<criterion>** — <detail verbatim>

    </details>

    Run: `<run-id>`

    🤖 Generated with [Claude Code](https://claude.com/claude-code)

## What the driver supplies vs. what the renderer assembles

`render.mjs` carries no judgment. Every prose field arrives as an argument:

| Section | Argument | Notes |
| --- | --- | --- |
| `Closes #<ID>.` | `--issue` | Omitted entirely when there is no issue |
| summary | `--summary` | Driver prose |
| `## Changes` | `--changes` | JSON array of strings; renderer adds `- ` |
| `## QA Notes` | `--qa-notes` | JSON array of strings; renderer adds `1. ` |
| entry-contract table | `--result-rows` | JSON array of `{criterion, tag, result, evidence}` |
| landing checklist | `--landing` | JSON array of strings |
| advisory residue | `--notes` | THIS run's own residue/defect notes, verbatim |
| `Run: <id>` | `--run-id` | Always present |

## Rules

**`## Changes` — 3–8 bullets, one flat list.** No sub-headings, no nesting, no
"Files Changed" or "Migration Notes" inventory. Each bullet names the file or
surface and states the change. Real paths and real URLs
(`/configuration/rating-classifications`), never page names.

**`## QA Notes` — numbered manual steps a human reviewer can follow.** One step
per array entry; interleave `**Expected:** ...` entries after the actions they
verify. Every command must be runnable as written from a fresh checkout. These
are manual verification steps, **not** a restatement of the entry contract —
that already has its own table below.

**The heading text `## QA Notes` is load-bearing.** The Jira cleanup step parses
that exact heading back out of the PR body to build the ADF for
`customfield_14226`. Renaming it silently breaks the ticket write-back.

**Empty sections are omitted, never emitted empty.** `## Changes`,
`## QA Notes`, and each of the three detail blocks appear only when their input
is non-empty. An empty `--changes` on a run that changed files is a bug in the
driver's call, not a valid render.

**The verification detail is folded, not dropped.** `push-branch` bans competing
top-level sections in the body, but the harness carries evidence a human pusher
does not. The entry-contract table, landing checklist, and advisory residue go
inside exactly ONE collapsed `<details>` block below `## QA Notes` — audit trail
preserved, review surface uncluttered. The whole block is omitted when all three
inputs are empty.

**`Closes #<ID>` behaves differently by source, and both are correct.** For
github, `Closes #2` auto-closes the issue when a human merges (never on open, so
the never-merge invariant holds). For jira, `Closes #TARS-1271` is not a valid
numeric ref, so GitHub ignores it and it degrades to a plain reference; the Jira
issue is transitioned separately.
