// GitHub issue normalization: turn the `gh issue view --json
// number,title,body,labels` response into the SAME neutral intake shape
// jira.mjs produces, so the SKILL.md never hand-parses GitHub JSON and the
// downstream phases (plan, implement) read the manifest instead of re-hitting
// the tracker. Intake fetches ONCE and normalizes to disk immediately — a fetch
// failure then fails only intake, cleanly (mirrors the Jira-in-a-loop risk).
// SOURCE: field set carried over from the legacy harness-intake skill's
// gh-issue-view call (fields: number, title, body, labels). That skill is
// deleted — this is the only home for the field set now.

// GitHub label → conventional-commit bucket. Unknown/absent labels return null
// so intake classifies by substance (same contract as unknown Jira issue types).
const CHANGE_TYPE_BY_LABEL = {
  bug: 'fix',
  defect: 'fix',
  enhancement: 'feat',
  feature: 'feat',
  documentation: 'docs',
  docs: 'docs',
  chore: 'chore',
};

export function changeTypeFromLabels(labels) {
  if (!Array.isArray(labels)) return null;
  for (const label of labels) {
    const name = typeof label?.name === 'string' ? label.name.toLowerCase() : null;
    if (name && CHANGE_TYPE_BY_LABEL[name]) return CHANGE_TYPE_BY_LABEL[name];
  }
  return null;
}

/**
 * Normalize a `gh issue view --json number,title,body,labels` response into the
 * neutral intake shape (identical to normalizeJiraIssue's output).
 * Throws (fail loud, never fabricate) when the response lacks a number or title.
 * @param {{number?:number, title?:string, body?:string, labels?:Array<{name:string}>}} issue
 * @param {{repoSlug?:string}} opts — repoSlug becomes project_key.
 * @returns {{key,summary,description,issue_type,change_type,parent_key,project_key,input}}
 */
export function normalizeGithubIssue(issue, { repoSlug = null } = {}) {
  const number = issue?.number;
  if (number === undefined || number === null || Number.isNaN(Number(number))) {
    throw new Error('normalizeGithubIssue: response has no issue number');
  }
  const summary = issue.title;
  if (!summary || typeof summary !== 'string') {
    throw new Error(`normalizeGithubIssue: #${number} has no title`);
  }
  const description = typeof issue.body === 'string' ? issue.body : '';

  // input is what intake feeds the manifest: summary, then the description
  // after a blank line. No trailing blank lines when there's no description.
  const input = description.trim() ? `${summary}\n\n${description}` : summary;

  return {
    key: String(number),
    summary,
    description,
    issue_type: null, // GitHub has no issue-type concept
    change_type: changeTypeFromLabels(issue.labels),
    parent_key: null, // GitHub issues have no parent link
    project_key: repoSlug,
    input,
  };
}
