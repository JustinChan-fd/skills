import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseIssueFromRunId, scanResidue } from '../tools/lib/residue.mjs';

function scaffold() {
  return mkdtempSync(join(tmpdir(), 'harness-residue-'));
}

function writeAudit(entries) {
  const dir = scaffold();
  const path = join(dir, 'audit.jsonl');
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

// Literal copies of this repo's OWN four historical .harness/audit.jsonl
// residue-ish notes, captured BEFORE the u1 standardization. Facts that make
// them the load-bearing fixture:
//   - Two carry data.type:"residue" (issue-2 intake, issue-3 intake) and two
//     carry the ad hoc data.type:"gate_residue" (issue-2 plan, issue-3 plan).
//   - Three carry data.detail; one (issue-3 intake) carries advisory_findings
//     instead and no detail.
//   - NONE carries data.criterion.
// A type-only filter would WRONGLY match the two data.type:"residue" entries;
// scanResidue must not match any of the four, precisely because none has a
// non-empty data.criterion.
const HISTORICAL = [
  {
    ts: '2026-07-27T02:32:15Z',
    run_id: '2026-07-27T022150Z__skills__intake__issue-2__b5808e',
    phase: 'intake',
    agent_id: 'driver',
    event: 'note',
    data: {
      type: 'residue',
      detail:
        'round-2 verifier noted the issue causal claim drivers copy the SKILL.md example verbatim is not broken out as its own claims_audit entry, though it is substantively corroborated by the separately verified structural match between the SKILL.md example and telemetry events; verifier judged this too minor to be blocking (score 0.96, result pass)',
    },
  },
  {
    ts: '2026-07-27T02:40:24.408Z',
    run_id: '2026-07-27T023521Z__skills__plan__issue-2__53e7f3',
    phase: 'plan',
    event: 'note',
    data: {
      type: 'gate_residue',
      detail:
        'verifier round 1 (score 0.95, advisory-fail) opened with residue: AC6 (post-merge live self-run) has no covering unit in plan.json and no explicit acknowledgment that it defers to the handoff landing checklist. Per harness-plan design this is correct (post-verification outcomes are not unit criteria), but the plan lacked a one-line acknowledgment. Resolved by adding it to plan.json risks before writing the handoff.',
    },
  },
  {
    ts: '2026-07-27T03:21:40Z',
    run_id: '2026-07-27T031429Z__skills__intake__issue-3__d365c0',
    phase: 'intake',
    agent_id: 'driver',
    event: 'note',
    data: {
      type: 'residue',
      advisory_findings: [
        "claims_audit min_samples entry does not separately fact-check the companion 'a 3-record window can't see one tick back' phrase",
        'constraints[3] scope guard is a reasonable inference, not a literal issue statement',
      ],
    },
  },
  {
    ts: '2026-07-27T03:36:00Z',
    run_id: '2026-07-27T032456Z__skills__plan__issue-3__376a3e',
    phase: 'plan',
    event: 'note',
    data: {
      type: 'gate_residue',
      gate_decision: 'open',
      round: 1,
      score: 0.9,
      result: 'advisory-fail',
      detail:
        'Verifier round 1 found one advisory finding: u2 done_criteria #2 as originally worded did not account for execFileSync throwing on the anomalies CLIs non-zero exit when findings are present. Plan amended in-place (single-writer) to note the try/catch-around-execFileSync requirement rather than looping another verifier round, since gate decision was open at score 0.9. Entry contract: all 6 draft criteria approved as-is by the verifier (no amendments).',
    },
  },
];

// A new note written in the FULL u1 shape (data.type + data.criterion +
// data.detail) for issue 2 — the entry scanResidue SHOULD surface.
const U1_SHAPED_ISSUE2 = {
  ts: '2026-07-27T05:30:00Z',
  run_id: '2026-07-27T053000Z__skills__implement__issue-2__abc123',
  phase: 'implement',
  event: 'note',
  data: {
    type: 'residue',
    criterion: 'AC1: PR body reproduces residue verbatim',
    detail: 'verifier round 1 advisory: landing-checklist table missing a trailing newline',
  },
};

test('parseIssueFromRunId parses the __issue-<n>__ segment as an integer', () => {
  assert.equal(parseIssueFromRunId('2026-07-27T022150Z__skills__intake__issue-2__b5808e'), 2);
  assert.equal(parseIssueFromRunId('2026-07-27T044632Z__skills__plan__issue-4__745ef3'), 4);
  assert.equal(parseIssueFromRunId('2026-07-27T031429Z__skills__intake__issue-13__d365c0'), 13);
});

test('parseIssueFromRunId returns null for adhoc/file-sourced run ids (no issue segment)', () => {
  assert.equal(parseIssueFromRunId('2026-07-27T050000Z__skills__intake__adhoc__x1y2z3'), null);
  assert.equal(parseIssueFromRunId('2026-07-27T050000Z__skills__intake__file__x1y2z3'), null);
  assert.equal(parseIssueFromRunId(''), null);
  assert.equal(parseIssueFromRunId(null), null);
});

test('scanResidue does NOT match this repo\'s four pre-standardization historical notes', () => {
  const auditPath = writeAudit(HISTORICAL);
  // Neither issue-2 nor issue-3 has any u1-shaped note in the fixture, so both
  // queries must come back empty even though two entries use type:"residue".
  assert.deepEqual(scanResidue({ auditPath, issue: 2 }), []);
  assert.deepEqual(scanResidue({ auditPath, issue: 3 }), []);
});

test('scanResidue matches a u1-shaped note but still excludes the type-only historical ones', () => {
  const auditPath = writeAudit([...HISTORICAL, U1_SHAPED_ISSUE2]);
  const hits = scanResidue({ auditPath, issue: 2 });
  assert.equal(hits.length, 1, 'exactly the one u1-shaped issue-2 note matches');
  assert.equal(hits[0].run_id, U1_SHAPED_ISSUE2.run_id);
  assert.equal(hits[0].data.criterion, 'AC1: PR body reproduces residue verbatim');
  assert.equal(hits[0].data.detail, U1_SHAPED_ISSUE2.data.detail);
  // The two historical data.type:"residue" notes for issue-2/issue-3 that a
  // type-only filter would grab must NOT appear in any result.
  const historicalIds = HISTORICAL.map((e) => e.run_id);
  assert.ok(!hits.some((h) => historicalIds.includes(h.run_id)));
});

test('scanResidue also matches data.type:"defect" when data.criterion is present', () => {
  const defect = {
    ts: '2026-07-27T05:31:00Z',
    run_id: '2026-07-27T053100Z__skills__implement__issue-2__def456',
    event: 'note',
    data: { type: 'defect', criterion: 'AC2', detail: 'cap reached with an unresolved advisory' },
  };
  const auditPath = writeAudit([defect]);
  const hits = scanResidue({ auditPath, issue: 2 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].data.type, 'defect');
});

test('scanResidue rejects an empty-string data.criterion (type alone is insufficient)', () => {
  const emptyCriterion = {
    ts: '2026-07-27T05:32:00Z',
    run_id: '2026-07-27T053200Z__skills__implement__issue-2__ghi789',
    event: 'note',
    data: { type: 'residue', criterion: '', detail: 'x' },
  };
  const auditPath = writeAudit([emptyCriterion]);
  assert.deepEqual(scanResidue({ auditPath, issue: 2 }), []);
});

test('scanResidue returns matches sorted oldest-to-newest by ts', () => {
  const newer = {
    ts: '2026-07-27T06:00:00Z',
    run_id: '2026-07-27T060000Z__skills__implement__issue-2__newer0',
    event: 'note',
    data: { type: 'residue', criterion: 'AC1', detail: 'newer' },
  };
  const older = {
    ts: '2026-07-27T04:00:00Z',
    run_id: '2026-07-27T040000Z__skills__implement__issue-2__older0',
    event: 'note',
    data: { type: 'residue', criterion: 'AC1', detail: 'older' },
  };
  const auditPath = writeAudit([newer, older]); // written out of order
  const hits = scanResidue({ auditPath, issue: 2 });
  assert.deepEqual(hits.map((h) => h.data.detail), ['older', 'newer']);
});

test('scanResidue ignores non-note events and other issues; missing file yields []', () => {
  const otherIssue = {
    ts: '2026-07-27T05:40:00Z',
    run_id: '2026-07-27T054000Z__skills__implement__issue-9__zzz999',
    event: 'note',
    data: { type: 'residue', criterion: 'AC1', detail: 'issue 9' },
  };
  const notANote = {
    ts: '2026-07-27T05:41:00Z',
    run_id: '2026-07-27T054100Z__skills__implement__issue-2__aaa111',
    event: 'phase_end',
    data: { type: 'residue', criterion: 'AC1', detail: 'not a note event' },
  };
  const auditPath = writeAudit([otherIssue, notANote]);
  assert.deepEqual(scanResidue({ auditPath, issue: 2 }), []);
  assert.deepEqual(scanResidue({ auditPath: join(scaffold(), 'nope.jsonl'), issue: 2 }), []);
});

// ── Jira issue keys (slugified in the run-id) ─────────────────────────────────
// A Jira-sourced run-id carries the slugified key: issue-tars-1271. residue
// forward-routing must work for those too — parse the slug, and match it
// against the real key the caller passes (case-insensitively).

test('parseIssueFromRunId parses a slugified Jira key segment as its slug string', () => {
  assert.equal(parseIssueFromRunId('2026-07-28T064201Z__webtarsthree__intake__issue-tars-1271__70b223'), 'tars-1271');
  assert.equal(parseIssueFromRunId('2026-07-28T000000Z__webtarsthree__plan__issue-ems-5__abc123'), 'ems-5');
});

test('parseIssueFromRunId still returns a number for a purely-numeric issue segment', () => {
  assert.equal(parseIssueFromRunId('2026-07-27T022150Z__skills__intake__issue-2__b5808e'), 2);
});

test('scanResidue matches a Jira-keyed run when the caller passes the real key (case-insensitive)', () => {
  const auditPath = writeAudit([
    {
      ts: '2026-07-28T06:00:00Z',
      run_id: '2026-07-28T064201Z__webtarsthree__intake__issue-tars-1271__70b223',
      phase: 'intake', agent_id: 'driver', event: 'note',
      data: { type: 'residue', criterion: 'AC-1 clientFetch timeout', detail: 'timeout not yet added' },
    },
  ]);
  // The loop passes the real key (TARS-1271); the run-id carries the slug (tars-1271).
  const hits = scanResidue({ auditPath, issue: 'TARS-1271' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].data.criterion, 'AC-1 clientFetch timeout');
});
