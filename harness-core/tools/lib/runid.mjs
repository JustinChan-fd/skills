// Run-id stem = telemetry filename: immutable facts only, never renamed (spec §4).
import { randomBytes } from 'node:crypto';

export const KINDS = ['intake', 'plan', 'implement', 'pipeline'];
// A source is issue-<slug>, adhoc, or file. <slug> is lowercase alphanumerics +
// hyphens: it covers a numeric GitHub issue (issue-123) AND a slugified Jira key
// (issue-tars-1271). The key must be pre-slugified (lowercase, hyphen-safe) so
// the "__" stem separator stays unambiguous — the real key rides in --issue.
const SOURCE_RE = /^(issue-[a-z0-9][a-z0-9-]*|adhoc|file)$/;
const STEM_RE = /^(\d{4}-\d{2}-\d{2}T\d{6}Z)__([a-z0-9][a-z0-9-]*)__(intake|plan|implement|pipeline)__(issue-[a-z0-9][a-z0-9-]*|adhoc|file)__([0-9a-f]{6})$/;

export function slugifyRepo(name) {
  // Collapses runs of non-alphanumerics to single "-" — slugs never contain
  // "_" at all, so "__" is a fully reserved separator (split('__') is safe).
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function makeRunId({ repo, kind, source, now = new Date(), shortid = randomBytes(3).toString('hex') }) {
  if (!KINDS.includes(kind)) throw new Error(`invalid kind: ${kind}`);
  if (!SOURCE_RE.test(source)) throw new Error(`invalid source: ${source}`);
  const iso = now.toISOString();
  const ts = `${iso.slice(0, 10)}T${iso.slice(11, 19).replace(/:/g, '')}Z`;
  return `${ts}__${slugifyRepo(repo)}__${kind}__${source}__${shortid}`;
}

export function parseRunId(stem) {
  const m = STEM_RE.exec(stem);
  if (!m) return null;
  return { ts: m[1], repo: m[2], kind: m[3], source: m[4], shortid: m[5] };
}
