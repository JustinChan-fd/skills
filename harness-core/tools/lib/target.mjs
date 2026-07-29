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

// A pasted URL names BOTH a repo and an item, so it is parsed structurally
// rather than scraped. `/issues/N` and `/pull/N` share GitHub's one numbering
// sequence; Jira's `/browse/KEY` is the canonical issue link. Anything else —
// a repo root, a release tag, an unrelated host — is deliberately NOT matched:
// a trailing number is not an issue number, and treating it as one pinned
// comment ids (`#issuecomment-3184779201`) and invented cross-project keys.
const GITHUB_ITEM_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/i;
const JIRA_BROWSE_URL = /^https?:\/\/[^/\s]+\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]|$)/i;

function looksLikeUrl(raw) {
  return /^https?:\/\//i.test(raw);
}

// A work-item hint is a Jira key, an issue number, or a URL that names one of
// those. Returns `null` for genuinely absent, `{bad}` for
// present-but-unparseable, and for a URL also the repo it named, so the caller
// can check it against the repo hint instead of silently merging the two.
//
// The caller must NOT conflate absent and unparseable. Silently dropping an item
// the user named falls through to the lowest-actionable scan and ticks a
// DIFFERENT item.
function normalizeItem(item) {
  const raw = (item ?? '').trim();
  if (!raw) return null;
  if (JIRA_KEY.test(raw)) return { key: raw.toUpperCase() };

  if (looksLikeUrl(raw)) {
    const gh = raw.match(GITHUB_ITEM_URL);
    // Strip a trailing `.git` so a clone URL and a web URL agree.
    if (gh) return { num: gh[3], urlSlug: `${gh[1]}/${gh[2].replace(/\.git$/i, '')}`, url: raw };
    const jira = raw.match(JIRA_BROWSE_URL);
    if (jira) {
      const key = jira[1].toUpperCase();
      return { key, urlPrefix: key.split('-')[0], url: raw };
    }
    // A URL we do not recognize. Refuse rather than reach for its digits: the
    // whole defect class here was "ends in a number" standing in for "is an
    // issue number".
    return { bad: raw };
  }

  const num = raw.match(/(\d+)\s*$/);
  return num ? { num: num[1] } : { bad: raw };
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
function envelope({ path, alias, projectKey, resolvedFrom, user, projects, defaultCloudId, itemSpec, fallbackKey }) {
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
  const github = resolvedAlias ? (user?.repos?.[resolvedAlias]?.github ?? null) : null;

  // The pinned item can only be finished HERE, because qualifying a bare number
  // needs the issue source and project key this function just resolved.
  let pinned = fallbackKey ?? null;
  if (itemSpec?.bad) {
    return fail('unresolvable_item',
      `"${itemSpec.bad}" is not a Jira key, an issue number, or a recognized issue URL`);
  }

  // A URL named a repo too. If it disagrees with the repo we resolved, that is a
  // contradiction the user has to settle: keeping one side and silently
  // discarding the other is how a PIZZA-9 link became TARS-9. Only checked when
  // the URL was NOT itself what resolved the target (resolvedFrom 'item_url'),
  // since there it cannot disagree with itself.
  if (resolvedFrom !== 'item_url') {
    if (itemSpec?.urlSlug && github && itemSpec.urlSlug.toLowerCase() !== github.toLowerCase()) {
      return fail('conflicting_target',
        `hint resolved to ${resolvedAlias ?? path} (${github}) but the URL names ${itemSpec.urlSlug} — re-run naming one`);
    }
    if (itemSpec?.urlSlug && !github) {
      return fail('conflicting_target',
        `the URL names github repo ${itemSpec.urlSlug} but ${resolvedAlias ?? path} has no github slug in user.json — re-run naming one`);
    }
    if (itemSpec?.urlPrefix && itemSpec.urlPrefix !== resolvedPrefix) {
      // Note the absent-prefix case is a conflict too, not a pass. If the
      // resolved repo has no prefix in projects.json, we have no evidence it is
      // the URL's project — and pinning PIZZA-9 against it would tick a key that
      // may belong to an entirely different repo.
      const known = resolvedPrefix ? `project ${resolvedPrefix}` : 'no project in projects.json';
      return fail('conflicting_target',
        `hint resolved to ${resolvedAlias ?? path} (${known}) but the URL names project ${itemSpec.urlPrefix} — re-run naming one`);
    }
  }
  if (itemSpec?.key) {
    pinned = itemSpec.key;
  } else if (itemSpec?.num) {
    if (issueSource === 'github') {
      pinned = itemSpec.num;
    } else if (resolvedPrefix) {
      // "tick webtarsthree 1272" means TARS-1272. An unqualified number cannot
      // address Jira, so qualify it rather than pinning something unfetchable.
      pinned = `${resolvedPrefix}-${itemSpec.num}`;
    } else {
      return fail('unresolvable_item',
        `issue number ${itemSpec.num} needs a Jira project key, and no projects.json prefix maps to ${path}`);
    }
  }

  return {
    ok: true,
    target: {
      alias: resolvedAlias,
      path,
      issue_source: issueSource,
      github,
      cloud_id: cloudId,
      project_key: resolvedPrefix,
      pinned_issue: pinned,
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
        itemSpec: explicitItem,
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
        itemSpec: explicitItem,
        fallbackKey: trimmedHint.toUpperCase(),
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
        itemSpec: explicitItem,
      });
    }

    // Named something we cannot resolve. This is an ERROR, never a fallback:
    // silently ticking a repo the user did not name is the worst outcome here.
    return fail('unresolvable_hint',
      `"${trimmedHint}" is not a repo alias in user.json, a Jira prefix in projects.json, or an existing path`);
  }

  // No repo hint, but a URL that carries one. A pasted link is fully qualified,
  // so it routes the whole tick — more specific than the cwd and than
  // defaultRepo, both of which are guesses about what you meant.
  if (explicitItem?.urlSlug) {
    const bySlug = Object.keys(repos).find(
      (k) => (repos[k]?.github ?? '').toLowerCase() === explicitItem.urlSlug.toLowerCase());
    if (!bySlug) {
      return fail('unresolvable_item',
        `no repo in user.json has github slug ${explicitItem.urlSlug}`);
    }
    return envelope({
      ...common,
      path: canon(repos[bySlug].path),
      alias: bySlug,
      projectKey: null,
      resolvedFrom: 'item_url',
      itemSpec: explicitItem,
    });
  }
  if (explicitItem?.urlPrefix) {
    const project = projects?.[explicitItem.urlPrefix];
    if (!project?.repoPath) {
      return fail('unresolvable_item',
        `prefix ${explicitItem.urlPrefix} from the URL is not in projects.json`);
    }
    return envelope({
      ...common,
      path: canon(project.repoPath),
      alias: null,
      projectKey: explicitItem.urlPrefix,
      resolvedFrom: 'item_url',
      itemSpec: explicitItem,
    });
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
        itemSpec: explicitItem,
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
      itemSpec: explicitItem,
    });
  }
  return fail('no_target',
    def
      ? `defaultRepo "${def}" has no entry in user.json repos`
      : 'no repo hint, no registered cwd, and no defaultRepo in user.json');
}
