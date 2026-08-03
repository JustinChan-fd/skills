// telemetry — pushes `record.json` to the real sink, a git-cloned remote.
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

export function ensureClone({ dir, remote }) {
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['clone', remote, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return dir;
}

// Pushes `<runDir>/record.json` to `<telemetry.dir>/log/<slug(record.session.repo)>/
// <record.session.run_id>.json` in a git clone of `telemetry.remote`, and commits + pushes it.
//
// `record` is passed in rather than re-read from disk: `lib/run.mjs` already holds it in memory
// at Step 7c, and re-reading would be a second, potentially different, source of truth for what
// this call is syncing.
export function syncRecord({ runDir, telemetry, record, now = new Date(), retries = 3 }) {
  if (!telemetry?.remote || !telemetry?.dir) return { synced: false, reason: 'telemetry_not_configured' };
  if (!record?.session?.repo || !record?.session?.run_id) {
    return { synced: false, reason: 'record_missing_session_identity' };
  }

  const dir = expandHome(telemetry.dir);

  // The lock's parent may not exist yet on a fresh machine (e.g. ~/.harness/ absent). Ensure the
  // chain up to the clone dir's parent exists before taking the lock; `ensureClone` creates the
  // clone dir itself.
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
      ensureClone({ dir, remote: telemetry.remote });
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

      for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
          git(dir, 'push', '-u', 'origin', 'HEAD');
          return { synced: true, path: join(destDir, `${record.session.run_id}.json`) };
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
