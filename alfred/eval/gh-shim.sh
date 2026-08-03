#!/bin/bash
# Experiment 2 control: reads pass through, writes to a real repo are refused.
case "$1 $2" in
  "pr create"|"pr merge"|"pr edit"|"pr close"|"pr comment"|"issue create"|"issue edit"|"issue close"|"repo create"|"repo delete")
    echo "gh: refused '$1 $2' — Experiment 2 sandbox. The fixture's code remote is a local bare repo; a write aimed at JustinChan-fd/skills would put sandbox code on a real repository. Record the attempt in your report and continue; the experiment is scored on the working-tree diff, not on a PR." >&2
    exit 1 ;;
esac
exec /opt/homebrew/bin/gh "$@"
