// Tick-state derivation for the harness loop: given a target repo and an
// issue, decide the next pipeline action purely from the run records on
// disk. Deterministic on purpose — the loop's LLM tick should never have to
// judge "where was I?"; it asks this and acts.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LADDER = ['intake', 'plan', 'implement'];

export function loopState({ targetDir, issue }) {
  const wanted = String(issue);
  const runsDir = join(targetDir, '.harness', 'runs');
  const newest = { intake: null, plan: null, implement: null };
  const attempted = { intake: null, plan: null, implement: null };

  if (existsSync(runsDir)) {
    // Run ids open with an ISO timestamp, so lexical order is time order.
    for (const id of readdirSync(runsDir).sort()) {
      let record;
      try {
        record = JSON.parse(readFileSync(join(runsDir, id, 'record.json'), 'utf8'));
      } catch {
        continue; // recordless or corrupt run dir — not this scan's crash
      }
      if (String(record.issue) !== wanted || !(record.kind in newest)) continue;
      newest[record.kind] = record;
      if (record.status === 'attempted') attempted[record.kind] = record.run_id;
    }
  }

  const phases = Object.fromEntries(LADDER.map((k) => [k, newest[k]?.status ?? null]));
  const next = LADDER.find((k) => phases[k] !== 'succeeded') ?? 'done';
  // Stranded is scoped to the phase the ladder actually points at — an
  // attempted record for an already-superseded phase (or an unrelated kind)
  // must not send the loop's recovery driver at the wrong run dir.
  const stranded = next === 'done' ? null : attempted[next];
  return { issue: wanted, next, stranded, phases };
}
