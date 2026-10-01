# Changelog

Versions follow the bump policy in `SKILL.md`'s "Versioning" section. Every ticket this skill
creates carries the label `jira-create-release:<VERSION>`.

## 1.3.0

- Step 6b now runs `scripts/bulk-transition.ts`: pre-check (the transition must be offered to
  every key and lead to the expected status), one canary moved alone through the REST API, one
  `POST /rest/api/3/bulk/issues/transition` for the rest, task polling, then a direct read of
  every ticket. One tool call replaces one `transitionJiraIssue` call per ticket. Measured
  motive: the 1.2.0 run (TARS-1503) made 24 transition calls over 10 model requests and cost
  $0.99, against $0.41 for the 1.1.0 run with no ticket moves.
- Credentials come from `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_BASE_URL` in the environment, else
  the same `export` lines in `~/.zshrc`. With no credentials (exit 3) the skill falls back to the
  per-ticket MCP loop, now told to send the remaining calls in one message.
- `.gitignore` in the skills repo now ignores `.env`, `.env.*` and `*.token`.
- 20 tests for the script against a fake Jira (canary stops, partial failure, timeout, paging,
  credentials never in output).
- Verified live before the script existed: `/myself`, the bulk GET, and a 23-ticket bulk submit
  (Deployed to STG back to Ready for Release) that completed with 0 failures; the account has the
  bulk-change permission.
- Verified end to end on TARS-1504 (first real run of 1.3.0): the release ticket passes the
  baseline check with 0 mismatches, and the script moved all 23 tickets to Deployed to STG (exit 0,
  canary TARS-1482, task COMPLETE, 0 failed); every ticket was then read directly and is in
  Deployed to STG. The run found the credentials through the `~/.zshrc` fallback, so it took the
  script path, not the MCP loop.
- Cost and time from the session transcript: $0.37, 8 requests, about 1 min 4 s, with 1
  `transitionJiraIssue` call. Compare 1.2.0 (TARS-1503): $0.99, 11 requests, 24 transition calls,
  and 1.1.0 (TARS-1502, no ticket moves): $0.41, 10 requests, 56 s.
- Not exercised in a real run: the per-ticket failure report, the stop-on-bad-canary path, the
  no-credentials MCP fallback, and whether the bulk request notifies anyone.

## 1.2.0

- New Step 6b: after the release ticket reaches Pending Approvals, every ticket on the fix
  version is moved from Ready for Release to Deployed to STG (transition id 71, named
  "Deployed"). The first ticket is moved alone as a canary and the run stops if its new status
  is not Deployed to STG; the rest go together, failures are reported per ticket and never
  retried automatically. Skipped in dev mode. The release ticket itself is unchanged.
- Verified on TARS-1503 (first real run of 1.2.0): release ticket passes the baseline check with
  0 mismatches, and all 23 tickets on 3.13.23-beta moved from Ready for Release to Deployed to
  STG with only `{ "id": "71" }`. The user confirmed the canary step worked. The per-ticket
  failure path and the stop-on-bad-canary path have not been exercised (nothing failed).
  `ticketTransition.verified` is now true in the config.

## 1.1.0

- Workflow is now two phases: Phase 1 (Steps 1-4) only reads and ends with every input known
  or a stop; Phase 2 (Steps 5-8) writes. The text tells the run to issue the independent
  Phase 1 reads together; whether a given run actually batches them is not verified.
- Build Artifact is found through the version's git tag: tag -> commit (dereferencing annotated
  tags) -> `gh run list --commit`, two calls, about 3 seconds, with an exact match. The old
  100-run job-name scan (about 2 seconds per run) remains only as a fallback when no tag exists.
- An unreachable PRD lookup no longer falls back to the newest released Release ticket (that
  could put a wrong rollback version in front of approvers). It now asks the user which version
  is live, and stops if they cannot say.
- Build Artifact missing on a real run is still flagged, not a stop. Decision left open.
- Ticket contents are unchanged from 1.0.2.
- Verified on TARS-1502 (first real run of 1.1.0): passes the baseline check with 0 mismatches,
  automatic CODE FREEZE worked, Build Artifact came out the same as the old scan. Wall clock
  was 56 s against 3 min 56 s for the 1.0.2 run (TARS-1501), at about the same cost ($0.41 vs
  $0.37, both Sonnet 5.5). Both runs made nearly the same tool calls (5 vs 4 Bash), so the
  cause of the speed difference is not established; it was not the 100-run scan.
- Added `scripts/baseline.ts` and its tests (see README).

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
