// sync-eval-issue: projects manifest.json onto a GitHub issue.
//
// SANDBOX.md §6: the manifest is the ONLY source of truth for ticket text, and
// the issue is a projection of it. The properties that matter:
//   - idempotent: a second run changes nothing
//   - corrective: a hand-edited body is overwritten from the manifest
//   - abortive: if the fetched body disagrees with the manifest, the experiment
//     stops rather than measuring two arms against different tickets
//
// Every test here injects a fake `gh`. Nothing in this suite touches the network
// or the real repo — an eval harness that could only be tested by mutating a live
// issue would be untestable in practice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { issueBody, issueTitle, planSync, verifyBody } from '../lib/eval-issue.mjs';

const FIXTURE = fileURLToPath(new URL('../fixtures/sandbox-a', import.meta.url));
const manifest = JSON.parse(await readFile(join(FIXTURE, 'manifest.json'), 'utf8'));

// --- the projection ---

test('the issue body contains the ticket body verbatim', () => {
  assert.ok(issueBody(manifest).includes(manifest.ticket.body));
});

test('the issue body lists every acceptance criterion', () => {
  const body = issueBody(manifest);
  for (const ac of manifest.ticket.acceptance_criteria) {
    assert.ok(body.includes(ac.text), ac.id);
  }
});

test('the issue body leaks no trap, ground truth, or answer key', () => {
  // The manifest declares the planted traps and the measured ground truth. The
  // issue is what an arm reads. Projecting the whole manifest would hand over
  // the answer key and invalidate the run.
  const body = issueBody(manifest);
  assert.doesNotMatch(body, /trap/i);
  assert.doesNotMatch(body, /ground.?truth/i);
  assert.doesNotMatch(body, /unsatisfiable/i);
  assert.doesNotMatch(body, /load.?bearing/i);
  assert.doesNotMatch(body, /mergeFields\.js is/i);
  // The measured counts must not appear — the ticket's own wrong numbers may.
  assert.doesNotMatch(body, /7 errors/);
  assert.ok(body.includes('12 source files'), 'the ticket\'s WRONG count must survive');
});

test('the issue body is stable — same manifest, same bytes', () => {
  assert.equal(issueBody(manifest), issueBody(manifest));
});

test('the issue title is the one the manifest declares', () => {
  assert.equal(issueTitle(manifest), manifest.eval_issue.title);
});

test('the title marks the issue as an eval, so it is not mistaken for real work', () => {
  assert.match(issueTitle(manifest), /^\[eval:sandbox-a\]/);
});

// --- planSync: what to do, decided before anything is executed ---

test('with no recorded number and no existing issue, the plan is to create', () => {
  const plan = planSync({ manifest, existing: null });
  assert.equal(plan.action, 'create');
  assert.equal(plan.title, issueTitle(manifest));
  assert.equal(plan.body, issueBody(manifest));
});

test('an existing issue already matching the manifest is left alone', () => {
  const existing = { number: 21, title: issueTitle(manifest), body: issueBody(manifest) };
  const plan = planSync({ manifest, existing });
  assert.equal(plan.action, 'noop');
  assert.equal(plan.number, 21);
});

test('a hand-edited body plans an edit back to the manifest', () => {
  const existing = { number: 21, title: issueTitle(manifest), body: 'someone rewrote this' };
  const plan = planSync({ manifest, existing });
  assert.equal(plan.action, 'edit');
  assert.equal(plan.number, 21);
  assert.equal(plan.body, issueBody(manifest));
  assert.deepEqual(plan.fields, ['body']);
});

test('a hand-edited title plans an edit too', () => {
  const existing = { number: 21, title: 'Consolidate retries', body: issueBody(manifest) };
  const plan = planSync({ manifest, existing });
  assert.equal(plan.action, 'edit');
  assert.deepEqual(plan.fields, ['title']);
});

test('both drifted plans one edit naming both fields', () => {
  const existing = { number: 21, title: 'nope', body: 'nope' };
  const plan = planSync({ manifest, existing });
  assert.equal(plan.action, 'edit');
  assert.deepEqual(plan.fields, ['title', 'body']);
});

test('planning is idempotent — applying the plan then re-planning is a noop', () => {
  const created = { number: 99, title: issueTitle(manifest), body: issueBody(manifest) };
  assert.equal(planSync({ manifest, existing: created }).action, 'noop');
});

test('a closed issue is reopened rather than duplicated', () => {
  const existing = {
    number: 21, title: issueTitle(manifest), body: issueBody(manifest), state: 'CLOSED',
  };
  const plan = planSync({ manifest, existing });
  assert.equal(plan.action, 'reopen');
  assert.equal(plan.number, 21);
});

// --- verifyBody: the gate that aborts the experiment ---

test('verifyBody passes when the fetched body matches the manifest', () => {
  const result = verifyBody({ manifest, fetched: { body: issueBody(manifest) } });
  assert.equal(result.ok, true);
});

test('verifyBody fails when the fetched body drifted, and says so', () => {
  const result = verifyBody({ manifest, fetched: { body: 'drifted' } });
  assert.equal(result.ok, false);
  assert.match(result.detail, /manifest/i);
});

test('verifyBody fails on a missing issue rather than passing vacuously', () => {
  // A null fetch must not read as "nothing to compare, so fine" — that would let
  // the experiment run against no ticket at all.
  assert.equal(verifyBody({ manifest, fetched: null }).ok, false);
});

test('verifyBody ignores trailing-whitespace differences only', () => {
  // GitHub round-trips bodies with \r\n and can add a trailing newline. Those are
  // not drift. Anything else is.
  const body = issueBody(manifest);
  assert.equal(verifyBody({ manifest, fetched: { body: `${body}\n` } }).ok, true);
  assert.equal(verifyBody({ manifest, fetched: { body: body.replace(/\n/g, '\r\n') } }).ok, true);
  assert.equal(verifyBody({ manifest, fetched: { body: body.replace('12 source', '8 source') } }).ok, false);
});
