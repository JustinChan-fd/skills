# Issue #21, attempt 2 — aborted by the operator, not graded

Killed ~1 minute in, after the worker had rewritten `SKILL.md` (+41/-8) and before
it wrote an ac_map. No verdict, no cost figure, nothing to score. Kept only for the
reason it was aborted, which is a property of the harness worth writing down.

## Why it was aborted

`collectDiff` builds `diffstat` and `touched` from `git diff` against **HEAD over the
whole working tree**, plus untracked files. It cannot distinguish the worker's edits
from anything else already dirty in the tree.

Uncommitted work of the operator's own — the #13 changes to `alfred/lib/gate.mjs`
and `alfred/test/` — was therefore sitting in the tree the gate was about to score.
Both paths are `off_limits` in `.alfred/config.json`. The run was heading for a
`scope_violation` (and an `instrument_modified`) attributing the operator's edits to
the worker: a FAIL that says nothing about the worker and nothing about the join fix
the run existed to test.

## The rule this establishes

**A run must start from a clean tree.** The gate scores the tree, not the spawn, so
anything dirty at spawn time is indistinguishable from delivered work. This is the
same reason the run directory lives outside the repository — `source.json` under the
repo root would be counted as delivered work — and the reason generalises past that
one file.

Worth noting the failure mode is confined to the operator's own hygiene and does not
soften the gate: a dirty tree makes the gate stricter, and inventing findings against
a worker that did nothing wrong is a false FAIL, the same direction as the #21 join
defect itself. The harness has no way to tell, which is the actual gap. A pre-flight
refusal on a dirty tree — the same shape as refusing without a config — would close
it, and does not exist yet.
