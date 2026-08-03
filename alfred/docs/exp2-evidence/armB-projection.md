# Arm B pace projection — recorded BEFORE the wall cap could fire

Written at 15:41, 26 min into arm B, with phase 2 of 4 just started. Recorded now so
that if the 90-minute wall cap fires, the reasoning is not retrofitted to the kill.

## Measured

| phase | start | end | wall | status |
|---|---|---|---|---|
| pipeline (tick) | 15:15:43 | — | — | attempted |
| intake | 15:16:58 | 15:39:25 | **1,346,614 ms = 22.4 min** | **succeeded** |
| plan | 15:40:51 | — | — | attempted |

Cost after intake: **$0.731** (watchdog, transcript-derived).

## Projection

Intake is the cheapest of the four phases by design — it reads and writes one
manifest. Plan, implement, and review each do strictly more. If all four merely
MATCH intake's 22.4 min, the run lands at **~90 minutes**, which is exactly the
pre-registered `armB.wallCapMs`. If implement takes longer than intake — the likely
case, since it edits files and runs tests — the cap fires before review completes.

Cost projects to roughly **$3–5** at four intake-equivalents, comfortably under the
$18 spend cap. **So the wall cap, not the spend cap, is the operative bound** — which
is what §2.5 already concluded for a different reason.

## What a wall-cap kill would and would not mean

It **would** mean: on this ticket, the four-phase topology did not reach a PR inside
90 minutes, having spent ~22 minutes to produce a manifest. That is a finding about
throughput, and throughput is the whole reason a `/loop` that checks every n minutes
exists.

It **would not** mean the pipeline is incapable of the work. Intake succeeded and its
manifest is the best artifact either arm produced. A kill at the cap says "too slow
for the goal," not "wrong."

**Recorded prediction, before the fact:** arm B will not reach a merged-ready diff
inside the cap, and will be killed at 90 minutes somewhere inside implement or
review. If it instead finishes all four phases and delivers a scored diff, this
prediction is wrong and that goes in the results doc.
