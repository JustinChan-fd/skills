// Jira issue normalization: turn the mcp__atlassian__getJiraIssue response into
// a neutral intake shape, so the SKILL.md never hand-parses Jira JSON and the
// downstream phases (plan, implement) read the manifest instead of re-hitting
// Jira. Intake fetches ONCE and normalizes to disk immediately — a fetch
// failure then fails only intake, cleanly (see plan §F risk: Jira MCP in a loop).
// SOURCE: field set from harness-intake/SKILL.md getJiraIssue call
// (fields: summary, description, issuetype, parent, project; markdown format).

// Jira issue type → conventional-commit bucket. Unknown types return null so
// intake classifies by substance (a request worded as a feature can be a fix).
const CHANGE_TYPE_BY_ISSUE_TYPE = {
  Bug: 'fix',
  Defect: 'fix',
  Story: 'feat',
  'New Feature': 'feat',
  Improvement: 'feat',
  Task: 'chore',
  'Sub-task': 'chore',
  Subtask: 'chore',
  Chore: 'chore',
};

export function changeTypeFromIssueType(name) {
  if (!name) return null;
  return CHANGE_TYPE_BY_ISSUE_TYPE[name] ?? null;
}

// Derive the project key from an issue key prefix (TARS-1271 → TARS) as a
// fallback when the response omits the project object.
function projectKeyFromIssueKey(key) {
  return typeof key === 'string' && key.includes('-') ? key.split('-')[0].toUpperCase() : null;
}

/**
 * Normalize a getJiraIssue response into the neutral intake shape.
 * Throws (fail loud, never fabricate) when the response lacks a key or summary.
 * @param {{key?:string, fields?:object}} issue
 * @returns {{key,summary,description,issue_type,change_type,parent_key,project_key,input}}
 */
export function normalizeJiraIssue(issue) {
  const key = issue?.key;
  if (!key || typeof key !== 'string') {
    throw new Error('normalizeJiraIssue: response has no issue key');
  }
  const f = issue.fields ?? {};
  const summary = f.summary;
  if (!summary || typeof summary !== 'string') {
    throw new Error(`normalizeJiraIssue: ${key} has no summary`);
  }
  const description = typeof f.description === 'string' ? f.description : '';
  const issueType = f.issuetype?.name ?? null;
  const parentKey = f.parent?.key ?? null;
  const projectKey = f.project?.key ?? projectKeyFromIssueKey(key);

  // input is what intake feeds the manifest: summary, then the description
  // after a blank line. No trailing blank lines when there's no description.
  const input = description.trim() ? `${summary}\n\n${description}` : summary;

  return {
    key,
    summary,
    description,
    issue_type: issueType,
    change_type: changeTypeFromIssueType(issueType),
    parent_key: parentKey,
    project_key: projectKey,
    input,
  };
}
