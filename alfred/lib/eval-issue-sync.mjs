// eval-issue-sync — the executable half: find the eval issue, apply the plan,
// record the number back into the manifest.
//
// `gh` is injected (default: the real binary) so the whole sync is testable
// offline. This runs as a prerequisite of every eval, so it has to be trustworthy
// without a live issue to poke at.
//
// Usage: node lib/eval-issue-sync.mjs <slug> [--dry-run]

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { issueBody, issueTitle, planSync } from './eval-issue.mjs';

const execFileAsync = promisify(execFile);
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

const VIEW_FIELDS = 'number,title,body,state,labels';

// The real `gh`. Takes an argv array — never a shell string, so a ticket body
// containing backticks or quotes cannot be reinterpreted by a shell.
export async function realGh(args) {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export async function findEvalIssue({ manifest, gh = realGh }) {
  const { repo, number, title } = manifest.eval_issue;

  // A recorded number is the precise route, but the issue can be deleted out
  // from under the manifest. Re-creating is correct there; crashing an
  // unattended eval on a stale number is not.
  if (number != null) {
    try {
      return JSON.parse(
        await gh(['issue', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS]),
      );
    } catch {
      // fall through to search
    }
  }

  const wanted = title ?? issueTitle(manifest);
  const listed = JSON.parse(
    await gh([
      'issue', 'list', '--repo', repo,
      '--label', manifest.eval_issue.labels[0],
      '--state', 'all', '--limit', '100',
      '--json', VIEW_FIELDS,
    ]),
  );
  // Match on the exact title. The `eval` label is shared by every fixture's
  // issue, so label alone would pick up sandbox-b's ticket.
  return listed.find((issue) => issue.title === wanted) ?? null;
}

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (cause) {
    throw new Error(`cannot read fixture manifest at ${manifestPath}`, { cause });
  }
}

// Rewrites only eval_issue.number, preserving everything else byte-for-byte
// apart from the reserialization. The ticket text is the source of truth for the
// whole experiment; this must not disturb it.
async function recordNumber(manifestPath, manifest, number) {
  const updated = { ...manifest, eval_issue: { ...manifest.eval_issue, number } };
  await writeFile(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

function numberFromUrl(stdout) {
  const match = /\/issues\/(\d+)\s*$/.exec(String(stdout).trim());
  if (!match) throw new Error(`could not parse an issue number from gh output: ${stdout}`);
  return Number(match[1]);
}

export async function syncEvalIssue({ manifestPath, slug, gh = realGh, dryRun = false }) {
  const path = manifestPath ?? join(FIXTURES, slug, 'manifest.json');
  const manifest = await readManifest(path);
  const { repo } = manifest.eval_issue;

  const existing = await findEvalIssue({ manifest, gh });
  const plan = planSync({ manifest, existing });

  if (dryRun) return { ...plan, dryRun: true, repo };

  switch (plan.action) {
    case 'noop':
      return { ...plan, repo };

    case 'create': {
      const stdout = await gh([
        'issue', 'create', '--repo', repo,
        '--title', plan.title,
        '--body', plan.body,
        '--label', manifest.eval_issue.labels[0],
      ]);
      const number = numberFromUrl(stdout);
      await recordNumber(path, manifest, number);
      return { ...plan, number, repo };
    }

    case 'reopen': {
      await gh(['issue', 'reopen', String(plan.number), '--repo', repo]);
      // The body may also have drifted while it was closed.
      const reopened = await findEvalIssue({ manifest, gh });
      const after = planSync({ manifest, existing: { ...reopened, state: 'OPEN' } });
      if (after.action === 'edit') await applyEdit({ gh, repo, plan: after });
      if (manifest.eval_issue.number !== plan.number) {
        await recordNumber(path, manifest, plan.number);
      }
      return { ...plan, repo };
    }

    case 'edit': {
      await applyEdit({ gh, repo, plan });
      if (manifest.eval_issue.number !== plan.number) {
        await recordNumber(path, manifest, plan.number);
      }
      return { ...plan, repo };
    }

    default:
      throw new Error(`unknown sync action: ${plan.action}`);
  }
}

async function applyEdit({ gh, repo, plan }) {
  const args = ['issue', 'edit', String(plan.number), '--repo', repo];
  if (plan.fields.includes('title')) args.push('--title', plan.title);
  if (plan.fields.includes('body')) args.push('--body', plan.body);
  await gh(args);
}

// --- CLI ---

const USAGE = 'usage: eval-issue-sync.mjs <slug> [--dry-run]';

export async function main(argv) {
  const slug = argv.find((arg) => !arg.startsWith('--'));
  if (!slug) throw new Error(`missing fixture slug. ${USAGE}`);
  const result = await syncEvalIssue({ slug, dryRun: argv.includes('--dry-run') });
  // The body is large and is already the manifest's content — print the decision,
  // not the projection.
  const { body: _body, title: _title, ...summary } = result;
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
