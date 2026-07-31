// config — `.alfred/config.json`, the per-repo source of truth.
//
// See PLAN.md §4 for the schema and `test/config.test.mjs` for the ten frozen names.
//
// WHY THIS IS A FILE AND NOT A PHASE. §4: it "replaces what a phase used to re-derive
// every run, at zero tokens." Arm B spent four phases and $18.483 partly re-deriving
// facts a committed file could state outright — the base branch, the verify commands,
// what is off limits. Reading this is deterministic and free, which is the whole point.
//
// TWO RULES DO THE WORK, and both are refusals:
//
//   1. NO INVENTED DEFAULTS for anything that touches the repo. A guessed base branch
//      opens a PR against the wrong tree — measured on TARS-1271, where the base was
//      `feat/migrate-native-fetch-from-axios` and not `master`. A guessed verify
//      command grades a run on a check the repo does not run. Both are silent, so a
//      missing or invalid config REFUSES rather than filling in.
//   2. AN UNKNOWN KEY IS AN ERROR, at every depth. In a file that is the source of
//      truth, a typo is otherwise a setting that reads as applied and is not:
//      `off_limit` for `off_limits` permits writes to node_modules, and
//      `delivery.never_merged` permits merging. Depth-1-only validation catches the
//      first and waves through the second, so the walk is recursive.
//
// The single exception is `loop.poll_interval_minutes`, which defaults to 30 — the
// number in PERSONA.md §2. It defaults because it affects only cadence, and a wrong
// cadence is visible in an afternoon; a wrong base branch is a PR against the wrong
// tree. Note 0 is REFUSED rather than coerced to the default: a hot loop is the
// failure this guards, and coercion would make the operator who typed 0 never learn.
//
// NOTHING HERE RUNS A COMMAND. `verify` values are carried as strings for the gate to
// execute. A loader that shelled out would give a malformed config arbitrary execution
// at the top of an unattended tick.

import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { budgetUsdFor } from './router.mjs';
import { matchesPathPattern } from './paths.mjs';

export const CONFIG_RELATIVE_PATH = join('.alfred', 'config.json');

// PERSONA.md §2's number. Exported so a caller can state the default it is relying on
// rather than repeating the literal, and so the test can assert the two agree.
export const DEFAULT_POLL_INTERVAL_MINUTES = 30;

// Closed sets. Same reasoning as `blocked.mjs` REASONS and `gaps.mjs` GAP_CODES: a
// third value reaching a caller that switches on two silently takes the else branch.
const SOURCE_KINDS = ['jira', 'github'];
const DELIVERY_MODES = ['pr', 'push'];

// The permitted shape, by path. `type` is checked, so a string "1" from a hand-edited
// file or a templating step is refused — it is truthy, so every presence check passes
// and only a type check catches it.
const SCHEMA = {
  version: { type: 'number', required: true },
  repo: { type: 'string', required: true },
  source: {
    type: 'object',
    required: true,
    keys: {
      kind: { type: 'string', required: true, oneOf: SOURCE_KINDS },
      jira: { type: 'object', keys: { cloud: { type: 'string' }, project: { type: 'string' }, epic: { type: 'string' }, jql: { type: 'string' } } },
      github: { type: 'object', keys: { owner: { type: 'string' }, repo: { type: 'string' }, labels: { type: 'array' } } },
    },
  },
  loop: {
    type: 'object',
    keys: {
      poll_interval_minutes: { type: 'number' },
      blocked_label: { type: 'string' },
    },
  },
  base: {
    type: 'object',
    required: true,
    keys: { rules: { type: 'array', required: true } },
  },
  branch_prefix: { type: 'string', required: true },
  verify: { type: 'object', required: true },
  delivery: {
    type: 'object',
    required: true,
    keys: {
      mode: { type: 'string', required: true, oneOf: DELIVERY_MODES },
      pr_template: { type: 'string' },
      never_merge: { type: 'boolean', required: true },
    },
  },
  off_limits: { type: 'array', required: true },
  // Reachable at last (#70). `lib/router.mjs`'s `budgetUsdFor` has always read this key and
  // handed it to `--max-budget-usd` — the only ceiling the CLI was measured to enforce — but it
  // was absent here, so the unknown-key rule refused every config that set it and the only
  // budget a real run could use was the router's hardcoded default. Two modules each correct in
  // isolation, and the gap only appeared when a real fixture was validated.
  budget_usd: { type: 'number' },
  models: { type: 'object' },
  telemetry: { type: 'object', keys: { sink: { type: 'string' }, repo_slug: { type: 'string' } } },
};

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

const nullish = (v) => v === null || v === undefined;

// Recursive validation. Returns the first error as a string, or null.
//
// Recursive because of `delivery.never_merged`: a depth-1 walk reports the block as a
// known key and never looks inside, so a typo on the standing never-merge rule reads
// as applied. `verify` and `models` are deliberately open-valued — their keys are
// operator-chosen check names and seat names — so their contents are not walked, only
// their value types.
function validateBlock(value, schema, path) {
  for (const [key, sub] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    const rule = schema[key];

    if (!rule) return `unknown key ${at} — refusing rather than ignoring a setting that would read as applied`;
    if (nullish(sub)) continue;

    const actual = typeOf(sub);
    if (actual !== rule.type) return `${at} must be ${rule.type}, got ${actual}`;
    if (rule.oneOf && !rule.oneOf.includes(sub)) {
      return `${at} must be one of ${rule.oneOf.join(', ')} — got ${JSON.stringify(sub)}`;
    }
    if (rule.keys) {
      const nested = validateBlock(sub, rule.keys, at);
      if (nested) return nested;
    }
  }

  for (const [key, rule] of Object.entries(schema)) {
    if (rule.required && nullish(value[key])) return `${path ? `${path}.` : ''}${key} is required`;
  }

  return null;
}

// The checks that are not expressible as a type. Each corresponds to a defect this
// project has actually hit or a standing rule made mechanical.
function validateSemantics(raw) {
  // At least one verify command, because the gate runs `config.verify` and a config
  // declaring none produces a gate that passes everything by having nothing to check.
  const checks = Object.entries(raw.verify);
  if (checks.length === 0) return 'verify must declare at least one command — the gate needs something to run';
  for (const [name, cmd] of checks) {
    if (typeof cmd !== 'string' || cmd.trim() === '') return `verify.${name} must be a non-empty command string`;
  }

  // "Harness never merges its own PRs" is a standing constraint, not a preference.
  // Accepting false would make it a per-repo opinion one commit can flip.
  if (raw.delivery.never_merge !== true) {
    return 'delivery.never_merge must be true — the harness never merges its own PRs';
  }

  // The declared kind must have its block. `kind: 'github'` with only a jira block is
  // a half-finished edit whose every read comes back undefined, failing far from here.
  if (nullish(raw.source[raw.source.kind])) {
    return `source.kind is ${raw.source.kind} but no source.${raw.source.kind} block is present`;
  }

  if (raw.base.rules.length === 0) return 'base.rules must declare at least one rule';
  for (const [i, rule] of raw.base.rules.entries()) {
    if (typeOf(rule) !== 'object') return `base.rules[${i}] must be an object`;
    const isDefault = Object.hasOwn(rule, 'default');
    if (isDefault) {
      if (typeof rule.default !== 'string' || rule.default === '') return `base.rules[${i}].default must be a branch name`;
      continue;
    }
    if (typeof rule.when_epic !== 'string' || rule.when_epic === '') return `base.rules[${i}] needs when_epic or default`;
    if (typeof rule.branch !== 'string' || rule.branch === '') return `base.rules[${i}].branch must be a branch name`;
  }

  for (const [i, glob] of raw.off_limits.entries()) {
    if (typeof glob !== 'string' || glob.trim() === '') return `off_limits[${i}] must be a non-empty glob`;
    // A rule that matches outside the tree cannot protect anything inside it, and an
    // absolute rule stops matching the relative paths `git diff --name-only` reports.
    if (isAbsolute(glob) || glob.split('/').includes('..')) {
      return `off_limits[${i}] must be relative to the repo root and must not escape it: ${glob}`;
    }
  }

  // ASKED OF THE ROUTER RATHER THAN RE-STATED. `budgetUsdFor` already refuses a non-positive or
  // non-finite dollar figure, and a second copy of that rule here is the drift this key's own
  // absence was a case of. What the loader adds is WHERE it is refused: the router throws, and
  // at the top of an unattended tick an exception is a dead tick with no record, so it is caught
  // and reported as an error string like every other one in this file.
  if (!nullish(raw.budget_usd)) {
    try {
      budgetUsdFor(raw);
    } catch (e) {
      return `budget_usd: ${e.message}`;
    }
  }

  if (!nullish(raw.loop?.poll_interval_minutes)) {
    const n = raw.loop.poll_interval_minutes;
    // Refused, not coerced. A zero silently corrected to 30 is a config that reads as
    // applied and is not, and a hot loop is the specific failure being guarded.
    if (!Number.isFinite(n) || n <= 0) {
      return `loop.poll_interval_minutes must be a positive number of minutes, got ${JSON.stringify(n)}`;
    }
  }

  return null;
}

// Deep-freeze. The gate reads `off_limits` and `verify` to decide pass/fail; if a
// caller can mutate them mid-run, the record says a run was graded against rules that
// are no longer the ones in the file, and nothing in the artifact shows the swap.
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

const refuse = (error) => ({ ok: false, error, config: null });

// Loads and validates the config at `<repoRoot>/.alfred/config.json`.
//
// Reads ONLY the root it was given — no upward walk. A loader that searched upward
// would find this repo's config when run against a sandbox that has none, and grade
// the sandbox against skills' verify commands.
//
// Returns `{ ok, error, config }` and never throws: this runs at the top of an
// unattended tick, and an exception there kills the tick without a record of why.
export function loadConfig(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot === '') {
    return refuse('loadConfig requires a repo root path');
  }

  const path = join(repoRoot, CONFIG_RELATIVE_PATH);

  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return refuse(
      `no config at ${CONFIG_RELATIVE_PATH} under ${repoRoot} (${err?.code ?? 'unreadable'}) — ` +
        'refusing rather than inventing defaults for base branch, verify commands, or off-limits paths',
    );
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return refuse(`${CONFIG_RELATIVE_PATH} is not valid JSON: ${err?.message ?? 'parse failed'}`);
  }

  if (typeOf(raw) !== 'object') return refuse(`${CONFIG_RELATIVE_PATH} must contain a JSON object`);

  const structural = validateBlock(raw, SCHEMA, '');
  if (structural) return refuse(structural);

  const semantic = validateSemantics(raw);
  if (semantic) return refuse(semantic);

  // The one default, applied after validation so an explicit bad value is refused
  // rather than replaced.
  const config = deepFreeze({
    ...raw,
    loop: {
      blocked_label: 'alfred:blocked',
      ...(raw.loop ?? {}),
      poll_interval_minutes: raw.loop?.poll_interval_minutes ?? DEFAULT_POLL_INTERVAL_MINUTES,
    },
  });

  return { ok: true, error: null, config };
}

// Resolves the base branch for a work item. First match wins, in declared order —
// §4's rule, and not "most specific wins": for an epic named twice both readings look
// correct in isolation and give different answers.
//
// Returns null when nothing matches and no `{ default }` rule is declared. Null rather
// than 'master', because inventing the base is the TARS-1271 defect: that ticket's
// base was `feat/migrate-native-fetch-from-axios`, and a PR against master would have
// targeted the wrong tree.
export function resolveBase(config, { epic = null } = {}) {
  for (const rule of config?.base?.rules ?? []) {
    if (Object.hasOwn(rule, 'default')) return rule.default;
    // Guarded on a truthy epic: a prompt-sourced item has none, and falling through to
    // the first rule's branch would base it on whichever epic is listed first.
    if (epic && rule.when_epic === epic) return rule.branch;
  }
  return null;
}

// True when a repo-relative path is covered by any `off_limits` entry.
//
// Normalizes first because callers produce three shapes for one file — `git diff
// --name-only` gives repo-relative, bookkeeping gives `./`-prefixed, and a tool gives
// absolute. An unnormalized comparison reads "not off limits" and permits the write.
//
// The pattern side goes through `matchesPathPattern` rather than bare `matchesGlob` (#69):
// `matchesGlob('src/vendor/legacy.js', 'src/vendor/')` is false, and that trailing-slash form
// is what both fixture manifests ship. `bareNameIsSubtree` is set because this is a DENY
// list — an operator naming a directory here means the subtree, and the failure direction of
// reading it as one inode is silent permission. `lib/gate.mjs`'s `declaredScope` leaves the
// same flag at its default for the opposite reason.
//
// The `..`-escape check below stays HERE and is deliberately not pushed into the shared
// matcher: it needs `repoRoot` to mean anything, and the matcher has no repo.
export function isOffLimits(config, filePath, repoRoot = null) {
  if (typeof filePath !== 'string' || filePath === '') return false;

  let rel = filePath;
  if (isAbsolute(rel)) {
    if (!repoRoot) return false;
    rel = relative(repoRoot, rel);
    // Outside the repo entirely: no rule inside it applies.
    if (rel.startsWith(`..${sep}`) || rel === '..') return false;
  }
  rel = rel.split(sep).join('/').replace(/^\.\//, '');

  return (config?.off_limits ?? []).some((pattern) => matchesPathPattern(rel, pattern, { bareNameIsSubtree: true }));
}
