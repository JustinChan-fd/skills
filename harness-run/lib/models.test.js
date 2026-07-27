import { test } from 'node:test'; import assert from 'node:assert/strict'; import { MODEL } from './models.js'; test('MODEL.opus', () => assert.equal(MODEL.opus, 'claude-opus-5'))
