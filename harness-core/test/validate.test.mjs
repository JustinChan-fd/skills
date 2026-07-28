import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../tools/lib/validate.mjs';

test('accepts matching object', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' }, age: { type: ['integer', 'null'] } },
  };
  assert.deepEqual(validate(schema, { name: 'x', age: 3 }), []);
  assert.deepEqual(validate(schema, { name: 'x', age: null }), []);
});

test('reports missing required and wrong types with paths', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  };
  assert.deepEqual(validate(schema, {}), ['$: missing required "name"']);
  assert.deepEqual(validate(schema, { name: 5 }), ['$.name: expected string, got integer']);
});

test('enum, const, pattern', () => {
  assert.deepEqual(validate({ enum: ['S', 'M', 'L'] }, 'M'), []);
  assert.equal(validate({ enum: ['S', 'M', 'L'] }, 'XL').length, 1);
  assert.deepEqual(validate({ const: '1.0.0' }, '1.0.0'), []);
  assert.equal(validate({ pattern: '^[0-9a-f]{6}$' }, 'zzz').length, 1);
});

test('arrays validate items with indexed paths', () => {
  const schema = { type: 'array', items: { type: 'string' } };
  assert.deepEqual(validate(schema, ['a', 'b']), []);
  assert.deepEqual(validate(schema, ['a', 7]), ['$[1]: expected string, got integer']);
});

test('additionalProperties: false rejects unknown keys', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
  assert.deepEqual(validate(schema, { a: 'x', b: 1 }), ['$: unexpected property "b"']);
});

test('number accepts integers; integer rejects floats', () => {
  assert.deepEqual(validate({ type: 'number' }, 3), []);
  assert.equal(validate({ type: 'integer' }, 3.5).length, 1);
});
