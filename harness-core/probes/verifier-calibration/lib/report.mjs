// Result collection & report assembly for the verifier-calibration probe.
//
// recordResult appends one entry per defect-per-tier to the additive
// probe-report.json artifact (the non-schema-kind store chosen in the plan's
// open_design_decisions_resolved — the probe never calls CLI init-run).
// buildReport is a pure function turning the recorded entries into a markdown
// report: catch-rate tables per tier and per class, the directional-signal
// disclosure, and the FLOOR observation framed for the operator to arbitrate.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPORT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../results/probe-report.json',
);

const CLASSES = [
  'broken-build',
  'failing-contract-criterion',
  'data-loss-path',
  'silently-wrong-behavior',
];

/**
 * Append one result entry to probe-report.json (creating it as a JSON array if
 * absent) and return the full running array. The stored entry is the record as
 * given, so callers may include the raw gate result/failures verbatim for
 * future re-scoring — buildReport only reads the summary fields.
 */
export function recordResult(record, reportPath = DEFAULT_REPORT_PATH) {
  let results = [];
  if (existsSync(reportPath)) {
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
    results = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
  }
  results.push(record);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(results, null, 2) + '\n');
  return results;
}

function countCatches(results, predicate) {
  const subset = results.filter(predicate);
  const caught = subset.filter((r) => r.caught).length;
  return { caught, total: subset.length };
}

function pct(caught, total) {
  if (total === 0) return 'n/a';
  return `${Math.round((caught / total) * 100)}%`;
}

/**
 * Build the markdown report (pure).
 * @param {Array} results - recorded {defect_id, class, tier, caught, ...} entries
 */
export function buildReport(results) {
  const tiers = ['HIGH', 'MID'];

  // Per-tier table.
  const tierRows = tiers.map((tier) => {
    const { caught, total } = countCatches(results, (r) => r.tier === tier);
    return `| ${tier} | ${caught}/${total} | ${pct(caught, total)} |`;
  });

  // Per-class table (HIGH and MID columns side by side).
  const classRows = CLASSES.map((cls) => {
    const hi = countCatches(results, (r) => r.class === cls && r.tier === 'HIGH');
    const mid = countCatches(results, (r) => r.class === cls && r.tier === 'MID');
    return `| ${cls} | ${hi.caught}/${hi.total} | ${mid.caught}/${mid.total} |`;
  });

  const highTotal = countCatches(results, (r) => r.tier === 'HIGH');
  const midTotal = countCatches(results, (r) => r.tier === 'MID');
  const n = highTotal.total; // defects per tier

  const lines = [
    '## Catch rate by tier',
    '',
    '| Tier | Caught | Rate |',
    '| --- | --- | --- |',
    ...tierRows,
    '',
    '## Catch rate by defect class',
    '',
    '| Defect class | HIGH caught | MID caught |',
    '| --- | --- | --- |',
    ...classRows,
    '',
    '## Reading these numbers',
    '',
    `At N=8, this is a directional signal, not statistics. This probe exercises the verifier in isolation and not its full post-driver live context. Each defect is judged by a single fresh-context verifier_implement dispatch per tier, without the surrounding implement-phase driver loop, revision rounds, or accumulated run context, so the numbers describe the verifier's isolated catch behavior only.`,
    '',
    '## FLOOR question',
    '',
    `The FLOOR question is whether MID is a safe floor for the verifier_implement tier. Its measured answer shape here, offered as a reported observation for the operator to arbitrate, not an adjudicated conclusion:`,
    '',
    `> MID catches ${midTotal.caught}/${n} vs HIGH catches ${highTotal.caught}/${n}`,
    '',
    `This run does not itself change routing.json or any tier assignment regardless of the gap above; acting on it (or not) is the operator's call.`,
  ];
  return lines.join('\n');
}
