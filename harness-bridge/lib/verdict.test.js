import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verdictFor } from './verdict.js'

test('score >= 85 proceeds', () => assert.deepEqual(verdictFor(85, 0), { verdict: 'PROCEED', action: 'advance' }))
test('first miss re-asks (refine)', () => assert.deepEqual(verdictFor(70, 0), { verdict: 'RE_ASK', action: 'refine' }))
test('second miss exits', () => assert.deepEqual(verdictFor(70, 1), { verdict: 'EXIT', action: 'stop' }))
test('proceed even after a retry if score recovered', () => assert.deepEqual(verdictFor(90, 1), { verdict: 'PROCEED', action: 'advance' }))
