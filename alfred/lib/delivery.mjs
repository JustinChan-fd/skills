// delivery — a graded run onto a branch, and (on a pass) onto a remote and into a draft PR.
//
// THE ONLY MODULE IN ALFRED THAT WRITES SOMEWHERE THE OPERATOR DOES NOT CONTROL. Everything else
// reads a ticket, spawns a worker, grades a tree, and writes files under a run dir. This pushes
// commits to a remote and opens a pull request, so the failure modes are not "a wrong number in a
// record" — they are "someone else's repository now has a branch on it". Everything below is
// shaped by that asymmetry, and where a choice was available it went to the side that does less.
//
// COMMIT ALWAYS, PUSH ONLY ON PASS. These are separate decisions and separating them is the point.
//
//   A commit is LOCAL and RECOVERABLE. It is also the only durable record of what a worker
//   actually did: the run dir holds the log and the record, but the DIFF exists solely in the
//   working tree, and the next run's `treeIsDirty` check refuses to spawn against it. So a failed
//   run that is not committed is a run whose evidence gets wiped by the next tick. Committing a
//   failed run costs a branch nobody merges; not committing it costs the only copy of the work.
//
//   A push is REMOTE and it is what other people see. It is gated on the verdict, because a branch
//   on a shared remote is a claim that something is ready to look at.
//
// NEVER MERGE, CHECKED HERE AND NOT ONLY AT CONFIG LOAD. `config.mjs`'s `validateSemantics`
// already refuses a config whose `delivery.never_merge` is not exactly `true`. That check is real
// and it is not sufficient: it runs once, against the file, and every caller after it holds a
// plain object that anything in the process could have edited — including a future Alfred that
// merges a `--flag` into the loaded config. `router.mjs` makes the same argument for the opus
// refusal and resolves it the same way: the module that would perform the escalation refuses it at
// the point of use, so the guarantee does not depend on who called it or what happened in between.
//
// A DRAFT, ALWAYS. `--draft` is not a config key and deliberately cannot be turned off from a
// repo file. A ready-for-review PR asks a human to spend attention on the assumption that a
// machine thought it was done, and the whole premise of the gate is that a machine's opinion of
// its own work is the thing under test.
//
// THIS MODULE RETURNS ITS RESULT; IT DOES NOT ANNOUNCE IT. `lib/cli.mjs`'s `reportDelivery` is what
// tells the operator, and that pairing is worth naming here because its absence shipped: delivery was
// wired end to end, a real push landed, `gh pr create --draft` really ran, and the tick's output said
// only `gate: PASS`. An operator had no way to learn from their own terminal that a branch had been
// published on their behalf. A returned value nobody prints is the same defect as a computed value
// nobody stores (#63/#69/#72/#73) — so anything added to this return shape needs a line up there too.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveBase } from './config.mjs';

const execFileAsync = promisify(execFile);

// The branch name. `alfred/` prefixed so an operator scanning `git branch -a` can tell in one look
// which branches a machine made, and the run id appended because two runs on one ticket are a real
// case — a first attempt that failed the gate and a second that passed. Without the run id the
// second would either collide or silently reset the first, losing exactly the comparison that
// makes a re-run worth doing.
export function branchNameFor({ itemId, runId } = {}) {
  const slug = (s) =>
    String(s ?? '')
      .trim()
      .toLowerCase()
      // DOTS ARE DROPPED, NOT KEPT. `git check-ref-format` REJECTS a ref containing `..`, so a
      // ticket ref with two dots anywhere in it would fail at `git switch -c` — not here, where it
      // would be obvious, but three steps later after the worker has already run. Allowing `.` and
      // then stripping `..` afterwards is the same fix with a hole in it: `...` collapses to `.`
      // on one pass and `a..b..c` needs two. Nothing in a ticket id needs a dot to stay distinct.
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');

  const item = slug(itemId);
  const run = slug(runId);
  if (!item) throw new Error('no itemId: refusing to name a branch after nothing');
  // ITEM FIRST, and truncated so the RUN ID SURVIVES. `67e97d1` fixed this exact defect in the run
  // directory name: a long ref truncated away the ticket and two runs shared a directory. Same
  // hazard, opposite field — here it is the run id that disambiguates, so the item is what gets cut.
  return run ? `alfred/${item.slice(0, 60)}-${run}` : `alfred/${item.slice(0, 60)}`;
}

// git, with the repo pinned and output captured. Non-zero THROWS here, unlike `gate.mjs`'s runner
// where a non-zero exit is the measurement. A `git commit` that fails has not committed, and
// continuing to `push` would push the previous state under a message describing this run.
async function git(cwd, ...args) {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return `${stdout ?? ''}${stderr ?? ''}`.trim();
}

// `gh`, injectable. Production passes nothing and gets the real binary; a test passes a recorder.
// Injected at the FETCH boundary rather than by handing this module a pre-built PR object, for the
// reason `item.mjs`'s tests give: a stub of the result asserts against a shape this module composes
// and would keep passing after that shape changed.
async function defaultGh(args, { cwd } = {}) {
  const { stdout, stderr } = await execFileAsync('gh', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return `${stdout ?? ''}${stderr ?? ''}`.trim();
}

// THE PR BODY. States what was graded and by what, and says outright that a machine wrote it.
//
// THE VERDICT GOES IN EVEN WHEN IT IS A PASS-WITH-CAVEATS, and the findings are listed rather than
// summarized to a count. A reviewer's first question is "what does the harness itself think is
// wrong with this", and a number does not answer it. `unverified` is listed separately because it
// is the honest channel — §5 rule 2: it does not fail the run, and it is precisely what a human
// needs to look at.
export function prBody({ item, gate, runId, recordPath, preflight } = {}) {
  const lines = [
    `Alfred ran on \`${item?.id ?? 'unknown'}\`${item?.url ? ` (${item.url})` : ''}.`,
    '',
    // ONE LINE, NOT WRAPPED. A first draft wrapped this at 100 columns and a test asserting the
    // phrase "never merges" failed on the newline between the two words — GitHub reflows the
    // paragraph anyway, so the wrap bought nothing and broke the assertion.
    '**This is a draft opened by a machine, and it has not been merged by one.** The harness never merges its own pull requests. Read the diff before anything else here.',
    '',
    `Verdict: **${gate?.pass ? 'PASS' : 'FAIL'}** — ${gate?.findings?.length ?? 0} finding(s).`,
    '',
  ];

  const findings = gate?.findings ?? [];
  if (findings.length > 0) {
    lines.push("What the gate found (its own objections to this diff, not a reviewer's):", '');
    // EVIDENCE IS NOT REPRODUCED HERE. It is bounded in `gate.mjs` for the record, and a PR body is
    // a second publication surface with a different audience; the rule and the detail say what
    // happened, and the record holds the output.
    for (const f of findings) lines.push(`- \`${f.rule}\`: ${f.detail}`);
    lines.push('');
  }

  const unverified = gate?.unverified ?? [];
  if (unverified.length > 0) {
    lines.push(
      'Not verifiable by the harness — these need a human, and they did NOT fail the run:',
      '',
      ...unverified.map((u) => `- ${typeof u === 'string' ? u : `${u.id ?? '?'}: ${u.reason ?? 'no reason given'}`}`),
      '',
    );
  }

  if (preflight?.refused) {
    lines.push(
      `The preflight REFUSED this run (\`${preflight.reason}\`): ${preflight.detail ?? 'no detail'}`,
      '',
      'The worker was stopped in its first turn, so the diff below is whatever existed before it',
      'was stopped — which is usually nothing.',
      '',
    );
  }

  lines.push(`Run \`${runId ?? 'unknown'}\`${recordPath ? `, record at \`${recordPath}\`` : ''}.`);
  return lines.join('\n');
}

// `deliver({...}) -> { committed, branch, base, pushed, pr_url, steps[], error }`
//
// NEVER THROWS. Delivery runs after a graded run, and §7's rule applies with more force here than
// anywhere: the work landed and the gate graded it, so a failure to open a PR must read as "the PR
// was not opened" and never as "the run failed". A throw would reach `cli.mjs` as exit 2, which a
// scheduler retries — paying for the whole run again to re-attempt a `gh` call.
//
// PER-SUBSTEP, NOT ONE try/catch. A push that succeeded and a `gh pr create` that failed is a
// materially different state from neither happening: the branch is on the remote and the next
// attempt must not re-push. So each substep records its own outcome in `steps[]`, and the first
// failure stops the sequence rather than being retried past.
export async function deliver({
  repoRoot,
  config,
  item,
  gate,
  runId,
  recordPath = null,
  preflight = null,
  gh = defaultGh,
  now = null,
} = {}) {
  const steps = [];

  // THE STATE SO FAR, AND `fail` REPORTS IT RATHER THAN ZEROING IT. This started as a `fail` that
  // returned a hardcoded `committed: false, branch: null`, and a test of a push failure caught it:
  // the commit HAD happened, the branch existed, and delivery reported neither. That is the
  // project's recurring computed-and-discarded defect (#63/#69/#72/#73) landing in the one place
  // where the discarded value is "where the only copy of this run's work went" — an operator
  // reading that record would not know there was a branch to look at, and the next tick's
  // `treeIsDirty` check would find a clean tree and spawn straight over it.
  //
  // So a failure reports what is TRUE, not what would be tidy.
  const state = { committed: false, branch: null, base: null, pushed: false, pr_url: null, head: null };

  const fail = (step, error) => {
    const message = String(error?.message ?? error);
    steps.push({ step, ok: false, error: message });
    return { ...state, steps, error: message };
  };
  const done = (step, detail = null) => steps.push({ step, ok: true, detail });

  if (!repoRoot) return fail('preconditions', new Error('no repoRoot: refusing to deliver from an unnamed directory'));
  if (!config) return fail('preconditions', new Error('no config: refusing to deliver without a delivery mode or a base'));

  // NEVER MERGE, AT THE POINT OF USE. See the header. Note what this does NOT do: it does not
  // merge-and-then-check, and there is no code path in this module that calls `gh pr merge` or
  // `git merge` at all. The check is here so that the refusal is stated where the capability would
  // live, which is what makes it survive someone adding that capability later.
  if (config.delivery?.never_merge !== true) {
    return fail(
      'preconditions',
      new Error(
        `delivery.never_merge is ${JSON.stringify(config.delivery?.never_merge)}, not true: refusing to ` +
          'deliver at all. The harness never merges its own PRs, and a config that does not say so ' +
          'has been edited past the one place that guarantee is written down.',
      ),
    );
  }

  const mode = config.delivery?.mode ?? null;
  if (mode !== 'pr' && mode !== 'push') {
    return fail('preconditions', new Error(`delivery.mode is ${JSON.stringify(mode)}: expected 'pr' or 'push'`));
  }

  // THE BASE, RESOLVED — AND THIS IS THE CALL `run.mjs`'s Step 3 DELIBERATELY DID NOT MAKE. Its
  // comment said so outright: "belongs to delivery rather than to the worker … deliberately not
  // called, so that a base this thin path cannot use is not resolved and then quietly discarded."
  // This is the path that can use it, so this is where it is called.
  //
  // NULL IS FATAL TO DELIVERY, NOT DEFAULTED TO A BRANCH NAME. `resolveBase` returns null rather
  // than inventing 'master' because TARS-1271's base was `feat/migrate-native-fetch-from-axios`,
  // and a PR against master would have targeted the wrong tree. Inventing it here would reintroduce
  // that defect one layer down.
  const base = resolveBase(config, { epic: item?.epic ?? null });
  if (!base) {
    return fail(
      'resolve_base',
      new Error(
        `no base branch resolved for ${item?.epic ? `epic ${item.epic}` : 'an item with no epic'}: ` +
          'refusing to guess. Declare a `base.rules` entry — a PR opened against the wrong base is ' +
          'not a formatting problem, it targets the wrong tree.',
      ),
    );
  }
  done('resolve_base', base);
  state.base = base;

  const branch = branchNameFor({ itemId: item?.id, runId });

  // BRANCH FROM THE RESOLVED BASE, NOT FROM HEAD, and the difference is not cosmetic. A worker runs
  // on whatever was checked out; if that is not the base, branching from HEAD carries every commit
  // between them into the PR and the diff shows work this run did not do.
  //
  // `--no-track` because the local branch is not following the base, and `git branch` would
  // otherwise set an upstream that a later `git pull` would act on.
  try {
    // The base must EXIST locally to branch from it. Fetching it first is the difference between
    // "we do not have that ref" and a confident branch off a stale copy.
    await git(repoRoot, 'fetch', 'origin', base).catch(() => null);
    done('fetch_base', base);
  } catch {
    // Non-fatal by construction: a repo with no `origin` (every test, and a local-only repo) has
    // nothing to fetch, and the checkout below is what actually decides whether the base is usable.
  }

  return await commitAndPush({ repoRoot, config, item, gate, runId, recordPath, preflight, gh, base, branch, steps, done, fail, mode, now, state });
}

async function commitAndPush({ repoRoot, config, item, gate, runId, recordPath, preflight, gh, base, branch, steps, done, fail, mode, now, state }) {
  // Is there anything to commit? Asked BEFORE creating the branch, because a branch created for a
  // run that changed nothing is litter an operator has to clean up, and `git commit` on a clean
  // tree exits non-zero, which would read as a delivery failure rather than as "nothing happened".
  let dirty;
  try {
    dirty = (await git(repoRoot, 'status', '--porcelain')).trim();
  } catch (err) {
    return fail('observe', err);
  }
  if (!dirty) {
    // NOT AN ERROR, AND NOT A PUSH. A worker that changed nothing has delivered nothing; there is
    // no branch, no commit, and no PR, and `error` stays null because nothing went wrong.
    done('nothing_to_commit');
    return { ...state, steps, error: null };
  }

  try {
    // `git switch -c <branch> <base>` — create from the base, not from HEAD. `--no-track` so no
    // upstream is set by the branch creation itself; the push below sets it deliberately.
    await git(repoRoot, 'switch', '--no-track', '-c', branch, base);
    done('branch', `${branch} from ${base}`);
    // Set AFTER the switch returns, not before: a `branch` in the result means the ref exists and an
    // operator can check it out. Naming a branch we failed to create would send them to nothing.
    state.branch = branch;
  } catch (err) {
    // FALLING BACK TO HEAD IS NOT AN OPTION, and this is where it would be tempting. If the base is
    // not resolvable locally, a branch off HEAD would produce a PR whose diff includes everything
    // between HEAD and the base — work this run did not do, attributed to it.
    return fail('branch', new Error(`could not branch ${branch} from ${base}: ${err.message}`));
  }

  try {
    // `-A` with an explicit `--` and no pathspec: everything the worker touched, which is what the
    // gate graded. Narrowing it here would commit a different tree than the one graded.
    await git(repoRoot, 'add', '-A');
    await git(repoRoot, 'commit', '--no-verify', '-m', commitMessage({ item, gate, runId }));
    done('commit');
    state.committed = true;
  } catch (err) {
    return fail('commit', err);
  }

  state.head = await git(repoRoot, 'rev-parse', 'HEAD').catch(() => null);

  // THE VERDICT GATES THE PUSH, AND ONLY THE PUSH. The commit above already happened, so a failed
  // run's work is preserved on a local branch either way.
  if (!gate?.pass) {
    done('push_skipped', `gate failed with ${gate?.findings?.length ?? 0} finding(s) — committed locally, not pushed`);
    return { ...state, steps, error: null };
  }

  try {
    // `-u` sets the upstream so a human can `git pull` on the branch afterwards. NOT `--force`:
    // a non-fast-forward push means someone else has that branch name, and overwriting it is the
    // one irreversible thing in this module.
    await git(repoRoot, 'push', '-u', 'origin', branch);
    done('push', branch);
    state.pushed = true;
  } catch (err) {
    // `state.pushed` stays false and `state.committed` stays TRUE — the commit is on a local branch
    // and the operator needs to be told which one, which is the whole reason `fail` reports state.
    return fail('push', err);
  }

  if (mode === 'push') {
    // `mode: 'push'` means the branch is the delivery. No PR, and that is the config's choice.
    return { ...state, steps, error: null };
  }

  try {
    // `--draft`, ALWAYS. See the header: not a config key, and not overridable from a repo file.
    const out = await gh(
      [
        'pr',
        'create',
        '--draft',
        '--base',
        base,
        '--head',
        branch,
        '--title',
        prTitle({ item, gate }),
        '--body',
        prBody({ item, gate, runId, recordPath, preflight }),
      ],
      { cwd: repoRoot },
    );
    // The URL is the last thing `gh pr create` prints. Extracted rather than assumed to be the
    // whole output, because `gh` also prints warnings on stderr and both are captured.
    const url = (String(out).match(/https:\/\/\S+/g) ?? []).pop() ?? null;
    done('pr', url);
    state.pr_url = url;
    return { ...state, steps, error: null };
  } catch (err) {
    // THE PUSH ALREADY HAPPENED, and `state.pushed` is already true — a caller that read
    // `pushed: false` here would re-push a branch that is on the remote. This is the one place the
    // error message is rewritten rather than passed through, because "gh: HTTP 422" alone does not
    // tell an operator that the branch landed.
    steps.push({ step: 'pr', ok: false, error: String(err?.message ?? err) });
    return { ...state, steps, error: `the branch was pushed but no PR was opened: ${String(err?.message ?? err)}` };
  }
}

// The commit message. `alfred(<item>):` so `git log --oneline` says who made it, the verdict
// because a reader of the log should not have to open the PR to learn whether it passed, and the
// run id because that is the join key to the record.
function commitMessage({ item, gate, runId }) {
  const n = gate?.findings?.length ?? 0;
  return [
    `alfred(${item?.id ?? 'unknown'}): ${String(item?.title ?? 'no title').trim().slice(0, 60)}`,
    '',
    `Written by Alfred, graded ${gate?.pass ? 'PASS' : 'FAIL'} with ${n} finding(s). Run ${runId ?? 'unknown'}.`,
    '',
    'Not reviewed by a human at the time of this commit.',
  ].join('\n');
}

function prTitle({ item, gate }) {
  const title = String(item?.title ?? '').trim() || String(item?.id ?? 'untitled');
  // THE FAIL MARKER IS IN THE TITLE, not only in the body. A failed run reaches a remote only in
  // `mode: 'push'`, but a title is what shows in a list of PRs, and a reviewer scanning that list
  // should not have to open one to find out the harness itself thinks it is broken.
  return gate?.pass ? `${title}` : `[alfred: FAILED GATE] ${title}`;
}
