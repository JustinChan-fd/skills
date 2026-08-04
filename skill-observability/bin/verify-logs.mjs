#!/usr/bin/env node
// Validate the record store the way a DASHBOARD would have to trust it.
//
//   node bin/verify-logs.mjs [--dir <log-dir>]
//
// The test suite proves the WRITER is correct against fixtures. This proves the
// STORE is correct against whatever actually accumulated on disk — including
// records written by older code, which no test can retroactively cover. Every
// defect on this project so far was found by replaying real records rather than
// by a green test, so this is the check that earns the trust.
//
// Exits 1 if any invariant fails, so it can gate a dashboard build.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dirArg = process.argv.indexOf('--dir');
const LOG_DIR = dirArg > -1 ? process.argv[dirArg + 1] : process.env.SKILL_OBS_DIR || join(homedir(), '.claude', 'skill-runs');

// Costs are rounded to 6dp PER BUCKET before being summed, so a partition of
// two buckets can differ from the whole by up to ~5e-7 per term. Tokens are
// integers and get NO tolerance — an off-by-one there is a real defect.
// (A 1e-9 tolerance flagged 3 false positives on real records; the rounding is
// the design, and a checker stricter than the data's own precision is a bug
// in the checker.)
const COST_EPS = 1e-5;

const problems = [];
const notes = [];
function fail(scope, msg) {
  problems.push(`${scope}: ${msg}`);
}

function tokenSum(byModel) {
  return Object.values(byModel ?? {}).reduce(
    (s, b) => s + b.input + b.output + b.cache_read + b.cache_creation_5m + b.cache_creation_1h + b.cache_creation_unattributed,
    0,
  );
}

function main() {
  if (!existsSync(LOG_DIR)) {
    console.error(`no log dir at ${LOG_DIR}`);
    process.exit(1);
  }

  const files = [];
  for (const day of readdirSync(LOG_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    for (const f of readdirSync(join(LOG_DIR, day))) if (f.endsWith('.json')) files.push(join(day, f));
  }

  const indexPath = join(LOG_DIR, 'index.jsonl');
  const index = existsSync(indexPath)
    ? readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean).map((l, i) => {
        try {
          return JSON.parse(l);
        } catch {
          fail('index', `line ${i + 1} is not valid JSON`);
          return null;
        }
      }).filter(Boolean)
    : [];

  // ---- 1. the index must not lie about what is on disk ----------------------
  // This broke for real: two records written in the same second collided, so
  // index.jsonl held two lines pointing at one surviving file.
  for (const s of index) if (!existsSync(join(LOG_DIR, s.file))) fail('index', `references a missing record: ${s.file}`);
  const indexed = new Set(index.map((s) => s.file));
  for (const f of files) if (!indexed.has(f)) fail('index', `record on disk is not indexed: ${f}`);

  const byRunId = new Map();
  for (const s of index) {
    if (byRunId.has(s.run_id)) fail('index', `duplicate run_id ${s.run_id}`);
    byRunId.set(s.run_id, s);
  }

  // ---- 2. per-record invariants --------------------------------------------
  const records = files.map((f) => JSON.parse(readFileSync(join(LOG_DIR, f), 'utf8')));
  const runIds = new Set(records.map((r) => r.run.run_id));
  const bySession = new Map();
  let legacy = 0;

  for (const r of records) {
    const id = r.run.run_id ?? '(no run_id)';
    (bySession.get(r.run.session_id) ?? bySession.set(r.run.session_id, []).get(r.run.session_id)).push(r);

    const a = r.computed?.attribution;
    if (!a) {
      // Records written before the attribution work exists on disk and must be
      // skipped explicitly, not defaulted — a checker that silently treats a
      // missing block as zero would report a clean store that isn't comparable.
      legacy++;
      notes.push(`${id}: pre-attribution record, partition checks skipped`);
      continue;
    }

    const c = r.computed.cost;

    // The partition contract: attributed + unattributed IS the window, not a
    // filter of it. Tokens are integers, so this is exact.
    const parts = tokenSum(a.attributed.tokens.by_model) + tokenSum(a.unattributed.tokens.by_model);
    const sessionTokens = r.computed.tokens.grand_total - r.computed.counts.subagent_tokens_grand_total;
    if (parts !== sessionTokens) fail(id, `token partition is not exact: ${parts} != ${sessionTokens}`);
    if (a.attributed.api_calls + a.unattributed.api_calls !== r.computed.counts.api_calls) {
      fail(id, 'api_calls partition does not reconcile');
    }
    if (Math.abs(a.attributed.cost.marginal_usd + a.unattributed.cost.marginal_usd - c.marginal_usd) > COST_EPS) {
      fail(id, 'marginal cost partition does not reconcile');
    }
    if (Math.abs(a.attributed.cost.context_carry_usd + a.unattributed.cost.context_carry_usd - c.context_carry_usd) > COST_EPS) {
      fail(id, 'context carry partition does not reconcile');
    }
    if (c.complete && Math.abs(c.total_usd - (c.marginal_usd + c.context_carry_usd)) > COST_EPS) {
      fail(id, 'total_usd != marginal + carry');
    }

    // The join key must resolve, or be null. A key pointing at a record no
    // reader can open is worse than no key: it invites a silent inner-join drop.
    const owner = a.unattributed_belongs_to_run_id;
    if (owner !== undefined) {
      if (owner !== null && !runIds.has(owner)) fail(id, `unattributed_belongs_to_run_id ${owner} is not a record on disk`);
      if (a.unattributed.api_calls === 0 && owner !== null) fail(id, 'names an owner for a tail that does not exist');
    }

    // Comparability must be derivable from cache_state, never set independently.
    const expected = a.cache_state === null || a.cache_state === undefined ? null : a.cache_state === 'warm';
    if (a.marginal_comparable !== expected) fail(id, `marginal_comparable ${a.marginal_comparable} disagrees with cache_state ${a.cache_state}`);

    if (!c.pricing_version) fail(id, 'missing pricing_version — cost cannot be re-derived');
    if (a.cache_state === 'unknown') notes.push(`${id}: cache_state unknown — not comparable, and worth investigating`);
  }

  // ---- 3. windows must not overlap within a session ------------------------
  // Non-overlap is what guarantees no token is counted twice. Gaps are normal
  // (turns with no skill are not logged); overlaps never are.
  for (const [sid, rs] of bySession) {
    const sorted = [...rs].sort((x, y) => x.run.window.line_from - y.run.window.line_from);
    let prevEnd = null;
    for (const r of sorted) {
      if (prevEnd !== null && r.run.window.line_from < prevEnd) {
        fail(r.run.run_id, `window overlaps the previous record in session ${String(sid).slice(0, 8)} (double-counted tokens)`);
      }
      prevEnd = r.run.window.line_to;
    }
  }

  // ---- report --------------------------------------------------------------
  console.log(`store: ${LOG_DIR}`);
  console.log(`records: ${records.length} (${legacy} pre-attribution) | index lines: ${index.length} | sessions: ${bySession.size}`);
  const comparable = records.filter((r) => r.computed?.attribution?.marginal_comparable === true).length;
  console.log(`comparable for cost KPIs (cache_state warm): ${comparable}/${records.length - legacy}`);
  for (const n of notes) console.log(`  note  ${n}`);
  if (problems.length === 0) {
    console.log('\nOK — all invariants hold.');
    return 0;
  }
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log(`  ${p}`);
  return 1;
}

process.exit(main());
