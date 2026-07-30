// Guards `files_from` — the mechanism that lets two fixture manifests share ONE
// source tree.
//
// SANDBOX.md §7: "Reusing one fake repo across all three is deliberate: the repo
// stops being a variable, so differences between runs are attributable to the
// ticket." That sentence is only literally true if there is one tree. A copied
// `files/` per slug makes "same repo" a claim maintained by hand, and the way it
// fails is silent — someone edits sandbox-a's sms.js, sandbox-b's copy does not
// move, and the two fixtures diverge with every suite still green.
//
// So sandbox-b carries no `files/` at all; it declares `files_from: "sandbox-a"`
// and provisions the identical tree. The coupling is real either way. This makes
// it LOUD: one tree means one set of expected shas, and an edit to sandbox-a
// fails both ground-truth suites at once.
//
// The cost is recorded rather than hidden (PLAN.md §8.3): editing sandbox-a's
// files/ now moves sandbox-b's ground truth too, and both manifests must be
// re-measured. The test named for that is the last one in this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { provision, readManifest, filesRoot } from '../lib/fixture.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

async function walk(root, base = root, out = []) {
  for (const e of await readdir(root, { withFileTypes: true })) {
    const full = join(root, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else out.push(relative(base, full));
  }
  return out;
}

async function inTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'alfred-shared-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- the resolver ---

test('filesRoot resolves a fixture with its own files/ to its own directory', async () => {
  const manifest = await readManifest('sandbox-a');
  assert.equal(await filesRoot('sandbox-a', manifest), join(FIXTURES, 'sandbox-a', 'files'));
});

test('filesRoot follows files_from to the donor fixture directory', async () => {
  assert.equal(
    await filesRoot('sandbox-b', { files_from: 'sandbox-a' }),
    join(FIXTURES, 'sandbox-a', 'files'),
  );
});

test('files_from pointing at a nonexistent fixture is an error naming both slugs', async () => {
  await assert.rejects(
    () => filesRoot('sandbox-b', { files_from: 'sandbox-zzz' }),
    (err) => {
      assert.match(err.message, /sandbox-b/);
      assert.match(err.message, /sandbox-zzz/);
      return true;
    },
  );
});

// A chain would make "which tree did this fixture provision" a graph traversal,
// and the whole point of files_from is that the answer is one hop and obvious.
test('files_from may not point at a fixture that itself uses files_from', async () => {
  await assert.rejects(
    () => filesRoot('sandbox-c', { files_from: 'sandbox-b' }),
    /chain|itself|indirect/i,
  );
});

test('a fixture declaring both its own files/ and files_from is refused', async () => {
  await assert.rejects(
    () => filesRoot('sandbox-a', { files_from: 'sandbox-a' }),
    /both/i,
  );
});

test('a fixture with neither files/ nor files_from is refused', async () => {
  await assert.rejects(() => filesRoot('sandbox-b', {}), /files_from|no files/i);
});

// --- provisioning through the shared tree ---

test('sandbox-b provisions the identical tree sha as sandbox-a', async () => {
  await inTemp(async (dir) => {
    const a = await provision('sandbox-a', { into: join(dir, 'a') });
    const b = await provision('sandbox-b', { into: join(dir, 'b') });
    assert.equal(b.tree, a.tree);
  });
});

// Stronger than equal trees: equal HEADs. The two manifests must therefore agree
// on the whole commit plan, not merely on file contents — a different author or
// date would give the same tree and a different commit, and "same repo state"
// would quietly stop meaning the same start state.
test('sandbox-b provisions the identical head sha as sandbox-a', async () => {
  await inTemp(async (dir) => {
    const a = await provision('sandbox-a', { into: join(dir, 'a') });
    const b = await provision('sandbox-b', { into: join(dir, 'b') });
    assert.equal(b.head, a.head);
  });
});

test('sandbox-b provisions byte-identical file contents to sandbox-a', async () => {
  await inTemp(async (dir) => {
    const a = await provision('sandbox-a', { into: join(dir, 'a') });
    const b = await provision('sandbox-b', { into: join(dir, 'b') });

    const filesA = (await walk(a.repo)).filter((p) => !p.startsWith('.git/')).sort();
    const filesB = (await walk(b.repo)).filter((p) => !p.startsWith('.git/')).sort();
    assert.deepEqual(filesB, filesA);

    for (const rel of filesA) {
      assert.equal(
        await readFile(join(b.repo, rel), 'utf8'),
        await readFile(join(a.repo, rel), 'utf8'),
        rel,
      );
    }
  });
});

// The provisioned directory is named for the slug being provisioned, not for the
// donor. An arm's repo path is recorded in run output and read by the scorer; if
// sandbox-b landed in a directory called sandbox-a, every artifact would name the
// wrong fixture.
test('the provisioned clone is named for the requested slug, not the donor', async () => {
  await inTemp(async (dir) => {
    const b = await provision('sandbox-b', { into: join(dir, 'b') });
    assert.equal(relative(b.root, b.repo), 'sandbox-b');
  });
});

test('sandbox-b has no files/ directory of its own', async () => {
  await assert.rejects(
    () => stat(join(FIXTURES, 'sandbox-b', 'files')),
    { code: 'ENOENT' },
    'sandbox-b must share sandbox-a\'s tree, not carry a copy that can drift',
  );
});

// --- the cost of sharing, asserted so it cannot be forgotten ---
//
// This is the §8.3 trade-off in test form. If someone edits sandbox-a's files/
// and re-measures only sandbox-a's expected_shas, this fails and names the other
// manifest that still needs updating.
test('both manifests record the same expected shas — one tree, one start state', async () => {
  const a = await readManifest('sandbox-a');
  const b = await readManifest('sandbox-b');
  assert.equal(
    b.expected_shas.head,
    a.expected_shas.head,
    'sandbox-b shares sandbox-a\'s files/, so an edit to that tree moves BOTH ' +
      'fixtures\' start state. Re-measure and update both manifests.',
  );
  assert.equal(b.expected_shas.tree, a.expected_shas.tree);
});

test('both manifests declare the same commit plan, field by field', async () => {
  const a = (await readManifest('sandbox-a')).commit_plan;
  const b = (await readManifest('sandbox-b')).commit_plan;
  assert.deepEqual(b, a, 'a differing commit plan would give the same tree and a different head');
});
