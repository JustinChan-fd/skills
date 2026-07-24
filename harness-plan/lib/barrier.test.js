import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PROBE_LOOPS,
  NEVER_LIST,
  matchesNeverList,
  makeBarrierRecord,
  validateBarrierRecord,
} from './barrier.js';

describe('MAX_PROBE_LOOPS', () => {
  it('is 2', () => {
    assert.equal(MAX_PROBE_LOOPS, 2);
  });
});

describe('matchesNeverList', () => {
  it('matches irreversible-destructive on "rm -rf"', () => {
    assert.equal(matchesNeverList('rm -rf /var'), 'irreversible-destructive');
  });
  it('matches irreversible-destructive on "force-push"', () => {
    assert.equal(matchesNeverList('git force-push origin main'), 'irreversible-destructive');
  });
  it('matches security-auth-permission on "token"', () => {
    assert.equal(matchesNeverList('rotate the token'), 'security-auth-permission');
  });
  it('matches security-auth-permission on "credential"', () => {
    assert.equal(matchesNeverList('update credential store'), 'security-auth-permission');
  });
  it('matches cost-over-threshold on "over budget"', () => {
    assert.equal(matchesNeverList('we are over budget'), 'cost-over-threshold');
  });
  it('matches public-api-contract on "breaking change"', () => {
    assert.equal(matchesNeverList('this is a breaking change to the API'), 'public-api-contract');
  });
  it('matches out-of-scope on "not in plan"', () => {
    assert.equal(matchesNeverList('this file is not in plan'), 'out-of-scope');
  });
  it('matches legal-compliance on "gdpr"', () => {
    assert.equal(matchesNeverList('GDPR applies here'), 'legal-compliance');
  });
  it('returns null for a safe action', () => {
    assert.equal(matchesNeverList('refactor the DAG helper'), null);
  });
  it('is case-insensitive', () => {
    assert.equal(matchesNeverList('Force-Push to origin'), 'irreversible-destructive');
  });
  it('returns null for empty string', () => {
    assert.equal(matchesNeverList(''), null);
  });
  it('NEVER_LIST covers all six categories', () => {
    const expected = [
      'irreversible-destructive',
      'security-auth-permission',
      'cost-over-threshold',
      'public-api-contract',
      'out-of-scope',
      'legal-compliance',
    ];
    assert.deepEqual(Object.keys(NEVER_LIST), expected);
  });
});

describe('makeBarrierRecord', () => {
  it('fills defaults for missing optional fields', () => {
    const r = makeBarrierRecord({ decision: 'd', hinge: 'h', blocking: false });
    assert.deepEqual(r, { decision: 'd', hinge: 'h', options: [], probes: [], confidence: null, blocking: false });
  });
  it('coerces blocking to boolean', () => {
    assert.equal(makeBarrierRecord({ decision: 'd', hinge: 'h', blocking: 1 }).blocking, true);
    assert.equal(makeBarrierRecord({ decision: 'd', hinge: 'h', blocking: 0 }).blocking, false);
  });
  it('preserves provided options and probes', () => {
    const r = makeBarrierRecord({ decision: 'd', hinge: 'h', options: ['a'], probes: ['b'], confidence: 0.8, blocking: true });
    assert.deepEqual(r.options, ['a']);
    assert.deepEqual(r.probes, ['b']);
    assert.equal(r.confidence, 0.8);
    assert.equal(r.blocking, true);
  });
});

describe('validateBarrierRecord', () => {
  it('valid when all required fields present and blocking is boolean', () => {
    const r = makeBarrierRecord({ decision: 'do X', hinge: 'unknown Y', blocking: false });
    assert.deepEqual(validateBarrierRecord(r), { valid: true, errors: [] });
  });
  it('invalid when decision is missing', () => {
    const r = makeBarrierRecord({ decision: '', hinge: 'h', blocking: false });
    const { valid, errors } = validateBarrierRecord(r);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('decision')));
  });
  it('invalid when hinge is missing', () => {
    const r = makeBarrierRecord({ decision: 'd', hinge: '', blocking: true });
    const { valid, errors } = validateBarrierRecord(r);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('hinge')));
  });
  it('invalid when blocking is not a boolean', () => {
    const r = { decision: 'd', hinge: 'h', options: [], probes: [], confidence: null, blocking: 'yes' };
    const { valid, errors } = validateBarrierRecord(r);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('blocking')));
  });
  it('invalid on null record', () => {
    const { valid } = validateBarrierRecord(null);
    assert.equal(valid, false);
  });
});
