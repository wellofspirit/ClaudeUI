import { describe, expect, it } from 'vitest'
import { CodexUsageLedger, codexDisjointTokens } from '../usage-ledger'
import type { TokenUsageBreakdown } from '../protocol/v2/TokenUsageBreakdown'

/**
 * A cumulative snapshot shaped like the wire's. Every number defaults off
 * `total`, the way the fixture provider's 15-token turns arrive in the S0
 * probe, so a case only states the components it is about.
 */
function usage(total: number, parts: Partial<TokenUsageBreakdown> = {}): TokenUsageBreakdown {
  return {
    totalTokens: total,
    inputTokens: total,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    ...parts
  }
}

describe('the Codex per-thread usage baseline', () => {
  it('charges a CREATED thread its first frame in full', () => {
    const ledger = new CodexUsageLedger()
    ledger.openThread('root', 'created')
    ledger.observe('root', usage(15))
    expect(ledger.turnEnded('root')).toMatchObject({ totalTokens: 15, inputTokens: 15 })
  })

  it('writes nothing for a RESUMED thread’s replay and charges the next turn alone', () => {
    const ledger = new CodexUsageLedger()
    ledger.openThread('root', 'observed')
    // The replay frame: the thread's whole history, repeating the last
    // completed turn's cumulative (S0 case 2/3).
    ledger.observe('root', usage(30))
    expect(ledger.turnEnded('root')).toBeNull()
    ledger.observe('root', usage(45))
    expect(ledger.turnEnded('root')).toMatchObject({ totalTokens: 15 })
  })

  it('charges a FORK its own turn, not the source history its first frame carries', () => {
    const ledger = new CodexUsageLedger()
    // `excludeTurns: true` suppresses the replay, so the first frame the
    // product ever sees on a fork is already the source's total (S0 case 4).
    ledger.openThread('fork', 'observed')
    ledger.observe('fork', usage(45))
    expect(ledger.turnEnded('fork')).toBeNull()
    ledger.observe('fork', usage(60))
    expect(ledger.turnEnded('fork')).toMatchObject({ totalTokens: 15 })
  })

  it('folds a multi-request turn’s several frames into ONE delta', () => {
    const ledger = new CodexUsageLedger()
    ledger.openThread('root', 'created')
    ledger.observe('root', usage(15))
    ledger.observe('root', usage(30))
    ledger.observe('root', usage(45))
    expect(ledger.turnEnded('root')).toMatchObject({ totalTokens: 45 })
    expect(ledger.turnEnded('root')).toBeNull()
  })

  it('takes two turns in a row as two deltas, component by component', () => {
    const ledger = new CodexUsageLedger()
    ledger.openThread('root', 'created')
    ledger.observe('root', usage(30, { inputTokens: 20, outputTokens: 10 }))
    expect(ledger.turnEnded('root')).toMatchObject({ inputTokens: 20, outputTokens: 10 })
    ledger.observe('root', usage(105, { inputTokens: 65, outputTokens: 40, cachedInputTokens: 12 }))
    expect(ledger.turnEnded('root')).toEqual({
      totalTokens: 75,
      inputTokens: 45,
      cachedInputTokens: 12,
      cacheWriteInputTokens: 0,
      outputTokens: 30,
      reasoningOutputTokens: 0
    })
  })

  it('keeps a child thread’s books apart from the root’s, interleaved', () => {
    const ledger = new CodexUsageLedger()
    ledger.openThread('root', 'created')
    ledger.openThread('child', 'created')
    ledger.observe('root', usage(15))
    ledger.observe('child', usage(40))
    ledger.observe('root', usage(30))
    ledger.observe('child', usage(55))
    expect(ledger.turnEnded('child')).toMatchObject({ totalTokens: 55 })
    expect(ledger.turnEnded('root')).toMatchObject({ totalTokens: 30 })
    ledger.observe('child', usage(70))
    expect(ledger.turnEnded('child')).toMatchObject({ totalTokens: 15 })
  })

  it('re-seeds and charges nothing when ANY component of the cumulative goes down', () => {
    const ledger = new CodexUsageLedger()
    ledger.openThread('root', 'created')
    ledger.observe('root', usage(100, { inputTokens: 80, outputTokens: 20 }))
    expect(ledger.turnEnded('root')).toMatchObject({ totalTokens: 100 })
    // `fill_to_context_window` replaces the total and zeroes its components:
    // the totals went UP, one component did not, and there is no delta to take.
    ledger.observe('root', usage(258_400, { inputTokens: 258_400, outputTokens: 0 }))
    expect(ledger.turnEnded('root')).toBeNull()
    // From the replacement onward the deltas are honest again.
    ledger.observe('root', usage(258_450, { inputTokens: 258_430, outputTokens: 20 }))
    expect(ledger.turnEnded('root')).toMatchObject({ totalTokens: 50, outputTokens: 20 })
  })

  it('produces nothing for a turn end with no frame, or a delta of zero', () => {
    const ledger = new CodexUsageLedger()
    ledger.openThread('root', 'created')
    expect(ledger.turnEnded('root')).toBeNull()
    ledger.observe('root', usage(15))
    expect(ledger.turnEnded('root')).toMatchObject({ totalTokens: 15 })
    // A frame repeating the cumulative — a resume's replay landing on a thread
    // this session already has books for — is a zero delta, not a row.
    ledger.observe('root', usage(15))
    expect(ledger.turnEnded('root')).toBeNull()
  })

  it('seeds an unopened thread from its first frame rather than charging a lifetime', () => {
    const ledger = new CodexUsageLedger()
    ledger.observe('stranger', usage(900))
    expect(ledger.turnEnded('stranger')).toBeNull()
    ledger.observe('stranger', usage(915))
    expect(ledger.turnEnded('stranger')).toMatchObject({ totalTokens: 15 })
  })

  it('never re-seeds a thread it is already keeping books for', () => {
    const ledger = new CodexUsageLedger()
    ledger.openThread('root', 'created')
    ledger.observe('root', usage(15))
    // A re-resume onto another host: the same thread, the same history.
    ledger.openThread('root', 'observed')
    expect(ledger.turnEnded('root')).toMatchObject({ totalTokens: 15 })
  })

  it('reads a malformed component as zero rather than poisoning the row with NaN', () => {
    const ledger = new CodexUsageLedger()
    ledger.openThread('root', 'created')
    ledger.observe('root', usage(15, { outputTokens: Number.NaN }))
    expect(ledger.turnEnded('root')).toMatchObject({ totalTokens: 15, outputTokens: 0 })
  })
})

describe('Codex’s nested token shape as the disjoint one', () => {
  it('leaves the base input after both subsets and never re-adds reasoning', () => {
    expect(
      codexDisjointTokens({
        inputTokens: 1000,
        cachedInputTokens: 600,
        cacheWriteInputTokens: 200,
        outputTokens: 50
      })
    ).toEqual({ input: 200, output: 50, cacheWrite: 200, cacheWrite1h: 0, cacheRead: 600 })
  })

  it('floors the base input at zero when the subsets exceed the prompt', () => {
    expect(
      codexDisjointTokens({
        inputTokens: 10,
        cachedInputTokens: 30,
        cacheWriteInputTokens: 0,
        outputTokens: 0
      }).input
    ).toBe(0)
  })
})
