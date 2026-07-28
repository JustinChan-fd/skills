// Red-flag detection over synced telemetry. Telemetry records everything
// reliably, but nothing watches it — this scan is the watcher: deterministic
// threshold checks over recent records plus an audit-integrity pass that
// verifies every succeeded run left its full event skeleton behind.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = { outlier_multiple: 3, min_samples: 3, recent_limit: 50 };

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function costMid(cost) {
  if (typeof cost === 'number') return cost;
  if (cost && typeof cost.mid === 'number') return cost.mid;
  return null;
}

export function readEvents(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return []; // a corrupt line is not this scan's crash to have
      }
    });
}

// Token figures that were estimated rather than platform-reported. Structured
// form first ({estimated: true}); else prose that says "estimated" about
// tokens — but never a note explaining the figure is "reported, not
// estimated" (a real run wrote exactly that and must not be flagged).
function isEstimatedTokensNote(data) {
  if (data?.estimated === true) return true;
  if (data?.estimated === false) return false; // structured and explicit: platform-reported
  const text = JSON.stringify(data ?? {});
  return /token/i.test(text) && /estimat/i.test(text) && !/not estimated/i.test(text);
}

function recordChecks({ record, events, routing, findings }) {
  const flag = (check, detail) => findings.push({ run_id: record.run_id, check, detail });

  if (record.status !== 'succeeded') {
    flag('run_not_succeeded', `status=${record.status}${record.reason?.code ? ` reason=${record.reason.code}` : ''}`);
  }
  if (record.reason?.code === 'verifier_blocking_cap') {
    flag('verifier_cap_hit', record.reason.detail ?? 'verifier revision cap reached');
  }

  const threshold = routing.advisory_open_score ?? null;
  const cap = routing.sizes?.[record.size]?.revision_cap ?? null;
  for (const p of record.phases ?? []) {
    if (threshold !== null && p.verifier_score !== null && p.verifier_score !== undefined && p.verifier_score < threshold) {
      flag('low_verifier_score', `${p.phase}: score ${p.verifier_score} < advisory_open_score ${threshold}`);
    }
    if (cap !== null && p.rounds_used !== null && p.rounds_used >= cap) {
      flag('rounds_at_cap', `${p.phase}: ${p.rounds_used} rounds on size ${record.size} (cap ${cap})`);
    }
  }

  for (const e of events ?? []) {
    if (e.event === 'note' && isEstimatedTokensNote(e.data)) {
      flag('tokens_estimated', 'token figures estimated, not platform-reported');
      break;
    }
  }

  // Audit-integrity: a succeeded run must have left its full event skeleton.
  // Non-succeeded runs are already flagged above; their streams are expected
  // to be partial.
  if (record.status !== 'succeeded') return;
  if (events === null) {
    flag('events_missing', 'no events.jsonl beside a succeeded record');
    return;
  }
  const has = (name) => events.some((e) => e.event === name);
  if (!has('run_start')) flag('missing_run_start_event', 'no run_start in event stream');
  if (!has('run_end')) flag('missing_run_end_event', 'no run_end in event stream');
  for (const p of record.phases ?? []) {
    if (!events.some((e) => e.event === 'phase_end' && (e.phase === p.phase || e.data?.phase === p.phase))) {
      flag('missing_phase_end_event', `no phase_end for phase ${p.phase}`);
    }
  }
  const roundsUsed = (record.phases ?? []).reduce((sum, p) => sum + (p.rounds_used ?? 0), 0);
  if (roundsUsed >= 1) {
    const audited = events.filter((e) => e.event === 'verifier_round').length;
    if (audited < roundsUsed) {
      flag('verifier_rounds_unaudited', `${audited} verifier_round events for ${roundsUsed} rounds used`);
    }
    if (!events.some((e) => e.event === 'spawn' && /^verifier/.test(e.data?.task_type ?? ''))) {
      flag('verifier_spawn_unaudited', 'verifier ran (rounds_used >= 1) but no verifier spawn event was audited');
    }
  }
}

function outlierChecks({ records, cfg, findings }) {
  const groups = new Map();
  for (const { record } of records) {
    const key = `${record.repo}__${record.kind}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  for (const group of groups.values()) {
    if (group.length < cfg.min_samples) continue;
    for (const [check, valueOf] of [
      ['wall_outlier', (r) => (typeof r.wall_ms === 'number' ? r.wall_ms : null)],
      ['cost_outlier', (r) => costMid(r.estimated_cost)],
    ]) {
      const values = group.map(valueOf).filter((v) => v !== null);
      if (values.length < cfg.min_samples) continue;
      const med = median(values);
      if (med <= 0) continue;
      for (const record of group) {
        const v = valueOf(record);
        if (v !== null && v > cfg.outlier_multiple * med) {
          findings.push({
            run_id: record.run_id,
            check,
            detail: `${v} > ${cfg.outlier_multiple}x the ${record.repo}/${record.kind} median (${med})`,
          });
        }
      }
    }
  }
}

// A failed dashboard build leaves docs/ committed behind log/: healthy syncs
// commit data and rebuilt dashboard together. Judged from git history, not
// file mtimes (clone checkouts rewrite mtimes). Skipped when there is no
// docs/ or no git history to consult.
function dashboardCheck({ dir, findings }) {
  if (!existsSync(join(dir, 'docs')) || !existsSync(join(dir, '.git'))) return;
  const lastCommitTime = (path) => {
    const out = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%ct', '--', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out ? Number(out) : null;
  };
  try {
    const logTime = lastCommitTime('log');
    const docsTime = lastCommitTime('docs');
    if (logTime !== null && docsTime !== null && docsTime < logTime) {
      findings.push({
        run_id: null,
        check: 'dashboard_stale',
        detail: 'docs/ last committed before the latest log/ commit — a dashboard rebuild likely failed or was skipped',
      });
    }
  } catch {
    // no commits yet, or git unavailable — nothing to judge
  }
}

export function scanAnomalies({ dir, repo = null, limit = null, routing = {} }) {
  const cfg = { ...DEFAULTS, ...(routing.anomalies ?? {}) };
  const findings = [];
  const logDir = join(dir, 'log');

  const files = [];
  if (existsSync(logDir)) {
    for (const repoDir of readdirSync(logDir)) {
      if (repo && repoDir !== repo) continue;
      const full = join(logDir, repoDir);
      if (!statSync(full).isDirectory()) continue; // .DS_Store and friends
      for (const name of readdirSync(full)) {
        if (name.endsWith('.json') && !name.endsWith('.events.jsonl')) {
          files.push({ name, path: join(full, name) });
        }
      }
    }
  }
  // Run ids open with an ISO timestamp, so filename order is time order.
  files.sort((a, b) => (a.name < b.name ? 1 : -1));
  const recent = files.slice(0, limit ?? cfg.recent_limit);

  const records = [];
  for (const f of recent) {
    let record;
    try {
      record = JSON.parse(readFileSync(f.path, 'utf8'));
    } catch (err) {
      findings.push({ run_id: f.name.replace(/\.json$/, ''), check: 'record_unparseable', detail: err.message });
      continue;
    }
    const events = readEvents(f.path.replace(/\.json$/, '.events.jsonl'));
    records.push({ record, events });
  }

  for (const { record, events } of records) recordChecks({ record, events, routing, findings });
  outlierChecks({ records, cfg, findings });
  dashboardCheck({ dir, findings });

  return { ok: findings.length === 0, scanned: recent.length, findings };
}
