/**
 * Unit tests for BashStreamGate — the dedup + trailing-edge throttle gate that
 * sits between opencode's per-chunk bash metadata.output snapshots and the
 * `session:bash-output` IPC emission (Slice A: opencode bash live streaming).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BashStreamGate } from '../bash-stream-gate'

describe('BashStreamGate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('emits nothing until the throttle window elapses', () => {
    const emit = vi.fn()
    const gate = new BashStreamGate(emit)
    gate.update('t1', 'hello')
    expect(emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(99)
    expect(emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledExactlyOnceWith('t1', 'hello')
  })

  it('rapid successive updates within the window collapse to ONE emission of the latest value', () => {
    const emit = vi.fn()
    const gate = new BashStreamGate(emit)
    gate.update('t1', 'a')
    vi.advanceTimersByTime(30)
    gate.update('t1', 'ab')
    vi.advanceTimersByTime(30)
    gate.update('t1', 'abc')
    // Only 60ms elapsed since the FIRST update scheduled the timer — window not yet expired.
    vi.advanceTimersByTime(40)
    expect(emit).toHaveBeenCalledExactlyOnceWith('t1', 'abc')
  })

  it('a value identical to the last-sent one is deduped (no timer, no emission)', () => {
    const emit = vi.fn()
    const gate = new BashStreamGate(emit)
    gate.update('t1', 'same')
    vi.advanceTimersByTime(100)
    expect(emit).toHaveBeenCalledTimes(1)
    emit.mockClear()

    gate.update('t1', 'same') // unchanged vs lastSent
    vi.advanceTimersByTime(100)
    expect(emit).not.toHaveBeenCalled()
  })

  it('a value identical to the currently-pending one does not reschedule or duplicate', () => {
    const emit = vi.fn()
    const gate = new BashStreamGate(emit)
    gate.update('t1', 'x')
    gate.update('t1', 'x') // same as pending — no-op, still one pending flush
    vi.advanceTimersByTime(100)
    expect(emit).toHaveBeenCalledExactlyOnceWith('t1', 'x')
  })

  it('after a flush, a new update starts a fresh throttle window', () => {
    const emit = vi.fn()
    const gate = new BashStreamGate(emit)
    gate.update('t1', 'first')
    vi.advanceTimersByTime(100)
    expect(emit).toHaveBeenCalledExactlyOnceWith('t1', 'first')

    gate.update('t1', 'second')
    expect(emit).toHaveBeenCalledTimes(1) // not yet — new window just started
    vi.advanceTimersByTime(100)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenNthCalledWith(2, 't1', 'second')
  })

  it('tracks multiple keys independently', () => {
    const emit = vi.fn()
    const gate = new BashStreamGate(emit)
    gate.update('t1', 'one')
    vi.advanceTimersByTime(50)
    gate.update('t2', 'two')
    vi.advanceTimersByTime(50)
    // t1's window (started at t=0) has now elapsed (100ms); t2's (started at t=50) has not.
    expect(emit).toHaveBeenCalledExactlyOnceWith('t1', 'one')
    vi.advanceTimersByTime(50)
    expect(emit).toHaveBeenCalledWith('t2', 'two')
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('cancel(key) drops the pending timer/value — no emission, and clears last-sent so the same value can flow again', () => {
    const emit = vi.fn()
    const gate = new BashStreamGate(emit)
    gate.update('t1', 'pending-value')
    gate.cancel('t1')
    vi.advanceTimersByTime(1000)
    expect(emit).not.toHaveBeenCalled()

    // last-sent was cleared too — the same value now flows as "new" rather than deduping.
    gate.update('t1', 'pending-value')
    vi.advanceTimersByTime(100)
    expect(emit).toHaveBeenCalledExactlyOnceWith('t1', 'pending-value')
  })

  it('cancel(key) on an unrelated/unknown key is a safe no-op', () => {
    const emit = vi.fn()
    const gate = new BashStreamGate(emit)
    expect(() => gate.cancel('unknown')).not.toThrow()
  })

  it('cancelAll() drops every pending timer — nothing fires afterward', () => {
    const emit = vi.fn()
    const gate = new BashStreamGate(emit)
    gate.update('t1', 'a')
    gate.update('t2', 'b')
    gate.cancelAll()
    vi.advanceTimersByTime(1000)
    expect(emit).not.toHaveBeenCalled()
  })

  it('respects a custom intervalMs', () => {
    const emit = vi.fn()
    const gate = new BashStreamGate(emit, { intervalMs: 500 })
    gate.update('t1', 'v')
    vi.advanceTimersByTime(499)
    expect(emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledExactlyOnceWith('t1', 'v')
  })
})
