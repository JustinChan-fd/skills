import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { failsQualityContract, failsThinSpec, synthesizeKeyFindings } from './quality.js'

describe('failsQualityContract', () => {
  const GOOD = 'WHAT: add button\nWHERE: src/ui.ts\nHOW: call fn()\n```ts\ncode()\n```\nDONE: test passes'

  it('passes a well-formed description', () => {
    assert.equal(failsQualityContract(GOOD, false), false)
  })

  it('fails when WHAT is missing', () => {
    assert.equal(failsQualityContract('WHERE: x\nHOW: y\n```\n```', false), true)
  })

  it('fails when WHERE is missing', () => {
    assert.equal(failsQualityContract('WHAT: x\nHOW: y\n```\n```', false), true)
  })

  it('fails when HOW is missing', () => {
    assert.equal(failsQualityContract('WHAT: x\nWHERE: y\n```\n```', false), true)
  })

  it('fails when code fence is missing', () => {
    assert.equal(failsQualityContract('WHAT: x\nWHERE: y\nHOW: z', false), true)
  })

  it('fails when tddRequired and DONE is missing', () => {
    assert.equal(failsQualityContract('WHAT: x\nWHERE: y\nHOW: z\n```\n```', true), true)
  })

  it('passes when tddRequired and DONE is present', () => {
    assert.equal(failsQualityContract(GOOD, true), false)
  })

  it('passes when tddRequired=false and DONE absent', () => {
    assert.equal(failsQualityContract('WHAT: x\nWHERE: y\nHOW: z\n```\n```', false), false)
  })
})

describe('failsThinSpec', () => {
  const GOOD_DESC = 'WHAT: do it\nWHERE: in the file src/thing.ts at line 42\nHOW: call the method with args\n```ts\ncall()\n```'

  it('passes a substantive description', () => {
    assert.equal(failsThinSpec(GOOD_DESC), false)
  })

  it('fails when WHERE body is under 20 chars', () => {
    const desc = 'WHERE: short\nHOW: call the method with good args here\n```ts\nfn()\n```'
    assert.equal(failsThinSpec(desc), true)
  })

  it('fails when HOW body is under 20 chars (no trailing content)', () => {
    // The HOW regex captures lazily until next keyword or end-of-string.
    // With s-flag, the body includes everything after HOW: up to the next keyword.
    // To get a genuinely short HOW body, put DONE after it so the lazy match stops early.
    const desc = 'WHERE: in the file src/thing.ts at line 42\nHOW: call fn\nDONE: test\n```ts\nfn()\n```'
    assert.equal(failsThinSpec(desc), true)
  })

  it('fails when no code snippet present', () => {
    const desc = 'WHERE: in the file src/thing.ts at line 42\nHOW: call the method with good args here'
    assert.equal(failsThinSpec(desc), true)
  })
})

describe('synthesizeKeyFindings', () => {
  it('drops "could not determine" answers', () => {
    const qa = [
      { question: 'Q1', answer: 'could not determine the framework' },
      { question: 'Q2', answer: 'React 18' },
    ]
    const findings = synthesizeKeyFindings(qa)
    assert.equal(findings.length, 1)
    assert.ok(findings[0].includes('React 18'))
  })

  it('caps at 7 findings', () => {
    const qa = Array.from({ length: 10 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` }))
    const findings = synthesizeKeyFindings(qa)
    assert.equal(findings.length, 7)
  })

  it('formats as "question → answer"', () => {
    const qa = [{ question: 'What framework?', answer: 'React' }]
    const findings = synthesizeKeyFindings(qa)
    assert.equal(findings[0], 'What framework? → React')
  })

  it('returns empty array for empty input', () => {
    assert.deepEqual(synthesizeKeyFindings([]), [])
    assert.deepEqual(synthesizeKeyFindings(null), [])
  })
})
