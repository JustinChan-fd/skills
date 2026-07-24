import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyAcBullet } from './classify.js'

describe('classifyAcBullet', () => {
  it('marks migration ACs as isMigration', () => {
    const r = classifyAcBullet('Migrate axios imports to clientFetch in src/client/')
    assert.equal(r.isMigration, true)
    assert.equal(r.isCleanup, false)
    assert.equal(r.isValidation, false)
    assert.equal(r.isDeferred, false)
  })

  it('marks remove/delete ACs as isCleanup', () => {
    const r = classifyAcBullet('Remove axios dependency from package.json')
    assert.equal(r.isCleanup, true)
    assert.equal(r.isMigration, false)
  })

  it('marks verify/confirm ACs as isValidation', () => {
    const r = classifyAcBullet('Verify all clientFetch calls succeed in CI')
    assert.equal(r.isValidation, true)
    assert.equal(r.isMigration, false)
  })

  it('marks npm install ACs as isValidation via isCleanup+isDeferred combo', () => {
    const r = classifyAcBullet('Run npm install and verify clean install with no axios-related warnings')
    assert.equal(r.isValidation, true)
    assert.equal(r.isMigration, false)
  })

  it('marks AbortController ACs as isDeferred', () => {
    const r = classifyAcBullet('Add AbortController timeout support to clientFetch wrapper')
    assert.equal(r.isDeferred, true)
    assert.equal(r.isMigration, false)
  })

  it('check keyword marks as isValidation', () => {
    const r = classifyAcBullet('Check that no axios references remain')
    assert.equal(r.isValidation, true)
    assert.equal(r.isMigration, false)
  })

  it('remains keyword marks as isValidation', () => {
    const r = classifyAcBullet('Ensure no bare fetch() call remains in src/client/')
    assert.equal(r.isValidation, true)
    assert.equal(r.isMigration, false)
  })

  it('package.json keyword marks as isCleanup', () => {
    const r = classifyAcBullet('Update package.json to remove axios')
    assert.equal(r.isCleanup, true)
    assert.equal(r.isMigration, false)
  })

  it('Replace fetch() calls is migration (not validation despite "remain" keyword absent)', () => {
    const r = classifyAcBullet('Replace bare fetch() calls with clientFetch in src/client/')
    assert.equal(r.isMigration, true)
    assert.equal(r.isValidation, false)
  })

  it('baseline keyword marks as isValidation', () => {
    const r = classifyAcBullet('Establish a baseline test suite passing rate')
    assert.equal(r.isValidation, true)
    assert.equal(r.isMigration, false)
  })
})
