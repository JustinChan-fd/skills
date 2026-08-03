// delivery — the only module that writes somewhere the operator does not control.
//
// GIT IS REAL IN EVERY TEST HERE. Not injected, not stubbed, not a recorded runner. This is the
// `feedback_mocked_seam_blindness` rule applied to the highest-consequence module in the harness:
// the propositions under test are things git decides, not things this module decides. "Branching
// from the resolved base rather than HEAD produces a diff containing only this run's work" is a
// claim about `git switch -c <branch> <base>` — a fake git would answer it by construction, and
// the test would pass whether or not the real command carried the base argument at all.
//
// The remote is a real bare repo behind a real `file://` URL, so `git push` genuinely pushes and
// the assertion is made by INSPECTING THE REMOTE, not by trusting the return value that says a
// push happened. Same argument: a `pushed: true` computed by this module is exactly the kind of
// self-report the gate exists to distrust.
//
// `gh` IS INJECTED, AND THAT ASYMMETRY IS DELIBERATE. `gh pr create` reaches github.com, and there
// is no local equivalent of a bare repo for it. So `gh` is a recorder, and what the tests assert is
// the ARGV — because the propositions about `gh` are all about what we asked it for (`--draft`,
// which base, which head), and argv is where those live. The one thing a recorder cannot prove is
// that GitHub honours `--draft`, and no test in this file claims to.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { branchNameFor, deliver, prBody } from '../lib/delivery.mjs';

const dirs = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A repo with a commit on `main`, a second branch, and a real bare remote at `origin`.
//
// TWO BRANCHES AND A COMMIT ON EACH IS THE POINT. A repo with one branch cannot distinguish
// "branched from the base" from "branched from HEAD" — they are the same commit, and the central
// test of this file would pass vacuously.
function tempRepo({ base = 'main', extraBranches = {}, checkout = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'alfred-delivery-'));
  dirs.push(root);
  git(root, 'init', '-q', '-b', base);
  git(root, 'config', 'user.email', 'alfred@test.invalid');
  git(root, 'config', 'user.name', 'Alfred Test');
  writeFileSync(join(root, 'README.md'), `# base ${base}\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `base commit on ${base}`);

  // Each extra branch gets a commit that exists NOWHERE on the base. That file is the probe: if
  // delivery branches from HEAD while HEAD is here, this file lands in the PR's diff.
  for (const [name, marker] of Object.entries(extraBranches)) {
    git(root, 'switch', '-q', '--no-track', '-c', name, base);
    writeFileSync(join(root, `${marker}.txt`), `work that belongs to ${name}, not to the run\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `unrelated commit on ${name}`);
  }

  const bare = mkdtempSync(join(tmpdir(), 'alfred-delivery-remote-'));
  dirs.push(bare);
  git(bare, 'init', '-q', '--bare');
  git(root, 'remote', 'add', 'origin', `file://${bare}`);
  git(root, 'push', '-q', 'origin', base);

  git(root, 'switch', '-q', checkout ?? base);
  return { root, bare };
}

// A recording `gh`. Returns a plausible URL so the URL-extraction path is exercised.
function ghRecorder({ fail = null, output = 'https://github.com/acme/repo/pull/42' } = {}) {
  const calls = [];
  const gh = async (args, opts) => {
    calls.push({ args, opts });
    if (fail) throw new Error(fail);
    return output;
  };
  gh.calls = calls;
  return gh;
}

const CONFIG = Object.freeze({
  verify: { test: 'npm test' },
  delivery: { mode: 'pr', never_merge: true },
  base: { rules: [{ when_epic: 'EPIC-1', branch: 'feat/the-epic-branch' }, { default: 'main' }] },
});

const cfg = (over = {}) => ({ ...CONFIG, ...over, delivery: { ...CONFIG.delivery, ...(over.delivery ?? {}) } });
const ITEM = Object.freeze({ id: 'TARS-1351', title: 'Consolidate the retry loop', url: 'https://x.invalid/TARS-1351' });
const PASS = Object.freeze({ pass: true, findings: [], unverified: [] });
const FAIL = Object.freeze({ pass: false, findings: [{ rule: 'test_failed', detail: 'npm test exited 1' }], unverified: [] });

const dirtyWith = (root, name = 'src/new.js') => {
  execFileSync('mkdir', ['-p', join(root, name, '..')]);
  writeFileSync(join(root, name), 'export const written = true;\n');
};

test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// never_merge, at the point of use.
// ---------------------------------------------------------------------------

test('never_merge false refuses delivery outright, and nothing is committed', async () => {
  const { root } = tempRepo();
  dirtyWith(root);
  const gh = ghRecorder();

  const out = await deliver({ repoRoot: root, config: cfg({ delivery: { never_merge: false } }), item: ITEM, gate: PASS, runId: 'r1', gh });

  assert.equal(out.committed, false);
  assert.equal(out.pushed, false);
  assert.match(out.error, /never_merge/);
  assert.equal(gh.calls.length, 0, 'gh must not be called at all');
  // THE REFUSAL IS OBSERVED IN THE REPO, not only in the return value. A refusal that returned the
  // right object while having already committed would pass an assertion on `out` alone.
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1', 'no commit was made');
  assert.equal(git(root, 'branch', '--show-current'), 'main', 'the branch was never switched');
});

test('never_merge missing entirely refuses too — absent is not permission', async () => {
  const { root } = tempRepo();
  dirtyWith(root);
  const config = cfg();
  delete config.delivery.never_merge;

  const out = await deliver({ repoRoot: root, config, item: ITEM, gate: PASS, runId: 'r1', gh: ghRecorder() });
  assert.match(out.error, /never_merge is undefined/);
});

test('never_merge "true" as a STRING refuses — the check is identity, not truthiness', async () => {
  // The falsifier for the `!== true` form. A `!config.delivery.never_merge` check would accept the
  // string, and a config whose value is the string has been through something that stringified it —
  // an env var, a CLI flag — which is exactly the "edited past the one place it is written down"
  // case the point-of-use check exists for.
  const { root } = tempRepo();
  dirtyWith(root);
  const out = await deliver({ repoRoot: root, config: cfg({ delivery: { never_merge: 'true' } }), item: ITEM, gate: PASS, runId: 'r1', gh: ghRecorder() });
  assert.match(out.error, /never_merge is "true", not true/);
});

test('the falsifier: never_merge true does NOT refuse', async () => {
  const { root } = tempRepo();
  dirtyWith(root);
  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: PASS, runId: 'r1', gh: ghRecorder() });
  assert.equal(out.error, null, 'a config that says never_merge:true must deliver');
  assert.equal(out.committed, true);
});

test('no code path in this module can merge — asserted against the source, not behaviour', () => {
  // A behavioural test cannot prove a negative here: it can only show that the paths it happened to
  // drive did not merge. This reads the module and asserts the capability is absent, which is the
  // proposition the header claims.
  const src = readFileSync(new URL('../lib/delivery.mjs', import.meta.url), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /pr['"]?,\s*['"]merge/, 'gh pr merge must not appear in code');
  assert.doesNotMatch(code, /['"]merge['"]/, 'no git/gh merge subcommand in code');
  assert.doesNotMatch(code, /--force|-f\b/, 'no force push: overwriting a remote branch is the one irreversible act here');
});

// ---------------------------------------------------------------------------
// The base. resolveBase wired in, and null fatal rather than guessed.
// ---------------------------------------------------------------------------

test('the branch is cut from the RESOLVED base, not from HEAD', async () => {
  // The central test. HEAD sits on `other`, which carries a commit the base does not have. If
  // delivery branches from HEAD, that commit's file appears in the diff against the base — work
  // this run did not do, attributed to it.
  const { root } = tempRepo({ extraBranches: { other: 'stray' }, checkout: 'other' });
  dirtyWith(root);
  const gh = ghRecorder();

  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: PASS, runId: 'r1', gh });

  assert.equal(out.base, 'main');
  assert.equal(out.error, null);
  const diff = git(root, 'diff', '--name-only', 'main...HEAD').split('\n').filter(Boolean).sort();
  assert.deepEqual(diff, ['src/new.js'], 'the diff against the base holds only this run’s file');
  assert.ok(!diff.includes('stray.txt'), 'the unrelated branch’s commit must not be in the diff');
});

test('an epic item bases on the epic branch, not the default — TARS-1271’s defect', async () => {
  const { root } = tempRepo({ extraBranches: { 'feat/the-epic-branch': 'epicwork' } });
  dirtyWith(root);
  const gh = ghRecorder();

  const out = await deliver({ repoRoot: root, config: cfg(), item: { ...ITEM, epic: 'EPIC-1' }, gate: PASS, runId: 'r1', gh });

  assert.equal(out.base, 'feat/the-epic-branch');
  // The PR must TARGET it too — resolving the base and then opening against main is exactly the
  // computed-and-discarded shape (#63/#69/#72/#73).
  const argv = gh.calls[0].args;
  assert.equal(argv[argv.indexOf('--base') + 1], 'feat/the-epic-branch');
  // And the epic's own commit is NOT in the diff, because the base is where we branched from.
  const diff = git(root, 'diff', '--name-only', 'feat/the-epic-branch...HEAD').split('\n').filter(Boolean);
  assert.deepEqual(diff, ['src/new.js']);
});

test('no base resolves → refuse, and do not fall back to a branch name', async () => {
  const { root } = tempRepo();
  dirtyWith(root);
  const gh = ghRecorder();

  const out = await deliver({ repoRoot: root, config: cfg({ base: { rules: [] } }), item: ITEM, gate: PASS, runId: 'r1', gh });

  assert.equal(out.committed, false);
  assert.equal(out.pushed, false);
  assert.match(out.error, /no base branch resolved/);
  assert.equal(gh.calls.length, 0);
  assert.equal(git(root, 'branch', '--show-current'), 'main', 'nothing was branched off a guessed base');
});

test('a base that does not exist locally fails at branch, and does not fall back to HEAD', async () => {
  const { root } = tempRepo();
  dirtyWith(root);
  const gh = ghRecorder();

  const out = await deliver({ repoRoot: root, config: cfg({ base: { rules: [{ default: 'no-such-branch' }] } }), item: ITEM, gate: PASS, runId: 'r1', gh });

  assert.equal(out.committed, false);
  assert.match(out.error, /could not branch/);
  assert.equal(gh.calls.length, 0);
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1', 'no commit landed anywhere');
});

// ---------------------------------------------------------------------------
// Commit always, push only on pass. Two decisions, separately tested.
// ---------------------------------------------------------------------------

test('a FAILED gate still commits — the diff is the only copy of the work', async () => {
  const { root, bare } = tempRepo();
  dirtyWith(root);
  const gh = ghRecorder();

  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: FAIL, runId: 'r1', gh });

  assert.equal(out.committed, true);
  assert.equal(out.error, null, 'a failed gate is not a delivery failure');
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '2');
  // Observed in the repo: the file is IN the commit, not merely staged or still untracked, because
  // the next tick's `treeIsDirty` check refuses to spawn against a dirty tree.
  assert.match(git(root, 'show', '--name-only', '--format=', 'HEAD'), /src\/new\.js/);
  assert.equal(git(root, 'status', '--porcelain'), '', 'the tree is clean afterwards');
});

test('a FAILED gate does NOT push, and the remote is checked to prove it', async () => {
  const { root, bare } = tempRepo();
  dirtyWith(root);
  const gh = ghRecorder();

  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: FAIL, runId: 'r1', gh });

  assert.equal(out.pushed, false);
  assert.equal(out.pr_url, null);
  assert.equal(gh.calls.length, 0, 'no PR for a failed run');
  // THE REMOTE IS THE WITNESS. `pushed: false` is this module's own report; the bare repo's ref
  // list is not.
  assert.equal(git(bare, 'branch', '--list', out.branch), '', 'the branch must not exist on the remote');
  assert.ok(out.steps.some((s) => s.step === 'push_skipped' && s.ok), 'the skip is recorded, not silent');
});

test('a PASSED gate pushes, and the remote really has the commit', async () => {
  const { root, bare } = tempRepo();
  dirtyWith(root);
  const gh = ghRecorder();

  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: PASS, runId: 'r1', gh });

  assert.equal(out.pushed, true);
  assert.equal(out.error, null);
  assert.notEqual(git(bare, 'branch', '--list', out.branch), '', 'the branch exists on the remote');
  // The remote's tip is OUR commit, and it carries the file. A push that landed an empty commit or
  // the base's tip would satisfy a ref-existence check alone.
  assert.equal(git(bare, 'rev-parse', out.branch), git(root, 'rev-parse', 'HEAD'));
  assert.match(git(bare, 'show', '--name-only', '--format=', out.branch), /src\/new\.js/);
});

test('a run that changed NOTHING commits nothing, pushes nothing, and is not an error', async () => {
  const { root, bare } = tempRepo();
  const gh = ghRecorder();

  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: PASS, runId: 'r1', gh });

  assert.equal(out.committed, false);
  assert.equal(out.pushed, false);
  assert.equal(out.branch, null, 'no branch litter for a run that did nothing');
  assert.equal(out.error, null, 'nothing happened is not a failure');
  assert.equal(gh.calls.length, 0);
  assert.equal(git(root, 'branch', '--list', 'alfred/*'), '', 'no alfred branch was created');
  assert.ok(out.steps.some((s) => s.step === 'nothing_to_commit'));
});

// ---------------------------------------------------------------------------
// The PR. Draft always, and the argv is where that lives.
// ---------------------------------------------------------------------------

test('the PR is opened --draft, against the resolved base, from our branch', async () => {
  const { root } = tempRepo();
  dirtyWith(root);
  const gh = ghRecorder();

  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: PASS, runId: 'r1', gh });

  assert.equal(gh.calls.length, 1);
  const argv = gh.calls[0].args;
  assert.deepEqual(argv.slice(0, 3), ['pr', 'create', '--draft']);
  assert.ok(argv.includes('--draft'), 'every PR this harness opens is a draft');
  assert.equal(argv[argv.indexOf('--base') + 1], 'main');
  assert.equal(argv[argv.indexOf('--head') + 1], out.branch);
  assert.equal(gh.calls[0].opts.cwd, root, 'gh runs in the repo, not in the harness cwd');
  assert.equal(out.pr_url, 'https://github.com/acme/repo/pull/42');
});

test('--draft is not configurable — asserted against the source', () => {
  // A behavioural test drives the config shapes that exist today. This asserts there is no key to
  // find: `--draft` is a literal, never read from config.
  const src = readFileSync(new URL('../lib/delivery.mjs', import.meta.url), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /'--draft'/, 'the literal is present');
  assert.doesNotMatch(code, /draft\s*[?:]|\.draft\b/, 'no config key or ternary controls draft-ness');
});

test('a gh failure AFTER a successful push reports pushed:true — a caller must not re-push', async () => {
  const { root, bare } = tempRepo();
  dirtyWith(root);
  const gh = ghRecorder({ fail: 'gh: could not create pull request (HTTP 422)' });

  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: PASS, runId: 'r1', gh });

  assert.equal(out.pushed, true, 'the branch IS on the remote — reporting false would invite a re-push');
  assert.equal(out.pr_url, null);
  assert.match(out.error, /pushed but no PR/);
  assert.notEqual(git(bare, 'branch', '--list', out.branch), '', 'and the remote confirms it');
  assert.ok(out.steps.some((s) => s.step === 'push' && s.ok), 'the push step stays recorded as ok');
  assert.ok(out.steps.some((s) => s.step === 'pr' && !s.ok), 'the pr step is recorded as failed');
});

test('mode:push pushes and opens no PR', async () => {
  const { root, bare } = tempRepo();
  dirtyWith(root);
  const gh = ghRecorder();

  const out = await deliver({ repoRoot: root, config: cfg({ delivery: { mode: 'push' } }), item: ITEM, gate: PASS, runId: 'r1', gh });

  assert.equal(out.pushed, true);
  assert.equal(out.pr_url, null);
  assert.equal(gh.calls.length, 0);
  assert.notEqual(git(bare, 'branch', '--list', out.branch), '');
});

test('an unknown delivery mode refuses before touching the repo', async () => {
  const { root } = tempRepo();
  dirtyWith(root);
  const out = await deliver({ repoRoot: root, config: cfg({ delivery: { mode: 'merge' } }), item: ITEM, gate: PASS, runId: 'r1', gh: ghRecorder() });
  assert.match(out.error, /delivery\.mode is "merge"/);
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1');
});

// ---------------------------------------------------------------------------
// deliver never throws. A delivery failure is a sidecar, not a refusal of a graded run.
// ---------------------------------------------------------------------------

test('deliver NEVER throws — a missing repoRoot returns an error object', async () => {
  // §7's rule, and it matters most here: a throw reaches cli.mjs as exit 2, which a scheduler
  // retries — paying for the whole 25-minute run again to re-attempt a gh call.
  const out = await deliver({ config: cfg(), item: ITEM, gate: PASS, runId: 'r1', gh: ghRecorder() });
  assert.match(out.error, /no repoRoot/);
  assert.equal(out.committed, false);
});

test('deliver NEVER throws — a repoRoot that is not a git repo returns an error object', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alfred-delivery-nogit-'));
  dirs.push(root);
  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: PASS, runId: 'r1', gh: ghRecorder() });
  assert.ok(out.error, 'an error is reported');
  assert.equal(out.committed, false);
});

test('deliver NEVER throws — a gh that throws a non-Error still returns an error object', async () => {
  const { root } = tempRepo();
  dirtyWith(root);
  const gh = async () => { throw 'a bare string, because a child process wrapper did that once'; };
  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: PASS, runId: 'r1', gh });
  assert.match(out.error, /bare string/);
  assert.equal(out.pushed, true);
});

test('a push failure stops the sequence rather than opening a PR for an absent branch', async () => {
  const { root } = tempRepo();
  dirtyWith(root);
  git(root, 'remote', 'set-url', 'origin', 'file:///nonexistent/alfred-no-such-remote.git');
  const gh = ghRecorder();

  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: PASS, runId: 'r1', gh });

  assert.equal(out.committed, true, 'the commit already happened and is not rolled back');
  assert.equal(out.pushed, false);
  assert.match(out.error, /./);
  assert.equal(gh.calls.length, 0, 'no PR against a head that was never pushed');

  // THE BRANCH IS NAMED IN THE FAILURE. This is what the first version of the module got wrong: it
  // returned `committed: false, branch: null` from every failure path, so a push failure reported
  // that nothing had happened while a local branch held the only copy of the work. The next tick
  // would find a clean tree and spawn straight over it.
  assert.equal(out.branch, branchNameFor({ itemId: ITEM.id, runId: 'r1' }), 'the operator is told where the work is');
  assert.equal(out.base, 'main', 'and what it was based on');
  assert.ok(out.head, 'and the commit sha');
  // Observed in the repo, not taken from the return value.
  assert.notEqual(git(root, 'branch', '--list', out.branch), '', 'that branch really exists locally');
  assert.match(git(root, 'show', '--name-only', '--format=', out.branch), /src\/new\.js/);
});

// ---------------------------------------------------------------------------
// The branch name.
// ---------------------------------------------------------------------------

test('the branch name keeps the run id when the item id is long — 67e97d1’s defect, other field', async () => {
  const long = `TARS-${'x'.repeat(200)}`;
  const a = branchNameFor({ itemId: long, runId: 'run-aaa' });
  const b = branchNameFor({ itemId: long, runId: 'run-bbb' });
  assert.notEqual(a, b, 'two runs on one long-named ticket must not collide');
  assert.match(a, /run-aaa$/);
  assert.ok(a.length < 100, `branch name stayed bounded: ${a.length}`);
});

test('two runs on the same ticket get different branches', async () => {
  const { root, bare } = tempRepo();
  dirtyWith(root, 'src/first.js');
  const first = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: PASS, runId: 'run-1', gh: ghRecorder() });
  git(root, 'switch', '-q', 'main');
  dirtyWith(root, 'src/second.js');
  const second = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: PASS, runId: 'run-2', gh: ghRecorder() });

  assert.notEqual(first.branch, second.branch);
  // BOTH survive on the remote. The failure this guards is the second run resetting the first,
  // losing exactly the comparison that makes a re-run worth doing.
  assert.match(git(bare, 'show', '--name-only', '--format=', first.branch), /src\/first\.js/);
  assert.match(git(bare, 'show', '--name-only', '--format=', second.branch), /src\/second\.js/);
});

test('the branch name is alfred/-prefixed and GIT ITSELF accepts it', () => {
  // `check-ref-format` is the assertion that matters, and it caught a real defect: the first slug
  // kept `.`, so `TARS 1351/../weird ref` became `alfred/tars-1351-..-weird-ref` — which git
  // REJECTS. A hand-written character blacklist would have had to know that `..` is illegal while a
  // single `.` is fine; asking git removes the guessing.
  for (const itemId of ['TARS 1351/../weird ref', 'a.b.c', 'TARS-1@#$%^&*()1351', '-leading-dash-', 'HEAD', 'feat/x']) {
    const name = branchNameFor({ itemId, runId: 'r 1' });
    assert.match(name, /^alfred\//, `${itemId} → ${name}`);
    assert.doesNotMatch(name, /\s/, `no whitespace: ${name}`);
    // `check-ref-format --branch` ECHOES the name on success and exits non-zero on rejection, so the
    // signal is the exit code — `execFileSync` throws on it. Asserting empty output was wrong and
    // would have passed for any name git happened to normalize to nothing.
    const root = tempRepo().root;
    assert.doesNotThrow(() => git(root, 'check-ref-format', '--branch', name), `git accepts ${name} (from ${itemId})`);
    assert.equal(git(root, 'check-ref-format', '--branch', name), name, 'and does not rewrite it');
  }
});

test('no itemId throws rather than naming a branch after nothing', () => {
  assert.throws(() => branchNameFor({ runId: 'r1' }), /no itemId/);
  // AN ID THAT SLUGS TO NOTHING THROWS TOO, and this is the case the loop above found: `'...'` is a
  // non-empty string that survives a truthiness check and reduces to the empty slug. Without the
  // post-slug check the branch would be `alfred/-r1`, named after nothing while looking deliberate.
  assert.throws(() => branchNameFor({ itemId: '...', runId: 'r1' }), /no itemId/);
  assert.throws(() => branchNameFor({ itemId: '   ', runId: 'r1' }), /no itemId/);
  assert.throws(() => branchNameFor({ itemId: '@#$%', runId: 'r1' }), /no itemId/);
});

// ---------------------------------------------------------------------------
// The PR body. What a reviewer is told.
// ---------------------------------------------------------------------------

test('the body says a machine wrote it and that no machine merged it', () => {
  const body = prBody({ item: ITEM, gate: PASS, runId: 'r1' });
  assert.match(body, /draft opened by a machine/i);
  assert.match(body, /never merges/i);
  assert.match(body, /Read the diff/i);
});

test('the body lists each finding by rule and detail, not a count', () => {
  const gate = { pass: false, findings: [{ rule: 'test_failed', detail: 'npm test exited 1' }, { rule: 'ac_unmapped', detail: 'AC2 has no command' }], unverified: [] };
  const body = prBody({ item: ITEM, gate, runId: 'r1' });
  assert.match(body, /FAIL/);
  assert.match(body, /test_failed.*npm test exited 1/);
  assert.match(body, /ac_unmapped.*AC2 has no command/);
});

test('unverified ACs are listed SEPARATELY and not as failures — §5 rule 2’s honest channel', () => {
  const gate = { pass: true, findings: [], unverified: [{ id: 'AC3', reason: 'needs a human to look at the rendered page' }] };
  const body = prBody({ item: ITEM, gate, runId: 'r1' });
  assert.match(body, /PASS/);
  assert.match(body, /did NOT fail the run/);
  assert.match(body, /AC3.*rendered page/);
});

test('ADDED 2026-08-03: the body hands a reviewer the verify commands that REALLY ran, and invents none', () => {
  // Ported in spirit from the operator's `push-branch` skill: give a reviewer something concrete to
  // type. Grounded in `config.verify`, which lib/gate.mjs execFile'd against this tree — so the
  // section is a report, not a suggestion.
  const config = { verify: { test: 'npx vitest run', lint: 'npm run lint' } };
  const body = prBody({ item: ITEM, gate: PASS, runId: 'r1', config });
  assert.match(body, /commands the gate ran/i);
  assert.match(body, /npx vitest run/);
  assert.match(body, /npm run lint/);

  // AND THE OMISSION CASE, which is the half that would rot silently. A repo with no verify block
  // must not get a header promising commands followed by nothing — an empty "how to check this"
  // section on a machine-opened PR reads as "there was nothing to check", which is a stronger
  // claim than "this harness was not configured to check anything".
  const bare = prBody({ item: ITEM, gate: PASS, runId: 'r1' });
  assert.doesNotMatch(bare, /commands the gate ran/i, 'an unconfigured repo got an empty verify section');

  // A non-string command is not a command. Guards the shape rather than trusting the config loader,
  // because this value reaches a PUBLISHED surface.
  const junk = prBody({ item: ITEM, gate: PASS, runId: 'r1', config: { verify: { test: null, lint: '   ' } } });
  assert.doesNotMatch(junk, /commands the gate ran/i, 'a config with no usable command still printed the header');
});

test('ADDED 2026-08-03: the verify section survives the trip through deliver() to the real --body argv', async () => {
  // WHY THIS EXISTS AS A SECOND TEST, and it is the more important of the two. The test above calls
  // `prBody` directly, so it proves the FUNCTION composes the section — and proves nothing about
  // whether `deliver()` passes `config` to it. Mutation-checked: removing `config` from the
  // `prBody({...})` call inside `deliver()` left 33/33 GREEN.
  //
  // That is this project's recorded defect shape, twice over. `3aba45b` added `delivery.steps` to
  // `buildRecord`, asserted it at that layer, suite green — and every record still had `steps: []`,
  // because `run.mjs` hand-built the object above it. A fix verified only at the layer it edits is
  // not verified. So this reads the bytes `gh pr create` was actually handed.
  const { root } = tempRepo();
  dirtyWith(root);
  const gh = ghRecorder();
  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: PASS, runId: 'r1', gh });

  assert.equal(out.pr_url, 'https://github.com/acme/repo/pull/42');
  const create = gh.calls.find((c) => c.args.includes('create'));
  assert.ok(create, 'gh pr create was never called');
  const body = create.args[create.args.indexOf('--body') + 1];
  assert.match(body, /commands the gate ran/i, 'deliver() dropped config on the way to prBody');
  // CONFIG.verify.test, reaching the published surface from the config the caller passed.
  assert.match(body, /npm test/);
});

test('a preflight refusal is disclosed in the body', () => {
  const body = prBody({ item: ITEM, gate: FAIL, runId: 'r1', preflight: { refused: true, reason: 'quote-not-in-body', detail: 'AC2’s quote is not in the ticket' } });
  assert.match(body, /REFUSED/);
  assert.match(body, /quote-not-in-body/);
  assert.match(body, /stopped in its first turn/);
});

test('the commit message and PR title carry the verdict, so a log reader need not open the PR', async () => {
  const { root } = tempRepo();
  dirtyWith(root);
  const gh = ghRecorder();
  await deliver({ repoRoot: root, config: cfg({ delivery: { mode: 'push' } }), item: ITEM, gate: FAIL, runId: 'r1', gh });

  const msg = git(root, 'log', '-1', '--format=%B');
  assert.match(msg, /^alfred\(TARS-1351\):/, 'git log --oneline says who made it');
  assert.match(msg, /FAIL/);
  assert.match(msg, /Not reviewed by a human/);
});

test('a failed run reaching a remote is marked FAILED GATE in the PR title', async () => {
  const { root } = tempRepo();
  dirtyWith(root);
  const gh = ghRecorder();
  // A failed gate does not push on this path, so the title is asserted directly — the shape that
  // reaches a reviewer's PR list.
  const { prBody: _unused } = await import('../lib/delivery.mjs');
  const out = await deliver({ repoRoot: root, config: cfg(), item: ITEM, gate: FAIL, runId: 'r1', gh });
  assert.equal(gh.calls.length, 0, 'and it did not reach one here');
  assert.equal(out.pushed, false);
});
