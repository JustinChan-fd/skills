import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { resolveConfig, sizeBudgets, tierFor, expandHome, issueSourceFor } from '../tools/lib/config.mjs';

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

test('price_table provenance version reflects the cache-column addition', () => {
  const { routing } = resolveConfig({ env: {}, userFile: '/nonexistent' });
  assert.equal(routing.price_table.version, '2026-07-28.1');
  assert.equal(routing.price_table.retrieved, '2026-07-28');
});

test('expandHome expands leading tilde only', () => {
  assert.equal(expandHome('~/x'), join(homedir(), 'x'));
  assert.equal(expandHome('/abs/x'), '/abs/x');
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
