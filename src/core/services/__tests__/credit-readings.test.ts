// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  onCreditReading,
  publishCreditReading,
  resetCreditReadings,
  type CreditReadingWritten
} from '../credit-readings'

/**
 * The credits relay's publisher (ADR-072 §4, amended 2026-10-01).
 *
 * The instant a reading carries is when it was READ, which the caller states —
 * for ChatGPT the last full read, never a live turn's push. Every live turn
 * re-records the account, so the same read arrives over and over and must be
 * published once; a new read is a new instant and always goes.
 */
const T = 1_759_300_000_000

function reading(over: Partial<CreditReadingWritten> = {}): CreditReadingWritten {
  return {
    accountKey: 'chatgpt:ws-1:user-1',
    accountLabel: 'member@example.com',
    vendorId: 'openai',
    plan: 'business',
    credits: { unlimited: false, balance: null },
    allowance: { used: 100, limit: 8000, remainingPercent: 99, resetsAt: null },
    observedAt: T,
    ...over
  }
}

afterEach(() => resetCreditReadings())

describe('publishCreditReading', () => {
  it('tells every subscriber, with the instant the caller says it was read', () => {
    const heard = vi.fn()
    onCreditReading(heard)
    expect(publishCreditReading(reading())).toBe(true)
    expect(heard).toHaveBeenCalledWith(
      expect.objectContaining({ accountKey: 'chatgpt:ws-1:user-1', observedAt: T })
    )
  })

  it('publishes the same read once, however often it is handed over', () => {
    const heard = vi.fn()
    onCreditReading(heard)
    publishCreditReading(reading())
    expect(publishCreditReading(reading())).toBe(false)
    expect(publishCreditReading(reading())).toBe(false)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('publishes a new read even when nothing in it changed — its instant did', () => {
    publishCreditReading(reading())
    expect(publishCreditReading(reading({ observedAt: T + 60_000 }))).toBe(true)
  })

  it('publishes a changed reading', () => {
    publishCreditReading(reading())
    expect(
      publishCreditReading(
        reading({ allowance: { used: 101, limit: 8000, remainingPercent: 99, resetsAt: null } })
      )
    ).toBe(true)
  })

  it('publishes nothing for the shared unknown key, or for a reading with nothing to say', () => {
    const heard = vi.fn()
    onCreditReading(heard)
    expect(publishCreditReading(reading({ accountKey: 'unknown' }))).toBe(false)
    expect(publishCreditReading(reading({ credits: null, allowance: null }))).toBe(false)
    expect(heard).not.toHaveBeenCalled()
  })

  it('keeps telling the others when one subscriber throws', () => {
    const heard = vi.fn()
    onCreditReading(() => {
      throw new Error('broken subscriber')
    })
    onCreditReading(heard)
    publishCreditReading(reading())
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('stops telling a subscriber that unsubscribed', () => {
    const heard = vi.fn()
    const stop = onCreditReading(heard)
    stop()
    publishCreditReading(reading())
    expect(heard).not.toHaveBeenCalled()
  })
})
