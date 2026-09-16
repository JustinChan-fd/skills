---
name: jira-create-ticket
description: Create a Jira ticket from a free-text prompt, optionally linked to another ticket (e.g. "blocks TARS-1381"), using self-healing per-project field configs and per-issue-type content templates
---

# /jira-create-ticket

Create a Jira ticket whose plumbing (required fields, parent constraints) is looked up
and cached per project+issue type, and whose content (Overview / Evidence / Steps to
Reproduce / Acceptance Criteria) is written by Claude from a fixed template so every
ticket in a project reads the same way.

## Philosophy

A ticket produced by this skill is the **baseline a human or agent picks up cold** —
not a dump of every fact gathered during investigation. Write only what's known.
Every section should make someone want to read it: concise, concrete, actionable.

- Never pad a section just to fill space. If there's no evidence, omit the Evidence
  section entirely rather than writing filler.
- **Open questions are not Acceptance Criteria.** "Confirm with @X whether Y" is not
  testable by a QA reader — it belongs in Overview as a caveat, or as its own
  follow-up ticket. Every AC bullet must be a condition someone can check off with
  no additional context.
- Steps to Reproduce should include real URLs/paths/queries wherever they exist, so
  someone can copy-paste and go instead of guessing at navigation.
- Do the research before writing the ticket, but don't transcribe the research into
  the ticket. Summarize; link to the source (e.g. the ticket that motivated this one).

## When to Use

When the user asks to create a Jira ticket from a description, investigation, or as a
follow-up/blocker to an existing ticket — e.g. "create a CR bug that blocks TARS-1381
for the tsquery crash" or "file a story in TARS for the publication search hardening."

## Arguments

`$ARGUMENTS` — free text describing the ticket: target project (key or name), issue
type (defaults to Bug if unclear), and any link relationship to another ticket
("blocks X", "follow-up to X", "relates to X").

## Model policy

This skill's own session (Steps 1–7: project/type/link resolution, field-config
lookup, parent inference, the `AskUserQuestion` batch) should run on **Sonnet** —
those steps are judgment calls (routing decisions, ambiguity detection, matching a
sibling ticket's domain), not deep multi-hop reasoning, so they don't need Opus,
but they're too consequential (a wrong project/issue-type/parent silently
mis-files the ticket) to hand to Haiku either.

Step 8 (turning the facts Steps 1–7 already settled into the template's exact
prose/ADF shape) is a fixed-tier `Agent` call pinned to `model: "haiku"` — see
that step for the full delegation contract. That split — Sonnet for the calls
that decide something, Haiku for the call that only transcribes what was already
decided — keeps the expensive tier off the one step in this skill that's pure
mechanical formatting.

## Versioning

This skill is semantically versioned. `VERSION` (in this skill directory) holds
the current version as a bare `MAJOR.MINOR.PATCH` string, no leading `v`, no
trailing newline content beyond the version itself. Step 11 stamps every created
ticket with a `jira-ticket-create:<VERSION>` label read from this file, so a
ticket's originating skill/template version is always visible on the ticket
itself — see that step for the mechanics.

Bump rule of thumb (bumped by hand when editing this skill, not automatically,
and recorded in `CHANGELOG.md` in the same edit):

- **Patch** (`x.y.Z`) — wording/doc-only tweaks that don't change what a ticket
  looks like or how routing decisions are made (a clarified comment, a typo
  fix, a reworded guardrail with the same effect).
- **Minor** (`x.Y.0`) — a new capability that's purely additive: a new
  issue-type template, a new template section, a new routing rule, a new
  `AskUserQuestion` case, a new config-learning pattern. Existing tickets'
  structure isn't invalidated by it.
- **Major** (`X.0.0`) — a change that makes a ticket created under the new
  version structurally inconsistent with one created under the old version in
  a way that matters downstream — removing or renaming a required section,
  changing what a section means, changing the model tier in a way that
  changes output quality/shape, or any change `ticket-refine`'s
  definition-of-ready checklist would treat differently depending on which
  version wrote the ticket.

When in doubt between two levels, pick the higher one — the label's whole point
is letting someone later distinguish "which version wrote this," and
under-bumping defeats that.

## Workflow

### Step 1: Parse intent

Extract from the prompt:
- **Project** — a key-shaped token ("CR", "TARS"), a project name, or a description
  ("the critics project", "webtarsthree"). Resolve the key in Step 2 — don't assume a
  bare uppercase word is already a valid key without checking.
- **Issue type** — explicit ("bug", "story", "task", "ISP"/"internal package") or
  inferred from context. Work through these in order — the first rule that
  applies wins:
  1. **Not a code change at all** (docs, Jira/Confluence housekeeping, a manual
     config toggle in a vendor UI, renaming a ticket, etc.) → **Task**. Task is
     reserved for non-code changes; if a diff/PR is involved, it's not a Task.
  2. **A code change that is a test file only** (a new/updated `*.test.*`, a
     spec file, a QA automation script) → **Story**, even though it never runs
     as deployed PRD application code on its own. Test coverage is still
     product work, not package inventory — don't route it to ISP just because
     it "isn't seen on PRD."
  3. **A code change that is never seen running on PRD as deployed application
     code, and is not itself the build/CI orchestration** → **Internal Package
     Software** ("ISP"). This covers artifacts that define *what* gets baked
     into a build — a Dockerfile's base image or pinned package/dependency
     versions, an internal library version bump, a build-tooling recipe/config
     consumed by another app's build. It does **not** cover the pipeline
     definition itself (`.github/workflows/*.yml`, `Jenkinsfile`, CI script
     orchestration) — editing *how the build runs* is process tooling, not
     package inventory; treat that as a Task (or Bug/Story if it's fixing a
     defect or adding a pipeline capability).
     ISP is an inventory/tracking record, not a unit of work: the ticket's job
     is to document what the package is, why it changed, and where it's
     consumed. Signal phrases: "track this package," "document the base
     image/dependency change," "internal package."
     Example: TARS-1434 tracks a Docker base-image migration (bullseye →
     bookworm) plus apt package-version pins and a jq mirror URL in
     `Dockerfile`/`Dockerfile-CI` — those files define what's baked into the
     image, never run as deployed application code themselves, and the change
     didn't touch the `.github/workflows/*.yml` pipeline definition. ISP.
     Contrast: a PR that only edits `.github/workflows/webtarsthree-build-deploy.yml`
     (e.g. changing a runner label or adding a step) is build orchestration,
     not package inventory — Task, not ISP.
  4. **A code change that deploys and runs as application code on PRD, but has
     no user-facing behavior change and is not fixing a defect** (a refactor,
     an internal data-model migration, extracting/consolidating a module,
     a dependency bump that touches app code paths rather than just a
     Dockerfile/lockfile pin, cross-cutting technical debt work) →
     **Tech Story**, if the target project's Jira instance has that issue
     type (check `configs/<PROJECT_KEY>.json`, or `getJiraProjectIssueTypesMetadata`
     if not yet cached); fall back to **Story** if the project has no Tech
     Story type. This is distinct from ISP (which never runs as deployed app
     code at all) and from Task (reserved for non-code changes) — Tech Story
     *does* run on PRD, it just isn't visible to an end user and isn't a bug
     fix.
  5. **Everything else that deploys and runs as application code on PRD**: a
     crash/defect → **Bug**; a net-new user-facing capability → **Story**.
  Ask if genuinely ambiguous — in particular, a change that touches both a
  Dockerfile/package pin *and* the pipeline YAML in the same PR isn't
  automatically one type; ask whether the ticket's primary subject is the
  package or the pipeline. Likewise, a change that's both an internal
  refactor *and* fixes a reported defect isn't automatically Tech Story —
  ask whether the ticket exists because of the defect (Bug) or the refactor
  was the actual ask (Tech Story).
- **Link target + relationship** — a referenced ticket key and the relationship word
  ("blocks", "is blocked by", "relates to", "duplicates"). Map to Jira's link type
  names via `getIssueLinkTypes` if not already known:
  - "blocks" → type `Blocks`, this new ticket is the **inward** issue (blocker),
    the target is the **outward** issue (blocked). "A is blocked by B" → inward=B,
    outward=A.

### Step 2: Resolve the project key

Check `configs/_projects.json` in this skill directory (create it with `{}` if it
doesn't exist yet) before calling any Jira API:

- If the prompt has an explicit key-shaped token (`[A-Z]{2,}`) that also appears as a
  key in `_projects.json`, use it directly — no lookup needed.
- Otherwise, match the prompt's project name/description against each entry's `name`
  and `aliases`. A hit resolves the key with no live call.
- If a referenced link-target ticket (Step 1) implies the project and neither of the
  above matched, `getJiraIssue` on it already gives you the project key/name for free
  — use that, and still record it below.
- Only if none of the above resolve it, call `getVisibleJiraProjects` with a search
  string built from whatever the user said, resolve the key live, and **append a new
  entry to `_projects.json`**:

```json
{
  "<KEY>": {
    "name": "<project name from Jira>",
    "aliases": ["<the phrase the user actually used, lowercased>"],
    "learnedFrom": "<the phrase or ticket that resolved this>",
    "learnedOn": "YYYY-MM-DD"
  }
}
```

If the key was already in `_projects.json` but the user's phrase isn't yet in its
`aliases`, append the new phrase to the existing `aliases` array (don't overwrite the
entry) so the same wording resolves locally next time too.

**Repo detection, for the `repo:*` label (Step 11).** Determine the current
working directory's repo slug — run `git remote get-url origin` from cwd and
derive the slug the same way `repoSlugFromUrl()` does in research-loop's/
dev-loop's `src/config.ts` (last path segment, minus a trailing `.git`), e.g.
`"catalog-ui-management"` from `git@github.com:fandango/catalog-ui-management.git`.
If cwd isn't a git repo, or has no `origin` remote, this yields no slug — that's
fine, it just means no `repo:*` label gets added (Step 11), not an error.

Check the resolved project key's `repos` array in `_projects.json` (added
alongside `aliases`/`learnedFrom`):
- **cwd's slug is in that project's `repos` array**: this is the automatic,
  no-question case — carry the slug forward to Step 11, no `AskUserQuestion`
  needed. This is also how a project with multiple repos (MC has
  `catalog-ui-management` and `catalog-ui-public`) resolves *which one*
  automatically, since cwd's slug picks the right one without asking.
- **cwd's slug is a real repo but not in that project's `repos` array** (or the
  project has no `repos` array yet): a real mismatch signal — the ticket's
  target project doesn't match the repo the user is sitting in. Surface this in
  Step 7's `AskUserQuestion` batch rather than silently guessing either way.
- **cwd yields no slug at all** (not a git repo, no origin): skip the `repo:*`
  label entirely, no question asked — there's nothing to guess from and nothing
  to confirm.
- **A project's `repos` array doesn't exist yet and this is the first ticket
  created for it from a real repo**: after the user confirms (via the Step 7
  guard question) that cwd's slug is correct for this project, add a `repos`
  array to that project's `_projects.json` entry (`["<slug>"]`, or append to an
  existing array) — same self-healing convention as `aliases`, so the next
  ticket from the same repo resolves automatically.

### Step 3: Fetch link-target context (if any)

If a ticket was referenced, `getJiraIssue` on it (summary, description, comments).
This is the seed material for Overview/Evidence — same as reading the target ticket
before drafting a follow-up manually. Do not transcribe its full contents into the
new ticket; extract only what the new ticket needs to stand on its own.

### Step 4: Load or discover field requirements

Check `configs/<PROJECT_KEY>.json` in this skill directory (create the file if it
doesn't exist — start as `{}`).

- If `<IssueType>` key exists in the config, reuse its cached `fields` and
  `constraints` — no live metadata call needed.
- If not, call `getJiraIssueTypeMetaWithFields` for the project + issue type, seed a
  new entry under that issue type with every required field (id, name, `fieldType`,
  `allowedValues` if present), and write it back to the config file.

**Config shape** (see `configs/CR.json` for a filled example):
```json
{
  "<IssueType>": {
    "fields": {
      "<customfield_id>": {
        "name": "...",
        "required": true,
        "fieldType": "select|multiselect|adf|string|...",
        "allowedValues": [{ "id": "...", "value": "..." }],
        "note": "any quirk worth remembering, e.g. metadata lies about the real accepted shape",
        "learnedFrom": "<ISSUE-KEY>",
        "learnedOn": "YYYY-MM-DD"
      }
    },
    "constraints": [
      {
        "type": "parentRequired",
        "note": "...",
        "learnedFrom": "<ISSUE-KEY>",
        "learnedOn": "YYYY-MM-DD"
      }
    ]
  }
}
```

`fieldType: "adf"` is a special case worth calling out: Jira's create-metadata reports
some fields as plain `textarea`/`string`, but the create/edit endpoint actually
**rejects** a plain string for them and requires structured ADF document content
(`{ type: "doc", version: 1, content: [...] }`). This was discovered the hard way on
`customfield_10838` (Steps to Reproduce) in the CR project — see `configs/CR.json`.
Treat any field flagged this way as ADF from the start; don't rediscover it by trial.

### Step 5: Infer parent (if the project needs one)

If `constraints` includes a `parentRequired` entry, or the project's create-metadata
otherwise signals a parent is needed: search recent sibling tickets to find a
plausible parent Epic.

```js
searchJiraIssuesUsingJql({
  jql: `project = <PROJECT_KEY> AND issuetype = <IssueType> ORDER BY created DESC`,
  fields: ["summary", "parent"],
  maxResults: 10,
})
```

Look for a parent Epic shared by multiple recent, topically-related tickets (same
component/domain as the new ticket, not just the most recent one). This is a guess —
surface it as the pre-selected option in Step 7, not a silent decision.

**Don't over-trust "most recent" as the tiebreaker.** In TARS, recent sibling bugs
were parented across multiple unrelated epics — recency alone picked the wrong one
once already (see `constraints` note in `configs/TARS.json`). Match domain/component
in the sibling's own summary, not just timestamp, and always confirm in Step 7.

### Step 6: Load content template

Read `templates/<IssueType>.md` in this skill directory, where `<IssueType>` is
the issue type name with spaces removed (e.g. "Tech Story" → `TechStory.md`,
"Internal Package Software" → `InternalPackageSoftware.md`). If it doesn't exist:
- Fall back to `templates/Bug.md`'s shape (Overview / Evidence / Steps to
  Reproduce-or-equivalent / Acceptance Criteria) as a generic default.
- After the ticket is created, offer to save that generic shape as a new
  `templates/<IssueType>.md` seed so the next ticket of this type has a template to
  refine, rather than starting from scratch again.

Each template section is guidance for **what Claude writes**, not a config value —
keep template files as prose/markdown, not JSON. `configs/` is plumbing (field ids,
shapes, constraints); `templates/` is content (what goes in each section, and how).

### Step 7: One upfront AskUserQuestion

Batch every decision that needs a human into a single `AskUserQuestion` call. No
further prompts after this point.

Include, only as applicable:
- **Parent epic** — if inferred in Step 5, present it pre-selected as the first
  option alongside "let me specify a different one."
- **Any field from Step 4 with no default** (e.g. a required select/multiselect with
  no obvious value inferable from context) — surface its `allowedValues` as options.
- **Ambiguous issue type or link relationship**, if Step 1 couldn't resolve one
  confidently.
- **Ambiguous project match**, if Step 2 found more than one plausible alias/name hit
  and couldn't pick one with confidence.
- **Missing named surface** — for Bug/Story/Tech Story only, if nothing in the
  prompt or the Step 3 link-target context names a concrete file, page, endpoint,
  or component: ask for one directly (e.g. "Which file/page/endpoint does this
  concern?"), free text, no preset options. This is required, not a nice-to-have
  — Overview's template guidance (see `templates/Bug.md`/`Story.md`/`TechStory.md`)
  mandates a named surface specifically so this ticket doesn't hit
  research-loop's `ticket-refine` zero-signal bounce gate with no investigation
  ever attempted. Skip this question only when a surface is already evident from
  context — don't ask when the prompt already named one.
- **Repo/project mismatch guard** — if Step 2's repo detection found a real cwd
  slug that is *not* in the target project's `repos` array (a new project with no
  `repos` array yet counts as a mismatch too): ask directly, e.g. "You're in
  `catalog-ui-management` but this ticket targets TARS — should this ticket be
  labeled `repo:catalog-ui-management`, a different repo, or no repo label at
  all?" — options: the detected slug, "a different repo" (free text), "no repo
  label." This is the one guard that exists specifically because the `repo:*`
  label is applied automatically the rest of the time (Step 2/Step 11) — silently
  guessing here is exactly the wrong-repo-labeled-ticket risk that guard exists to
  catch. Skip this question when cwd yielded no slug at all (nothing to confirm),
  or when the slug is already in the project's `repos` array (no mismatch).

### Step 8: Delegate mechanical writing to a Haiku task-writer

All judgment for this ticket is already settled by this point — project, issue
type, parent, field values, link relationship (Steps 1–7). What's left is
mechanical: arrange already-decided facts into the template's fixed shape. Don't
do that arranging yourself — spawn a subagent via the `Agent` tool with
`model: "haiku"` (no `subagent_type`, so it starts fresh with no context of its
own) to do it, and treat its output as a plain formatting pass, not a second
opinion.

Build one self-contained prompt for that call containing everything it needs and
nothing it should decide:
- The **exact template** loaded in Step 6, verbatim (its HTML comments are the
  writing rules — leave them in).
- The **concrete facts** this session already gathered/decided: the link-target
  context extracted in Step 3, the named surface/current-vs-desired framing
  settled for Overview, any AC conditions already agreed, the field values from
  Step 4/7.
- **Explicit instructions**: only place the given facts into the template's
  sections in the given order; never invent, infer, or add a fact not supplied;
  if a section has no supplied content, omit it exactly as the template's own
  comments direct rather than padding it; keep AC bullets as independently
  testable conditions with no open questions; for any field flagged
  `fieldType: "adf"` in `configs/<PROJECT_KEY>.json` (see Step 4), also emit
  that field's content as real ADF doc JSON (orderedList/listItem nodes, bold
  `Expected:` lead-ins, inline code marks for routes/paths) using the exact
  shape already documented there — not a plain string.
- If it finds a supplied fact doesn't fit any section, or a required section has
  nothing supplied for it, it should say so back rather than guessing filler —
  that response means Steps 1–7 weren't actually finished, not that the writer
  should compensate.

Take its returned section text (and any ADF doc content) as the literal ticket
content for Step 9 — don't re-derive or re-word it yourself; if something reads
wrong, fix the input facts and re-run the call rather than hand-editing its
output, so the actual writing stays fully on the cheaper tier.

Sections that map to Jira fields other than `description` (e.g. Steps to Reproduce →
`customfield_10838` in CR) are written as their own field value, not inlined into the
`description` body — check `configs/<PROJECT_KEY>.json` for which section maps to a
dedicated field vs. staying in `description`; tell the Haiku call this mapping too,
so it returns them as separate pieces rather than one blob.

**Why Haiku, and why a separate call at all**: Steps 1–7 (project/type/parent
resolution, field inference, the `AskUserQuestion` batch) are the actual judgment
calls this skill exists to make, and they stay on this session's own tier.
Turning already-decided facts into template-shaped prose/ADF has exactly one
correct answer per input and needs no reasoning about the codebase, Jira
semantics, or the user's intent — the same mechanical/judgment split
`research-loop`'s `ticket-refine` draws between its own Sonnet-tier orchestration
and its subagents. Keeping this step on the parent session's tier would mean
paying for judgment-grade reasoning on a step that doesn't use it, every single
ticket.

### Step 9: Create the issue

```js
createJiraIssue({
  cloudId: "fandango.atlassian.net",
  projectKey: "<PROJECT_KEY>",
  issueTypeName: "<IssueType>",
  summary: "...",
  contentFormat: "markdown",
  parent: "<PARENT_EPIC_KEY>",       // if applicable
  description: "### Overview\n...\n### Evidence\n...\n### Acceptance Criteria\n...",
  additional_fields: {
    // one entry per required custom field from configs/<PROJECT_KEY>.json,
    // using ADF doc content for any field flagged fieldType: "adf"
  },
})
```

**On a "field is required" error not already in the config** (a constraint the
metadata call didn't surface — the CR parent-Epic requirement is exactly this kind of
failure): ask the user for that value via `AskUserQuestion`, retry the create, and
append the learned constraint/field to `configs/<PROJECT_KEY>.json` with
`learnedFrom`/`learnedOn` set to this ticket, so it's never hit blind again.

### Step 10: Create the link (if any)

```js
createIssueLink({
  cloudId: "fandango.atlassian.net",
  inwardIssue: "<blocker-key>",
  outwardIssue: "<blocked-key>",
  type: "Blocks",
})
```

### Step 11: Stamp the version label and repo label

Read this skill's `VERSION` file and add label `jira-ticket-create:<VERSION>` to
the just-created issue (e.g. `jira-ticket-create:1.1.0`) via `editJiraIssue`'s
`fields.labels`. If Step 2 resolved a repo slug for this ticket (either
automatically, or confirmed via Step 7's mismatch guard — never a slug that was
asked about and declined via "no repo label"), add `repo:<slug>` in the same
write:

```js
editJiraIssue({
  cloudId: "fandango.atlassian.net",
  issueIdOrKey: "<ISSUE-KEY>",
  fields: {
    labels: ["jira-ticket-create:<VERSION>", "repo:<slug>"],   // merge with any
                                                  // labels already set by
                                                  // additional_fields in Step 9
                                                  // — don't clobber them; omit
                                                  // "repo:<slug>" entirely if
                                                  // Step 2 found no slug or the
                                                  // user declined one in Step 7
  },
})
```

If Step 9 already set other labels via `additional_fields`, append these labels to
that same array instead of overwriting it with a second call — one label set,
one write. `jira-ticket-create:<VERSION>` is purely a provenance marker for which
skill version produced the ticket. `repo:<slug>` identifies which repo this
ticket belongs to — the same label research-loop's/dev-loop's `jira.repoLabel`
config field polls for (see research-loop's `docs/config.md`), needed because
more than one target repo can share a single Jira project (MC:
`catalog-ui-management` + `catalog-ui-public`). Neither label is
`pipeline:research`/`pipeline:dev` (the stage labels that actually trigger a
loop to pick the ticket up) — this skill never adds a stage label; that stays a
separate, deliberate decision the user makes when a ticket is actually ready to
enter the pipeline, not something ticket creation should do automatically.

### Step 12: Output

```
✅ Created <ISSUE-KEY>: <summary>
🔗 https://fandango.atlassian.net/browse/<ISSUE-KEY>
🔗 Linked: <ISSUE-KEY> blocks <TARGET-KEY>
🏷️ Labeled: jira-ticket-create:<VERSION>, repo:<slug>
```

## Guardrails

- Never write a plain string into a field whose config marks `fieldType: "adf"` —
  build real ADF doc content (see Step 4 and `configs/CR.json`).
- Never put an open question or "confirm with @X" into Acceptance Criteria — that's
  an Overview caveat or a separate ticket, not a checkable AC bullet.
- Never transcribe a full investigation/comment thread into the new ticket — extract
  and summarize; link back to the source ticket for full context.
- Every self-healing write to `configs/<PROJECT_KEY>.json` or `configs/_projects.json`
  must include `learnedFrom` (the ticket key or phrase that revealed it) and
  `learnedOn` (date), so the config stays auditable, not just a black box of magic ids.
- Never overwrite an existing `_projects.json` entry to add a new alias — append to
  its `aliases` array. Overwriting loses prior phrasing that already resolves fine.
- `templates/` files are markdown content guidance; `configs/` files are JSON
  plumbing. Don't mix them — a new field quirk goes in `configs/`, a new section or
  writing rule goes in `templates/`.
- Never call `getVisibleJiraProjects` (or any live Jira lookup for project identity)
  when `configs/_projects.json` already resolves the key or name/alias match — the
  whole point of the project index is to make repeat resolution local.
