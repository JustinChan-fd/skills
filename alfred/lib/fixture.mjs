// Sandbox fixture provisioning. See docs/SANDBOX.md.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, readFile, copyFile, chmod, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

// `node --test` discovery patterns, confirmed empirically against v22.19.0
// rather than read off the docs. Two independent rules:
//   1. ANY .js/.mjs file inside a directory named exactly `test`, at any depth.
//   2. A basename matching one of the test-ish forms below, anywhere.
// `tests/`, `__tests__/` and `spec/` are NOT swept. There is no path-exclude
// flag, and a nested package.json does not stop descent — hence the .src
// suffix convention that this module implements and test/fixture-layout
// enforces over what is actually on disk.

const TESTISH_BASENAME =
  /(?:^test\.(?:js|mjs|cjs)$|^test-.*\.(?:js|mjs|cjs)$|[.\-_]test\.(?:js|mjs|cjs)$)/;

const RUNNABLE_EXT = /\.(?:js|mjs|cjs)$/;

const STORED_SUFFIX = '.src';

export function isDiscoverableByNodeTest(path) {
  const segments = path.split('/');
  const basename = segments.pop();

  // Rule 1: inside a directory named `test`.
  if (segments.includes('test') && RUNNABLE_EXT.test(basename)) return true;

  // Rule 2: a test-ish basename.
  return TESTISH_BASENAME.test(basename);
}

export function storedName(path) {
  return isDiscoverableByNodeTest(path) ? path + STORED_SUFFIX : path;
}

export function provisionedName(path) {
  return path.endsWith(STORED_SUFFIX) ? path.slice(0, -STORED_SUFFIX.length) : path;
}

// --- provisioning ---
//
// Builds a bare `origin.git` plus a working clone from `files/` and the
// manifest's commit plan. Everything git would otherwise read from the ambient
// environment is pinned, so the same manifest yields the same shas on any
// machine: identity, dates, signing, and line endings. That is what makes a
// fixed start state possible, and it is why each arm gets its own freshly
// provisioned pair rather than sharing a long-lived repo it could contaminate.

const FILE_MODE = 0o644;

async function walk(root, base = root, out = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

// Environment stripped of anything that would leak the host's git identity or
// config into the commit. `GIT_CONFIG_GLOBAL=/dev/null` is what keeps a
// developer's ~/.gitconfig — commit.gpgsign, core.autocrlf, init.defaultBranch —
// from changing the resulting sha.
function gitEnv(plan, commit) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: plan.author_name,
    GIT_AUTHOR_EMAIL: plan.author_email,
    GIT_COMMITTER_NAME: plan.committer_name,
    GIT_COMMITTER_EMAIL: plan.committer_email,
    ...(commit ? { GIT_AUTHOR_DATE: commit.date, GIT_COMMITTER_DATE: commit.date } : {}),
  };
}

async function git(cwd, args, env) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { env });
  return stdout.trim();
}

export async function readManifest(slug) {
  const path = join(FIXTURES, slug, 'manifest.json');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    throw new Error(`no fixture manifest for '${slug}' at ${path}`, { cause });
  }
}

// Which `files/` tree a fixture provisions from.
//
// A manifest may declare `files_from: "<slug>"` instead of carrying its own
// `files/`, and then provisions the donor's tree byte-for-byte. SANDBOX.md §7
// wants one repo across all three sandbox shapes so the repo stops being a
// variable — which is only literally true with one tree. A copy per slug makes
// "same repo" a claim maintained by hand, and it fails silently: edit
// sandbox-a's sms.js, sandbox-b's copy does not move, both suites stay green.
// Sharing makes the coupling loud instead — one tree, one set of expected shas,
// and an edit fails every sharing fixture's ground-truth suite at once.
//
// One hop only. A chain would turn "which tree did this provision" into a graph
// traversal, and being obvious is the entire point.
export async function filesRoot(slug, manifest) {
  const own = join(FIXTURES, slug, 'files');
  const from = manifest?.files_from;

  if (!from) {
    if (!existsSync(own)) {
      throw new Error(
        `fixture '${slug}' has no files/ directory and declares no files_from. ` +
          'A fixture must either carry its own source tree or name the one it shares.',
      );
    }
    return own;
  }

  if (existsSync(own)) {
    throw new Error(
      `fixture '${slug}' declares both its own files/ and files_from: '${from}'. ` +
        'Only one can be the source tree — delete files/ or drop files_from.',
    );
  }

  const donorDir = join(FIXTURES, from);
  const donorFiles = join(donorDir, 'files');
  if (!existsSync(donorFiles)) {
    // Distinguish "no such fixture" from "that fixture shares too", because the
    // fix differs and the error is the only place the reader learns which.
    if (existsSync(donorDir)) {
      const donor = await readManifest(from).catch(() => null);
      if (donor?.files_from) {
        throw new Error(
          `fixture '${slug}' names files_from: '${from}', but '${from}' itself uses ` +
            `files_from: '${donor.files_from}'. Indirect sharing is not supported — ` +
            'point at the fixture that actually owns the tree. One hop only.',
        );
      }
    }
    throw new Error(
      `fixture '${slug}' names files_from: '${from}', but there is no files/ tree at ` +
        `${donorFiles}.`,
    );
  }

  return donorFiles;
}

// Written at the root of every provisioned tree. `replace` deletes a directory
// the caller named, and `--into` is user-supplied — so it only ever deletes a
// tree carrying this marker. A typo pointing at real work is refused instead.
const MARKER = '.alfred-fixture';

async function isEmptyDir(path) {
  try {
    return (await readdir(path)).length === 0;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
}

// A fixed `--into` path is what a `user.json` alias needs (SANDBOX.md §6): an
// alias is static, so the same path must be provisionable repeatedly. Doing that
// silently would be worse — an arm could inherit a previous arm's commits — so
// reuse is explicit, and an occupied path without `replace` is refused here
// rather than failing later inside `git remote add`.
async function prepareRoot(root, slug, replace) {
  if (await isEmptyDir(root)) return;

  if (!replace) {
    throw new Error(
      `${root} already exists and is not empty. Pass replace (or --replace) to ` +
        'reprovision it from scratch, or choose another --into path.',
    );
  }

  const marked = existsSync(join(root, MARKER));
  if (!marked) {
    throw new Error(
      `refusing to replace ${root}: it holds files this fixture did not create ` +
        `(no ${MARKER} marker). Delete it by hand if that is really what you want.`,
    );
  }
  await rm(root, { recursive: true, force: true });
}

export async function provision(slug, { into, replace = false } = {}) {
  const manifest = await readManifest(slug);
  const plan = manifest.commit_plan;
  const branch = plan.default_branch;

  const root = into ?? (await mkdtemp(join(tmpdir(), `alfred-${slug}-`)));
  await prepareRoot(root, slug, replace);
  const origin = join(root, 'origin.git');
  const repo = join(root, slug);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, MARKER), `${slug}\n`);
  await mkdir(origin, { recursive: true });
  await mkdir(repo, { recursive: true });

  const baseEnv = gitEnv(plan);
  await execFileAsync('git', ['init', '--bare', `--initial-branch=${branch}`, origin], {
    env: baseEnv,
  });
  await execFileAsync('git', ['init', `--initial-branch=${branch}`, repo], { env: baseEnv });

  // Pinned in the repo's own config too, not just the environment, so a later
  // commit made by an arm behaves the same way.
  await git(repo, ['config', 'core.autocrlf', String(plan.autocrlf)], baseEnv);
  await git(repo, ['config', 'commit.gpgsign', String(plan.gpgsign)], baseEnv);
  await git(repo, ['config', 'user.name', plan.committer_name], baseEnv);
  await git(repo, ['config', 'user.email', plan.committer_email], baseEnv);
  await git(repo, ['remote', 'add', 'origin', origin], baseEnv);

  // May be another fixture's tree — see filesRoot. The provisioned clone is still
  // named for the requested slug, because an arm's repo path is recorded in run
  // output and read by the scorer.
  const src = await filesRoot(slug, manifest);
  for (const commit of plan.commits) {
    // `includes: "all files"` is the only form the single-commit plans need so
    // far. A per-commit file list would slot in here.
    if (commit.includes !== 'all files') {
      throw new Error(`unsupported commit_plan includes: ${commit.includes}`);
    }
    for (const stored of await walk(src)) {
      const dest = join(repo, provisionedName(stored));
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(src, stored), dest);
      // An inherited exec bit would change the tree sha.
      await chmod(dest, FILE_MODE);
    }
    const env = gitEnv(plan, commit);
    await git(repo, ['add', '--all', '--force'], env);
    await git(repo, ['commit', '--no-gpg-sign', '-m', commit.message], env);
  }

  await git(repo, ['push', '--quiet', 'origin', branch], baseEnv);
  const head = await git(repo, ['rev-parse', 'HEAD'], baseEnv);
  const tree = await git(repo, ['rev-parse', 'HEAD^{tree}'], baseEnv);

  return { slug, root, repo, origin, branch, head, tree, manifest };
}

// --- CLI ---
//
//   node lib/fixture.mjs provision <slug> [--into <dir>] [--replace]
//
// Prints the paths and shas as JSON so a run script can consume them. The
// manifest is deliberately NOT included: it declares every planted trap, and
// stdout may end up somewhere an arm can read.

const USAGE = 'usage: fixture.mjs provision <slug> [--into <dir>] [--replace]';

export async function main(argv) {
  const [subcommand, ...rest] = argv;

  if (subcommand !== 'provision') {
    throw new Error(`unknown subcommand '${subcommand ?? ''}'. ${USAGE}`);
  }

  const slug = rest.find((arg) => !arg.startsWith('--'));
  if (!slug) throw new Error(`missing fixture slug. ${USAGE}`);

  const flag = rest.indexOf('--into');
  const into = flag === -1 ? undefined : rest[flag + 1];
  if (flag !== -1 && !into) throw new Error(`--into needs a directory. ${USAGE}`);

  const replace = rest.includes('--replace');
  const { manifest: _manifest, ...result } = await provision(slug, { into, replace });
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
