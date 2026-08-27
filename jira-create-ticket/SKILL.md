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

## Workflow

### Step 1: Parse intent

Extract from the prompt:
- **Project key** — explicit ("CR", "TARS") or inferred from a referenced ticket's
  project, or from the current repo if the user just says "file a ticket for this."
- **Issue type** — explicit ("bug", "story", "task", "ISP") or inferred from context
  (a crash/defect defaults to Bug; a net-new capability defaults to Story). Ask if
  genuinely ambiguous.
- **Link target + relationship** — a referenced ticket key and the relationship word
  ("blocks", "is blocked by", "relates to", "duplicates"). Map to Jira's link type
  names via `getIssueLinkTypes` if not already known:
  - "blocks" → type `Blocks`, this new ticket is the **inward** issue (blocker),
    the target is the **outward** issue (blocked). "A is blocked by B" → inward=B,
    outward=A.

### Step 2: Fetch link-target context (if any)

If a ticket was referenced, `getJiraIssue` on it (summary, description, comments).
This is the seed material for Overview/Evidence — same as reading the target ticket
before drafting a follow-up manually. Do not transcribe its full contents into the
new ticket; extract only what the new ticket needs to stand on its own.

### Step 3: Load or discover field requirements

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

### Step 4: Infer parent (if the project needs one)

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
surface it as the pre-selected option in Step 6, not a silent decision.

### Step 5: Load content template

Read `templates/<IssueType>.md` in this skill directory. If it doesn't exist:
- Fall back to `templates/Bug.md`'s shape (Overview / Evidence / Steps to
  Reproduce-or-equivalent / Acceptance Criteria) as a generic default.
- After the ticket is created, offer to save that generic shape as a new
  `templates/<IssueType>.md` seed so the next ticket of this type has a template to
  refine, rather than starting from scratch again.

Each template section is guidance for **what Claude writes**, not a config value —
keep template files as prose/markdown, not JSON. `configs/` is plumbing (field ids,
shapes, constraints); `templates/` is content (what goes in each section, and how).

### Step 6: One upfront AskUserQuestion

Batch every decision that needs a human into a single `AskUserQuestion` call. No
further prompts after this point.

Include, only as applicable:
- **Parent epic** — if inferred in Step 4, present it pre-selected as the first
  option alongside "let me specify a different one."
- **Any field from Step 3 with no default** (e.g. a required select/multiselect with
  no obvious value inferable from context) — surface its `allowedValues` as options.
- **Ambiguous issue type or link relationship**, if Step 1 couldn't resolve one
  confidently.

### Step 7: Generate the description

Using the template from Step 5 and the context from Step 2, write each section.
Follow the Philosophy section above strictly — omit Evidence if there's nothing
concrete, keep AC bullets independently testable, keep Steps to Reproduce concrete
with real paths/URLs.

Sections that map to Jira fields other than `description` (e.g. Steps to Reproduce →
`customfield_10838` in CR) are written as their own field value, not inlined into the
`description` body — check `configs/<PROJECT_KEY>.json` for which section maps to a
dedicated field vs. staying in `description`.

### Step 8: Create the issue

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

### Step 9: Create the link (if any)

```js
createIssueLink({
  cloudId: "fandango.atlassian.net",
  inwardIssue: "<blocker-key>",
  outwardIssue: "<blocked-key>",
  type: "Blocks",
})
```

### Step 10: Output

```
✅ Created <ISSUE-KEY>: <summary>
🔗 https://fandango.atlassian.net/browse/<ISSUE-KEY>
🔗 Linked: <ISSUE-KEY> blocks <TARGET-KEY>
```

## Guardrails

- Never write a plain string into a field whose config marks `fieldType: "adf"` —
  build real ADF doc content (see Step 3 and `configs/CR.json`).
- Never put an open question or "confirm with @X" into Acceptance Criteria — that's
  an Overview caveat or a separate ticket, not a checkable AC bullet.
- Never transcribe a full investigation/comment thread into the new ticket — extract
  and summarize; link back to the source ticket for full context.
- Every self-healing write to `configs/<PROJECT_KEY>.json` must include
  `learnedFrom` (the ticket key that revealed it) and `learnedOn` (date), so the
  config stays auditable, not just a black box of magic ids.
- `templates/` files are markdown content guidance; `configs/` files are JSON
  plumbing. Don't mix them — a new field quirk goes in `configs/`, a new section or
  writing rule goes in `templates/`.
