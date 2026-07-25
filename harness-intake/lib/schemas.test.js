import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LAYER_SCHEMA } from './schemas.js'

describe('LAYER_SCHEMA', () => {
  it('does NOT require files[]', () => {
    assert.ok(!LAYER_SCHEMA.required.includes('files'), 'files must not be required')
  })

  it('requires sampleFiles', () => {
    assert.ok(LAYER_SCHEMA.required.includes('sampleFiles'), 'sampleFiles must be required')
  })

  it('sampleFiles has maxItems: 5', () => {
    assert.equal(LAYER_SCHEMA.properties.sampleFiles.maxItems, 5)
  })

  it('sampleFiles items are strings', () => {
    assert.equal(LAYER_SCHEMA.properties.sampleFiles.items.type, 'string')
  })

  it('does NOT have a top-level files property', () => {
    assert.ok(!LAYER_SCHEMA.properties.files, 'files property must not exist on top-level schema')
  })
})

describe('LAYER_SCHEMA sublayer', () => {
  const sublayerItem = LAYER_SCHEMA.properties.sublayers.items

  it('does NOT require files[]', () => {
    assert.ok(!sublayerItem.required.includes('files'), 'sublayer files must not be required')
  })

  it('requires sampleFiles', () => {
    assert.ok(sublayerItem.required.includes('sampleFiles'), 'sublayer sampleFiles must be required')
  })

  it('sublayer sampleFiles has maxItems: 5', () => {
    assert.equal(sublayerItem.properties.sampleFiles.maxItems, 5)
  })

  it('does NOT have a sublayer files property', () => {
    assert.ok(!sublayerItem.properties.files, 'files property must not exist on sublayer schema')
  })
})
