// Experiment 2 watchdog. Prices each arm from its own transcript and decides, against
// the thresholds pre-registered in eval/armcost.mjs, whether to stop paying.
//
// One line per poll per arm, so the kill decision is auditable after the fact rather
// than asserted. Emits KILL lines that a Monitor grep can act on.

import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const { priceByModel, decideKill, THRESHOLDS, parseEtimeMs } = await import(
  '/Users/206618626@bwt3.com/Desktop/Repos/skills/alfred/eval/armcost.mjs'
);
const { collectFromFiles } = await import(
  '/Users/206618626@bwt3.com/Desktop/Repos/skills/harness-core/tools/lib/tokens-collect.mjs'
);

const DIR = '/Users/206618626@bwt3.com/.claude/jobs/c695fb15/tmp/exp2';
const PROJECTS = '/Users/206618626@bwt3.com/.claude/projects';

const ARMS = [
  {
    name: 'armA',
    caps: THRESHOLDS.armA,
    proj: `${PROJECTS}/-Users-206618626-bwt3-com--claude-jobs-c695fb15-tmp-exp2-armA-sandbox-a`,
  },
  {
    name: 'armB',
    caps: THRESHOLDS.armB,
    proj: `${PROJECTS}/-Users-206618626-bwt3-com--claude-jobs-c695fb15-tmp-exp2-armB-sandbox-a`,
  },
];

// Arm B's drivers are separate `claude` processes with their OWN transcript dirs keyed
// by their cwd. Pricing only the loop's own transcript would undercount the arm by
// however much its children spent — which is most of it. So: every transcript dir whose
// name contains the arm's sandbox path.
function transcriptsFor(arm) {
  const files = [];
  for (const entry of readdirSync(PROJECTS)) {
    if (!entry.includes(`exp2-${arm.name}-`)) continue;
    const dir = join(PROJECTS, entry);
    for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) files.push(join(dir, f));
  }
  return files;
}

// Consumed CPU time in ms, from `ps -o time=` ([[dd-]hh:]mm:ss.cc). Null when the
// process is gone — a missing reading must not read as "no progress".
function cpuTimeMs(pid) {
  if (!pid) return null;
  try {
    const raw = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (!raw) return null;
    const [hms, cs = '0'] = raw.split('.');
    const parts = hms.split(':').map(Number).reverse();
    const secs = (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600;
    return secs * 1000 + Number(cs) * 10;
  } catch {
    return null;
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// The ARM's age, not the watchdog's. Falls back to the watcher's own start only when
// `ps` gives nothing (the process is gone, so no cap is pending anyway) — never to 0,
// which would read as "just started" and reset the cap on every poll.
function armWallMs(pid) {
  if (!pid) return null;
  try {
    return parseEtimeMs(execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

const pidOf = (name) => {
  const f = `${DIR}/logs/${name}.pid`;
  return existsSync(f) ? Number(readFileSync(f, 'utf8').trim()) : null;
};

const state = new Map(); // arm -> {lastBytes, lastChangeAt, killed}
const started = Date.now();
const log = (line) => {
  process.stdout.write(`${line}\n`);
  writeFileSync(`${DIR}/logs/watch.log`, `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
};

async function poll() {
  let total = 0;
  const running = [];

  for (const arm of ARMS) {
    const pid = pidOf(arm.name);
    const files = transcriptsFor(arm);
    const bytes = files.reduce((n, f) => n + statSync(f).size, 0);

    // PROGRESS IS NOT TRANSCRIPT BYTES ALONE.
    //
    // Arm B dispatches each phase as a subagent with run_in_background:false, and the
    // subagent's entries do not land in the transcript until it RETURNS. Observed: 5+
    // minutes at 0.0% CPU, flat file, no children — which looks exactly like a hang
    // and is not one. Live TCP sockets and a climbing CPU-time counter showed it
    // waiting on an API response mid-phase.
    //
    // A byte-only stall signal would have killed a healthy arm B at minute 15 and
    // handed arm A the experiment on a measurement artifact. So consumed CPU time
    // counts as progress too: a genuinely wedged process burns none.
    const cpuMs = cpuTimeMs(pid);
    const prev =
      state.get(arm.name) ?? { lastBytes: -1, lastCpuMs: -1, lastChangeAt: started, killed: false };
    if (bytes !== prev.lastBytes || (cpuMs !== null && cpuMs !== prev.lastCpuMs)) {
      prev.lastChangeAt = Date.now();
    }
    prev.lastBytes = bytes;
    if (cpuMs !== null) prev.lastCpuMs = cpuMs;
    state.set(arm.name, prev);

    let usd = 0;
    let unpriced = [];
    if (files.length) {
      try {
        const r = await collectFromFiles(files);
        const p = priceByModel(r.by_model);
        usd = p.total_usd;
        unpriced = p.unpriced;
      } catch (err) {
        log(`${arm.name} PRICING-ERROR ${err.message}`);
      }
    }
    total += usd;

    const up = pid && alive(pid);
    if (up) running.push(arm.name);
    const sinceProgressMs = Date.now() - prev.lastChangeAt;

    const wallMs = armWallMs(pid) ?? Date.now() - started;

    log(
      `${arm.name} ${up ? 'RUNNING' : 'EXITED '} $${usd.toFixed(3)}/${arm.caps.spendCapUsd} ` +
        `wall=${Math.round(wallMs / 60000)}m quiet=${Math.round(sinceProgressMs / 1000)}s cpu=${cpuMs === null ? '-' : Math.round(cpuMs / 1000) + 's'} ` +
        `txn=${files.length} bytes=${bytes}${unpriced.length ? ` UNPRICED=${unpriced}` : ''}`,
    );

    if (!up || prev.killed) continue;

    const d = decideKill({
      usd,
      spendCapUsd: arm.caps.spendCapUsd,
      sinceProgressMs,
      stallMs: THRESHOLDS.stallMs,
    });
    // Wall-clock cap is the third pre-registered bound: an arm making steady slow
    // progress trips neither spend nor stall, and is still not worth waiting on.
    //
    // Measured from the ARM's process age (§2.7), not from this watcher's start. The
    // first version used `Date.now() - started`, so when the watchdog died with a
    // session and restarted mid-run, arm B's wall clock reset to 0m and the 90-minute
    // cap became unreachable. With the CPU-based stall fix already near-inert, that
    // left the run with no working bound at all.
    const overWall = wallMs > arm.caps.wallCapMs;

    if (d.kill || overWall) {
      prev.killed = true;
      const cause = d.kill ? d.cause : 'wall';
      const reason = d.kill ? d.reason : `exceeded the ${Math.round(arm.caps.wallCapMs / 60000)}-minute wall cap`;
      log(`KILL ${arm.name} cause=${cause} :: ${reason}`);
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  if (total > THRESHOLDS.totalCapUsd) {
    log(`KILL BOTH cause=total :: combined $${total.toFixed(2)} exceeded the $${THRESHOLDS.totalCapUsd} experiment cap`);
    for (const arm of ARMS) { const p = pidOf(arm.name); if (p && alive(p)) { try { process.kill(p, 'SIGTERM'); } catch {} } }
    return false;
  }

  log(`TOTAL $${total.toFixed(3)}/${THRESHOLDS.totalCapUsd} running=[${running.join(',')}]`);
  if (!running.length) { log('DONE both arms exited'); return false; }
  return true;
}

log(`WATCH start thresholds stall=${THRESHOLDS.stallMs / 60000}m armA=$${THRESHOLDS.armA.spendCapUsd} armB=$${THRESHOLDS.armB.spendCapUsd} total=$${THRESHOLDS.totalCapUsd}`);
while (await poll()) await new Promise((r) => setTimeout(r, 60_000));
