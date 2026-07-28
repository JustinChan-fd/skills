// jira.mjs: normalize the mcp__atlassian__getJiraIssue response shape into the
// neutral intake input the SKILL.md consumes — so the skill never hand-parses
// Jira JSON and plan/implement never re-hit Jira (they read the manifest).
// SOURCE: field set from the legacy harness-intake skill's getJiraIssue call
// (fields: summary, description, issuetype, parent, project; markdown format).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJiraIssue, changeTypeFromIssueType } from '../tools/lib/jira.mjs';

const sample = {
  key: 'TARS-1271',
  fields: {
    summary: 'Clear button does not reset the date filter',
    description: 'When a user clicks Clear, the date range stays selected.\n\nExpected: all filters reset.',
    issuetype: { name: 'Bug' },
    parent: { key: 'TARS-1000' },
    project: { key: 'TARS', name: 'Tars App' },
  },
};

test('normalizeJiraIssue builds a neutral intake shape from the Jira response', () => {
  const n = normalizeJiraIssue(sample);
  assert.equal(n.key, 'TARS-1271');
  assert.equal(n.summary, 'Clear button does not reset the date filter');
  assert.equal(n.issue_type, 'Bug');
  assert.equal(n.parent_key, 'TARS-1000');
  assert.equal(n.project_key, 'TARS');
  // input = summary + blank line + description (what the skill feeds the manifest)
  assert.ok(n.input.startsWith('Clear button does not reset the date filter'));
  assert.ok(n.input.includes('Expected: all filters reset.'));
});

test('normalizeJiraIssue tolerates missing optional fields (no parent, empty description)', () => {
  const n = normalizeJiraIssue({ key: 'EMS-5', fields: { summary: 'Add health endpoint', issuetype: { name: 'Story' } } });
  assert.equal(n.parent_key, null);
  assert.equal(n.project_key, 'EMS'); // derived from the key prefix when project is absent
  assert.equal(n.input, 'Add health endpoint'); // no trailing blank lines when no description
});

test('normalizeJiraIssue throws on a response with no key or summary (fail loud, do not fabricate)', () => {
  assert.throws(() => normalizeJiraIssue({ fields: { summary: 'x' } }), /key/);
  assert.throws(() => normalizeJiraIssue({ key: 'TARS-1', fields: {} }), /summary/);
});

test('changeTypeFromIssueType maps Jira issue types to conventional-commit buckets', () => {
  assert.equal(changeTypeFromIssueType('Bug'), 'fix');
  assert.equal(changeTypeFromIssueType('Story'), 'feat');
  assert.equal(changeTypeFromIssueType('Task'), 'chore');
  assert.equal(changeTypeFromIssueType('Spike'), null); // unknown → let intake classify by substance
});
