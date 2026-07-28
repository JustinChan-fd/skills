// plan.schema.json: the plan artifact harness-plan writes and harness-implement
// reads. Shape is defined by what preflight.mjs planChecks already validates:
// units[] with id/locations/done_criteria/depends_on, plus an order[] that is a
// permutation of the unit ids respecting deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema, validate } from '../tools/lib/validate.mjs';

const validPlan = {
  run_id: '2026-07-28T000000Z__webtarsthree__plan__issue-tars-1271__abc123',
  plan_key: 'TARS-1271-p1',
  units: [
    { id: 'U1', title: 'Merge TARS-1300 wrapper', locations: ['src/client/api.js'], done_criteria: ['clientFetch present'], depends_on: [] },
    { id: 'U2', title: 'Migrate api.js', locations: ['src/client/api.js'], done_criteria: ["no from 'axios' in api.js"], depends_on: ['U1'] },
  ],
  order: ['U1', 'U2'],
  schema_version: '1.0.0',
};

test('plan: a valid plan passes', () => {
  assert.deepEqual(validate(loadSchema('plan'), validPlan), []);
});

test('plan: units is required and must be a non-empty-shaped array of typed units', () => {
  const noUnits = { ...validPlan };
  delete noUnits.units;
  assert.ok(validate(loadSchema('plan'), noUnits).length > 0);
});

test('plan: a unit missing required fields fails', () => {
  const bad = { ...validPlan, units: [{ id: 'U1' }] };
  assert.ok(validate(loadSchema('plan'), bad).length > 0);
});

test('plan: order is required', () => {
  const noOrder = { ...validPlan };
  delete noOrder.order;
  assert.ok(validate(loadSchema('plan'), noOrder).length > 0);
});

test('plan: schema_version must be the const 1.0.0', () => {
  assert.ok(validate(loadSchema('plan'), { ...validPlan, schema_version: '2.0.0' }).length > 0);
});

test('plan: NEW: prefixed locations are allowed (implement creates the file)', () => {
  const withNew = {
    ...validPlan,
    units: [{ id: 'U1', title: 'x', locations: ['NEW: src/client/utils/clientFetch.js'], done_criteria: ['exists'], depends_on: [] }],
    order: ['U1'],
  };
  assert.deepEqual(validate(loadSchema('plan'), withNew), []);
});
