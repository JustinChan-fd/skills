# Directional Token Capture + Round Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tokens_directional.by_model` land non-empty on the live `run-end` path without any manual backfill, and cut one verifier round out of intake/plan by fixing three deterministic gaps.

**Architecture:** Phase A repairs the directional-token pipeline in `harness-core/tools/lib/` — a clobber guard so a good stamp is never overwritten by an empty one, a peak-context fingerprint that replaces the brittle `spawnDepth` + description + time-window match, a guard so `complete` can never be vacuously true on an empty `by_model`, two missing entries in the model→tier map, an anomaly rule that flags a run whose directional capture silently failed, and removal of `estimated_cost` (the harness stores RAW values; pricing belongs downstream). Phase B fixes three round-burners: `split-oversized.mjs` reads a `files` key the plan schema does not have, `splitRequired` is hardcoded `false` in prose, and no preflight check catches a manifest/plan naming a symbol that does not exist.

**Tech Stack:** Node.js ESM (`.mjs`), zero runtime dependencies, `node:test` + `node:assert/strict`, hand-rolled JSON Schema validator (`tools/lib/validate.mjs`).

## Global Constraints

- **The harness stores RAW values only.** No cost math, no pricing, no derived dollar figures in any record field. Pricing is a downstream concern of whatever reads telemetry.
- **TDD, failing test first, every change.** Write the test, run it, see it fail for the stated reason, then implement. A step that implements before its test has failed is a plan violation.
- **Loop invariant 6:** `stampTokensDirectional` sets only `tokens_directional` and clears `synced_at`. It must never touch `tokens_by_tier` or `tokens_observed`.
- **Never fail a run over enrichment.** Every function in the directional path returns a structured `{ ok:false, error:{ code, detail } }` and never throws.
- **No raw transcript text in any return value or record field.** Sums and metadata only.
- **Branch:** `harness/harness-core`. Commit per task; do NOT merge without review.
- **No real user paths in skill code.** `test/portability.test.mjs` enforces this — use synthetic paths (`/home/dev/...`) in tests and fixtures.
- **Verification bar for the whole plan:**
  1. `cd harness-core && node --test` fully green. Every task adds tests; none may remove or weaken an existing one.
  1a. **Establish your own baseline — do not trust a number written in this plan.** Before Step 1 of the task you are assigned, run `cd harness-core && node --test 2>&1 | tail -8` and record the `# pass` figure. That number is YOUR baseline; every "expected count" below is expressed as a delta against it (`baseline + N`). The suite was at 320 when this plan was drafted and 328 by the time it was reviewed — commits land between drafting and execution, so an absolute count in a plan is stale by construction. A total that differs from the plan's arithmetic is only a regression if it differs from *your* recorded baseline plus the stated delta.
  2. A dry run of `init-run` → fixture subagent transcript → `run-end` leaves `tokens_directional.by_model` **non-empty** with NO manual `backfill-directional` call.
  3. `CLI anomalies` flags an artificially-empty directional record with `directional_uncaptured`.

---
## Phase A — Fix directional token capture on the live path

### Task 1: Clobber guard in `stampTokensDirectional`

**Files:**
- Modify: `harness-core/tools/lib/record.mjs:97-108` (the `stampTokensDirectional` comment block + body)
- Test: `harness-core/test/record.test.mjs` (append at end of file)

**Interfaces:**
- Consumes: `readRecord(runDir)` and `writeRecord(runDir, record)` from `harness-core/tools/lib/record.mjs`; the `tokens_directional` shape `{ by_model, format_version, collected_at, complete }` produced by `buildTokensDirectional` in `tools/lib/tokens-collect.mjs:301`.
- Produces: `stampTokensDirectional({ runDir, tokensDirectional }) -> record` — the return value is still the record object (unchanged on a skip, updated on a write), so both existing call sites (`harness.mjs:92` in `collectAndStamp`, which ignores the return; `harness.mjs:386` in `backfill-directional`, which also ignores it) keep working untouched. The skip signal is carried as a **non-enumerable** `skipped` property on the returned record object: `Object.defineProperty(record, 'skipped', { value: true|false, enumerable: false })`. Non-enumerable is required because the returned object is the same object handed to `writeRecord`/`JSON.stringify`, and `run-record.schema.json` is `additionalProperties: false` — an enumerable `skipped` key would fail schema validation and would leak into `record.json`. Callers read it as `stampTokensDirectional({...}).skipped`.

- [ ] **Step 1: Write the failing test**

Append to `harness-core/test/record.test.mjs`. The file imports from `../tools/lib/record.mjs` on line 9 — extend that existing import to include `stampTokensDirectional`:

```javascript
import { initRun, readRecord, phaseEnd, finalizeRun, recordObservedTokens, stampTokensDirectional, finalizeTokens } from '../tools/lib/record.mjs';
```

Then append these tests:

```javascript
// ---------------------------------------------------------------------------
// stampTokensDirectional clobber guard — record-observed-tokens, phase-end and
// run-end all funnel through collectAndStamp (harness.mjs), so one run stamps
// several times. On the live TARS-1271 run an early call landed real per-model
// sums and a later call whose transcript resolution failed wrote by_model: {}
// over the top, which is why that record needed a manual backfill-directional
// to recover numbers the harness had already captured once.
// ---------------------------------------------------------------------------

const GOOD_DIRECTIONAL = {
  by_model: { 'claude-opus-5': { input: 12_000, output: 3_400 } },
  format_version: '1',
  collected_at: NOW.toISOString(),
  complete: true,
};

function emptyDirectional(collectedAt) {
  return { by_model: {}, format_version: '1', collected_at: collectedAt, complete: false };
}

test('stampTokensDirectional refuses to clobber a non-empty by_model with an empty one', () => {
  const { runDir } = freshRun();
  stampTokensDirectional({ runDir, tokensDirectional: GOOD_DIRECTIONAL });
  const later = new Date(NOW.getTime() + 60_000).toISOString();
  const record = stampTokensDirectional({ runDir, tokensDirectional: emptyDirectional(later) });
  // The whole object survives — not just by_model. collected_at and complete
  // still describe the observation that actually produced the sums.
  assert.deepEqual(record.tokens_directional, GOOD_DIRECTIONAL);
  assert.deepEqual(readRecord(runDir).tokens_directional, GOOD_DIRECTIONAL);
  assert.equal(record.skipped, true);
});

test('stampTokensDirectional leaves a prior synced_at intact when it skips (a no-op must not force a re-sync)', () => {
  const { runDir } = freshRun();
  stampTokensDirectional({ runDir, tokensDirectional: GOOD_DIRECTIONAL });
  const synced = readRecord(runDir);
  synced.synced_at = NOW.toISOString(); // simulate the successful sync that followed the good stamp
  writeFileSync(join(runDir, 'record.json'), JSON.stringify(synced));
  const record = stampTokensDirectional({ runDir, tokensDirectional: emptyDirectional(NOW.toISOString()) });
  assert.equal(record.synced_at, NOW.toISOString());
  assert.equal(readRecord(runDir).synced_at, NOW.toISOString());
});

test('stampTokensDirectional writes a newer non-empty by_model over an older one and clears synced_at', () => {
  const { runDir } = freshRun();
  stampTokensDirectional({ runDir, tokensDirectional: GOOD_DIRECTIONAL });
  const synced = readRecord(runDir);
  synced.synced_at = NOW.toISOString();
  writeFileSync(join(runDir, 'record.json'), JSON.stringify(synced));
  // Transcripts accumulate, so a later real observation is normally a superset —
  // newest real reading wins, never a merge.
  const superset = {
    by_model: {
      'claude-opus-5': { input: 20_000, output: 5_000 },
      'claude-haiku-4-5': { input: 800, output: 120 },
    },
    format_version: '1',
    collected_at: new Date(NOW.getTime() + 60_000).toISOString(),
    complete: true,
  };
  const record = stampTokensDirectional({ runDir, tokensDirectional: superset });
  assert.deepEqual(record.tokens_directional, superset);
  assert.deepEqual(readRecord(runDir).tokens_directional, superset);
  assert.equal(record.synced_at, null);
  assert.equal(record.skipped, false);
});

test('stampTokensDirectional writes an empty by_model when no directional field exists yet', () => {
  const { runDir } = freshRun();
  // A degraded first attempt must still land format_version/collected_at so the
  // anomalies scan can tell "collection ran and found nothing" apart from
  // "collection never ran at all".
  const empty = emptyDirectional(NOW.toISOString());
  const record = stampTokensDirectional({ runDir, tokensDirectional: empty });
  assert.deepEqual(record.tokens_directional, empty);
  assert.deepEqual(readRecord(runDir).tokens_directional, empty);
  assert.equal(record.skipped, false);
});

test('stampTokensDirectional writes an empty by_model over a previous empty one (no guard between two empties)', () => {
  const { runDir } = freshRun();
  stampTokensDirectional({ runDir, tokensDirectional: emptyDirectional(NOW.toISOString()) });
  const later = new Date(NOW.getTime() + 30_000).toISOString();
  const record = stampTokensDirectional({ runDir, tokensDirectional: emptyDirectional(later) });
  assert.equal(record.tokens_directional.collected_at, later);
  assert.equal(record.skipped, false);
});

test('stampTokensDirectional treats a null/missing tokensDirectional as empty and never clobbers real sums', () => {
  const { runDir } = freshRun();
  stampTokensDirectional({ runDir, tokensDirectional: GOOD_DIRECTIONAL });
  for (const bad of [null, undefined, {}, { by_model: null, format_version: '1', collected_at: null, complete: false }]) {
    const record = stampTokensDirectional({ runDir, tokensDirectional: bad });
    assert.deepEqual(record.tokens_directional, GOOD_DIRECTIONAL);
    assert.equal(record.skipped, true);
  }
});

test('stampTokensDirectional never touches tokens_by_tier or tokens_observed — in the write branch or the skip branch (loop invariant 6)', () => {
  const { runDir } = freshRun();
  finalizeRun({ runDir, status: 'succeeded', tokensByTier: { MID: 65_000 }, now: NOW });
  recordObservedTokens({ runDir, total: 105_779, tier: 'MID', now: NOW });
  const observed = readRecord(runDir).tokens_observed;

  // write branch
  let record = stampTokensDirectional({ runDir, tokensDirectional: GOOD_DIRECTIONAL });
  assert.deepEqual(record.tokens_by_tier, { MID: 65_000 });
  assert.deepEqual(record.tokens_observed, observed);

  // skip branch
  record = stampTokensDirectional({ runDir, tokensDirectional: emptyDirectional(NOW.toISOString()) });
  assert.deepEqual(record.tokens_by_tier, { MID: 65_000 });
  assert.deepEqual(record.tokens_observed, observed);
  assert.deepEqual(readRecord(runDir).tokens_by_tier, { MID: 65_000 });
  assert.deepEqual(readRecord(runDir).tokens_observed, observed);
});

test('stampTokensDirectional skip does not write a skipped key into record.json (schema is additionalProperties:false)', () => {
  const { runDir } = freshRun();
  stampTokensDirectional({ runDir, tokensDirectional: GOOD_DIRECTIONAL });
  stampTokensDirectional({ runDir, tokensDirectional: emptyDirectional(NOW.toISOString()) });
  const raw = readFileSync(join(runDir, 'record.json'), 'utf8');
  assert.ok(!raw.includes('"skipped"'));
  assert.equal(readRecord(runDir).skipped, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd harness-core && node --test test/record.test.mjs`

Expected: FAIL. The first new test fails on the clobber assertion —
`AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` with actual
`{ by_model: {}, format_version: '1', collected_at: '2026-07-24T18:31:12.000Z', complete: false }`
and expected `{ by_model: { 'claude-opus-5': { input: 12000, output: 3400 } }, ... }`, because
today's body assigns `record.tokens_directional = tokensDirectional` unconditionally.
The `record.skipped` assertions fail with `Expected values to be strictly equal: undefined !== true`,
the synced_at test fails with `'2026-07-24T18:30:12.000Z' !== null` inverted
(actual `null`, expected the timestamp), and the `null`/`undefined` case throws
`TypeError: Cannot read properties of undefined (reading 'by_model')` once the guard
is added naively — write the guard defensively as in Step 3.

- [ ] **Step 3: Write minimal implementation**

Replace `harness-core/tools/lib/record.mjs:97-108` (the comment block plus the whole
`stampTokensDirectional` body) with:

```javascript
// True when a tokens_directional object carries at least one per-model sum.
// Defensive about shape because it is asked about both freshly-built objects
// and whatever an old record on disk happens to hold (including null).
function hasModelSums(tokensDirectional) {
  const byModel = tokensDirectional?.by_model;
  return !!byModel && typeof byModel === 'object' && Object.keys(byModel).length > 0;
}

// Stamp the additive tokens_directional field onto a run record. This is
// strictly additive: it sets only tokens_directional and never touches
// tokens_by_tier or tokens_observed (the two raw token snapshots), so directional
// per-model sums are recorded ALONGSIDE the existing tier totals, never over top
// of them. synced_at is cleared so the enriched record is re-pushed to telemetry.
//
// Clobber guard: record-observed-tokens, phase-end and run-end each call
// collectAndStamp, so one run stamps several times and any single call may have
// failed to resolve a transcript. On the live TARS-1271 run an early call landed
// real per-model sums and a later call landed by_model: {} over the top, so the
// record shipped empty and needed a manual backfill-directional to recover sums
// the harness had already captured. An incoming empty by_model therefore never
// replaces an existing non-empty one — it is a no-op that also leaves synced_at
// alone, because nothing changed and forcing a re-sync of identical bytes is
// pure waste. An incoming non-empty by_model always wins: transcripts only grow,
// so the newest real reading is the most complete one (supersets are expected,
// which is why this replaces rather than merges).
//
// The skip signal rides back as a NON-ENUMERABLE `skipped` property. It must not
// be enumerable: this same object is what writeRecord validates, and
// run-record.schema.json is additionalProperties:false, so an enumerable key
// would both fail validation and leak into record.json.
export function stampTokensDirectional({ runDir, tokensDirectional }) {
  const record = readRecord(runDir);
  const skipped = !hasModelSums(tokensDirectional) && hasModelSums(record.tokens_directional);
  if (!skipped) {
    record.tokens_directional = tokensDirectional;
    record.synced_at = null;
    writeRecord(runDir, record);
  }
  Object.defineProperty(record, 'skipped', { value: skipped, enumerable: false });
  return record;
}
```

Note on the skip branch: it deliberately does not call `writeRecord`. Re-writing
byte-identical JSON would only risk a validation throw on a record that was
already valid on disk, and enrichment must never fail a run.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd harness-core && node --test test/record.test.mjs`

Expected: PASS — all pre-existing tests in the file plus the 8 new ones.

- [ ] **Step 5: Full suite green**

Run: `cd harness-core && node --test`

Expected: all tests pass (**your recorded baseline + 8 new**, 0 failing). Pay
particular attention to `test/tokens-backfill.test.mjs` and
`test/tokens-collect-cli.test.mjs`: both drive `stampTokensDirectional` through the
CLI. A backfill test that stamps an empty result onto a record that already holds
real sums will now legitimately observe a no-op. If one fails, confirm the fixture
actually intends an empty overwrite before changing anything — the guard is the
new correct behavior; the assertion is what needs updating, and only if it was
asserting the clobber.

- [ ] **Step 6: Commit**

```bash
git add harness-core/tools/lib/record.mjs harness-core/test/record.test.mjs
git commit -m "harness-core: never clobber captured directional sums with an empty by_model"
```
### Task 2: Peak-context fingerprint — compute it

`collectFromText` (`tokens-collect.mjs:127`) only ever SUMS usage into per-model
buckets (`addUsage`, line 88). It has no notion of any single call's total
context. That missing number is the one strong identity signal available:

    peak = max over all usage entries of
           (input_tokens + cache_read_input_tokens
            + cache_creation_input_tokens + output_tokens)

This is what the Agent tool reports as `subagent_tokens`, which every harness
driver copies verbatim into `tokens_observed.total`. So `peak` is a near-exact
fingerprint for "which transcript file belongs to this run" — far stronger than
the `spawnDepth` + description-substring + 60s-window AND that discovery uses
today. This task computes and exposes it. Task 3 rewires discovery onto it; do
not touch `discoverSubagentForRun` here.

**Files:**
- Modify: `harness-core/tools/lib/tokens-collect.mjs:83-197` (`emptyBucket`
  neighborhood, `collectFromText`), and `harness-core/tools/lib/tokens-collect.mjs:345-363`
  (`collectFromFile`'s error-path literal)
- Test: `harness-core/test/tokens-collect.test.mjs`

**Interfaces:**
- Consumes: `usagesFromLine(line) -> usage[]` (line 99, already exported-internal;
  reuse it, do not re-parse). `DIRECTIONS` (line 76). `inWindow(ts, startMs, endMs)`
  (line 112).
- Produces: `collectFromText(text, opts)` and `collectFromFile(path, opts)` both
  return their existing object plus one new own property:
  - `peak_context: number` — the maximum single-usage-entry context total as
    defined above. `0` when no usage entry was seen (never `-Infinity`, never
    `null`). Computed over **every** usage entry in the file, ignoring
    `opts.start` / `opts.end`. All other fields keep their current windowed
    semantics.
  Task 3 reads only `result.peak_context`.

**Why peak is unwindowed while sums stay windowed.** The window comes from the
run's own `started_at`/`ended_at`. When that window is wrong — the exact case
the fingerprint exists to rescue — a windowed peak silently drops the very call
that would have matched `tokens_observed.total`, and the fingerprint degrades
into the same time-based guess it is replacing. Sums stay windowed because they
answer a different question ("what did THIS run spend"), where over-counting a
neighbouring run's calls is the failure to avoid.

- [ ] **Step 1: Write the failing tests**

Add to `harness-core/test/tokens-collect.test.mjs`. These build transcript text
inline rather than via a fixture file, because each needs a specific arithmetic
shape; the module's parser takes raw text, so no fixture is required.

```javascript
// ---- peak_context: the single-call context fingerprint ----
//
// tokens_observed.total on a record is the Agent tool's subagent_tokens tag,
// which is the PEAK single-call context of that subagent — not a sum. Matching
// a transcript to a run by that number is an identity check; matching by
// spawnDepth + description + a 60s window overlap is three guesses ANDed
// together, and it landed TARS-1271 with an empty by_model.

const usageLine = (ts, model, u) =>
  JSON.stringify({ timestamp: ts, message: { model, usage: u } });

test('peak_context is the largest single call context, not the sum and not the last call', () => {
  // The biggest call is deliberately in the MIDDLE: a bug that returns the last
  // call's total, or a running sum, both pass a fixture where max is last.
  const text = [
    usageLine('2026-07-27T00:00:10.000Z', 'claude-opus-5', {
      input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }),
    usageLine('2026-07-27T00:00:20.000Z', 'claude-opus-5', {
      input_tokens: 5_000, output_tokens: 800, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 2_000,
    }),
    usageLine('2026-07-27T00:00:30.000Z', 'claude-opus-5', {
      input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0,
    }),
  ].join('\n');
  const r = collectFromText(text);
  assert.equal(r.ok, true);
  assert.equal(r.peak_context, 67_800, 'peak is 5000 + 800 + 60000 + 2000');
  const summed = r.by_model['claude-opus-5'];
  const sumTotal = summed.input + summed.output + summed.cache_read + summed.cache_creation;
  assert.ok(r.peak_context < sumTotal, 'peak must not be the sum across calls');
});

test('peak_context ignores the start/end window that sums honour', () => {
  // The whole point: a wrong run window is what breaks time-based attribution,
  // so the fingerprint must survive one. The peak call here is OUTSIDE the
  // window, and must still be reported.
  const text = [
    usageLine('2026-07-27T00:00:10.000Z', 'claude-opus-5', {
      input_tokens: 90_000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }),
    usageLine('2026-07-27T00:05:00.000Z', 'claude-opus-5', {
      input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }),
  ].join('\n');
  const r = collectFromText(text, {
    start: '2026-07-27T00:04:00.000Z',
    end: '2026-07-27T00:06:00.000Z',
  });
  assert.equal(r.ok, true);
  assert.equal(r.peak_context, 90_500, 'the out-of-window peak call was dropped');
  assert.equal(r.by_model['claude-opus-5'].input, 100, 'sums must stay windowed');
});

test('peak_context counts iterations[] sub-entries as their own calls', () => {
  // usagesFromLine flattens iterations[]; each is a real API call with its own
  // context, so the peak may live in a sub-entry rather than message.usage.
  const text = JSON.stringify({
    timestamp: '2026-07-27T00:00:10.000Z',
    message: { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 } },
    iterations: [
      { usage: { input_tokens: 40_000, output_tokens: 300, cache_read_input_tokens: 1_000 } },
      { message: { usage: { input_tokens: 20, output_tokens: 2 } } },
    ],
  });
  const r = collectFromText(text);
  assert.equal(r.peak_context, 41_300);
});

test('missing cache keys coerce to 0 rather than NaN', () => {
  // Older transcript lines carry only input_tokens/output_tokens. A NaN peak
  // makes every fingerprint comparison false, which is the silent-empty failure
  // this whole phase is fixing.
  const text = usageLine('2026-07-27T00:00:10.000Z', 'claude-opus-5', {
    input_tokens: 700, output_tokens: 40,
  });
  const r = collectFromText(text);
  assert.equal(r.peak_context, 740);
  assert.ok(Number.isFinite(r.peak_context), 'peak_context is not finite');
});

test('a transcript with no usage entries reports peak_context 0, not -Infinity', () => {
  const text = JSON.stringify({ timestamp: '2026-07-27T00:00:10.000Z', type: 'user', message: { content: 'hi' } });
  const r = collectFromText(text);
  assert.equal(r.ok, true);
  assert.equal(r.peak_context, 0);
});

test('an empty or unparseable transcript still carries a numeric peak_context', () => {
  // Both early-return paths build from `base`; a field added only to the success
  // path would leave `undefined` here, and Task 3 compares it numerically.
  assert.equal(collectFromText('').peak_context, 0);
  assert.equal(collectFromText('not json at all').peak_context, 0);
});

test('collectFromFile surfaces peak_context, including on the not_found path', () => {
  // Discovery calls collectFromFile, never collectFromText directly.
  const dir = mkdtempSync(join(tmpdir(), 'peak-'));
  const p = join(dir, 't.jsonl');
  writeFileSync(p, usageLine('2026-07-27T00:00:10.000Z', 'claude-opus-5', {
    input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 25,
  }));
  assert.equal(collectFromFile(p).peak_context, 1_175);
  assert.equal(collectFromFile(join(dir, 'nope.jsonl')).peak_context, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd harness-core && node --test test/tokens-collect.test.mjs`

Expected: FAIL. Every new test fails on `undefined`, e.g.
`AssertionError: Expected values to be strictly equal: undefined !== 67800`.
`collectFromText` does not yet have a `peak_context` key.

- [ ] **Step 3: Write minimal implementation**

Add the context-total helper next to `addUsage` in
`harness-core/tools/lib/tokens-collect.mjs` (after line 93):

```javascript
// The total context of ONE api call: everything the model had to read plus what
// it wrote. This is the number the Agent tool surfaces as `subagent_tokens`,
// which drivers copy into a record's `tokens_observed.total` — so the max of
// this across a transcript is an identity fingerprint for "this file is that
// run's". Missing cache keys coerce to 0: older transcript lines carry only
// input/output, and a NaN here makes every later fingerprint comparison false.
function contextTotal(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  let total = 0;
  for (const field of Object.values(DIRECTIONS)) {
    const v = usage[field];
    if (typeof v === 'number' && Number.isFinite(v)) total += v;
  }
  return total;
}
```

In `collectFromText`, add `peak_context` to the `base` literal (line 132-142) so
both early-return paths carry it:

```javascript
  const base = {
    ok: false,
    by_model: {},
    timestamps: { min: null, max: null },
    active_ms: 0,
    gap_cap_ms: gapCapMs,
    lines_total: 0,
    lines_parsed: 0,
    lines_skipped: 0,
    peak_context: 0,
    error: null,
  };
```

Then hoist the peak scan ABOVE the window filter. The existing loop body at
lines 164-181 becomes — note `contextTotal` runs before the `inWindow` early
`continue`, which is the entire point:

```javascript
    const tsStr = typeof line?.timestamp === 'string' ? line.timestamp : null;
    const tsMs = tsStr ? Date.parse(tsStr) : NaN;
    const ts = Number.isFinite(tsMs) ? tsMs : null;

    const usages = usagesFromLine(line);

    // Peak is measured UNWINDOWED, deliberately. The window is derived from the
    // run's own started_at/ended_at, and a wrong window is exactly the failure
    // the fingerprint exists to rescue — TARS-1271's directional capture came
    // back empty because a windowed match dropped the only call that identified
    // the transcript. Sums stay windowed below: they answer "what did THIS run
    // spend", where counting a neighbour's calls is the error to avoid.
    for (const u of usages) {
      const total = contextTotal(u);
      if (total > base.peak_context) base.peak_context = total;
    }

    if (!inWindow(ts, startMs, endMs)) continue;

    if (ts !== null) {
      stamps.push({ ms: ts, iso: tsStr });
      if (base.timestamps.min === null || ts < Date.parse(base.timestamps.min)) base.timestamps.min = tsStr;
      if (base.timestamps.max === null || ts > Date.parse(base.timestamps.max)) base.timestamps.max = tsStr;
    }

    const model = typeof line?.message?.model === 'string' ? line.message.model : null;
    if (model && usages.length) {
      byModel[model] ??= emptyBucket();
      for (const u of usages) addUsage(byModel[model], u);
    }
```

Two details that matter. `usagesFromLine` now runs once per line instead of
once per in-window line — it is a two-field read with no parsing, so the cost is
noise. And the peak scan does not require `line.message.model` to be a string:
a usage entry on a line with a missing/odd model still consumed context, and
excluding it would make the peak under-report exactly on the malformed lines
where attribution is already hardest.

Finally, `collectFromFile`'s `not_found` branch (lines 350-360) builds its own
object literal rather than reusing `base`, so it needs the field too:

```javascript
    return {
      ok: false,
      by_model: {},
      timestamps: { min: null, max: null },
      active_ms: 0,
      gap_cap_ms: Number.isFinite(opts.gapCapMs) ? opts.gapCapMs : DEFAULT_GAP_CAP_MS,
      lines_total: 0,
      lines_parsed: 0,
      lines_skipped: 0,
      peak_context: 0,
      error: { code: 'not_found', detail: err.message },
    };
```

Update the `collectFromText` JSDoc `@returns` (lines 123-125) to name the new
field, since Task 3's author reads that block as the contract:

```javascript
/**
 * Parse a transcript's raw JSONL text.
 * @param {string} text
 * @param {{start?:string|null,end?:string|null,gapCapMs?:number}} [opts]
 * @returns {{ok:boolean, by_model:object, timestamps:{min:string|null,max:string|null},
 *            active_ms:number, gap_cap_ms:number, lines_total:number,
 *            lines_parsed:number, lines_skipped:number, peak_context:number,
 *            error:null|{code:string,detail:string}}}
 */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd harness-core && node --test test/tokens-collect.test.mjs`
Expected: PASS — all 7 new tests plus every pre-existing test in the file.

- [ ] **Step 5: Full suite green**

Run: `cd harness-core && node --test`

Expected: all tests pass (**your recorded baseline + 7 new**). `peak_context` is a
purely additive field: nothing reads it yet, and no existing assertion does a
`deepEqual` on a whole `collectFromText` result — verify that claim by grepping
before you trust it:

```bash
cd harness-core && grep -rn "deepEqual(r\b\|deepEqual(result\b" test/tokens-collect.test.mjs test/tokens-backfill.test.mjs test/tokens-collect-cli.test.mjs
```

If any hit compares an entire result object, add `peak_context` to its expected
literal rather than deleting the assertion.

- [ ] **Step 6: Commit**

```bash
git add harness-core/tools/lib/tokens-collect.mjs harness-core/test/tokens-collect.test.mjs
git commit -m "harness-core: compute unwindowed peak_context per transcript"
```
### Task 3: Rewire subagent discovery onto the peak-context fingerprint

`discoverSubagentForRun` (`tokens-collect.mjs:383`) picks a transcript by ANDing
four weak signals, all of which fail independently in practice:

| Line | Condition | How it fails |
|---|---|---|
| 407 | `meta.spawnDepth !== 1` → reject | absent on some metas, `2` for nested spawns |
| 410 | issue key is a substring of `meta.description` | a driver's description need not carry the Jira key |
| 413 | phase name is a substring of `meta.description` | same, and `kind` ≠ the word used in prose |
| 419-431 | ≥`MIN_OVERLAP_MS` (60s, line 375) window overlap | a run window wrong by minutes kills a correct match |

When the AND fails, discovery returns `not_found`, `backfillDirectional` bails at
line 478, and `by_model` stays empty. Replace all four with one identity check.

**Files:**
- Modify: `harness-core/tools/lib/tokens-collect.mjs:375-444` (`MIN_OVERLAP_MS`,
  `discoverSubagentForRun`) and `:470-522` (`backfillDirectional`'s discovery
  call and cross-check)
- Test: `harness-core/test/tokens-backfill.test.mjs`

**Interfaces:**
- Consumes (from Task 2, already planned): `collectFromFile(path, opts)` returns
  its existing object plus `peak_context: number` — the maximum over all usage
  entries of `input_tokens + cache_read_input_tokens + cache_creation_input_tokens
  + output_tokens`, computed **unwindowed** (ignoring `opts.start`/`opts.end`),
  and `0` when the transcript has no usage entries.
- Produces:
  - `discoverSubagentForRun({ subagentsDir, observedTotal, start, end })` →
    `{ ok:boolean, path:string|null, error:null|{code,detail} }`. Error codes:
    `not_found` (unreadable dir, or no candidate in band), `no_fingerprint`
    (`observedTotal` absent/0). **`ambiguous` is gone** — see the tie-break
    below. The `issueKey` and `phase` parameters are removed.
  - `FINGERPRINT_BAND = { lo: 0.95, hi: 1.05 }` (exported, so the test asserts
    the real constant rather than a copied literal).

**Why a band and not equality.** `record.tokens_observed.total` is the
Agent-tool `subagent_tokens` tag as the driver read it. The driver may read that
tag before the subagent's final streamed usage entry is flushed, and some
drivers round. So the transcript's true peak can sit slightly either side of the
recorded number. A lower bound of 0.95 absorbs that.

**Why an upper bound too.** Without one, any transcript whose peak merely
*exceeds* `observedTotal` matches — and a long-running sibling driver's
transcript exceeds every smaller run's total, so the biggest transcript in the
directory would win every match. `hi: 1.05` makes the check two-sided: the
fingerprint means "same size", not "at least this size".

**Tie-break, replacing `ambiguous`.** Two transcripts can legitimately land in
band. Returning `ambiguous` (line 439-442) makes that a hard failure and leaves
`by_model` empty — the outcome this whole phase exists to prevent. Instead: pick
the candidate whose `|ratio - 1|` is smallest; on an exact tie, pick the
lexicographically smallest path. Determinism matters because
`readdirSync` order is not guaranteed stable across filesystems, and a
non-deterministic discovery makes the same run attribute differently on a
re-scan.

**The time window becomes advisory.** Keep it only as a cheap prefilter so we do
not parse transcripts from unrelated days, and widen it to a generous pad. It
must never be the sole reason a fingerprint-matching transcript is rejected —
that is the exact regression being fixed. Concretely: if a candidate matches the
fingerprint, it is accepted regardless of overlap.

**What `attribution_suspect` becomes.** Today (line 512) it fires when the
windowed input+output sum diverges from `observedTotal` by more than 10×. That
check was a proxy for "did we pick the right transcript" — which the fingerprint
now answers directly and far better. Keeping both means a run can pass the
identity check and still be refused a stamp by the weaker heuristic. **Remove
the `attribution_suspect` early-return** (lines 499-522) and the comment block at
499-503. The fingerprint match in discovery replaces it. Note in the commit
message that this is a deliberate removal, not an oversight.

- [ ] **Step 1: Audit the existing tests, then write the failing ones**

Five tests call `discoverSubagentForRun`. Their fate:

- **line 45** `discovers exactly one spawnDepth=1 agent whose time window overlaps the run`
  — **rewrite.** Its premise (depth-2 agents are ignored) is deleted behavior.
  Becomes the exact-fingerprint test below; the depth-2 agent stays in the
  fixture but is now excluded by having a non-matching peak, which is the real
  new contract.
- **line 69** `returns ambiguous when two spawnDepth=1 agents both match`
  — **delete and replace.** `ambiguous` no longer exists. Replaced by
  `picks the candidate closest to the observed total when two are in band`.
- **line 90** `returns not_found when no agent overlaps the run window sufficiently`
  — **delete.** It asserts precisely the behavior being removed: a
  non-overlapping window must now still match on fingerprint. Its inverse
  becomes the load-bearing regression test below.
- **line 108** `description filtering: agent without issue key in description is excluded`
  — **delete.** Description filtering is gone.
- **line 125** `returns not_found on a missing subagents directory`
  — **keep unchanged.** The `readdirSync` failure path (lines 385-389) is
  untouched. Note it passes no `observedTotal`, so verify it still returns
  `not_found` and not `no_fingerprint`: the directory read happens first, and
  must stay first.

`backfillDirectional` tests from line 133 onward pass `issueKey`/`phase`
indirectly through the record; check each for an assertion on
`error.code === 'attribution_suspect'` and delete those, since that code is
removed.

Now the new tests. They reuse the file's existing helpers `makeSubagentsDir`
(line 33), `writeAgentMeta` (19), `writeAgentTranscript` (23) and `usageLine`
(39), and add one helper so a fixture's peak is stated rather than computed by
the reader:

```javascript
// A transcript whose single largest call has exactly `peak` total context.
// tokens_observed.total is that peak, so this is how a fixture declares
// "I am the transcript for a run that recorded N observed tokens".
function transcriptWithPeak(dir, id, peak, ts = '2026-07-27T02:00:00.000Z') {
  writeAgentMeta(dir, id, { description: 'whatever' });
  writeAgentTranscript(dir, id, [
    usageLine('claude-opus-5', ts, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    usageLine('claude-opus-5', ts, { input_tokens: peak - 500, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);
}

test('an exact peak-context match wins, and a non-matching transcript is excluded', () => {
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'aaa', 12_000);  // a different run's driver
  transcriptWithPeak(dir, 'bbb', 90_000);  // ours
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 90_000 });
  assert.equal(r.ok, true, `expected a match, got ${r.error?.code}: ${r.error?.detail}`);
  assert.ok(r.path.includes('agent-bbb.jsonl'), `matched the wrong transcript: ${r.path}`);
});

test('spawnDepth and description are no longer consulted', () => {
  // Both were hard filters. A depth-2 agent with a description naming neither the
  // issue nor the phase must now match purely on its fingerprint — this is the
  // combination that silently produced an empty by_model on the live path.
  const dir = makeSubagentsDir();
  writeAgentMeta(dir, 'ccc', { spawnDepth: 2, description: 'unrelated prose' });
  writeAgentTranscript(dir, 'ccc', [
    usageLine('claude-opus-5', '2026-07-27T02:00:00.000Z', { input_tokens: 49_500, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 50_000 });
  assert.equal(r.ok, true, `expected a match, got ${r.error?.code}`);
});

test('a fingerprint match succeeds even when the time windows do not overlap', () => {
  // THE regression this task exists for. The run window here is hours off from
  // the transcript — the old MIN_OVERLAP_MS check rejected exactly this, which is
  // how a correct transcript got thrown away.
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'ddd', 75_000, '2026-07-27T10:00:00.000Z');
  const r = discoverSubagentForRun({
    subagentsDir: dir,
    observedTotal: 75_000,
    start: '2026-07-27T02:00:00.000Z',
    end: '2026-07-27T02:30:00.000Z',
  });
  assert.equal(r.ok, true, `window rejected a fingerprint match: ${r.error?.detail}`);
  assert.ok(r.path.includes('agent-ddd.jsonl'));
});

test('a match inside the tolerance band is accepted at ratio 0.96', () => {
  // The driver can read subagent_tokens before the last streamed usage entry
  // flushes, so the transcript peak lands slightly under the recorded total.
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'eee', 96_000);
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 });
  assert.equal(r.ok, true, `0.96 should be in band, got ${r.error?.code}`);
});

test('a transcript at half the observed total is rejected', () => {
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'fff', 50_000);
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test('a transcript far above the observed total is rejected too', () => {
  // Without an upper bound, the largest transcript in the directory matches every
  // smaller run — a long sibling driver would win every attribution.
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'ggg', 400_000);
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test('two candidates in band: the one closest to the observed total wins', () => {
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'hhh', 96_000);   // ratio 0.96
  transcriptWithPeak(dir, 'iii', 99_500);   // ratio 0.995 — closer
  const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 });
  assert.equal(r.ok, true, 'in-band candidates must resolve, never return ambiguous');
  assert.ok(r.path.includes('agent-iii.jsonl'), `picked the further candidate: ${r.path}`);
});

test('an exact ratio tie resolves deterministically by path', () => {
  // readdirSync order is not guaranteed stable across filesystems, and a
  // non-deterministic pick makes the same run attribute differently on re-scan.
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'kkk', 80_000);
  transcriptWithPeak(dir, 'jjj', 80_000);
  const first = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 80_000 });
  const second = discoverSubagentForRun({ subagentsDir: dir, observedTotal: 80_000 });
  assert.equal(first.ok, true);
  assert.equal(first.path, second.path, 'discovery is not deterministic on a tie');
  assert.ok(first.path.includes('agent-jjj.jsonl'), 'tie-break is not lexicographic');
});

test('no observed total means no fingerprint, and no silent fallback', () => {
  // There is deliberately no heuristic fallback: guessing is what produced a
  // wrong-or-empty stamp. Say so in the error instead.
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'lll', 80_000);
  for (const observedTotal of [0, undefined, null]) {
    const r = discoverSubagentForRun({ subagentsDir: dir, observedTotal });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'no_fingerprint', `observedTotal ${observedTotal} took a fallback path`);
  }
});

test('the exported band is what discovery actually enforces', () => {
  // Guards against the constant and the comparison drifting apart.
  assert.equal(FINGERPRINT_BAND.lo, 0.95);
  assert.equal(FINGERPRINT_BAND.hi, 1.05);
  const dir = makeSubagentsDir();
  transcriptWithPeak(dir, 'mmm', Math.round(100_000 * FINGERPRINT_BAND.lo));
  assert.equal(discoverSubagentForRun({ subagentsDir: dir, observedTotal: 100_000 }).ok, true);
});
```

Add `FINGERPRINT_BAND` to the import block at lines 9-12.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd harness-core && node --test test/tokens-backfill.test.mjs`

Expected: FAIL. `FINGERPRINT_BAND` is not exported, so the import throws
`SyntaxError: The requested module '../tools/lib/tokens-collect.mjs' does not
provide an export named 'FINGERPRINT_BAND'` and the whole file fails to load.
Comment the import out to see the individual failures first if you prefer: the
fingerprint tests then fail with `not_found`, because discovery still requires
`spawnDepth === 1` and ignores `observedTotal` entirely.

- [ ] **Step 3: Write minimal implementation**

Replace `MIN_OVERLAP_MS` (line 375) and the whole of `discoverSubagentForRun`
(lines 377-444) in `harness-core/tools/lib/tokens-collect.mjs`:

```javascript
// How far a transcript's peak single-call context may sit from the run's
// recorded tokens_observed.total and still be considered the same subagent.
//
// The lower bound absorbs a real skew: the driver reads the Agent-tool
// subagent_tokens tag, and may read it before the subagent's final streamed
// usage entry is flushed, so the transcript's true peak can exceed what was
// recorded. The upper bound is what makes this an identity check rather than a
// floor — without it, the largest transcript in the directory matches every
// smaller run, and a long-running sibling driver wins every attribution.
export const FINGERPRINT_BAND = { lo: 0.95, hi: 1.05 };

// Prefilter pad. The window is advisory only — it exists so we don't parse a
// month of unrelated transcripts, never to reject a fingerprint match. A run
// window wrong by minutes is exactly what broke the old overlap check, so the
// pad is deliberately generous.
const WINDOW_PAD_MS = 6 * 60 * 60 * 1000; // 6 hours either side

/**
 * Find the subagent transcript belonging to a run, by fingerprint.
 *
 * `observedTotal` is the run record's `tokens_observed.total` — the Agent-tool
 * `subagent_tokens` tag, which is the subagent's PEAK single-call context, not a
 * sum. A transcript's own peak (Task 2's `peak_context`) is therefore a near-exact
 * identity match. This replaced a spawnDepth + description-substring + 60s-overlap
 * AND, where any one signal failing left `tokens_directional.by_model` empty —
 * which is how TARS-1271 shipped with no directional capture at all.
 *
 * @param {{ subagentsDir:string, observedTotal?:number, start?:string, end?:string }} opts
 * @returns {{ ok:boolean, path:string|null, error:null|{code:string,detail:string} }}
 */
export function discoverSubagentForRun({ subagentsDir, observedTotal, start, end } = {}) {
  let entries;
  try {
    entries = readdirSync(subagentsDir);
  } catch (err) {
    return { ok: false, path: null, error: { code: 'not_found', detail: err.message } };
  }

  // No fingerprint means no match. There is deliberately no heuristic fallback:
  // guessing from timestamps is what produced empty and mis-attributed stamps.
  const observed = Number.isFinite(observedTotal) ? observedTotal : 0;
  if (observed <= 0) {
    return {
      ok: false,
      path: null,
      error: {
        code: 'no_fingerprint',
        detail: 'record has no tokens_observed.total, so there is nothing to fingerprint against',
      },
    };
  }

  const startMs = start ? Date.parse(start) : null;
  const endMs = end ? Date.parse(end) : null;
  const padLo = Number.isFinite(startMs) ? startMs - WINDOW_PAD_MS : null;
  const padHi = Number.isFinite(endMs) ? endMs + WINDOW_PAD_MS : null;

  let best = null; // { path, drift }
  for (const name of entries) {
    if (!name.endsWith('.meta.json') || !name.startsWith('agent-')) continue;

    const baseName = name.slice(0, -'.meta.json'.length);
    const jsonlPath = join(subagentsDir, baseName + '.jsonl');

    const result = collectFromFile(jsonlPath);
    if (!Number.isFinite(result.peak_context) || result.peak_context <= 0) continue;

    // Advisory prefilter only. A transcript entirely outside the padded window is
    // skipped to save parsing on unrelated days; anything inside is judged purely
    // on fingerprint. Note this runs AFTER the parse, so it saves no work here —
    // it exists to stop a same-sized transcript from a different week matching.
    if (padLo !== null && padHi !== null) {
      const tMin = result.timestamps?.min ? Date.parse(result.timestamps.min) : null;
      const tMax = result.timestamps?.max ? Date.parse(result.timestamps.max) : null;
      if (tMin !== null && tMax !== null && (tMax < padLo || tMin > padHi)) continue;
    }

    const ratio = result.peak_context / observed;
    if (ratio < FINGERPRINT_BAND.lo || ratio > FINGERPRINT_BAND.hi) continue;

    const drift = Math.abs(ratio - 1);
    // Closest to 1 wins. On an exact tie, the lexicographically smaller path wins:
    // readdirSync order is not stable across filesystems, and a non-deterministic
    // pick makes the same run attribute differently on a re-scan.
    if (best === null || drift < best.drift || (drift === best.drift && jsonlPath < best.path)) {
      best = { path: jsonlPath, drift };
    }
  }

  if (best === null) {
    return {
      ok: false,
      path: null,
      error: {
        code: 'not_found',
        detail: `no transcript peak within [${FINGERPRINT_BAND.lo}, ${FINGERPRINT_BAND.hi}] of observed total ${observed}`,
      },
    };
  }
  return { ok: true, path: best.path, error: null };
}
```

Note what is gone: the `spawnDepth` check, both description checks, the meta-file
`JSON.parse` (the meta is now only a marker that a sibling `.jsonl` should exist —
keep the filename filter, drop the read), `MIN_OVERLAP_MS`, and the `ambiguous`
branch.

Then in `backfillDirectional`, update the discovery call (lines 470-476) to pass
the fingerprint instead of the issue key and phase. `observedTotal` is read at
line 504 today, below the call — hoist that read above it:

```javascript
  const observedTotal = record.tokens_observed?.total ?? 0;

  const discovered = discoverSubagentForRun({
    subagentsDir,
    observedTotal,
    start: effectiveStart,
    end: effectiveEnd,
  });

  if (!discovered.ok) return { ok: false, error: discovered.error };
```

And delete the `attribution_suspect` block entirely — the comment at lines
499-503 and the `if (observedTotal > 0 && result.ok) { … }` guard at 505-522.
Discovery now proves identity by fingerprint, so a second, weaker sum-ratio check
can only ever refuse a stamp the strong check already approved. Keep the
`no_usage` guard at 492-497: it catches a different failure (right transcript,
nothing inside the window), and it is what stops an empty stamp from looking like
a successful attribution of zero.

Update the module comment at lines 365-373, which still describes the old
mechanism — replace "it discovers the right transcript by matching spawnDepth=1
agents whose time window overlaps the run" with "it discovers the right
transcript by matching its peak single-call context against the run's recorded
`tokens_observed.total`".

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd harness-core && node --test test/tokens-backfill.test.mjs`
Expected: PASS — 10 new tests, plus the kept missing-directory test and every
`backfillDirectional` test.

- [ ] **Step 5: Full suite green**

Run: `cd harness-core && node --test`

Expected: all tests pass. Relative to **your recorded baseline**: +7 from Task 2
(if it landed before this one), then this task removes 3 discovery tests and adds
10, for a net **+14** over baseline when both tasks are in. If Task 2 has not
landed, the net is **+7** over baseline. Two cross-file risks to check rather than
assume:

```bash
cd harness-core && grep -rn "MIN_OVERLAP_MS\|attribution_suspect\|spawnDepth" tools test
```

Any surviving reference outside this task's edits — in `tools/harness.mjs`'s
`backfill-directional` case (~363-390), its usage string, or another test — must
be updated in this same commit. `attribution_suspect` in particular may appear in
a CLI error-code list.

- [ ] **Step 6: Commit**

```bash
git add harness-core/tools/lib/tokens-collect.mjs harness-core/test/tokens-backfill.test.mjs
git commit -m "harness-core: match subagent transcripts by peak-context fingerprint

Replaces the spawnDepth + description + window-overlap AND, where any one
signal failing left tokens_directional.by_model empty. Deliberately removes the
attribution_suspect sum-ratio check: it was a proxy for the identity question
the fingerprint now answers directly, and keeping both means a run can pass the
strong check and still be refused a stamp by the weak one."
```
### Task 4: `complete` can never be vacuously true

**Files:**
- Modify: `harness-core/tools/lib/tokens-collect.mjs:293-323` (`buildTokensDirectional`)
- Test: `harness-core/test/tokens-collect.test.mjs`

**Interfaces:**
- Consumes: `buildTokensDirectional({ result, modelTierMap, now })` — `result` is a `collectFromText`/`collectFromFile` result `{ ok, by_model, ... , error }`.
- Produces: `buildTokensDirectional` returns `{ tokens_directional: { by_model, format_version, collected_at, complete }, note: { code, detail } | null }`. `complete` is now true only for a non-empty, fully-tiered, successful collect. New note code `empty_collection` joins the existing `unknown_model` / parser-error codes. The record field shape is UNCHANGED — no new keys.

**Decision on the distinguishing signal (committed):** no new field on `tokens_directional`. The returned `note` already distinguishes the two cases and is the channel every consumer uses: `harness.mjs:75 collectAndStamp` turns a non-null note into an `estimated: true` audit event, which `anomalies.mjs:41 isEstimatedTokensNote` reads to raise `tokens_estimated`. So `complete: false` + `note.code === 'empty_collection'` vs `note.code === 'unknown_model'` is already a full discrimination, with no schema churn. This matters because `schemas/run-record.schema.json`'s `tokens_directional` subschema is `"additionalProperties": false` with `required: ["by_model","format_version","collected_at","complete"]` and exactly those four properties — any new key would make `writeRecord` throw `HarnessError('invalid_record')` until the schema were widened, and would strand every already-written record (including the live TARS-1271 one) on an older shape. **No schema edit is needed for this task.**

**Existing-test audit (done by reading, not assumed):** `test/tokens-collect.test.mjs` does not import `buildTokensDirectional` at all today — its import block ends at `discoverStandaloneTranscript` (line 14) — so no test in that file asserts `complete` on any fixture, and nothing there can break. The four `complete: true` assertions elsewhere (`test/tokens-collect-cli.test.mjs:48`, `:63`, `test/tokens-backfill.test.mjs:161`, `test/schemas.test.mjs:141`) all run against populated `by_model` (`claude-opus-4-8` input 330; `claude-sonnet-4-6` input 110; a hand-written record fixture), so they keep passing and serve as the regression proof that the guard did not invert the normal path. Step 1 adds the import.

- [ ] **Step 1: Write the failing test**

Add `buildTokensDirectional` to the existing import block at the top of `harness-core/test/tokens-collect.test.mjs` so it reads:

```javascript
import {
  DEFAULT_GAP_CAP_MS,
  collectFromText,
  collectFromFile,
  buildTokensDirectional,
  mungeProjectDir,
  projectDirForCwd,
  discoverLoopTranscript,
  discoverStandaloneTranscript,
} from '../tools/lib/tokens-collect.mjs';
```

Then append at the end of the file:

```javascript
// ---- buildTokensDirectional: `complete` must never be vacuously true ----

// A helper matching the parser's success shape closely enough for the builder,
// which only reads `.ok` and `.by_model`.
const okResult = (by_model) => ({ ok: true, by_model, error: null });
const sums = { input: 100, output: 50, cache_read: 20, cache_creation: 10 };
const NOW = new Date('2026-07-28T10:00:00.000Z');

test('an empty by_model is never complete — a transcript that produced nothing has nothing to be complete about', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({}),
    modelTierMap: { 'claude-opus-4-8': 'HIGH' },
    now: NOW,
  });
  // This is the shape the live TARS-1271 record landed in: ok collect, zero
  // models, zero unknowns -> the old code stamped complete:true over {}.
  assert.deepEqual(tokens_directional.by_model, {});
  assert.equal(tokens_directional.complete, false);
  assert.equal(tokens_directional.format_version, '1');
  assert.equal(tokens_directional.collected_at, '2026-07-28T10:00:00.000Z');
  // The note is the only channel that distinguishes "collected nothing" from
  // "collected something but saw an unknown model" (no field is added to the
  // record — the schema's tokens_directional is additionalProperties:false).
  assert.equal(note.code, 'empty_collection');
  assert.match(note.detail, /no model usage/i);
});

test('a populated by_model with every model tiered is complete — the empty-guard does not invert the normal path', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({ 'claude-opus-4-8': { ...sums } }),
    modelTierMap: { 'claude-opus-4-8': 'HIGH' },
    now: NOW,
  });
  assert.equal(tokens_directional.complete, true);
  assert.equal(note, null);
  assert.equal(tokens_directional.by_model['claude-opus-4-8'].input, 100);
});

test('a populated by_model containing an unknown model id is still not complete, and says so distinctly', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: okResult({
      'claude-opus-4-8': { ...sums },
      'some-unrecognized-model-99': { input: 70, output: 5, cache_read: 0, cache_creation: 0 },
    }),
    modelTierMap: { 'claude-opus-4-8': 'HIGH' },
    now: NOW,
  });
  assert.equal(tokens_directional.complete, false);
  assert.equal(note.code, 'unknown_model');
  assert.notEqual(note.code, 'empty_collection'); // the two degradations stay tellable apart
  // the unknown model's tokens survive under its own id, never mis-tiered
  assert.equal(tokens_directional.by_model['some-unrecognized-model-99'].input, 70);
});

test('a failed collect keeps its own error code and is not relabelled empty_collection', () => {
  const { tokens_directional, note } = buildTokensDirectional({
    result: { ok: false, by_model: {}, error: { code: 'not_found', detail: 'no such transcript' } },
    modelTierMap: {},
    now: NOW,
  });
  assert.equal(tokens_directional.complete, false);
  assert.equal(note.code, 'not_found'); // parse/discovery failure wins over emptiness
  assert.equal(tokens_directional.format_version, '1'); // stamped even on failure
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd harness-core && node --test test/tokens-collect.test.mjs`

Expected: FAIL on the first new test with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: true !== false` at the `assert.equal(tokens_directional.complete, false)` line, followed by a second failure in the same test reading `Cannot read properties of null (reading 'code')` for `note.code` (the old code returns `note: null` for an empty-but-ok collect). The other three new tests pass already.

- [ ] **Step 3: Write minimal implementation**

The current expression that makes `complete` vacuously true is the unconditional assignment on line 321, reached whenever `result.ok` is truthy and `unknown.length === 0`:

```javascript
  tokens_directional.complete = true;
  return { tokens_directional, note: null };
```

Replace those two lines (`harness-core/tools/lib/tokens-collect.mjs:321-322`) with:

```javascript
  // A collect can succeed and still find nothing: an empty by_model has no
  // unknown model ids to flag, so the old `complete = true` here fired on a
  // transcript that produced zero usage lines. The live TARS-1271 record landed
  // exactly that way — `complete: true` over `by_model: {}` — and a consumer
  // reading `complete` has no reason to also test emptiness. Completeness now
  // requires something to have been collected.
  if (Object.keys(tokens_directional.by_model).length === 0) {
    return {
      tokens_directional,
      note: { code: 'empty_collection', detail: 'transcript parsed but contained no model usage; nothing to attribute' },
    };
  }
  tokens_directional.complete = true;
  return { tokens_directional, note: null };
```

Then update the JSDoc block above the function (`harness-core/tools/lib/tokens-collect.mjs:293-300`) so the contract matches the code:

```javascript
/**
 * Turn a parser result into the additive `tokens_directional` record field
 * plus an optional degradation note. The format version is ALWAYS stamped, even
 * on failure. `complete` is true only when parsing succeeded AND at least one
 * model was actually collected AND every model id seen is present in
 * `modelTierMap`. The emptiness clause exists because a parse failure and a
 * zero-usage transcript are indistinguishable from `unknown.length` alone: with
 * `by_model: {}` there are no unknown ids, so `complete` used to come out true
 * over nothing at all. The note's code says which degradation happened —
 * `empty_collection` (nothing collected) vs `unknown_model` (collected, but an
 * unrecognized id that must not be silently mis-tiered under a default tier) —
 * because `tokens_directional` itself cannot carry a reason field: its subschema
 * in run-record.schema.json is additionalProperties:false.
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd harness-core && node --test test/tokens-collect.test.mjs`

Expected: PASS (all pre-existing tests in the file plus the 4 new ones).

- [ ] **Step 5: Full suite green**

Run: `cd harness-core && node --test`

Expected: all tests pass (**your recorded baseline + 4 new**). In particular `test/tokens-collect-cli.test.mjs` (`complete: true` at lines 48 and 63), `test/tokens-backfill.test.mjs:161`, and `test/schemas.test.mjs:141` must still pass — all three use populated `by_model`, and their staying green is the proof the guard did not break the normal path.

- [ ] **Step 6: Commit**

```bash
git add harness-core/tools/lib/tokens-collect.mjs harness-core/test/tokens-collect.test.mjs
git commit -m "harness-core: never report tokens_directional.complete over an empty by_model"
```
### Task 5: `model_id_to_tier` — add `claude-opus-5` and `<synthetic>`, bump the price-table version

**Files:**
- Modify: `harness-core/config/routing.json:41-55` (the `model_id_to_tier` map — 13 entries today, lines 42-54) and `harness-core/config/routing.json:36` (`price_table.version`)
- Test: `harness-core/test/config.test.mjs` (existing map test at lines 47-57, existing provenance test at lines 59-63)

**Interfaces:**
- Consumes: `resolveConfig({ env, userFile })` from `harness-core/tools/lib/config.mjs` → `{ routing, user }`; `routing.model_id_to_tier` is the map `buildTokensDirectional` in `harness-core/tools/lib/tokens-collect.mjs:301` receives as `modelTierMap`.
- Produces: `routing.model_id_to_tier['claude-opus-5'] === 'HIGH'`, `routing.model_id_to_tier['<synthetic>'] === 'LOW'`, `routing.price_table.version === '2026-07-28.1'`. No function signatures change.

**Decisions this task locks in (do not re-litigate while implementing):**

- **Tier for `claude-opus-5`: `HIGH`.** Every opus-family id already in the map is `HIGH` (`claude-opus-4-8`, `-4-7`, `-4-6`, `-4-5`, `-4-1`, `-4-0` at lines 42-47), as are the two other flagships `claude-fable-5` and `claude-mythos-5` (lines 48-49). `claude-opus-5` is the current flagship and the model the harness's own driver and reasoning seats run on, so `HIGH` is the only consistent answer — and `HIGH` is the tier `tierFor(routing, 'verifier_implement')` already resolves to.
- **`<synthetic>`: option (a) — map it to `LOW` in this config file.** The objection to (a) is that `<synthetic>` is not billable, so giving it a priced tier attributes cost to something that costs nothing. That objection is priced against a cost column the harness is losing: Task 7 of this plan removes `estimated_cost` entirely, and the plan's global constraint is that the harness stores RAW values only with no cost math anywhere in a record. With no cost math downstream, the tier on a `<synthetic>` row is a *classification label*, not a price input — nothing multiplies it. Option (b) (filter `<synthetic>` out of `by_model` inside `collectFromText` at `harness-core/tools/lib/tokens-collect.mjs:176-181`, before the bucket is created) would also work, but it silently discards raw observed rows from the transcript, which is exactly what the RAW-values constraint exists to prevent: the record would no longer let you reconstruct what the transcript said. (a) keeps the row, keeps `complete: true`, and costs one line. `LOW` is chosen over MID/HIGH because if any future consumer *does* price the map, the cheapest tier minimises the fiction.
- **Version bump: yes.** `price_table.version` goes from `"2026-07-26.1"` to `"2026-07-28.1"` and `price_table.retrieved` from `"2026-07-26"` to `"2026-07-28"`. `model_id_to_tier` is how `tokens_directional` collapses to a single tier per model, so the set of ids the table can price is part of the table's identity; a version string that did not move while two ids appeared is the failure mode where a historical record cannot be re-priced against the table it was written under. The date-prefixed form matches the existing convention, and `retrieved` moves with it because the pricing page is re-checked on the same pass that adds the id.

- [ ] **Step 1: Write the failing tests**

Add to `harness-core/test/config.test.mjs`, after the existing map test (which ends at line 57). The existing test's `for (const tier of Object.values(map))` loop at lines 54-56 **already** asserts that every mapped tier has a price entry, so the two new ids get price coverage for free the moment they are added — no new test is needed for that half of the requirement. What is missing is (a) an explicit assertion on the two new ids and (b) the regression test that the ids the harness's own skills spawn are all present.

```javascript
test('model_id_to_tier covers the current flagship and the synthetic-entry sentinel', () => {
  const { routing } = resolveConfig({ env: {}, userFile: '/nonexistent' });
  const map = routing.model_id_to_tier;
  // claude-opus-5 is what the driver and reasoning seats actually run on; every
  // other opus-family and flagship id in the map is HIGH, so this must be too.
  assert.equal(map['claude-opus-5'], 'HIGH');
  // Transcripts carry the literal id '<synthetic>' for no-model assistant entries.
  // It is not billable; it is mapped to the cheapest tier purely so it never lands
  // in tokens_directional.unknown[] and forces complete:false on a perfect capture.
  assert.equal(map['<synthetic>'], 'LOW');
  // the existing loop below is what keeps these two priceable
  for (const id of ['claude-opus-5', '<synthetic>']) {
    assert.ok(routing.tier_prices_usd_per_mtok[map[id]], `${id} maps to an unpriced tier`);
  }
});

test('every model id the harness itself spawns is present in model_id_to_tier', () => {
  const { routing } = resolveConfig({ env: {}, userFile: '/nonexistent' });
  const map = routing.model_id_to_tier;
  // A run whose transcript carries an id missing from this map is reported
  // complete:false by buildTokensDirectional even when the capture was perfect.
  // A measured M-size run lost its whole by_model breakdown to a flagship rename;
  // this list is the tripwire so the next rename fails here, loudly, instead.
  const spawned = [
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    '<synthetic>',
  ];
  const missing = spawned.filter((id) => !(id in map));
  assert.deepEqual(missing, [], `model ids spawned by harness skills but unmapped: ${missing.join(', ')}`);
});
```

Then edit the existing provenance test in place. Replace lines 61-62:

```javascript
  assert.equal(routing.price_table.version, '2026-07-28.1');
  assert.equal(routing.price_table.retrieved, '2026-07-28');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd harness-core && node --test test/config.test.mjs`

Expected: FAIL, three failures.
- `model_id_to_tier covers the current flagship and the synthetic-entry sentinel` → `Expected values to be strictly equal: undefined !== 'HIGH'`
- `every model id the harness itself spawns is present in model_id_to_tier` → `model ids spawned by harness skills but unmapped: claude-opus-5, <synthetic>`
- `price_table provenance version reflects the cache-column addition` → `Expected values to be strictly equal: '2026-07-26.1' !== '2026-07-28.1'`

- [ ] **Step 3: Write minimal implementation**

In `harness-core/config/routing.json`, bump the two provenance fields (lines 36 and 38):

```json
  "price_table": {
    "version": "2026-07-28.1",
    "source_url": "https://docs.claude.com/en/docs/about-claude/pricing",
    "retrieved": "2026-07-28",
```

And extend `model_id_to_tier` (lines 41-55) — `claude-opus-5` leads the opus block, `<synthetic>` goes last:

```json
  "model_id_to_tier": {
    "claude-opus-5": "HIGH",
    "claude-opus-4-8": "HIGH",
    "claude-opus-4-7": "HIGH",
    "claude-opus-4-6": "HIGH",
    "claude-opus-4-5": "HIGH",
    "claude-opus-4-1": "HIGH",
    "claude-opus-4-0": "HIGH",
    "claude-fable-5": "HIGH",
    "claude-mythos-5": "HIGH",
    "claude-sonnet-5": "MID",
    "claude-sonnet-4-6": "MID",
    "claude-sonnet-4-5": "MID",
    "claude-sonnet-4-0": "MID",
    "claude-haiku-4-5": "LOW",
    "<synthetic>": "LOW"
  }
```

That takes the map from 13 entries to 15. Also extend the `price_table.note` (line 39) so the reason the map has a non-billable id in it survives the next reader — append this sentence to the existing note string:

```
 '<synthetic>' is not a billable model; it is mapped to the cheapest tier so no-model assistant entries stop forcing tokens_directional.complete:false, and it carries no cost meaning.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd harness-core && node --test test/config.test.mjs`
Expected: PASS

- [ ] **Step 5: Full suite green**

Run: `cd harness-core && node --test`

Expected: all tests pass (**your recorded baseline + 2 new**). Two suites read this config and are the ones to watch: `test/tokens-collect.test.mjs` has an unknown-model case driven by `fixtures/unknown-model.jsonl` — confirm that fixture's id is not one of the two ids just added, or that test's `complete: false` expectation inverts. `test/tokens-collect-cli.test.mjs` also asserts against `claude-opus-4-8`, which is untouched.

- [ ] **Step 6: Commit**

```bash
git add harness-core/config/routing.json harness-core/test/config.test.mjs
git commit -m "harness-core: map claude-opus-5 and <synthetic> in model_id_to_tier; bump price-table version"
```
### Task 6: `directional_uncaptured` anomaly rule

**Files:**
- Modify: `harness-core/tools/lib/anomalies.mjs:48-102` (inside `recordChecks`, after the succeeded-only early return at line 79)
- Test: `harness-core/test/anomalies.test.mjs`

**Interfaces:**
- Consumes: `scanAnomalies({ dir, repo, limit, routing })` from `harness-core/tools/lib/anomalies.mjs` — unchanged signature, unchanged `{ ok, scanned, findings }` return; `findings[]` entries stay `{ run_id, check, detail }`. Reads only two record fields: `record.tokens_observed` (object keyed by model id → `{ input, output, ... }` numbers, or absent/`null` on pre-directional-era records) and `record.tokens_directional` (`{ by_model, complete }` or absent/`null`).
- Produces: a new flag code `directional_uncaptured` in `findings[].check`. No new export, no new function, no signature change — later tasks and the `anomalies` CLI case (`harness-core/tools/harness.mjs:396`) need no edit.
- Does NOT touch `costMid` (line 17), `outlierChecks` (line 104) or the `cost_outlier` entry (line 115). Task 7 of this plan deletes `estimated_cost`, `costMid` and `cost_outlier`; nothing in this task reads `record.estimated_cost` or calls `costMid`, and the new test fixtures assert only on `directional_uncaptured`, so Task 7 can remove all three without editing anything written here.

**Decisions this task commits to:**

- **Predicate (exact):** the record flags when `record.status === 'succeeded'` **and** the summed observed token count over `record.tokens_observed` is `> 0` **and** (`record.tokens_directional` is nullish **or** its `by_model` is nullish **or** `Object.keys(by_model).length === 0`). Observed-total gating is what keeps a run that genuinely spawned nothing from flagging: no observed tokens means there was never anything to attribute, so an empty `by_model` is the correct answer, not a regression.
- **`complete: false` with a populated `by_model`:** does **not** flag, under this code or any other. That state is honest partial attribution — capture worked and named the models it recognised — whereas `directional_uncaptured` exists to catch total silence, and folding the lesser condition in would make the flag fire on healthy runs and get muted.
- **Placement:** immediately after the `if (record.status !== 'succeeded') return;` early return at line 79 and before the `if (events === null)` block, so it rides the existing per-record walk (no second pass over `records`) and sits unambiguously inside the succeeded-only region. It is deliberately above the `events === null` return so a succeeded run that also lost its event file still reports both facts.
- **No schema validation upstream:** `scanAnomalies` (line 163) `JSON.parse`s each of the newest `cfg.recent_limit` (50) files and pushes them straight into `records` — `writeRecord`'s schema check never runs on the read path. So this predicate is handed pre-`tokens_directional`-era and partially-written records. Every access is optional-chained and every sum defaults to `0`, so a record missing `tokens_observed`, missing `tokens_directional`, or holding `null` in either yields `false` rather than a `TypeError`. A throw here would abort the entire scan, not just one record.

- [ ] **Step 1: Write the failing test**

Append to `harness-core/test/anomalies.test.mjs`:

```javascript
// TARS-1271 shipped with an empty tokens_directional.by_model and nothing
// noticed: the gap was found by reading a record by hand weeks later. This
// rule is the automated version of that discovery.
test('directional_uncaptured: succeeded run with observed tokens but empty by_model is flagged', () => {
  const dir = scaffold();
  const rec = makeRecord({
    tokens_observed: { 'claude-opus-5': { input: 120000, output: 8000 } },
    tokens_directional: { by_model: {}, complete: false },
  });
  writeRun(dir, rec);
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.deepEqual(checksFor(r, rec.run_id), ['directional_uncaptured']);
});

test('directional_uncaptured: a populated by_model does not flag, even when complete is false', () => {
  const dir = scaffold();
  const rec = makeRecord({
    tokens_observed: { 'claude-opus-5': { input: 120000, output: 8000 } },
    // complete:false is honest partial attribution — an unknown model showed
    // up — not the total-silence case this rule watches for.
    tokens_directional: { by_model: { 'claude-opus-5': { input: 120000, output: 8000 } }, complete: false },
  });
  writeRun(dir, rec);
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.deepEqual(checksFor(r, rec.run_id), []);
});

test('directional_uncaptured: a run that observed zero tokens does not flag', () => {
  const dir = scaffold();
  const rec = makeRecord({
    tokens_observed: { 'claude-opus-5': { input: 0, output: 0 } },
    tokens_directional: { by_model: {}, complete: true },
  });
  writeRun(dir, rec);
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.deepEqual(checksFor(r, rec.run_id), []);
});

test('directional_uncaptured: non-succeeded runs with empty by_model are not flagged', () => {
  const dir = scaffold();
  const rec = makeRecord({
    status: 'cancelled',
    reason: { code: 'user_cancel', detail: 'x', phase: null, agent: null },
    tokens_observed: { 'claude-opus-5': { input: 120000, output: 8000 } },
    tokens_directional: { by_model: {}, complete: false },
  });
  writeRun(dir, rec, null);
  const r = scanAnomalies({ dir, routing: ROUTING });
  const checks = checksFor(r, rec.run_id);
  assert.ok(checks.includes('run_not_succeeded'));
  assert.ok(!checks.includes('directional_uncaptured'));
});

// scanAnomalies reads the 50 newest records WITHOUT schema-validating them, so
// records from eras predating tokens_directional land in this predicate. A
// throw here would abort the whole scan, not just skip one record.
test('directional_uncaptured: records missing or nulling the token fields do not throw', () => {
  const dir = scaffold();
  const absent = makeRecord({}); // makeRecord carries neither token field
  const nulled = makeRecord({ tokens_observed: null, tokens_directional: null });
  for (const rec of [absent, nulled]) writeRun(dir, rec);
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.deepEqual(checksFor(r, absent.run_id), []);
  assert.deepEqual(checksFor(r, nulled.run_id), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd harness-core && node --test test/anomalies.test.mjs`
Expected: FAIL — the first test errors with `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\n+ actual - expected\n\n+ []\n- [\n-   'directional_uncaptured'\n- ]` (the code does not exist yet, so nothing is pushed). The four negative/robustness tests pass vacuously; that is expected and they become meaningful once Step 3 lands.

- [ ] **Step 3: Write minimal implementation**

Insert into `harness-core/tools/lib/anomalies.mjs` directly after line 79 (`if (record.status !== 'succeeded') return;`) and before the `if (events === null)` block:

```javascript
  // TARS-1271 succeeded with tokens_observed full and tokens_directional.by_model
  // empty — every downstream attribution read zero and no one noticed for weeks,
  // because a silent enrichment failure looks identical to a quiet run. Gate on
  // observed > 0 so a run that genuinely spawned nothing stays clean: with no
  // tokens to attribute, an empty by_model is the right answer. Records reach
  // here unvalidated (scanAnomalies parses raw JSON, no schema check), so both
  // fields may be absent or null on pre-directional-era runs — optional-chain
  // everything rather than throw and abort the scan.
  const observedTotal = Object.values(record.tokens_observed ?? {}).reduce(
    (sum, v) => sum + (typeof v === 'number' ? v : (v?.input ?? 0) + (v?.output ?? 0)),
    0,
  );
  const byModel = record.tokens_directional?.by_model ?? null;
  // complete:false with a populated by_model is honest partial attribution, not
  // silence — it deliberately does not flag here or under any other code.
  if (observedTotal > 0 && (byModel === null || Object.keys(byModel).length === 0)) {
    flag('directional_uncaptured', `${observedTotal} observed tokens but tokens_directional.by_model is empty`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd harness-core && node --test test/anomalies.test.mjs`
Expected: PASS — all tests in the file, including the five new ones.

- [ ] **Step 5: Full suite green**

Run: `cd harness-core && node --test`
Expected: all tests pass (**your recorded baseline + 5 new**). The pre-existing `'clean scan: succeeded run with full skeleton produces no findings'` test must still assert `r.findings` deep-equals `[]` — `makeRecord` carries no `tokens_observed`, so `observedTotal` is `0` and the new rule stays silent on it.

- [ ] **Step 6: Commit**

```bash
git add harness-core/tools/lib/anomalies.mjs harness-core/test/anomalies.test.mjs
git commit -m "harness-core: flag succeeded runs whose directional capture is vacuous"
```
### Task 7: Drop `estimated_cost` from the record entirely

The harness stores RAW values only. `estimated_cost` is derived dollars computed inside the record layer from a price table that is stale the moment Anthropic changes pricing — and worse, it is computed from `tokens_by_tier`, which holds combined per-tier totals, so `estimateCost` prices only `in`/`out` and ignores cache reads and cache-creation tokens entirely. A stored number that is both stale-able and structurally wrong is worse than no number at all: a reader who sees `estimated_cost.mid` has no way to know it under-counts a cache-heavy run. Pricing is a read-time concern and belongs to whatever consumes the telemetry (the dashboard, an aggregation query), where the price table can be current and the cache dimensions can be honored. So the field, the math, and the CLI/schema surface that carry it all go.

**THIS MUST LAND AS ONE ATOMIC COMMIT.** `schemas/run-record.schema.json` is `additionalProperties: false`. If the code stops writing `estimated_cost` but the schema keeps it, nothing breaks — but if the schema entry is removed in a separate commit from the code, or vice versa in the other order, the intermediate commit has `initRun` writing a key the schema forbids, and `writeRecord` throws `HarnessError('invalid_record')` on **every single run** — the harness is completely dead at that SHA, and `harness_sha` provenance means a bisect lands on it. Code, schema, CLI, anomalies, and all tests change together in one commit.

**Files:**
- Modify: `harness-core/tools/lib/record.mjs` — remove `estimated_cost: null` from the `initRun` record literal (line 73); delete `estimateCost` and its comment block (lines 138-158); remove the `cost`/`prices` params from `finalizeRun`'s signature (line 160) and delete the cost branch (lines 176-180)
- Test: `harness-core/test/record.test.mjs` — delete the two `estimateCost`-behavior tests at lines 96-105 (`'finalizeRun computes estimated_cost bounds from tokens and a price table'`) and 107-114 (`'finalizeRun leaves estimated_cost null when tokens are absent'`); rewrite `'forced failure: malformed price tables never fail a run finalize'` (lines 157-166) — with `prices` gone there is no price table to malform, so this test is deleted outright, not adapted; rewrite `'recordObservedTokens does not compute or touch estimated_cost…'` (lines 269-278) to assert `estimated_cost` is absent before and after instead of comparing values; drop `cost: 0.2` from line 61, and drop `cost: 0.9` plus the `assert.equal(record.estimated_cost, 0.9)` assertion from lines 118 and 121 (the surrounding wall_ms/tokens assertions at 119-120 stay); drop `prices:` from line 273. Add the four new absence tests from Step 1.
- Modify: `harness-core/tools/lib/anomalies.mjs` — the `costMid` helper (17-21) and the `cost_outlier` entry in `outlierChecks` (115)
- Modify: `harness-core/schemas/run-record.schema.json` — the `estimated_cost` property block (84-98)
- Modify: `harness-core/tools/harness.mjs` — the `run-end` case (221-245), which parses `--cost` and forwards `cost`/`prices` into `finalizeRun`, plus the usage string (472)
- Test: `harness-core/test/anomalies.test.mjs` (fixture at 34, outlier test at 136-146), `harness-core/test/schemas.test.mjs` (20), `harness-core/test/schemas-v2.test.mjs` (35)
- Modify: `harness-core/config/routing.json` (39) — a prose note referencing cost estimation; the note text changes, the price table does not

**Interfaces:**
- Produces: `initRun({...})` returns `{ runId, runDir, harnessDir }` unchanged, but the record it writes **no longer contains an `estimated_cost` key at all** — not `null`, absent. Every consumer must use `'estimated_cost' in record === false`, never `record.estimated_cost === null`.
- Produces: `estimateCost` is **DELETED OUTRIGHT** — the export is removed from `record.mjs`, not merely un-exported. A private helper that nothing calls is dead code that the next reader will assume is live. Its dedicated tests in `record.test.mjs` are deleted with it: `'finalizeRun computes estimated_cost bounds from tokens and a price table'`, `'finalizeRun leaves estimated_cost null when tokens are absent'`, and `'forced failure: malformed price tables never fail a run finalize'`. Any file importing `estimateCost` after this task fails at module load.
- Produces: `finalizeRun`'s exact new signature — the `cost` and `prices` parameters are gone, everything else keeps its current order and defaults:
  ```javascript
  export function finalizeRun({ runDir, status, reason = null, wallMs = null, tokensByTier = null, billingMode = null, priceTableVersion = null, now = new Date(),
    activeMs = null, agentCount = null, skillMetrics = null })
  ```
  (Previously: `{ runDir, status, reason = null, wallMs = null, tokensByTier = null, cost = null, prices = null, billingMode = null, priceTableVersion = null, now = new Date(), activeMs = null, agentCount = null, skillMetrics = null }`.) It still stamps `billing_mode` (default `'unknown'`) and `price_table_version` (default `null`) — those are raw provenance about *how* the run was billed, not derived dollars, so they stay. Callers passing `cost:` or `prices:` now silently no-op, which is why the CLI `run-end` case must be cleaned in the same commit.
- Consumes: `tier_prices_usd_per_mtok` in `harness-core/config/routing.json` **STAYS IN PLACE.** Do not remove it. `test/config.test.mjs` asserts that every tier mapped in the routing table has a corresponding price entry, so deleting the table cascades into that suite for no benefit. The price table is legitimate reference data for a read-time consumer; only the record-layer math that consumed it goes away.

- [ ] **Step 1: Write the failing tests**

Add to `harness-core/test/record.test.mjs`, using the file's existing `freshRun()` helper and `readRecord`:

```javascript
// ---------------------------------------------------------------------------
// estimated_cost is GONE. It was derived dollars from a price table that goes
// stale the moment pricing changes, computed off tokens_by_tier — which meant
// it priced only in/out and silently ignored cache reads and cache creation.
// On a cache-heavy run that under-counted badly, with nothing in the record to
// say so. The harness stores raw counts; pricing belongs to the reader.
// ---------------------------------------------------------------------------

test('initRun does not write an estimated_cost key at all (not even null)', () => {
  const { runDir } = freshRun();
  const record = readRecord(runDir);
  assert.ok(!('estimated_cost' in record), 'estimated_cost must be absent, not null');
});

test('writeRecord REJECTS a record carrying estimated_cost (schema additionalProperties: false)', async () => {
  const { writeRecord } = await import('../tools/lib/record.mjs');
  const { runDir } = freshRun();
  const record = readRecord(runDir);
  record.estimated_cost = { lo: 11, mid: 33, hi: 55 };
  assert.throws(
    () => writeRecord(runDir, record),
    (err) => err.code === 'invalid_record',
    'a record with estimated_cost must be refused by the schema',
  );
});

test('finalizeRun on a succeeded run writes no estimated_cost key', () => {
  const { runDir } = freshRun();
  const record = finalizeRun({ runDir, status: 'succeeded', wallMs: 61_000, tokensByTier: { MID: 1_000_000 }, now: NOW });
  assert.equal(record.status, 'succeeded');
  assert.ok(!('estimated_cost' in record));
  assert.ok(!('estimated_cost' in readRecord(runDir)));
});

test('the string estimated_cost appears nowhere in a finalized record.json', () => {
  const { runDir } = freshRun();
  finalizeRun({ runDir, status: 'succeeded', tokensByTier: { LOW: 100, HIGH: 2_000_000 }, now: NOW });
  const raw = readFileSync(join(runDir, 'record.json'), 'utf8');
  assert.ok(!raw.includes('estimated_cost'), 'no cost field should be serialized to disk');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd harness-core && node --test test/record.test.mjs`

Expected: FAIL — four failures, for two distinct reasons.

Three are absence assertions failing because `initRun` still sets `estimated_cost: null` at `record.mjs:73`:
- `'initRun does not write an estimated_cost key at all (not even null)'` → `AssertionError: estimated_cost must be absent, not null` (the `assert.ok(!('estimated_cost' in record))` receives `false`).
- `'finalizeRun on a succeeded run writes no estimated_cost key'` → `AssertionError` on the same `in` check; the key survives from `initRun` even before `finalizeRun`'s cost branch runs, and with `tokensByTier: { MID: 1_000_000 }` and no `prices` the branch at 177-180 leaves it `null` rather than deleting it.
- `'the string estimated_cost appears nowhere in a finalized record.json'` → `AssertionError: no cost field should be serialized to disk`, because `JSON.stringify` at `record.mjs:113` emits `"estimated_cost": null`.

One is the schema assertion failing in the opposite direction — `'writeRecord REJECTS a record carrying estimated_cost (schema additionalProperties: false)'` → `AssertionError [ERR_MISSING_EXPECTED_EXCEPTION]: Missing expected exception`, because `run-record.schema.json` still declares `estimated_cost` (~84-98) as a permitted property, so `validate` returns no errors and `writeRecord` writes the record instead of throwing `HarnessError('invalid_record')`.
- [ ] **Step 3: Write minimal implementation**

Six source/config files and five test files change in this one step. Work
through them in order; nothing is testable until all of them are done, because
the schema and the code have to agree.

**3a. `harness-core/tools/lib/record.mjs` — drop the key.**

Delete line 73 from the `initRun` record literal:

```javascript
    estimated_cost: null,
```

The surrounding lines (`skill_metrics: null,` at 72 and `started_at:
now.toISOString(),` at 74) become adjacent. Do not replace it with anything —
the schema will forbid the key entirely, so writing `undefined` or leaving a
comment placeholder both invite a future reader to restore it.

**3b. `harness-core/tools/lib/record.mjs` — delete `estimateCost` outright.**

Delete lines 138-158 in their entirety, comment block included:

```javascript
// USD per million tokens. tokens_by_tier holds combined (in+out) counts, so
// the honest answer is a range: lo prices everything as input, hi as output,
// mid is their midpoint. Better bounds arrive when per-direction counts do.
export function estimateCost(tokensByTier, prices) {
  if (!tokensByTier || !prices) return null;
  // Metrics enrichment must never fail a run: a malformed price table (wrong
  // shape, non-numeric rates) yields null, not a throw or a NaN in the record.
  const usable = ([tier, n]) =>
    n > 0 && Number.isFinite(prices?.[tier]?.in) && Number.isFinite(prices?.[tier]?.out);
  const tiers = Object.entries(tokensByTier).filter(usable);
  if (!tiers.length) return null;
  let lo = 0;
  let hi = 0;
  for (const [tier, n] of tiers) {
    lo += (n / 1e6) * prices[tier].in;
    hi += (n / 1e6) * prices[tier].out;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const round = (x) => Math.round(x * 10000) / 10000;
  return { lo: round(lo), mid: round((lo + hi) / 2), hi: round(hi) };
}
```

That whole block goes. The comment is worth reading once before you delete it,
because it documents the exact defect: "tokens_by_tier holds combined (in+out)
counts" — the function never had the inputs to price a run correctly, and the
`lo`/`hi` range was an admission of that, not a feature.

**3c. `harness-core/tools/lib/record.mjs` — `finalizeRun` signature and body.**

Replace lines 160-163 (the signature). Before:

```javascript
export function finalizeRun({ runDir, status, reason = null, wallMs = null, tokensByTier = null, cost = null, prices = null, billingMode = null, priceTableVersion = null, now = new Date(),
  // v2 graft: active (gap-capped) time beside wall clock, per-skill perf metrics,
  // and agent counts by model/phase. All optional — omitting leaves prior values.
  activeMs = null, agentCount = null, skillMetrics = null }) {
```

After — `cost` and `prices` are gone; every other parameter keeps its position
and default, and `billingMode`/`priceTableVersion` stay because they are raw
provenance about how the run was billed, not derived dollars:

```javascript
export function finalizeRun({ runDir, status, reason = null, wallMs = null, tokensByTier = null, billingMode = null, priceTableVersion = null, now = new Date(),
  // v2 graft: active (gap-capped) time beside wall clock, per-skill perf metrics,
  // and agent counts by model/phase. All optional — omitting leaves prior values.
  activeMs = null, agentCount = null, skillMetrics = null }) {
```

Then delete the cost branch at lines 176-180:

```javascript
  if (cost !== null) record.estimated_cost = cost;
  else {
    const estimated = estimateCost(record.tokens_by_tier, prices);
    if (estimated) record.estimated_cost = estimated;
  }
```

Line 175 (`if (tokensByTier) record.tokens_by_tier = tokensByTier;`) and line
181 (`writeRecord(runDir, record);`) become adjacent. Nothing replaces the
branch — the record simply never gains the key.

**3d. `harness-core/tools/lib/anomalies.mjs` — `cost_outlier` and `costMid`.**

`cost_outlier` reads `r.estimated_cost`, which no longer exists on any record
written after this commit, so the check would silently evaluate every run to
`null` and never fire again. A rule that cannot fire is worse than no rule: it
reads as coverage. Delete it.

In `outlierChecks` (line 104), the loop tuple list at lines 113-116 becomes a
single entry. Before:

```javascript
    for (const [check, valueOf] of [
      ['wall_outlier', (r) => (typeof r.wall_ms === 'number' ? r.wall_ms : null)],
      ['cost_outlier', (r) => costMid(r.estimated_cost)],
    ]) {
```

After — keep the array-of-tuples shape rather than collapsing to a single
inline check, because the loop is the extension point where the next outlier
rule lands:

```javascript
    // Cost outliers are gone with estimated_cost: the harness stores raw token
    // counts, so "is this run unusually expensive" is a question for whoever
    // prices them (the dashboard, an aggregation query), where the price table
    // is current and cache reads are priced instead of silently ignored.
    for (const [check, valueOf] of [
      ['wall_outlier', (r) => (typeof r.wall_ms === 'number' ? r.wall_ms : null)],
    ]) {
```

`costMid` (lines 17-21) is now dead — verify that before deleting rather than
trusting this plan:

```bash
cd harness-core && grep -rn "costMid" tools test
```

Expected after 3d: the only hit is the definition itself at
`tools/lib/anomalies.mjs:17`. Then delete lines 17-21:

```javascript
function costMid(cost) {
  if (typeof cost === 'number') return cost;
  if (cost && typeof cost.mid === 'number') return cost.mid;
  return null;
}
```

`median` (lines 11-15) directly above it STAYS — `wall_outlier` still calls it.

**3e. `harness-core/schemas/run-record.schema.json` — delete the property.**

Delete lines 84-98, the entire `estimated_cost` block:

```json
    "estimated_cost": {
      "anyOf": [
        { "type": "number" },
        { "type": "null" },
        {
          "type": "object",
          "required": ["lo", "mid", "hi"],
          "additionalProperties": false,
          "properties": {
            "lo": { "type": "number" },
            "mid": { "type": "number" },
            "hi": { "type": "number" }
          }
        }
      ]
    },
```

The preceding line 83 is `"skill_metrics": { "type": ["object", "null"] },` and
the following line 99 is `"emit_trigger": { "enum": ["workflow", "sweep", null]
},` — both already carry their own trailing commas, so removing the block
between them leaves valid JSON with no comma surgery needed. Confirm anyway:

```bash
cd harness-core && node -e "JSON.parse(require('fs').readFileSync('schemas/run-record.schema.json','utf8')); console.log('parses')"
```

A trailing-comma slip here fails every single test in the suite at schema load,
not just the cost ones — which is a fast signal, but only if you know to look
for it.

**3f. `harness-core/tools/harness.mjs` — the `run-end` case and usage string.**

In the `case 'run-end':` block (starts line 221), the option declaration at
line 225 drops `cost`. Before:

```javascript
        'tokens-by-tier': { type: 'string' }, cost: { type: 'string' },
```

After:

```javascript
        'tokens-by-tier': { type: 'string' },
```

Then in the `finalizeRun` call (lines 235-245), delete lines 238-239:

```javascript
        cost: v.cost !== undefined ? Number(v.cost) : null,
        prices: routing.tier_prices_usd_per_mtok ?? null,
```

Line 237 (`tokensByTier: …`) and line 240 (`billingMode: user.billing_mode ??
null,`) become adjacent. `routing` is still used on the next line for
`priceTableVersion: routing.price_table?.version ?? null` and by
`collectAndStamp(v, routing)` further down, so the `const { routing, user } =
resolveConfig();` at line 234 stays exactly as it is — do not "clean up" an
unused binding that is still used twice.

Finally the usage string at line 472. Before:

```javascript
          'run-end': '--target <path> --run-dir <dir> --status <s> [--reason-code c --reason-detail d] [--tokens-by-tier json] [--cost usd]',
```

After:

```javascript
          'run-end': '--target <path> --run-dir <dir> --status <s> [--reason-code c --reason-detail d] [--tokens-by-tier json]',
```

Dropping `cost` from the `opts({...})` declaration means `--cost 1.23` on the
command line now **fails the run-end invocation** with a `parseArgs`
unknown-option error rather than being quietly ignored. That is the behavior we
want: a caller still passing `--cost` believes a number is being recorded, and a
loud failure tells them it is not. Grep the skills for stale callers before you
finish the task:

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/skills && grep -rn -- "--cost" harness-*-core
```

Expected: no output. If a `SKILL.md` does pass `--cost`, remove that flag from
its `run-end` command line in this same commit.

**3g. `harness-core/config/routing.json` — reword the note only.**

Line 39's `note` currently explains the lo/mid/hi range in terms of
`estimated_cost`, which no longer exists. Replace that one string value:

```json
    "note": "Tier-level list rates for the tier_models aliases (haiku/sonnet/opus). in/out are combined-direction bounds; cache_read/cache_write are the standard cache multipliers of the input rate (read ~0.1x, 5-minute write ~1.25x). Reference data for read-time consumers only — the harness stores raw token counts and computes no dollars; tokens_by_tier gives a lo/hi range because it holds in+out totals, while directional per-model sums (tokens_directional) can be priced to a point via model_id_to_tier. Bump version on any rate/column change so historical records stay re-priceable."
```

**`tier_prices_usd_per_mtok` itself STAYS.** `test/config.test.mjs` asserts
that every tier named in the routing table has a price entry, so deleting the
table cascades into that suite for no benefit — and the table is legitimate
reference data for the downstream consumer that now owns pricing.

**3h. The four other test files.**

`harness-core/test/anomalies.test.mjs` — three edits.

Delete `estimated_cost: null,` from the `makeRecord` fixture literal (line 34);
a record carrying the key can no longer be written, so leaving it in the fixture
would make every test in the file build an invalid record.

Rewrite the outlier test at lines 136-146. Before:

```javascript
test('wall and cost outliers vs the same repo+kind median are flagged', () => {
  const dir = scaffold();
  const a = makeRecord({ wall_ms: 100000, estimated_cost: { lo: 1, mid: 2, hi: 3 } });
  const b = makeRecord({ wall_ms: 110000, estimated_cost: { lo: 1, mid: 2.2, hi: 3 } });
  const c = makeRecord({ wall_ms: 900000, estimated_cost: { lo: 5, mid: 30, hi: 60 } });
  for (const rec of [a, b, c]) writeRun(dir, rec);
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.ok(checksFor(r, c.run_id).includes('wall_outlier'));
  assert.ok(checksFor(r, c.run_id).includes('cost_outlier'));
  assert.ok(!checksFor(r, a.run_id).includes('wall_outlier'));
  assert.ok(!checksFor(r, b.run_id).includes('cost_outlier'));
});
```

After — the wall-clock half is real coverage and must survive; the added
negative assertion is what stops a future author from reviving a cost rule that
prices tokens inside the record layer again:

```javascript
test('wall outliers vs the same repo+kind median are flagged', () => {
  const dir = scaffold();
  const a = makeRecord({ wall_ms: 100000 });
  const b = makeRecord({ wall_ms: 110000 });
  const c = makeRecord({ wall_ms: 900000 });
  for (const rec of [a, b, c]) writeRun(dir, rec);
  const r = scanAnomalies({ dir, routing: ROUTING });
  assert.ok(checksFor(r, c.run_id).includes('wall_outlier'));
  assert.ok(!checksFor(r, a.run_id).includes('wall_outlier'));
  assert.ok(!checksFor(r, b.run_id).includes('wall_outlier'));
  // No cost rule exists any more. estimated_cost was derived dollars computed
  // off tokens_by_tier, which meant it priced in/out only and ignored cache
  // reads entirely — so a cache-heavy run was under-counted with nothing in the
  // record saying so. Cost outliers belong to whoever prices the raw tokens.
  for (const rec of [a, b, c]) {
    assert.ok(!checksFor(r, rec.run_id).some((c2) => c2.includes('cost')));
  }
});
```

`harness-core/test/schemas.test.mjs` — delete `estimated_cost: 0.5,` (line 20)
from the valid-record fixture. With the schema property gone and
`additionalProperties: false`, that fixture asserts a record is VALID, so
leaving the key makes the test fail.

`harness-core/test/schemas-v2.test.mjs` — delete `estimated_cost: 0.5,` (line
35) from its fixture, same reason.

`harness-core/test/record.test.mjs` — beyond the deletions and additions Step 1
specified, two call sites pass `cost:` and must drop it:

- line 61: `record = finalizeRun({ runDir, status: 'succeeded', wallMs: 61000, tokensByTier: { LOW: 100 }, cost: 0.2, now: NOW });` → drop `cost: 0.2,`. The two assertions after it (`record.status`, `record.ended_at`) are unaffected.
- lines 117-122, `'finalizeRun honors an explicit wallMs and records tokens/cost'` — rename it and drop the cost line:

```javascript
test('finalizeRun honors an explicit wallMs and records raw tokens', () => {
  const { runDir } = freshRun();
  const record = finalizeRun({ runDir, status: 'succeeded', wallMs: 61_000, tokensByTier: { HIGH: 65_243 }, now: NOW });
  assert.equal(record.wall_ms, 61_000);
  assert.equal(record.tokens_by_tier.HIGH, 65_243);
});
```

- lines 269-278, `'recordObservedTokens does not compute or touch estimated_cost…'` — the invariant it guards (recording observed tokens does not trigger cost math) still matters, now expressed as absence:

```javascript
test('recordObservedTokens introduces no estimated_cost key — the harness stores raw counts only', () => {
  const { runDir } = freshRun();
  finalizeRun({ runDir, status: 'succeeded', tokensByTier: { MID: 1000 }, now: NOW });
  assert.ok(!('estimated_cost' in readRecord(runDir)));
  const record = recordObservedTokens({ runDir, total: 999_999, tier: 'MID' });
  assert.ok(!('estimated_cost' in record), 'a large observed total must not resurrect cost math');
  assert.ok(!('estimated_cost' in readRecord(runDir)));
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd harness-core && node --test test/record.test.mjs`

Expected: PASS. All four new absence tests from Step 1 pass, and every
retained test in the file still passes.

- [ ] **Step 5: Full suite green**

Run: `cd harness-core && node --test`

Expected: all tests pass, **your recorded baseline + 1**. The arithmetic: plus the
4 new absence tests from Step 1, minus the 3 deleted from
`record.test.mjs` (`'finalizeRun computes estimated_cost bounds from tokens and
a price table'`, `'finalizeRun leaves estimated_cost null when tokens are
absent'`, `'forced failure: malformed price tables never fail a run finalize'`).
No test is deleted from `anomalies.test.mjs`, `schemas.test.mjs`, or
`schemas-v2.test.mjs` — those are rewrites and fixture edits, so the count is
unchanged there. Net: **+4 − 3 = +1** over your recorded baseline.

If another task in this plan has already landed, its own tests are added on top;
compare against the count the previous task's Step 5 reported rather than your
original baseline.

Then prove nothing survives:

```bash
cd harness-core && grep -rn "estimated_cost\|estimateCost\|costMid" tools test schemas config
```

Expected: **no output**. Any hit is an incomplete task — a leftover in `tools`
or `schemas` is a live bug, and a leftover in `test` is a test asserting on a
field that can no longer exist.

- [ ] **Step 6: Commit**

```bash
git add harness-core/tools/lib/record.mjs \
        harness-core/tools/lib/anomalies.mjs \
        harness-core/tools/harness.mjs \
        harness-core/schemas/run-record.schema.json \
        harness-core/config/routing.json \
        harness-core/test/record.test.mjs \
        harness-core/test/anomalies.test.mjs \
        harness-core/test/schemas.test.mjs \
        harness-core/test/schemas-v2.test.mjs
git commit -m "harness-core: drop estimated_cost; harness stores raw values only"
```

One commit, not nine: `run-record.schema.json` is `additionalProperties: false`,
so any intermediate SHA where the code and the schema disagree has `initRun`
writing a key the schema forbids — `writeRecord` throws `invalid_record` on
every run, and `harness_sha` provenance means a future bisect lands on that
dead commit.
## Phase B — Round reduction

### Task 8: `split-oversized.mjs` operates on the real plan schema

The splitter has never fired on a real plan. `splitOversizedTasks` (`split-oversized.mjs:127`) reads `task.files` at line 132 and writes `files: [...]` at 144, but the artifact it is pointed at is `plan.json`, validated against `schemas/plan.schema.json`, whose unit objects are `additionalProperties: false` with exactly `id, title, locations, done_criteria, depends_on, block, group_id, tdd_required`. No `files`, no `acceptanceCriteria`. So `harness.mjs split-tasks --plan <run_dir>/plan.json` — the command `harness-plan-core/SKILL.md:127` tells the plan skill to run for any oversized unit — reads `undefined`, trips the `if (!files || …)` guard at 133, and returns every unit untouched. That is why TARS-1271's T05 was one agent grinding a 102-entry array one Read+Edit at a time.

Same mismatch a second time in the CLI: `harness.mjs:168` reads `plan.tasks ?? []` while the schema's array is `units`. Both sides must move for the command to work end to end.

**Decisions made here, so the implementer does not re-litigate them:**

- Emitted JSON key becomes `units`, not `tasks` — `emit({ units })`. The input key is `units`, the schema key is `units`, and a caller that pipes the output back into a plan file must not have to rename anything.
- Title wording becomes `${chunkList.length} locations` (was `files`). The field is `locations` and an entry may be `NEW: path`, which is not yet a file.
- `dirOf("NEW: src/a/b.js")` returns `"NEW: src/a"` — `dirOf` (line 22) does `lastIndexOf('/')` on the raw string, so the prefix lands inside the grouping key and every new file in `src/a/` groups separately from every existing file in `src/a/`. Fix: strip a leading `NEW:` (with optional whitespace) for the **grouping key only**; the chunk's `locations` keep the prefix verbatim, because harness-implement needs to know the file does not exist yet.

**Files:**
- Modify: `harness-core/tools/lib/split-oversized.mjs:22-25` (`dirOf`), `:55-81` (`chunkFiles`), `:96-114` (`scopeCriteria`), `:116-153` (`splitOversizedTasks`)
- Modify: `harness-core/tools/harness.mjs:162-170` (`split-tasks` case)
- Test: `harness-core/test/split-oversized.test.mjs`

**Interfaces:**
- Consumes: `validate(schema, obj) -> errors[]` and `loadSchema(name) -> schema` from `tools/lib/validate.mjs` — the call shape is taken from `harness.mjs:173`, `validate(loadSchema(v.schema), JSON.parse(...))`, where a length-0 array means valid.
- Produces: `splitOversizedTasks(units, cap = FILE_CAP) -> object[]` — units in input order; each unit whose `locations.length > cap` replaced by chunks carrying `{ id, title, locations, done_criteria, depends_on, block: 'parallel', group_id, tdd_required }`. `FILE_CAP = 8` unchanged. CLI `split-tasks` emits `{ units }`.

- [ ] **Step 1: Write the failing test**

Replace the `taskWith` helper at `test/split-oversized.test.mjs:31` in full, and add the imports:

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitOversizedTasks } from '../tools/lib/split-oversized.mjs'
import { loadSchema, validate } from '../tools/lib/validate.mjs'

const CLI = new URL('../tools/harness.mjs', import.meta.url).pathname

/**
 * A plan UNIT with n locations under one directory, plus the fields the splitter must carry over.
 *
 * Field names are the plan schema's, not the old prose plan's: the splitter reads plan.json,
 * whose units are additionalProperties:false, so `files`/`groupId`/`acceptanceCriteria` were
 * keys that never existed on the artifact and the splitter silently no-opped on every real run.
 */
const taskWith = (n, dir = 'src/client', extra = {}) => ({
  id: 'T05',
  title: 'Migrate axios to fetch',
  block: 'sequential',
  group_id: 'G3',
  locations: Array.from({ length: n }, (_, i) => `${dir}/f${i}.js`),
  tdd_required: true,
  done_criteria: ['no axios imports remain'],
  ...extra,
})
```

Migration of the existing tests — every `c.files`, `c.groupId`, `c.acceptanceCriteria` reference moves:

| Test (current line) | Change |
| --- | --- |
| `at or under the cap passes through by identity` (43) | no change — identity assertion still holds |
| `an empty files[] task is untouched` (54) | rename title to `an empty locations[] unit is untouched` |
| `no files key at all` (64) | title → `no locations key at all`; literal `{ groupId: 'G1' }` → `{ group_id: 'G1' }` |
| `cap is inclusive` (69) | no change |
| `102 files split into at least 13 chunks` (77) | `c.files.length` → `c.locations.length` (both uses) |
| `parent task is dropped` (83) | no change |
| `chunk files are the parent files exactly` (88) | `c.files` → `c.locations`; `parent.files` → `parent.locations` |
| `chunks are disjoint` (97) | `c.files` → `c.locations` |
| `inherits the parent groupId and is parallel` (108) | `c.groupId` → `c.group_id` |
| `chunk ids suffixed a, b, c…` (118) | no change |
| `ids stay unique past 26 chunks` (125) | no change |
| `several tasks in one array` (143) | inline `groupId: 'G1'` → `group_id: 'G1'` |
| `never mutates the input tasks` (151) | no change |
| `non-array argument` (158) | no change |
| `grouped by directory before packing` (169) | `files:` override → `locations:`; `c.files.map` → `c.locations.map`; message `c.files.join` → `c.locations.join` |
| `one directory exceeding the cap` (185) | `files:` → `locations:`; `c.files.length` → `c.locations.length` |
| `small directories pack together` (192) | `files:` → `locations:` |
| `chunk titles carry the scope and a count` (200) | `c.files.length` → `c.locations.length` |
| `description, rules, table and snippets copied verbatim` (210) | drop `c.description` (not a schema key); keep the extra-field copies; `c.tddRequired` → `c.tdd_required` |
| `absent optional fields are not invented` (228) | no change |
| `dependsOn is inherited` (236) | `dependsOn: ['T04']` → `depends_on: ['T04']`; `c.dependsOn` → `c.depends_on` (both uses) |
| `scoped path in the parent DONE is replaced` (250) | `files:` → `locations:`; `acceptanceCriteria:` → `done_criteria:`; `out[0].acceptanceCriteria` → `out[0].done_criteria`; `out[0].files` → `out[0].locations` |
| `each chunk DONE names only its own files` (259) | `files:`/`acceptanceCriteria:` → `locations:`/`done_criteria:`; `c.acceptanceCriteria` → `c.done_criteria`; `sib.files`/`c.files` → `sib.locations`/`c.locations` |
| `unsubstitutable DONE becomes a per-file loop` (275) | same four renames as above |
| `parent repo-wide assertion retained once on the last chunk` (284) | `files:`/`acceptanceCriteria:` → `locations:`/`done_criteria:`; `c.acceptanceCriteria.includes` → `c.done_criteria.includes` |
| `no acceptanceCriteria still splits` (296) | title → `no done_criteria`; literal unit uses `group_id`/`locations`; assert `Array.isArray(c.done_criteria)` |

New tests, appended to the file:

```javascript
test('a 9-location unit splits and every chunk validates against the plan schema', () => {
  // The whole reason this task exists: chunks that the plan schema rejects cannot be written
  // back to plan.json, so a splitter that produced `files`/`groupId` keys was unusable even
  // once it fired.
  const out = splitOversizedTasks([taskWith(9)], 4)
  assert.ok(out.length > 1, `9 locations at cap 4 should split, got ${out.length}`)
  const schema = loadSchema('plan')
  const errors = validate(schema, {
    run_id: 'R1',
    units: out,
    order: out.map(c => c.id),
    schema_version: '1.0.0',
  })
  assert.deepEqual(errors, [], `chunks are not schema-valid: ${JSON.stringify(errors)}`)
})

test('a NEW: location groups by its real directory, keeping the prefix in locations', () => {
  // dirOf on the raw string yields "NEW: src/a", a directory key no existing file can share,
  // so new files scattered into their own chunks away from the code they sit next to.
  const t = { ...taskWith(0), locations: [
    'src/a/one.js', 'src/a/two.js', 'src/a/three.js',
    'NEW: src/a/four.js', 'src/b/five.js', 'src/b/six.js',
  ] }
  const out = splitOversizedTasks([t], 4)
  const withNew = out.find(c => c.locations.some(l => l.startsWith('NEW: ')))
  assert.ok(withNew, 'the NEW: location vanished')
  assert.ok(withNew.locations.includes('NEW: src/a/four.js'), 'the NEW: prefix was stripped from locations')
  for (const c of out) {
    const dirs = new Set(c.locations.map(l => {
      const bare = l.replace(/^NEW:\s*/, '')
      return bare.slice(0, bare.lastIndexOf('/'))
    }))
    assert.equal(dirs.size, 1, `chunk ${c.id} mixes directories: ${c.locations.join(', ')}`)
  }
})

test('the CLI split-tasks case reads units and emits units', () => {
  // harness.mjs read plan.tasks, which the plan schema does not define — the command returned
  // an empty array for every real plan.json ever passed to it.
  const dir = mkdtempSync(join(tmpdir(), 'split-cli-'))
  const file = join(dir, 'plan.json')
  writeFileSync(file, JSON.stringify({
    run_id: 'R1',
    units: [taskWith(12, 'src/client')],
    order: ['T05'],
    schema_version: '1.0.0',
  }))
  const out = JSON.parse(execFileSync(process.execPath, [CLI, 'split-tasks', '--plan', file], { encoding: 'utf8' }))
  assert.ok(Array.isArray(out.units), `expected a units[] in the CLI output, got ${Object.keys(out).join(', ')}`)
  assert.equal(out.units.length, 2, `12 locations at cap 8 should be 2 units, got ${out.units.length}`)
  assert.deepEqual(out.units.flatMap(u => u.locations).sort(), taskWith(12).locations.sort())
  assert.deepEqual(validate(loadSchema('plan'), {
    run_id: 'R1', units: out.units, order: out.units.map(u => u.id), schema_version: '1.0.0',
  }), [], 'CLI output units are not schema-valid')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd harness-core && node --test test/split-oversized.test.mjs`
Expected: FAIL. The renamed existing tests fail with `TypeError: Cannot read properties of undefined (reading 'length')` on `c.locations.length`, the schema test fails with `chunks are not schema-valid: [...]` naming `files`/`groupId`/`acceptanceCriteria` as unexpected properties, and the CLI test fails with `12 locations at cap 8 should be 2 units, got 0` (or `expected a units[] in the CLI output, got tasks`).

- [ ] **Step 3: Write minimal implementation**

`split-oversized.mjs` — replace `dirOf` (lines 22-25):

```javascript
/**
 * Directory portion of a location, '' for a bare filename.
 *
 * The `NEW: ` prefix is stripped first. plan.json locations use it to mark a file the unit
 * creates, and lastIndexOf('/') on the raw string returns "NEW: src/a" — a grouping key no
 * existing file in src/a can ever match, so every new file became its own chunk, separated
 * from exactly the code it needs to sit beside.
 */
function dirOf(f) {
  const s = String(f).replace(/^NEW:\s*/, '');
  const i = s.lastIndexOf('/');
  return i === -1 ? '' : s.slice(0, i);
}
```

`chunkFiles` (lines 55-81) is unchanged — it calls `dirOf` for grouping and pushes the raw entry, so stripping inside `dirOf` fixes the grouping while the `NEW: ` prefix survives into the chunk.

`scopeCriteria` (lines 96-114) — parameter names only; the `list`/`isLast` logic is byte-identical, shown in full because the implementer reads tasks out of order:

```javascript
function scopeCriteria(criteria, chunkLocations, isLast) {
  const list = Array.isArray(criteria) ? criteria : [];
  const fileList = chunkLocations.join(' ');

  const scoped = list.map((c) => {
    const text = String(c);
    const pathRe = /(^|\s)(\.?\/?(?:[\w.-]+\/)+[\w.-]*)(?=\s|$)/;
    const m = text.match(pathRe);
    if (m && !/\.\w{1,4}$/.test(m[2])) {
      return text.replace(pathRe, `$1${fileList}`);
    }
    return `${text} — verified over this task's files only: ${fileList}`;
  });

  if (isLast && list.length) {
    return [...scoped, ...list.map(String)];
  }
  return scoped;
}
```

Replace `splitOversizedTasks` (lines 127-153):

```javascript
export function splitOversizedTasks(tasks, cap = FILE_CAP) {
  if (!Array.isArray(tasks)) return [];

  const out = [];
  for (const task of tasks) {
    // plan.schema.json calls this `locations` and is additionalProperties:false, so `task.files`
    // was undefined on every real plan.json — the guard below swallowed it and the splitter
    // returned every unit untouched. That is why TARS-1271's T05 ran as one agent over 102
    // entries.
    const locations = Array.isArray(task?.locations) ? task.locations : null;
    if (!locations || locations.length <= cap) {
      out.push(task);
      continue;
    }

    const groups = chunkFiles(locations, cap);
    groups.forEach((chunkList, i) => {
      const chunk = {
        ...task,
        id: `${task.id}${suffixFor(i)}`,
        title: `${task.title} (${dirOf(chunkList[0]) || 'files'}, ${chunkList.length} locations)`,
        locations: [...chunkList],
        group_id: task.group_id,
        block: 'parallel',
        done_criteria: scopeCriteria(task.done_criteria, chunkList, i === groups.length - 1),
      };
      out.push(chunk);
    });
  }
  return out;
}
```

Also update the module header comment at lines 3-14: `files[]` → `locations[]`, and `Same groupId + block:'parallel' + disjoint files[]` → `Same group_id + block:'parallel' + disjoint locations[]`. Same for the JSDoc at 117-125 (`whose files[] exceeds` → `whose locations[] exceeds`, and the fileless note becomes `the XS fast path hardcodes locations: []`).

`harness.mjs` — replace the `split-tasks` case body (lines 162-170):

```javascript
    case 'split-tasks': {
      // Split any unit whose locations[] exceeds the per-task cap into same-group parallel
      // siblings (directory-coherent chunks) so implement lands them as one commit without one
      // agent grinding 100 files serially. Keys are the plan schema's (`units`, `locations`):
      // this read was `plan.tasks` against a schema that has no `tasks`, so the command
      // returned an empty array for every plan.json it was ever given.
      const v = opts({ plan: { type: 'string' }, cap: { type: 'string' } });
      const plan = JSON.parse(readFileSync(v.plan, 'utf8'));
      const units = splitOversizedTasks(plan.units ?? [], v.cap !== undefined ? Number(v.cap) : undefined);
      emit({ units });
    }
```

Update the `split-tasks` usage string in `harness.mjs` (~460-480) so it reads `split-tasks --plan <plan.json> [--cap N]   split oversized units by locations[]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd harness-core && node --test test/split-oversized.test.mjs`
Expected: PASS

- [ ] **Step 5: Full suite green**

Run: `cd harness-core && node --test`
Expected: all tests pass (**your recorded baseline + 3 new**). If `harness-plan-core/SKILL.md:127` or any other test asserts the CLI emits `tasks`, update that reference to `units` in the same commit — the emitted key is `units`.

- [ ] **Step 6: Commit**

```bash
git add harness-core/tools/lib/split-oversized.mjs harness-core/tools/harness.mjs harness-core/test/split-oversized.test.mjs
git commit -m "harness-core: make split-oversized read the real plan schema (units/locations/done_criteria)"
```
### Task 9: Un-hardcode `splitRequired`

**Decision: option (a) — delete the field from the intake `--skill-metrics` payload.**

Justification against "determinism over LLM": a value an LLM types from prose is
not a measurement. `splitRequired` is worse than non-deterministic — it is a
*constant*, `false` on every intake record ever written, including the live
TARS-1271 record whose plan then produced a 102-location unit. Option (b) is
rejected on honesty grounds: `repo_scan.key_paths.length > FILE_CAP`
(`split-oversized.mjs:20`, `FILE_CAP = 8`) counts paths a human named in the
manifest, while `splitOversizedTasks` chunks `task.files` on a PLAN unit that
does not exist yet at intake time — it is a proxy that would be wrong most of
the time, and a wrong number is worse than an absent one because it looks
measured. Option (c) is the right long-term home, but it is a separate change to
the `split-tasks` CLI's stdout contract and to `harness-plan-core`; this task
removes the lie rather than relocating it. Intake structurally cannot know
whether a split is needed, so it must not claim to.

`schemas/run-record.schema.json` types `skill_metrics` as
`{ "type": ["object","null"] }` — free-form. Two consequences: no schema change
is needed to drop the key (removal cannot fail validation), and nothing
validates the shape, so nothing would have caught the constant either. The only
possible guard is a text-level test over the skill markdown itself — which is
why the failing test below asserts on `SKILL.md` content, not on a record.

**Files:**
- Modify: `harness-intake-core/SKILL.md:258-267` (the `--skill-metrics` line at 267 and the parenthetical at 261)
- Test: `harness-core/test/skill-metrics-literals.test.mjs` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks. Reads sibling skill dirs off disk the
  same way `test/portability.test.mjs:10-15` does — `ROOT = fileURLToPath(new
  URL('../..', import.meta.url))`, then `readdirSync(ROOT)` filtered to names
  starting with `harness-` that are directories.
- Produces: no exported code. Produces a repo-wide invariant later tasks must
  respect: no `SKILL.md` may contain a hardcoded `splitRequired` literal in a
  `--skill-metrics` example.

- [ ] **Step 1: Write the failing test**

```javascript
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
// hardcoded list silently missed a skill once already.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd harness-core && node --test test/skill-metrics-literals.test.mjs`

Expected: FAIL — `assert.deepEqual(offenders, [])` reports one entry,
`.../harness-intake-core/SKILL.md: hardcodes splitRequired -> --skill-metrics '{"intakeManifestPath":"<run_dir>/manifest.json","size_from_intake":"<size>","splitRequired":false}'`

- [ ] **Step 3: Write minimal implementation**

Edit `harness-intake-core/SKILL.md`. Replace the line at 267 (the whole
`--skill-metrics` continuation line) with exactly this — quoted in full,
including its four leading spaces and the trailing backslash removal, since 267
is the last continuation line of the `run-end` command:

```
      --skill-metrics '{"intakeManifestPath":"<run_dir>/manifest.json","size_from_intake":"<size>"}'
```

Then fix the sentence at 261, which advertises the removed key. Replace:

```
`--skill-metrics` (intake slice: manifest path, size, split flag):
```

with:

```
`--skill-metrics` (intake slice: manifest path and size — both read off the
manifest you just wrote; do NOT add a split flag here, intake cannot know
whether the plan will need splitting):
```

The parenthetical carries the reason forward so the next author does not
re-add the constant.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd harness-core && node --test test/skill-metrics-literals.test.mjs`
Expected: PASS

- [ ] **Step 5: Full suite green**

Run: `cd harness-core && node --test`
Expected: all tests pass (**your recorded baseline + 1 new**). `test/portability.test.mjs`
still passes — the new file introduces no user paths and the DENY terms are
untouched.

- [ ] **Step 6: Commit**

```bash
git add harness-core/test/skill-metrics-literals.test.mjs harness-intake-core/SKILL.md
git commit -m "harness-intake-core: drop hardcoded splitRequired from intake skill_metrics"
```

**Parallel-line audit (grep over the sibling skills):**

- `harness-plan-core/SKILL.md:249` and `:255` do carry a `--skill-metrics` line:
  `--skill-metrics '{"planSlug":"<KEY>","planCount":<n>,"taskCount":<n>,"architectRevisions":<n>}'`.
  Every value there is a `<n>` placeholder the driver fills from a real count,
  not a baked-in literal — so it needs no treatment under this task and the
  guard test does not flag it. It is, however, the natural landing spot if
  option (c) is ever taken up: `CLI split-tasks` already knows whether it split
  anything, so plan could report a real `splitRequired`.
- `harness-loop-core/SKILL.md` has no `--skill-metrics` line at all — nothing to
  fix there.
### Task 10: Preflight symbol check — flag a named symbol that exists nowhere

`preflight.mjs` already catches the mechanical lie about *files*: a
`key_paths` entry that does not exist, an evidence path that resolves to
nothing, a plan location naming a missing file. It catches nothing about
*symbols*. A manifest that claims "`handleClearFilters` already debounces" or a
plan unit whose `done_criteria` says "`useFetchClient` returns an AbortSignal"
passes preflight clean, and the first thing that notices is a verifier round —
50-75k tokens to discover a name that a substring search would have found.

The check is scoped deliberately narrowly. It does **not** grep the whole repo:
it reads only the files the artifact itself already names — `key_paths` and
`evidence` paths for intake, `locations` for plan — and asks whether each
symbol the artifact mentions appears as a substring anywhere in that text. If a
manifest says "`foo` lives in `src/a.ts`" and `foo` is nowhere in `src/a.ts`,
either the symbol is wrong or the path is wrong, and both are worth one line of
output before a verifier spends a round on it.

**This finding is ADVISORY, not a blocker.** It cannot be a hard failure,
because its false-negative case is legitimate and common: a plan unit that
*introduces* `useFetchClient` names a symbol that by definition does not exist
yet — which is exactly what the `NEW: <path>` convention at `preflight.mjs:98`
already encodes for files. A blocking symbol check would fail every greenfield
unit in the plan. So findings from this check carry `severity: 'advisory'` and
are excluded from the `ok` computation; a skill surfaces them to the author to
confirm or fix, and `preflight` still exits 0.

**Files:**
- Modify: `harness-core/tools/lib/preflight.mjs` — add `SYMBOL_RE` and
  `symbolChecks` beside `evidencePaths` (lines 20-32); call it from
  `intakeChecks` (after line 78) and `planChecks` (after line 115); change
  `preflight`'s return (lines 166-173) to compute `ok` over blocking findings only
- Test: `harness-core/test/preflight.test.mjs`

**Interfaces:**
- Consumes: `evidencePaths(text, target) -> string[]` (line 20) — repo-relative
  path tokens found in free text, already filtered to tokens whose first
  segment is a real directory. Reuse it verbatim; do not write a second path
  extractor. `keyPathOf(entry) -> string` (line 36) — strips the `" — note"`
  annotation off a `key_paths` entry. `targetOf(runDir) -> string` (line 11).
- Produces: `symbolChecks({ text, paths, target, label, findings }) -> void`,
  exported for direct unit testing. It appends zero or more findings and
  returns nothing. `text` is the free text to mine symbols from; `paths` is the
  array of repo-relative file paths to search in; `label` is the artifact
  context that goes into `detail` (e.g. `'claims_audit(conventions)'`,
  `'U2.done_criteria'`).
- Produces: the finding shape, which matches the existing `{ check, detail }`
  contract at lines 43/49/69/75 plus one new key:
  ```javascript
  { check: 'symbol_resolves', detail: '<label>: symbol not found in any named file: <symbol> (searched: src/a.ts, src/b.ts)', severity: 'advisory' }
  ```
  Existing findings gain **no** `severity` key — absent means blocking. This
  keeps every current test's `deepEqual(r.findings, [])` and
  `f.check === '…'` assertion working untouched.
- Produces: `preflight({ phase, runDir })` returns the same
  `{ ok, findings }` shape, but `ok` is now
  `findings.every((f) => f.severity === 'advisory')` rather than
  `findings.length === 0`. A run with only advisory findings is `ok: true` with
  a non-empty `findings` array — callers that treat `findings.length` as
  failure must read `ok` instead. `tools/harness.mjs`'s `preflight` case (~391)
  already prints the findings and exits on `ok`, so it needs no change; verify
  that before trusting it.
- Produces: `SYMBOL_RE` is NOT exported. It is an implementation detail, and a
  test that asserts on the regex rather than on findings would lock the pattern
  in place and break on every legitimate tuning of it.

**What counts as a symbol.** Two patterns, both narrow on purpose, because a
false positive here costs an author's attention on every single run:

1. A backticked identifier — `` `handleClear` `` — which is the author
   explicitly marking a code name.
2. A bare `camelCase`, `PascalCase`, or trailing-`()` token: `useFetchClient`,
   `EmsSearchPage`, `debounce()`.

Explicitly NOT symbols: single lowercase prose words (`debounce` on its own is
a verb an author uses in a sentence), anything containing `/` (that is a path,
already handled by `evidencePaths` — and matching it twice would double-report
the same defect), and tokens under 4 characters (`ok`, `id`, `URL` produce
noise at a rate that trains authors to ignore the whole check).

**Substring, not a definition parse.** The check asks "does this name appear
anywhere in this file's text," not "is this name defined here." A definition
parse needs a real parser per language, and the harness is zero-dependency;
worse, it would flag a symbol that is imported-and-used in the named file
rather than declared there, which is a perfectly good thing for a manifest to
claim. Substring search accepts some false negatives (the name appears in a
comment, or as part of a longer identifier) in exchange for near-zero false
positives.

**No child process.** `preflight.mjs` imports only `existsSync, readFileSync,
statSync` from `node:fs` and `join, dirname` from `node:path` (lines 6-7). Read
the files with `readFileSync` and use `String.prototype.includes`. Do not shell
out to `grep` — `anomalies.mjs` imports `execFileSync` and that is a different
module with a different job; adding a child process here puts a shell dependency
and a per-file process spawn into the one code path whose entire reason for
existing is being cheaper than the alternative.

- [ ] **Step 1: Write the failing tests**

Add to `harness-core/test/preflight.test.mjs`. These reuse the file's existing
`scaffold()` (line 9), `MANIFEST()` (line 19), and `PLAN()` (line 92) helpers.
`scaffold()` writes `src/app.ts` and `src/components/button.ts` with the body
`export {}\n`, which contains no identifiers — so any symbol these tests claim
lives there is genuinely absent unless the test writes the file itself.

```javascript
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
```

The last test imports a second symbol, so update the import at line 6:

```javascript
import { preflight, symbolChecks } from '../tools/lib/preflight.mjs';
```

`scaffold()` currently returns `{ target, runDir }` (line 16) and several
existing tests destructure only `runDir` — the tests above that write fixture
files take `target` too, which needs no helper change.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd harness-core && node --test test/preflight.test.mjs`

Expected: FAIL. Two distinct failure modes.

`'symbolChecks is exported and appends nothing when every symbol resolves'`
fails at import: `SyntaxError: The requested module '../tools/lib/preflight.mjs'
does not provide an export named 'symbolChecks'`. Because this is a module-load
error on the test file's own import statement, **every test in the file fails**,
including the currently-passing ones — that is expected at this step and resolves
as soon as the export exists.

The remaining new tests then fail on empty results once the export is in place:
`advisory(r)` returns `[]`, so
`'intake preflight flags a symbol named in evidence that appears in no named
file'` fails with `AssertionError: expected exactly one advisory, got []`, and
`'a symbol finding is advisory: preflight stays ok and does not block'` fails on
`assert.equal(r.findings.length, 1)` receiving `0`.

The three tests that assert *absence* of advisories (`'prose words, paths, and
short tokens…'`, `'a NEW: location is skipped…'`, `'a unit with no readable
locations…'`) will PASS vacuously at this step, since nothing produces
advisories yet. That is fine and expected — they exist to pin the behavior down
once Step 3 lands, and they are the tests that catch an over-eager regex.
- [ ] **Step 3: Write minimal implementation**

**3a. The symbol extractor and checker.** Add to
`harness-core/tools/lib/preflight.mjs` immediately after `evidencePaths` (which
ends at line 32), before `keyPathOf`:

```javascript
// Code names inside free artifact text. Two shapes only, both narrow, because a
// false positive here spends the author's attention on every run and trains
// them to skip the whole check: a backticked identifier (`handleClear` — the
// author explicitly marking a code name), or a bare camelCase/PascalCase token
// with an optional call suffix (useFetchClient, EmsSearchPage, debounce()).
// Deliberately NOT matched: lone lowercase prose words ("we should debounce the
// input" is a sentence, not a claim about a symbol), anything with a slash
// (that's a path — evidencePaths already owns it, and matching both would
// double-report one defect), and tokens under 4 chars (ok/id/URL are noise).
const BACKTICKED_RE = /`([A-Za-z_$][A-Za-z0-9_$]*)`/g;
const CASED_RE = /\b([a-z][a-z0-9_$]*[A-Z][A-Za-z0-9_$]*|[A-Z][a-z0-9_$]+[A-Z][A-Za-z0-9_$]*)\b/g;
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
```

`statSync(full).isFile()` matters: `key_paths` legitimately contains directory
entries (`'src/components/ — existing ui: …'` in the test fixture at
`test/preflight.test.mjs:64`), and `readFileSync` on a directory throws `EISDIR`.
The `continue` skips them rather than letting the throw escape — preflight must
never crash on a well-formed artifact.

**3b. Wire it into `intakeChecks`.** The function ends at line 79. Extend the
`claims_audit` loop (lines 72-78) and add a `key_paths` pass. Replace lines
66-78:

```javascript
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
```

**3c. Wire it into `planChecks`.** Inside the `for (const u of units)` loop
(lines 96-115), after the `depends_on` loop closes at line 114 and before the
loop's closing brace at 115, add:

```javascript
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
```

**3d. `implementChecks` gets NO symbol check.** Deliberate. By implement time
the plan has already been through a plan-phase preflight and a plan verifier, so
the symbols in it were already surfaced once; re-reporting them costs the
implement driver's attention on findings its author has already adjudicated.
Worse, implement runs *while* the code changes — a symbol absent at the start of
a unit is present by the end, so the check's answer depends on when it ran.
Leave `implementChecks` (lines 143-164) untouched.

**3e. `preflight`'s `ok` computation.** Replace line 172:

```javascript
  return { ok: findings.length === 0, findings };
```

with:

```javascript
  // Advisory findings inform, they do not gate. Existing findings carry no
  // severity key at all — absent means blocking — so every current caller and
  // test keeps working, and only symbol_resolves opts into non-blocking.
  return { ok: findings.every((f) => f.severity === 'advisory'), findings };
}
```

Note `findings.every(...)` on an empty array is `true`, so a clean run is still
`ok: true` — the empty case needs no special handling.

Before trusting that the CLI needs no change, verify how it consumes the result:

```bash
cd harness-core && sed -n '388,396p' tools/harness.mjs
```

If the `preflight` case exits on `r.findings.length` rather than on `r.ok`, fix
it to read `r.ok` in this same commit — otherwise an advisory finding would
block a run, which is precisely what this task's design forbids.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd harness-core && node --test test/preflight.test.mjs`

Expected: PASS — all 8 new tests plus every pre-existing test in the file.

Two pre-existing tests are the ones most likely to break, and both are load-
bearing regression signals rather than tests to adjust:

- `'intake preflight passes on a grounded manifest'` (line 29) asserts
  `deepEqual(r.findings, [])`. `MANIFEST()`'s summary is `'s'` and its
  acceptance criterion is `'does the thing'` — no camelCase, nothing backticked,
  nothing ≥4 chars that matches — so it must stay empty.
- `'intake preflight accepts annotated key_paths ("path — note") and prose
  slashes in evidence'` (line 57) also asserts `deepEqual(r.findings, [])`, and
  its fixture is the adversarial one: `'src/app.ts — the main entry (calls
  foo/bar patterns)'` and `'uses shadcn/ui conventions; components are
  button/input/label/textarea style'`. Every token there is either
  slash-joined (excluded), lowercase prose (excluded), or under 4 chars
  (excluded). If this test fails, `CASED_RE` or the length floor is too loose —
  fix the pattern, do not relax the test. This fixture is a real manifest that a
  measured run produced.

- [ ] **Step 5: Full suite green**

Run: `cd harness-core && node --test`

Expected: all tests pass, **your recorded baseline + 8 new**. If other tasks in this
plan have already landed, compare against the count the previous task's Step 5
reported instead of your original baseline.

The `ok` semantics changed, so check every other caller of `preflight`:

```bash
cd harness-core && grep -rn "preflight" tools test | grep -v "tools/lib/preflight.mjs\|test/preflight.test.mjs"
cd /Users/206618626@bwt3.com/Desktop/Repos/skills && grep -rn "preflight" harness-*-core/SKILL.md
```

Any caller branching on `findings.length` must branch on `ok`. **Two SKILL.md
prose edits are already known to be REQUIRED — they were verified against the
live files, so treat them as part of this task, not as a maybe:**

1. `harness-plan-core/SKILL.md:145` — "FIRST run the deterministic preflight and
   fix every finding before spending any verifier tokens" followed by
   `:150` "re-run until clean".
2. `harness-intake-core/SKILL.md:199` — same "fix every finding" wording,
   `:206` "Exit 1 → fix the manifest per the findings, re-run until clean."

Why this is load-bearing and not cosmetic: an advisory symbol finding is one the
author may legitimately *keep* (a unit that introduces a symbol names one that
does not exist yet — that is the whole reason the check is advisory). Paired with
"re-run until clean," a driver that obeys the prose literally will loop forever
on a finding that is never supposed to clear, burning a phase's entire budget.
Reword both to the effect of: "fix every **blocking** finding; `ok: true` is the
gate. Advisory findings are for you to confirm deliberately — a symbol you are
introducing in this unit is expected to be flagged and is not a defect."

Note that `tools/lib/looprecord.mjs:14` and `harness-loop-core/SKILL.md:200` also
match a `findings.length` grep, but they read the **anomalies** scan, not
preflight. Leave them alone — changing them would corrupt the loop's anomaly
count.

- [ ] **Step 6: Commit**

```bash
git add harness-core/tools/lib/preflight.mjs harness-core/test/preflight.test.mjs \
        harness-plan-core/SKILL.md harness-intake-core/SKILL.md
git commit -m "harness-core: advisory preflight check for symbols named in artifacts"
```

The two SKILL.md files are in the `git add` deliberately: the `ok` semantics and
the prose that tells a driver how to react to findings must change in one commit,
or a driver reading the old prose against the new semantics loops forever. If
Step 5's grep turned up a `tools/harness.mjs` edit too, add that path as well.
---

## Parked / Dropped

Recorded so a later session does not re-derive these from scratch, and does not
re-litigate them either.

### Parked

**B1 — parallel unit dispatch in harness-implement.** Dispatch same-`group_id`
`block: 'parallel'` units concurrently rather than serially. This is the largest
single wall-clock win available (TARS-1271's implement phase was 26 units run
one at a time), and Task 8 in this plan is its precondition — the splitter has
to actually produce parallel siblings before there is anything to dispatch in
parallel. Parked by explicit decision: a "lofty dream scenario that can be
pushed to later." Do not start it as part of this plan.

Confidence it would help: **high**. Confidence it is cheap: **low** — it touches
the implement orchestration loop, shared-file conflict detection, and per-group
commit assembly all at once.

### Dropped

**B2 — re-tier the implement driver to a cheaper model.** Premise inverted on
inspection. The hypothesis was that a cheap driver was spawning expensive
sub-implementers; the transcript shows the opposite — the implement driver wrote
22 of 26 units in its own context and delegated only 4. Cheapening the driver
would cheapen the seat doing nearly all of the actual work. Dropped.

**B3 — scope the verifier to the diff.** The hypothesis was that a verifier
reading whole files instead of the diff was wasting a round's worth of context.
But the round-2 finding on `EmsSearchPage.jsx` was a crash reachable only from
code the diff did not touch — a diff-scoped verifier would have missed it and
shipped the crash. The waste is real and the fix is wrong. Dropped.

**B5 — issue-key normalization.** Already fixed in commit `ce21d15`
(`harness-core: make residue + loop-record Jira-key aware`). No work remains.

---

## Execution Notes

- Phase A tasks 1-7 are independent of Phase B tasks 8-10; either phase can land
  first. Within Phase A, Task 2 (the peak-context fingerprint itself) and Task 3
  (rewiring discovery onto it) are the largest change and must land in that
  order — Task 3 consumes what Task 2 produces. Everything else in Phase A is
  order-free.
- Task 7 (drop `estimated_cost`) touches the schema with
  `additionalProperties: false`, so it must land as one atomic commit. Do not
  split it across tasks.
- After all ten tasks: re-run the three-point verification bar from Global
  Constraints. Bar item 2 (a live-path dry run leaving non-empty `by_model` with
  no manual backfill) is the one that proves this plan did its job — a green
  unit suite alone does not.
