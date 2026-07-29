# Model-Tier Normalization + Live-Path Fingerprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tokens_directional` trustworthy enough to be a cost baseline — resolve every Anthropic model id form a real transcript carries to a tier (#18), and reach the peak-context fingerprint on the live collection path instead of only through the backfill CLI (#17).

**Architecture:** Two narrow changes at two existing seams. (#18) A new pure module `tools/lib/model-tier.mjs` exposes `normalizeModelId` + `tierForModelId`; `buildTokensDirectional`'s single lookup at `tokens-collect.mjs:350` calls it instead of testing `m in modelTierMap` directly. Normalization is restricted to *lossless respellings of the same model* — strip a leading `anthropic.`, strip a trailing `-YYYYMMDD` — plus explicit alias entries in `routing.json`. There is deliberately no family-substring fallback (see Global Constraints). (#17) `resolveTranscript` gains an `observedTotal` parameter; in loop mode it tries `discoverSubagentForRun` (the fingerprint matcher Task 3 of the prior plan built) and falls back to `discoverLoopTranscript` when there is no fingerprint to match against. Both changes are additive: no record-schema field is added, no caller signature breaks.

**Tech Stack:** Node 20+ ESM, `node:test` built-in runner, `node:assert/strict`. No new dependencies.

## Global Constraints

- **No new dependency in `package.json`.** Tests use the Node built-in test runner only (`node:test`, `node:assert/strict`) — this is how every existing test in `harness-core/test/` is written.
- **Never guess a tier from a family substring.** Do NOT implement "id contains `sonnet` → MID". Date-stripping and `anthropic.`-stripping are lossless respellings of one specific model; a substring match is a guess that would silently mis-tier — and mis-price — a future `claude-sonnet-9` at today's rates. It would also defeat the rename tripwire in `test/config.test.mjs:75`, whose entire purpose is to fail loudly on an unrecognized flagship. An unrecognized id must stay unrecognized.
- **Non-Anthropic ids must stay `UNKNOWN`.** Real local transcripts carry `qwen.qwen3-coder-30b-a3b-v1:0` and `deepseek.r1-v1:0`. They have no Anthropic tier and no Anthropic price; resolving them to a tier would be a pricing defect. Only the exact prefix `anthropic.` is stripped — never a generic `<vendor>.` prefix.
- **Determinism over LLM.** Every behaviour in this plan is a pure function of its inputs. No subagent, no model call, no network.
- **Token enrichment is best-effort and must never fail a run.** `collectAndStamp` is already wrapped in `try {} catch {}` at both the phase-end and run-end call sites. Nothing added here may throw out of `resolveTranscript`, `collectForRun`, or `buildTokensDirectional` — every failure mode returns a structured `{ ok: false, error: { code, detail } }` result, matching the existing convention in the file.
- **Records stay schema-valid.** `run-record.schema.json` is `additionalProperties: false`, and its `tokens_directional` subschema is too. Do NOT add a field to the record. The new `via` provenance value (Task 3) travels in the CLI's `emit(...)` output only.
- **Advisory findings never fail a run** — unchanged from the prior plan; nothing here touches `preflight`.
- **Do not change `FINGERPRINT_BAND`** (`{ lo: 0.95, hi: 1.05 }`) or the fingerprint's matching logic. Task 3 changes *who calls* `discoverSubagentForRun`, never how it decides.

## Baseline

`npm test` from `harness-core/` at plan start: **384 pass / 0 fail**. Every task's test step is a delta on that number — re-measure rather than trusting it if the tree has moved.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `harness-core/tools/lib/model-tier.mjs` | **Create.** Pure model-id → tier resolution: `normalizeModelId`, `tierForModelId`. No I/O, no imports beyond none. | 1 |
| `harness-core/test/model-tier.test.mjs` | **Create.** Unit tests for the module, including the real id forms observed in local transcripts and the must-stay-unknown cases. | 1 |
| `harness-core/config/routing.json` | **Modify.** Add three bare-alias entries to `model_id_to_tier`. | 2 |
| `harness-core/tools/lib/tokens-collect.mjs` | **Modify.** `buildTokensDirectional` uses `tierForModelId` (Task 2). `resolveTranscript` + `collectForRun` accept `observedTotal` and prefer the fingerprint in loop mode (Task 3). | 2, 3 |
| `harness-core/test/config.test.mjs` | **Modify.** Extend the rename tripwire to the dated and `anthropic.`-prefixed forms; assert the bare aliases agree with `tier_models`. | 2 |
| `harness-core/test/tokens-collect.test.mjs` | **Modify.** Builder tests for normalized ids (Task 2); `resolveTranscript` fingerprint-preference tests (Task 3). | 2, 3 |
| `harness-core/tools/harness.mjs` | **Modify.** `collectAndStamp` threads the record's `tokens_observed.total` into `collectForRun`; `via` joins the emitted summary. | 3 |

---

### Task 1: `model-tier.mjs` — pure id normalization and tier lookup

**Files:**
- Create: `harness-core/tools/lib/model-tier.mjs`
- Test: `harness-core/test/model-tier.test.mjs`

**Interfaces:**
- Consumes: nothing (no imports).
- Produces, both relied on by Task 2:
  - `normalizeModelId(id: unknown) => string | null` — returns the canonical spelling of `id`, or `null` for a non-string input. Never throws.
  - `tierForModelId(id: unknown, map: object) => string | null` — returns the tier string from `map`, or `null` when unresolvable. Never throws.

**Context:** the only reason this module exists is that 46.6% of usage lines in real local transcripts (3,583 of 7,684 sampled) carry a model id absent from `model_id_to_tier` — `claude-sonnet-4-5-20250929` alone accounts for 1,739. The map holds only undated, unprefixed ids.

- [ ] **Step 1: Write the failing test**

Create `harness-core/test/model-tier.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelId, tierForModelId } from '../tools/lib/model-tier.mjs';

// A stand-in for routing.json's model_id_to_tier, holding only the undated,
// unprefixed spellings the real map holds — the whole point is that dated and
// prefixed ids must resolve THROUGH this shape, not require entries of their own.
const MAP = {
  'claude-opus-5': 'HIGH',
  'claude-opus-4-8': 'HIGH',
  'claude-sonnet-5': 'MID',
  'claude-sonnet-4-6': 'MID',
  'claude-sonnet-4-5': 'MID',
  'claude-haiku-4-5': 'LOW',
  '<synthetic>': 'LOW',
  opus: 'HIGH',
  sonnet: 'MID',
  haiku: 'LOW',
};

test('an id already in the map resolves without any normalization', () => {
  assert.equal(tierForModelId('claude-sonnet-4-6', MAP), 'MID');
  // The sentinel is a literal map key and must survive untouched — it is not a
  // model name and must never be mangled by the stripping rules.
  assert.equal(tierForModelId('<synthetic>', MAP), 'LOW');
  assert.equal(normalizeModelId('<synthetic>'), '<synthetic>');
});

test('a trailing -YYYYMMDD date suffix is stripped — the dominant unresolved form', () => {
  // 1,739 usage lines in the sampled local transcripts carry exactly this id.
  assert.equal(normalizeModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(tierForModelId('claude-sonnet-4-5-20250929', MAP), 'MID');
  assert.equal(tierForModelId('claude-haiku-4-5-20251001', MAP), 'LOW');
});

test('a leading anthropic. prefix is stripped, and composes with date-stripping', () => {
  assert.equal(normalizeModelId('anthropic.claude-sonnet-4-6'), 'claude-sonnet-4-6');
  assert.equal(tierForModelId('anthropic.claude-sonnet-5', MAP), 'MID');
  // Both rules on one id — the Bedrock-style dated form.
  assert.equal(normalizeModelId('anthropic.claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(tierForModelId('anthropic.claude-haiku-4-5-20251001', MAP), 'LOW');
});

test('bare tier aliases resolve, because transcripts really do carry them', () => {
  for (const [id, tier] of [['opus', 'HIGH'], ['sonnet', 'MID'], ['haiku', 'LOW']]) {
    assert.equal(tierForModelId(id, MAP), tier);
  }
});

test('a non-Anthropic vendor prefix is NOT stripped and stays unresolved', () => {
  // These are real ids in local transcripts. They have no Anthropic tier and no
  // Anthropic price; resolving them to one would be a pricing defect, so only the
  // exact "anthropic." prefix is ever removed.
  assert.equal(normalizeModelId('qwen.qwen3-coder-30b-a3b-v1:0'), 'qwen.qwen3-coder-30b-a3b-v1:0');
  assert.equal(tierForModelId('qwen.qwen3-coder-30b-a3b-v1:0', MAP), null);
  assert.equal(tierForModelId('deepseek.r1-v1:0', MAP), null);
});

test('an unrecognized Anthropic-shaped id stays unresolved — no family guessing', () => {
  // This is the rename tripwire's whole reason to exist: a future flagship must
  // come back null and force complete:false, NOT get silently mis-tiered (and
  // therefore mis-priced) by a substring match on "sonnet" or "opus".
  assert.equal(tierForModelId('claude-sonnet-9', MAP), null);
  assert.equal(tierForModelId('claude-opus-9-9', MAP), null);
  assert.equal(tierForModelId('some-unrecognized-model-99', MAP), null);
});

test('a partial or malformed date suffix is not treated as a date', () => {
  // Only a full 8-digit trailing group is a date. Stripping anything shorter
  // would eat a version segment: claude-opus-4-8 must not become claude-opus-4.
  assert.equal(normalizeModelId('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(tierForModelId('claude-opus-4-8', MAP), 'HIGH');
  assert.equal(normalizeModelId('claude-sonnet-4-5-2025'), 'claude-sonnet-4-5-2025');
  assert.equal(tierForModelId('claude-sonnet-4-5-2025', MAP), null);
});

test('garbage input returns null instead of throwing — collection must never crash', () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(normalizeModelId(bad), null);
    assert.equal(tierForModelId(bad, MAP), null);
  }
  // A missing or empty map is a degradation, not a crash.
  assert.equal(tierForModelId('claude-opus-5', {}), null);
  assert.equal(tierForModelId('claude-opus-5', undefined), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd harness-core && node --test test/model-tier.test.mjs`
Expected: FAIL — cannot find module `../tools/lib/model-tier.mjs`.

- [ ] **Step 3: Write the implementation**

Create `harness-core/tools/lib/model-tier.mjs`:

```javascript
// Model-id → tier resolution for directional token accounting.
//
// routing.json's model_id_to_tier holds ONE canonical spelling per model
// (undated, unprefixed). Real transcripts carry three more spellings of the
// same models, and 46.6% of usage lines in a local sample (3,583 of 7,684)
// carried an id the raw map could not resolve — claude-sonnet-4-5-20250929
// alone was 1,739 of them. Each unresolved id forces
// tokens_directional.complete:false on an otherwise perfect capture, and
// leaves the tokens unpriceable.
//
// WHAT THIS DELIBERATELY DOES NOT DO: guess a tier from a family substring
// ("contains sonnet → MID"). Date-stripping and anthropic.-stripping are
// lossless respellings of one specific model — the id still names exactly the
// model the map has an entry and a price for. A substring match is a different
// thing entirely: a guess. It would price a future claude-sonnet-9 at today's
// sonnet rates and, worse, silence the rename tripwire in config.test.mjs that
// exists precisely to fail loudly when a new flagship appears. An id this
// module does not recognize must come back null.
//
// Pure: no I/O, no imports, never throws. Token collection must never crash the
// run it is enriching.

// Bedrock-style vendor prefix. ONLY this exact prefix is stripped — a generic
// /^\w+\./ would also strip qwen. and deepseek., which are real ids in local
// transcripts that genuinely have no Anthropic tier or price.
const VENDOR_PREFIX = 'anthropic.';

// A trailing model snapshot date: exactly 8 digits at the end, e.g. the -20250929
// of claude-sonnet-4-5-20250929. Anchored and fixed-width so it cannot eat a
// version segment — claude-opus-4-8 keeps its -8.
const DATE_SUFFIX_RE = /-\d{8}$/;

/**
 * Canonical spelling of a model id: `anthropic.` prefix removed, trailing
 * -YYYYMMDD date removed. Returns null for anything that is not a string.
 * An id needing no changes is returned unchanged (including the '<synthetic>'
 * sentinel, which is a literal map key rather than a model name).
 */
export function normalizeModelId(id) {
  if (typeof id !== 'string') return null;
  let out = id;
  if (out.startsWith(VENDOR_PREFIX)) out = out.slice(VENDOR_PREFIX.length);
  return out.replace(DATE_SUFFIX_RE, '');
}

/**
 * Look up a model id's tier in a model_id_to_tier map, trying the id exactly as
 * given before its normalized spelling. Exact-first matters: it lets the map
 * carry an entry for a literal id that normalization would otherwise rewrite.
 * Returns null when unresolvable — the caller reports that as a degradation.
 */
export function tierForModelId(id, map) {
  if (typeof id !== 'string' || map === null || typeof map !== 'object') return null;
  if (Object.hasOwn(map, id)) return map[id];
  const normalized = normalizeModelId(id);
  if (normalized !== null && normalized !== id && Object.hasOwn(map, normalized)) {
    return map[normalized];
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd harness-core && node --test test/model-tier.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the guard is load-bearing (perturbation)**

Temporarily change `DATE_SUFFIX_RE` to `/-\d+$/` and re-run. Expected: the
"partial or malformed date suffix" test FAILS (`claude-opus-4-8` → `claude-opus-4`),
proving the fixed 8-digit width is doing real work. Revert the change and confirm
the suite is green again before committing.

- [ ] **Step 6: Run the full suite**

Run: `cd harness-core && npm test`
Expected: 392 pass / 0 fail (384 baseline + 8 new). No pre-existing test changes behaviour — nothing imports this module yet.

- [ ] **Step 7: Commit**

```bash
git add harness-core/tools/lib/model-tier.mjs harness-core/test/model-tier.test.mjs
git commit -m "harness-core: add model-tier id normalization (#18)"
```

---

### Task 2: Resolve normalized ids in `buildTokensDirectional`, and close the tripwire gap

**Files:**
- Modify: `harness-core/config/routing.json` (`model_id_to_tier`)
- Modify: `harness-core/tools/lib/tokens-collect.mjs:350` (the `unknown` filter) and its doc comment at 337
- Modify: `harness-core/test/config.test.mjs:75-92` (the rename tripwire)
- Modify: `harness-core/test/tokens-collect.test.mjs` (builder tests)

**Interfaces:**
- Consumes from Task 1: `tierForModelId(id, map) => string | null`.
- Produces: no signature change. `buildTokensDirectional({ result, modelTierMap, now })` keeps its exact shape and return contract; only which ids it treats as unknown changes.

**Context:** `buildTokensDirectional` has exactly one tier lookup — `tokens-collect.mjs:350`:
```javascript
const unknown = Object.keys(result.by_model).filter((m) => !(m in modelTierMap));
```
That single line is why a dated id degrades a healthy run to `complete: false` with an `unknown_model` note. The map itself is fine; the lookup is too literal.

Note the pre-existing tripwire test at `test/config.test.mjs:75`, `'every model id the harness itself spawns is present in model_id_to_tier'`. Its `spawned` array lists **only undated ids**, so the test written specifically to catch model-id drift structurally cannot catch this class — it asserts against the form the *map* has, not the form *transcripts* carry. Extending it is part of this task.

- [ ] **Step 1: Write the failing tests**

First, in `harness-core/test/tokens-collect.test.mjs`, add after the existing
`'a populated by_model containing an unknown model id is still not complete'` test.
The file already defines the helpers `okResult`, `sums`, and `NOW` — reuse them, do not redeclare:

```javascript
test('a dated model id resolves through normalization and stays complete', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({ 'claude-sonnet-4-5-20250929': { ...sums } }),
    modelTierMap: { 'claude-sonnet-4-5': 'MID' },
    now: NOW,
  });
  // 1,739 usage lines in the sampled local transcripts carry exactly this id.
  // Before normalization this was an unknown_model degradation on a perfect capture.
  assert.equal(tokens_directional.complete, true);
  assert.equal(note, null);
  // The tokens stay filed under the id the transcript actually used — normalization
  // is a lookup convenience, never a rewrite of captured data.
  assert.equal(tokens_directional.by_model['claude-sonnet-4-5-20250929'].input, 100);
  assert.equal(tokens_directional.by_model['claude-sonnet-4-5'], undefined);
});

test('an anthropic.-prefixed id resolves through normalization too', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({ 'anthropic.claude-sonnet-4-6': { ...sums } }),
    modelTierMap: { 'claude-sonnet-4-6': 'MID' },
    now: NOW,
  });
  assert.equal(tokens_directional.complete, true);
  assert.equal(note, null);
});

test('a genuinely unrecognized id is still incomplete — normalization is not family guessing', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({ 'claude-sonnet-9': { ...sums } }),
    modelTierMap: { 'claude-sonnet-4-6': 'MID' },
    now: NOW,
  });
  // A future flagship must still degrade loudly. If this ever passes as complete,
  // normalization has grown a substring fallback and is mis-pricing new models.
  assert.equal(tokens_directional.complete, false);
  assert.equal(note.code, 'unknown_model');
  assert.match(note.detail, /claude-sonnet-9/);
});

test('a non-Anthropic vendor id is reported unknown, not silently tiered', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({ 'qwen.qwen3-coder-30b-a3b-v1:0': { ...sums } }),
    modelTierMap: { 'claude-sonnet-4-6': 'MID' },
    now: NOW,
  });
  assert.equal(tokens_directional.complete, false);
  assert.equal(note.code, 'unknown_model');
});
```

Second, in `harness-core/test/config.test.mjs`, **replace** the body of the
existing `'every model id the harness itself spawns is present in model_id_to_tier'`
test (currently at lines 75-92) with this. Keep the test name — it is the same
tripwire, widened to the forms transcripts actually carry:

```javascript
test('every model id the harness itself spawns is present in model_id_to_tier', () => {
  const { routing } = resolveConfig({ env: {}, userFile: '/nonexistent' });
  const map = routing.model_id_to_tier;
  // A run whose transcript carries an id this map cannot resolve is reported
  // complete:false by buildTokensDirectional even when the capture was perfect.
  // A measured M-size run lost its whole by_model breakdown to a flagship rename;
  // this list is the tripwire so the next rename fails here, loudly, instead.
  //
  // Every id below was observed in a real local transcript. The dated and
  // anthropic.-prefixed spellings are the ones this test USED to miss: it listed
  // only undated ids, so it asserted against the form the map has rather than the
  // form transcripts carry — and could not have caught the 46.6%-unresolved bug
  // it was written to catch. Resolution goes through tierForModelId, so a dated id
  // passes via normalization without needing its own entry.
  const spawned = [
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    '<synthetic>',
    // dated snapshots
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001',
    // Bedrock-style vendor prefix, plain and dated
    'anthropic.claude-sonnet-4-6',
    'anthropic.claude-sonnet-5',
    'anthropic.claude-haiku-4-5-20251001',
    // bare tier aliases — what tier_models spawns with
    'opus',
    'sonnet',
    'haiku',
  ];
  const unresolved = spawned.filter((id) => tierForModelId(id, map) === null);
  assert.deepEqual(unresolved, [], `model ids spawned by harness skills but unresolvable: ${unresolved.join(', ')}`);
  // Every resolved tier must also be a priced tier, or the id is unpriceable.
  for (const id of spawned) {
    const tier = tierForModelId(id, map);
    assert.ok(routing.tier_prices_usd_per_mtok[tier], `${id} resolves to unpriced tier ${tier}`);
  }
});

test('bare tier aliases in model_id_to_tier agree with tier_models', () => {
  const { routing } = resolveConfig({ env: {}, userFile: '/nonexistent' });
  // tier_models is the source of truth for which model each tier spawns
  // (LOW: haiku, MID: sonnet, HIGH: opus). Transcripts sometimes carry that bare
  // alias as the model id, so model_id_to_tier needs the inverse entries — and
  // the two maps must not drift apart.
  for (const [tier, alias] of Object.entries(routing.tier_models)) {
    assert.equal(routing.model_id_to_tier[alias], tier, `alias ${alias} should map to ${tier}`);
  }
});
```

Add `tierForModelId` to that file's imports:
```javascript
import { tierForModelId } from '../tools/lib/model-tier.mjs';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd harness-core && node --test test/tokens-collect.test.mjs test/config.test.mjs`
Expected: FAIL. The dated/prefixed builder tests fail with `complete: false` and an
`unknown_model` note (the raw `in` check does not normalize). The widened tripwire
fails on the bare aliases `opus`/`sonnet`/`haiku`, which are genuinely absent from
`model_id_to_tier`, and the new alias-agreement test fails for the same reason.

- [ ] **Step 3: Add the bare aliases to `routing.json`**

In `harness-core/config/routing.json`, add three entries to `model_id_to_tier`,
placed immediately after `"<synthetic>": "LOW"` as its own group. Keep the file's
existing 2-space indentation and trailing-newline style:

```json
    "<synthetic>": "LOW",
    "opus": "HIGH",
    "sonnet": "MID",
    "haiku": "LOW"
```

These three mirror `tier_models` (`LOW: haiku`, `MID: sonnet`, `HIGH: opus`) — they
are not new policy, they are the inverse of a mapping the file already asserts, and
transcripts do carry the bare alias as a model id (142 `sonnet`, 77 `haiku`, 39
`opus` lines in the local sample). Do NOT add dated or `anthropic.`-prefixed
entries: those resolve through normalization, and enumerating them would put the
map back in the business of tracking every snapshot date.

- [ ] **Step 4: Wire the lookup through `tierForModelId`**

In `harness-core/tools/lib/tokens-collect.mjs`, add to the existing imports at the
top of the file:

```javascript
import { tierForModelId } from './model-tier.mjs';
```

Replace line 350:

```javascript
  const unknown = Object.keys(result.by_model).filter((m) => !(m in modelTierMap));
```

with:

```javascript
  // Resolution is normalizing, not literal: transcripts carry dated
  // (claude-sonnet-4-5-20250929), anthropic.-prefixed, and bare-alias spellings of
  // models the map holds one canonical entry for. A literal `m in modelTierMap`
  // left 46.6% of real usage lines unresolved and degraded healthy runs to
  // complete:false. See model-tier.mjs for why there is no family-substring
  // fallback: an id that is genuinely new must still land here and degrade loudly.
  const unknown = Object.keys(result.by_model).filter((m) => tierForModelId(m, modelTierMap) === null);
```

Then update the `buildTokensDirectional` doc comment at line 337 — it currently says
`complete` requires "every model id seen is present in `modelTierMap`". Change that
clause to "every model id seen RESOLVES in `modelTierMap` (exactly, or via
`model-tier.mjs` normalization)". Leave the rest of that comment alone; the
`empty_collection` / `unknown_model` reasoning it documents is unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd harness-core && node --test test/tokens-collect.test.mjs test/config.test.mjs`
Expected: PASS, including the four new builder tests and both config tests.

- [ ] **Step 6: Prove the wiring is load-bearing (perturbation)**

Revert only line 350 to the literal `!(m in modelTierMap)` form and re-run the two
test files. Expected: the dated and `anthropic.`-prefixed builder tests FAIL. Restore
the `tierForModelId` call. Then separately delete the `"sonnet": "MID"` entry from
`routing.json` and confirm the alias-agreement test FAILS naming `sonnet`; restore it.
Both perturbations must fail before you trust either guard.

- [ ] **Step 7: Verify against a real transcript**

Confirm the fix works on real data, not just fixtures:

```bash
cd harness-core && node -e "
const { readFileSync } = require('node:fs');
import('./tools/lib/model-tier.mjs').then(({ tierForModelId }) => {
  const map = JSON.parse(readFileSync('config/routing.json','utf8')).model_id_to_tier;
  const ids = ['claude-sonnet-4-6','claude-sonnet-4-5-20250929','claude-sonnet-5','claude-opus-5','claude-opus-4-6','claude-opus-4-8','claude-haiku-4-5-20251001','sonnet','anthropic.claude-sonnet-4-6','haiku','<synthetic>','anthropic.claude-haiku-4-5-20251001','opus','anthropic.claude-sonnet-5','qwen.qwen3-coder-30b-a3b-v1:0','deepseek.r1-v1:0'];
  for (const id of ids) console.log(String(tierForModelId(id, map)).padEnd(8), id);
});
"
```

Expected: all fourteen Anthropic forms print a tier; `qwen.…` and `deepseek.…` print
`null`. Those sixteen ids are the complete set observed in the local transcript
sample, so a tier on every Anthropic one means zero unresolved Anthropic usage lines.

- [ ] **Step 8: Run the full suite**

Run: `cd harness-core && npm test`
Expected: 397 pass / 0 fail (392 after Task 1 + 4 builder + 1 alias-agreement; the
widened tripwire replaces a test rather than adding one). Re-measure rather than
trusting this arithmetic — report the actual delta.

- [ ] **Step 9: Commit**

```bash
git add harness-core/config/routing.json harness-core/tools/lib/tokens-collect.mjs harness-core/test/config.test.mjs harness-core/test/tokens-collect.test.mjs
git commit -m "harness-core: resolve dated/prefixed/alias model ids to tiers (#18)"
```

---

### Task 3: Reach the peak-context fingerprint on the live collection path

**Files:**
- Modify: `harness-core/tools/lib/tokens-collect.mjs` — `resolveTranscript` (lines 312-321) and `collectForRun` (387-394)
- Modify: `harness-core/tools/harness.mjs` — `collectAndStamp` (76-100)
- Test: `harness-core/test/tokens-collect.test.mjs`

**Interfaces:**
- Consumes: `discoverSubagentForRun({ subagentsDir, observedTotal }) => { ok, path, error }` and `discoverLoopTranscript(subagentsDir) => { ok, path, error }` — both already exported from `tokens-collect.mjs`, both unchanged by this task.
- Produces:
  - `resolveTranscript({ transcript, mode, subagentsDir, projectDir, cwd, home, observedTotal })` — gains the optional `observedTotal`, and its result gains a `via` field: `'explicit' | 'fingerprint' | 'newest_mtime'`.
  - `collectForRun({ ..., observedTotal })` — gains the same optional parameter, and its return gains `via`, passed straight through.

**Context:** `discoverSubagentForRun` — the fingerprint matcher — is currently
reachable **only** through the `backfill-directional` CLI subcommand, whose sole
non-test caller is `backfillDirectional`. `resolveTranscript`, which every live
collection goes through (`collectAndStamp` → `collectForRun` → `resolveTranscript`,
called from phase-end, run-end, and `tokens-collect`), dispatches only to the two
newest-mtime discoverers. So the live path attributes by file mtime, which is
correct only while exactly one run is in flight. This is not a regression — it was
backfill-only at the base commit too.

`discoverSubagentForRun` returns `{ code: 'no_fingerprint' }` when
`observedTotal <= 0`, and a phase run legitimately has no `tokens_observed` (only a
loop tick gets one, from `record-observed-tokens` in loop step 6, which runs before
`run-end` in step 7). **So the fingerprint must be a preference, not a requirement:**
fall back to newest-mtime rather than failing. A fallback that failed instead would
break every phase run's directional capture.

- [ ] **Step 1: Write the failing test**

Add to `harness-core/test/tokens-collect.test.mjs`. The file's import block from
`../tools/lib/tokens-collect.mjs` (lines 7-16) already lists `collectFromFile`,
`discoverLoopTranscript`, and `discoverStandaloneTranscript`; add the one missing
name, `resolveTranscript`, to it. Its `node:fs` import already includes
`mkdtempSync`, `writeFileSync`, and `utimesSync`, and `node:os` already provides
`tmpdir` — the fixture below needs no further imports.

These tests need a subagents dir holding two transcripts where **newest-mtime and
the fingerprint disagree** — that divergence is the whole point, and a fixture where
both agree would pass with the bug still present:

```javascript
// Build a subagents dir with two agent transcripts whose peak single-call context
// differs, and whose mtimes are set so the NEWER file is the WRONG one for the
// given fingerprint. Any test using this fixture fails if resolution falls back to
// mtime, which is exactly the property under test.
function twoAgentFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-fp-'));
  const mk = (name, peak, mtimeSec) => {
    // One usage line whose input tokens set the transcript's peak_context.
    // peak_context is contextTotal(usage) — the SUM of all four direction fields,
    // not input alone — so every other field must be 0 for the peak to equal
    // `peak` exactly. A stray output_tokens: 1 would make it peak+1.
    const line = JSON.stringify({
      timestamp: '2026-07-28T10:00:00.000Z',
      message: { model: 'claude-opus-4-8', usage: { input_tokens: peak, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    writeFileSync(join(dir, `${name}.jsonl`), line + '\n');
    writeFileSync(join(dir, `${name}.meta.json`), '{}\n');
    utimesSync(join(dir, `${name}.jsonl`), mtimeSec, mtimeSec);
  };
  // agent-old holds the fingerprint we will match (100000) but is the OLDER file.
  mk('agent-old', 100000, 1000);
  // agent-new is newer by mtime and would win on the old code path.
  mk('agent-new', 500000, 2000);
  return dir;
}

test('loop mode prefers the peak-context fingerprint over newest mtime', () => {
  const dir = twoAgentFixture();
  const r = resolveTranscript({ mode: 'loop', subagentsDir: dir, observedTotal: 100000 });
  assert.equal(r.ok, true);
  // The fingerprint's transcript wins even though agent-new.jsonl is newer. Under
  // the previous behaviour this resolved to agent-new.jsonl and mis-attributed
  // one run's tokens to another whenever two runs overlapped.
  assert.equal(r.path, join(dir, 'agent-old.jsonl'));
  assert.equal(r.via, 'fingerprint');
});

test('loop mode falls back to newest mtime when there is no fingerprint to match', () => {
  const dir = twoAgentFixture();
  // A phase run has no tokens_observed at all — only a loop tick records one. The
  // fingerprint must therefore be a PREFERENCE: failing here instead of falling
  // back would break directional capture for every phase run.
  for (const observedTotal of [undefined, 0, null]) {
    const r = resolveTranscript({ mode: 'loop', subagentsDir: dir, observedTotal });
    assert.equal(r.ok, true, `observedTotal ${observedTotal} should still resolve`);
    assert.equal(r.path, join(dir, 'agent-new.jsonl'));
    assert.equal(r.via, 'newest_mtime');
  }
});

test('loop mode falls back to newest mtime when the fingerprint matches nothing', () => {
  const dir = twoAgentFixture();
  // An observed total far outside FINGERPRINT_BAND of every candidate. Better to
  // attribute by mtime than to leave by_model empty — an empty stamp is the
  // failure mode this whole line of work exists to eliminate.
  const r = resolveTranscript({ mode: 'loop', subagentsDir: dir, observedTotal: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.path, join(dir, 'agent-new.jsonl'));
  assert.equal(r.via, 'newest_mtime');
});

test('an explicit transcript path still wins over every discovery route', () => {
  const r = resolveTranscript({ transcript: '/tmp/explicit.jsonl', mode: 'loop', subagentsDir: '/nope', observedTotal: 100000 });
  assert.equal(r.path, '/tmp/explicit.jsonl');
  assert.equal(r.via, 'explicit');
});

test('standalone mode is untouched by the fingerprint preference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-fp-standalone-'));
  writeFileSync(join(dir, 'session.jsonl'), '\n');
  // The fingerprint matcher only knows about agent-*.jsonl in a subagents dir;
  // a standalone run has no such directory, so passing an observedTotal must not
  // change its resolution.
  const r = resolveTranscript({ projectDir: dir, observedTotal: 100000 });
  assert.equal(r.ok, true);
  assert.equal(r.path, join(dir, 'session.jsonl'));
  assert.equal(r.via, 'newest_mtime');
});

test('a loop-mode resolve with no subagents dir still reports a structured failure', () => {
  const r = resolveTranscript({ mode: 'loop', observedTotal: 100000 });
  assert.equal(r.ok, false);
  assert.equal(r.path, null);
  assert.equal(r.error.code, 'not_found');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd harness-core && node --test test/tokens-collect.test.mjs`
Expected: FAIL — the fingerprint-preference test resolves to `agent-new.jsonl`
(mtime wins) and `r.via` is `undefined` everywhere.

- [ ] **Step 3: Implement the fingerprint preference in `resolveTranscript`**

In `harness-core/tools/lib/tokens-collect.mjs`, replace `resolveTranscript`
(lines 312-321) and its doc comment with:

```javascript
/**
 * Resolve which transcript to read for a run:
 *  - explicit `transcript` path wins;
 *  - `mode: "loop"` prefers the peak-context fingerprint match against
 *    `observedTotal`, falling back to the newest agent-*.jsonl in `subagentsDir`;
 *  - otherwise standalone: the newest top-level .jsonl in `projectDir`, or in
 *    the project dir derived from `cwd` when `projectDir` is not given.
 *
 * The fingerprint is a PREFERENCE, not a requirement. `discoverSubagentForRun`
 * needs a positive `tokens_observed.total` to match against, and only a loop tick
 * has one (recorded by record-observed-tokens in loop step 6, before run-end in
 * step 7) — a plain phase run has none. Failing without a fingerprint would break
 * directional capture for every phase run, so a missing or unmatched fingerprint
 * degrades to newest-mtime rather than to nothing.
 *
 * Why prefer it at all: newest-mtime is only correct while exactly one run is in
 * flight. With two overlapping runs the newest file belongs to whichever sibling
 * wrote last, and a run gets another run's tokens. The fingerprint is an identity
 * check, so it stays correct under overlap.
 *
 * Returns a discovery result `{ ok, path, error, via }`, where `via` is
 * 'explicit' | 'fingerprint' | 'newest_mtime' — provenance for the CLI's output.
 * It is NOT written to the run record: run-record.schema.json's
 * tokens_directional subschema is additionalProperties:false.
 */
export function resolveTranscript({ transcript, mode, subagentsDir, projectDir, cwd, home, observedTotal } = {}) {
  if (transcript) return { ok: true, path: transcript, error: null, via: 'explicit' };
  if (mode === 'loop') {
    if (!subagentsDir) return { ok: false, path: null, error: { code: 'not_found', detail: 'loop mode requires a subagents dir' }, via: null };
    if (Number.isFinite(observedTotal) && observedTotal > 0) {
      const fingerprinted = discoverSubagentForRun({ subagentsDir, observedTotal });
      if (fingerprinted.ok) return { ...fingerprinted, via: 'fingerprint' };
      // no_fingerprint / not_found both fall through to mtime, deliberately.
    }
    return { ...discoverLoopTranscript(subagentsDir), via: 'newest_mtime' };
  }
  const dir = projectDir ?? (cwd ? projectDirForCwd(cwd, { home }) : null);
  if (!dir) return { ok: false, path: null, error: { code: 'not_found', detail: 'no project dir or cwd to discover a standalone transcript' }, via: null };
  return { ...discoverStandaloneTranscript(dir), via: 'newest_mtime' };
}
```

`discoverSubagentForRun` is declared later in the file than `resolveTranscript`;
that is fine, function declarations hoist within an ES module.

- [ ] **Step 4: Thread `observedTotal` through `collectForRun`**

In the same file, change `collectForRun`'s signature to accept `observedTotal` and
pass it to `resolveTranscript`, and surface `via` on the return. Replace lines
387-394 with:

```javascript
export function collectForRun({ transcript, mode, subagentsDir, projectDir, cwd, home, start, end, gapCapMs, modelTierMap, observedTotal, now = new Date() } = {}) {
  const resolved = resolveTranscript({ transcript, mode, subagentsDir, projectDir, cwd, home, observedTotal });
  const result = resolved.ok
    ? collectFromFile(resolved.path, { start, end, gapCapMs })
    : { ok: false, by_model: {}, error: resolved.error };
  const built = buildTokensDirectional({ result, modelTierMap, now });
  return { ...built, source: resolved.ok ? resolved.path : null, via: resolved.via ?? null, result };
}
```

- [ ] **Step 5: Supply `observedTotal` from the record in `collectAndStamp`**

In `harness-core/tools/harness.mjs`, `collectAndStamp` already reads the record
into `record` at the top. Add the `observedTotal` argument to its `collectForRun`
call, immediately after the `modelTierMap` line:

```javascript
    modelTierMap: routing.model_id_to_tier ?? {},
    // The Agent-tool subagent_tokens tag, when an orchestrator recorded one — the
    // fingerprint discoverSubagentForRun matches a transcript's peak_context
    // against. Absent on a plain phase run, which degrades to newest-mtime.
    observedTotal: record.tokens_observed?.total ?? null,
```

Then destructure and return `via` so the CLI reports how attribution happened.
Change the destructuring line to include it:

```javascript
  const { tokens_directional, note, source, via } = collectForRun({
```

and the return statement to:

```javascript
  return { complete: tokens_directional.complete, degraded: !!note, source, via };
```

`via` reaches the operator through `emit({ ok: true, ...summary, tokens_directional })`
in the `tokens-collect` case. It is not added to the record — the schema forbids it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd harness-core && node --test test/tokens-collect.test.mjs`
Expected: PASS, including all six new tests.

- [ ] **Step 7: Prove the preference is load-bearing (perturbation)**

Comment out the `if (Number.isFinite(observedTotal) && observedTotal > 0) { … }`
block in `resolveTranscript` and re-run. Expected: the
`'prefers the peak-context fingerprint over newest mtime'` test FAILS, resolving to
`agent-new.jsonl`. That failure is the evidence the fingerprint is genuinely on the
live path now. Restore the block.

Then, separately, make the fallback a hard failure (`return fingerprinted` instead
of falling through) and re-run. Expected: the two fallback tests FAIL — confirming
they cover the phase-run case that a naive "fingerprint or nothing" implementation
would break.

- [ ] **Step 8: Run the full suite**

Run: `cd harness-core && npm test`
Expected: 403 pass / 0 fail (397 after Task 2 + 6 new). Re-measure and report the
actual number. Pay attention to `test/tokens-backfill.test.mjs` — it exercises
`backfillDirectional`, which calls `discoverSubagentForRun` directly and is
untouched by this task; it must stay green.

- [ ] **Step 9: Commit**

```bash
git add harness-core/tools/lib/tokens-collect.mjs harness-core/tools/harness.mjs harness-core/test/tokens-collect.test.mjs
git commit -m "harness-core: prefer peak-context fingerprint on the live collect path (#17)"
```

---

## Verification Bar

All four must hold before this plan is called done. Run them yourself — do not accept a subagent's report as evidence.

1. **Suite green with a real delta.** `cd harness-core && npm test` → 0 fail, and the pass count is the 384 baseline plus the tests this plan added. Report the measured number, not the predicted one.

2. **Every Anthropic id form in the local transcript sample resolves to a priced tier**, and `qwen.…` / `deepseek.…` resolve to `null`. Task 2 Step 7 is the check; re-run it against the committed `routing.json`.

3. **The fingerprint is demonstrably on the live path.** With the fixture where newest-mtime and the fingerprint disagree, `collectForRun({ mode: 'loop', subagentsDir, observedTotal })` returns the fingerprint's transcript and `via: 'fingerprint'`. Then perturb: disable the preference block and confirm the assertion fails. A guard that cannot be shown failing against deliberately broken code is documentation, not evidence.

4. **No record-schema regression.** A run record stamped after these changes still validates: `tokens_directional` carries no `via` (nor any other new key), and `writeRecord` does not throw `invalid_record`. Confirm by driving a real `tokens-collect` against a run dir and checking the emitted JSON against `record.json` on disk — `via` present in the CLI output, absent from the record.

## Notes

- **Not in scope, deliberately:** pricing from these tokens (#12, which this unblocks), the `--repo` raw path segment (#14), the record contract + `session_id` work (#15), and telemetry capture (#16). This plan makes the baseline trustworthy; it does not consume it.
- **Follow-on, not a blocker:** with #18 landed, `cost_outlier` detection is still absent (deleted in Task 7 of the prior plan, tracked by #15). Nothing here reintroduces it.
