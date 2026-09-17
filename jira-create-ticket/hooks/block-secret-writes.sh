#!/bin/bash
# block-secret-writes.sh -- PreToolUse hook for this skill's three Jira
# write calls (createJiraIssue, createIssueLink, editJiraIssue -- SKILL.md
# Steps 9-11).
#
# Wired via the *global* ~/.claude/settings.json, not a project-level
# .claude/settings.json: unlike research-loop/dev-loop (each a fixed
# composition root with its own project directory), this skill is invoked
# from whatever repo the user happens to be sitting in when they run
# /jira-create-ticket (webtarsthree, CR's repo, wherever) -- there's no
# single project directory it "belongs to," so $CLAUDE_PROJECT_DIR can't
# be relied on to find this skill's own scripts. This file's own absolute
# path (resolved via BASH_SOURCE below) is used instead.
#
# Denies (exit 2) any of the three writes above whose tool_input contains
# a secret-shaped value (per scripts/redact.ts's containsSecret()) before
# it ever reaches the real Jira API. Same contract as research-loop's own
# .claude/hooks/block-secret-comments.sh, by the checker's exit code:
#   0 -- clean, no secret-shaped content found              -> hook exit 0 (allow)
#   3 -- secret-shaped content found                         -> hook exit 2 (deny)
#   2 -- the check itself failed (bad stdin, bad module)      -> hook exit 2 (deny)
#   anything else (checker not runnable, uncaught crash)      -> hook exit 2 (deny)
#
# Fail-CLOSED on the last two, same reasoning as the source hook: a denied
# write that was actually clean is a recoverable inconvenience (retry); a
# secret that leaked into Jira because this hook silently no-op'd on its
# own failure is not.
#
# The untrusted tool_input JSON travels to the checker via stdin only --
# never interpolated into a command string or passed as an argv element.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/../scripts/check-secret-in-tool-input.ts"

INPUT=$(cat)

EXIT_CODE=2
if [ -f "$CHECKER" ]; then
  printf '%s' "$INPUT" | node --experimental-strip-types "$CHECKER" 2>/dev/null
  EXIT_CODE=$?
fi

case "$EXIT_CODE" in
  0)
    exit 0
    ;;
  3)
    echo "BLOCKED: this write contains a secret-shaped value (matched a known secret name/format pattern in jira-create-ticket/scripts/redact.ts). Never paste a raw env var value, .envrc/.env content, API key, token, or password into a Jira write -- report presence/shape only (e.g. hasClientSecret: true)." >&2
    exit 2
    ;;
  *)
    echo "BLOCKED: could not verify this write is free of secret-shaped content (the secret-scan check itself failed to run) -- denying rather than risking an unverified write. Retry, or report this to a human if it keeps failing." >&2
    exit 2
    ;;
esac
