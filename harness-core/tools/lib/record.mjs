// Run record lifecycle: attempted at init, updated per phase, finalized at end.
// Created FIRST so even a run that dies at minute one leaves a trace (spec §4).
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeRunId } from './runid.mjs';
import { loadSchema, validate } from './validate.mjs';
import { appendAudit, HarnessError } from './audit.mjs';

export const SCHEMA_VERSION = '2.0.0';

// The git checkout that supplies harness-core itself — NOT the target repo.
// record.mjs always lives inside that checkout, so its own directory is the
// right cwd for git even when harness-core is reached via the
// ~/.claude/skills symlink (Node resolves the module to its real path).
const HARNESS_CORE_DIR = dirname(fileURLToPath(import.meta.url));

// Short SHA of harness-core's HEAD, for provenance on every run record.
// Best-effort: any failure (no git binary, no .git, detached with no commit)
// degrades to null and must never throw — a run must not die because it
// couldn't stamp its own version.
export function harnessSha(dir = HARNESS_CORE_DIR) {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim() || null;
  } catch {
    return null;
  }
}

export function initRun({ targetDir, repo, kind, source, issue = null, branch = null, routingPolicy = null, now = new Date(), shaDir = undefined,
  // v2 graft: parent-loop association + cross-phase correlation + provenance.
  // parentRunId is the loop tick's run-id (the pipeline record) — that single id
  // is what joins a loop-driven phase to its tick. All null for a standalone
  // hand-run. (A loop_run_id field used to mirror parentRunId here; it had no
  // reader and was dropped — parent_run_id is the join key.)
  parentRunId = null, correlationId = null, repoPath = null, skillsCommit = null }) {
  // The issue number is already encoded in an issue-N source — derive it so
  // the record never carries issue: null for an issue-sourced run.
  if (issue === null && /^issue-\d+$/.test(source)) issue = source.slice('issue-'.length);
  const harnessDir = join(targetDir, '.harness');
  const runId = makeRunId({ repo, kind, source, now });
  const runDir = join(harnessDir, 'runs', runId);
  for (const d of ['handoffs', 'briefs', 'findings']) mkdirSync(join(runDir, d), { recursive: true });
  ensureGitignore(targetDir);
  const record = {
    run_id: runId,
    parent_run_id: parentRunId,
    correlation_id: correlationId,
    repo,
    repo_path: repoPath,
    branch,
    issue,
    machine: hostname(),
    harness_sha: harnessSha(shaDir),
    skills_commit: skillsCommit,
    kind,
    input_type: source.startsWith('issue-') ? 'issue' : source,
    size: null,
    status: 'attempted',
    reason: null,
    phases: [],
    routing_policy: routingPolicy ?? null,
    wall_ms: null,
    active_ms: null,
    agent_count: null,
    skill_metrics: null,
    started_at: now.toISOString(),
    ended_at: null,
    pr_url: null,
    pr_created_at: null,
    synced_at: null,
    schema_version: SCHEMA_VERSION,
  };
  writeRecord(runDir, record);
  appendAudit(harnessDir, { ts: now.toISOString(), run_id: runId, event: 'run_start', data: { repo, kind, source } });
  return { runId, runDir, harnessDir };
}

export function ensureGitignore(targetDir) {
  const path = join(targetDir, '.gitignore');
  const line = '.harness/';
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (!current.split('\n').includes(line)) {
    appendFileSync(path, (current && !current.endsWith('\n') ? '\n' : '') + line + '\n');
  }
}

export function readRecord(runDir) {
  return JSON.parse(readFileSync(join(runDir, 'record.json'), 'utf8'));
}

// True when a tokens_directional object carries at least one per-model sum.
// Defensive about shape because it is asked about both freshly-built objects
// and whatever an old record on disk happens to hold (including null).
function hasModelSums(tokensDirectional) {
  const byModel = tokensDirectional?.by_model;
  return !!byModel && typeof byModel === 'object' && Object.keys(byModel).length > 0;
}

// Stamp the additive tokens_directional field onto a run record. This is
// strictly additive: it sets only tokens_directional and never touches
// tokens_by_tier or tokens_observed (the two raw token snapshots), so directional
// per-model sums are recorded ALONGSIDE the existing tier totals, never over top
// of them. synced_at is cleared so the enriched record is re-pushed to telemetry.
//
// Clobber guard: phase-end, run-end and tokens-collect each call
// collectAndStamp (record-observed-tokens does NOT — it writes tokens_observed
// only), so one run stamps several times and any single call may have failed to
// resolve a transcript. On the live TARS-1271 run an early call landed
// real per-model sums and a later call landed by_model: {} over the top, so the
// record shipped empty and needed a manual backfill-directional to recover sums
// the harness had already captured. An incoming empty by_model therefore never
// replaces an existing non-empty one — it is a no-op that also leaves synced_at
// alone, because nothing changed and forcing a re-sync of identical bytes is
// pure waste. An incoming non-empty by_model always wins: transcripts only grow,
// so the newest real reading is the most complete one (supersets are expected,
// which is why this replaces rather than merges).
//
// The skip signal rides back as a NON-ENUMERABLE `skipped` property, and the
// defineProperty call is deliberately placed AFTER the write. Two independent
// things keep `skipped` out of record.json, and it is worth being precise about
// which one is doing the work:
//   1. Ordering (what actually protects today). The object handed to writeRecord
//      does not carry `skipped` at all — in the write branch the property is
//      defined afterwards, and in the skip branch writeRecord is never called.
//   2. Non-enumerability (defense in depth, for whoever moves line 1). Both
//      gates walk enumerable keys only: validate.mjs checks
//      additionalProperties via Object.keys, and JSON.stringify skips
//      non-enumerable properties. Verified empirically — an enumerable
//      `skipped` on a record object yields `$: unexpected property "skipped"`
//      from validate(), a non-enumerable one yields no errors. So moving the
//      defineProperty above writeRecord would still be safe as written, but
//      only because of `enumerable: false`; run-record.schema.json is
//      additionalProperties:false and writeRecord throws
//      HarnessError('invalid_record') on an unexpected key.
export function stampTokensDirectional({ runDir, tokensDirectional }) {
  const record = readRecord(runDir);
  const skipped = !hasModelSums(tokensDirectional) && hasModelSums(record.tokens_directional);
  if (!skipped) {
    record.tokens_directional = tokensDirectional;
    record.synced_at = null;
    writeRecord(runDir, record);
  }
  Object.defineProperty(record, 'skipped', { value: skipped, enumerable: false });
  return record;
}

export function writeRecord(runDir, record) {
  const errors = validate(loadSchema('run-record'), record);
  if (errors.length) throw new HarnessError('invalid_record', errors.join('; '));
  writeFileSync(join(runDir, 'record.json'), JSON.stringify(record, null, 2) + '\n');
}

function harnessDirOf(runDir) {
  return dirname(dirname(runDir)); // .harness/runs/<id> → .harness
}

export function phaseEnd({ runDir, phase, status, rounds = null, score = null, reason = null, size = null, now = new Date() }) {
  const record = readRecord(runDir);
  record.phases = record.phases.filter((p) => p.phase !== phase);
  // Phase wall clock runs from the previous phase's end (or the run start for
  // the first phase) — phases are sequential, so the gap between them is real
  // work time and belongs to the phase that just closed.
  const phaseStart = record.phases.reduce(
    (latest, p) => (p.ended_at && p.ended_at > latest ? p.ended_at : latest),
    record.started_at,
  );
  const wallMs = now.getTime() - new Date(phaseStart).getTime();
  // started_at is stamped, not just used to derive wall_ms: a span that carries
  // only an end and a duration forces every reader to re-derive its start, and
  // two readers deriving it differently is how a timeline stops adding up.
  record.phases.push({ phase, status, rounds_used: rounds, verifier_score: score, reason, started_at: phaseStart, ended_at: now.toISOString(), wall_ms: wallMs });
  if (size) record.size = size;
  writeRecord(runDir, record);
  appendAudit(harnessDirOf(runDir), { ts: now.toISOString(), run_id: record.run_id, phase, event: 'phase_end', data: { status, rounds, score, wall_ms: wallMs } });
  return record;
}

// Close a phase span on the PIPELINE record — the loop's own tick record, whose
// `phases` array shipped EMPTY on every run to date. Its 59m59s wall clock had
// no internal structure, so the three child phase runs summing to 54m23s left
// 5m36s of dispatcher hand-off time invisible rather than merely unlabelled.
//
// Deliberately NOT phaseEnd: that function belongs to a phase driver reporting
// its own verifier rounds and score, and its CLI wrapper triggers token
// collection. The loop is reporting elapsed time for a child run it dispatched,
// so a span here carries the child's run id and nothing about tokens or scores.
// Spans chain from the previous span's end (the run start for the first), which
// is what makes them sum to wall clock by construction rather than by luck.
export function pipelinePhase({ runDir, phase, status, childRunId = null, now = new Date() }) {
  const record = readRecord(runDir);
  record.phases = record.phases.filter((p) => p.phase !== phase);
  const startedAt = record.phases.reduce(
    (latest, p) => (p.ended_at && p.ended_at > latest ? p.ended_at : latest),
    record.started_at,
  );
  const wallMs = now.getTime() - new Date(startedAt).getTime();
  record.phases.push({
    phase, status, child_run_id: childRunId,
    started_at: startedAt, ended_at: now.toISOString(), wall_ms: wallMs,
  });
  writeRecord(runDir, record);
  appendAudit(harnessDirOf(runDir), {
    ts: now.toISOString(), run_id: record.run_id, phase, event: 'phase_end',
    data: { status, wall_ms: wallMs, child_run_id: childRunId },
  });
  return record;
}

// Close the span opened by a `spawn` event and write a `spawn_end` carrying the
// subagent's wall time.
//
// Why the harness computes the duration instead of the driver reporting it: a
// subagent's wall time was only ever measurable when its return coincided with
// a `verifier_round` event. Discovery agents emitted a `spawn` and nothing
// else, so on TARS-1272 the 6m32s window after intake's two parallel discovery
// spawns was two agents PLUS driver work, with no way to separate them. Asking
// the driver to subtract two timestamps would put arithmetic in the LLM's hands
// and re-introduce the precision problem; the spawn's own `ts` is already on
// disk, so the deterministic spine does the subtraction.
//
// Returns { matched, wall_ms, spawn_ts }. An unmatched close writes NOTHING and
// does not throw: a driver that emits a spawn_end for an agent it never spawned
// has a bookkeeping bug, and fabricating a duration would hide it — the caller
// reports matched:false and the run continues.
export function spawnEnd({ runDir, agentId, taskType, now = new Date() }) {
  const record = readRecord(runDir);
  const harnessDir = harnessDirOf(runDir);
  const auditPath = join(harnessDir, 'audit.jsonl');
  let lines = [];
  try {
    lines = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { matched: false, wall_ms: null, spawn_ts: null };
  }

  // Walk newest-first and take the first OPEN spawn: a re-spawned agent id (the
  // implement verifier runs as the same logical agent across rounds) must close
  // its latest spawn, not its first, or round 2's duration would absorb round 1
  // and the sum would exceed the phase it sits in.
  let closed = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue; // a torn line is not a spawn we can match
    }
    if (e.run_id !== record.run_id) continue;
    if (e.agent_id !== agentId) continue;
    if (e.data?.task_type !== taskType) continue;
    if (e.event === 'spawn_end') {
      closed += 1;
      continue;
    }
    if (e.event !== 'spawn') continue;
    if (closed > 0) {
      closed -= 1; // this spawn is already accounted for by a later spawn_end
      continue;
    }
    const spawnMs = Date.parse(e.ts);
    if (Number.isNaN(spawnMs)) return { matched: false, wall_ms: null, spawn_ts: null };
    const wallMs = now.getTime() - spawnMs;
    appendAudit(harnessDir, {
      ts: now.toISOString(), run_id: record.run_id, phase: e.phase ?? null, agent_id: agentId,
      event: 'spawn_end',
      data: { task_type: taskType, tier: e.data?.tier ?? null, round: e.data?.round ?? null, wall_ms: wallMs },
    });
    return { matched: true, wall_ms: wallMs, spawn_ts: e.ts };
  }
  return { matched: false, wall_ms: null, spawn_ts: null };
}

export function finalizeRun({ runDir, status, reason = null, wallMs = null, tokensByTier = null, billingMode = null, priceTableVersion = null, now = new Date(),
  // v2 graft: active (gap-capped) time beside wall clock, per-skill perf metrics,
  // and agent counts by model/phase. All optional — omitting leaves prior values.
  activeMs = null, agentCount = null, skillMetrics = null,
  // The delivered artifact and when GitHub created it. Without these,
  // "pipeline start → PR submitted" — the headline number for a harness run —
  // needs a live `gh pr view` join, so it is unanswerable from the sink and
  // unanswerable at all once the PR is gone. A run that opens no PR (any
  // failure, and every intake/plan phase) leaves both null.
  prUrl = null, prCreatedAt = null }) {
  const record = readRecord(runDir);
  record.status = status;
  record.reason = reason;
  record.emit_trigger = 'workflow';
  record.billing_mode = billingMode ?? 'unknown';
  record.price_table_version = priceTableVersion ?? null;
  record.ended_at = now.toISOString();
  record.wall_ms = wallMs !== null ? wallMs : now.getTime() - new Date(record.started_at).getTime();
  if (activeMs !== null) record.active_ms = activeMs;
  if (agentCount !== null) record.agent_count = agentCount;
  if (skillMetrics !== null) record.skill_metrics = skillMetrics;
  if (prUrl !== null) record.pr_url = prUrl;
  if (prCreatedAt !== null) record.pr_created_at = prCreatedAt;
  if (tokensByTier) record.tokens_by_tier = tokensByTier;
  writeRecord(runDir, record);
  appendAudit(harnessDirOf(runDir), { ts: now.toISOString(), run_id: record.run_id, event: 'run_end', data: { status, wall_ms: record.wall_ms } });
  return record;
}

// A driver's own run-end call can only self-report the subagent_tokens of its
// OWN nested spawns (verifier rounds, discovery agents) — tokens_by_tier — it
// has no way to see its own dispatch's total cost from inside its own
// context. Only whoever dispatched it (an orchestrator watching the
// Agent-tool call return) ever observes that total, as a single raw number
// for the whole dispatch at one tier.
//
// This is deliberately additive, not a correction: tokens_by_tier is the
// individual run's own raw report and must keep working standalone, with no
// orchestrator involved, ever. tokens_observed is a second raw snapshot from
// a different vantage point — recorded alongside, never over top of, so
// either level can be inspected independently when debugging. No cost/derived
// math is computed here; that's aggregation work for whoever reads both
// numbers later (harness-core's role is to aggregate and summarize, not to
// bake a computed "final answer" into the individual record).
//
// Can be called at any run lifecycle state (attempted or finalized). An
// orchestrator may observe the Agent-tool return total before the subagent's
// own run-end has completed — for example, on a crashed run — so enforcing
// "finalized only" was too strict and has been removed.
// Sum per-tier subagent-token observations into the tokens_by_tier shape a
// phase-end reports, and author the accompanying tokens note. This is the
// deterministic half of a phase's token accounting: the driver still OBSERVES
// each spawn's raw number from the Agent-tool usage tag (nothing on disk holds
// them, so no script can discover them) and supplies them here as
// {tier, amount, estimated} observations; finalizeTokens only sums and formats.
// Untouched tiers are omitted (never zero-filled). The note's estimated flag is
// true when ANY observation was estimated, false only when every figure was
// platform-reported — the anomalies scan keys off that flag.
export function finalizeTokens(observations = []) {
  const tokens_by_tier = {};
  let anyEstimated = false;
  for (const { tier, amount, estimated } of observations) {
    tokens_by_tier[tier] = (tokens_by_tier[tier] ?? 0) + amount;
    if (estimated) anyEstimated = true;
  }
  return {
    tokens_by_tier,
    estimated: anyEstimated,
    note: { type: 'tokens', estimated: anyEstimated },
  };
}

export function recordObservedTokens({ runDir, total, tier, source = 'agent_tool_usage_tag', now = new Date() }) {
  const record = readRecord(runDir);
  record.tokens_observed = { total, tier, source, observed_at: now.toISOString() };
  // The already-synced copy in telemetry is missing this snapshot — clear
  // synced_at so the next sync (called by the caller, or a later sweep)
  // re-pushes the enriched record instead of skipping it as already done.
  record.synced_at = null;
  writeRecord(runDir, record);
  appendAudit(harnessDirOf(runDir), {
    ts: now.toISOString(),
    run_id: record.run_id,
    event: 'cost_update',
    data: { tokens_observed: record.tokens_observed },
  });
  return record;
}
