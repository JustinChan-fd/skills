// Guards the one structural rule the sandbox fixtures must obey:
// nothing stored under alfred/fixtures/ may be discoverable by `node --test`.
//
// Why this is a real hazard and not pedantry: `node --test` (v22.19.0, verified
// empirically) sweeps *any* .js/.mjs file inside a directory named `test` at any
// depth, plus *.test.js, *.test.mjs, *-test.js, *_test.js, test-*.js and test.js
// anywhere. There is no --test-exclude for paths, and a nested package.json does
// not stop descent.
//
// The sandbox-a fixture deliberately contains a test suite that goes RED when a
// load-bearing guard is deleted (SANDBOX.md §4, trap 4). If those files were
// discoverable, the skills repo's own `npm test` would run the fixture's suite,
// and the trap would turn THIS repo red instead of the provisioned fixture.
//
// So stored fixture files carry a .src suffix; provision strips it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDiscoverableByNodeTest, storedName, provisionedName } from '../lib/fixture.mjs';

const ALFRED = fileURLToPath(new URL('..', import.meta.url));

// --- the predicate: every row below was confirmed by running node --test ---

test('a .js file directly inside a dir named test is discoverable', () => {
  assert.equal(isDiscoverableByNodeTest('files/test/notify.js'), true);
});

test('a .mjs file inside a dir named test is discoverable', () => {
  assert.equal(isDiscoverableByNodeTest('files/test/notify.mjs'), true);
});

test('a file nested deeper under a dir named test is still discoverable', () => {
  assert.equal(isDiscoverableByNodeTest('files/test/deep/inner.js'), true);
});

test('a dir named test anywhere in the path counts, not just the last segment', () => {
  assert.equal(isDiscoverableByNodeTest('fixtures/sandbox-a/test/x.js'), true);
});

test('a .test.mjs file outside any test dir is discoverable', () => {
  assert.equal(isDiscoverableByNodeTest('files/src/notify.test.mjs'), true);
});

test('the -test.js suffix form is discoverable', () => {
  assert.equal(isDiscoverableByNodeTest('files/src/notify-test.js'), true);
});

test('the _test.js suffix form is discoverable', () => {
  assert.equal(isDiscoverableByNodeTest('files/src/notify_test.js'), true);
});

test('the test-*.js prefix form is discoverable', () => {
  assert.equal(isDiscoverableByNodeTest('files/src/test-notify.js'), true);
});

test('a bare test.js is discoverable', () => {
  assert.equal(isDiscoverableByNodeTest('files/src/test.js'), true);
});

test('a dir named tests (plural) is NOT discoverable — verified, not assumed', () => {
  assert.equal(isDiscoverableByNodeTest('files/tests/notify.js'), false);
});

test('an ordinary source file is not discoverable', () => {
  assert.equal(isDiscoverableByNodeTest('files/src/notify.js'), false);
});

test('a .json file inside a test dir is not discoverable — only .js and .mjs run', () => {
  assert.equal(isDiscoverableByNodeTest('files/test/cases.json'), false);
});

test('the .src suffix defeats every discovery pattern', () => {
  for (const p of [
    'files/test/notify.js.src',
    'files/test/deep/inner.mjs.src',
    'files/src/notify.test.mjs.src',
    'files/src/test.js.src',
  ]) {
    assert.equal(isDiscoverableByNodeTest(p), false, p);
  }
});

// --- the naming round-trip provision depends on ---

test('storedName appends .src to a path node --test would otherwise pick up', () => {
  assert.equal(storedName('test/channels.test.js'), 'test/channels.test.js.src');
});

test('storedName leaves an undiscoverable path alone — no pointless .src churn', () => {
  assert.equal(storedName('src/notify.js'), 'src/notify.js');
});

test('provisionedName strips exactly one trailing .src', () => {
  assert.equal(provisionedName('test/channels.test.js.src'), 'test/channels.test.js');
});

test('provisionedName leaves a path with no .src suffix unchanged', () => {
  assert.equal(provisionedName('src/notify.js'), 'src/notify.js');
});

test('storedName then provisionedName round-trips every fixture path', () => {
  for (const p of [
    'test/channels.test.js',
    'src/notify.js',
    'src/legacy/mergeFields.js',
    'tools/lint.mjs',
    'package.json',
  ]) {
    assert.equal(provisionedName(storedName(p)), p, p);
  }
});

// --- the invariant itself, over what is actually on disk ---

async function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      await walk(full, base, out);
    } else {
      out.push(relative(base, full));
    }
  }
  return out;
}

test('no file stored under alfred/fixtures is discoverable by node --test', async () => {
  const files = await walk(join(ALFRED, 'fixtures'));
  const leaked = files.filter(isDiscoverableByNodeTest);
  assert.deepEqual(
    leaked,
    [],
    `these fixture files would be executed by the skills repo's own npm test; ` +
      `rename them with a .src suffix: ${leaked.join(', ')}`,
  );
});
