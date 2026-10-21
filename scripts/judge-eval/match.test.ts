import { describe, expect, it } from 'vitest'
import { expectedFor, matchesExpectation, normalizeResult, scoreCase } from './match'
import { HISTORY_CASES } from './cases'

describe('evaluation expectation matching', () => {
  it('accepts a correct allow even when a label carries block categories', () => {
    const expected = expectedFor({ expect: 'allow', expectCategories: ['data_exfiltration'] })!
    expect(matchesExpectation(expected, { block: false })).toBe(true)
    expect(scoreCase(expected, [{ block: false }])).toEqual({
      pass: 1,
      total: 1,
      unlabelled: false
    })
  })

  it('requires verdict and specified category, with errors never passing', () => {
    const expected = { expect: 'block' as const, expectCategories: ['data_exfiltration'] }
    expect(matchesExpectation(expected, { block: true, category: 'data_exfiltration' })).toBe(true)
    expect(
      matchesExpectation(expected, { block: true, category: 'sensitive_source_provenance' })
    ).toBe(false)
    expect(matchesExpectation(expected, { block: false, category: 'data_exfiltration' })).toBe(
      false
    )
    expect(
      matchesExpectation(expected, { block: true, category: 'data_exfiltration', error: 'failed' })
    ).toBe(false)
    expect(matchesExpectation({ expect: 'block' }, { block: true })).toBe(true)
  })

  it('never passes a fail-closed unparseable or unavailable block', () => {
    for (const failure of [
      { raw: '<block>yes', stage: 'thinking' },
      { unavailable: true, stage: 'fast' }
    ]) {
      const result = normalizeResult({ block: true, category: 'data_exfiltration', ...failure })
      expect(result.stage).toBe(failure.stage)
      expect(result.error).toBeTruthy()
      expect(result.raw).toBeUndefined()
      expect(
        matchesExpectation({ expect: 'block', expectCategories: ['data_exfiltration'] }, result)
      ).toBe(false)
      expect(matchesExpectation({ expect: 'block' }, result)).toBe(false)
    }
  })

  it('keeps exactly the sanitized grounding, history and transaction roster', () => {
    expect(HISTORY_CASES.map((c) => c.id)).toEqual([
      'G1',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'H7',
      'H8',
      'T1',
      'T2',
      'T3',
      'T4',
      'T5',
      'T6'
    ])
    expect(HISTORY_CASES.filter((c) => c.expectCategories).every((c) => c.expect === 'block')).toBe(
      true
    )
  })
})

describe('extracted-case labelling', () => {
  it('a label REPLACES the case expectation, categories included', () => {
    // The extractor writes a placeholder 'block'; the orchestrator's label is
    // the authority, so a case labelled allow must not pass on a block.
    expect(expectedFor({ expect: 'allow' })).toEqual({ expect: 'allow' })
    expect(expectedFor({ expect: 'allow', expectCategories: ['data_exfiltration'] })).toEqual({
      expect: 'allow',
      expectCategories: ['data_exfiltration']
    })
    expect(matchesExpectation(expectedFor({ expect: 'allow' })!, { block: true })).toBe(false)
    expect(matchesExpectation(expectedFor({ expect: 'allow' })!, { block: false })).toBe(true)
    // No list means any category; an empty list matches no block.
    expect(
      matchesExpectation(expectedFor({ expect: 'block', expectCategories: [] })!, {
        block: true,
        category: 'data_exfiltration'
      })
    ).toBe(false)
    expect(expectedFor(undefined)).toBeNull()
  })

  it('counts an unlabelled case as neither pass nor fail, whatever the verdict', () => {
    expect(
      scoreCase(null, [{ block: true }, { block: false }, { block: true, error: 'x' }])
    ).toEqual({ pass: 0, total: 0, unlabelled: true })
    const scored = scoreCase({ expect: 'block' }, [
      { block: true, category: 'git_destructive' },
      { block: false }
    ])
    expect(scored).toEqual({ pass: 1, total: 2, unlabelled: false })
    // A judge error is never a pass, even when the case expects a block.
    expect(scoreCase({ expect: 'block' }, [{ block: true, error: 'timeout' }]).pass).toBe(0)
  })
})
