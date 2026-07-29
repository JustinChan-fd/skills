import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAgentTree, childrenOf, descendantsOf, driversOf } from '../tools/lib/agent-tree.mjs';

// Mirrors the real shape observed in
// ~/.claude/projects/<munged>/<session>/subagents/agent-<id>.meta.json
function fixture(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-tree-'));
  for (const [id, meta] of Object.entries(spec)) {
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
    writeFileSync(join(dir, `agent-${id}.jsonl`), '');
  }
  return dir;
}

// driver a1 -> {b1, b2}; b1 -> c1. Second driver a2 with no children.
const TREE = {
  a1: { agentType: 'general-purpose', model: 'opus', spawnDepth: 1 },
  a2: { agentType: 'general-purpose', model: 'sonnet', spawnDepth: 1 },
  b1: { agentType: 'hp-researcher', model: 'sonnet', spawnDepth: 2, parentAgentId: 'a1' },
  b2: { agentType: 'hp-architect', model: 'sonnet', spawnDepth: 2, parentAgentId: 'a1' },
  c1: { agentType: 'Explore', model: 'sonnet', spawnDepth: 3, parentAgentId: 'b1' },
};

test('readAgentTree parses every sidecar into AgentMeta', () => {
  const t = readAgentTree(fixture(TREE));
  assert.equal(t.ok, true);
  assert.equal(t.agents.size, 5);
  assert.deepEqual(t.agents.get('b1'), {
    id: 'b1', agentType: 'hp-researcher', model: 'sonnet',
    parentAgentId: 'a1', spawnDepth: 2, description: null,
  });
  assert.equal(t.agents.get('a1').parentAgentId, null);
});

test('childrenOf returns direct children sorted', () => {
  const t = readAgentTree(fixture(TREE));
  assert.deepEqual(childrenOf(t, 'a1'), ['b1', 'b2']);
  assert.deepEqual(childrenOf(t, 'c1'), []);
});

test('descendantsOf includes self first, then transitive descendants', () => {
  const t = readAgentTree(fixture(TREE));
  assert.deepEqual(descendantsOf(t, 'a1'), ['a1', 'b1', 'b2', 'c1']);
  assert.deepEqual(descendantsOf(t, 'b1'), ['b1', 'c1']);
  assert.deepEqual(descendantsOf(t, 'a2'), ['a2']);
});

test('descendantsOf of an unknown id returns just that id', () => {
  const t = readAgentTree(fixture(TREE));
  assert.deepEqual(descendantsOf(t, 'nope'), ['nope']);
});

test('driversOf returns depth-1 agents; subtrees partition the tree', () => {
  const t = readAgentTree(fixture(TREE));
  const drivers = driversOf(t);
  assert.deepEqual(drivers, ['a1', 'a2']);
  // Fact 6: driver subtrees partition the session exactly — no orphans, no overlap.
  const covered = drivers.flatMap((d) => descendantsOf(t, d));
  assert.equal(covered.length, new Set(covered).size, 'no agent counted twice');
  assert.deepEqual([...covered].sort(), [...t.agents.keys()].sort());
});

test('an orphan whose parent is absent from the dir is treated as a driver', () => {
  const t = readAgentTree(fixture({
    x1: { agentType: 'general-purpose', spawnDepth: 2, parentAgentId: 'gone' },
  }));
  assert.deepEqual(driversOf(t), ['x1']);
});

test('a parentAgentId cycle terminates instead of hanging', () => {
  const t = readAgentTree(fixture({
    p: { agentType: 'a', parentAgentId: 'q' },
    q: { agentType: 'b', parentAgentId: 'p' },
  }));
  assert.deepEqual(descendantsOf(t, 'p'), ['p', 'q']);
});

test('a malformed sidecar is skipped, not fatal', () => {
  const dir = fixture({ ok1: { agentType: 'general-purpose' } });
  writeFileSync(join(dir, 'agent-bad.meta.json'), '{ not json');
  const t = readAgentTree(dir);
  assert.equal(t.ok, true);
  assert.equal(t.agents.size, 1);
  assert.equal(t.agents.has('bad'), false);
});

test('a missing directory returns ok:false with not_found, never throws', () => {
  const t = readAgentTree(join(tmpdir(), 'definitely-not-here-9c1f'));
  assert.equal(t.ok, false);
  assert.equal(t.error.code, 'not_found');
  assert.equal(t.agents.size, 0);
});

test('a directory with jsonl but no sidecars returns ok:false no_metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-tree-'));
  writeFileSync(join(dir, 'agent-z9.jsonl'), '');
  const t = readAgentTree(dir);
  assert.equal(t.ok, false);
  assert.equal(t.error.code, 'no_metadata');
  assert.match(t.error.detail, /no agent-\*\.meta\.json sidecars/);
});

test('sidecars that are all unreadable say so instead of claiming none exist', () => {
  // Both routes yield no_metadata, and no consumer branches on a finer code —
  // resolveTranscripts just passes tree.error through. But the DETAIL is what a
  // human reads when directional capture came back empty, and "no sidecars in X"
  // sends them looking for missing files when the files are right there and
  // malformed. Two very different fixes; the message must not conflate them.
  const dir = mkdtempSync(join(tmpdir(), 'agent-tree-'));
  writeFileSync(join(dir, 'agent-z9.meta.json'), '{ this is not json');
  writeFileSync(join(dir, 'agent-z8.meta.json'), 'also not json');
  const t = readAgentTree(dir);
  assert.equal(t.ok, false);
  assert.equal(t.error.code, 'no_metadata');
  assert.match(t.error.detail, /2 .*unreadable|unreadable.*2/,
    `detail must name the unreadable count, got: ${t.error.detail}`);
  assert.doesNotMatch(t.error.detail, /no agent-\*\.meta\.json sidecars/,
    'must not claim there are no sidecars when there are two');
});

test('readAgentTree ignores non-agent files and nested dirs', () => {
  const dir = fixture({ k1: { agentType: 'general-purpose' } });
  writeFileSync(join(dir, 'notes.md'), '# hi');
  mkdirSync(join(dir, 'nested'));
  const t = readAgentTree(dir);
  assert.deepEqual([...t.agents.keys()], ['k1']);
});
