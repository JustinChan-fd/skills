---
name: jira-create-release
description: Create a Jira Release ticket for a fix version (e.g. "3.13.23-beta"), after hard-stop prereq checks, with derived and carried-forward fields filled from the previous release, assigned to the invoker and moved to Pending Approvals
argument-hint: for fix version <version>. previous release deploy was <jenkins url>
---

# /jira-create-release

Create a TARS `Release` ticket for one fix version. Plumbing (field ids, carry-forward
rules, transition ids) lives in `configs/<PROJECT>.json` and self-heals, same convention
as `jira-create-ticket`. This skill writes no prose: the title is templated, the
description is empty unless the user supplies text at trigger time.

## Versioning

`VERSION` (in this skill directory) holds the current version as a bare `MAJOR.MINOR.PATCH`
string. Step 5 stamps every created ticket with the label `jira-create-release:<VERSION>`, so
a ticket's originating skill version is visible on the ticket. Bump by hand when editing this
skill and record it in `CHANGELOG.md` in the same edit:

- **Patch**: wording or doc tweaks that don't change what a ticket looks like or how a
  decision is made.
- **Minor**: purely additive capability (a new field, a new check, a new mode).
- **Major**: a change that makes a new ticket structurally different from an old one, or
  changes a hard-stop rule, the title template, or which fields are filled or left manual.

When in doubt between two levels, pick the higher one.

## Arguments

`$ARGUMENTS` — natural language. Typical form:
`for fix version 3.13.23-beta. previous release deploy was https://ci-jenkins.../121/`

Infer these from the text; do not require a fixed order:

- **fixVersion** (required): the version-shaped token (e.g. `3.13.23-beta`).
- **Previous deploy URL** (optional): any URL the user describes as the previous/last
  deploy. Used for Previous Deploy Job and Release Rollback Plan. If absent, Step 4 asks.
- **project** (optional): key or alias from `configs/_projects.json`. Defaults to `TARS`.
- **Description text** (optional): any remaining text that is clearly meant for the ticket
  (not the version or the deploy URL). Saved as the description (Step 7). If none, the
  description stays empty. If it is unclear whether a sentence is instructions to you or
  description text, treat it as instructions and leave the description empty.

## Dev mode

If `$ARGUMENTS` contains `dev mode` or `--dev`, this is a test run against a placeholder
fix version. Changes from the normal flow:

- **Skip Step 2 checks 1 and 2** (tickets on the version, ticket statuses). A test version
  has no tickets. Run checks 3 (no duplicate) and 4 (version is empty), plus the Step 1 check
  that the version exists in Jira, since `fixVersions` is required at create.
- **Prefix the summary**: `[DEV] Release {repo} {fixVersion}`. Add the label
  `jira-create-release-dev` so test tickets are easy to find and clean up.
- **Build Artifact**: a placeholder version will not match a workflow run. Leave it empty and
  flag it; this is not an error in dev mode.
- **Skip the CODE FREEZE transition by default**, since it starts the approver chain. Run it
  only if the arguments also say `with transition`.
- Everything else (PRD version lookup, previous release, defaults, carry-forward, link format,
  assignee) runs exactly as in a real run.
- Print `DEV MODE: ticket/status checks skipped` as the first line of the Step 8 output.

Dev mode never applies to a version that already has real tickets on it. If the version has
any tickets, stop and say so.

## Prompting policy

Ask the user only when something cannot be inferred or derived. There is no confirmation
step: if the prereq checks pass and every input is known, create the ticket without asking.
The hard-stop prereq checks (Step 2) are the safeguard.

## Out of scope (manual, never fill)

Snyk counts and PDF, every approver field (QA/Tech Lead/CAB), Release Signoff, Due date,
Scheduled Start Date, and legacy hidden fields. The full list is `neverFill` in the config.
Do not copy any of them from the previous ticket.

## Workflow

### Step 1: Resolve project and version

Look up the project in `configs/_projects.json` by key or alias. Load `configs/<KEY>.json`
and its `Release` entry. Confirm the fix version exists with `getJiraIssueTypeMetaWithFields`
(its `fixVersions.allowedValues`) or JQL. If it does not exist, stop and say so.

### Step 2: Prereq checks (HARD STOP on failure, nothing created)

Run all four (in dev mode, run only checks 3 and 4), report every offender, then stop if any fails:

1. **Fix versions assigned.** JQL
   `project = <KEY> AND fixVersion = "<version>"` must return at least one ticket. Zero
   means stop. Also run
   `project = <KEY> AND status in (<acceptedStatuses>) AND (fixVersion is EMPTY OR fixVersion != "<version>")`
   and list any hits as "ready but not on this version" (stop; the user decides whether
   they belong).
2. **Statuses.** Every ticket on the version must be in `prereqs.acceptedStatuses`
   (config). Any other status fails; list key, summary and status.

3. **No duplicate.** `project = <KEY> AND issuetype = Release AND fixVersion = "<version>"`
   must return zero tickets. If it returns one, stop and show its key, status and link.
   Never create a second Release ticket for the same fix version.
4. **Dev mode only: version must be empty.** `project = <KEY> AND fixVersion = "<version>"`
   (all issue types) must return zero tickets. If it returns any, stop: dev mode never
   applies to a version with real tickets.

Do not ask the user anything before these pass.

### Step 3: Derive fields

- **Title**: `titleTemplate` = `Release {repo} {fixVersion}`, where `repo` is the project's
  `repo` from `_projects.json`. Example: `Release webtarsthree 3.13.23-beta`.
- **Version live on PRD**: `curl -sS -m 10` the config's `prodVersionLookup.url`. Collect the
  distinct `.version` values across containers.
  - Exactly one distinct version: that is the live version.
  - More than one (a deploy is mid-flight) or any container not `passing`: stop and tell the
    user; do not pick one.
  - Unreachable (timeout, non-200, bad JSON): fall back to the newest Release ticket whose
    fix version is released, and add "PRD version unverified" to the end-summary flags.
- **Previous release ticket** (query it fresh every run; do not reuse an earlier run's result)
  = the Release ticket for the live version:
  `project = <KEY> AND issuetype = Release AND fixVersion = "<live version>" ORDER BY created DESC`,
  maxResults 1. Gives `customfield_14332` (its browse URL) and the source for carry-forward.
  If the live version equals the version being released, stop (already on PRD). If no Release
  ticket exists for the live version, ask the user which ticket to use.
  Do NOT use "most recent Release ticket": builds can run ahead of what is deployed.
- **Rollback Version** (`customfield_14330`): the live version from the lookup above (its Jira
  version object, matched by exact name).
- **Build Artifact** (`customfield_14154`): search runs of the workflow file
  `webtarsthree-build-deploy.yml` (`gh run list --repo <githubRepo> --workflow webtarsthree-build-deploy.yml --limit 100`),
  on ANY branch, not just master. For each run, `gh run view <id> --json jobs` and look at the
  job named `Update Hiera Versions / Update webtarsthree → <X> in hiera-versions`. It matches
  when `<X>` equals the fix version exactly, or equals `<branch>-<version>` (branch builds are
  prefixed, e.g. `TARS-1474-implement-dd-trace-3.13.15-beta`). Never substring-match: `3.13.1-beta`
  must not hit `3.13.11-beta`. If several runs match (a version can be built twice), take the
  newest and list the others in the end-summary flags. URL form:
  `https://github.com/<githubRepo>/actions/runs/<id>`. If none matches, leave it empty and flag
  it; do not guess.
- **Defaults**: apply `defaults.fields` from the config as-is (Release Type = Code,
  Development Team(s) = Creative Business Unit III).
- **Carry-forward**: read each field in `carryForward.fields` from the previous release
  ticket and copy its value as-is. These are provisional; the Step 8 output shows them.

### Step 4: Fill gaps

Use the previous-deploy URL inferred from `$ARGUMENTS` for `customfield_14331` (Previous
Deploy Job, bare URL) and `customfield_14151` (Release Rollback Plan: a single markdown link
whose text is the rollback version and whose target is the URL, e.g.
`[3.13.1-beta](https://ci-jenkins.fandango.com/job/webtarsthree-deploy-project/120/)`).
Verified on TARS-1497: Jira stores that string as-is and renders it as a real link.

Gaps: if the URL was not given, or Build Artifact / previous release could not be derived,
ask for exactly those missing items in one batched `AskUserQuestion` ("Paste the URL of the
last deploy in Jenkins (any link)" for the deploy URL).

There is no separate pre-create summary and no confirmation. The hard-stop checks in Step 2
are the safeguard, and Step 8 reports everything that was created. Go straight to Step 5 once
every input is known. Stop before creating only if a required input is still missing after the
gap question, or a Step 2 check failed.

### Step 5: Create

`createJiraIssue` with `projectKey`, `issueTypeName: "Release"`, the title, `fixVersions`,
`components`, `labels` (`jira-create-release:<VERSION>` read from this skill's `VERSION` file,
plus `jira-create-release-dev` in dev mode), `assignee_account_id` of the invoking user
(`atlassianUserInfo`), `description`
from Step 7 (omit when empty), and all derived/carry-forward/Jenkins fields in
`additional_fields`. Always assign to the invoker.

On a "field is required" error not in the config, ask once, retry, and write the learned
field/constraint to the config with `learnedFrom`/`learnedOn`.

### Step 6: Move to Pending Approvals

**Discovery mode (only if `transition.transitionId` is null in the config; it is set for TARS).** Do not transition.
Call `getTransitionsForJiraIssue` on the new ticket and report what it returns: each
transition's id, name, target status and `hasScreen`, plus the ticket's current status.
Creating the ticket counts as a successful run. Then stop and tell the user the next step is
to transition it together so the id and modal fields can be written to the config. Skip the
rest of this step.

**Normal mode (`transitionId` is set).** The ticket lands in `initialStatus`. Call
`getTransitionsForJiraIssue`, pick the transition whose `to.name` equals `transition.to`.
Match on the target status, never the transition name: the transition into Pending
Approvals is named `CODE FREEZE` (the two are the same step in the Jira UI). Verified on
TARS-1497: `transitionJiraIssue` with just `{ "id": "21" }` succeeds, so no screen fields
need to be sent. After it runs, confirm the ticket's status is Pending Approvals.

- If `hasScreen` is true, read its fields from the result and fill them from the config's
  `transition.screenFields`. If a required screen field has no value in the config, ask the
  user once, then save the answer to the config.
- Call `transitionJiraIssue`.
- First run only: write `transitionId`, `hasScreen`, `screenFields`, `learnedFrom`,
  `learnedOn` back into `configs/<KEY>.json`. Also correct `initialStatus` if the ticket
  landed somewhere other than On-Hold.

If the transition is unavailable or fails, stop and report. The ticket already exists, so
show its key and the exact error.

### Step 7: Description

Empty by default. If the user supplied free text, save it as the description, templated as:

```
{user text}
```

Keep the user's wording. Do not add headings, release notes, or ticket lists. (A future
templating pass can expand this; today it is a pass-through.)

### Step 8: Output

```
[dev mode only: first line is `DEV MODE: ticket/status checks skipped`]
✅ Created <KEY>: Release <repo> <version>   (assigned to you, now Pending Approvals)
🔗 https://fandango.atlassian.net/browse/<KEY>
📦 Fix version: <version>  |  Rollback: <prev version>  |  Prev release: <PREV-KEY>
🎫 Tickets on version: <n>, all Ready for Release   (dev mode: "checks skipped")
🔨 Build Artifact: <url, or "not found">   |   Deploy URL: <url>
📋 Defaults: Release Type = Code, Development Team(s) = Creative Business Unit III
📋 Carry-forward (provisional, from <PREV-KEY>): <field: value, ...>
🏷️ Labeled: jira-create-release:<VERSION>
⚠️ Manual still: Snyk counts + PDF, approvers, due date, scheduled start
⚠️ <any soft flags, e.g. Build Artifact not found>
```

## Guardrails

- Never create the ticket if any Step 2 check fails.
- Never fill a `neverFill` field.
- Never invent a URL. Missing Build Artifact is a flag, not a guess.
- Every self-healing write to `configs/` carries `learnedFrom` and `learnedOn`.
- Never paste secrets or tokens into a ticket field.
- Do not add stage labels or `cab_ovrd`; CAB owns that. The only labels this skill sets are
  `jira-create-release:<VERSION>` and, in dev mode, `jira-create-release-dev`.
