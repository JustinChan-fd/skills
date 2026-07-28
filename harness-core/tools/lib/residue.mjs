// Residue forward-routing lookup. When a gate opens with a non-null `record`
// (residue|defect), the phase driver writes a standardized audit `note` (the
// u1 shape: data.type in {residue,defect} + data.criterion + data.detail).
// This module reads those notes back out of a target repo's audit.jsonl,
// scoped to one issue, so a later plan run on the same issue can carry still-
// relevant residue forward. It deliberately reuses anomalies.mjs's tolerant
// JSONL reader rather than mirroring a second parser.
import { readEvents } from './anomalies.mjs';

// The integer in a run_id's `__issue-<n>__` segment, or null when the run_id
// carries no issue segment (adhoc/file-sourced runs are permanently outside
// forward-routing — they have no issue to route to).
export function parseIssueFromRunId(runId) {
  if (typeof runId !== 'string') return null;
  const m = runId.match(/__issue-(\d+)__/);
  return m ? Number(m[1]) : null;
}

// A note is routable residue ONLY when it carries the FULL u1 shape:
// data.type in {residue, defect} AND a non-empty string data.criterion. The
// data.type check alone is insufficient — this repo's own pre-standardization
// notes already use the literal data.type:"residue" for issue-2/issue-3 yet
// carry no data.criterion, and must not be matched.
function isRoutableResidue(event) {
  if (event?.event !== 'note') return false;
  const data = event.data;
  if (!data) return false;
  if (data.type !== 'residue' && data.type !== 'defect') return false;
  return typeof data.criterion === 'string' && data.criterion.length > 0;
}

// Read <auditPath> and return the routable-residue note events whose run_id's
// parsed issue number equals `issue`, sorted oldest-to-newest by ts. A missing
// audit file (readEvents → null) is a valid empty outcome, not an error.
export function scanResidue({ auditPath, issue }) {
  const events = readEvents(auditPath) ?? [];
  return events
    .filter(isRoutableResidue)
    .filter((e) => parseIssueFromRunId(e.run_id) === issue)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
