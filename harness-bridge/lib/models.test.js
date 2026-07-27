import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL } from './models.js'
test('bridge opus seat is claude-opus-5', () => assert.equal(MODEL.opus, 'claude-opus-5'))
