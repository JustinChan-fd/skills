# Changelog

Versions follow the bump policy in `SKILL.md`'s "Versioning" section. Every ticket this skill
creates carries the label `jira-create-release:<VERSION>`.

## 1.0.2

- Removed the pre-create plan summary (Step 4b) and its Step 5 precondition. Three dev-mode
  runs in a row skipped it despite increasingly strict wording, and it never blocked anything:
  the Step 2 hard-stop checks are the real safeguard, and the user asked for no prompting.
  Step 8 now reports tickets, Build Artifact, deploy URL, defaults and carry-forward instead,
  and dev mode prints its `DEV MODE` banner there.
- Ticket contents are unchanged from 1.0.0 and 1.0.1. Four dev-mode runs (TARS-1498 to
  TARS-1500 and the first) produced correct tickets each time.

## 1.0.1

- The plan summary is now its own step (4b, text only, no tool call) with a precondition on
  Step 5. The run that created TARS-1498 and the 1.0.0 run that created TARS-1499 both skipped
  the summary and called `createJiraIssue` directly, so the earlier "mandatory" wording did
  not work as a gate.
- Previous release ticket must be queried fresh each run, not reused from an earlier one.
- Behavior and ticket contents are unchanged from 1.0.0.

## 1.0.0

- Initial release. Creates a TARS `Release` ticket from a fix version.
- Hard-stop prereq checks: tickets on the version, all tickets Ready for Release (the real
  end-of-INT status; "Verified on INT" has never existed in TARS), no duplicate Release ticket.
- Rollback Version and Previous Release Issue come from the version live on PRD
  (container-info lookup), not the newest Release ticket.
- Build Artifact matched from `webtarsthree-build-deploy.yml` runs on any branch, exact
  version match.
- Defaults: Release Type = Code, Development Team(s) = Creative Business Unit III. Capex/Opex,
  PII and SRE Classification are carried forward from the previous release (provisional).
- Release Rollback Plan is a markdown link, `[<rollback version>](<jenkins url>)`.
- Title `Release {repo} {fixVersion}`, assigned to the invoker, moved to Pending Approvals via
  CODE FREEZE (transition id 21) after create.
- Natural-language arguments, no confirmation prompt; a plan summary is printed before create.
- Dev mode (`--dev`) for testing against a placeholder version; see `README.md`.
- Snyk, approvers, due date, scheduled start and legacy hidden fields are left for a human.
- Verified so far: TARS-1497 (real create plus a manual CODE FREEZE) and TARS-1498 (dev-mode
  create). The automatic CODE FREEZE and Build Artifact match have not run through the skill yet.
