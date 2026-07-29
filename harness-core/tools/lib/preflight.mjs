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

// Code names inside free artifact text. Two shapes only, both narrow, because a
// false positive here spends the author's attention on every run and trains
// them to skip the whole check: a backticked identifier (`handleClear` — the
// author explicitly marking a code name), or a bare camelCase token starting
// with lowercase (useFetchClient, debounce()), or a trailing-() call name.
// Deliberately NOT matched: lone lowercase prose words ("we should debounce the
// input" is a sentence, not a claim about a symbol), anything with a slash
// (that's a path — evidencePaths already owns it, and matching both would
// double-report one defect), and tokens under 4 chars (ok/id/URL are noise).
// NOTE: Unquoted PascalCase is NOT matched by CASED_RE — a PascalCase name is
// only caught when the author backtick-quotes it, which BACKTICKED_RE handles.
// That is deliberate. Broadening CASED_RE to uppercase-initial would fire on
// multi-hump platform globals an artifact mentions in passing (AbortSignal,
// AbortController, EventTarget, MutationObserver) and on every imported
// component name, producing advisories on nearly every run. Do not add a
// denylist to suppress them — it is unbounded and drifts per project. Leave the
// regex narrow: the signal loss is acceptable, the noise is not.
const BACKTICKED_RE = /`([A-Za-z_$][A-Za-z0-9_$]*)`/g;
const CASED_RE = /\b([a-z][a-z0-9_$]*[A-Z][A-Za-z0-9_$]*)\b/g;
const CALLED_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\(\)/g;

function symbolsIn(text) {
  if (typeof text !== 'string') return [];
  const out = new Set();
  for (const re of [BACKTICKED_RE, CASED_RE, CALLED_RE]) {
    for (const m of text.matchAll(re)) {
      if (m[1].length >= 4) out.add(m[1]);
    }
  }
  return [...out];
}

/**
 * Advisory ground-truth check for symbols an artifact names. Reads only the
 * files the artifact ITSELF points at (key_paths, evidence paths, unit
 * locations) and asks whether each named symbol appears as a substring in any
 * of them. Substring, not a definition parse: the harness has no parser and
 * wants none, and a symbol that is imported-and-used in the named file rather
 * than declared there is a perfectly good thing for a manifest to claim.
 *
 * NEVER blocking. A unit that INTRODUCES a symbol names one that cannot exist
 * yet — the same legitimate case the "NEW: <path>" convention already encodes
 * for files — so a hard failure here would reject every greenfield unit.
 * Findings carry severity:'advisory' and preflight stays ok.
 */
export function symbolChecks({ text, paths, target, label, findings }) {
  const symbols = symbolsIn(text);
  if (!symbols.length || !paths?.length) return;

  const searchable = [];
  for (const p of paths) {
    const full = join(target, p);
    try {
      if (!statSync(full).isFile()) continue;
      searchable.push({ path: p, body: readFileSync(full, 'utf8') });
    } catch {
      continue; // a missing/unreadable path is key_path_exists' finding, not ours
    }
  }
  if (!searchable.length) return; // nothing to search is not evidence of absence

  for (const sym of symbols) {
    if (searchable.some((f) => f.body.includes(sym))) continue;
    findings.push({
      check: 'symbol_resolves',
      detail: `${label}: symbol not found in any named file: ${sym} (searched: ${searchable.map((f) => f.path).join(', ')})`,
      severity: 'advisory',
    });
  }
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
  const keyPaths = [];
  for (const entry of manifest.repo_scan?.key_paths ?? []) {
    const p = keyPathOf(entry);
    if (p && !existsSync(join(target, p))) {
      findings.push({ check: 'key_path_exists', detail: `repo_scan.key_paths entry does not exist: ${p}` });
    } else if (p) {
      keyPaths.push(p);
    }
  }
  // An annotated key_path ("src/App.tsx — handleClear (…)") names its own
  // symbols; check them against the file the same entry points at.
  for (const entry of manifest.repo_scan?.key_paths ?? []) {
    const p = keyPathOf(entry);
    if (!p || !keyPaths.includes(p)) continue;
    symbolChecks({ text: String(entry), paths: [p], target, label: `key_paths(${p})`, findings });
  }
  for (const entry of manifest.claims_audit ?? []) {
    const paths = evidencePaths(entry.evidence, target);
    for (const p of paths) {
      if (!existsSync(join(target, p))) {
        findings.push({ check: 'evidence_path_resolves', detail: `claims_audit evidence references nonexistent path: ${p} (claim: ${entry.claim})` });
      }
    }
    // Symbols in the evidence are checked against the paths that evidence
    // names, plus the manifest's own key_paths — an author often writes "handles
    // it in src/app.ts" for one claim and names the symbol in another.
    const searchIn = [...new Set([...paths.filter((p) => existsSync(join(target, p))), ...keyPaths])];
    symbolChecks({
      text: `${entry.claim ?? ''} ${entry.evidence ?? ''}`,
      paths: searchIn,
      target,
      label: `claims_audit(${entry.claim})`,
      findings,
    });
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
    // Symbols a unit names are checked only against that unit's OWN existing
    // locations. NEW: locations are excluded — a unit that creates a file names
    // symbols that cannot exist yet, and flagging those is the false positive
    // that would make this check worthless on greenfield work.
    const existing = (u.locations ?? []).filter((loc) => !loc.startsWith('NEW: '));
    symbolChecks({
      text: [u.title ?? '', ...(u.done_criteria ?? [])].join(' '),
      paths: existing,
      target,
      label: `${u.id}.done_criteria`,
      findings,
    });
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
  // Advisory findings inform, they do not gate. Existing findings carry no
  // severity key at all — absent means blocking — so every current caller and
  // test keeps working, and only symbol_resolves opts into non-blocking.
  return { ok: findings.every((f) => f.severity === 'advisory'), findings };
}
