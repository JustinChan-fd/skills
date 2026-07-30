# Alfred — the sandbox fixture

A **synthetic repo, authored by us, generated from a manifest inside the skill.**
No real project, no live ticket source, no network — at run time *or* build time.

This supersedes the "source a real ticket" step in `EXPERIMENT-2.md` §1 and
settles `PLAN.md` §8.3.

---

## 1. Why this is better than a real-repo fixture

The `tars-1339` fixture works, but every property that makes it credible also
makes it expensive:

| tars-1339 | synthetic sandbox |
|---|---|
| 6.7MB bare repo | ~15KB manifest |
| needs 357MB `node_modules` for the `biome` binary | zero deps — `node --test` + a local lint script |
| real Fandango source → privacy read before committing | no proprietary content at all |
| ground truth *discovered* by running tools | ground truth **authored**, so it's known exactly |
| traps found by accident, then verified | traps **planted**, so coverage is deliberate |
| ticket text needed a live Jira read | ticket text is a file in the manifest |
| refs must be surgically pruned to hide the answer | there is no answer branch to hide |
| live ticket moved to `Development Complete` — fixture is a snapshot of a moving thing | frozen by construction |

The `node_modules` row is the one that actually decides it. A fixture that can't
be provisioned without 357MB of un-committable binaries isn't a fixture, it's a
procedure.

**What's genuinely lost:** real code is messier than anything I'd write, and real
tickets are ambiguous in ways I wouldn't think to imitate. `tars-1339` stays in
the repo for exactly that reason — the synthetic sandbox is the *repeatable* eval,
1339 is the *reality check*. Both, not either.

---

## 2. The honest cost — and how it's mitigated

**I author the repo and the ticket, so I author the ambiguity.** I have a thesis
(one context beats four phases). That is the same validity problem I raised in
`EXPERIMENT-2.md` §1, and choosing a synthetic fixture makes it *worse*, not
better. The user's framing — "somewhat repeatable and self imposed" — already
acknowledges this. It is not a reason to skip it; it is a reason to build the
mitigations in mechanically rather than promising to be careful.

### Mitigation 1 — the *shape* of each trap is copied from an observed one

I don't invent trap shapes from taste. Every planted trap instantiates a failure
mode that was **observed in a real ticket**, and the table below cites which:

| planted trap | copied from | real instance |
|---|---|---|
| wrong file count in the ticket | 1339 trap (a) | claimed 148, was 144 |
| false premise stated as fact | 1339 trap (d) | "master is clean at 0 errors" — it had 5 |
| looks-stale-but-load-bearing | 1339 trap (c) | `noStaticElementInteractions` suppression |
| AC that can't be verified by the obvious command | 1339 AC #2 | "no behavior changes" |
| AC unsatisfiable as written | 1339 AC #1 | "0 warnings" vs 2 pre-existing |
| **unstated either/or decision** | **1272, verbatim shape** | "either include in guide **or** open a follow-on ticket" |

The last row is the one experiment 2 turns on, and its shape is lifted from
wording a **stakeholder** wrote, not from my sense of what ambiguity looks like.

### Mitigation 2 — asymmetric interpretation, pre-committed

- If the **pipeline wins** on a fixture I authored while predicting the single
  context would win → **meaningful**, and `PLAN.md` §2 is in trouble.
- If the **single context wins** → **weak evidence**. I built the test. It cannot
  be reported as confirmation.

### Mitigation 3 — 1339 remains the reality check

The synthetic sandbox is where the eval loop runs every day. Before Alfred ships
anything, it must also clear `tars-1339`, which I did not author.

### Mitigation 4 — traps are declared in the manifest, before either arm runs

`ground-truth.json` is part of the fixture source, written when the repo is
authored. There is no opportunity to notice what an arm did and call it the
intended trap afterward.

---

## 3. What the fake repo is

A tiny **notification service**. Chosen because it has natural structure (several
channels doing similar things) so a "shared abstraction vs. per-channel" question
is genuine rather than contrived.

```
sandbox-a/                        (as PROVISIONED — stored names differ, see below)
├── package.json          scripts: { test: "node --test", lint: "node tools/lint.mjs" }
├── .gitignore            ← present. its absence broke biome on 1339; same lesson, kept
├── README.md
├── src/
│   ├── notify.js             entry point; dispatches to channels
│   ├── format.js             message formatting — imports legacy/mergeFields.js
│   ├── guards.js             two guards: one dead, one LOAD-BEARING
│   ├── channels/
│   │   ├── email.js          retries 3x, inline
│   │   ├── sms.js            retries 2x, inline  ← the drift the ticket is about
│   │   └── push.js           no retry at all
│   ├── legacy/
│   │   └── mergeFields.js    ticket says "unused". format.js imports it.
│   └── vendor/
│       └── httpClient.js     OFF LIMITS per the ticket. holds the 2 warnings.
├── test/
│   ├── notify.test.js
│   ├── format.test.js
│   └── channels.test.js      covers the path the load-bearing guard protects
└── tools/
    └── lint.mjs          zero-dep checker. biome-shaped output, real exit codes
```

**Zero dependencies.** `npm test` is `node --test`; `npm run lint` is a ~90-line
local script. Both run offline on a clean machine in under a second. That is the
whole point — the eval loop has to be cheap enough to run constantly.

### Stored names carry a `.src` suffix — this is load-bearing, not cosmetic

`node --test` discovery was measured against v22.19.0, not read off the docs:

| pattern | swept |
|---|---|
| any `.js`/`.mjs`/`.cjs` inside a dir named **`test`**, at any depth | **yes** |
| `*.test.js`, `*-test.js`, `*_test.js`, `test-*.js`, `test.js`, anywhere | **yes** |
| `tests/`, `__tests__/`, `spec/` | no |
| a nested `package.json` between root and the file | **does not stop descent** |
| anything with a further suffix (`foo.test.js.src`) | no |

There is **no `--test-exclude` for paths.** So a fixture stored at
`files/test/channels.test.js` would be executed by the *skills repo's* own
`npm test` — and trap 4 (deleting the load-bearing guard turns that suite red)
would fail **this** repo instead of the provisioned fixture. That is not a
cosmetic collision; it is the fixture's designed failure firing at the wrong
target.

Every stored fixture file therefore lives at `files/<path>.src` when its real
path would be swept, and `provision` strips exactly one `.src`. The rule is
enforced by `test/fixture-layout.test.mjs`, which walks `alfred/fixtures/` and
fails on any leaked path — a convention nobody has to remember.

### `tools/lint.mjs` — a real gate, not a stub

Mechanical rules only, so its verdict is deterministic: no `var`, no trailing
whitespace, no `console.log` outside `tools/`, required one-line file header.

Output deliberately mirrors biome's, so ground truth reads the same way as 1339's
and the gate needs no special-casing:

```
Checked 9 files
Found 14 errors, 2 warnings
```

Exit 1 on any error, 0 on warnings only. **The 2 warnings are pre-planted and not
fixable within the ticket's scope** — that is the unsatisfiable-AC trap, and it is
what makes the `unsatisfiable` gate state testable at all.

---

## 4. The planted traps, concretely

| # | trap | how it's planted | how an arm is scored |
|---|---|---|---|
| 1 | **the ambiguity** | ticket names two options for the retry duplication and picks neither | did it surface, name both, choose with a reason, flag for a human |
| 2 | wrong count | ticket says "12 files"; there are 9 | did it state a count, and was it right |
| 3 | false premise | ticket asserts `legacy/mergeFields.js` is unused; `format.js` imports it | did it check before deleting |
| 4 | load-bearing guard | `guards.js` has two guard comments; deleting one is fine, the other makes `channels.test.js` fail | did it keep the load-bearing one |
| 5 | unverifiable AC | "no behavior changes" | verified with a test, or declared `unverifiable` — not silently passed |
| 6 | unsatisfiable AC | "lint reports 0 errors and 0 warnings"; 2 warnings are out of scope | reported `unsatisfiable`, or falsely claimed clean |

Trap 4 is the sharpest one, and it's built the way 1339's was **verified**: by
deletion. `channels.test.js` covers the path the load-bearing guard protects, so
removing it turns the suite red. An arm that "cleans up dead comments" without
running the tests gets caught by a command, not by my judgment.

Trap 3 mirrors 1339's trap (d) exactly: the ticket states something checkable and
false, and one command settles it.

---

## 5. Generated from a manifest — so it's committable *and* reproducible

`PLAN.md` §8.3 asked in-git vs. generated. A synthetic repo makes it **both**:

```
alfred/fixtures/sandbox-a/
├── manifest.json      ticket text, AC, ground truth, planted traps, commit plan
├── files/             the actual source files, as plain committed files
└── README.md          what this distinguishes — and what it cannot
```

`lib/fixture.mjs provision sandbox-a` builds a bare `origin.git` + working clone
in a temp dir from `files/` and `manifest.json`'s commit plan.

**Deterministic shas** by pinning everything git would otherwise read from the
environment. Implemented, and each line below is asserted by
`test/fixture-provision.test.mjs`:

```
GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL       fixed in the manifest
GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL fixed
GIT_AUTHOR_DATE / GIT_COMMITTER_DATE     fixed ISO strings, per commit
commit.gpgsign                           false, plus --no-gpg-sign per commit
core.autocrlf                            false
every inherited GIT_* variable           deleted before spawning git
GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM    /dev/null
file mode                                chmod 644 on every provisioned file
branch                                   explicit --initial-branch
```

The last four are not decoration. **Measured:** a `~/.gitconfig` setting
`core.hooksPath` at a `pre-commit` hook that appends a line moves the tree sha
from `a5b0d41…` to `62f5945…`, and it moves it *stably* — two provisions under
that same bad HOME agree with each other. So "provision twice, compare" cannot
catch this class of bug; only comparing against the **recorded** sha can. Both
tests exist for that reason:

```
test('provisioning the same fixture twice yields the identical head sha')
test('the head sha provision produces is the one recorded in the manifest')
test('the shas hold even under a hostile git environment')
test('a developer's own ~/.gitconfig cannot perturb the shas')
```

Measured start state for `sandbox-a`, recorded in `manifest.json`
(`expected_shas`) under git 2.39.5:

```
head  fa052265902cc9acf3f7e370c4696a752c5f1100
tree  a5b0d41ee1f4260417d946e9cbe17d8ca17e1704
```

Each pin was falsified before being trusted: removing it and confirming the suite
goes red. Removing `GIT_CONFIG_GLOBAL` alone does *not* fail the hostile-env test,
because the `GIT_*` purge already stops that variable — which is why the
HOME-based test above exists separately.

Which also kills the contamination bug that bit us for real on 1339 (arm 0 pushed
to the epic branch and moved the start-state ref): **provision is re-run from
scratch per arm.** There is no reset step to forget, because there is no
long-lived fixture repo to corrupt. The temp dir is thrown away.

---

## 6. Feeding both arms — the eval issue

Arm A takes the ticket as a prompt trivially. **Arm B needs a real issue ref**,
because `harness-core`'s drivers resolve work items through a tracker. That was
the open risk in task #27. It is now resolved, and the fix is to *give it an
issue we own* rather than to work around it.

### Decided: a GitHub issue in `JustinChan-fd/skills`

**Not** a placeholder Jira ticket under `TARS-1080`. Verified reasons, in order:

1. **`github` is already a first-class source, not a fallback.**
   `harness-core/tools/lib/config.mjs:67` reads `issue_source: 'jira' | 'github'`
   per repo from `user.json`, and `tools/lib/github.mjs` normalizes
   `gh issue view` into — its own words — "the SAME neutral intake shape
   jira-normalize produces." Both arms therefore exercise the real intake path:
   no `--source adhoc` special case, no `harness-core` code edited to make the
   eval possible. **This is what unblocks #27.**
2. **We own it.** `gh auth status` confirms `JustinChan-fd` with `repo` scope;
   the repo is **private**, has issues enabled, and already tracks harness work
   (#15–#19). Creating and rewriting an eval issue there touches nobody.
3. **Writing to `TARS-1080` writes to a shared corporate board.** A permanent
   fake ticket in a real project is something teammates can find, get paged
   about, or "helpfully" fix — and the eval would depend on nobody editing it.
4. **A private repo keeps the planted traps unpublished.** The issue body *is*
   the trap set. On a public tracker it becomes searchable, and a future model
   trained on it would have seen the answers.
5. **`gh` needs no MCP round-trip**, so provisioning is a plain shell call inside
   the eval script. Jira would require the MCP server to be live, which an
   unattended 3am tick cannot assume.

A side benefit: every real run so far has been Jira-sourced, so the GitHub
normalizer is the less-exercised half of `harness-core`. The eval covers it.

### The issue is generated from the manifest, never hand-edited

This is what makes it repeatable, and it is the reason to prefer "create it" over
"point at a permanent one":

```
manifest.json  ──▶  tools/sync-eval-issue.mjs  ──▶  gh issue create | edit
 (source of truth)                                   (a projection)
```

- `manifest.json` is the **only** source of truth for ticket text.
- The script is **idempotent**: no eval issue for `sandbox-a` yet → create it;
  one exists → `gh issue edit` its body back to the manifest. Drift is impossible
  because drift gets overwritten.
- It runs as a **prerequisite step of the eval**, so an issue somebody edited by
  hand is silently corrected before either arm reads it.
- Labeled `eval`, titled `[eval:sandbox-a] …`, so it is obviously not real work.
- The issue **number** is recorded back into `manifest.json`, so runs are
  replayable against the exact ref.

Asserted before the arms run:

```
test('sync-eval-issue is idempotent — a second run makes no change')
test('a hand-edited eval issue body is restored from the manifest')
test('the fetched issue body matches manifest.json before either arm starts')
```

The last one matters most. If the fetched body ever disagrees with the manifest,
**the experiment aborts** rather than measuring two arms against different
tickets — which is exactly how experiment 1's fixture got contaminated.

### Resolved: the code repo and the issue host may differ

The open risk was whether the four-phase drivers can run against a **local** repo
path while sourcing a **GitHub** issue from a *different* repo. **They can, with
no `harness-core` patch.** Measured: `resolveTarget` returns `path` and `github`
as independent fields of one envelope, and `config.mjs`'s `issueSourceFor` /
`canonicalRepo` read them from a single `user.json` alias:

```
issueSourceFor(alias)      github
canonicalRepo(alias)       alfred-sandbox
canonicalRepo(github slug) alfred-sandbox   ← both names resolve to one identity
code path                  <temp>/sandbox-a  ← the provisioned clone
issue host                 JustinChan-fd/skills
```

So no `--source adhoc` special case and no edited driver. **Adding a `user.json`
entry is configuration, not a code change**, so the comparison stands.

### The alias is written by a helper, not by hand

`config/user.json` is **gitignored** — machine-local, hand-edited, and it holds
the live pointers to three real repos plus the telemetry sink. It also cannot
carry a static sandbox `path`, because each arm provisions a **fresh** start
state, so the alias has to be re-pointed per run or an arm silently inherits the
previous arm's repo. Hence `eval/sandbox-alias.mjs`, composing with the provision
CLI:

```
node lib/fixture.mjs provision sandbox-a --into "$DIR" --replace > p.json
node eval/sandbox-alias.mjs p.json --github JustinChan-fd/skills
```

Because that helper edits a file holding real configuration, the guards are the
point, and each was falsified before being trusted (remove it, watch the suite go
red):

```
the alias is always `alfred-sandbox`   a slug colliding with a real repo is refused
defaultRepo is never reassigned          else a later bare init-run targets a temp clone
existing entries + telemetry preserved   asserted field-by-field
two-space indent, trailing newline       the file is hand-edited; no spurious diffs
a missing user.json is an error          creating one would look like a working config
a malformed user.json is never written   parsed before anything is serialized
repeat calls report changed: false       an invisible rewrite of a hand-edited file
```

`--replace` on `provision` exists for the same reason: an alias is a *fixed*
path, so the same path must be reprovisionable. Reuse is explicit — an occupied
path without `--replace` is refused up front rather than failing obscurely inside
`git remote add` — and `replace` only ever deletes a tree carrying the
`.alfred-fixture` marker `provision` itself wrote, so an `--into` typo pointed at
real work is refused instead of erased. The marker lives at the provision **root**,
outside the working clone, so it stays out of the tree and the recorded shas do
not move.

If a future change to `harness-core` makes issue-repo and code-repo inseparable:
stop and report it — *the pipeline cannot be evaluated against a sandbox* is
itself a finding about the architecture.

Both arms get byte-identical ticket text — arm A from `manifest.json`, arm B from
the issue that same manifest generated.

---

## 7. The other two shapes, same generator

Once `sandbox-a` exists, the missing shapes from `PLAN.md` §7 are manifests, not
projects:

- **`sandbox-b`** — ticket that should be pushed back on. Same repo, a ticket
  asking for something the code makes actively wrong. Scores: did the arm stop.
  **Authored 2026-07-30, after M0–M4 was frozen.**
- **`sandbox-c`** — multi-file feature with real tests. Same repo, add a channel
  with genuine design choices. Not written yet.

Reusing one fake repo across all three is deliberate: the *repo* stops being a
variable, so differences between runs are attributable to the ticket.

### One tree, shared by reference — decided 2026-07-30

That last sentence is only *literally* true if there is one tree. `sandbox-b`
therefore carries **no `files/` directory**; its manifest declares
`files_from: "sandbox-a"` and provisions that tree byte-for-byte. This resolves
`PLAN.md` §8.3 for the sandbox repo: **in git, one copy, shared by manifest
reference.**

The alternative — a copied `files/` per slug — makes "same repo" a claim
maintained by hand, and it fails *silently*: edit sandbox-a's `sms.js`,
sandbox-b's copy does not move, and both ground-truth suites stay green while the
two fixtures quietly diverge. Sharing makes the same coupling *loud*: one tree
means one set of expected shas, and an edit fails every sharing fixture's ground
truth at once.

The cost is real and is asserted rather than hidden. Editing `sandbox-a/files/`
moves sandbox-b's ground truth too, and **both** manifests must be re-measured.
`alfred/test/fixture-shared-tree.test.mjs` (13 tests) fails if only one is
updated, and its failure message names the other. It also pins the resolver's
refusals: both `files/` and `files_from` is an error, neither is an error, and
`files_from` may not chain — one hop, so "which tree did this provision" never
becomes a graph traversal.

### Why sandbox-b had to come *after* M4

M4's gate tests and sandbox-a's trap manifest landed in the **same commit**
(`e86cd48`) — two of the thirteen frozen gate names are sandbox-a's traps 5 and 6
verbatim. A gate built from those tests catches those traps because it was written
against them. Arm B earned its catches cold; running arm C on sandbox-a would be
teaching to the test.

So sandbox-b's traps were measured against `lib/gate.mjs` **as committed** at
`7da5718`, and each records whether that gate catches it. Three are **confirmed
holes**, each probed directly and each returning `{pass: true, findings: []}` on
input where the AC is not met:

| hole | what passes that should not |
|---|---|
| conjunctive AC | "0 errors **and** 0 warnings" mapped to a command that exits 0 with warnings still present — the gate reads the exit code, never the output |
| vacuous test filter | `--test-name-pattern` matching nothing reports `# pass 3` (the three *files*) and exits 0 on a broken tree |
| contradictory ACs | two ACs that cannot both hold, each with a command exiting 0, both pass — the gate resolves each AC independently |

None is fixed. Per this document's own rule — **tune the fixture, never the gate**
— a gate patched to catch a trap it is about to be graded on measures nothing. The
holes are declared in `fixtures/sandbox-b/manifest.json` under
`gate_coverage_summary`, with what would close each, and the fix belongs in a later
milestone.

### "Did the arm stop" cannot mean "halted"

Arm A's measured result is why. It scored **2** on Axis 1 — the top of the scale —
asked *"Does this approach work for you, or would you prefer a different
direction?"*, and the run ended. `$0.617` bought a design review and zero files. It
did not fail to work; **it stopped to ask, correctly, in a context where asking is
fatal.** An unattended `/loop` tick cannot treat "ask a human" as a terminal state.

So sandbox-b's pass bar is: **declined the ticket AND filed a `blocked` marker with
a closed-set reason code** (`unsatisfiable-ac` or `ambiguous-requirement` from
`lib/blocked.mjs`). Halting without a marker reproduces arm A's outcome, which is
worth nothing to a loop.

---

## 8. What this fixture cannot tell us

- **Synthetic code is cleaner than real code.** No 200-file diffs, no legacy
  weirdness, no build system with opinions. An arm that looks competent here can
  still drown in a real repo.
- **I planted the traps, so both arms are graded against my model of what's
  hard.** A failure mode I didn't think of is invisible.
- **Small scope hides context-window effects.** The 1339 measurement turned on
  cache reuse across a large context. A 9-file repo may not reproduce that at all
  — which means the *cost* half of experiment 2 is weaker here than the *quality*
  half. Report both, and don't let a small-repo cost ratio stand in for the
  measured 4.6x.
- It is n=1 per shape, still. Three shapes ≠ a distribution.

---

## 9. Maintaining the suite — how a fixture is allowed to change

### Additive-only: fixtures grow, they do not get edited

A fixture is half of what a score means. The other half is the rubric, and the two
are versioned together as one unit in `config/suite.json` — see `lib/suite.mjs` for
the members and the digest that keeps the declared `suite_version` honest. Every
rule below follows from one fact: **a result is only comparable to another result
carrying the same `suite_version`.** Editing a scored fixture in place does not
change one number, it silently rebases every number ever taken against it, and a
trend line drawn across that edit lies without any single reading being false.

So the default is **add, never mutate**:

- **A gap in coverage → a new case, or a new slug.** `sandbox-b` was authored
  rather than folded into `sandbox-a` for exactly this reason (§7, "Why sandbox-b
  had to come *after* M4"), and it shares `sandbox-a`'s tree by reference so the
  *repo* stays a constant while the ticket varies.
- **Any change to a member — including a new case inside an existing manifest —
  bumps `suite_version` and its digest.** `test/suite.test.mjs` fails until the
  declared digest matches the members on disk, so the bump cannot be forgotten. It
  cannot tell you whether the change was *legitimate*; that judgement is this
  section's.

**When a fixture is not merely incomplete but WRONG.** This is the case the rule
has to answer, because it is the case where quietly editing feels obviously
correct. A trap's ground truth is mis-measured; an expected sha is stale; an AC is
declared unsatisfiable and is in fact satisfiable. Fixing it in place is the worst
available option: the fixture then asserts something *true*, and every prior result
scored against the false version is still sitting in the history looking
comparable. Instead:

1. **Record the error inside the wrong fixture**, naming what is wrong and when it
   was found. It stays on disk. Preserve-and-mark over delete.
2. **Mark it superseded**, pointing at its replacement.
3. **Add the corrected fixture under a new slug**, and bump `suite_version`.
4. Results stamped with the old version stay readable as *"scored against a
   fixture later found wrong"* — which is a fact worth keeping — rather than
   becoming unexplainable disagreements with results scored after a silent fix.

Deleting the wrong fixture is not a cheaper version of this. It destroys the only
record of what the old numbers meant, and leaves a stamp in the history pointing at
nothing.

Note what does **not** count as wrong: `sandbox-b`'s three declared gate holes
(§7). A fixture recording that `lib/gate.mjs` passes input it should fail is the
fixture working. It is the *gate* that is wrong, and this document's standing rule
— **tune the fixture, never the gate** — governs which side of that line may move
in response. The two rules are not in tension: that one says a fixture, not the
system under test, is what you are allowed to adjust when a comparison misbehaves;
this one says *how* you adjust it — by adding, under a new version, rather than by
mutating something already scored.

**Saturation, and why demotion is the answer rather than deletion.** A case that
every arm passes carries no information about the arms; it is paying for itself in
runtime and giving back nothing discriminating. The temptation is to delete it. The
right move is to **demote it to a cheap regression floor** — kept, still run, no
longer treated as evidence about which arm is better — because "everyone passes
this now" is a claim that stops being true the moment something regresses, and a
deleted case cannot notice.

`sandbox-a` is already exactly this, and it should read as the intended pattern
rather than an accident of history. It cannot discriminate for arm C: M4's gate
tests and `sandbox-a`'s trap manifest landed in the same commit (`e86cd48`), two of
the thirteen frozen gate names *are* its traps 5 and 6 verbatim, so the gate
catches those traps because it was written against them. That makes `sandbox-a`
worthless as a test of the gate and valuable as a floor under it — the fixture that
fails loudly if a later change breaks what already worked. Demoted, not deleted,
and kept out of any before/after quality claim.
