import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { resolveConfig, sizeBudgets, tierFor, expandHome, issueSourceFor, canonicalRepo } from '../tools/lib/config.mjs';
import { tierForModelId } from '../tools/lib/model-tier.mjs';

test('routing defaults load; sizes and tiers resolve', () => {
  const { routing } = resolveConfig({ env: {}, userFile: '/nonexistent' });
  assert.equal(sizeBudgets(routing, 'S').max_parallel_readers, 2);
  assert.equal(sizeBudgets(routing, 'L').watchdog_stall_seconds, 600);
  assert.deepEqual(tierFor(routing, 'read_only_discovery'), { tier: 'LOW', model: 'haiku', reasoning: 'MINIMAL' });
  assert.deepEqual(tierFor(routing, 'verifier_implement'), { tier: 'HIGH', model: 'opus', reasoning: 'FULL' });
});

test('unknown size and task type fail loudly', () => {
  const { routing } = resolveConfig({ env: {}, userFile: '/nonexistent' });
  assert.throws(() => sizeBudgets(routing, 'XL'), /unknown size/);
  assert.throws(() => tierFor(routing, 'vibe_check'), /unknown task type/);
});

test('user.json overrides load; env overrides user.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-cfg-'));
  const userFile = join(dir, 'user.json');
  writeFileSync(userFile, JSON.stringify({ defaultRepo: 'from-file', telemetry: { repo: 'u/t' } }));
  const noEnv = resolveConfig({ env: {}, userFile });
  assert.equal(noEnv.user.defaultRepo, 'from-file');
  const withEnv = resolveConfig({ env: { HARNESS_DEFAULT_REPO: 'from-env', HARNESS_TELEMETRY_DIR: '/tmp/tel' }, userFile });
  assert.equal(withEnv.user.defaultRepo, 'from-env');
  assert.equal(withEnv.user.telemetry.repo, 'u/t');
  assert.equal(withEnv.user.telemetry.dir, '/tmp/tel');
});

test('routing exposes cache_read/cache_write columns alongside in/out for every tier', () => {
  const { routing } = resolveConfig({ env: {}, userFile: '/nonexistent' });
  for (const tier of ['LOW', 'MID', 'HIGH']) {
    const rates = routing.tier_prices_usd_per_mtok[tier];
    for (const col of ['in', 'out', 'cache_read', 'cache_write']) {
      assert.equal(typeof rates[col], 'number', `${tier}.${col} must be numeric`);
    }
    // cache multipliers follow the standard convention against the input rate.
    assert.ok(Math.abs(rates.cache_read - rates.in * 0.1) < 1e-9);
    assert.ok(Math.abs(rates.cache_write - rates.in * 1.25) < 1e-9);
  }
});

test('routing exposes an explicit model-id-to-tier map covering the tier aliases in use', () => {
  const { routing } = resolveConfig({ env: {}, userFile: '/nonexistent' });
  const map = routing.model_id_to_tier;
  assert.equal(map['claude-opus-4-8'], 'HIGH');
  assert.equal(map['claude-sonnet-5'], 'MID');
  assert.equal(map['claude-haiku-4-5'], 'LOW');
  // every mapped tier must be a real pricing tier
  for (const tier of Object.values(map)) {
    assert.ok(routing.tier_prices_usd_per_mtok[tier], `unknown tier ${tier} in model_id_to_tier`);
  }
});

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

test('price_table provenance version reflects the per-model rate table', () => {
  const { routing } = resolveConfig({ env: {}, userFile: '/nonexistent' });
  assert.equal(routing.price_table.version, '2026-07-29.1');
  assert.equal(routing.price_table.retrieved, '2026-07-29');
  // The rates are only interpretable alongside what billing shape they assume:
  // batch (-50%), fast mode, and US-only residency (1.1x) all stack on top and
  // are deliberately excluded, so a re-pricer must be told that.
  assert.match(routing.price_table.billing_assumption, /non-batch/);
});

test('every model id in model_id_to_tier has a per-model price, and it is consistent with its tier', () => {
  const { routing } = resolveConfig({ env: {}, userFile: '/nonexistent' });
  const prices = routing.model_prices_usd_per_mtok;
  const COLS = ['in', 'out', 'cache_read', 'cache_write', 'cache_write_1h'];
  for (const [id, tier] of Object.entries(routing.model_id_to_tier)) {
    if (['opus', 'sonnet', 'haiku'].includes(id)) continue; // bare aliases price off their tier
    assert.ok(prices[id], `${id} resolves to tier ${tier} but has no per-model price`);
    for (const col of COLS) {
      assert.equal(typeof prices[id][col], 'number', `${id}.${col} must be a number`);
    }
  }
  // Cache columns are fixed multiples of the model's own input rate. A hand-edited
  // rate that breaks this ratio is a transcription error, not a real price.
  for (const [id, p] of Object.entries(prices)) {
    if (p.in === 0) continue; // <synthetic> carries no cost meaning
    assert.ok(Math.abs(p.cache_read - p.in * 0.1) < 1e-9, `${id} cache_read should be 0.1x input`);
    assert.ok(Math.abs(p.cache_write - p.in * 1.25) < 1e-9, `${id} cache_write should be 1.25x input`);
    assert.ok(Math.abs(p.cache_write_1h - p.in * 2) < 1e-9, `${id} cache_write_1h should be 2x input`);
    assert.ok(Math.abs(p.out - p.in * 5) < 1e-9, `${id} output should be 5x input`);
  }
});

test('claude-sonnet-5 carries its introductory-rate step-up so records stay re-priceable across it', () => {
  const { routing } = resolveConfig({ env: {}, userFile: '/nonexistent' });
  const s5 = routing.model_prices_usd_per_mtok['claude-sonnet-5'];
  // Introductory $2/$10 through 2026-08-31, standard $3/$15 from 2026-09-01. A
  // record is priced by comparing its started_at to this boundary, so both sets
  // of rates have to live in the table, not just the current one.
  assert.equal(s5.in, 2);
  assert.equal(s5.out, 10);
  assert.equal(s5.introductory_until, '2026-08-31');
  assert.equal(s5.standard_after.in, 3);
  assert.equal(s5.standard_after.out, 15);
});

test('expandHome expands leading tilde only', () => {
  assert.equal(expandHome('~/x'), join(homedir(), 'x'));
  assert.equal(expandHome('/abs/x'), '/abs/x');
});

// `--repo` was documented as "<slug>" on both `init-run` and `gh issue view`,
// which mean different things: user.json's KEY ("jarvis") vs the github slug
// ("JustinChan-fd/jarvis"). Callers passed the latter, so record.repo — the
// telemetry directory name and the run-id stem — was wrong at birth. The repo
// identity is user.json's key, and this resolver is the single place that
// decides it, rather than trusting each caller to spell it right.
test('canonicalRepo maps a github slug back to its user.json key', () => {
  const user = {
    repos: {
      webtarsthree: { path: '~/x', issue_source: 'jira' },
      jarvis: { path: '~/j', issue_source: 'github', github: 'JustinChan-fd/jarvis' },
    },
  };
  // The github slug resolves to the key, case-insensitively.
  assert.equal(canonicalRepo(user, 'JustinChan-fd/jarvis'), 'jarvis');
  assert.equal(canonicalRepo(user, 'justinchan-fd/JARVIS'), 'jarvis');
  // An exact key passes through, and is normalized to the registry's spelling.
  assert.equal(canonicalRepo(user, 'jarvis'), 'jarvis');
  assert.equal(canonicalRepo(user, 'Jarvis'), 'jarvis');
  assert.equal(canonicalRepo(user, 'webtarsthree'), 'webtarsthree');
});

// An unregistered repo must NOT be silently rewritten or dropped: adhoc targets
// legitimately have no user.json entry. It passes through unchanged so the
// slugifier downstream still makes it path-safe.
test('canonicalRepo passes through an unregistered repo unchanged', () => {
  const user = { repos: { jarvis: { path: '~/j', github: 'JustinChan-fd/jarvis' } } };
  assert.equal(canonicalRepo(user, 'some-adhoc-repo'), 'some-adhoc-repo');
  assert.equal(canonicalRepo(user, 'Owner/unregistered'), 'Owner/unregistered');
  assert.equal(canonicalRepo({}, 'anything'), 'anything'); // no repos at all
  assert.equal(canonicalRepo(undefined, 'anything'), 'anything');
});

test('issueSourceFor reads a repo\'s explicit issue_source, defaulting to jira', () => {
  const user = {
    repos: {
      webtarsthree: { path: '~/x', issue_source: 'jira' },
      jarvis: { path: '~/j', issue_source: 'github', github: 'me/jarvis' },
      legacy: { path: '~/l' }, // unset → default jira (back-compat)
    },
  };
  assert.equal(issueSourceFor(user, 'jarvis'), 'github');
  assert.equal(issueSourceFor(user, 'webtarsthree'), 'jira');
  assert.equal(issueSourceFor(user, 'legacy'), 'jira'); // default when unset
  assert.equal(issueSourceFor(user, 'unknown-alias'), 'jira'); // unknown repo → default
  assert.equal(issueSourceFor({}, 'anything'), 'jira'); // no repos at all → default
});
