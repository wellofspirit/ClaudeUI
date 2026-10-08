/**
 * useSettledFlag: true only after the flag has held for the delay, false at
 * once when it drops, and a blip shorter than the delay never shows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSettledFlag } from '../useSettledFlag'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const DELAY = 150

describe('useSettledFlag', () => {
  it('is false initially, even when the flag starts true', () => {
    const off = renderHook(() => useSettledFlag(false, DELAY))
    expect(off.result.current).toBe(false)
    const on = renderHook(() => useSettledFlag(true, DELAY))
    expect(on.result.current).toBe(false)
  })

  it('becomes true only after the flag has held for the delay', () => {
    const { result } = renderHook(() => useSettledFlag(true, DELAY))
    act(() => {
      vi.advanceTimersByTime(DELAY - 1)
    })
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(true)
  })

  it('is false in the same render the flag drops', () => {
    const { result, rerender } = renderHook(({ flag }) => useSettledFlag(flag, DELAY), {
      initialProps: { flag: true }
    })
    act(() => {
      vi.advanceTimersByTime(DELAY)
    })
    expect(result.current).toBe(true)

    rerender({ flag: false })
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(false)
  })

  it('never shows a true -> false -> true blip shorter than the delay', () => {
    const { result, rerender } = renderHook(({ flag }) => useSettledFlag(flag, DELAY), {
      initialProps: { flag: true }
    })
    act(() => {
      vi.advanceTimersByTime(DELAY - 10)
    })
    rerender({ flag: false })
    act(() => {
      vi.advanceTimersByTime(20)
    })
    rerender({ flag: true })
    // 130 ms + 20 ms have passed since the first true, but the clock restarted.
    act(() => {
      vi.advanceTimersByTime(DELAY - 1)
    })
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(true)
  })

  it('clears its timer on unmount (no state update after unmount)', () => {
    const { unmount } = renderHook(() => useSettledFlag(true, DELAY))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer pending once the flag drops', () => {
    const { rerender } = renderHook(({ flag }) => useSettledFlag(flag, DELAY), {
      initialProps: { flag: true }
    })
    rerender({ flag: false })
    expect(vi.getTimerCount()).toBe(0)
  })
})
