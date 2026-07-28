// Compose one harness-loop tick's loop.jsonl line. This subsumes two
// deterministic steps harness-loop step 7 used to do inline: the anomalies
// finding-count extraction (previously a `node -e` one-liner) and the
// per-phase token aggregation. It DISCOVERS nothing new — the tokens it reads
// were already persisted per-run via record-observed-tokens (tokens_observed);
// this only reads those snapshots back and assembles the fixed line shape.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Extract the anomalies finding count exactly as the prior inline one-liner
// did: parse the captured scan JSON and take findings.length. Kept identical
// so the count is computed by code, never estimated.
function anomaliesCount(anomaliesScanPath) {
  return JSON.parse(readFileSync(anomaliesScanPath, 'utf8')).findings.length;
}

// Read a run's orchestrator-observed token total (tokens_observed.total) back
// off disk. A run with no tokens_observed — a stranded run recovered from a
// prior tick, whose subagent_tokens this tick never witnessed — returns null
// (the caller lists it in unknown_phases rather than guessing a number).
function observedTotal(runDir) {
  const record = JSON.parse(readFileSync(join(runDir, 'record.json'), 'utf8'));
  return record.tokens_observed ? record.tokens_observed.total : null;
}

// Assemble the exact loop.jsonl line (ts/issue/actions/outcome/pr_url/
// anomalies/tokens) for one tick. phaseRuns is the ordered list of
// { phase, runDir } pairs this tick dispatched.
export function composeLoopLine({ issue, actions, outcome, prUrl = null, anomaliesScanPath, phaseRuns = [], ts }) {
  const by_phase = {};
  const unknown_phases = [];
  let total = null;
  for (const { phase, runDir } of phaseRuns) {
    const n = observedTotal(runDir);
    by_phase[phase] = n;
    if (n === null) unknown_phases.push(phase);
    else total = (total ?? 0) + n;
  }
  return {
    ts,
    issue,
    actions,
    outcome,
    pr_url: prUrl ?? null,
    anomalies: anomaliesCount(anomaliesScanPath),
    tokens: { total, by_phase, unknown_phases, source: 'agent_tool_usage_tag' },
  };
}
