import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preflight } from '../tools/lib/preflight.mjs';

// Layout: <target>/.harness/runs/<id>/{manifest.json,plan.json}
function scaffold() {
  const target = mkdtempSync(join(tmpdir(), 'harness-preflight-'));
  const runDir = join(target, '.harness', 'runs', '2026-07-25T000000Z__t__intake__adhoc__abc123');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(target, 'src', 'components'), { recursive: true });
  writeFileSync(join(target, 'src', 'app.ts'), 'export {}\n');
  writeFileSync(join(target, 'src', 'components', 'button.ts'), 'export {}\n');
  return { target, runDir };
}

const MANIFEST = (over = {}) => ({
  run_id: '2026-07-25T000000Z__t__intake__adhoc__abc123',
  schema_version: '1.0.0',
  source: { type: 'adhoc', ref: 'x' },
  requirement: { summary: 's', acceptance_criteria: ['does the thing'] },
  size: { value: 'S', rationale: 'r' },
  repo_scan: { stack: 'ts', key_paths: ['src/app.ts'], notes: null },
  ...over,
});

test('intake preflight passes on a grounded manifest', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(MANIFEST()));
  const r = preflight({ phase: 'intake', runDir });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('intake preflight flags nonexistent key_paths', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(MANIFEST({
    repo_scan: { stack: 'ts', key_paths: ['src/app.ts', 'src/ghost.ts'], notes: null },
  })));
  const r = preflight({ phase: 'intake', runDir });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.check === 'key_path_exists' && f.detail.includes('src/ghost.ts')));
});

test('intake preflight flags empty acceptance criteria and schema violations', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(MANIFEST({
    requirement: { summary: 's', acceptance_criteria: [] },
  })));
  const r = preflight({ phase: 'intake', runDir });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.check === 'acceptance_criteria_nonempty'));
});

test('intake preflight accepts annotated key_paths ("path — note") and prose slashes in evidence', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(MANIFEST({
    repo_scan: {
      stack: 'ts',
      key_paths: [
        'src/app.ts — the main entry (calls foo/bar patterns)',
        'src/components/ — existing ui: button/input/label live here',
      ],
      notes: null,
    },
    claims_audit: [
      { claim: 'conventions', verdict: 'verified', evidence: 'uses shadcn/ui conventions; components are button/input/label/textarea style' },
      { claim: 'no dialog', verdict: 'verified', evidence: 'no dialog/modal component exists anywhere in src/components' },
    ],
  })));
  const r = preflight({ phase: 'intake', runDir });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
});

test('intake preflight resolves repo-relative paths inside claims_audit evidence', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(MANIFEST({
    claims_audit: [
      { claim: 'button exists', verdict: 'verified', evidence: 'see src/components/button.ts, exported' },
      { claim: 'ghost exists', verdict: 'verified', evidence: 'src/ghost/widget.ts defines it' },
    ],
  })));
  const r = preflight({ phase: 'intake', runDir });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.check === 'evidence_path_resolves' && f.detail.includes('src/ghost/widget.ts')));
  assert.ok(!r.findings.some((f) => f.detail.includes('button.ts')));
});

const PLAN = (over = {}) => ({
  run_id: 'p1',
  intake_run_id: 'i1',
  units: [
    { id: 'u1', title: 'a', locations: ['src/app.ts'], depends_on: [], done_criteria: ['tests pass'] },
    { id: 'u2', title: 'b', locations: ['NEW: src/components/dialog.ts'], depends_on: ['u1'], done_criteria: ['renders'] },
  ],
  order: ['u1', 'u2'],
  risks: [],
  ...over,
});

test('plan preflight passes on a grounded plan', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(PLAN()));
  const r = preflight({ phase: 'plan', runDir });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('plan preflight flags nonexistent non-NEW locations and missing NEW parents', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(PLAN({
    units: [
      { id: 'u1', title: 'a', locations: ['src/ghost.ts'], depends_on: [], done_criteria: ['x'] },
      { id: 'u2', title: 'b', locations: ['NEW: src/ghostdir/file.ts'], depends_on: [], done_criteria: ['x'] },
    ],
    order: ['u1', 'u2'],
  })));
  const r = preflight({ phase: 'plan', runDir });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.check === 'location_exists' && f.detail.includes('src/ghost.ts')));
  assert.ok(r.findings.some((f) => f.check === 'new_location_parent_exists' && f.detail.includes('src/ghostdir')));
});

test('plan preflight flags order/dependency defects', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(PLAN({
    units: [
      { id: 'u1', title: 'a', locations: ['src/app.ts'], depends_on: ['u2'], done_criteria: ['x'] },
      { id: 'u2', title: 'b', locations: ['src/app.ts'], depends_on: ['u9'], done_criteria: [] },
    ],
    order: ['u1'],
  })));
  const r = preflight({ phase: 'plan', runDir });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.check === 'order_complete'));           // u2 missing from order
  assert.ok(r.findings.some((f) => f.check === 'depends_on_exists' && f.detail.includes('u9')));
  assert.ok(r.findings.some((f) => f.check === 'order_respects_deps' && f.detail.includes('u1')));
  assert.ok(r.findings.some((f) => f.check === 'done_criteria_nonempty' && f.detail.includes('u2')));
});

test('preflight reports unparseable artifacts as findings, not throws', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'plan.json'), '{nope');
  const r = preflight({ phase: 'plan', runDir });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.check === 'artifact_parses'));
});
