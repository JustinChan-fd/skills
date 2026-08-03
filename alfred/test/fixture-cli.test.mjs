// The `provision` CLI. SANDBOX.md §5 documents
// `lib/fixture.mjs provision sandbox-a` as the command that builds an arm's
// start state, so it has to actually be a command — a run script needs the paths
// on stdout, not a module import.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const LIB = fileURLToPath(new URL('../lib/fixture.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/sandbox-a', import.meta.url));

let scratch;
let manifest;

function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function cli(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [LIB, ...args], { env: childEnv() });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

before(async () => {
  manifest = JSON.parse(await readFile(join(FIXTURE, 'manifest.json'), 'utf8'));
  scratch = await mkdtemp(join(tmpdir(), 'alfred-cli-'));
});

after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test('provision prints JSON a run script can parse', async () => {
  const { code, stdout } = await cli('provision', 'sandbox-a', '--into', join(scratch, 'a'));
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.slug, 'sandbox-a');
  assert.equal(out.head, manifest.expected_shas.head);
  assert.equal(out.tree, manifest.expected_shas.tree);
  assert.equal(out.branch, manifest.commit_plan.default_branch);
  assert.ok(out.repo.startsWith(join(scratch, 'a')));
  assert.ok(out.origin.startsWith(join(scratch, 'a')));
});

test('provision does not dump the whole manifest to stdout', async () => {
  // The manifest declares every planted trap. Printing it where an arm's own
  // logs could pick it up would hand over the answer key.
  const { stdout } = await cli('provision', 'sandbox-a', '--into', join(scratch, 'b'));
  assert.doesNotMatch(stdout, /trap/i);
  assert.equal(JSON.parse(stdout).manifest, undefined);
});

test('--replace reprovisions an occupied path, and its absence is an error', async () => {
  // The eval script reprovisions a fixed path per arm, so this flag is on the
  // real run path — not a convenience.
  const into = join(scratch, 'cli-replace');
  const first = await cli('provision', 'sandbox-a', '--into', into);
  assert.equal(first.code, 0);

  const blocked = await cli('provision', 'sandbox-a', '--into', into);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /--replace/);

  const again = await cli('provision', 'sandbox-a', '--into', into, '--replace');
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.stdout).head, JSON.parse(first.stdout).head);
});

test('an unknown subcommand exits non-zero and says what is available', async () => {
  const { code, stderr } = await cli('teleport', 'sandbox-a');
  assert.equal(code, 1);
  assert.match(stderr, /provision/);
});

test('provision with no slug exits non-zero rather than guessing one', async () => {
  const { code, stderr } = await cli('provision');
  assert.equal(code, 1);
  assert.match(stderr, /slug/i);
});

test('an unknown fixture slug exits non-zero and names the slug', async () => {
  const { code, stderr } = await cli('provision', 'sandbox-nope');
  assert.equal(code, 1);
  assert.match(stderr, /sandbox-nope/);
});

test('importing the module runs no CLI side effects', async () => {
  // main() must not fire on import, or every test that imports this module would
  // provision a stray repo.
  const { stdout } = await run(
    process.execPath,
    ['-e', `import(${JSON.stringify(LIB)}).then(() => process.stdout.write('imported'))`],
    { env: childEnv() },
  );
  assert.equal(stdout, 'imported');
});
