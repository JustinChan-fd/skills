// transcript — finding the transcript a worker we launched just wrote.
//
// WHY THIS IS NOT A DISCOVERY LAYER, WHICH lib/report.mjs's HEADER REFUSES BY NAME. That
// refusal is aimed at SEARCHING: the old collector's `discoverLoopTranscript` fingerprinted
// candidate files by `observedTotal` and widened through four strategies, and a searcher can
// find the wrong file and report a confident number for a session that is not the one that
// ended. Nothing here searches. The vendor CLI reports its own `session_id` in the
// `--output-format json` result it writes to our log, we know the cwd because we chose it, and
// the path is a fixed formula from those two. One candidate, computed; zero read and rejected.
//
// THE FORMULA IS MEASURED, NOT GUESSED, and both halves of it bite:
//
//   realpath('/tmp/alfred-e2e/notify')  === '/private/tmp/alfred-e2e/notify'
//
// so a run launched under `/tmp` — which is every run of the e2e fixture — writes its
// transcript under the RESOLVED path. Composing the un-resolved one finds nothing, and a
// reporter that finds nothing reports a run that spent $1.07 as unmeasurable.
//
// Then the mangling, verified against two directories that exist on this machine right now:
//
//   /private/tmp/alfred-e2e/notify
//     -> -private-tmp-alfred-e2e-notify
//   /Users/206618626@bwt3.com/.claude/jobs/c695fb15/tmp/probe
//     -> -Users-206618626-bwt3-com--claude-jobs-c695fb15-tmp-probe
//
// The second is the one worth keeping: the `@` in the username and the dot of `.claude` each
// become a dash, and `/.` becomes the DOUBLE dash that a naive `replace(/\//g, '-')` would
// never produce. Anything cleverer than "every non-alphanumeric becomes a dash" gets it wrong.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { projectDirFor, sessionFromWorkerLog, transcriptPathFor } from '../lib/transcript.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'alfred-transcript-'));

test('the project directory is every non-alphanumeric character replaced by a dash', () => {
  // The two measured cases. Pinned as literals because this is the one piece of the path
  // that cannot be derived from anything — it is a vendor convention, and the only evidence
  // that we have it right is that these strings name directories that exist.
  assert.equal(
    projectDirFor('/private/tmp/alfred-e2e/notify', { home: '/h' }),
    '/h/.claude/projects/-private-tmp-alfred-e2e-notify',
  );
  // The `@` and the `/.` are the reason a hand-rolled slash-to-dash pass is not enough.
  assert.equal(
    projectDirFor('/Users/206618626@bwt3.com/.claude/jobs/c695fb15/tmp/probe', { home: '/h' }),
    '/h/.claude/projects/-Users-206618626-bwt3-com--claude-jobs-c695fb15-tmp-probe',
  );
});

test('a symlinked cwd resolves before it is mangled, because the vendor resolves it too', () => {
  // Not a hypothetical: `/tmp` IS a symlink to `/private/tmp` on this platform, so every run
  // of the e2e fixture takes this path. A reporter composing the unresolved spelling looks
  // under `-tmp-…` for a transcript the CLI wrote under `-private-tmp-…`, finds nothing, and
  // reports a run that cost real money as one it could not read.
  const dir = tmp();
  const target = join(dir, 'real');
  const link = join(dir, 'link');
  mkdirSync(target);
  symlinkSync(target, link);

  assert.equal(
    projectDirFor(link, { home: '/h' }),
    projectDirFor(realpathSync(target), { home: '/h' }),
    'the symlink and its target composed different project directories',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('an unresolvable cwd still yields a path rather than throwing', () => {
  // A repo deleted between the spawn and the report is a plausible tick, and the reporter is
  // a sidecar: it must never be the thing that kills a run whose work already succeeded. So
  // the un-resolved spelling is used and the caller finds no transcript there, which is a
  // reported hole rather than an exception.
  const gone = join(tmp(), 'never-existed');
  assert.equal(
    projectDirFor(gone, { home: '/h' }),
    `/h/.claude/projects/${gone.replace(/[^A-Za-z0-9]/g, '-')}`,
  );
});

test('the transcript is <project-dir>/<session-id>.jsonl', () => {
  assert.equal(
    transcriptPathFor({ cwd: '/private/tmp/x', sessionId: 'abc-123', home: '/h' }),
    '/h/.claude/projects/-private-tmp-x/abc-123.jsonl',
  );
});

test('a session id is read out of the worker log the CLI wrote, not guessed', () => {
  // The shape is the real one: `--output-format json` writes a single object whose
  // `session_id` and `total_cost_usd` are the CLI's own account of the run it just did.
  const log = JSON.stringify({
    type: 'result',
    session_id: 'af60fd37-1d43-40a6-b3e1-48482eab3344',
    total_cost_usd: 1.0671731999999998,
    num_turns: 42,
  });
  const found = sessionFromWorkerLog(log);
  assert.equal(found.session_id, 'af60fd37-1d43-40a6-b3e1-48482eab3344');
  assert.equal(found.total_cost_usd, 1.0671731999999998);
});

test('a truncated worker log yields nulls, never an exception', () => {
  // A worker killed at the wall cap is exactly the run whose accounting matters most, and its
  // log is a half-written JSON object. `JSON.parse` throwing here would turn the most
  // interesting run into a crash inside the loop, so the failure is a value.
  for (const text of ['{"session_id": "abc", "tot', '', 'not json at all', null, undefined]) {
    const found = sessionFromWorkerLog(text);
    assert.equal(found.session_id, null, `threw or guessed on ${JSON.stringify(text)}`);
    assert.equal(found.total_cost_usd, null);
  }
});

test('a log that parses but carries no session id is not mistaken for one that does', () => {
  // An error result is still valid JSON. Reporting `session_id: undefined` would compose
  // `<project-dir>/undefined.jsonl`, and a file at that path from an earlier bug would be
  // read as this run's — the wrong-session defect report.mjs's header refuses.
  const found = sessionFromWorkerLog(JSON.stringify({ type: 'result', is_error: true }));
  assert.equal(found.session_id, null);
  assert.equal(found.total_cost_usd, null);
});
