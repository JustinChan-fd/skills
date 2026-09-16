# Changelog

All notable changes to this skill are recorded here. Versions follow the
bump policy in `SKILL.md`'s "Versioning" section (patch/minor/major).

## 1.2.0

- Added automatic **`repo:<slug>` labeling** (Step 2 detection, Step 11
  write): the current working directory's git remote is resolved to a repo
  slug and, when it's in the target project's `repos` array
  (`configs/_projects.json`), `repo:<slug>` is added to the created ticket
  automatically — no extra prompt for the common case. This is the same
  label research-loop's/dev-loop's `jira.repoLabel` config field polls for
  (see those repos' `docs/config.md`), needed because more than one target
  repo can share a single Jira project (MC: `catalog-ui-management` +
  `catalog-ui-public` both file there — cwd's slug is what disambiguates
  which one automatically).
- Added a **repo/project mismatch guard** to Step 7's `AskUserQuestion`
  batch: if cwd's detected slug is a real repo but isn't in the target
  project's `repos` array (including a project with no `repos` array yet),
  the user is asked to confirm rather than the skill silently guessing —
  covers "I'm in `catalog-ui-management` but asked for a TARS ticket."
  Confirming for a new project/repo pairing self-heals `_projects.json`'s
  `repos` array, same convention as `aliases`.
- This skill still never adds a pipeline stage label
  (`pipeline:research`/`pipeline:dev`) — `repo:*` only identifies which
  repo a ticket belongs to; entering the pipeline stays a separate,
  deliberate decision.
- `configs/_projects.json`: added `repos` arrays for `TARS`
  (`["webtarsthree"]`) and `MC`
  (`["catalog-ui-management", "catalog-ui-public"]`).

## 1.1.0

- Added **Tech Story** routing (Step 1) and a `templates/TechStory.md`
  template, for a code change that deploys to PRD but has no user-facing
  behavior change and isn't a bug fix — previously fell through to Story
  with no matching content template.
- Added a **Sonnet/Haiku model split**: this skill's own session stays on
  Sonnet for judgment calls (routing, field lookup, parent inference, the
  `AskUserQuestion` batch); Step 8 (turning already-decided facts into the
  template's exact prose/ADF shape) is now delegated to a separate `Agent`
  call pinned to `model: "haiku"`.
- Added a **named-surface guardrail**: `templates/Bug.md`, `Story.md`, and
  `TechStory.md` now require Overview to name at least one concrete file,
  page, endpoint, or component, even when Evidence is omitted; Step 7's
  `AskUserQuestion` batch asks for one directly if nothing surfaced. This
  keeps a created ticket from landing in `research-loop`'s `ticket-refine`
  with nothing for its zero-signal bounce gate to grab onto.
- Added **current-vs-desired framing** to Overview's guidance in
  `Bug.md`/`Story.md`/`TechStory.md`, to directly feed `ticket-refine`'s
  currency check (its first, cheapest grounding step).
- Added a **`### References`** section to every issue-type template
  (Bug/Story/Task/TechStory/InternalPackageSoftware) — links to API docs,
  Confluence pages, third-party vendor docs, or related ticket keys that
  aren't already covered by a formal Jira link. Supersedes MC's earlier
  one-off `customReferencesSection` config note, which is now the default
  everywhere rather than MC-specific.
- Added a **version-tracking label** step (new Step 11, before Output):
  every created ticket now gets a `jira-ticket-create:<VERSION>` label
  (read from this skill's `VERSION` file), so a ticket's originating
  skill/template version is visible on the ticket itself.
- Introduced this skill's own `VERSION` file and semantic-versioning policy.

## 1.0.0

Baseline — not itself versioned at the time, reconstructed here as the
starting point once versioning was introduced in 1.1.0. Covers the skill
as it existed through the TARS Story config learn
(`516f965`): free-text parsing, project-key resolution cache
(`configs/_projects.json`), self-healing per-project field configs
(`configs/<PROJECT_KEY>.json`), per-issue-type content templates
(`templates/Bug.md`, `Story.md`, `Task.md`), and Jira issue/link creation.
