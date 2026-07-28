import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { initRun, readRecord, phaseEnd, finalizeRun, recordObservedTokens, finalizeTokens } from '../tools/lib/record.mjs';

const NOW = new Date('2026-07-24T18:30:12Z');

function freshRun() {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-target-'));
  return { targetDir, ...initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'issue-123', issue: '123', branch: 'main', now: NOW }) };
}

test('initRun stamps the current SCHEMA_VERSION (2.0.0)', async () => {
  const { SCHEMA_VERSION } = await import('../tools/lib/record.mjs');
  assert.equal(SCHEMA_VERSION, '2.0.0');
  const { runDir } = freshRun();
  assert.equal(readRecord(runDir).schema_version, '2.0.0');
});

test('initRun creates layout, gitignore entry, attempted record, run_start audit', () => {
  const { targetDir, runId, runDir, harnessDir } = freshRun();
  for (const d of ['handoffs', 'briefs', 'findings']) assert.ok(existsSync(join(runDir, d)));
  assert.ok(readFileSync(join(targetDir, '.gitignore'), 'utf8').split('\n').includes('.harness/'));
  const record = readRecord(runDir);
  assert.equal(record.status, 'attempted');
  assert.equal(record.run_id, runId);
  assert.equal(record.input_type, 'issue');
  assert.equal(record.synced_at, null);
  const audit = readFileSync(join(harnessDir, 'audit.jsonl'), 'utf8');
  assert.ok(audit.includes('"run_start"'));
});

test('initRun derives the issue number from an issue-N source when --issue is omitted', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-target-'));
  const { runDir } = initRun({ targetDir, repo: 'myapp', kind: 'implement', source: 'issue-42', now: NOW });
  assert.equal(readRecord(runDir).issue, '42');
  const { runDir: adhocDir } = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: new Date(NOW.getTime() + 1000) });
  assert.equal(readRecord(adhocDir).issue, null);
});

test('initRun does not duplicate the gitignore line', () => {
  const { targetDir } = freshRun();
  initRun({ targetDir, repo: 'myapp', kind: 'plan', source: 'adhoc', now: new Date('2026-07-24T19:00:00Z') });
  const lines = readFileSync(join(targetDir, '.gitignore'), 'utf8').split('\n').filter((l) => l === '.harness/');
  assert.equal(lines.length, 1);
});

test('phaseEnd upserts phase and size; finalizeRun sets status and ended_at', () => {
  const { runDir } = freshRun();
  phaseEnd({ runDir, phase: 'intake', status: 'succeeded', rounds: 2, score: 0.9, size: 'M', now: NOW });
  phaseEnd({ runDir, phase: 'intake', status: 'succeeded', rounds: 3, score: 0.95, now: NOW });
  let record = readRecord(runDir);
  assert.equal(record.phases.length, 1);
  assert.equal(record.phases[0].rounds_used, 3);
  assert.equal(record.size, 'M');
  record = finalizeRun({ runDir, status: 'succeeded', wallMs: 61000, tokensByTier: { LOW: 100 }, cost: 0.2, now: NOW });
  assert.equal(record.status, 'succeeded');
  assert.equal(record.ended_at, NOW.toISOString());
});

test('phaseEnd stamps ended_at and wall_ms from run start; later phases measure from the previous phase end', () => {
  const { runDir } = freshRun(); // started_at = NOW
  const t1 = new Date(NOW.getTime() + 90_000);
  phaseEnd({ runDir, phase: 'intake', status: 'succeeded', rounds: 1, score: 0.9, now: t1 });
  let record = readRecord(runDir);
  assert.equal(record.phases[0].ended_at, t1.toISOString());
  assert.equal(record.phases[0].wall_ms, 90_000);

  const t2 = new Date(NOW.getTime() + 150_000);
  phaseEnd({ runDir, phase: 'plan', status: 'succeeded', rounds: 1, score: 0.9, now: t2 });
  record = readRecord(runDir);
  const plan = record.phases.find((p) => p.phase === 'plan');
  assert.equal(plan.wall_ms, 60_000); // measured from intake's ended_at, not run start
});

test('phaseEnd re-run (upsert) re-measures from the previous OTHER phase, not its own old entry', () => {
  const { runDir } = freshRun();
  phaseEnd({ runDir, phase: 'intake', status: 'failed', rounds: 1, score: 0.4, now: new Date(NOW.getTime() + 30_000) });
  phaseEnd({ runDir, phase: 'intake', status: 'succeeded', rounds: 2, score: 0.9, now: new Date(NOW.getTime() + 80_000) });
  const record = readRecord(runDir);
  assert.equal(record.phases.length, 1);
  assert.equal(record.phases[0].wall_ms, 80_000); // from run start — its own earlier entry was replaced
});

test('finalizeRun computes wall_ms from started_at when not supplied', () => {
  const { runDir } = freshRun();
  const record = finalizeRun({ runDir, status: 'succeeded', now: new Date(NOW.getTime() + 42_000) });
  assert.equal(record.wall_ms, 42_000);
});

test('finalizeRun computes estimated_cost bounds from tokens and a price table', () => {
  const { runDir } = freshRun();
  const record = finalizeRun({
    runDir, status: 'succeeded', now: NOW,
    tokensByTier: { LOW: 1_000_000, HIGH: 2_000_000 },
    prices: { LOW: { in: 1, out: 5 }, MID: { in: 3, out: 15 }, HIGH: { in: 5, out: 25 } },
  });
  // lo = all-input pricing: 1*1 + 2*5 = 11; hi = all-output: 1*5 + 2*25 = 55; mid = 33
  assert.deepEqual(record.estimated_cost, { lo: 11, mid: 33, hi: 55 });
});

test('finalizeRun leaves estimated_cost null when tokens are absent', () => {
  const { runDir } = freshRun();
  const record = finalizeRun({
    runDir, status: 'succeeded', now: NOW,
    prices: { LOW: { in: 1, out: 5 } },
  });
  assert.equal(record.estimated_cost, null);
});

test('finalizeRun honors an explicit wallMs and records tokens/cost', () => {
  const { runDir } = freshRun();
  const record = finalizeRun({ runDir, status: 'succeeded', wallMs: 61_000, tokensByTier: { HIGH: 65_243 }, cost: 0.9, now: NOW });
  assert.equal(record.wall_ms, 61_000);
  assert.equal(record.tokens_by_tier.HIGH, 65_243);
  assert.equal(record.estimated_cost, 0.9);
});

test('finalizeRun with structured reason validates against schema', () => {
  const { runDir } = freshRun();
  const record = finalizeRun({
    runDir, status: 'failed',
    reason: { code: 'cost_ceiling', detail: 'ceiling 5 exceeded', phase: 'intake', agent: null },
    now: NOW,
  });
  assert.equal(record.reason.code, 'cost_ceiling');
});

test('writeRecord refuses an invalid record', () => {
  const { runDir } = freshRun();
  assert.throws(() => finalizeRun({ runDir, status: 'exploded', now: NOW }), /invalid_record|not in enum/);
});

test('finalizeRun stamps metrics provenance: emit_trigger, billing_mode, price_table_version', () => {
  const { runDir } = freshRun();
  const record = finalizeRun({
    runDir, status: 'succeeded', now: NOW,
    billingMode: 'subscription', priceTableVersion: '2026-07-24.1',
  });
  assert.equal(record.emit_trigger, 'workflow');
  assert.equal(record.billing_mode, 'subscription');
  assert.equal(record.price_table_version, '2026-07-24.1');
});

test('finalizeRun defaults billing_mode to unknown and price_table_version to null', () => {
  const { runDir } = freshRun();
  const record = finalizeRun({ runDir, status: 'succeeded', now: NOW });
  assert.equal(record.billing_mode, 'unknown');
  assert.equal(record.price_table_version, null);
});

test('forced failure: malformed price tables never fail a run finalize', () => {
  // Constraint: metrics enrichment must never fail the run. Garbage prices of
  // any shape → run still finalizes, estimated_cost stays null.
  for (const prices of ['garbage', { MID: 'x' }, { MID: { in: 'x', out: 15 } }, { MID: { in: NaN, out: 15 } }]) {
    const { runDir } = freshRun();
    const record = finalizeRun({ runDir, status: 'succeeded', now: NOW, tokensByTier: { MID: 1_000_000 }, prices });
    assert.equal(record.status, 'succeeded');
    assert.equal(record.estimated_cost, null);
  }
});

test('initRun stamps harness_sha equal to git rev-parse --short HEAD of the harness-core checkout', () => {
  const { runDir } = freshRun();
  // The harness-core checkout is wherever this test file lives (…/harness-core/test).
  const coreDir = dirname(fileURLToPath(import.meta.url));
  const expected = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: coreDir }).toString().trim();
  assert.equal(readRecord(runDir).harness_sha, expected);
});

test('initRun degrades harness_sha to null (no throw) when run outside a git checkout', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'harness-target-'));
  const noGitDir = mkdtempSync(join(tmpdir(), 'harness-nogit-')); // a bare temp dir, no .git
  const { runDir } = initRun({ targetDir, repo: 'myapp', kind: 'intake', source: 'adhoc', now: NOW, shaDir: noGitDir });
  assert.equal(readRecord(runDir).harness_sha, null);
});

test('pre-harness_sha records (schema_version 1.2.0, no harness_sha) still validate', async () => {
  const { loadSchema, validate } = await import('../tools/lib/validate.mjs');
  const { runDir } = freshRun();
  const old = readRecord(runDir);
  old.schema_version = '1.2.0';
  delete old.harness_sha;
  assert.deepEqual(validate(loadSchema('run-record'), old), []);
});

test('pre-metrics records (schema_version 1.0.0, no metrics fields) still validate', async () => {
  const { loadSchema, validate } = await import('../tools/lib/validate.mjs');
  const { runDir } = freshRun();
  const old = readRecord(runDir);
  old.schema_version = '1.0.0';
  delete old.emit_trigger;
  delete old.billing_mode;
  delete old.price_table_version;
  assert.deepEqual(validate(loadSchema('run-record'), old), []);
});

test('pre-tokens_observed records (schema_version 1.1.0, no tokens_observed) still validate', async () => {
  const { loadSchema, validate } = await import('../tools/lib/validate.mjs');
  const { runDir } = freshRun();
  const old = readRecord(runDir);
  old.schema_version = '1.1.0';
  delete old.tokens_observed;
  assert.deepEqual(validate(loadSchema('run-record'), old), []);
});

test('initRun defaults tokens_observed to null', () => {
  const { runDir } = freshRun();
  assert.equal(readRecord(runDir).tokens_observed, null);
});

test('pre-routing_policy records (schema_version 1.4.0, no routing_policy) still validate', async () => {
  const { loadSchema, validate } = await import('../tools/lib/validate.mjs');
  const { runDir } = freshRun();
  const old = readRecord(runDir);
  old.schema_version = '1.4.0';
  delete old.routing_policy;
  assert.deepEqual(validate(loadSchema('run-record'), old), []);
});

test('initRun defaults routing_policy to null', () => {
  const { runDir } = freshRun();
  assert.equal(readRecord(runDir).routing_policy, null);
});

test('recordObservedTokens refuses a run that never finalized (still attempted)', () => {
  const { runDir } = freshRun();
  assert.throws(() => recordObservedTokens({ runDir, total: 500, tier: 'MID' }), /invalid_record|not been finalized/);
});

test("recordObservedTokens adds the orchestrator's total ALONGSIDE the driver's own tokens_by_tier, without touching it", () => {
  const { runDir, harnessDir } = freshRun();
  // The driver could only see its own nested verifier spawn (65k) — not its
  // own dispatch's true total (105,779), which only the orchestrator, having
  // watched the Agent-tool call return, ever observes. Both are real,
  // independently useful numbers for debugging at either level, so neither
  // should erase the other.
  finalizeRun({ runDir, status: 'succeeded', tokensByTier: { MID: 65_000 }, now: NOW });
  const record = recordObservedTokens({
    runDir, total: 105_779, tier: 'MID', source: 'agent_tool_usage_tag',
    now: new Date(NOW.getTime() + 1000),
  });
  assert.deepEqual(record.tokens_by_tier, { MID: 65_000 }); // untouched
  assert.deepEqual(record.tokens_observed, {
    total: 105_779, tier: 'MID', source: 'agent_tool_usage_tag',
    observed_at: new Date(NOW.getTime() + 1000).toISOString(),
  });
  assert.equal(record.synced_at, null); // cleared so the next sync picks up the added snapshot
  const audit = readFileSync(join(harnessDir, 'audit.jsonl'), 'utf8');
  assert.ok(audit.includes('"cost_update"'));
  assert.ok(audit.includes('105779'));
});

test('recordObservedTokens defaults source to agent_tool_usage_tag', () => {
  const { runDir } = freshRun();
  finalizeRun({ runDir, status: 'succeeded', tokensByTier: { LOW: 100 }, now: NOW });
  const record = recordObservedTokens({ runDir, total: 72_000, tier: 'HIGH' });
  assert.equal(record.tokens_observed.source, 'agent_tool_usage_tag');
});

test('recordObservedTokens does not compute or touch estimated_cost — that stays derived from tokens_by_tier only', () => {
  const { runDir } = freshRun();
  finalizeRun({
    runDir, status: 'succeeded', tokensByTier: { MID: 1000 }, now: NOW,
    prices: { MID: { in: 3, out: 15 } },
  });
  const before = readRecord(runDir).estimated_cost;
  const record = recordObservedTokens({ runDir, total: 999_999, tier: 'MID' });
  assert.deepEqual(record.estimated_cost, before);
});

test('recordObservedTokens clears a prior synced_at so the enriched record is picked up for re-sync', () => {
  const { runDir } = freshRun();
  finalizeRun({ runDir, status: 'succeeded', tokensByTier: { MID: 1000 }, now: NOW });
  const record = readRecord(runDir);
  record.synced_at = NOW.toISOString(); // simulate a prior successful sync
  writeFileSync(join(runDir, 'record.json'), JSON.stringify(record));
  const patched = recordObservedTokens({ runDir, total: 2000, tier: 'MID' });
  assert.equal(patched.synced_at, null);
});

// ---------------------------------------------------------------------------
// u5 — finalizeTokens: sum per-tier subagent-token observations into the exact
// tokens_by_tier shape (untouched tiers omitted) and author the tokens note,
// replacing the hand-done phase-end sum + note authoring in the phase skills.
// ---------------------------------------------------------------------------

test('finalizeTokens sums per tier, omits untouched tiers, estimated:false when all platform-reported', () => {
  const r = finalizeTokens([
    { tier: 'MID', amount: 61_269, estimated: false },
    { tier: 'HIGH', amount: 200_000, estimated: false },
  ]);
  assert.deepEqual(r.tokens_by_tier, { MID: 61_269, HIGH: 200_000 });
  assert.ok(!('LOW' in r.tokens_by_tier), 'untouched tiers are omitted');
  assert.equal(r.estimated, false);
  assert.deepEqual(r.note, { type: 'tokens', estimated: false });
});

test('finalizeTokens returns estimated:true and a tokens note with estimated:true when ANY observation is estimated', () => {
  const r = finalizeTokens([
    { tier: 'LOW', amount: 10_000, estimated: true },
    { tier: 'MID', amount: 61_269, estimated: false },
  ]);
  assert.deepEqual(r.tokens_by_tier, { LOW: 10_000, MID: 61_269 });
  assert.equal(r.estimated, true);
  assert.deepEqual(r.note, { type: 'tokens', estimated: true });
});

test('finalizeTokens sums repeated observations for the same tier', () => {
  const r = finalizeTokens([
    { tier: 'MID', amount: 100, estimated: false },
    { tier: 'MID', amount: 250, estimated: false },
    { tier: 'MID', amount: 50, estimated: true },
  ]);
  assert.deepEqual(r.tokens_by_tier, { MID: 400 });
  assert.equal(r.estimated, true); // one of the three was estimated
});

test('finalizeTokens on zero observations yields an empty tokens_by_tier and estimated:false', () => {
  const r = finalizeTokens([]);
  assert.deepEqual(r.tokens_by_tier, {});
  assert.equal(r.estimated, false);
});
