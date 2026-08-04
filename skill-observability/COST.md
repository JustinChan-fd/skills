# How a run's cost is built up

Everything here is measured on this machine: 36,794 deduplicated API calls across
435 session transcripts. Where a number appears, it came from a script over that
corpus, not from a vendor doc. The one thing taken on faith is the *existence* of
a 5-minute cache TTL — and even that boundary was confirmed independently below.

## 1. The simple formula, and the one thing it's missing

You already have the right instinct: cost is rate × tokens. That is genuinely all
it is. The complication is that there are **four** token counters per call, not
two, and they bill at different multiples of one base rate.

Every API call reports:

| counter | what it is | rate |
|---|---|---|
| `input_tokens` | tokens sent that were **not** cached | 1x input |
| `output_tokens` | tokens generated | output rate (~5x input) |
| `cache_creation_input_tokens` | tokens **written into** the cache | **1.25x input** |
| `cache_read_input_tokens` | tokens **read from** the cache | **0.1x input** |

```
cost = input×R_in + output×R_out + cache_write×(R_in×1.25) + cache_read×(R_in×0.1)
```

That's the whole model. No hidden terms. `lib/pricing.mjs` is those four lines.

**The one fact that makes cache confusing, stated plainly: reading a cached token
costs 1/12.5 of writing it.** 0.1x vs 1.25x. So the same conversation content can
bill at wildly different prices depending on whether the cache was alive when the
call happened. That single 12.5x ratio is the source of every surprising cost
number in this system.

## 2. Why the cache exists at all

A conversation resends its entire history on every call. By turn 50 you are
re-sending 100K+ tokens of context you already sent 49 times.

The cache lets the provider keep that prefix and charge 0.1x to reuse it. The
catch: **entries live 5 minutes from last use.** Keep talking and it stays alive
and cheap. Pause 6 minutes and it's gone — the next call re-sends the whole
prefix at 1.25x to establish a new entry.

So a session has a heartbeat. Active work rides a warm cache at 0.1x. Every pause
longer than 5 minutes costs one full re-write of your entire context.

Measured, per call, bucketed by idle gap since the previous call:

| gap | cache WRITE | cache READ | marginal |
|---|---:|---:|---:|
| 0–15s | 1,941 | 115,227 | **7,670** |
| 60–120s | 4,536 | 111,349 | 13,220 |
| 240–270s | 9,020 | 99,438 | 20,226 |
| 270–300s | 14,290 | 90,583 | 22,651 |
| **300–330s** | **25,728** | 85,746 | **31,380** |
| **330–420s** | **55,896** | 58,685 | **63,636** |
| 600–1800s | 78,609 | 24,525 | 89,030 |
| ≥ 2h | 70,339 | 5,860 | 87,110 |

Read the write and read columns as a seesaw: they trade off, because context you
don't read you must write. The cliff sits exactly between 300s and 330s, which is
the documented 5-minute TTL confirmed from the other direction — I did not assume
it, I found it.

## 3. What `marginal` measures, and what it doesn't

Split the four counters by **who caused the spend**:

```
marginal      = input + output + cache_write     "what this run caused"
context_carry = cache_read                       "the tax on conversation length"
total         = marginal + context_carry         actual money
```

**`marginal` is the cost of the work the run did.** It's the tokens the run
generated, the new tokens it sent, and any cache it had to establish.

**`context_carry` is the cost of *where* the run happened.** Re-reading 120K
tokens of prior conversation at 0.1x is real money, but a skill invoked at turn 90
did not choose to have 90 turns of history in front of it. It would carry the same
tax if it did nothing at all.

The reason to separate them: **`total` cannot answer "is this skill efficient?"**
Run the same skill at turn 5 and turn 500 and `total` differs several-fold purely
from carry. `marginal` strips that out.

**What `marginal` does NOT strip out — and this is the part I got wrong first —**
is the cache-write spike. `cache_write` sits inside `marginal`, so a cold run's
one-time cost of establishing the cache lands in the metric that's supposed to be
comparable. Cold runs measure ~8x warm ones on `marginal`. Hence
`marginal_comparable`, which is true only when `cache_state` is `warm`.

## 4. Answering your screenshot

The screenshot claims: *fresh pays 1.6x more cache write, deep pays 1.74x more
cache read, they land in different buckets, so marginal is flat at ~9,600–11,900
at every depth.*

**The mechanism is right. The conclusion is wrong, and I'd already half-corrected
it before you asked.**

Two errors compounded:

**Error 1 — coarse buckets.** That table used 100-line buckets. `0–99` averaged a
spike at the very start against ~90 cheap lines after it. Re-bucketed finer,
marginal at lines 5–9 is **45,619**, not ~10,400. The claim "flat at every depth"
was an artifact of bucket width. I corrected this to "flat past line 25."

**Error 2 — the axis itself.** Correcting the buckets wasn't enough, because *line
depth was never the cause.* Crossing depth against idle gap:

| | gap < 5 min | gap ≥ 5 min |
|---|---:|---:|
| line < 25 | 9,713 | 18,355 |
| line 25–399 | **7,759** | **67,948** |
| line ≥ 400 | 9,951 | 82,264 |

Read down the warm column: 9,713 / 7,759 / 9,951. Depth spans 0 to 5,000+ lines
and marginal doesn't move. Read across either row: 8x.

**Line depth correlated with cost only because a session's first calls are the
ones most likely to follow a long human pause.** Depth was a proxy for idle time.
The screenshot's "different buckets" reasoning describes a real seesaw — it just
attributed it to the wrong variable.

So `invocation_depth_lines` is still recorded, but it is provenance, not a
predictor. `idle_ms_before_invocation` and `cache_state` are what predict cost.

## 5. Your three cases

**Existing session, actively working** (you've been talking; you invoke a skill)

`cache_state: warm`. The prefix is live, so the skill reads it at 0.1x. Marginal
~7,700–13,000 tokens/call. `total` is inflated by carry proportional to
conversation length, `marginal` is not. **Comparable.** This is the cheap case and
the common one — 96.3% of all calls in the corpus.

**New session** (fresh terminal, `claude`, invoke a skill)

`cache_state: cold`, because nothing is cached yet — this run *writes* the cache.
Measured 35,174 write / 24,372 read / **41,641 marginal** for a session's first
call. Low carry (nothing to re-read), high marginal (establishing everything).
**Not comparable on marginal**, and this is exactly the case my depth rule got
right by accident.

Worth knowing: a fresh run's cost is also *cleanly attributed* — there's no prior
turn in the window to contaminate it. Fresh runs are attribution-clean and
cost-inflated at once.

**Resumed session** (`claude --resume`, or coming back after lunch)

`cache_state: cold`, and **this is the case the depth rule got actively wrong.** A
resumed session appends to the same transcript, so its line index stays high — my
committed rule labeled it `steady` and declared it comparable while it paid
**96,680 marginal tokens/call** (n=67, gap > 1h). Eight times a warm call, waved
through as the most comparable tier.

It's the worst case of the three: the cache is dead *and* the context is long, so
it pays a full re-write of a large prefix. A resume at turn 200 costs
substantially more than a fresh start.

There's a fourth case worth naming since it's the same mechanism: **you walk away
mid-session for 10 minutes and come back.** The transcript shows no break, the
line index is deep, but the TTL expired. Same as a resume. This is why the field
is `cache_state` rather than `session_kind` — the thing that matters is cache
liveness, and it isn't visible in how a session was started.

## 6. Why time, and not the token counts themselves

The obvious alternative: read `cache_write` vs `cache_read` off the call and infer
coldness. I tested it against ground truth (gap ≥ TTL, or first call):

| rule | precision | recall |
|---|---:|---:|
| `read === 0` | 86.0% | **51.8%** |
| `write > read` | 71.9% | 57.6% |
| `write > read × 0.25` | 47.3% | 67.1% |
| `write > read × 0.1` | 40.0% | 75.6% |

The best rule misses **half** of cold calls, and loosening it trades precision
away without reaching useful recall. Composition is a *symptom* of a cold cache,
diluted by partial hits and multi-breakpoint prefixes. Elapsed time is the
*mechanism*, and it's exactly measurable from timestamps. Classify on the
mechanism.

## 7. One trap, because it nearly made the field useless

The idle gap is measured from the last call **before** the invocation. But the
invoking call *straddles* the boundary: it is the call that emitted the `Skill`
tool_use, and a single `message.id` spans several transcript lines a few
milliseconds apart. On both real records the row immediately "before" the
invocation was the invocation's own call.

Measuring against it gives a ~3ms gap, so **every mid-session run would report
`warm`** and the field would carry no information whatsoever. The fix excludes
the invoking call's whole dedup group, not just the boundary line — the same trap
that bit the attributed/unattributed split.

Worth naming because this was found by replaying real records, not by a test. The
unit tests were green and the logic read correctly; only the actual transcript
showed a 0.0s gap where an hour of wall-clock had passed.

## 8. Fields on the record

Under `computed.attribution`:

| field | meaning |
|---|---|
| `idle_ms_before_invocation` | gap the cache had to survive. The predictor |
| `cache_state` | `warm` \| `cold` \| `unknown` |
| `marginal_comparable` | true only when `warm`. `unknown` is not a licence to compare |
| `invocation_depth_lines` | absolute session line. Provenance, not a predictor |
| `attributed` / `unattributed` | the run's own spend vs the turn's pre-invocation tail |

`unknown` means the gap couldn't be measured — a window that opened on the
invocation with no carried timestamp. Reported honestly rather than guessed,
because guessing `warm` is precisely what silently declares a resumed run
comparable. The hook carries `last_call_at` across firings to keep this rare.

## 9. Reading the dashboard

Two cost columns, one badge:

- **`attributed.cost.total_usd`** — real money. Sums correctly. Needs no footnote.
- **`attributed.cost.marginal_usd`**, labelled *"skill cost"* — the efficiency
  number. Only this column is comparable, and only when warm.
- **A ❄ badge when `cache_state` is cold**, reading *"cold cache — includes
  one-time context setup."* The badge is the whole point: nobody needs to learn
  what marginal means, they need to know why a row costs 8x.
- When `marginal_comparable` is false, the trend line **skips the point** rather
  than dropping the row. Cold runs are real spend, just not valid datapoints for
  "is this skill getting cheaper?"

`context_carry_usd` is not a column. It's the difference between the two and
surfacing it invites the "which is the real number?" question. Row detail only.

## 10. What this is measured on, and what would invalidate it

- 36,794 deduplicated calls, 435 transcripts, one machine, one user, through the
  Keystone Bedrock gateway.
- The gateway sets the 5-minute TTL and likely rejects explicit cache
  breakpoints. **A 1-hour-TTL deployment would move the cliff** — the code reads
  `CACHE_TTL_MS`, so re-measure the gap sweep before trusting it elsewhere.
- Multipliers (1.25x / 2x / 0.1x) are vendor terms in `lib/pricing.mjs`, not
  derived here. The 1-hour write multiplier (2x) is implemented but essentially
  unexercised in this corpus.
- "Deduplicated call" means unique `message.id` per model — 6,222 of 11,805 rows
  in one sample shared an id. Counting rows instead of calls inflates
  per-call figures.
- Cold-call sample sizes are small in the tail (n=67 for gap > 1h, n=105 for
  30–120min). The 8x effect is robust; the exact tail figures are not.
