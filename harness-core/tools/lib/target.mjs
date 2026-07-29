// Deterministic target + work-item resolution.
//
// The invoking skill's only interpretive job is to pull two loose strings out of
// free-form text (a repo hint, a work-item hint). Every DECISION — alias
// lookup, default fallback, Jira-vs-GitHub, cloud id — lives here, composed
// from user.json's `repos`/`defaultRepo` and projects.json's `projects`. This
// module encodes no repo knowledge of its own: adding a repo means editing
// those files, never this code.
//
// The two config files are NOT in 1:1 correspondence and do not agree on path
// format. projects.json carries Jira prefixes with no matching user.json alias
// (ARTI, PIZZA, RT, RTFE today), and writes absolute paths where user.json
// writes `~/`. Reconciling both is the reason this is code and not prose.
import { existsSync, realpathSync } from 'node:fs';
import { expandHome, issueSourceFor } from './config.mjs';

const JIRA_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

// A work-item hint is either a Jira key (kept whole, uppercased) or an issue
// number (reduced to the bare digits, so `4`, `#4`, and `issue 4` agree).
function normalizeItem(item) {
  const raw = (item ?? '').trim();
  if (!raw) return null;
  if (JIRA_KEY.test(raw)) return raw.toUpperCase();
  const num = raw.match(/(\d+)\s*$/);
  return num ? num[1] : null;
}

// Compare two paths that may differ in home-expansion, trailing slash, or
// symlink resolution (macOS /tmp -> /private/tmp bites the cwd path).
function canon(path) {
  if (!path) return null;
  const expanded = expandHome(String(path)).replace(/\/+$/, '');
  try {
    return existsSync(expanded) ? realpathSync(expanded) : expanded;
  } catch {
    return expanded;
  }
}

function pathsMatch(a, b) {
  const ca = canon(a);
  const cb = canon(b);
  return ca !== null && cb !== null && ca === cb;
}

function findAliasByPath(user, path) {
  for (const [alias, cfg] of Object.entries(user?.repos ?? {})) {
    if (pathsMatch(cfg?.path, path)) return alias;
  }
  return null;
}

function findPrefixByPath(projects, path) {
  for (const [prefix, cfg] of Object.entries(projects ?? {})) {
    if (pathsMatch(cfg?.repoPath, path)) return prefix;
  }
  return null;
}

// Build the envelope from a resolved path. `alias` and `projectKey` are looked
// up in whichever config the path did NOT come from, so a target reached by
// either route carries the other route's metadata when one exists.
function envelope({ path, alias, projectKey, resolvedFrom, user, projects, defaultCloudId, pinnedIssue }) {
  const resolvedAlias = alias ?? findAliasByPath(user, path);
  const resolvedPrefix = projectKey ?? findPrefixByPath(projects, path);
  // A repo with no registry entry cannot have an issue_source declared. When we
  // arrived via a projects.json Jira prefix, that arrival IS the evidence the
  // repo is Jira-tracked; issueSourceFor's own default agrees, but say so
  // explicitly rather than leaning on a fallback that means something else.
  const issueSource = resolvedAlias ? issueSourceFor(user, resolvedAlias) : 'jira';
  const cloudId = resolvedPrefix
    ? (projects?.[resolvedPrefix]?.cloudId ?? defaultCloudId ?? null)
    : null;
  return {
    ok: true,
    target: {
      alias: resolvedAlias,
      path,
      issue_source: issueSource,
      github: resolvedAlias ? (user?.repos?.[resolvedAlias]?.github ?? null) : null,
      cloud_id: cloudId,
      project_key: resolvedPrefix,
      pinned_issue: pinnedIssue ?? null,
      resolved_from: resolvedFrom,
    },
  };
}

function fail(code, detail) {
  return { ok: false, error: { code, detail } };
}

export function resolveTarget({ hint, item, cwd, user, projects, defaultCloudId = null } = {}) {
  const repos = user?.repos ?? {};
  const explicitItem = normalizeItem(item);
  const common = { user, projects, defaultCloudId };
  const trimmedHint = (hint ?? '').trim();

  if (trimmedHint) {
    // 1. An alias, case-insensitively.
    const aliasKey = Object.keys(repos).find((k) => k.toLowerCase() === trimmedHint.toLowerCase());
    if (aliasKey) {
      return envelope({
        ...common,
        path: canon(repos[aliasKey].path),
        alias: aliasKey,
        projectKey: null,
        resolvedFrom: 'hint_alias',
        pinnedIssue: explicitItem,
      });
    }

    // 2. A Jira key: its prefix names the repo AND the key pins the work item.
    if (JIRA_KEY.test(trimmedHint)) {
      const prefix = trimmedHint.split('-')[0].toUpperCase();
      const project = projects?.[prefix];
      if (!project?.repoPath) {
        return fail('unresolvable_hint',
          `"${trimmedHint}" looks like a Jira key but prefix ${prefix} is not in projects.json`);
      }
      return envelope({
        ...common,
        path: canon(project.repoPath),
        alias: null,
        projectKey: prefix,
        resolvedFrom: 'hint_jira_key',
        pinnedIssue: explicitItem ?? trimmedHint.toUpperCase(),
      });
    }

    // 3. A literal path, but only one that exists.
    if (trimmedHint.startsWith('/') || trimmedHint.startsWith('~/')) {
      const path = canon(trimmedHint);
      if (!existsSync(path)) {
        return fail('unresolvable_hint', `path does not exist: ${path}`);
      }
      return envelope({
        ...common,
        path,
        alias: null,
        projectKey: null,
        resolvedFrom: 'hint_path',
        pinnedIssue: explicitItem,
      });
    }

    // Named something we cannot resolve. This is an ERROR, never a fallback:
    // silently ticking a repo the user did not name is the worst outcome here.
    return fail('unresolvable_hint',
      `"${trimmedHint}" is not a repo alias in user.json, a Jira prefix in projects.json, or an existing path`);
  }

  // No hint: the cwd, if it IS a registered repo (you are running from inside
  // the repo you mean).
  if (cwd) {
    const cwdAlias = findAliasByPath(user, cwd);
    if (cwdAlias) {
      return envelope({
        ...common,
        path: canon(repos[cwdAlias].path),
        alias: cwdAlias,
        projectKey: null,
        resolvedFrom: 'cwd',
        pinnedIssue: explicitItem,
      });
    }
  }

  // Last resort: the declared default. A default that names an unregistered
  // repo is no target at all, not a path guess.
  const def = user?.defaultRepo;
  if (def && repos[def]?.path) {
    return envelope({
      ...common,
      path: canon(repos[def].path),
      alias: def,
      projectKey: null,
      resolvedFrom: 'default',
      pinnedIssue: explicitItem,
    });
  }
  return fail('no_target',
    def
      ? `defaultRepo "${def}" has no entry in user.json repos`
      : 'no repo hint, no registered cwd, and no defaultRepo in user.json');
}
