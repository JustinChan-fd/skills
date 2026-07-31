// Pins `provision` — the step that turns a committed fixture into a git repo
// an arm can actually work in.
//
// The property that matters is determinism: same manifest -> same shas, on any
// machine, forever. Without it there is no fixed start state, and the 1339
// contamination bug (arm 0 moved the ref the next arm started from) becomes
// possible again. With it, provision is re-run from scratch per arm and there is
// no long-lived repo to corrupt.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { provision } from '../lib/fixture.mjs';

const run = promisify(execFile);
const FIXTURE = fileURLToPath(new URL('../fixtures/sandbox-a', import.meta.url));

let scratch;
let first;
let manifest;

// `git` inherits NODE_TEST_CONTEXT harmlessly, but a nested `node --test` does
// not: it switches to child-reporter mode and writes nothing to stdout. Strip it
// for every child this suite spawns.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

const git = async (repo, ...args) => {
  const { stdout } = await run('git', ['-C', repo, ...args], { env: childEnv() });
  return stdout.trim();
};

async function walk(root, base = root, out = []) {
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const full = join(root, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else out.push(relative(base, full));
  }
  return out;
}

before(async () => {
  manifest = JSON.parse(await readFile(join(FIXTURE, 'manifest.json'), 'utf8'));
  scratch = await mkdtemp(join(tmpdir(), 'alfred-provision-'));
  first = await provision('sandbox-a', { into: join(scratch, 'one') });
});

after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

// --- shape of what provision returns ---

test('provision returns the repo path, the origin path, and the head sha', () => {
  assert.equal(typeof first.repo, 'string');
  assert.equal(typeof first.origin, 'string');
  assert.match(first.head, /^[0-9a-f]{40}$/);
});

test('provision rejects a slug with no fixture directory', async () => {
  await assert.rejects(
    () => provision('sandbox-does-not-exist', { into: join(scratch, 'nope') }),
    /sandbox-does-not-exist/,
  );
});

// --- the origin ---

test('the origin is a bare repository', async () => {
  assert.equal(await git(first.origin, 'rev-parse', '--is-bare-repository'), 'true');
});

test('the origin and the working clone are at the same commit', async () => {
  const branch = manifest.commit_plan.default_branch;
  assert.equal(await git(first.origin, 'rev-parse', branch), first.head);
  assert.equal(await git(first.repo, 'rev-parse', 'HEAD'), first.head);
});

test('the clone has the origin configured as its remote', async () => {
  const url = await git(first.repo, 'remote', 'get-url', 'origin');
  assert.equal(url, first.origin);
});

// --- the working tree ---

test('the working clone is on the branch the manifest names', async () => {
  const branch = await git(first.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  assert.equal(branch, manifest.commit_plan.default_branch);
});

test('the working tree is clean — nothing modified, nothing untracked', async () => {
  assert.equal(await git(first.repo, 'status', '--porcelain'), '');
});

test('no provisioned filename retains the .src storage suffix', async () => {
  const files = await walk(first.repo);
  assert.deepEqual(files.filter((f) => f.endsWith('.src')), []);
});

test('the provisioned file count is the one the manifest measured', async () => {
  const files = await walk(first.repo);
  assert.equal(files.length, manifest.ground_truth.file_count_total);
});

test('every provisioned file is tracked by git, including .gitignore', async () => {
  const tracked = (await git(first.repo, 'ls-files')).split('\n').sort();
  const onDisk = (await walk(first.repo)).sort();
  assert.deepEqual(tracked, onDisk);
  assert.ok(tracked.includes('.gitignore'));
});

// --- determinism: the whole point ---

test('provisioning the same fixture twice yields the identical head sha', async () => {
  const second = await provision('sandbox-a', { into: join(scratch, 'two') });
  assert.equal(second.head, first.head);
});

test('provisioning twice yields the identical tree sha', async () => {
  const third = await provision('sandbox-a', { into: join(scratch, 'three') });
  assert.equal(
    await git(third.repo, 'rev-parse', 'HEAD^{tree}'),
    await git(first.repo, 'rev-parse', 'HEAD^{tree}'),
  );
});

test('the head sha provision produces is the one recorded in the manifest', () => {
  assert.equal(first.head, manifest.expected_shas.head);
});

test('the tree sha provision produces is the one recorded in the manifest', async () => {
  assert.equal(await git(first.repo, 'rev-parse', 'HEAD^{tree}'), manifest.expected_shas.tree);
});

// --- what makes the shas deterministic ---

test('author and committer identity come from the manifest, not the environment', async () => {
  const fmt = await git(first.repo, 'log', '-1', '--pretty=%an|%ae|%cn|%ce');
  const { author_name, author_email, committer_name, committer_email } = manifest.commit_plan;
  assert.equal(fmt, [author_name, author_email, committer_name, committer_email].join('|'));
});

test('author and committer dates are the pinned strings from the commit plan', async () => {
  const [{ date }] = manifest.commit_plan.commits;
  const expected = new Date(date).toISOString();
  const [authored, committed] = (
    await git(first.repo, 'log', '-1', '--pretty=%aI|%cI')
  ).split('|');
  assert.equal(new Date(authored).toISOString(), expected);
  assert.equal(new Date(committed).toISOString(), expected);
});

test('the commit is unsigned — a signature would vary per machine', async () => {
  const sig = await git(first.repo, 'log', '-1', '--pretty=%G?');
  assert.equal(sig, 'N');
});

test('provision pins autocrlf off, so line endings cannot vary by platform', async () => {
  assert.equal(await git(first.repo, 'config', 'core.autocrlf'), 'false');
});

test('the commit plan produces exactly the number of commits it declares', async () => {
  const count = await git(first.repo, 'rev-list', '--count', 'HEAD');
  assert.equal(Number(count), manifest.commit_plan.commits.length);
});

test('the commit message is the one the plan specifies', async () => {
  const [{ message }] = manifest.commit_plan.commits;
  assert.equal(await git(first.repo, 'log', '-1', '--pretty=%s'), message);
});

test('every provisioned file has mode 644 — an exec bit would change the tree sha', async () => {
  for (const rel of await walk(first.repo)) {
    const { mode } = await stat(join(first.repo, rel));
    assert.equal(mode & 0o777, 0o644, rel);
  }
});

test('the shas hold even under a hostile git environment', async () => {
  // "Same manifest -> same shas on any machine" is the claim, and my own machine
  // is the weakest possible test of it. This provisions through a child process
  // carrying a global gitconfig that sets a different identity, autocrlf on,
  // gpgsign on and a different default branch, plus conflicting GIT_* vars and a
  // non-UTC timezone — every input that could reasonably leak into a sha.
  const gitconfig = join(scratch, 'hostile.gitconfig');
  await writeFile(
    gitconfig,
    [
      '[user]', '\tname = Hostile Dev', '\temail = hostile@example.invalid',
      '[core]', '\tautocrlf = true',
      '[commit]', '\tgpgsign = true',
      '[init]', '\tdefaultBranch = trunk',
      '',
    ].join('\n'),
  );

  const script = join(scratch, 'hostile.mjs');
  const lib = fileURLToPath(new URL('../lib/fixture.mjs', import.meta.url));
  await writeFile(
    script,
    [
      `import { provision } from ${JSON.stringify(lib)};`,
      `const r = await provision('sandbox-a', { into: ${JSON.stringify(join(scratch, 'hostile'))} });`,
      'process.stdout.write(JSON.stringify({ head: r.head, tree: r.tree, branch: r.branch }));',
      '',
    ].join('\n'),
  );

  const { stdout } = await run(process.execPath, [script], {
    env: childEnv({
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_AUTHOR_NAME: 'Hostile',
      GIT_AUTHOR_EMAIL: 'hostile@example.invalid',
      GIT_COMMITTER_NAME: 'Hostile',
      GIT_COMMITTER_EMAIL: 'hostile@example.invalid',
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00+00:00',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00+00:00',
      TZ: 'Asia/Tokyo',
    }),
  });

  const got = JSON.parse(stdout);
  assert.equal(got.head, first.head);
  assert.equal(got.tree, first.tree);
  assert.equal(got.branch, manifest.commit_plan.default_branch);
});

test('a developer\'s own ~/.gitconfig cannot perturb the shas', async () => {
  // The hostile-environment test above passes even without GIT_CONFIG_GLOBAL
  // pinned, because provision strips every GIT_* var — so that env var never
  // reaches git either way. The input the pin actually defends is the config git
  // finds through HOME. Measured: a ~/.gitconfig setting core.hooksPath at a
  // pre-commit hook that appends a line moves the tree sha to a different value.
  //
  // Note it moves it *stably* — two provisions under the same bad HOME agree
  // with each other. So determinism-vs-itself cannot catch this class of bug;
  // only comparing against the recorded sha can.
  const home = join(scratch, 'fakehome');
  const hooks = join(scratch, 'fakehooks');
  await mkdir(home, { recursive: true });
  await mkdir(hooks, { recursive: true });
  await writeFile(
    join(hooks, 'pre-commit'),
    '#!/bin/sh\necho "// injected by a global hook" >> src/notify.js\ngit add src/notify.js\n',
    { mode: 0o755 },
  );
  await writeFile(join(home, '.gitconfig'), `[core]\n\thooksPath = ${hooks}\n`);

  const script = join(scratch, 'viahome.mjs');
  const lib = fileURLToPath(new URL('../lib/fixture.mjs', import.meta.url));
  await writeFile(
    script,
    [
      `import { provision } from ${JSON.stringify(lib)};`,
      `const r = await provision('sandbox-a', { into: ${JSON.stringify(join(scratch, 'viahome'))} });`,
      'process.stdout.write(JSON.stringify({ head: r.head, tree: r.tree }));',
      '',
    ].join('\n'),
  );

  const env = childEnv({ HOME: home });
  delete env.GIT_CONFIG_GLOBAL;
  const { stdout } = await run(process.execPath, [script], { env });

  const got = JSON.parse(stdout);
  assert.equal(got.tree, first.tree, 'a global hooksPath leaked into the commit');
  assert.equal(got.head, first.head);
});

// --- the provisioned repo actually works ---

test('the provisioned repo reproduces the ground-truth lint result', async () => {
  const { lint } = manifest.ground_truth;
  let stdout;
  let code = 0;
  try {
    ({ stdout } = await run(process.execPath, ['tools/lint.mjs'], {
      cwd: first.repo,
      env: childEnv(),
    }));
  } catch (err) {
    code = err.code;
    stdout = err.stdout;
  }
  assert.equal(code, lint.exit);
  assert.match(stdout, new RegExp(`^Found ${lint.errors} errors, ${lint.warnings} warnings$`, 'm'));
});

test('the provisioned repo reproduces the ground-truth test result', async () => {
  const { stdout } = await run(process.execPath, ['--test'], {
    cwd: first.repo,
    env: childEnv(),
  });
  const { tests } = manifest.ground_truth;
  assert.match(stdout, new RegExp(`^# tests ${tests.count}$`, 'm'));
  assert.match(stdout, new RegExp(`^# pass ${tests.pass}$`, 'm'));
  assert.match(stdout, new RegExp(`^# fail ${tests.fail}$`, 'm'));
});

// --- reprovisioning a fixed path ---
//
// Arm B needs a `user.json` alias, and an alias is a static path — so the same
// path has to be provisionable twice. Left unhandled, the second attempt fails
// deep inside `git remote add` with a message that says nothing about the cause.

test('reprovisioning an occupied path is refused, and the error says why', async () => {
  const into = join(scratch, 'occupied');
  await provision('sandbox-a', { into });

  await assert.rejects(() => provision('sandbox-a', { into }), (err) => {
    assert.match(err.message, /already/i);
    assert.match(err.message, /replace/);
    assert.ok(err.message.includes(into), 'the error must name the path');
    return true;
  });
});

test('replace reprovisions in place and lands on the identical shas', async () => {
  // The point of a fixed path: the alias keeps pointing at a start state that is
  // byte-identical to the one the manifest records, run after run.
  const into = join(scratch, 'replaced');
  const one = await provision('sandbox-a', { into });
  await writeFile(join(one.repo, 'arm-scribble.txt'), 'work from a previous arm\n');
  await run('git', ['-C', one.repo, 'commit', '--allow-empty', '-m', 'previous arm'], {
    env: childEnv({
      GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.invalid',
      GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.invalid',
    }),
  });

  const two = await provision('sandbox-a', { into, replace: true });
  assert.equal(two.repo, one.repo);
  assert.equal(two.head, manifest.expected_shas.head);
  assert.equal(two.tree, manifest.expected_shas.tree);
  // The previous arm's work must be gone, not merely committed over.
  await assert.rejects(() => stat(join(two.repo, 'arm-scribble.txt')));
  assert.equal(await git(two.repo, 'rev-list', '--count', 'HEAD'), '1');
});

test('replace refuses a directory holding files the fixture did not create', async () => {
  // `--into` is a user-supplied path and replace deletes. A typo pointed at a
  // real working directory must not be recoverable-by-luck.
  const into = join(scratch, 'someones-work');
  await mkdir(join(into, 'src'), { recursive: true });
  await writeFile(join(into, 'src', 'important.js'), 'export const keep = true;\n');

  await assert.rejects(() => provision('sandbox-a', { into, replace: true }), (err) => {
    assert.match(err.message, /did not create|refus/i);
    return true;
  });
  // And it really is still there.
  assert.ok(await stat(join(into, 'src', 'important.js')));
});

test('replace on a path that does not exist yet is not an error', async () => {
  const fresh = await provision('sandbox-a', { into: join(scratch, 'not-yet'), replace: true });
  assert.equal(fresh.head, manifest.expected_shas.head);
});

// --- isolation between arms ---

test('two provisions of the same fixture do not share a git directory', async () => {
  const second = await provision('sandbox-a', { into: join(scratch, 'four') });
  assert.notEqual(second.repo, first.repo);
  assert.notEqual(second.origin, first.origin);

  // A commit in one arm's clone must not be visible in the other's, or the
  // contamination bug from 1339 is back.
  await run('git', ['-C', second.repo, 'commit', '--allow-empty', '-m', 'arm work'], {
    env: childEnv({
      GIT_AUTHOR_NAME: 'A',
      GIT_AUTHOR_EMAIL: 'a@example.invalid',
      GIT_COMMITTER_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'a@example.invalid',
    }),
  });
  assert.notEqual(await git(second.repo, 'rev-parse', 'HEAD'), first.head);
  assert.equal(await git(first.repo, 'rev-parse', 'HEAD'), first.head);
});

// origin/HEAD, and how its absence was found.
//
// NOT by reading this file. By running `node eval/run-armc.mjs --run 1 --dry-run` against a
// provisioned clone: arm C's preflight reported "origin/HEAD is unset in the clone (control
// 7)" and it was correct. `provision` builds the clone with `git init` + `remote add` +
// `push`, and `refs/remotes/origin/HEAD` is written only by `git clone` — so control 7 could
// never have passed on any fixture, on any arm, and the check would have fired on every
// single invocation of the runner.
//
// WHY IT MATTERS BEYOND THE PREFLIGHT: Alfred's implement path resolves origin/HEAD when
// base_branch is null. On a clone missing it, the branch cut fails — and that failure would
// be scored as the topology's fault when it belongs to the fixture. A control that cannot
// pass is worse than no control, because it teaches the operator to read refusals as noise.
test('the provisioned clone has origin/HEAD set, so control 7 is satisfiable at all', async () => {
  assert.equal(
    await git(first.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD'),
    `refs/remotes/origin/${first.branch}`,
  );
});

test('setting origin/HEAD does not move the commit or tree sha', async () => {
  // The determinism this whole file exists to pin. origin/HEAD is a REF in the clone, not
  // an object in the history, so writing it must leave head and tree byte-identical — and
  // the manifest's expected_shas are what a later reader compares against. Measured rather
  // than reasoned: these are the two values recorded before the fix.
  assert.equal(first.head, 'fa052265902cc9acf3f7e370c4696a752c5f1100');
  assert.equal(first.tree, 'a5b0d41ee1f4260417d946e9cbe17d8ca17e1704');
  assert.equal(first.head, manifest.expected_shas.head);
  assert.equal(first.tree, manifest.expected_shas.tree);
});
