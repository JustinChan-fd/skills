// github.mjs: normalize the `gh issue view --json number,title,body,labels`
// response shape into the SAME neutral intake shape jira.mjs produces — so the
// SKILL.md never hand-parses GitHub JSON, plan/implement read the manifest (not
// the tracker), and every downstream phase is source-agnostic.
// SOURCE: field set from the legacy harness-intake skill's gh-issue-view call
// (fields: number, title, body, labels).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGithubIssue, changeTypeFromLabels } from '../tools/lib/github.mjs';
import { normalizeJiraIssue } from '../tools/lib/jira.mjs';

const sample = {
  number: 2,
  title: 'Clear button does not reset the date filter',
  body: 'When a user clicks Clear, the date range stays selected.\n\nExpected: all filters reset.',
  labels: [{ name: 'bug' }, { name: 'ui' }],
};

test('normalizeGithubIssue builds a neutral intake shape from the gh response', () => {
  const n = normalizeGithubIssue(sample, { repoSlug: 'jarvis' });
  assert.equal(n.key, '2'); // issue number as a string — rides in --issue, slugs to issue-2
  assert.equal(n.summary, 'Clear button does not reset the date filter');
  assert.equal(n.issue_type, null); // GitHub has no issue-type concept
  assert.equal(n.parent_key, null); // GitHub issues have no parent
  assert.equal(n.project_key, 'jarvis'); // the repo slug
  assert.equal(n.change_type, 'fix'); // from the "bug" label
  // input = title + blank line + body (what the skill feeds the manifest)
  assert.ok(n.input.startsWith('Clear button does not reset the date filter'));
  assert.ok(n.input.includes('Expected: all filters reset.'));
});

test('normalizeGithubIssue tolerates missing optional fields (no labels, empty body)', () => {
  const n = normalizeGithubIssue({ number: 5, title: 'Add health endpoint' }, { repoSlug: 'jarvis' });
  assert.equal(n.key, '5');
  assert.equal(n.change_type, null); // no labels → let intake classify by substance
  assert.equal(n.parent_key, null);
  assert.equal(n.input, 'Add health endpoint'); // no trailing blank lines when no body
});

test('normalizeGithubIssue throws on a response with no number or title (fail loud, do not fabricate)', () => {
  assert.throws(() => normalizeGithubIssue({ title: 'x' }, { repoSlug: 'jarvis' }), /number/);
  assert.throws(() => normalizeGithubIssue({ number: 2 }, { repoSlug: 'jarvis' }), /title/);
});

test('changeTypeFromLabels maps GitHub labels to conventional-commit buckets', () => {
  assert.equal(changeTypeFromLabels([{ name: 'bug' }]), 'fix');
  assert.equal(changeTypeFromLabels([{ name: 'enhancement' }]), 'feat');
  assert.equal(changeTypeFromLabels([{ name: 'feature' }]), 'feat');
  assert.equal(changeTypeFromLabels([{ name: 'documentation' }]), 'docs');
  assert.equal(changeTypeFromLabels([{ name: 'wontfix' }]), null); // unknown → let intake classify
  assert.equal(changeTypeFromLabels([]), null);
  assert.equal(changeTypeFromLabels(undefined), null);
  // a bug label wins over an unrelated one regardless of order
  assert.equal(changeTypeFromLabels([{ name: 'ui' }, { name: 'bug' }]), 'fix');
});

// The parity test — THIS is the contract that keeps downstream phases
// source-agnostic. An equivalent Jira and GitHub issue must produce the same
// neutral shape for every field EXCEPT the documented source-specific ones
// (key, issue_type, parent_key, project_key).
test('github and jira normalizers agree on the source-neutral fields (parity)', () => {
  const jira = normalizeJiraIssue({
    key: 'TARS-1271',
    fields: {
      summary: 'Clear button does not reset the date filter',
      description: 'When a user clicks Clear, the date range stays selected.\n\nExpected: all filters reset.',
      issuetype: { name: 'Bug' },
    },
  });
  const gh = normalizeGithubIssue(sample, { repoSlug: 'jarvis' });
  // Same shared keys.
  assert.deepEqual(Object.keys(gh).sort(), Object.keys(jira).sort());
  // Identical on the fields every downstream phase actually consumes.
  assert.equal(gh.summary, jira.summary);
  assert.equal(gh.description, jira.description);
  assert.equal(gh.input, jira.input);
  assert.equal(gh.change_type, jira.change_type); // both 'fix' (bug label / Bug type)
});
