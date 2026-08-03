
## §2.6 count will go stale if arm B writes another record (noted 16:16Z)

Two more commits landed on `alfred/foundation` while arm B was live: `75dcbcd`
(wall-cap clock) and `7027336` (AC3-lint classification). No record has been written
since — `implement`'s record.json was stamped 08:56:40 local with `2e9593d`, both
commits landed after 09:14. So §2.6's "three distinct shas across four records" is
still accurate *as of this moment*.

But if arm B writes a review or PR phase record from here, it stamps `7027336` and the
count becomes four. Rather than correct §2.6 now — which would add a *fifth* sha and
recreate the exact loop the section describes — no further commits until the arm exits.
The count gets reconciled once, from the final set of records, in the results doc.

This is the second time the fix for a measurement defect is itself a write to the thing
being measured. The general form for Alfred: **the harness_sha must be captured once at
run start and carried, not re-resolved per phase.** A per-phase `git rev-parse` makes
provenance a function of when the phase happened to run, which is not what provenance
means.
