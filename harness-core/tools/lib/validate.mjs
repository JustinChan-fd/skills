// Minimal JSON Schema subset validator (zero-dep by design; see spec §5/§10).
// Supported keywords: type, enum, const, pattern, required, properties,
// additionalProperties:false, items. Schemas stay standard JSON Schema so
// external tooling can consume them unchanged.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMAS_DIR = new URL('../../schemas/', import.meta.url);

export function loadSchema(name) {
  const path = fileURLToPath(new URL(`${name}.schema.json`, SCHEMAS_DIR));
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function validate(schema, data, path = '$') {
  const errors = [];
  walk(schema, data, path, errors);
  return errors;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function walk(schema, data, path, errors) {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(data, t))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(data)}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, data))) {
    errors.push(`${path}: value ${JSON.stringify(data)} not in enum`);
    return;
  }
  if (schema.const !== undefined && !deepEqual(schema.const, data)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.pattern && typeof data === 'string' && !new RegExp(schema.pattern).test(data)) {
    errors.push(`${path}: does not match pattern ${schema.pattern}`);
  }
  if (typeOf(data) === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in data)) errors.push(`${path}: missing required "${key}"`);
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in data) walk(sub, data[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!(key in props)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
  if (typeOf(data) === 'array' && schema.items) {
    data.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, errors));
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
