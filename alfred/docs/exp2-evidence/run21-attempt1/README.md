# Issue #21, attempt 1 — the run that found the label join

The first Alfred run sourced from a real GitHub issue. Kept because the verdict was
wrong and the artifact was right, which is the only combination that tells you
something about the gate rather than about the worker.

    cost        $1.831013   (matches the vendor price table to 6dp, independently)
    duration    358s
    worker      exit 0, `npm test` green on its own tree
    verdict     FAIL — ac_unmapped x4
    reality     all four ac_map commands PASS when run by hand

The worker keyed its entries `AC-1..AC-4`; ids are minted positionally as
`AC1..ACn`. Every criterion went unmatched, so the gate reported four unmapped
criteria against a diff that satisfied all four. Fixed in the commit that adds the
label index to `resolveAcs`.

## Files

- `SKILL.md.worker-output` — the graded artifact as the worker left it (+27/-5)
- `SKILL.md.diff` — the same change as a diff against the baseline
- `ac-map.json` — the worker's `.alfred/ac-map.json`, verbatim

## What this run does NOT establish

`gate_pass: true` has still never been observed on a real run. This run came one
string mismatch away from it; that is not the same as reaching it. Attempt 2 runs
the same ticket under the fixed join to find out.
