// Tests for the OTel capture diagnostic's guards.
//
// SCOPE. The capture itself spawns `claude` and cannot be unit-tested without spending
// money, so what is tested here is everything that decides WHETHER to spend it and how the
// result is read: the two refusals, the rate reconciliation, and the model-id extraction.
// Those are the parts that can be wrong in a way that produces a clean-looking number.
//
// HONEST NOTE ON ORDER. These tests were written AFTER `eval/otel-capture.mjs`, not before.
// That is a TDD violation and it is recorded rather than hidden. The substitute evidence is
// that every assertion below was falsified against a deliberately broken implementation
// before being trusted — the failure was watched, just not in the right order. Where a test
// exists only because the falsification found a hole, the comment says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  contentFlagViolations,
  staleSeatEnv,
  reconcile,
  modelIdsFromOtlp,
  p1Verdict,
  EXPECTED_P1_SOURCES,
} from '../eval/otel-capture.mjs';

// --- the content-flag refusal ---
//
// This is the guard with the worst failure mode in the repo: OTEL_LOG_RAW_API_BODIES writes
// the entire conversation history, and its `file:<dir>` form writes untruncated bodies to
// disk. A capture that leaks a transcript is strictly worse than no capture, so the refusal
// must fire on presence, not on some notion of "enabled".

test('a set content-capture flag is refused', () => {
  const v = contentFlagViolations({ OTEL_LOG_RAW_API_BODIES: 'file:/tmp/leak' });
  assert.deepEqual(v, ['OTEL_LOG_RAW_API_BODIES']);
});

test('every content flag is covered, not just the worst one', () => {
  // Bidirectional in spirit: if a flag is added to the forbidden list, it must actually be
  // checked; if one is removed, this fails loudly rather than silently permitting it.
  const all = {
    OTEL_LOG_USER_PROMPTS: '1',
    OTEL_LOG_ASSISTANT_RESPONSES: 'true',
    OTEL_LOG_TOOL_DETAILS: '1',
    OTEL_LOG_TOOL_CONTENT: '1',
    OTEL_LOG_RAW_API_BODIES: '1',
  };
  const v = contentFlagViolations(all);
  assert.equal(v.length, 5, `expected all five flags flagged, got ${JSON.stringify(v)}`);
});

test('absent and explicitly-disabled flags are not violations', () => {
  // Without this the guard would refuse to run in the normal case, and a guard that always
  // fires gets disabled by whoever is trying to get work done.
  assert.deepEqual(contentFlagViolations({}), []);
  assert.deepEqual(
    contentFlagViolations({
      OTEL_LOG_USER_PROMPTS: '0',
      OTEL_LOG_TOOL_DETAILS: 'false',
      OTEL_LOG_TOOL_CONTENT: '',
    }),
    [],
  );
});

// --- the stale-shell refusal ---
//
// The whole point of the re-run is to read a model id. A shell that pre-dates the .zshrc fix
// inherits `anthropic.claude-sonnet-4-6` from its parent `claude` process and cannot see the
// corrected file, because a non-interactive zsh sources no startup file. Running there would
// stamp the field under test with a stale value and the result would read clean.

test('the pre-fix inherited sonnet id is refused', () => {
  const problems = staleSeatEnv({
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic.claude-sonnet-4-6',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic.claude-opus-5',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /sonnet-4-6/);
});

test('an ABSENT opus id is refused, not treated as acceptable', () => {
  // The distinction that was the actual diagnosis: absent means the pre-fix .zshrc never
  // exported it, so there was nothing to inherit. An `undefined` that reads as "fine" is
  // exactly how a stale shell would slip through.
  const problems = staleSeatEnv({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic.claude-sonnet-5' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /absent/);
});

test('a post-fix shell passes both seat checks', () => {
  assert.deepEqual(
    staleSeatEnv({
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic.claude-sonnet-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic.claude-opus-5',
    }),
    [],
  );
});

// --- rate reconciliation ---
//
// The load-bearing arithmetic. The 2026-07-30 figure of $0.291135 on 4642/264/0/41812 is
// what made the finding sharp: it matches opus-5 to seven decimals while the record named
// haiku. If this function drifts, the re-run cannot make that comparison.

test('the 2026-07-30 figure still reconciles to opus-5 and to nothing else', () => {
  const rows = reconcile({
    inputTokens: 4642,
    outputTokens: 264,
    cacheCreationInputTokens: 41812,
    cacheReadInputTokens: 0,
  });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.usd]));

  const OBSERVED = 0.291135;
  assert.ok(
    Math.abs(byLabel['opus-5 $5/$25'] - OBSERVED) < 1e-7,
    `opus-5 should explain the observed figure; got ${byLabel['opus-5 $5/$25']}`,
  );

  // And crucially NOT the others — a reconciler that matched everything would "confirm"
  // any hypothesis, which is the unfalsifiable shape this project keeps finding.
  for (const label of ['sonnet-5 $3/$15', 'sonnet-5 intro $2/$10', 'haiku-4-5 $1/$5']) {
    assert.ok(
      Math.abs(byLabel[label] - OBSERVED) > 1e-3,
      `${label} must NOT also match ${OBSERVED} — got ${byLabel[label]}`,
    );
  }
});

test('cache writes bill at 1.25x input and cache reads at 0.1x', () => {
  // Found by falsification: an earlier version dropped the cacheRead term entirely and the
  // test above still passed, because the 2026-07-30 record had cacheRead = 0. A real arm C
  // record will not, so the coefficient needs its own case with a nonzero value.
  const [row] = reconcile({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 1_000_000,
    cacheReadInputTokens: 0,
  }).filter((r) => r.label === 'sonnet-5 $3/$15');
  assert.ok(Math.abs(row.usd - 3.75) < 1e-9, `1M cache writes at $3 input = $3.75, got ${row.usd}`);

  const [readRow] = reconcile({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 1_000_000,
  }).filter((r) => r.label === 'sonnet-5 $3/$15');
  assert.ok(Math.abs(readRow.usd - 0.3) < 1e-9, `1M cache reads at $3 input = $0.30, got ${readRow.usd}`);
});

test('the reconciler does not import our own price table', async () => {
  // The circularity guard. This script exists to check whether an EXTERNAL price table
  // agrees with ours; if it priced from lib/prices.mjs the comparison could not fail.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../eval/otel-capture.mjs', import.meta.url), 'utf8'),
  );
  assert.ok(
    !/from\s+['"][^'"]*lib\/prices\.mjs['"]/.test(src),
    'otel-capture.mjs must not import lib/prices.mjs — that would make the check circular',
  );
});

// --- model-id extraction ---
//
// P1 is "do all sources agree", so a missed source is a false agreement. That is the
// dangerous direction: the report would print "distinct ids = 1" and look like a fix.

test('a model attribute is found on a nested OTLP metric payload', () => {
  const payload = {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.cost.usage',
                sum: {
                  dataPoints: [
                    { attributes: [{ key: 'model', value: { stringValue: 'sonney' } }] },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const found = modelIdsFromOtlp(payload, '/v1/metrics');
  assert.equal(found.length, 1, `expected one model id, got ${JSON.stringify(found)}`);
  assert.equal(found[0].model, 'sonney');
});

test('two different ids in one payload are both reported, not collapsed', () => {
  // The original finding was a DISAGREEMENT, so an extractor that collapsed its results
  // would erase the very thing being measured.
  //
  // A NOTE ON HOW THIS WAS FALSIFIED, because the first attempt was a bad experiment and
  // that is worth recording. I injected a dedupe-by-model and the test still passed — which
  // looks like the "green falsification means the guard cannot fire" hazard. It was not:
  // deduping BY MODEL keeps both records when the models differ, so the injected mutation
  // was not a break for this input at all. The lesson is that a falsification can fail by
  // testing nothing, and a passing falsification has two explanations — a blind test, or a
  // mutation that did not mutate. Distinguish them before concluding. It fires against
  // `found.slice(0, 1)`, which is a real collapse.
  const payload = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              { attributes: [{ key: 'model', value: { stringValue: 'claude-haiku-4-5-20251001' } }] },
              { attributes: [{ key: 'model', value: { stringValue: 'sonney' } }] },
            ],
          },
        ],
      },
    ],
  };
  const found = modelIdsFromOtlp(payload, '/v1/logs');
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.model).sort(), ['claude-haiku-4-5-20251001', 'sonney']);
});

test('a payload with no model attribute yields nothing rather than a default', () => {
  // A defaulted id here would manufacture agreement out of an empty payload — the same
  // failure shape as `seatModelFor` defaulting instead of throwing.
  assert.deepEqual(modelIdsFromOtlp({ resourceLogs: [{ scopeLogs: [{ logRecords: [] }] }] }, 'x'), []);
  assert.deepEqual(modelIdsFromOtlp({}, 'x'), []);
});

// --- P1's denominator ---
//
// The bug this closes: `distinct.length === 1` counted ids without ever counting SOURCES, so
// agreement among the sources that happened to arrive read identically to agreement among all
// four. That is the §2.8 shape — $1.072 judged against an $18 cap, a precise number whose
// denominator was wrong.
//
// The gate has to be ASYMMETRIC, and run1 is why. Run1's listener crashed and captured zero
// OTLP payloads, so only result.json survived — yet result.json alone yields TWO ids (the
// modelUsage key `anthropic.claude-sonnet-5` and `canonicalModel` `claude-sonnet-5`), so run1
// printed P1 FAILS off 1 of 4 sources. That verdict was CORRECT: adding sources can never
// repair a disagreement, so a FAILS on a partial set is sound. A blanket "INCONCLUSIVE if
// incomplete" would have thrown away a valid answer. Only HOLDS needs the full denominator.

test('P1 cannot hold when a source is missing, and names which', () => {
  // The exact starved shape: only result.json present, and — counterfactually — agreeing.
  // Nothing here disagrees, so the OLD code would have printed HOLDS off one source.
  const verdict = p1Verdict([
    { kind: 'result.json modelUsage', where: 'key', model: 'claude-sonnet-5' },
    { kind: 'result.json', where: 'canonicalModel', model: 'claude-sonnet-5' },
  ]);
  assert.equal(verdict.status, 'INCONCLUSIVE');
  assert.equal(verdict.arrived, 1);
  assert.equal(verdict.expected, 4);
  assert.deepEqual(verdict.missing, ['cost.usage metric', 'token.usage metric', 'api_request log']);
  assert.doesNotMatch(verdict.line, /HOLDS/, 'a starved set must not read as agreement');
});

test('P1 FAILS on a partial set, because a disagreement cannot be repaired by more sources', () => {
  // Run1's actual sources, verbatim from its capture-record.json. 1 of 4 arrived, and the
  // verdict is still a real answer. This is the asymmetry: silence cannot manufacture a
  // disagreement, so FAILS needs no denominator.
  const verdict = p1Verdict([
    { kind: 'result.json modelUsage', where: 'key', model: 'anthropic.claude-sonnet-5' },
    { kind: 'result.json', where: 'canonicalModel', model: 'claude-sonnet-5' },
  ]);
  assert.equal(verdict.status, 'FAILS');
  assert.equal(verdict.arrived, 1);
  assert.deepEqual(verdict.distinct.sort(), ['anthropic.claude-sonnet-5', 'claude-sonnet-5']);
});

test('P1 HOLDS only with all four sources agreeing', () => {
  const verdict = p1Verdict([
    { kind: 'result.json modelUsage', where: 'key', model: 'claude-sonnet-5' },
    { kind: '/v1/metrics', where: 'claude_code.cost.usage', model: 'claude-sonnet-5' },
    { kind: '/v1/metrics', where: 'claude_code.token.usage', model: 'claude-sonnet-5' },
    { kind: '/v1/logs', where: 'api_request', model: 'claude-sonnet-5' },
  ]);
  assert.equal(verdict.status, 'HOLDS');
  assert.equal(verdict.arrived, 4);
  assert.deepEqual(verdict.missing, []);
});

test('total silence is INCONCLUSIVE, not agreement', () => {
  const verdict = p1Verdict([]);
  assert.equal(verdict.status, 'INCONCLUSIVE');
  assert.equal(verdict.arrived, 0);
  assert.equal(verdict.missing.length, 4);
});

test('the four expected sources are declared, not inferred from what arrived', () => {
  // If the expected set were derived from the observed sources, `missing` would always be
  // empty and the guard could not fire — the unfalsifiable shape. Freeze the list.
  assert.equal(EXPECTED_P1_SOURCES.length, 4);
  assert.deepEqual(
    EXPECTED_P1_SOURCES.map((s) => s.label),
    ['result.json', 'cost.usage metric', 'token.usage metric', 'api_request log'],
  );
});

test("run2's real sources satisfy all four, so its P1 FAILS was a full-denominator verdict", () => {
  // Verbatim from run2's capture-record.json, with the metric/log names the fixed extractor
  // now preserves. This is the regression anchor for the run that actually happened: its
  // verdict was FAILS, and it was reached with nothing missing.
  const verdict = p1Verdict([
    { kind: 'result.json modelUsage', where: 'key', model: 'anthropic.claude-sonnet-5' },
    { kind: 'result.json', where: 'canonicalModel', model: 'claude-sonnet-5' },
    { kind: '/v1/logs', where: 'api_request', model: 'claude-sonnet-5' },
    { kind: '/v1/logs', where: 'assistant_response', model: 'claude-sonnet-5' },
    { kind: '/v1/metrics', where: 'claude_code.cost.usage', model: 'anthropic.claude-sonnet-5' },
    { kind: '/v1/metrics', where: 'claude_code.token.usage', model: 'anthropic.claude-sonnet-5' },
  ]);
  assert.equal(verdict.status, 'FAILS');
  assert.deepEqual(verdict.missing, []);
  assert.equal(verdict.arrived, 4);
});

// --- source identity ---
//
// A denominator needs to know WHICH source arrived, and run2 showed the extractor was throwing
// that away: cost.usage and token.usage both reported `where: 'dataPoints'`, api_request
// reported `where: 'logRecords'`. Indistinguishable sources cannot be counted.

test('a metric attribute carries its metric name, not the container key', () => {
  // Run2's real shape. Before this, `where` was 'dataPoints' and cost.usage could not be
  // told apart from token.usage.
  const payload = {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.cost.usage',
                sum: {
                  dataPoints: [
                    { attributes: [{ key: 'model', value: { stringValue: 'anthropic.claude-sonnet-5' } }] },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const [found] = modelIdsFromOtlp(payload, '/v1/metrics');
  assert.equal(found.where, 'claude_code.cost.usage');
});

test('a log record carries its event.name, not the container key', () => {
  // Same problem on the logs side: run2's api_request and assistant_response both reported
  // 'logRecords', so the api_request source could not be confirmed present.
  const payload = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  { key: 'event.name', value: { stringValue: 'api_request' } },
                  { key: 'model', value: { stringValue: 'claude-sonnet-5' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const [found] = modelIdsFromOtlp(payload, '/v1/logs');
  assert.equal(found.where, 'api_request');
});

test('non-string attribute values are preserved rather than dropped', () => {
  // Falsification found this: an early version read only `stringValue`, so an id arriving
  // as an intValue vanished and its source silently stopped counting toward P1.
  const payload = {
    m: { attributes: [{ key: 'model', value: { intValue: 42 } }] },
  };
  const found = modelIdsFromOtlp(payload, 'x');
  assert.equal(found.length, 1);
  assert.equal(found[0].model, '42');
});
