// sandbox-alias — register the provisioned sandbox as a repo alias in
// harness-core's `config/user.json`, so arm B can resolve the eval issue through
// the real intake path.
//
// THIS FILE LIVES IN `eval/`, NOT `lib/`, AND THAT IS THE POINT.
//
// `lib/` is Alfred's runtime and imports nothing outside `alfred/` — enforced by
// test/isolation.test.mjs, not merely documented. `eval/` is experiment scaffolding,
// and it is the one place allowed to reach harness-core, because Experiment 2's arm B
// *is* the four-phase pipeline: the control group Alfred's design bet is measured
// against. Measuring the thing you are replacing requires reaching it.
//
// Nothing an Alfred run does touches this file. When Experiment 2 is scored, arm B has
// served its purpose and this can be deleted outright.
//
// SANDBOX.md §6 resolved the open risk here: the four-phase drivers can run
// against a LOCAL repo path while sourcing a GitHub issue from a DIFFERENT repo,
// because `resolveTarget` treats `path` and `github` as independent fields. This
// module is what supplies that pair. It writes configuration only — no
// harness-core source is edited, which is the line that keeps the comparison
// valid.
//
// Two reasons this is a tested helper rather than a documented hand-edit:
//
//   1. `path` cannot be a static config value. Each arm provisions a fresh
//      start state (that is how the 1339 contamination bug is designed out), so
//      the alias has to be re-pointed per run. A stale path would silently run
//      an arm against the previous arm's repo.
//   2. `config/user.json` is gitignored — machine-local, hand-edited, and it
//      holds the live pointers to three real repos plus the telemetry sink. An
//      unattended eval writing to that file needs to be provably narrow.
//
// Usage: node lib/sandbox-alias.mjs <provision-json-file|-> [--user <path>]

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// One alias for every fixture. The fixtures share a repo shape and only one arm
// runs at a time, so a per-slug alias would just accumulate stale entries in a
// file the user reads by hand.
export const SANDBOX_ALIAS = 'alfred-sandbox';

const DEFAULT_USER_FILE = fileURLToPath(
  new URL('../../harness-core/config/user.json', import.meta.url),
);

// Returns a new user config with the sandbox alias pointing at `provisioned`.
// Pure: the caller decides whether to write it.
export function withAlias(user, provisioned) {
  const { slug, repo, github } = provisioned;
  if (!repo) throw new Error('provisioned.repo is required — the alias needs a code path');
  if (!github) {
    throw new Error(
      'a github slug is required: issue_source is "github", so without it harness-core ' +
        'would resolve a tracker it has no repo to query. Pass { github } or set ' +
        "the fixture manifest's eval_issue.repo.",
    );
  }

  const repos = user?.repos ?? {};

  // A slug that collides with a registered repo would redirect real work at a
  // throwaway temp clone. Only the reserved alias may be written.
  for (const key of Object.keys(repos)) {
    if (key !== SANDBOX_ALIAS && (key === slug || key.toLowerCase() === String(slug).toLowerCase())) {
      throw new Error(
        `refusing to write an alias for '${slug}': user.json already registers a repo ` +
          `by that name. The sandbox alias is always '${SANDBOX_ALIAS}'.`,
      );
    }
  }

  return {
    ...user,
    repos: {
      ...repos,
      // Field order matches the existing entries so the diff stays readable.
      [SANDBOX_ALIAS]: { path: repo, issue_source: 'github', github },
    },
  };
}

// Rewrites user.json with the alias applied. Reports whether anything changed so
// a run script can log it — and so a repeated call is visibly a noop rather than
// an invisible rewrite of a file the user also edits by hand.
export async function writeAlias({ userFile = DEFAULT_USER_FILE, provisioned, github } = {}) {
  let raw;
  try {
    raw = await readFile(userFile, 'utf8');
  } catch (cause) {
    // Creating one would yield a file with a sandbox alias and no real repos,
    // which reads as a working config and is not one.
    throw new Error(
      `no user.json at ${userFile}. The sandbox alias edits an existing harness-core ` +
        'config; it does not create one.',
      { cause },
    );
  }

  // Parsed before anything is written, so a malformed file is never clobbered.
  const user = JSON.parse(raw);
  const next = withAlias(user, { ...provisioned, github: provisioned?.github ?? github });

  // Two-space indent and a trailing newline: the file is hand-edited, and
  // reformatting it would surface every eval run as a spurious diff.
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (serialized === raw) return { changed: false, alias: SANDBOX_ALIAS, userFile };

  await writeFile(userFile, serialized);
  return { changed: true, alias: SANDBOX_ALIAS, userFile, path: next.repos[SANDBOX_ALIAS].path };
}

// --- CLI ---
//
// Takes the JSON that `fixture.mjs provision` printed, so the two compose:
//   node lib/fixture.mjs provision sandbox-a --into "$DIR" --replace > p.json
//   node lib/sandbox-alias.mjs p.json

const USAGE = 'usage: sandbox-alias.mjs <provision-json-file|-> [--user <path>] [--github <slug>]';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv) {
  const source = argv.find((arg) => !arg.startsWith('--'));
  if (!source) throw new Error(`missing provision JSON. ${USAGE}`);

  const flagValue = (name) => {
    const at = argv.indexOf(name);
    if (at === -1) return undefined;
    const value = argv[at + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value. ${USAGE}`);
    return value;
  };

  const raw = source === '-' ? await readStdin() : await readFile(source, 'utf8');
  return writeAlias({
    userFile: flagValue('--user'),
    provisioned: JSON.parse(raw),
    github: flagValue('--github'),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
