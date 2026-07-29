// Config resolution: env vars → user.json → routing.json defaults (spec §2).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = new URL('../../config/', import.meta.url);

const ENV_MAP = {
  HARNESS_DEFAULT_REPO: ['defaultRepo'],
  HARNESS_TELEMETRY_REPO: ['telemetry', 'repo'],
  HARNESS_TELEMETRY_REMOTE: ['telemetry', 'remote'],
  HARNESS_TELEMETRY_DIR: ['telemetry', 'dir'],
};

export function resolveConfig({
  env = process.env,
  userFile = fileURLToPath(new URL('user.json', CONFIG_DIR)),
} = {}) {
  const routing = JSON.parse(readFileSync(fileURLToPath(new URL('routing.json', CONFIG_DIR)), 'utf8'));
  const user = existsSync(userFile) ? JSON.parse(readFileSync(userFile, 'utf8')) : {};
  for (const [envKey, pathKeys] of Object.entries(ENV_MAP)) {
    if (env[envKey]) setPath(user, pathKeys, env[envKey]);
  }
  return { routing, user };
}

export function sizeBudgets(routing, size) {
  const budgets = routing.sizes[size];
  if (!budgets) throw new Error(`unknown size: ${size}`);
  return budgets;
}

export function tierFor(routing, taskType) {
  const tier = routing.tiers[taskType];
  if (!tier) throw new Error(`unknown task type: ${taskType}`);
  return { tier, model: routing.tier_models[tier], reasoning: routing.reasoning[taskType] };
}

export function expandHome(path) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

// Jira project resolution (grafted from Desktop config.js). Maps a Jira issue
// key prefix to a repo path + cloud id so a SKILL.md wrapper can resolve the
// target repo deterministically without heuristic git-remote matching.
export function loadProjects(projectsFile = fileURLToPath(new URL('projects.json', CONFIG_DIR))) {
  const raw = JSON.parse(readFileSync(projectsFile, 'utf8'));
  return { projects: raw.projects ?? {}, defaultCloudId: raw.defaultCloudId ?? null };
}

// Resolve { repoPath, cloudId } from a Jira issue key (e.g. "TARS-1271").
// Returns null when the key is empty or its prefix is not in projects.json.
export function resolveProject(issueKey, projectsFile = undefined) {
  if (!issueKey) return null;
  const { projects } = loadProjects(...(projectsFile ? [projectsFile] : []));
  const prefix = issueKey.split('-')[0].toUpperCase();
  return projects[prefix] ?? null;
}

// Resolve a repo's issue tracker ('jira' | 'github') from user.json. Every repo
// is meant to stamp issue_source explicitly, but an unset (or unknown) repo
// defaults to 'jira' for back-compat with the original Jira-only harness. This
// is the single branch point the SKILL.md files read to route pick-work-item,
// fetch/normalize, and the status-comment sink.
export function issueSourceFor(user, alias) {
  return user?.repos?.[alias]?.issue_source ?? 'jira';
}

// Resolve whatever a caller called the repo to its CANONICAL identity: the key
// in user.json's `repos`. Callers were passing the github slug
// ("JustinChan-fd/jarvis") because `--repo <slug>` reads identically on
// `init-run` and on `gh issue view --repo <owner/repo>` — and that string then
// became the run-id stem and the telemetry directory name, splitting one repo
// across two identities in the sink. The local registry key is the identity;
// the github slug is one of its attributes.
//
// An unregistered repo passes through untouched: adhoc targets legitimately
// have no entry, and rewriting or rejecting them would be worse than accepting
// the caller's own name (the run-id slugifier still makes it path-safe).
export function canonicalRepo(user, repo) {
  const repos = user?.repos;
  if (!repos || !repo) return repo;
  const wanted = repo.toLowerCase();
  return (
    Object.keys(repos).find((key) => key.toLowerCase() === wanted) ??
    Object.keys(repos).find((key) => (repos[key]?.github ?? '').toLowerCase() === wanted) ??
    repo
  );
}

function setPath(obj, keys, value) {
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
  cur[keys.at(-1)] = value;
}
