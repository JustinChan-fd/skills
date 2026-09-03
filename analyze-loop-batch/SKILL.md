---
name: analyze-loop-batch
description: Analyze a completed research-loop/dev-loop sub-batch and fill in its Confluence tracking tables (outcomes, KPIs, blocked/pending)
---

# /analyze-loop-batch

Reads `research-loop` and `dev-loop`'s run logs plus live Jira state for one
sub-batch of tickets, classifies every ticket's current outcome (including
non-PR terminal states — blocked on spec, blocked externally, refined and
awaiting human approval), computes the batch's KPIs, and writes both back
into the Confluence tracking page.

This is a **read-then-report** skill. It never claims a ticket, never spawns
`claude -p`, never touches a worktree, and never writes to Jira beyond what
it's already there to read (comments/status/changelog). It only appends
analysis — to `runs/webtarsthree.jsonl` readers and to the Confluence page.

## When to use

After a sub-batch of tickets has been run through `research-loop` /
`dev-loop`, once you believe that sub-batch is done — not mid-run. Typically:
once a day, after that day's sub-batch has had a chance to settle.

## Arguments

`$ARGUMENTS` — the sub-batch number (e.g. `1`) and, optionally, the
Confluence page URL if it differs from the default. If the sub-batch number
is omitted, ask which one.

Default Confluence page:
`https://fandango.atlassian.net/wiki/spaces/TARS/pages/5697765452/TARS-3+-+Curation+Tools+Batch+research-loop+dev-loop+Analysis`

Default repo paths:
- `research-loop`: `~/Desktop/Repos/research-loop`
- `dev-loop`: `~/Desktop/Repos/dev-loop`

Both configurable via `$ARGUMENTS` if the user names different paths/pages.

## Step -1 — first-ever invocation: calibration pass

This skill's classification rules and field names (comment titles, status
names, config field names like `claimStatus`/`readyEpic`/`auto-promote`,
`runs.jsonl`'s schema) were all written by reading the loops' source and
docs at some point in the past — they are **assumptions about how the
pipeline behaves, not verified facts about how it behaves right now**.
The first time this skill is ever run for this batch (no prior "Sub-batch N
results" subsection exists on the Confluence page yet, and no Sub-batch log
row has a date in it), treat this run as a **calibration pass** before
trusting its own output:

1. Before Step 0, spot-check each assumption below against the *live*
   source/config, not against this skill's memory of it:
   - The exact comment title strings (`Refined Spec — ready for
     ticket-to-pr`, `Ticket-Refine Bounce — <failure_category>`) — read
     the actual comment(s) posted on this sub-batch's tickets and confirm
     the wording matches exactly, not approximately.
   - The intake/claim status name(s) and the `readyEpic`/`intakeEpics`
     field values — read `research-loop`'s actual config (not just
     `docs/config.md`, which can drift from the real config file) and
     confirm they match what Step 1's classification logic assumes.
   - Whether `dev-loop` truly still has no Jira-comment-writing tool in
     `ALLOWED_TOOLS` (re-check `dev-loop/src/main.ts` directly — this may
     have changed since this skill was last updated).
   - The `auto-promote` label's exact name and behavior.
   - `runs.jsonl`'s actual field names/shapes in both repos, in case the
     schema drifted from what Step 1/2 expect (e.g. a renamed
     `failure_category` value, an added/removed field).
2. If everything checks out, say so briefly in the Output report ("first
   run — spot-checked assumptions against live config/source, no drift
   found") and proceed normally.
3. If something doesn't match — e.g. the intake status is actually called
   something other than what was assumed, or a comment title has slightly
   different wording — this is a **finding, not a one-off workaround**:
   fix it in this SKILL.md file itself (so every future run, not just this
   one, uses the corrected logic), then re-run Step 1's classification for
   *this* sub-batch using the corrected rule before writing anything to
   Confluence. Report the correction explicitly to the user: what was
   assumed, what's actually true, and that the skill file has been updated.
4. **Consistency matters more than getting it right immediately.** The
   point of this pass is to catch drift once, early, so every subsequent
   sub-batch is measured the same way — not to keep re-litigating
   assumptions every run. If a correction changes how any ticket in *this*
   sub-batch would have been classified or timed, redo that ticket's
   classification/KPIs with the corrected rule before this run's Confluence
   write — don't let sub-batch 1 get graded by one set of rules and
   sub-batch 2 onward by another; that produces tainted, non-comparable
   data across the batch. If sub-batch 1's rows were already written to
   Confluence under the old assumption in a *prior* run (i.e. you're only
   now discovering this drift on sub-batch 2+), go back and correct
   sub-batch 1's already-written rows too, and note in the versionMessage
   that this was a retroactive correction, not just new data.
5. Once a sub-batch has run cleanly with no corrections needed, treat the
   assumptions as stable — don't re-run this full calibration pass on every
   invocation. Only revisit a specific assumption if something in a later
   sub-batch looks inconsistent with it (e.g. a comment title suddenly
   doesn't match, a status name that used to work no longer does).

## Step 0 — readiness gate (hard stop if not met)

**Do not proceed past this step until every condition holds.** Running this
analysis while a ticket is mid-flight reads a partial picture — a
`cost_usd`/`tokens` value that hasn't been written to `runs.jsonl` yet
because that run hasn't reached a terminal state, or pipeline state
(worktree, shared dev server) still in active use.

1. Identify this sub-batch's ticket keys from the Confluence page's
   "Sub-batch N" table (read the page first — `getConfluencePage`).
2. For each ticket, check both `research-loop/runs/webtarsthree.jsonl` and
   `dev-loop/runs/webtarsthree.jsonl` for its most recent run line.
3. Check for anything still in flight for these tickets:
   - Any ticket with a run line but no matching terminal Jira state yet
     (see Step 1's classification) may still be actively being worked —
     cross-check by looking for a live worktree: `git worktree list` in
     the target repo (`webtarsthree`) for a branch name containing the
     ticket key, or `.pipeline/<slug>/runs/<TICKET>-*` directories in
     either loop repo that haven't been cleaned up.
   - If a `claude -p` process invoking either skill for one of these
     tickets appears to be running (ask the user if unsure — do not guess
     from process listing alone, since that's unreliable across
     terminals), treat the sub-batch as **not ready**.
4. If anything in the sub-batch is still in flight: **stop, report which
   ticket(s), and do not write anything to Confluence.** Tell the user to
   re-run this skill once those settle.
5. If everything has reached a terminal state (see the outcome legend
   below — landed, blocked, refined-awaiting-approval, bounced, error,
   killed, or genuinely never started), proceed.

Terminal, for this gate's purposes, includes states that are NOT a landed
PR — a ticket sitting in `Blocked` with a bounce comment is just as
"settled" as one with an open PR. The point of the gate is "nothing is
actively running right now," not "everything succeeded."

## Step 1 — classify every ticket in the sub-batch

For each ticket key, determine its outcome using this precedence (check in
order, stop at the first match):

1. **✅ Landed** — `dev-loop/runs/webtarsthree.jsonl` has a line for this
   ticket with `outcome: "landed"`. Record its `pr` field.
2. **🔁 Bounced — dev→research** — the *most recent* `dev-loop` run line for
   this ticket has `outcome: "bounced"`, AND a *newer* `research-loop` run
   line exists for the same ticket (dev-loop kicked it back and
   research-loop already picked it up again). If there's no newer
   research-loop line yet, this is currently sitting between loops — still
   report it as this state, but note "awaiting research-loop pickup" in the
   Blocked/pending tracker's reason column.
3. **🔄 Bounced — human-directed re-run** — the most recent `research-loop`
   run line has `outcome: "bounced"`, AND since that run's `ended`
   timestamp a non-bot comment exists on the ticket (per the human
   commentary scan below), AND the ticket's status has been moved back to
   `config.jira.claimStatus.from` (its intake queue state, e.g. "To Do") —
   i.e. you personally reviewed the bounce, gave a resolving directive, and
   manually re-queued it for another research-loop pass, distinct from #2
   (which is dev-loop kicking a ticket back, not a human steering
   research-loop directly). If no newer research-loop run has picked it up
   yet, it's currently sitting in the intake queue awaiting that pass —
   report it as this state and note "re-queued <date>, awaiting next
   research-loop pickup" in the tracker. Confirm via the ticket's changelog
   (`getJiraIssue` with `expand: "changelog"`): a `status` transition
   *authored by a human* (not a Jira automation account) back to the intake
   status, timestamped after the bounce comment.
4. **🚫 Blocked — spec** — the most recent `research-loop` run line has
   `outcome: "bounced"` with `failure_category` in
   `spec_ambiguous`/`spec_contradicted`/`too_large`, no newer
   `dev-loop`-side resolution exists, AND #3's re-queue condition does not
   hold (i.e. it's still actually sitting blocked, not already re-queued).
5. **🚫 Blocked — external** — same as above but `failure_category: "blocked"`.
6. **📝 Refined, awaiting approval** — `research-loop`'s most recent run has
   `outcome: "landed"` (research-loop's internal "ready" verdict, normalized
   — see `research-loop/src/loop-runner.ts`), but the ticket has NOT been
   auto-promoted (check the `auto-promote` label — see
   `research-loop/docs/config.md`) and dev-loop has no run for it yet.
   Confirm by fetching the ticket (`getJiraIssue`) and checking for the
   `Refined Spec — ready for ticket-to-pr` comment plus its current epic —
   still sitting under `intakeEpics`, not moved to `readyEpic`.

   **Rework check before settling on this classification**: if a *newer*
   `research-loop` run line exists for this ticket after that `Refined Spec`
   comment's timestamp — i.e. you reviewed the refined spec, disagreed with
   an assumption/scope, and manually moved status back to the intake queue
   instead of promoting it (mechanically the same human-authored-changelog-
   transition check as #3, just triggered from a 📝 state rather than a
   bounce) — then this ticket is NOT currently 📝. Restart the precedence
   check using that newer run as the ticket's most recent research-loop
   line; whatever it resolves to (landed-again / bounced / etc.) is the real
   current classification. Either way, record the rework gap (see "Human
   gate timing" below) in the tracker — that idle period happened regardless
   of where the ticket landed afterward.
7. **⚠️ Error / killed** — most recent run line for either loop has
   `outcome: "error"` or `outcome: "killed"`.
8. **⏳ Not started** — no run line in either log for this ticket at all.
9. **🔵 In progress** — should not occur here (Step 0 gates on this), but if
   it does slip through, do not classify further — flag it and skip.

For every ticket landing in 🚫, 📝, 🔁, or 🔄, pull the actual bounce/block
reason. The two loops are NOT symmetric here — check which one produced the
bounce before deciding where to look:

- **research-loop bounce** (`failure_category` in
  `spec_ambiguous`/`spec_contradicted`/`too_large`/`blocked`) — the
  `Ticket-Refine Bounce — <failure_category>` Jira comment is the primary
  source (`research-loop`'s `main.ts` allows
  `mcp__atlassian__addCommentToJiraIssue`, and its skill always posts this
  comment on bounce). Quote it directly.
- **dev-loop bounce** — dev-loop's `ticket-to-pr` skill has NO Jira-comment
  tool in its `ALLOWED_TOOLS` and `loop-runner.ts`'s bounce branch only
  transitions status to `Blocked` — it never writes a comment. Do not go
  looking for a bounce comment here; it doesn't exist. Pull the reason from
  `verdict.json`'s `detail` field as logged in that ticket's
  `dev-loop/runs/webtarsthree.jsonl` line instead.

Either way, quote the concrete evidence, not just the category label — the
whole point of this tracker is to show *what* the skepticism/ambiguity/
question actually was, not just that one occurred.

**Human commentary scan**: for every ticket in 🚫, 📝, 🔁, or 🔄, fetch its
full Jira comment history (`getJiraIssue` with `fields: ["comments"]`) and
check for any comment that is NOT titled exactly `Refined Spec — ready for
ticket-to-pr` or `Ticket-Refine Bounce — <failure_category>` — i.e. anything
you (or another human) wrote by hand: a question, a "holding on this," a
steering note, or (for 🔄) the resolving directive itself. This is how a
ticket you're personally sitting on with an open question gets surfaced,
since neither loop's automation would ever flag it on its own. Quote any
such comment verbatim in the tracker's reason column, prefixed
`(human note)`, alongside — not instead of — the loop-generated reason if
one also exists. For 🔄 specifically, this scan IS the evidence for that
classification (see #3 above) — quote the directive comment(s) in full,
since that's the actual scope decision the next research-loop pass will
act on, not just a footnote.

## Step 2 — compute this sub-batch's KPIs

Pull every `runs.jsonl` line (both repos) belonging to this sub-batch's
ticket keys. For each ticket compute, then roll up sub-batch totals/averages:

- **Time**: research-loop phase (`ended - started`, summed if there were
  multiple runs e.g. after a bounce-and-retry), dev-loop phase, combined
  end-to-end (first research-loop `started` → the `landed` run's `ended`).
  For a ticket not yet landed, end-to-end has no value yet — report time
  spent so far, explicitly labeled "in progress, not landed" rather than as
  a finished duration.

  **Cross-check `runs.jsonl`'s self-reported start/end against independent
  evidence** — don't just trust the loop's own log for the two endpoints of
  the combined end-to-end figure:
  - **Start**: compare research-loop's `started` timestamp against the
    Jira changelog transition that moved the ticket out of the intake
    status (e.g. To Do → In Progress) around that time, if research-loop
    transitions status on claim. Use the changelog entry whose timestamp
    is closest to `started`.
  - **Landing**: compare the `landed` run's `ended` timestamp against that
    PR's actual `createdAt` on GitHub (`gh pr view <pr> --json createdAt`,
    using the `pr` field from that run line) — the PR is a third system's
    timestamp, not the loop grading its own homework.
  - If the two agree within 5 minutes, trust `runs.jsonl`'s number as-is
    and don't clutter the report with the cross-check. If they differ by
    more than 5 minutes, report both timestamps side by side and flag the
    discrepancy explicitly (e.g. "⚠️ start mismatch: runs.jsonl says 14:00,
    Jira changelog shows claim at 14:45 — using changelog time for the
    combined figure, discrepancy needs a look") rather than silently
    picking one number or averaging them. Do this cross-check once per
    landed ticket (start + landing), not for every intermediate bounce.
- **Cost**: `cost_usd` per phase and summed, across every run line for that
  ticket (not just the last one — a bounced-then-retried ticket has more
  than one run per phase).
- **Retries / verify_loops**: sum across that ticket's run lines.
- **Human gate timing**: every human decision point in the pipeline is a
  wall-clock gap between "the loop handed control back to a human" and
  "the human acted" — never a proxy for how long you actually spent
  thinking about it. There are four distinct gates; compute whichever
  apply per ticket, and label each by its gate name (don't collapse them
  into one generic "review time"):
  - **Bounce-review gap** (🔄, or any 🚫 re-queued mid-batch): loop-
    generated bounce's `ended` timestamp → the human-authored changelog
    transition back to the intake status (per #3's classification check).
  - **Promotion gap** (📝 that gets promoted): `Refined Spec` comment's
    `created` timestamp → the epic-move to `readyEpic`.
  - **Rework gap** (📝 that gets sent back instead of promoted, per the
    rework check under #6): `Refined Spec` comment's `created` timestamp →
    the human-authored changelog transition back to the intake status.
  - **PR review gap** (✅ Landed, i.e. any ticket with a `pr` URL): that
    PR's `createdAt` → its `mergedAt`, both from GitHub
    (`gh pr view <pr> --json createdAt,mergedAt,state`), not Jira — Jira's
    `Code Review` status transition is a reasonable proxy for `createdAt`
    but GitHub is the source of truth for `mergedAt`. This is the one gate
    that doesn't require any Jira changelog cross-referencing: pull both
    timestamps from the same `gh pr view` call. A "Landed" ticket is not
    fully done just because the PR opened — it's sitting in someone's
    review queue, and that wait is exactly as real as the other three
    gates, so don't let "✅ Landed" read as "finished."
  Report each per-ticket as "<gate name> gap: Xh Ym (<from-event> at <ts> →
  <to-event> at <ts>)" — e.g. "rework gap: 3h 10m (Refined Spec posted
  09:05 → status back to To Do 12:15)". Do not editorialize about whether
  that gap represents focused effort or the ticket just sitting untouched
  while you were doing something else — report the timestamps and let the
  gap speak for itself.

  **Open vs. closed gates.** A gate only has a real duration once its
  closing event has actually happened (the re-queue transition, the
  epic-move, etc.). If a ticket has reached the *opening* event for a gate
  (a bounce, a Refined Spec comment) but the closing event hasn't happened
  yet as of this run — e.g. research-loop just finished and posted the
  comment, and you haven't promoted/re-queued it yet — that gate is
  **open, not zero and not skippable**. Report it as "<gate name> gap: open
  — <from-event> at <ts>, <Xh Ym> elapsed as of this check" (compute
  elapsed against the time you're running this analysis, not against
  nothing). Do not: (a) omit the ticket from the report because its gate
  hasn't closed, (b) treat an open gate as a completed duration by
  measuring against "now" and calling it final, or (c) block Step 0's
  readiness gate on it — an open human-gate is exactly the "settled, not
  actively running" state that gate expects for 📝/🔁/🔄 tickets (nothing
  further happens until you act; there's no risk of reading a half-written
  `runs.jsonl` line). When you re-run this skill later and the gate has
  since closed, replace the "open" figure with the real closed duration —
  don't leave both.

  Sum each gate type separately for a sub-batch total, and when summing,
  keep open and closed gaps visibly distinct — don't average an open gap's
  elapsed-so-far time in with closed gaps' final durations, since that
  understates the closed ones and overstates nothing meaningful for the
  open one (it'll only grow). State the sub-batch total as e.g. "closed:
  41m (1 ticket); open: 2 tickets awaiting action, elapsed 3h11m and 0h48m
  as of this check" rather than blending them into one average (don't merge
  bounce-review + promotion + rework + PR review into one number either —
  they're different decision points and blending them hides which gate is
  actually the slow one). Always show these totals separately from loop
  time/cost, never blended into the same "combined" figure Step 3 writes
  for research-loop/dev-loop phases — this is human calendar time, not
  compute time, and conflating the two would misrepresent both.

  **PR review gap is almost always open when this skill runs.** A PR
  landing and then sitting in review for a few days is the realistic,
  expected case — not an anomaly to flag. Check every ✅ Landed ticket's PR
  state on every run (not just the first time it's classified) via
  `gh pr view <pr> --json state,mergedAt`: `state: "MERGED"` closes the
  gate (report the real duration and move the ticket to the merged tracker
  below); `state: "OPEN"` keeps it open (report elapsed-so-far, same as any
  other open gate). A ticket sitting open in review across multiple
  sub-batch runs is not a problem this skill flags or escalates — it's just
  reported, same as any other open gate, until it closes.
- **`red_confirmed` rate**: fraction of this sub-batch's dev-loop landed
  runs where `red_confirmed: true`.
- **Outcome distribution**: count of tickets in each Step 1 classification,
  for this sub-batch specifically (not the whole 13-ticket batch).
- **Cache tokens**: report `tokens.in`/`tokens.out` as currently logged. If
  the fresh/cache_creation/cache_read split has not been added to
  `claude-usage.ts` yet (check by reading that file — if it still combines
  the three into one `tokens.in` number), do not attempt to back it out —
  report the combined number and state plainly that the cache split isn't
  available yet, per the caveat already on the Confluence page. Never
  estimate or guess a cache-read fraction from token totals alone.
- **A `runs.jsonl` line with `cost_usd: 0` and `tokens: {in:0, out:0}` on a
  run that clearly ran for real (non-trivial `ended - started`, or a real
  `verdict.json`/PR) is not a genuinely free run** — `extractUsage()` in
  both repos deliberately returns zeros when `claude -p`'s stdout fails to
  parse as JSON, rather than throwing, so this is what a parse failure
  looks like in the log, not a $0 API call. Both repos now persist the raw
  `claude -p` stdout to `.pipeline/<slug>/raw-usage/<TICKET>-<timestamp>
  .json` unconditionally before attempting to parse it (fixed 2026-09-02 —
  `research-loop` commit `99043f0`, `dev-loop` commit `64f20e4`; prior to
  this fix, a parse failure lost the real usage number permanently, since
  stdout only ever lived in a local variable). For a zero-cost line from
  *before* that fix: check whether
  the Bedrock/Fluency usage dashboard
  (https://developer-bedrock-platform.fandango.com/fluency) still retains
  a request-level record for that ticket's timestamp window and can
  supply the real figure — but for any run after the fix, check
  `raw-usage/` first, since it has the exact original response.

  **Check `skill_version` before assuming a recoverable parse failure.** A
  line with `skill_version: "manual"` (not a real git SHA) means the
  ticket was landed or bounced by hand in an interactive Claude Code
  session, not by `claude -p` — there is no `raw-usage/` entry and no
  Bedrock/Fluency record to go find, because no headless call ever
  happened. Its `cost_usd: 0` is genuinely unrecoverable, not a parse
  failure — read the `detail` field for what actually happened and why
  the cost is untracked, and report it as "manual, cost not captured"
  rather than spending time hunting for a number that doesn't exist.
  First seen on TARS-1399 (2026-09-02): two automated `ticket-to-pr` runs
  bounced `verify_rejected` (their `cost_usd`/`tokens` are real, from
  `raw-usage/`), then a human reproduced and fixed the qa-agent's
  remaining finding by hand and ran `push-branch` directly, skipping
  `claude -p` entirely for that final landing.
- **T-shirt size, retroactive, per landed ticket**: every ticket in this
  batch is story-pointed at 3 in Jira — that's a planning-time estimate,
  identical across all 13, and useless for checking whether cost/time
  actually tracked with how much work a ticket turned out to need. Once a
  ticket lands, size it retroactively using its **PR diff**, not the
  loop's own cost or time — diff size is an objective, independently-
  verifiable signal (`gh pr view <pr> --json additions,deletions,
  changedFiles,files`); loop cost is exactly the thing you're trying to
  sanity-check against a size, so it can't also be the size.
  - **XS**: ≤20 changed lines, 1-2 files, no new files.
  - **S**: ~20-100 changed lines, 2-4 files, at most one new file.
  - **M**: ~100-250 changed lines, 3-6 files, may include a new
    module/endpoint.
  - **L**: 250+ changed lines, 6+ files, or multiple new
    files/modules/endpoints.
  These thresholds were calibrated from this batch's first 4 landed
  tickets (see the Confluence page's T-shirt sizing table for the actual
  numbers) — treat them as a starting point, not a fixed law; if a later
  sub-batch's tickets cluster oddly against these bands, it's fine to
  widen/narrow a band, but do so explicitly (note the change and why) so
  the sizing stays comparable across sub-batches rather than silently
  drifting per-run the way Step -1 already guards against for other
  assumptions.

  **The point of sizing is the cost/size relationship, not the size
  alone.** For each landed ticket, report size next to combined cost and
  combined time, and flag anything where they visibly don't track — e.g.
  an XS-sized ticket with an L-sized cost is a signal to look at *why*
  (retries, `agent_error` failures eating cost before the real landing
  run — check `retries`/failed run lines for that ticket) rather than
  evidence the ticket was secretly complex. Don't silently accept a
  mismatched cost as "this one was just harder" without checking the run
  history first.

Do not silently drop a ticket that's blocked/pending/not-started from these
averages by pretending the sub-batch was smaller than it is — report the
denominator you used (e.g. "cost/time figures below are for the 3 of 4
tickets that landed; TARS-1391 is still blocked, see tracker") so a reader
can't mistake a partial average for the full sub-batch's number.

**PR review tracker** (separate from the Blocked/pending tracker, which is
only for non-landed states): every ✅ Landed ticket gets a row here — add it
the run it first lands, keep updating it until `state: "MERGED"`. Columns:
Ticket, PR (link), Opened (`createdAt`), Merged (`mergedAt`, or "open — Xh
elapsed" per the open-gate format), PR review gap. Once merged, the row
stays (don't delete it) — it's the historical record of how long that PR
sat in review, and feeds the Epilogue's "Time, PR merged → deployed to INT"
once that stage is reached.

## Step 3 — write back to Confluence

Read the current page fresh (`action: "read"`) immediately before writing —
do not reuse an earlier read from this conversation, in case someone else
edited it. Then update, via `action: "publish"` with the full merged body:

1. **This sub-batch's ticket table** — fill in `Outcome` (using the emoji
   legend already on the page) and `PR` (link, if landed) for each ticket.
2. **Sub-batch log row** for this sub-batch — `Date run` (today, or the
   actual run date if known), `Landed` count, `Blocked/pending` count
   (even if 0 — write "0", don't leave it blank), and a one-line `Notes`
   summarizing anything notable (a bounce, a slow ticket, a cost outlier).
3. **PR review tracker** — add or update a row for every ✅ Landed ticket
   (match by ticket key, don't duplicate). Fill `Opened`/`Merged` from
   `gh pr view <pr> --json createdAt,mergedAt,state`, and `PR review gap`
   with the per-ticket figure from Step 2 (open format if not yet merged).
   Do not remove a row once a PR merges — leave it as the closed record.
4. **T-shirt sizing table** — add or update a row for every ✅ Landed
   ticket (match by ticket key). Columns: Ticket, PR diff (`+X/-Y, N
   files`), T-shirt size (per Step 2's bands), Combined cost, Combined
   time, Tracks? (Yes, or a short note like "No — 13 failed dev-loop
   attempts before landing, see run log" when size and cost visibly
   diverge). This is a running table across the whole batch, not a
   per-sub-batch subsection — append rows, never remove one.
5. **Blocked/pending tracker** — add a row for every ticket in 🚫/📝/🔁/🔄,
   or update its existing row if one's already there for a prior
   sub-batch's check-in (match by ticket key, don't duplicate). Fill
   `Since` with the timestamp of the run line that produced the block, and
   `Bounce/block reason` with the concrete evidence from Step 1 — not just
   the category label (for 🔄, this is the quoted human directive). Fill
   the `Human gate gap` column with the per-ticket figure from Step 2 —
   if that ticket's gate is still open, write it exactly as Step 2's open
   format (e.g. "promotion gap: open — Refined Spec posted 14:32, 3h11m
   elapsed as of this check"), not a blank cell and not a fabricated final
   number. Set `Resolved?` to blank/No unless you can confirm it's since
   moved past that state — note that a 🔄 row can be "Resolved: Yes" once a
   newer research-loop run exists for it (it's moved on to a fresh
   outcome), even though the original bounce it grew out of never got a
   code fix. An open-gate row is never "Resolved: Yes" — by definition
   nothing has moved it forward yet.
6. **A new subsection under "KPI framework" → "1. Time & cost"** — add
   `#### Sub-batch N results (computed <today's date>)` with the actual
   numbers from Step 2, in the same table shape as the template above it
   (research-loop phase / dev-loop phase / combined columns), plus separate
   lines/rows for this sub-batch's total bounce-review gap, total promotion
   gap, total rework gap, and total PR review gap (each named individually,
   none folded into the combined column or into each other — see Step 2's
   "Human gate timing"). For any gate type with at least one still-open
   ticket, report closed and open counts/totals separately in that line
   (per Step 2's "Open vs. closed gates") rather than one blended average —
   PR review gap in particular will very often be all-open, and that's
   expected, not a gap in the data. Append rather than overwrite any prior
   sub-batch's results subsection — and when a later run finds a
   previously-open gate has since closed, update that subsection's figure
   in place rather than leaving a stale "open" number next to a newer one.
7. If this sub-batch surfaced anything for the "Landing & quality signal"
   bucket (an outcome distribution worth noting, a `failure_category` that
   recurred) — add a one- or two-line note under that section referencing
   this sub-batch, rather than duplicating its whole table.

Use a `versionMessage` naming the sub-batch, e.g. `"Sub-batch 2 results:
2/3 landed, 1 blocked (spec_ambiguous)"`.

## Guardrails

- Never fabricate a number. If a field is genuinely unavailable (no cache
  split, a ticket has no run line yet, a PR has no reviews yet), say so in
  the table rather than leaving a cell that looks like real data but isn't,
  and rather than inventing a plausible-looking placeholder.
- Never mark a ticket ✅ Landed without a real `pr` URL from its run line.
- Never resolve a Blocked/pending tracker row to "Resolved: Yes" without a
  newer run line or Jira state change actually showing it moved past that
  state.
- Never mark a PR review tracker row's `Merged` cell without `gh pr view`
  actually returning `state: "MERGED"` for that PR — an open PR sitting in
  review for days is the expected case, not something to round up to
  "basically done."
- Never size a ticket by its loop cost/time or by its Jira story points —
  size comes only from the landed PR's actual diff (Step 2's T-shirt
  bands). Cost/time are what you're checking *against* the size, not
  inputs to it — sizing a ticket by its own cost would make "tracks?"
  meaningless by definition.
- If Step 0's gate fails, that is the entire output of this run — do not
  partially write results for the tickets that ARE settled while others in
  the sub-batch are still in flight. Wait for the whole sub-batch.
- This skill is read-mostly: it reads two local repos' `runs/*.jsonl`
  files, reads Jira, reads git worktree state, and writes to exactly one
  place — the Confluence page. It does not edit files in `research-loop`,
  `dev-loop`, or `webtarsthree`, and does not transition Jira tickets
  (that's the loops' own job).

## Output

After a successful write, report to the user in the chat:

- Which sub-batch, and whether it's fully landed, partially blocked, or a
  mix.
- The headline KPI numbers (combined time and cost for the sub-batch).
- Anything in the Blocked/pending tracker that's new this run, with its
  reason, so the user knows what — if anything — needs a human decision
  before the next sub-batch or before this ticket can retry.
- Each newly-landed ticket's T-shirt size next to its combined cost/time,
  and whether they track — call out any mismatch (e.g. an XS ticket with
  an outsized cost) with the likely cause from the run history, not just
  the fact of the mismatch.
- How many landed PRs are still open in review vs. merged (PR review
  tracker), with elapsed time for the open ones — reported plainly, not as
  an alarm; a PR sitting open for a few days is expected, not a problem to
  flag as unusual.
- The Confluence page link.
