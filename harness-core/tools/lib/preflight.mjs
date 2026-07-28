// Deterministic pre-verifier checks. Measured runs showed most verifier
// round-1 failures are mechanical (nonexistent locations, dangling deps,
// unresolvable evidence paths) — each one burned a 50-75k-token LLM round a
// regex could have caught. Skills run this BEFORE spawning a verifier and
// fix findings first; the verifier's context is then spent on judgment.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadSchema, validate } from './validate.mjs';

// A run dir is <target>/.harness/runs/<id> — the repo root is three up.
function targetOf(runDir) {
  return dirname(dirname(dirname(runDir)));
}

// Repo-relative path tokens inside free evidence text: "src/a/b.ts", with
// trailing punctuation and :line suffixes stripped. Single-segment names
// ("README.md") are skipped — too many false positives on prose. Slash-joined
// prose ("shadcn/ui", "button/input/label") is filtered downstream by
// requiring the token's first segment to be a real directory in the repo.
function evidencePaths(text, target) {
  if (typeof text !== 'string') return [];
  return (text.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g) ?? [])
    .map((p) => p.replace(/:\d+(-\d+)?$/, '').replace(/[.,;:)]+$/, ''))
    .filter((p) => {
      const first = p.split('/')[0];
      try {
        return existsSync(join(target, first)) && statSync(join(target, first)).isDirectory();
      } catch {
        return false;
      }
    });
}

// key_paths entries may carry an annotation after the path ("src/App.tsx —
// handleClear (…)"): the path is everything before the first whitespace.
function keyPathOf(entry) {
  return String(entry).trim().split(/\s/)[0];
}

function parseArtifact(runDir, file, findings) {
  const path = join(runDir, file);
  if (!existsSync(path)) {
    findings.push({ check: 'artifact_exists', detail: `${file} not found in run dir` });
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    findings.push({ check: 'artifact_parses', detail: `${file}: ${err.message}` });
    return null;
  }
}

function intakeChecks(runDir, findings) {
  const manifest = parseArtifact(runDir, 'manifest.json', findings);
  if (!manifest) return;
  const target = targetOf(runDir);

  for (const err of validate(loadSchema('manifest'), manifest)) {
    findings.push({ check: 'schema_valid', detail: err });
  }
  const acs = manifest.requirement?.acceptance_criteria ?? [];
  if (!acs.length || acs.some((a) => typeof a !== 'string' || !a.trim())) {
    findings.push({ check: 'acceptance_criteria_nonempty', detail: 'acceptance_criteria must be a non-empty list of non-empty strings' });
  }
  for (const entry of manifest.repo_scan?.key_paths ?? []) {
    const p = keyPathOf(entry);
    if (p && !existsSync(join(target, p))) {
      findings.push({ check: 'key_path_exists', detail: `repo_scan.key_paths entry does not exist: ${p}` });
    }
  }
  for (const entry of manifest.claims_audit ?? []) {
    for (const p of evidencePaths(entry.evidence, target)) {
      if (!existsSync(join(target, p))) {
        findings.push({ check: 'evidence_path_resolves', detail: `claims_audit evidence references nonexistent path: ${p} (claim: ${entry.claim})` });
      }
    }
  }
}

function planChecks(runDir, findings) {
  const plan = parseArtifact(runDir, 'plan.json', findings);
  if (!plan) return;
  const target = targetOf(runDir);
  const units = Array.isArray(plan.units) ? plan.units : [];
  if (!units.length) {
    findings.push({ check: 'units_nonempty', detail: 'plan has no units' });
    return;
  }
  const ids = units.map((u) => u.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) {
    findings.push({ check: 'unit_ids_unique', detail: `duplicate unit ids: ${ids.join(', ')}` });
  }

  for (const u of units) {
    for (const loc of u.locations ?? []) {
      if (loc.startsWith('NEW: ')) {
        const parent = dirname(loc.slice('NEW: '.length));
        if (!existsSync(join(target, parent))) {
          findings.push({ check: 'new_location_parent_exists', detail: `${u.id}: NEW location's parent dir does not exist: ${parent}` });
        }
      } else if (!existsSync(join(target, loc))) {
        findings.push({ check: 'location_exists', detail: `${u.id}: location does not exist: ${loc}` });
      }
    }
    if (!Array.isArray(u.done_criteria) || !u.done_criteria.length) {
      findings.push({ check: 'done_criteria_nonempty', detail: `${u.id} has no done_criteria` });
    }
    for (const dep of u.depends_on ?? []) {
      if (!idSet.has(dep)) {
        findings.push({ check: 'depends_on_exists', detail: `${u.id} depends on unknown unit: ${dep}` });
      }
    }
  }

  const order = Array.isArray(plan.order) ? plan.order : [];
  const pos = new Map(order.map((id, i) => [id, i]));
  for (const id of idSet) {
    if (!pos.has(id)) findings.push({ check: 'order_complete', detail: `unit missing from order: ${id}` });
  }
  for (const id of order) {
    if (!idSet.has(id)) findings.push({ check: 'order_complete', detail: `order names unknown unit: ${id}` });
  }
  if (new Set(order).size !== order.length) {
    findings.push({ check: 'order_complete', detail: 'order contains duplicates' });
  }
  for (const u of units) {
    for (const dep of u.depends_on ?? []) {
      if (!pos.has(u.id) || !idSet.has(dep)) continue; // covered by order_complete / depends_on_exists
      if (!pos.has(dep) || pos.get(dep) >= pos.get(u.id)) {
        findings.push({ check: 'order_respects_deps', detail: `${u.id} appears in order before its dependency ${dep}` });
      }
    }
  }
}

// Implement runs against the plan.json harness-plan wrote (schema_version'd,
// units + order). Before a fresh implement verifier: the plan must exist,
// parse, pass the plan schema, and every non-NEW location must exist (a NEW:
// location's parent dir must exist) — same mechanical ground-truth as plan,
// but keyed to the plan schema so a schema-invalid plan is caught here too.
function implementChecks(runDir, findings) {
  const plan = parseArtifact(runDir, 'plan.json', findings);
  if (!plan) return;
  const target = targetOf(runDir);

  for (const err of validate(loadSchema('plan'), plan)) {
    findings.push({ check: 'schema_valid', detail: err });
  }

  for (const u of Array.isArray(plan.units) ? plan.units : []) {
    for (const loc of u.locations ?? []) {
      if (loc.startsWith('NEW: ')) {
        const parent = dirname(loc.slice('NEW: '.length));
        if (!existsSync(join(target, parent))) {
          findings.push({ check: 'new_location_parent_exists', detail: `${u.id}: NEW location's parent dir does not exist: ${parent}` });
        }
      } else if (!existsSync(join(target, loc))) {
        findings.push({ check: 'location_exists', detail: `${u.id}: location does not exist: ${loc}` });
      }
    }
  }
}

export function preflight({ phase, runDir }) {
  const findings = [];
  if (phase === 'intake') intakeChecks(runDir, findings);
  else if (phase === 'plan') planChecks(runDir, findings);
  else if (phase === 'implement') implementChecks(runDir, findings);
  else findings.push({ check: 'phase_known', detail: `unknown preflight phase: ${phase}` });
  return { ok: findings.length === 0, findings };
}
