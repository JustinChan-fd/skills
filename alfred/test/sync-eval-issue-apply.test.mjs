// The executable half of sync-eval-issue: the `gh` calls, and the write-back of
// the issue number into the manifest.
//
// `gh` is injected as a recording fake throughout. A sync that could only be
// tested by mutating a live issue would not get tested, and this one runs as a
// prerequisite of every eval — it has to be trustworthy while offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { issueBody, issueTitle } from '../lib/eval-issue.mjs';
import { findEvalIssue, syncEvalIssue } from '../lib/eval-issue-sync.mjs';

const FIXTURE = fileURLToPath(new URL('../fixtures/sandbox-a', import.meta.url));
const manifest = JSON.parse(await readFile(join(FIXTURE, 'manifest.json'), 'utf8'));

// A recording fake `gh`. Keyed on the subcommand shape so a call the
// implementation was not supposed to make shows up as an unexpected-call throw
// rather than silently returning undefined.
function fakeGh(responses = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const key = args.slice(0, 3).join(' ');
    if (key in responses) {
      const value = responses[key];
      return typeof value === 'function' ? value(args) : value;
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  gh.calls = calls;
  return gh;
}

async function scratchManifest() {
  const dir = await mkdtemp(join(tmpdir(), 'eval-issue-'));
  const path = join(dir, 'manifest.json');
  await writeFile(path, JSON.stringify(manifest, null, 2));
  return { dir, path };
}

// --- finding the existing issue ---

test('findEvalIssue looks up by the recorded number when there is one', async () => {
  const gh = fakeGh({
    'issue view 21': JSON.stringify({
      number: 21, title: issueTitle(manifest), body: issueBody(manifest), state: 'OPEN',
    }),
  });
  const found = await findEvalIssue({ manifest: withNumber(21), gh });
  assert.equal(found.number, 21);
  assert.ok(gh.calls[0].includes('--repo'));
  assert.ok(gh.calls[0].includes(manifest.eval_issue.repo));
});

test('findEvalIssue searches by title when no number is recorded', async () => {
  const gh = fakeGh({
    'issue list --repo': JSON.stringify([
      { number: 7, title: issueTitle(manifest), body: issueBody(manifest), state: 'OPEN' },
    ]),
  });
  const found = await findEvalIssue({ manifest, gh });
  assert.equal(found.number, 7);
});

test('findEvalIssue returns null when the search finds nothing', async () => {
  const gh = fakeGh({ 'issue list --repo': '[]' });
  assert.equal(await findEvalIssue({ manifest, gh }), null);
});

test('findEvalIssue ignores an unrelated issue that merely shares the label', async () => {
  const gh = fakeGh({
    'issue list --repo': JSON.stringify([
      { number: 4, title: '[eval:sandbox-b] something else', body: 'x', state: 'OPEN' },
    ]),
  });
  assert.equal(await findEvalIssue({ manifest, gh }), null);
});

test('a recorded number that 404s falls back to search rather than throwing', async () => {
  // The issue can be deleted out from under the manifest. Re-creating is correct;
  // crashing the eval on a stale number is not.
  const gh = fakeGh({
    'issue view 99': () => { throw new Error('gh: issue not found'); },
    'issue list --repo': '[]',
  });
  assert.equal(await findEvalIssue({ manifest: withNumber(99), gh }), null);
});

// --- applying ---

test('a create call passes the title, body, and eval label', async () => {
  const { dir, path } = await scratchManifest();
  const gh = fakeGh({
    'issue list --repo': '[]',
    'issue create --repo': 'https://github.com/JustinChan-fd/skills/issues/31\n',
  });
  const result = await syncEvalIssue({ manifestPath: path, gh });

  assert.equal(result.action, 'create');
  assert.equal(result.number, 31);
  const create = gh.calls.find((c) => c[1] === 'create');
  assert.ok(create.includes('--label'));
  assert.ok(create.includes(manifest.eval_issue.labels[0]));
  assert.ok(create.includes(issueTitle(manifest)));
  assert.ok(create.includes(issueBody(manifest)));
  await rm(dir, { recursive: true, force: true });
});

test('the created issue number is written back into the manifest', async () => {
  const { dir, path } = await scratchManifest();
  const gh = fakeGh({
    'issue list --repo': '[]',
    'issue create --repo': 'https://github.com/JustinChan-fd/skills/issues/31\n',
  });
  await syncEvalIssue({ manifestPath: path, gh });

  const written = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(written.eval_issue.number, 31);
  // Writing back must not disturb anything else — the ticket text especially.
  assert.equal(written.ticket.body, manifest.ticket.body);
  assert.deepEqual(written.ground_truth, manifest.ground_truth);
  assert.deepEqual(written.expected_shas, manifest.expected_shas);
  await rm(dir, { recursive: true, force: true });
});

test('a matching issue makes no write call at all', async () => {
  const { dir, path } = await scratchManifest();
  const gh = fakeGh({
    'issue list --repo': JSON.stringify([
      { number: 7, title: issueTitle(manifest), body: issueBody(manifest), state: 'OPEN' },
    ]),
  });
  const result = await syncEvalIssue({ manifestPath: path, gh });

  assert.equal(result.action, 'noop');
  assert.deepEqual(gh.calls.filter((c) => ['create', 'edit', 'reopen'].includes(c[1])), []);
  await rm(dir, { recursive: true, force: true });
});

test('a hand-edited body is corrected by an edit call', async () => {
  const { dir, path } = await scratchManifest();
  const gh = fakeGh({
    'issue list --repo': JSON.stringify([
      { number: 7, title: issueTitle(manifest), body: 'someone rewrote this', state: 'OPEN' },
    ]),
    'issue edit 7': '',
  });
  const result = await syncEvalIssue({ manifestPath: path, gh });

  assert.equal(result.action, 'edit');
  const edit = gh.calls.find((c) => c[1] === 'edit');
  assert.ok(edit.includes('--body'));
  assert.ok(edit.includes(issueBody(manifest)));
  await rm(dir, { recursive: true, force: true });
});

test('syncing twice in a row performs no second write', async () => {
  // Idempotence is the property SANDBOX.md §6 asserts, and it is what lets sync
  // run as a prerequisite of every eval without churning the issue.
  const { dir, path } = await scratchManifest();
  const state = { number: 7, title: issueTitle(manifest), body: 'drifted', state: 'OPEN' };
  const gh = fakeGh({
    'issue list --repo': () => JSON.stringify([state]),
    'issue view 7': () => JSON.stringify(state),
    'issue edit 7': (args) => {
      state.body = args[args.indexOf('--body') + 1];
      return '';
    },
  });

  assert.equal((await syncEvalIssue({ manifestPath: path, gh })).action, 'edit');
  const writesAfterFirst = gh.calls.filter((c) => c[1] === 'edit').length;
  assert.equal((await syncEvalIssue({ manifestPath: path, gh })).action, 'noop');
  assert.equal(gh.calls.filter((c) => c[1] === 'edit').length, writesAfterFirst);
  await rm(dir, { recursive: true, force: true });
});

test('a closed eval issue is reopened, not duplicated', async () => {
  const { dir, path } = await scratchManifest();
  const gh = fakeGh({
    'issue list --repo': JSON.stringify([
      { number: 7, title: issueTitle(manifest), body: issueBody(manifest), state: 'CLOSED' },
    ]),
    'issue reopen 7': '',
  });
  const result = await syncEvalIssue({ manifestPath: path, gh });

  assert.equal(result.action, 'reopen');
  assert.deepEqual(gh.calls.filter((c) => c[1] === 'create'), []);
  await rm(dir, { recursive: true, force: true });
});

// --- dry run ---

test('a dry run reports the action and makes no write call', async () => {
  const { dir, path } = await scratchManifest();
  const gh = fakeGh({ 'issue list --repo': '[]' });
  const result = await syncEvalIssue({ manifestPath: path, gh, dryRun: true });

  assert.equal(result.action, 'create');
  assert.equal(result.dryRun, true);
  assert.deepEqual(gh.calls.filter((c) => c[1] === 'create'), []);
  // Asserted as "unchanged from what was written", not as "=== null". The scratch
  // manifest is copied from the real one, whose `number` stops being null the first
  // time an eval issue is actually created — an assertion pinned to null tests the
  // state of the repo, not the behaviour of a dry run.
  const before = manifest.eval_issue.number ?? null;
  const untouched = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(untouched.eval_issue.number ?? null, before);
  await rm(dir, { recursive: true, force: true });
});

test('a dry run against a missing manifest fails loudly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eval-issue-missing-'));
  await mkdir(join(dir, 'empty'), { recursive: true });
  await assert.rejects(
    () => syncEvalIssue({ manifestPath: join(dir, 'empty', 'manifest.json'), gh: fakeGh(), dryRun: true }),
    /manifest/i,
  );
  await rm(dir, { recursive: true, force: true });
});

function withNumber(number) {
  return { ...manifest, eval_issue: { ...manifest.eval_issue, number } };
}
