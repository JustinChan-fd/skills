import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preflight, symbolChecks } from '../tools/lib/preflight.mjs';

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

// ── implement preflight ───────────────────────────────────────────────────────
// Before spending a fresh implement verifier, catch the mechanical defects: the
// plan.json must exist, parse, be schema-valid, and every non-NEW location it
// names must exist in the repo (a NEW: location's parent dir must exist).

const IMPL_PLAN = (over = {}) => ({
  run_id: '2026-07-25T000000Z__t__implement__adhoc__abc123',
  units: [
    { id: 'U1', title: 'edit app', locations: ['src/app.ts'], done_criteria: ['done'], depends_on: [] },
  ],
  order: ['U1'],
  schema_version: '1.0.0',
  ...over,
});

test('implement preflight passes when plan.json is schema-valid and locations exist', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(IMPL_PLAN()));
  const r = preflight({ phase: 'implement', runDir });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('implement preflight flags a missing plan.json', () => {
  const { runDir } = scaffold();
  const r = preflight({ phase: 'implement', runDir });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.check === 'artifact_exists'));
});

test('implement preflight flags a plan that fails the plan schema', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(IMPL_PLAN({ units: [{ id: 'U1' }] })));
  const r = preflight({ phase: 'implement', runDir });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.check === 'schema_valid'));
});

test('implement preflight flags a location that does not exist', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(IMPL_PLAN({
    units: [{ id: 'U1', title: 'x', locations: ['src/ghost.ts'], done_criteria: ['d'], depends_on: [] }],
  })));
  const r = preflight({ phase: 'implement', runDir });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.check === 'location_exists'));
});

test('implement preflight allows a NEW: location whose parent dir exists', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(IMPL_PLAN({
    units: [{ id: 'U1', title: 'x', locations: ['NEW: src/components/clientFetch.ts'], done_criteria: ['d'], depends_on: [] }],
  })));
  const r = preflight({ phase: 'implement', runDir });
  assert.equal(r.ok, true);
});

// ── symbol_resolves (advisory) ────────────────────────────────────────────────
// Preflight already catches the mechanical lie about files. It caught nothing
// about symbols: a manifest claiming `handleClearFilters` already debounces, or
// a plan unit whose done_criteria names `useFetchClient`, passed clean and the
// first thing to notice was a verifier round — 50-75k tokens for a name a
// substring search finds for free. Advisory, never blocking: a unit that
// INTRODUCES a symbol legitimately names one that does not exist yet, the same
// case the "NEW: <path>" convention already encodes for files.

const advisory = (r) => r.findings.filter((f) => f.severity === 'advisory');

test('intake preflight flags a symbol named in evidence that appears in no named file', () => {
  const { target, runDir } = scaffold();
  writeFileSync(join(target, 'src', 'app.ts'), 'export function handleClear() {}\n');
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(MANIFEST({
    claims_audit: [
      { claim: 'clearing', verdict: 'verified', evidence: 'src/app.ts defines `handleClear` and `handleClearFilters`' },
    ],
  })));
  const r = preflight({ phase: 'intake', runDir });
  const found = advisory(r);
  assert.equal(found.length, 1, `expected exactly one advisory, got ${JSON.stringify(found)}`);
  assert.equal(found[0].check, 'symbol_resolves');
  assert.ok(found[0].detail.includes('handleClearFilters'));
  assert.ok(!found[0].detail.includes('`handleClear`'), 'handleClear is present and must not be flagged');
  assert.ok(found[0].detail.includes('src/app.ts'), 'the detail must name what was searched');
});

test('a symbol finding is advisory: preflight stays ok and does not block', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(MANIFEST({
    claims_audit: [
      { claim: 'ghost', verdict: 'verified', evidence: 'src/app.ts exports `totallyMissingSymbol`' },
    ],
  })));
  const r = preflight({ phase: 'intake', runDir });
  assert.equal(r.ok, true, 'an advisory-only run must remain ok — a NEW symbol is legitimate');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'advisory');
});

test('a blocking finding still makes preflight not-ok even beside advisories', () => {
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(MANIFEST({
    repo_scan: { stack: 'ts', key_paths: ['src/ghost.ts'], notes: null },
    claims_audit: [
      { claim: 'ghost', verdict: 'verified', evidence: 'src/app.ts exports `alsoMissing`' },
    ],
  })));
  const r = preflight({ phase: 'intake', runDir });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.check === 'key_path_exists' && f.severity === undefined));
  assert.ok(r.findings.some((f) => f.check === 'symbol_resolves' && f.severity === 'advisory'));
});

test('prose words, paths, and short tokens are not treated as symbols', () => {
  // Every one of these appeared in a real manifest. Flagging any of them trains
  // the author to ignore the check, which costs more than the check saves.
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(MANIFEST({
    claims_audit: [
      { claim: 'prose', verdict: 'verified', evidence: 'we should debounce the input here; it is ok as is' },
      { claim: 'paths', verdict: 'verified', evidence: 'uses shadcn/ui conventions across src/components' },
    ],
  })));
  const r = preflight({ phase: 'intake', runDir });
  assert.deepEqual(advisory(r), []);
  assert.equal(r.ok, true);
});

test('plan preflight mines symbols from unit done_criteria against that unit locations', () => {
  const { target, runDir } = scaffold();
  writeFileSync(join(target, 'src', 'app.ts'), 'export const useFetchClient = () => {};\n');
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(PLAN({
    units: [
      { id: 'u1', title: 'a', locations: ['src/app.ts'], depends_on: [], done_criteria: ['`useFetchClient` returns an AbortSignal'] },
      { id: 'u2', title: 'b', locations: ['src/app.ts'], depends_on: [], done_criteria: ['`useLegacyFetch` is deleted'] },
    ],
    order: ['u1', 'u2'],
  })));
  const r = preflight({ phase: 'plan', runDir });
  const found = advisory(r);
  assert.equal(found.length, 1, `expected one advisory, got ${JSON.stringify(found)}`);
  assert.ok(found[0].detail.includes('useLegacyFetch'));
  assert.ok(found[0].detail.startsWith('u2'), 'the detail must name the unit');
});

test('a NEW: location is skipped by the symbol check, not reported as missing', () => {
  // The whole false-negative case: a unit that creates a file names symbols that
  // cannot exist yet. Nothing to search, so nothing to say.
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(PLAN({
    units: [
      { id: 'u1', title: 'a', locations: ['NEW: src/components/dialog.ts'], depends_on: [], done_criteria: ['`DialogRoot` renders'] },
    ],
    order: ['u1'],
  })));
  const r = preflight({ phase: 'plan', runDir });
  assert.deepEqual(advisory(r), []);
});

test('a unit with no readable locations produces no symbol findings', () => {
  // Guard against the check reporting "not found in any named file" when the
  // list of files to search is empty — that is a vacuous finding, not a defect.
  const { runDir } = scaffold();
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(PLAN({
    units: [
      { id: 'u1', title: 'a', locations: [], depends_on: [], done_criteria: ['`mysterySymbol` works'] },
    ],
    order: ['u1'],
  })));
  const r = preflight({ phase: 'plan', runDir });
  assert.deepEqual(advisory(r), []);
});

test('symbolChecks is exported and appends nothing when every symbol resolves', () => {
  const { target } = scaffold();
  writeFileSync(join(target, 'src', 'app.ts'), 'export function handleClear() { return doWork(); }\n');
  const findings = [];
  symbolChecks({
    text: 'calls `handleClear` and then `doWork`',
    paths: ['src/app.ts'],
    target,
    label: 'unit-test',
    findings,
  });
  assert.deepEqual(findings, []);
});
