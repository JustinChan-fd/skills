// telemetry — commits `record.json` into the real sink, and pushes it when the sink has a remote.
//
// TWO SINK SHAPES (A4). `telemetry.dir` alone is a LOCAL-ONLY sink: `git init`, commit, no push,
// and the result carries `remote: null` so a reader can tell these records exist on exactly one
// machine. `dir` + `remote` is the original clone-and-push path. A remote added to config later is
// reconciled onto an already-initialized sink, so the local phase is not a dead end.
//
// A FRESH, INDEPENDENT IMPLEMENTATION, not an import. `harness-core/tools/lib/telemetry.mjs`
// already does this (`syncRun`), and its mechanics are mirrored here deliberately, but Alfred
// does not import it: `test/isolation.test.mjs` and PERSONA.md §8 make "Alfred imports nothing
// from harness-core" a tested rule, not a style preference — "Alfred is meant to survive
// harness-core being absent." `syncRun` also reads flat `record.repo`/`record.run_id`; Alfred's
// own record (see report.mjs) nests these under `record.session.repo`/`record.session.run_id`,
// so an import would need an adapter anyway. Reading Alfred's own shape directly needs none.
//
// UNCONDITIONALLY SAFE TO CALL. `syncRecord({ runDir, telemetry: null, record })` no-ops with
// `{ synced: false, reason: 'telemetry_not_configured' }` rather than requiring the call site to
// guard it — same contract `syncRun` has, so `lib/run.mjs` never needs an `if` around this call.
//
// NEVER THROWS, for the same sidecar reason `lib/run.mjs`'s Step 7/7b are try/caught: a sink
// outage (network down, remote renamed, disk full) must not turn a graded run into a refusal.
//
// `git add -A -- log` IS SCOPED TO `log/` ONLY, on purpose, not as a lint nit. The clone at
// `telemetry.dir` may double as a working repo, and `report.test.mjs`'s header records the
// measured incident: a wider `add -A` once swept unrelated staged changes into a telemetry
// commit. This module carries that lesson forward as code, not just as a comment on a sibling.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Same constant `syncRun` uses. A lock dir older than this is presumed to belong to a dead
// process rather than a live holder, so the next caller steals it rather than staying blocked
// forever on a crash nobody is going to clean up.
const LOCK_STALE_MS = 5 * 60 * 1000;

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Collapses runs of non-alphanumerics to single "-". Matches harness-core's own `slugifyRepo`
// (runid.mjs) byte-for-byte, so both writers land in the same `log/<slug>/` directory for a
// repo named identically by either caller — the point of a shared sink.
function slugifyRepo(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function expandHome(path) {
  if (typeof path !== 'string') return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

// Same atomic-write shape as `syncRun`'s `atomicWrite`: a same-directory temp file, then
// rename. A plain write can tear on a crash mid-write, and a later reader of a half-written
// JSON file would see a parse error where the run actually succeeded.
function atomicWrite(destPath, content) {
  const tmp = `${destPath}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, destPath);
}

// Makes `dir` a git repo that syncs are safe to commit into, and reconciles `origin` against the
// configured remote. Returns `{ dir, remote }` — the remote actually reachable from this repo, or
// null for a local-only sink — or `{ error }` for a divergence this must not resolve on its own.
//
// THREE CASES, and they are not interchangeable:
//
//   remote, no repo yet    `git clone`. The original behaviour, unchanged.
//   no remote              `git init`. A LOCAL-ONLY SINK (A4). Committing rather than merely
//                          writing is what lets a remote added later carry the whole history off
//                          the machine in one push.
//   repo exists            reconcile. This is the case the pre-A4 code got wrong: it cloned only
//                          `if (!existsSync(dir/.git))`, so after an init it was a permanent
//                          no-op, and NOTHING in this module ever ran `git remote add`. Adding a
//                          remote to config later failed `'origin' does not appear to be a git
//                          repository` → 3 retries → `push_failed`, forever. Reproduced, then
//                          fixed here rather than left for whoever hit it in six months.
//
// A DISAGREEING ORIGIN IS NAMED, NEVER REWRITTEN. Silently re-pointing `origin` would push this
// machine's records into a repo its operator did not aim at; silence would make the divergence
// unobservable. So the sync refuses with both urls in the reason.
export function ensureSink({ dir, remote = null }) {
  const isRepo = existsSync(join(dir, '.git'));

  if (!isRepo) {
    mkdirSync(dir, { recursive: true });
    if (remote) {
      execFileSync('git', ['clone', remote, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { dir, remote };
    }
    // `-b main` to match the branch a clone of the real sink would be on, rather than inheriting
    // whatever `init.defaultBranch` this machine happens to have — a sink whose branch name
    // depends on who initialized it needs a merge nobody asked for the first time it is shared.
    git(dir, 'init', '--quiet', '-b', 'main');
    return { dir, remote: null };
  }

  // The repo already exists. What it is pointed at may or may not be what config now says.
  let existing = null;
  try {
    existing = git(dir, 'remote', 'get-url', 'origin').trim() || null;
  } catch {
    existing = null;
  }

  // CONFIG IS THE AUTHORITY, NOT THE LEFTOVER GIT REMOTE. Returning `existing` here was a defect
  // in this fix's first draft: a sink that had once been a clone kept pushing after its config was
  // deliberately retargeted local-only — which is exactly the retarget webtarsthree's config gets.
  // The origin is left in place (this refuses to push, it does not tear config down), but a run
  // whose config names no remote does not leave the machine.
  if (!remote) return { dir, remote: null };
  if (!existing) {
    git(dir, 'remote', 'add', 'origin', remote);
    return { dir, remote };
  }
  if (existing !== remote) {
    return {
      error:
        `origin_mismatch: the sink at ${dir} has origin ${existing}, but telemetry.remote is ${remote}. ` +
        'Refusing rather than re-pointing it — a rewritten origin pushes these records somewhere nobody aimed at.',
    };
  }
  return { dir, remote };
}

// Writes `<runDir>/record.json` to `<telemetry.dir>/log/<slug(record.session.repo)>/
// <record.session.run_id>.json` in the sink repo, commits it, and pushes only when the sink has a
// remote (A4). Returns `{synced: true, path, remote}` — `remote: null` for a local-only sink.
//
// `record` is passed in rather than re-read from disk: `lib/run.mjs` already holds it in memory
// at Step 7c, and re-reading would be a second, potentially different, source of truth for what
// this call is syncing.
export function syncRecord({ runDir, telemetry, record, now = new Date(), retries = 3 }) {
  // `dir` IS THE REQUIREMENT; `remote` IS OPTIONAL (A4). A remote with no dir has nowhere to clone
  // into and stays a no-op — `loadConfig` refuses that shape too, but this module is called
  // directly by tests and by the backfill, so the guard is not redundant.
  if (!telemetry?.dir) return { synced: false, reason: 'telemetry_not_configured' };
  if (!record?.session?.repo || !record?.session?.run_id) {
    return { synced: false, reason: 'record_missing_session_identity' };
  }

  const dir = expandHome(telemetry.dir);

  // The lock's parent may not exist yet on a fresh machine (e.g. ~/.harness/ absent). Ensure the
  // chain up to the sink dir's parent exists before taking the lock; `ensureSink` creates the
  // sink dir itself.
  try {
    mkdirSync(dirname(dir), { recursive: true });
  } catch (err) {
    return { synced: false, reason: `sync_error: ${err.message}` };
  }

  // An atomic mkdir as the advisory lock: exactly one caller wins the race for this clone.
  const lockPath = `${dir}.lock`;
  let lockedByThisCall = false;
  try {
    mkdirSync(lockPath);
    lockedByThisCall = true;
  } catch (err) {
    if (err.code !== 'EEXIST') return { synced: false, reason: `sync_error: ${err.message}` };
    let stale = false;
    try {
      stale = now.getTime() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch {
      // Lock dir vanished between the failed mkdir and this stat — another caller is already
      // racing to clean it up; treat as still locked.
    }
    if (!stale) return { synced: false, reason: 'locked' };
    try {
      rmSync(lockPath, { recursive: true, force: true });
      mkdirSync(lockPath);
      lockedByThisCall = true;
    } catch {
      return { synced: false, reason: 'locked' };
    }
  }

  try {
    try {
      const sink = ensureSink({ dir, remote: telemetry.remote ?? null });
      // Refused BEFORE anything is written. A record staged into a repo whose origin disagrees
      // with config would sit there uncommitted and unexplained.
      if (sink.error) return { synced: false, reason: sink.error };
      const destDir = join(dir, 'log', slugifyRepo(record.session.repo));
      mkdirSync(destDir, { recursive: true });
      atomicWrite(join(destDir, `${record.session.run_id}.json`), readFileSync(join(runDir, 'record.json')));

      // Stage ONLY log/ — see this file's header. The clone may double as a working repo, and
      // `add -A` alone was the measured cause of a past incident absorbing unrelated changes.
      git(dir, 'add', '-A', '--', 'log');

      // Commit as the configured identity when given; else the clone's own git config
      // (hardcoding an identity here would fight commit-verification hooks on a clone that
      // already has one). Retry once with a fallback identity only when the clone has none.
      const idFlags = telemetry.commit_identity
        ? ['-c', `user.name=${telemetry.commit_identity.name}`, '-c', `user.email=${telemetry.commit_identity.email}`]
        : [];
      // `-- log` on the commit too, not just the `add` above. Without it, `git commit` commits
      // the WHOLE INDEX — every path already staged by another process sharing this clone, not
      // just what this call just staged. Scoping `add` alone was measured to still leak an
      // unrelated staged file into the commit (see the REGRESSION test in telemetry.test.mjs).
      try {
        git(dir, ...idFlags, 'commit', '-m', `run: ${record.session.run_id}`, '--', 'log');
      } catch (err) {
        const noIdentity = /user\.(name|email)|tell me who you are/i.test(String(err.stderr ?? err.message));
        if (!telemetry.commit_identity && noIdentity) {
          try {
            git(dir, '-c', 'user.email=harness@local', '-c', 'user.name=harness', 'commit', '-m', `run: ${record.session.run_id}`, '--', 'log');
          } catch {
            // Nothing new to commit — still try to push earlier unpushed commits.
          }
        }
        // Otherwise: nothing new to commit — still try to push.
      }

      const path = join(destDir, `${record.session.run_id}.json`);

      // NO PUSH LOOP FOR A LOCAL SINK (A4). Left unconditional, `push -u origin HEAD` against a
      // repo with no origin fails 3 times and returns `push_failed` — a record that committed
      // perfectly, reported as unsynced. `remote: null` is the field that carries the distinction:
      // the contract is `{synced, reason?}` / `{synced: true, path}`, so without it nothing
      // downstream could tell a local-only sync from one that left the machine.
      if (!sink.remote) return { synced: true, path, remote: null };

      for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
          git(dir, 'push', '-u', 'origin', 'HEAD');
          return { synced: true, path, remote: sink.remote };
        } catch {
          try {
            git(dir, 'pull', '--rebase');
          } catch {
            // Remote may be empty or unreachable; retry push regardless.
          }
        }
      }
      return { synced: false, reason: 'push_failed' };
    } catch (err) {
      return { synced: false, reason: `sync_error: ${err.message}` };
    }
  } finally {
    if (lockedByThisCall) {
      try {
        rmdirSync(lockPath);
      } catch {
        // Best-effort unlock. A stale lock left behind is reclaimed by the next caller once
        // it is older than LOCK_STALE_MS, rather than locking the sink out forever.
      }
    }
  }
}
