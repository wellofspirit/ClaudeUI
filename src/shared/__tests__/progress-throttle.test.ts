/**
 * @vitest-environment node
 *
 * ADR-102 — the throttle every transport puts between a handler's progress
 * reports and the wire: first report immediate, at most one per interval with
 * the LATEST value kept, completion immediate, and an explicit flush/close
 * lifecycle so no frame can trail the response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgressThrottle } from '../progress-throttle'
import type { InvokeProgress } from '../remote-protocol'

const at = (done: number, total: number | null = 100): InvokeProgress => ({
  done,
  total,
  phase: 'transcript'
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createProgressThrottle', () => {
  it('delivers the first report immediately', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send, 250)
    t.report(at(0))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith(at(0))
  })

  it('sends at most one report per interval and flushes the LATEST when it elapses', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send, 250)
    t.report(at(0))
    for (let i = 1; i <= 20; i++) {
      vi.advanceTimersByTime(5)
      t.report(at(i))
    }
    expect(send).toHaveBeenCalledTimes(1) // 100 ms in: still just the first
    vi.advanceTimersByTime(149)
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1) // 250 ms after the first
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(at(20))
    // Nothing further was pending.
    vi.advanceTimersByTime(1000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('delivers directly when the interval has already passed', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send, 250)
    t.report(at(1))
    vi.advanceTimersByTime(300)
    t.report(at(2))
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(at(2))
  })

  it('delivers a completing report (done >= total) immediately, even inside the interval', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send, 250)
    t.report(at(10))
    t.report(at(100, 100))
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(at(100, 100))
    // ...and the stale coalesced value is not re-sent afterwards.
    vi.advanceTimersByTime(1000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not treat an unknown total as complete', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send, 250)
    t.report(at(10, null))
    t.report(at(99999, null))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('flush() delivers the pending report now; with nothing pending it is a no-op', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send, 250)
    t.flush()
    expect(send).not.toHaveBeenCalled()
    t.report(at(1))
    t.report(at(2))
    t.flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(at(2))
    t.flush()
    expect(send).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000) // the timer was cleared by the flush
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('close() drops the pending report, clears the timer and ignores later calls', () => {
    const send = vi.fn()
    const t = createProgressThrottle(send, 250)
    t.report(at(1))
    t.report(at(2))
    t.close()
    vi.advanceTimersByTime(1000)
    t.report(at(3))
    t.flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('last() returns the latest reported value, delivered or not', () => {
    const t = createProgressThrottle(vi.fn(), 250)
    expect(t.last()).toBeNull()
    t.report(at(1))
    t.report(at(2))
    expect(t.last()).toEqual(at(2))
  })

  it('swallows a throwing sender so a dead socket never fails the load', () => {
    const t = createProgressThrottle(() => {
      throw new Error('socket closed')
    }, 250)
    expect(() => t.report(at(1))).not.toThrow()
  })
})
