// harness-core/test/portability.test.mjs
// Spec P4: no machine- or user-specific identifiers in skill code outside
// designated config. Deny terms are concatenated so this file never matches itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Auto-discover every harness-* skill dir so a new skill (e.g. harness-loop)
// can never land outside the guard — a hardcoded list silently missed one.
const SCAN_DIRS = readdirSync(ROOT).filter(
  (name) => name.startsWith('harness-') && statSync(join(ROOT, name)).isDirectory(),
);
const DENY = ['jchan' + '922', '/Users/' + 'justin', 'Desktop/' + 'repos'];
const EXCLUDE_SUFFIXES = [join('harness-core', 'config', 'user.json')];

test('portability: no repo-specific identifiers in skill code', () => {
  const offenders = [];
  for (const dir of SCAN_DIRS) {
    const full = join(ROOT, dir);
    let exists = true;
    try {
      statSync(full);
    } catch {
      exists = false; // skill folders land in later tasks; scan what exists
    }
    if (!exists) continue;
    walk(full, (file) => {
      if (EXCLUDE_SUFFIXES.some((suffix) => file.endsWith(suffix))) return;
      const text = readFileSync(file, 'utf8');
      for (const term of DENY) {
        if (text.includes(term)) offenders.push(`${file}: contains "${term}"`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    statSync(path).isDirectory() ? walk(path, fn) : fn(path);
  }
}
