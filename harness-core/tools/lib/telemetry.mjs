// Layer-2 logging: one file per run in a central git repo — appends never
// collide, so concurrent machines can't conflict (spec §4). Push failure is
// non-fatal; the sweep guarantees eventual delivery.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readRecord, writeRecord } from './record.mjs';

const FINAL_STATUSES = ['succeeded', 'failed', 'partial', 'cancelled', 'timeout', 'abandoned'];

// A lock dir older than this is presumed to belong to a dead process (crash,
// kill -9) rather than a live holder — the next caller steals it so eventual
// delivery isn't blocked forever.
const LOCK_STALE_MS = 5 * 60 * 1000;

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// The dashboard build assumes every log/**/*.json parses. Plain writes can
// tear on a crash and a later sweep would commit the partial file — so land
// files via same-directory temp + rename (atomic on one filesystem): a file
// at its final path is always complete.
export function atomicWrite(destPath, content) {
  const tmp = `${destPath}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, destPath);
}

// A crash between write and rename strands a .tmp; staging is `git add -A
// -- log` across the WHOLE tree (a multi-repo store), so a temp stranded in
// one repo's dir would ride along on any other repo's sync. Purge
// recursively across all of log/ before staging, not just the syncing
// run's own dest dir.
function purgeTempFiles(logDir) {
  if (!existsSync(logDir)) return;
  for (const name of readdirSync(logDir)) {
    const path = join(logDir, name);
    let entryStat;
    try {
      entryStat = statSync(path);
    } catch {
      continue; // vanished between readdir and stat — nothing to purge
    }
    if (entryStat.isDirectory()) {
      purgeTempFiles(path);
    } else if (name.endsWith('.tmp')) {
      try {
        unlinkSync(path);
      } catch {
        // best effort — a vanished temp file is the outcome we wanted
      }
    }
  }
}

export function ensureClone({ dir, remote }) {
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['clone', remote, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return dir;
}

export function syncRun({ runDir, telemetry, now = new Date(), retries = 3 }) {
  if (!telemetry?.remote || !telemetry?.dir) return { synced: false, reason: 'telemetry_not_configured' };

  // The lock lives at "<dir>.lock", a SIBLING of the clone dir — so its parent
  // is the clone dir's parent. On a fresh machine that parent may not exist yet
  // (e.g. ~/.harness/telemetry when ~/.harness/ is absent); a non-recursive
  // mkdir of the lock would then fail ENOENT and no run would ever sync. Ensure
  // the parent chain exists before taking the lock. (ensureClone later creates
  // the clone dir itself.)
  try {
    mkdirSync(dirname(telemetry.dir), { recursive: true });
  } catch (err) {
    return { synced: false, reason: `sync_error: ${err.message}` };
  }

  // The clone at telemetry.dir is shared across concurrent same-machine syncRun
  // calls (e.g. a sweep over many runs, or overlapping harness invocations).
  // An atomic mkdir is our advisory lock: exactly one caller wins the race.
  const lockPath = `${telemetry.dir}.lock`;
  let lockedByThisCall = false;
  try {
    mkdirSync(lockPath);
    lockedByThisCall = true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      let stale = false;
      try {
        stale = now.getTime() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        // lock dir vanished between the failed mkdir and this stat — another
        // caller is already racing to clean it up; treat as still locked.
      }
      if (stale) {
        try {
          rmSync(lockPath, { recursive: true, force: true });
          mkdirSync(lockPath);
          lockedByThisCall = true;
        } catch {
          return { synced: false, reason: 'locked' };
        }
      } else {
        return { synced: false, reason: 'locked' };
      }
    } else {
      return { synced: false, reason: `sync_error: ${err.message}` };
    }
  }

  let buildResult = null;
  try {
    let record;
    try {
      record = readRecord(runDir);
      const dir = ensureClone({ dir: telemetry.dir, remote: telemetry.remote });
      const destDir = join(dir, 'log', record.repo);
      mkdirSync(destDir, { recursive: true });
      purgeTempFiles(join(dir, 'log'));
      atomicWrite(join(destDir, `${record.run_id}.json`), readFileSync(join(runDir, 'record.json')));
      const auditPath = join(runDir, '..', '..', 'audit.jsonl');
      if (existsSync(auditPath)) {
        const slice = readFileSync(auditPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .filter((line) => JSON.parse(line).run_id === record.run_id);
        atomicWrite(join(destDir, `${record.run_id}.events.jsonl`), slice.join('\n') + '\n');
      }

      // Optional dashboard rebuild: keep the published view in the same
      // commit as the data it renders. Failure never blocks the sync.
      if (telemetry.build) {
        try {
          execFileSync('sh', ['-c', telemetry.build], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
          buildResult = 'ok';
        } catch (err) {
          buildResult = `failed: ${err.message}`.slice(0, 200);
        }
      }

      // Stage ONLY the paths this sync owns (log/, plus docs/ when a build
      // produced it) — the clone may double as a working repo, and `add -A`
      // was observed sweeping unrelated uncommitted changes into telemetry
      // commits.
      git(dir, 'add', '-A', '--', 'log');
      if (existsSync(join(dir, 'docs'))) git(dir, 'add', '-A', '--', 'docs');

      // Commit as the configured identity when given; else the clone's own
      // git config (hardcoding an identity tripped commit-verification
      // hooks). Retry once with a default identity only when the clone has
      // none configured at all.
      const idFlags = telemetry.commit_identity
        ? ['-c', `user.name=${telemetry.commit_identity.name}`, '-c', `user.email=${telemetry.commit_identity.email}`]
        : [];
      try {
        git(dir, ...idFlags, 'commit', '-m', `run: ${record.run_id}`);
      } catch (err) {
        const noIdentity = /user\.(name|email)|tell me who you are/i.test(String(err.stderr ?? err.message));
        if (!telemetry.commit_identity && noIdentity) {
          try {
            git(dir, '-c', 'user.email=harness@local', '-c', 'user.name=harness', 'commit', '-m', `run: ${record.run_id}`);
          } catch {
            // nothing new to commit — still try to push earlier unpushed commits
          }
        }
        // otherwise: nothing new to commit — still try to push
      }
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          git(dir, 'push', '-u', 'origin', 'HEAD');
          record.synced_at = now.toISOString();
          writeRecord(runDir, record);
          return buildResult === null ? { synced: true } : { synced: true, build: buildResult };
        } catch {
          try {
            git(dir, 'pull', '--rebase');
          } catch {
            // remote may be empty or unreachable; retry push regardless
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
        // best-effort unlock; if this leaves a stale lock dir behind (e.g. we
        // crash before reaching here), the next caller steals it once it's
        // older than LOCK_STALE_MS instead of being locked out forever
      }
    }
  }
}

export function sweep({ targetDir, telemetry, now = new Date(), staleMs = 6 * 3600 * 1000 }) {
  const runsDir = join(targetDir, '.harness', 'runs');
  if (!existsSync(runsDir)) return { swept: [] };
  const swept = [];
  for (const id of readdirSync(runsDir)) {
    const runDir = join(runsDir, id);
    if (!existsSync(join(runDir, 'record.json'))) continue;
    let record;
    try {
      record = readRecord(runDir);
    } catch {
      // corrupt/unreadable record.json — leave it untouched, keep sweeping others
      continue;
    }
    if (record.synced_at) continue;
    if (record.status === 'attempted') {
      const age = now.getTime() - new Date(record.started_at).getTime();
      if (age <= staleMs) continue; // in-flight run — leave it alone
      record.status = 'abandoned';
      record.reason = { code: 'crash', detail: 'record never finalized; marked abandoned by sweep', phase: null, agent: null };
      record.emit_trigger = 'sweep'; // crash backstop, not a workflow-completed emit
      record.ended_at = now.toISOString();
      writeRecord(runDir, record);
    } else if (!FINAL_STATUSES.includes(record.status)) {
      continue;
    }
    if (syncRun({ runDir, telemetry, now }).synced) swept.push(id);
  }
  return { swept };
}
