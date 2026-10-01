# jira-create-release

Creates a Jira `Release` ticket for a fix version and moves it to Pending Approvals
(the `CODE FREEZE` transition). The behavior is defined in `SKILL.md`; this file is a
quick reference.

## Usage

```
/jira-create-release for fix version 3.13.23-beta. previous release deploy was <jenkins url>
```

- Only the version is required. If the Jenkins URL is missing, the skill asks for it.
- Extra text meant for the ticket is saved as the description. By default it stays empty.
- Project defaults to TARS. Add new projects in `configs/_projects.json` and
  `configs/<KEY>.json`.

After the release ticket is in Pending Approvals, the skill moves every ticket on the fix
version from Ready for Release to Deployed to STG (one ticket first as a canary, then the
rest). Dev mode skips this.

Hard stops (nothing is created): no tickets on the version, any ticket not in
`prereqs.acceptedStatuses`, a Release ticket already exists for the version, or the
containers on PRD disagree on version.

## Dev mode (testing against a placeholder version)

Use this to test the skill without real tickets. It needs a fix version that exists in Jira
(the create call requires one). Create it in the TARS Releases page first, for example
`0.0.0-skilltest`. Use a name that cannot be mistaken for a real release.

```
/jira-create-release for fix version 0.0.0-skilltest. previous release deploy was https://ci-jenkins.fandango.com/job/webtarsthree-deploy-project/120/ --dev
```

Add `with transition` to also run CODE FREEZE. By default dev mode does not transition,
because that moves the ticket to Pending Approvals and starts the approver chain.

What dev mode changes:
- Skips the "tickets on the version" and "ticket statuses" checks.
- Keeps the duplicate check and the check that the version exists.
- Title is `[DEV] Release webtarsthree <version>` and the ticket gets the label
  `jira-create-release-dev`.
- Build Artifact is left empty and flagged, since a placeholder version matches no build.
- Refuses any version that already has real tickets on it.

Checks on the created ticket:
- Title starts with `[DEV]`.
- Rollback Version is the version live on PRD; Previous Release Issue is that version's
  Release ticket.
- Release Rollback Plan is a link whose text is the rollback version.
- Release Type is Code; Development Team(s) is Creative Business Unit III.
- Assigned to you; description empty.

Cleanup (the skill cannot delete): find the ticket with
`labels = jira-create-release-dev`, delete it in the Jira UI, then delete the placeholder
version from the TARS Releases page (needs project admin).

## Baseline test

Checks that a created ticket has the agreed baseline fields (title, labels, assignee, status,
fixed values, derived links, human-owned fields left empty), and that the config, `VERSION`
and `CHANGELOG.md` agree with it. Run from this directory, no install needed (Node 24+):

```
node --experimental-strip-types --test scripts/baseline.test.ts
```

- `scripts/baseline.ts`: `checkTicketFields(fields, { version, dev, transitioned })` returns a
  list of mismatches; empty means the ticket matches the baseline.
- `scripts/fixtures/TARS-1501.fields.json`: the golden ticket (first end-to-end run, v1.0.2).
- To check a live ticket: `getJiraIssue` it, pass `fields` to `checkTicketFields`. Any change to
  the baseline (a new default, a new never-fill field) means updating `baseline.ts`, the
  fixture and `configs/TARS.json` together; the config-sync tests fail if they drift.

## Bulk ticket moves

Step 6b moves the release's tickets with `scripts/bulk-transition.ts` (one process: pre-check,
canary, one bulk request, poll, verify). It needs `JIRA_EMAIL`, `JIRA_API_TOKEN` and
`JIRA_BASE_URL` in the environment or as `export` lines in `~/.zshrc`. Without them it exits 3
and the skill falls back to per-ticket MCP calls. Create a token at
https://id.atlassian.com/manage-profile/security/api-tokens. The account needs the Jira
"Global bulk change" permission (confirmed for this account).

```
node --experimental-strip-types scripts/bulk-transition.ts --keys TARS-1,TARS-2 --transition 71 --to "Deployed to STG" --dry-run
node --experimental-strip-types --test scripts/bulk-transition.test.ts
```

`--dry-run` runs only the read-only pre-check. Exit codes: 0 all moved, 1 some failed, 2 aborted,
3 no credentials, 4 bad arguments.

## Files

| File | Purpose |
|---|---|
| `SKILL.md` | Workflow and guardrails |
| `configs/_projects.json` | Project key, aliases, repo name, GitHub repo |
| `configs/TARS.json` | Field ids, defaults, carry-forward, never-fill list, transition id, PRD version URL |
| `scripts/bulk-transition.ts`, `.test.ts` | Bulk ticket mover and its fake-Jira tests |
| `VERSION`, `CHANGELOG.md` | Skill version and history. Tickets get the label `jira-create-release:<VERSION>`; find them with `labels = "jira-create-release:1.0.0"` (JQL has no wildcard match on labels, so query one exact version at a time, or `labels in ("jira-create-release:1.0.0", "jira-create-release:1.1.0")`). Bump both files together on every edit. |

## Manual steps the skill does not do

Snyk counts and PDF, all approver fields, Release Signoff, due date, scheduled start date.
