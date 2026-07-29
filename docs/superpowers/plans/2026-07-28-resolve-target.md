# Deterministic target resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move target-repo and work-item resolution out of SKILL.md prose into a deterministic `resolve-target` CLI subcommand, so the LLM only extracts loose hints from free-form invocation text and the CLI owns every routing decision.

**Architecture:** A new `resolveTarget()` in `tools/lib/target.mjs` composes the EXISTING config surface — `user.json` `repos`/`defaultRepo` and `projects.json` `projects` — and emits one envelope: `{alias, path, issue_source, github, cloud_id, project_key, pinned_issue, resolved_from}`. It encodes no repo knowledge of its own; both config files stay the single source of truth. `harness-loop-core` step 0 extracts hints (`hint`, `item`) from prose, then step 1 runs the CLI and obeys the JSON.

**Tech Stack:** Node built-ins only. ESM. `node:test` + `node:assert/strict`.

## Global Constraints

- **No new dependency in `package.json`.** Node built-ins only.
- **The resolver reads config; it never hardcodes a repo, alias, path, prefix, or cloud id.** Adding a repo means editing `user.json`/`projects.json`, never this code.
- **A named-but-unresolvable target is an ERROR, never a fallback to `defaultRepo`.** Silently ticking a different repo than the one named is the worst available outcome. Exit 1.
- **`defaultRepo` applies ONLY when no hint and no cwd match were supplied.**
- Paths: `user.json` uses `~/…`, `projects.json` uses absolute. Normalize BOTH through `expandHome` before any comparison. Compare realpaths where the path exists on disk.
- All existing tests must keep passing. Baseline: **435 pass / 0 fail** (`cd harness-core && npm test`).
- `emit(obj, code)` is the established CLI output helper; error shape is `{error: "<message>"}` with exit 1, matching `resolve-project` at `harness.mjs:155-160`.

---

### Task 1: `resolveTarget()` in `tools/lib/target.mjs`

**Files:**
- Create: `harness-core/tools/lib/target.mjs`
- Test: `harness-core/test/target.test.mjs`

**Interfaces:**
- Consumes (existing, from `tools/lib/config.mjs`): `resolveConfig({env, userFile})` → `{routing, user}`; `loadProjects(projectsFile)` → `{projects, defaultCloudId}`; `issueSourceFor(user, alias)` → `'jira'|'github'`; `expandHome(path)`.
- Produces, relied on by Task 2:
  ```
  resolveTarget({ hint, item, cwd, user, projects, defaultCloudId })
    -> { ok: true, target: {
           alias, path, issue_source, github, cloud_id, project_key,
           pinned_issue, resolved_from } }
     | { ok: false, error: { code, detail } }
  ```
  `resolved_from` ∈ `'hint_alias' | 'hint_path' | 'hint_jira_key' | 'cwd' | 'default'`.
  Error codes: `unresolvable_hint`, `no_target`.

**Resolution order (precedence — implement exactly):**
1. `hint` given → resolve it. An unresolvable hint is an ERROR; never fall through.
2. no hint, `cwd` matches a registered repo path → that repo (`resolved_from: 'cwd'`).
3. neither → `user.defaultRepo` (`resolved_from: 'default'`).
4. no `defaultRepo` either → `{ok:false, error:{code:'no_target'}}`.

**Hint resolution, in order:**
- exact `repos` key, case-insensitive → `resolved_from: 'hint_alias'`
- looks like a Jira key (`/^[A-Z]+-\d+$/i`) → take its prefix, look up `projects[PREFIX]`; on hit the target path is `repoPath` and `pinned_issue` is the full key → `resolved_from: 'hint_jira_key'`
- an absolute or `~/` path that exists on disk → `resolved_from: 'hint_path'`
- else → `{ok:false, error:{code:'unresolvable_hint', detail:"…"}}`

**Reconciliation rule (this is the point of the task).** A path may be reachable via `projects.json` with NO `user.json` `repos` entry (real today: `ARTI`, `PIZZA`, `RT`, `RTFE`). In that case:
- `alias` = the matching `repos` key if one has the same path, else `null`
- `issue_source` = `issueSourceFor(user, alias)` when `alias` is non-null, else `'jira'` — because arriving via a `projects.json` Jira prefix IS the evidence it is Jira-tracked
- `github` = `repos[alias].github ?? null`
- `cloud_id` = `projects[PREFIX].cloudId ?? defaultCloudId` when arriving by Jira key or when a prefix maps to this path; else `null`
- `project_key` = the Jira PREFIX when known, else `null`

**`item` (pinned work item) normalization:**
- Jira key shape → uppercase it, keep as-is (`tars-1272` → `TARS-1272`)
- all digits, or `#N`, or `issue N` → the bare number string (`'4'`)
- absent/empty → `null`
- When `hint` was itself a Jira key AND `item` is also given, `item` wins if they conflict; record nothing special — last-writer-wins is enough, but do NOT silently drop a conflicting `item`.

- [ ] **Step 1: Write the failing tests**

Create `harness-core/test/target.test.mjs`. Build fixtures INLINE (do not read the real config files — the tests must not break when the user edits their repos):

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTarget } from '../tools/lib/target.mjs';

const USER = {
  repos: {
    webtarsthree: { path: '~/Desktop/Repos/webtarsthree', issue_source: 'jira' },
    jarvis: { path: '~/Desktop/Repos/jarvis', issue_source: 'github', github: 'JustinChan-fd/jarvis' },
  },
  defaultRepo: 'webtarsthree',
};
const PROJECTS = {
  TARS: { repoPath: '/abs/webtarsthree', cloudId: 'x.atlassian.net' },
  PIZZA: { repoPath: '/abs/pizza-pie', cloudId: 'x.atlassian.net' },
};
const BASE = { user: USER, projects: PROJECTS, defaultCloudId: 'x.atlassian.net' };

test('an alias hint resolves to its repo and issue source', () => {
  const r = resolveTarget({ hint: 'jarvis', ...BASE });
  assert.equal(r.ok, true);
  assert.equal(r.target.alias, 'jarvis');
  assert.equal(r.target.issue_source, 'github');
  assert.equal(r.target.github, 'JustinChan-fd/jarvis');
  assert.equal(r.target.resolved_from, 'hint_alias');
  assert.equal(r.target.pinned_issue, null);
});

test('an alias hint is case-insensitive', () => {
  assert.equal(resolveTarget({ hint: 'JARVIS', ...BASE }).target.alias, 'jarvis');
});

test('a Jira key hint resolves via projects.json AND pins the item', () => {
  const r = resolveTarget({ hint: 'TARS-1272', ...BASE });
  assert.equal(r.ok, true);
  assert.equal(r.target.project_key, 'TARS');
  assert.equal(r.target.cloud_id, 'x.atlassian.net');
  assert.equal(r.target.pinned_issue, 'TARS-1272');
  assert.equal(r.target.issue_source, 'jira');
  assert.equal(r.target.resolved_from, 'hint_jira_key');
});

test('a lowercase Jira key is uppercased', () => {
  assert.equal(resolveTarget({ hint: 'tars-1272', ...BASE }).target.pinned_issue, 'TARS-1272');
});

test('a projects.json-only repo gets alias null and defaults to jira', () => {
  // PIZZA has no user.json repos entry. This is real: projects.json has 6
  // prefixes, user.json has 3 aliases. Arriving via a Jira prefix IS the
  // evidence the repo is Jira-tracked.
  const r = resolveTarget({ hint: 'PIZZA-9', ...BASE });
  assert.equal(r.ok, true);
  assert.equal(r.target.alias, null);
  assert.equal(r.target.issue_source, 'jira');
  assert.equal(r.target.project_key, 'PIZZA');
});

test('an unresolvable hint is an ERROR and never falls back to defaultRepo', () => {
  // The load-bearing guard: silently ticking webtarsthree because someone
  // typo'd an alias is the worst available outcome.
  const r = resolveTarget({ hint: 'jarvsi', ...BASE });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unresolvable_hint');
});

test('no hint falls back to defaultRepo', () => {
  const r = resolveTarget({ ...BASE });
  assert.equal(r.target.alias, 'webtarsthree');
  assert.equal(r.target.resolved_from, 'default');
});

test('cwd inside a registered repo beats defaultRepo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgt-'));
  const repo = join(dir, 'jarvis');
  mkdirSync(repo);
  const user = { repos: { jarvis: { path: repo, issue_source: 'github' } }, defaultRepo: 'webtarsthree' };
  const r = resolveTarget({ cwd: repo, user, projects: {}, defaultCloudId: null });
  assert.equal(r.target.alias, 'jarvis');
  assert.equal(r.target.resolved_from, 'cwd');
});

test('item normalization: bare number, #N, and "issue N" all yield the number', () => {
  for (const item of ['4', '#4', 'issue 4']) {
    assert.equal(resolveTarget({ hint: 'jarvis', item, ...BASE }).target.pinned_issue, '4',
      `failed for ${item}`);
  }
});

test('an explicit item overrides a Jira-key hint that disagrees', () => {
  const r = resolveTarget({ hint: 'TARS-1272', item: 'TARS-1300', ...BASE });
  assert.equal(r.target.pinned_issue, 'TARS-1300');
});

test('no defaultRepo and no hint is no_target', () => {
  const r = resolveTarget({ user: { repos: {} }, projects: {}, defaultCloudId: null });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_target');
});

test('~/ paths in user.json and absolute paths in projects.json both normalize', () => {
  // The two config files disagree on format; a cwd/path comparison that skips
  // expandHome silently fails to match.
  const r = resolveTarget({ hint: 'webtarsthree', ...BASE });
  assert.ok(r.target.path.startsWith('/'), 'path must be expanded, not ~/');
  assert.ok(!r.target.path.includes('~'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd harness-core && node --test test/target.test.mjs`
Expected: FAIL — cannot find module `../tools/lib/target.mjs`.

- [ ] **Step 3: Write the implementation**

Create `harness-core/tools/lib/target.mjs`. Import `expandHome` and `issueSourceFor` from `./config.mjs` — do not reimplement either. Structure: a `normalizeItem(item)` helper, a `pathsMatch(a, b)` helper (expandHome both, then compare; use `realpathSync` guarded by `existsSync`), a `findAliasByPath(user, path)` helper, a `prefixForPath(projects, path)` helper, and `resolveTarget()` composing them in the documented precedence order. Every branch sets `resolved_from`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd harness-core && node --test test/target.test.mjs` → PASS.
Then: `cd harness-core && npm test` → expect 435 + 12 = **447 pass / 0 fail**. Report the real numbers.

- [ ] **Step 5: Perturbation check**

Each must FAIL; revert after each and report the ACTUAL result. If one does not fail, say so plainly rather than adjusting the assertion — an unfailing perturbation means the invariant is unpinned, and I would rather know.

1. Make an unresolvable hint fall through to `defaultRepo` instead of erroring → the never-falls-back test must fail.
2. Drop `expandHome` from the path comparison → the `~/` normalization test or the cwd test must fail.
3. Make `issue_source` unconditionally `issueSourceFor(user, alias)` with a `null` alias → the projects-only test must still pass (it defaults to `'jira'`), so this one may NOT fail. Report which.

- [ ] **Step 6: Commit**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills
git add harness-core/tools/lib/target.mjs harness-core/test/target.test.mjs
git commit -m "harness-core: deterministic target + work-item resolution from config"
```

---

### Task 2: `resolve-target` CLI subcommand

**Files:**
- Modify: `harness-core/tools/harness.mjs` — add a case next to `resolve-project` (~line 155)
- Test: `harness-core/test/target-cli.test.mjs`

**Interfaces:**
- Consumes: `resolveTarget()` from Task 1.
- Produces, relied on by Task 3: `harness.mjs resolve-target [--hint <text>] [--item <text>] [--cwd <path>]` emits the target envelope as JSON on stdout, exit 0; or `{error: "<detail>"}` exit 1.

- [ ] **Step 1: Write the failing tests**

Create `harness-core/test/target-cli.test.mjs`, following the `run()` helper style in `test/tokens-collect-cli.test.mjs:16` — it shells `execFileSync('node', [CLI, ...args])` and returns `{code, out}` where `out` is parsed JSON. Read that file first and match it; do NOT invent a different helper name.

Tests to write:
- `resolve-target --hint jarvis` → exit 0, `out.alias === 'jarvis'`, `out.issue_source === 'github'`.
- `resolve-target --hint TARS-1272` → `out.pinned_issue === 'TARS-1272'`, `out.project_key === 'TARS'`.
- `resolve-target --hint jarvis --item 4` → `out.pinned_issue === '4'`.
- `resolve-target --hint definitely-not-a-repo` → **exit 1**, `out.error` is a non-empty string.
- `resolve-target` with no args → exit 0 and resolves the real `defaultRepo` (assert `out.alias` is a non-empty string and `out.path` starts with `/`; do NOT hardcode `webtarsthree` — the user may change their default).

These run against the REAL config files, so assert only on structure and on values the repo's own config guarantees.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd harness-core && node --test test/target-cli.test.mjs`
Expected: FAIL — `Unknown option '--hint'` or unknown subcommand. Note `parseArgs` runs with `strict: true` (`harness.mjs:43`), so an option missing from the table throws rather than being ignored.

- [ ] **Step 3: Write the implementation**

Add to `harness.mjs`, immediately after the `resolve-project` case:

```javascript
    case 'resolve-target': {
      // Deterministic target + work-item routing. The SKILL.md caller extracts
      // loose hints from free-form invocation text; every DECISION lives here,
      // composed from user.json + projects.json so those files stay the single
      // source of truth. A named-but-unresolvable hint exits 1 rather than
      // falling back to defaultRepo: silently ticking a repo the user did not
      // name is the worst available outcome.
      const v = opts({ hint: { type: 'string' }, item: { type: 'string' }, cwd: { type: 'string' } });
      const { user } = resolveConfig();
      const { projects, defaultCloudId } = loadProjects();
      const r = resolveTarget({
        hint: v.hint, item: v.item, cwd: v.cwd ?? process.cwd(),
        user, projects, defaultCloudId,
      });
      if (!r.ok) emit({ error: `${r.error.code}: ${r.error.detail ?? ''}`.trim() }, 1);
      emit(r.target);
    }
```

Add `loadProjects` to the existing `config.mjs` import and `resolveTarget` from `./lib/target.mjs`. Check whether `loadProjects` is already imported before adding it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd harness-core && node --test test/target-cli.test.mjs` → PASS.
Then `cd harness-core && npm test` → expect **447 + 5 = 452 pass / 0 fail**. Report real numbers.

- [ ] **Step 5: Perturbation check**

1. Remove `hint` from the `opts({...})` table → the `--hint jarvis` test must fail with a non-zero exit (this is the `strict: true` behaviour).
2. Change the `if (!r.ok) emit(..., 1)` exit code to 0 → the unresolvable-hint test must fail.

- [ ] **Step 6: Commit**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills
git add harness-core/tools/harness.mjs harness-core/test/target-cli.test.mjs
git commit -m "harness-core: add resolve-target subcommand"
```

---

### Task 3: rewrite `harness-loop-core` steps 0/1 to hints-then-CLI

**Files:**
- Modify: `harness-loop-core/SKILL.md` — step 0 (~line 58) and step 1, plus the step 4 pin block (~line 107)

**Interfaces:**
- Consumes: `resolve-target` from Task 2.
- Produces: nothing downstream. Steps 5-7 already consume `<target>` and `<KEY>` generically and need no change — verify this in Step 3 rather than assuming it.

**Context.** Steps 0/1 and the step 4 pin block are currently PROSE: they tell the model to interpret the invocation text AND to make every routing decision (alias lookup, `defaultRepo` fallback, Jira-vs-GitHub, cloud id). That is two jobs, and the second one is not the model's to do. This task cuts it to one.

- [ ] **Step 1: Read the current text**

Run `sed -n '56,125p' harness-loop-core/SKILL.md`. Steps 0, 1, and the step 4 pin block were added earlier in prose form; you are replacing the resolution MECHANISM while keeping the pin SEMANTICS (pinned item overrides the lowest-actionable scan; a stranded run still outranks a pin).

- [ ] **Step 2: Rewrite step 0 and step 1**

Replace both with a single step whose shape is: extract hints, then obey the CLI. It must convey:

- Your ONLY interpretive job is to read the invocation text and pull out at most two loose strings: a repo hint and a work-item hint. Everything else in the text is commentary.
- Do not resolve aliases, apply defaults, decide Jira-vs-GitHub, or look up a cloud id yourself. Pass the hints to:
  `CLI resolve-target --hint "<repo hint or omit>" --item "<item hint or omit>" --cwd <cwd>`
- Obey the JSON it emits: `alias`, `path`, `issue_source`, `github`, `cloud_id`, `project_key`, `pinned_issue`, `resolved_from`. Those ARE `<target>`, `ISSUE_SOURCE`, `GITHUB_SLUG`, and the pin.
- **Exit 1 means STOP and report the error verbatim.** Do not retry with a different guess, and do not fall back to a default repo.
- Echo one line before doing work: `target: <path> (issue_source=<src>, via=<resolved_from>), work item: <pinned_issue or "lowest actionable">`.

Keep the file's existing voice and formatting. Preserve the note that `ISSUE_SOURCE` governs step 4's listing, the driver prompts' input shape, and the status-comment sink, and must be passed into every driver prompt.

- [ ] **Step 3: Verify steps 5-7 need no change**

Run `grep -n "KEY\|<target>\|ISSUE_SOURCE" harness-loop-core/SKILL.md` and confirm every downstream use consumes those values generically rather than re-deriving them. Report anything that re-resolves the target or re-lists issues after step 4 — that would be a second source of truth and must be reported as a finding, not silently patched.

- [ ] **Step 4: Verify the CLI contract matches what you wrote**

Run each and paste the real output into your report:

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills
node harness-core/tools/harness.mjs resolve-target --hint jarvis
node harness-core/tools/harness.mjs resolve-target --hint jarvis --item 4
node harness-core/tools/harness.mjs resolve-target --hint TARS-1272
node harness-core/tools/harness.mjs resolve-target --hint nope-not-a-repo; echo "exit=$?"
```

The field names in your rewritten step MUST match these outputs exactly. If they differ, the SKILL.md is wrong — fix it, not the CLI.

- [ ] **Step 5: Commit**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills
git add harness-loop-core/SKILL.md
git commit -m "harness-loop-core: resolve target deterministically via resolve-target"
```

---

## Self-Review

**Spec coverage.** The ask was "reason, then gather fields to run the routing deterministically," plus "reference user.json for this too." Task 1 is the reasoning-free resolver composed from `user.json` + `projects.json`; Task 2 exposes it; Task 3 reduces the LLM to hint extraction. The `~/`-vs-absolute normalization and the `projects.json`-has-6-prefixes-but-`user.json`-has-3-aliases reconciliation are both covered by named tests in Task 1 because both are live in the real config today.

**Placeholder scan.** Task 1 Step 1 and Task 2 Step 1 carry real test code. Task 1 Step 3 describes helpers rather than pasting the implementation — deliberate, since the tests pin the contract and the helper bodies are mechanical. Task 3 Steps 2 is prose-to-prose editing where the requirements are enumerated as must-convey bullets rather than fixed wording, because the file has a house voice to match.

**Type consistency.** `resolveTarget` returns `{ok, target}` / `{ok, error:{code, detail}}` in Task 1's tests, Task 1's implementation notes, and Task 2's CLI case. The envelope field names are identical in Task 1's tests, Task 2's assertions, and Task 3's must-convey list. `emit(obj, code)` matches the existing `resolve-project` precedent.

**One risk worth naming.** Task 2's CLI tests run against the REAL `user.json`/`projects.json`, so they would break if the user removes the `jarvis` alias or the `TARS` prefix. Task 1's unit tests use inline fixtures and are immune. This is a deliberate trade: the CLI tests are the only place the real config wiring gets exercised end-to-end, which is worth one coupling. Task 2 Step 1 explicitly forbids hardcoding `defaultRepo`'s value for the same reason.
