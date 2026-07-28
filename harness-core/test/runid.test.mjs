import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunId, parseRunId, slugifyRepo, KINDS } from '../tools/lib/runid.mjs';

const NOW = new Date('2026-07-24T18:30:12.345Z');

test('generates the exact spec stem format', () => {
  const id = makeRunId({ repo: 'myapp', kind: 'intake', source: 'issue-123', now: NOW, shortid: 'a3f9c1' });
  assert.equal(id, '2026-07-24T183012Z__myapp__intake__issue-123__a3f9c1');
});

test('round-trips every kind/source combination', () => {
  for (const kind of KINDS) {
    for (const source of ['issue-99', 'adhoc', 'file']) {
      const id = makeRunId({ repo: 'my-app', kind, source, now: NOW });
      const parsed = parseRunId(id);
      assert.equal(parsed.repo, 'my-app');
      assert.equal(parsed.kind, kind);
      assert.equal(parsed.source, source);
      assert.match(parsed.shortid, /^[0-9a-f]{6}$/);
    }
  }
});

test('rejects invalid kind and source', () => {
  assert.throws(() => makeRunId({ repo: 'x', kind: 'bridge', source: 'adhoc' }), /invalid kind/);
  assert.throws(() => makeRunId({ repo: 'x', kind: 'intake', source: 'jira-1' }), /invalid source/);
});

test('accepts a slugified Jira issue key as the source (issue-tars-1271) and round-trips it', () => {
  const id = makeRunId({ repo: 'webtarsthree', kind: 'intake', source: 'issue-tars-1271', now: NOW, shortid: 'abc123' });
  assert.equal(id, '2026-07-24T183012Z__webtarsthree__intake__issue-tars-1271__abc123');
  const parsed = parseRunId(id);
  assert.equal(parsed.source, 'issue-tars-1271');
  assert.equal(parsed.kind, 'intake');
  assert.equal(parsed.repo, 'webtarsthree');
});

test('still rejects an issue source with uppercase or unsafe chars (must be pre-slugified)', () => {
  assert.throws(() => makeRunId({ repo: 'x', kind: 'intake', source: 'issue-TARS-1271' }), /invalid source/);
});

test('slugifyRepo prevents separator ambiguity', () => {
  assert.equal(slugifyRepo('My App!!'), 'my-app');
  assert.equal(slugifyRepo('a--b'), 'a-b');
  assert.equal(parseRunId('garbage'), null);
});
