/**
 * Read the subagent delegation tree for one Claude Code session.
 *
 * Every subagent transcript at <subagentsDir>/agent-<id>.jsonl has a sibling
 * <subagentsDir>/agent-<id>.meta.json written by the harness's host CLI:
 *
 *   {"agentType":"client_unit_test_writer","description":"...",
 *    "toolUseId":"toolu_...","parentAgentId":"a0efe4645d03748de",
 *    "spawnDepth":2,"model":"sonnet"}
 *
 * `parentAgentId` reconstructs the delegation tree, which is what makes a phase's
 * true cost computable: a driver's own transcript is only ~76% of what its subtree
 * spent (measured: driver own 233,607,665 vs subtree 308,519,206). Rolling up over
 * `descendantsOf` is the difference between undercounting a phase by a quarter and
 * getting it right.
 *
 * Like the sidecar format itself, this file's shape is internal to Claude Code and
 * is NOT a stable contract — it can change on any release. Every field is read
 * defensively and a malformed or missing sidecar degrades rather than throwing.
 * This module does no token math; it only answers "who spawned whom".
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const META_RE = /^agent-(.+)\.meta\.json$/;

/**
 * @returns {{ok: boolean, agents: Map<string, object>, error: {code: string, detail: string}|null}}
 * Never throws. `agents` is always a Map (empty when !ok).
 */
export function readAgentTree(subagentsDir) {
  const agents = new Map();
  if (!subagentsDir) {
    return { ok: false, agents, error: { code: 'not_found', detail: 'no subagents dir given' } };
  }
  let entries;
  try {
    entries = readdirSync(subagentsDir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, agents, error: { code: 'not_found', detail: `cannot read ${subagentsDir}: ${err.code ?? err.message}` } };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = META_RE.exec(entry.name);
    if (!m) continue;
    const id = m[1];
    let raw;
    try {
      raw = JSON.parse(readFileSync(join(subagentsDir, entry.name), 'utf8'));
    } catch {
      continue; // A malformed sidecar loses one agent, not the whole tree.
    }
    if (!raw || typeof raw !== 'object') continue;
    agents.set(id, {
      id,
      agentType: typeof raw.agentType === 'string' ? raw.agentType : null,
      model: typeof raw.model === 'string' ? raw.model : null,
      parentAgentId: typeof raw.parentAgentId === 'string' ? raw.parentAgentId : null,
      spawnDepth: Number.isFinite(raw.spawnDepth) ? raw.spawnDepth : null,
      description: typeof raw.description === 'string' ? raw.description : null,
    });
  }
  if (agents.size === 0) {
    return { ok: false, agents, error: { code: 'no_metadata', detail: `no agent-*.meta.json sidecars in ${subagentsDir}` } };
  }
  return { ok: true, agents, error: null };
}

/** Direct children of `id`, sorted for deterministic output. */
export function childrenOf(tree, id) {
  const out = [];
  for (const [childId, meta] of tree?.agents ?? []) {
    if (meta.parentAgentId === id) out.push(childId);
  }
  return out.sort();
}

/**
 * `id` plus every transitive descendant — `id` first, the rest sorted.
 * Cycle-safe: a parentAgentId loop terminates via the `seen` set rather than
 * recursing forever. An unknown `id` returns just `[id]`, so a caller that
 * knows an agent id the sidecars do not still gets that one transcript.
 */
export function descendantsOf(tree, id) {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    for (const child of childrenOf(tree, queue.shift())) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  const rest = [...seen].filter((x) => x !== id).sort();
  return [id, ...rest];
}

/**
 * Agents with no parent *present in this directory* — the phase drivers. An
 * agent whose parentAgentId names someone absent counts as a driver too, so an
 * incomplete directory still partitions rather than dropping a subtree.
 */
export function driversOf(tree) {
  const ids = [...(tree?.agents?.keys() ?? [])];
  return ids
    .filter((id) => {
      const parent = tree.agents.get(id).parentAgentId;
      return parent === null || !tree.agents.has(parent);
    })
    .sort();
}
