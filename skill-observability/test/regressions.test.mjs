// Regression anchors ported from the alfred/harness suites this tool replaces.
//
// Each test here encodes a defect MEASURED on real transcripts under
// ~/.claude/projects on 2026-08-04, not a hypothetical. The numbers are exact
// on purpose: a 2x accounting error is precisely what an exact-figure anchor
// catches and a "the key exists" structural check does not.
//
// Provenance of each anchor is named in its own comment so a future reader can
// re-derive it rather than trusting this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregate } from '../lib/record.mjs';
import { ratesFor } from '../lib/pricing.mjs';
import { readSubagentDelta } from '../lib/transcript.mjs';

// ---------------------------------------------------------------------------
// 1. message.id dedupe.
//
// MEASURED: across the 25 most recent real transcripts, 6,222 of 11,805
// usage-bearing rows re-used an already-seen message.id. Summing per row gives
// 1,528,547,090 tokens; deduping by message.id gives 728,786,873 — a 2.097x
// overcount. This is the same defect recorded in project_cost_accounting
// ("figures ~2.2x INFLATED by a message.id dedupe bug").
//
// 2,946 of those duplicate rows carried NONZERO tokens, so the surviving row
// cannot be "the first" or "the last" — the duplicates are not identical, and a
// zeroed duplicate is a truncated record of a real call, never a second free
// call. Keep the MAX per direction, as alfred/lib/tokens.mjs:198 does.
// ---------------------------------------------------------------------------

function row(id, tokens, overrides = {}) {
  return {
    source: 'session',
    model: 'claude-sonnet-5',
    timestamp: '2026-08-04T10:00:00.000Z',
    message_id: id,
    usage: {
      input_tokens: tokens.input ?? 0,
      output_tokens: tokens.output ?? 0,
      cache_read_input_tokens: tokens.cache_read ?? 0,
      cache_creation_input_tokens: tokens.cache_creation ?? 0,
      ...overrides,
    },
  };
}

test('two rows sharing one message.id count ONCE, not twice', () => {
  const dup = [
    row('msg_aaa', { input: 10, output: 100, cache_read: 1000 }),
    row('msg_aaa', { input: 10, output: 100, cache_read: 1000 }),
  ];
  const b = aggregate(dup).tokens.by_model['claude-sonnet-5'];
  assert.equal(b.input, 10, 'input must not double');
  assert.equal(b.output, 100, 'output must not double');
  assert.equal(b.cache_read, 1000, 'cache_read must not double');
});

test('a zeroed duplicate is a truncated record — the LARGER row survives', () => {
  // Order must not matter: the truncated row appearing second must not win.
  const zeroLast = [
    row('msg_bbb', { input: 10, output: 100, cache_read: 1000 }),
    row('msg_bbb', { input: 0, output: 0, cache_read: 0 }),
  ];
  const zeroFirst = [
    row('msg_ccc', { input: 0, output: 0, cache_read: 0 }),
    row('msg_ccc', { input: 10, output: 100, cache_read: 1000 }),
  ];
  for (const [label, rows] of [['zero last', zeroLast], ['zero first', zeroFirst]]) {
    const b = aggregate(rows).tokens.by_model['claude-sonnet-5'];
    assert.equal(b.output, 100, `${label}: the real row's tokens must survive`);
  }
});

test('partial duplicates keep the max per direction, not the first seen', () => {
  // Measured shape: duplicate rows disagree rather than being identical.
  const rows = [
    row('msg_ddd', { input: 10, output: 50, cache_read: 900 }),
    row('msg_ddd', { input: 10, output: 100, cache_read: 1000 }),
  ];
  const b = aggregate(rows).tokens.by_model['claude-sonnet-5'];
  assert.equal(b.output, 100, 'the larger output must win');
  assert.equal(b.cache_read, 1000, 'the larger cache_read must win');
});

test('rows with NO message.id are never collapsed together', () => {
  // A missing id must not become a shared dedupe key — that swaps a 2x
  // overcount for a silent undercount (alfred/lib/tokens.mjs:91,106).
  const rows = [
    row(undefined, { input: 10, output: 100 }),
    row(undefined, { input: 10, output: 100 }),
  ];
  const b = aggregate(rows).tokens.by_model['claude-sonnet-5'];
  assert.equal(b.input, 20, 'two id-less rows are two distinct calls');
  assert.equal(b.output, 200);
});

test('api_calls counts DEDUPLICATED calls, so cost-per-call stays honest', () => {
  const rows = [
    row('msg_eee', { input: 10, output: 100 }),
    row('msg_eee', { input: 10, output: 100 }),
    row('msg_fff', { input: 10, output: 100 }),
  ];
  const b = aggregate(rows).tokens.by_model['claude-sonnet-5'];
  assert.equal(b.api_calls, 2, 'three rows, two real calls');
});

test('dedupe is per message.id, NOT global — distinct ids all count', () => {
  // Guard against an over-broad fix that collapses everything.
  const rows = [
    row('msg_1', { input: 10, output: 100 }),
    row('msg_2', { input: 10, output: 100 }),
    row('msg_3', { input: 10, output: 100 }),
  ];
  const b = aggregate(rows).tokens.by_model['claude-sonnet-5'];
  assert.equal(b.input, 30, 'three distinct ids are three calls');
});

// ---------------------------------------------------------------------------
// 2. Nested subagent discovery.
//
// MEASURED on disk: 605 agent transcripts sit flat in subagents/ and 5,176 sit
// in subagents/workflows/<wf_id>/. A flat readdirSync sees 89.5% of files not
// at all — 63,137 usage-bearing API calls, silently, with no error raised.
//
// THE TRAP (from docs/superpowers/plans/2026-08-03-alfred-minimal-03-discovery):
// recursing on *.jsonl swallows journal.jsonl — 196 of them on this disk, with
// ZERO usage fields. Each would become a phantom zero-token agent, replacing an
// undercount with an overcount while looking fixed. Filter on the `agent-`
// filename PREFIX, which is the actual convention; the .jsonl extension is a
// coincidence journal.jsonl happens to share.
// ---------------------------------------------------------------------------

function usageLine(model, tokens) {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'u1',
    timestamp: '2026-08-04T10:00:30.000Z',
    isSidechain: true,
    message: { role: 'assistant', id: `mid-${Math.abs(tokens)}`, model, usage: { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) + '\n';
}

function sessionTree() {
  const root = mkdtempSync(join(tmpdir(), 'skill-obs-nested-'));
  const subs = join(root, 'subagents');
  const wf = join(subs, 'workflows', 'wf_abc123');
  mkdirSync(wf, { recursive: true });

  writeFileSync(join(subs, 'agent-flat1.jsonl'), usageLine('claude-sonnet-5', 11));
  writeFileSync(join(subs, 'agent-flat1.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_flat' }));

  writeFileSync(join(wf, 'agent-nested1.jsonl'), usageLine('claude-sonnet-5', 22));
  writeFileSync(join(wf, 'agent-nested1.meta.json'), JSON.stringify({ agentType: 'workflow', toolUseId: 'toolu_nested' }));
  writeFileSync(join(wf, 'agent-nested2.jsonl'), usageLine('claude-sonnet-5', 33));

  // The trap: bookkeeping, no usage fields. Must contribute nothing.
  writeFileSync(
    join(wf, 'journal.jsonl'),
    JSON.stringify({ type: 'started', key: 'v2:abc', agentId: 'a1' }) + '\n' +
      JSON.stringify({ type: 'finished', key: 'v2:abc', agentId: 'a1' }) + '\n',
  );
  return root;
}

test('nested workflow agent transcripts are discovered, not silently skipped', () => {
  const { agents } = readSubagentDelta(sessionTree(), {});
  const files = agents.map((a) => a.file).sort();
  assert.ok(files.some((f) => f.includes('agent-flat1')), 'flat agent still found');
  assert.ok(files.some((f) => f.includes('agent-nested1')), 'nested workflow agent must be found');
  assert.ok(files.some((f) => f.includes('agent-nested2')), 'all nested agents must be found');
  assert.equal(agents.length, 3, 'exactly 3 agents — flat + 2 nested');
});

test('journal.jsonl is NOT counted as a phantom zero-token agent', () => {
  const { agents } = readSubagentDelta(sessionTree(), {});
  assert.ok(
    !agents.some((a) => a.file.includes('journal')),
    'journal.jsonl carries no usage; counting it replaces an undercount with an overcount',
  );
});

test('nested agent tokens reach the aggregate — the 89.5% blind spot closes', () => {
  const { agents } = readSubagentDelta(sessionTree(), {});
  const all = agents.flatMap((a) => a.usage_entries);
  const b = aggregate(all).tokens.by_model['claude-sonnet-5'];
  assert.equal(b.input, 11 + 22 + 33, 'flat AND nested spend must both be counted');
});

test('nested agents keep their meta sidecar (agent_type / tool_use_id survive)', () => {
  const { agents } = readSubagentDelta(sessionTree(), {});
  const nested = agents.find((a) => a.file.includes('agent-nested1'));
  assert.equal(nested.meta?.toolUseId, 'toolu_nested', 'meta.json must resolve for nested agents too');
});

test('cursors are keyed so a nested and a flat agent never share an entry', () => {
  // Measured: 0 basename collisions WITHIN any single session (6 exist across
  // sessions, but cursors are per-session). Re-firing must yield no new spend.
  const root = sessionTree();
  const first = readSubagentDelta(root, {});
  const second = readSubagentDelta(root, first.nextCursors);
  const newSpend = second.agents.flatMap((a) => a.usage_entries);
  assert.equal(newSpend.length, 0, 'a second firing over unchanged files adds nothing');
});

// ---------------------------------------------------------------------------
// 3. Per-entry `speed`, not session-global.
//
// record.mjs:94 assigned `speedSeen` once per aggregate() and applied it to
// every model. A session mixing one fast Opus call with standard Sonnet calls
// priced ALL of it at fast rates. Opus 5 fast is $10/$50 vs standard $5/$25 —
// a 2x error on the wrong model.
// ---------------------------------------------------------------------------

// NOTE ON AN EARLIER FALSE PASS: the first version of this test put the fast
// call and the standard call on DIFFERENT models. It passed against the unfixed
// code, because cost is bucketed per model — so per-model bucketing masked the
// session-global variable entirely. The defect is only reachable when both
// calls land in the SAME bucket. A green test proved the guard could not fire,
// not that the code was right (feedback_unfalsifiable_conjunct).
test('a fast call does not reprice standard calls of the SAME model', () => {
  const mk = (id, speed) => ({
    source: 'session',
    model: 'claude-opus-5',
    timestamp: '2026-08-04T10:00:00.000Z',
    message_id: id,
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...(speed ? { speed } : {}),
    },
  });

  // 1M fast @ $10/Mtok + 1M standard @ $5/Mtok = $15.00.
  // The unfixed code priced BOTH at fast and reported $20.00.
  const mixed = aggregate([mk('m1', 'fast'), mk('m2', null)]);
  assert.equal(mixed.cost.by_model['claude-opus-5'].usd, 15, 'mixed fast+standard must be 10 + 5, not 10 + 10');

  // Order must not decide the rate either.
  const reversed = aggregate([mk('m2', null), mk('m1', 'fast')]);
  assert.equal(reversed.cost.by_model['claude-opus-5'].usd, 15, 'rate must not depend on row order');

  // And an all-standard window must be untouched by the fix.
  const allStandard = aggregate([mk('m1', null), mk('m2', null)]);
  assert.equal(allStandard.cost.by_model['claude-opus-5'].usd, 10, '2M standard Opus 5 input = $10.00');
});

test('ratesFor still honours an explicit per-call speed override', () => {
  // Pin the rate table itself so a pricing edit cannot silently move history.
  assert.equal(ratesFor('claude-opus-5', { speed: 'fast' }).input_per_mtok, 10);
  assert.equal(ratesFor('claude-opus-5', {}).input_per_mtok, 5);
  assert.equal(ratesFor('claude-sonnet-5', { at: '2026-08-04T00:00:00Z' }).variant, 'introductory');
  assert.equal(ratesFor('claude-sonnet-5', { at: '2026-09-30T00:00:00Z' }).variant, 'standard');
});

// ---------------------------------------------------------------------------
// 4. A zero-token bucket must not nullify real cost.
//
// MEASURED across all 434 session transcripts: 72,636 usage rows carry 8 distinct
// model ids. Seven are priced. The eighth is `<synthetic>` — 73 rows, stop_reason
// "stop_sequence", and every token field ZERO. It is a harness-generated
// placeholder, not an API call.
//
// Because it matched no pricing prefix, `cost.complete` went false and
// `total_usd` went null for the WHOLE corpus: 4,471,414,795 real tokens priced
// at nothing, because 73 empty rows were "an unknown model". The tool's headline
// output was unavailable on every real session on this machine, and 31 green
// tests did not say so — every test fed it only ids the table knows.
//
// 0 tokens x any rate = 0, so charging it zero is arithmetic, not a guess. The
// unknown-model guard must survive intact for the case it was written for.
// ---------------------------------------------------------------------------

test('a zero-token unpriced bucket costs 0 and does NOT null the total', () => {
  const real = {
    source: 'session', model: 'claude-opus-5', timestamp: '2026-08-04T10:00:00.000Z', message_id: 'r1',
    usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
  const synthetic = {
    source: 'session', model: '<synthetic>', timestamp: '2026-08-04T10:00:01.000Z', message_id: 's1',
    stop_reason: 'stop_sequence',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
  const agg = aggregate([real, synthetic]);
  assert.equal(agg.cost.total_usd, 5, '1M Opus 5 input = $5.00; an empty placeholder must not erase it');
  assert.equal(agg.cost.complete, true, 'nothing priceable is missing — completeness must hold');
  assert.equal(agg.cost.by_model['<synthetic>'].usd, 0, 'zero tokens cost zero, not null');
  assert.ok(
    !agg.notes.some((n) => n.code === 'unknown_model_pricing'),
    'an empty bucket is not a pricing gap; a note here would cry wolf on every real session',
  );
});

test('an unknown model WITH tokens still nulls the total — the guard survives', () => {
  // The falsifier for the fix above. If this goes green-by-accident the fix has
  // eaten the guard it was supposed to leave alone, and a genuinely unpriced
  // model would be silently charged $0 instead of refusing to guess.
  const agg = aggregate([{
    source: 'session', model: 'claude-future-9', timestamp: '2026-08-04T10:00:00.000Z', message_id: 'f1',
    usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }]);
  assert.equal(agg.cost.total_usd, null, 'real tokens on an unpriced model must refuse a number');
  assert.equal(agg.cost.complete, false);
  assert.equal(agg.cost.by_model['claude-future-9'].usd, null);
  assert.ok(agg.notes.some((n) => n.code === 'unknown_model_pricing'), 'and it must say why');
});

// ---------------------------------------------------------------------------
// 5. Nested discovery against a REAL session tree.
//
// Section 2 above tests the recursion with a fixture I hand-wrote — which means
// it can only prove the code does what I already believed. This section runs the
// same code over transcripts copied from an actual workflow session on this
// machine (catalog-ui-management, 2026-07), so the shape is the harness's, not
// mine: 11 flat agents, 13 under subagents/workflows/wf_a52a4127-2d7/, and one
// journal.jsonl beside them.
//
// The fixture keeps ONLY usage-bearing scalars — type, uuid, timestamp,
// isSidechain, message.{id,model,usage} — and the two meta fields. No content
// blocks, no tool inputs, no prose, no paths. Verified to reproduce the live
// tree's figures exactly before being committed.
//
// MEASURED on both the live tree and this fixture:
//   flat only : 11 files, 484 rows, 21,567,029 tokens, $13.882271, 268 calls
//   nested    : 13 files, 151 rows,  3,228,321 tokens,  $1.566188,  71 calls
//   all       : 24 files, 635 rows, 24,795,350 tokens, $15.448458, 339 calls
//   journal   :  1 file,    0 rows,          0 tokens
// A flat readdirSync sees 87.0% of the tokens in this one session and loses
// $1.57 with no error raised.
// ---------------------------------------------------------------------------

const REAL_TREE = new URL('./fixtures/nested-real/', import.meta.url).pathname;

test('a real workflow session yields all 24 agents — 11 flat AND 13 nested', () => {
  const { agents } = readSubagentDelta(REAL_TREE, {});
  assert.equal(agents.length, 24, 'the harness put 13 of these under workflows/; a flat readdir finds 11');
  const nested = agents.filter((a) => a.file.includes('workflows/'));
  assert.equal(nested.length, 13, 'every nested agent must be found');
  assert.ok(
    nested.every((a) => a.file.startsWith('workflows/wf_')),
    'nested cursor keys must be paths relative to subagents/, not bare basenames',
  );
});

test('the real tree reconciles to its MEASURED token and cost totals', () => {
  const { agents } = readSubagentDelta(REAL_TREE, {});
  const agg = aggregate(agents.flatMap((a) => a.usage_entries));
  // Exact figures, not "> 0": a 13% undercount is precisely what an exact
  // anchor catches and a truthiness check waves through.
  assert.equal(agg.tokens.grand_total, 24_795_350, 'flat-only would report 21,567,029');
  assert.equal(agg.cost.total_usd, 15.448458, 'flat-only would report $13.882271 — $1.57 lost');
  assert.equal(agg.api_calls, 339, 'flat-only would report 268');
  assert.equal(agg.cost.complete, true, 'a real session must price completely');
  assert.deepEqual(agg.notes, [], 'and degrade in no way at all');
});

test('the real tree carries a journal.jsonl and it contributes nothing', () => {
  const { agents } = readSubagentDelta(REAL_TREE, {});
  assert.ok(
    !agents.some((a) => a.file.includes('journal')),
    'journal.jsonl sits in the same dir as 13 real agents; taking every *.jsonl swallows it',
  );
  // The falsifier for the filter: if journal were admitted it would add a
  // 25th zero-token agent, so the count above is what proves the exclusion.
  assert.equal(agents.length, 24, 'not 25');
});

// Sidecar resolution is keyed off f.path, so a nested agent's meta.json is read
// from workflows/<wf_id>/ rather than from sessionDir/subagents/. Asserting on
// agentType (not toolUseId) because the real data says workflow subagents carry
// NO toolUseId — they are spawned by the workflow runtime, not by an Agent
// tool_use block, so there is no tool call to join back to. Flat agents in this
// same tree DO carry one; that asymmetry is the shape, not a gap.
test('real nested agents keep their meta sidecars from the workflows/ subdir', () => {
  const { agents } = readSubagentDelta(REAL_TREE, {});
  const nested = agents.filter((a) => a.file.includes('workflows/'));
  assert.equal(nested.length, 13);
  const resolved = nested.filter((a) => a.meta && a.meta.agentType === 'workflow-subagent');
  assert.equal(resolved.length, 13, 'sidecars must resolve next to the transcript, not next to sessionDir');
  assert.ok(nested.every((a) => a.meta.spawnDepth === 1));
  // The join key genuinely absent for workflow agents — recorded so a future
  // change that starts populating it is a visible, deliberate change.
  assert.ok(nested.every((a) => a.meta.toolUseId === undefined));
  // Contrast: flat Agent-tool spawns in the same session DO have the join key.
  const flat = agents.filter((a) => !a.file.includes('/'));
  assert.equal(flat.length, 11);
  assert.ok(flat.every((a) => typeof a.meta?.toolUseId === 'string'));
});

test('re-firing over the real tree adds no spend — cursors hold at scale', () => {
  const first = readSubagentDelta(REAL_TREE, {});
  const second = readSubagentDelta(REAL_TREE, first.nextCursors);
  assert.equal(second.agents.flatMap((a) => a.usage_entries).length, 0, '24 agents, second pass, zero new rows');
  assert.equal(Object.keys(first.nextCursors).length, 24, 'one cursor per agent, no collisions across dirs');
});
