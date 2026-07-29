// harness-core/test/audit-ts-literals.test.mjs
// A skill that writes `{"ts":"<now>","event":"spawn",...}` hands the timestamp to
// the MODEL to fill, and a model writes whole seconds: on the measured TARS-1272
// run both intake discovery spawns read `17:49:38` — identical, so the two
// subagents' durations were indistinguishable and neither could be ordered
// against the other. `appendAudit` already stamps `ts` itself when the caller
// omits it (audit.mjs), from `new Date()`, at millisecond precision, at a moment
// within a few ms of the event. So the fix is to stop hand-stamping: drop the
// field from the prose and let the CLI stamp it.
//
// Guard the prose, because audit-entry.schema.json only types `ts` as a
// date-time string — `2026-07-29T17:49:38Z` is perfectly valid, just useless for
// measuring anything shorter than a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Auto-discover, same as skill-metrics-literals.test.mjs — a hardcoded list
// silently missed a skill once already.
const SCAN_DIRS = readdirSync(ROOT).filter(
  (name) => name.startsWith('harness-') && statSync(join(ROOT, name)).isDirectory(),
);

test('audit prose: no SKILL.md hand-stamps ts in a CLI audit event', () => {
  const offenders = [];
  for (const dir of SCAN_DIRS) {
    const file = join(ROOT, dir, 'SKILL.md');
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // not every harness-* dir ships a SKILL.md (harness-core does not)
    }
    text.split('\n').forEach((line, i) => {
      // Only `CLI audit` lines: harness-loop-core documents a tick-log record
      // shape that legitimately carries its own `ts`, and that is not an audit
      // event — it is not written by appendAudit and has no ms claim to keep.
      if (!/CLI audit\b/.test(line)) return;
      if (/"ts"\s*:/.test(line)) {
        offenders.push(`${file}:${i + 1}: hand-stamps ts -> ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'omit ts and let appendAudit stamp it — a model-written timestamp is whole-second precision',
  );
});
