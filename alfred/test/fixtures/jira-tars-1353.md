Bring `docs/modules/hasher.md` up to a runbook that Product and Devs can both use for the **Discovery Hash ID Tool** module.

This is documentation only. No client or server code changes.

## Current state

* `docs/modules/hasher.md` exists at 39 lines, with these sections: `## Purpose`, `## Access`, `## Features`, `## External Services`, `## Key Business Rules`, `## Structure`, `## Working Here`.
* `## Client Routes`: **missing**. The module serves 1 client route(s).
* `## Server Routes`: **missing**. `src/server/app.js` registers 0 `/api/hasher` endpoint(s) — this module is client-only and uses the `fd-hashid-utils` library in the browser.
* `## Prerequisites`: **missing** — no module doc has one yet.

## What to write

* **What the module is** — what the Discovery Hash ID Tool does and who uses it.
* **Pages / routes** — a table of every client route and what that page does.
* **Server routes** — state plainly that there are none, and why.
* **Prerequisites** — the AD group needed for access (none — any authenticated user), plus every service this module is hooked up to.
* **Current-state overview** — how the module works today, not how it should work.

Keep it a general runbook for Product and Devs. Do not narrate individual files or walk through code.

## Acceptance Criteria

* `docs/modules/hasher.md` has a `## Client Routes` section AND every one of the 1 client route(s) below appears in the file — verify with: `grep -q "^## Client Routes" docs/modules/hasher.md && for p in /hasher; do grep -q "$p" docs/modules/hasher.md || exit 1; done`
* `docs/modules/hasher.md` states that the Discovery Hash ID Tool registers no server routes because it is client-only — verify with: `grep -qi "client-only" docs/modules/hasher.md`
* `docs/modules/hasher.md` has a `## Prerequisites` section naming the AD group required to reach `/hasher` and every external service the module calls — verify with: `grep -q "^## Prerequisites" docs/modules/hasher.md`
* `docs/modules/hasher.md` still has every section it has today (`## Purpose`, `## Access`, `## Features`, `## External Services`, `## Key Business Rules`, `## Structure`, `## Working Here`) — nothing is deleted to make room — verify with: `for h in "Purpose" "Access" "Features" "External Services" "Key Business Rules" "Structure" "Working Here"; do grep -q "^## $h" docs/modules/hasher.md || exit 1; done`
* The repository test suite still passes — verify with: `npm test`

## Out of scope

* Any change under `src/`.
* Renaming or moving the doc.

