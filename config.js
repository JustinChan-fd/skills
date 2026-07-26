// harness skills — workspace config
// Maps Jira project keys to repo paths and Jira cloud IDs.
// Used by SKILL.md wrappers to resolve repoPath deterministically without heuristic git-remote matching.
//
// How to add a project:
//   1. Add an entry to PROJECTS keyed by the Jira project key prefix (e.g. "TARS").
//   2. Set repoPath to the absolute path of the local checkout.
//   3. Set cloudId to the Jira site hostname (e.g. "fandango.atlassian.net").
//
// Multiple project keys can map to the same repo (e.g. TARS and RTFE both live in webtarsthree).

export const JIRA_DEFAULT_CLOUD_ID = 'fandango.atlassian.net'

export const PROJECTS = {
  // ── webtarsthree ────────────────────────────────────────────────────────────
  TARS: {
    repoPath: '/Users/206618626@bwt3.com/Desktop/Repos/webtarsthree',
    cloudId:  'fandango.atlassian.net',
  },
  RTFE: {
    repoPath: '/Users/206618626@bwt3.com/Desktop/Repos/webtarsthree',
    cloudId:  'fandango.atlassian.net',
  },

  // ── tars-ems ─────────────────────────────────────────────────────────────────
  EMS: {
    repoPath: '/Users/206618626@bwt3.com/Desktop/Repos/tars-ems',
    cloudId:  'fandango.atlassian.net',
  },

  // ── other repos ──────────────────────────────────────────────────────────────
  ARTI: {
    repoPath: '/Users/206618626@bwt3.com/Desktop/Repos/arti',
    cloudId:  'fandango.atlassian.net',
  },
  PIZZA: {
    repoPath: '/Users/206618626@bwt3.com/Desktop/Repos/pizza-pie',
    cloudId:  'fandango.atlassian.net',
  },
  RT: {
    repoPath: '/Users/206618626@bwt3.com/Desktop/Repos/rt-editorial-v4',
    cloudId:  'fandango.atlassian.net',
  },
}

// Resolve repoPath + cloudId from a Jira issue key (e.g. "TARS-1271").
// Returns null if the project prefix is not in the map.
export function resolveProject(issueKey) {
  if (!issueKey) return null
  const prefix = issueKey.split('-')[0].toUpperCase()
  return PROJECTS[prefix] ?? null
}
