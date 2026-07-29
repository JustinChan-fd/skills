// harness-core/test/skill-metrics-literals.test.mjs
// A `--skill-metrics` example in skill prose is copied verbatim by the driver,
// so any literal in it becomes a constant on every record. `splitRequired` was
// hardcoded `false` in harness-intake-core and stayed false on the live
// TARS-1271 record whose plan then produced a 102-location unit — the field read
// like a measurement of a split that intake cannot see (splitting happens on the
// plan artifact, which does not exist at intake time). Guard the prose, because
// run-record.schema.json types skill_metrics as free-form object|null and so
// validates nothing about its shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Auto-discover every harness-* skill dir, same as portability.test.mjs — a
// hardcoded list silently missed a skill once already. SCAN_DIRS covers only
// the four harness-* dirs, not the 20 other SKILL.md files in this repo
// (brainstorming/, push-branch/, …). That is correct — only harness driver
// skills call `CLI run-end` — so only they can bake a constant into the record.
const SCAN_DIRS = readdirSync(ROOT).filter(
  (name) => name.startsWith('harness-') && statSync(join(ROOT, name)).isDirectory(),
);

test('skill-metrics: no SKILL.md hardcodes a splitRequired literal', () => {
  const offenders = [];
  for (const dir of SCAN_DIRS) {
    const file = join(ROOT, dir, 'SKILL.md');
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // not every harness-* dir ships a SKILL.md (harness-core does not)
    }
    for (const line of text.split('\n')) {
      if (/"splitRequired"\s*:/.test(line)) {
        offenders.push(`${file}: hardcodes splitRequired -> ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
