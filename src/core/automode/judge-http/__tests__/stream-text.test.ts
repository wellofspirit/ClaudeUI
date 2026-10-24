/**
 * `JudgeTextAccumulator`'s opening-format rule: a reply that cannot become one of the
 * request's `allowedPrefixes` is abandoned as soon as that is certain, and the throw carries
 * `JUDGE_OFF_FORMAT_CODE`. The over-budget throw carries `JUDGE_OVER_BUDGET_CODE`; an empty
 * reply carries `JUDGE_EMPTY_REPLY_CODE`, except the reasoning-ate-the-budget case, which stays
 * uncoded so the banner still names it.
 */
import { describe, it, expect } from 'vitest'
import {
  JUDGE_BUDGET_EXHAUSTED_MESSAGE,
  JUDGE_EMPTY_REPLY_MESSAGE,
  JUDGE_OFF_FORMAT_MESSAGE,
  JUDGE_OVER_BUDGET_MESSAGE,
  JudgeTextAccumulator
} from '../stream-text'
import { JUDGE_EMPTY_REPLY_CODE, JUDGE_OFF_FORMAT_CODE, JUDGE_OVER_BUDGET_CODE } from '../types'

const PREFIXES = ['<severity>', '<thinking>'] as const

function acc(allowedPrefixes: readonly string[] = PREFIXES, maxChars = 1024) {
  return new JudgeTextAccumulator({ allowedPrefixes, maxChars })
}

/** Run every delta through a fresh accumulator, returning the thrown error (if any). */
function pushAll(deltas: string[], prefixes: readonly string[] = PREFIXES) {
  const a = acc(prefixes)
  let err: unknown
  try {
    for (const d of deltas) a.push(d)
  } catch (e) {
    err = e
  }
  return { acc: a, err }
}

describe('JudgeTextAccumulator — allowedPrefixes', () => {
  it('a prose reply is abandoned on its first delta, coded off-format', () => {
    const { err } = pushAll(['We need assess the proposed action …'])
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe(JUDGE_OFF_FORMAT_CODE)
    expect((err as Error).message).toBe(JUDGE_OFF_FORMAT_MESSAGE)
  })

  it('leading whitespace and newlines before the prefix are fine', () => {
    const { acc: a, err } = pushAll([' \n\n', '<severity>5'])
    expect(err).toBeUndefined()
    expect(a.finish('stop', null)).toMatchObject({ text: ' \n\n<severity>5', finish: 'stop' })
  })

  it('whitespace-only deltas are skipped, not judged', () => {
    const a = acc()
    expect(a.push(' \n')).toBe(true)
    expect(a.push('\t')).toBe(true)
    expect(a.push('<severity>')).toBe(true)
  })

  it('a prefix split across deltas stays valid', () => {
    const a = acc()
    expect(a.push('<sev')).toBe(true)
    expect(a.push('erity>5')).toBe(true)
    expect(a.finish('stop', null).text).toBe('<severity>5')
  })

  it("'<' then 'b' throws on the second delta: no allowed prefix can start like that", () => {
    const a = acc()
    expect(a.push('<')).toBe(true)
    let err: unknown
    try {
      a.push('b')
    } catch (e) {
      err = e
    }
    expect((err as { code?: string }).code).toBe(JUDGE_OFF_FORMAT_CODE)
  })

  it('the match is case-insensitive', () => {
    const { err } = pushAll(['<SEVERITY>7', '</SEVERITY>'])
    expect(err).toBeUndefined()
  })

  it('a <thinking> block is an allowed opening, and the check stops there', () => {
    const { acc: a, err } = pushAll([
      '<thinking>the model deliberates</thinking>',
      '<severity>3</severity>'
    ])
    expect(err).toBeUndefined()
    expect(a.finish('stop', null).text).toBe(
      '<thinking>the model deliberates</thinking><severity>3</severity>'
    )
  })

  it('without allowedPrefixes a prose reply passes (fast mode / stage 2 unchanged)', () => {
    const a = new JudgeTextAccumulator({ maxChars: 1024 })
    expect(a.push('We need assess the proposed action')).toBe(true)
    expect(a.finish('stop', null).text).toBe('We need assess the proposed action')
  })

  it('allowedPrefixes: [] means no check at all (prose passes)', () => {
    const { acc: a, err } = pushAll(['We need assess the proposed action'], [])
    expect(err).toBeUndefined()
    expect(a.finish('stop', null).text).toBe('We need assess the proposed action')
  })

  it('a UTF-8 BOM before the prefix is fine (trimStart strips it)', () => {
    const { acc: a, err } = pushAll(['\uFEFF<severity>3'])
    expect(err).toBeUndefined()
    expect(a.finish('stop', null).text).toBe('\uFEFF<severity>3')
  })

  it('a code-fence opener is off-format, not silently allowed', () => {
    const { err } = pushAll(['```xml\n<severity>3'])
    expect((err as { code?: string }).code).toBe(JUDGE_OFF_FORMAT_CODE)
  })

  it('checks the KEPT text after the stop cut: one prose delta carrying the stop is off-format', () => {
    const a = new JudgeTextAccumulator({
      allowedPrefixes: PREFIXES,
      maxChars: 1024,
      stopSequences: ['</severity>']
    })
    expect(() => a.push('We need x</severity>')).toThrow(JUDGE_OFF_FORMAT_MESSAGE)
  })

  it('the off-format message never echoes the reply text', () => {
    const { err } = pushAll(['SECRET-REPLY-BODY We need assess'])
    expect((err as Error).message).toBe(JUDGE_OFF_FORMAT_MESSAGE)
    expect((err as Error).message).not.toContain('SECRET-REPLY-BODY')
    expect((err as Error).message).not.toContain('We need')
  })

  it('the off-format check runs before the budget check', () => {
    const a = acc(PREFIXES, 5)
    let err: unknown
    try {
      a.push('We need assess the proposed action')
    } catch (e) {
      err = e
    }
    expect((err as { code?: string }).code).toBe(JUDGE_OFF_FORMAT_CODE)
  })

  it('over budget still throws the same message, now coded', () => {
    const a = acc(PREFIXES, 10)
    expect(a.push('<severity>')).toBe(true) // exactly the budget, still fine
    let err: unknown
    try {
      a.push('1')
    } catch (e) {
      err = e
    }
    expect((err as Error).message).toBe(JUDGE_OVER_BUDGET_MESSAGE)
    expect((err as { code?: string }).code).toBe(JUDGE_OVER_BUDGET_CODE)
  })

  it('the onDelta tap sees the offending delta before the throw', () => {
    const seen: string[] = []
    const a = new JudgeTextAccumulator({
      allowedPrefixes: PREFIXES,
      maxChars: 1024,
      onDelta: (d) => seen.push(d)
    })
    expect(() => a.push('We need')).toThrow(JUDGE_OFF_FORMAT_MESSAGE)
    expect(seen).toEqual(['We need'])
  })
})

describe('JudgeTextAccumulator — an empty reply', () => {
  function finishError(a: JudgeTextAccumulator, finish: 'stop' | 'length'): unknown {
    try {
      a.finish(finish, null)
    } catch (e) {
      return e
    }
    return undefined
  }

  it('a reply with no text on stop throws the empty-reply error, coded', () => {
    const err = finishError(new JudgeTextAccumulator({ maxChars: 1024 }), 'stop')
    expect((err as Error).message).toBe(JUDGE_EMPTY_REPLY_MESSAGE)
    expect((err as { code?: string }).code).toBe(JUDGE_EMPTY_REPLY_CODE)
  })

  it('length without a stop cut keeps the budget message, uncoded', () => {
    // Reasoning ate the budget: a judge-configuration problem the banner should name, so this
    // one must NOT escalate.
    const err = finishError(new JudgeTextAccumulator({ maxChars: 1024 }), 'length')
    expect((err as Error).message).toBe(JUDGE_BUDGET_EXHAUSTED_MESSAGE)
    expect((err as { code?: string }).code).toBeUndefined()
  })

  it('a stop cut that leaves no kept text is coded empty too', () => {
    const a = new JudgeTextAccumulator({ stopSequences: ['</severity>'], maxChars: 1024 })
    a.push('</severity>')
    const err = finishError(a, 'stop')
    expect((err as Error).message).toBe(JUDGE_EMPTY_REPLY_MESSAGE)
    expect((err as { code?: string }).code).toBe(JUDGE_EMPTY_REPLY_CODE)
  })

  it('length AFTER a stop cut is an empty reply, not an exhausted budget', () => {
    // A route without a server stop cuts client-side and the provider runs on to its cap: the
    // reply still answered nothing usable, so it escalates rather than blaming the budget.
    const a = new JudgeTextAccumulator({ stopSequences: ['</severity>'], maxChars: 1024 })
    a.push('</severity>')
    const err = finishError(a, 'length')
    expect((err as Error).message).toBe(JUDGE_EMPTY_REPLY_MESSAGE)
    expect((err as { code?: string }).code).toBe(JUDGE_EMPTY_REPLY_CODE)
  })
})
