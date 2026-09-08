/**
 * Layer 1: the mobile breakpoint.
 *
 * The load-bearing invariant is that ONE number decides "is this a phone", and
 * that it agrees with Tailwind. Every mobile fork in the app is chosen by
 * `useIsMobile` while the layout inside it is written with Tailwind's `max-md:`
 * variant — and Tailwind's `md` breakpoint is `min-width: 768px`, so `max-md:`
 * has already stopped applying AT 768px. `useIsMobile` used `<= 768`, so a
 * viewport exactly 768px wide got the phone FORK with the desktop LAYOUT:
 * SettingsMobileView's accordions drawn with the desktop's fixed 240px control
 * column (ADR-065 phase 7).
 *
 * 768 is written out here rather than imported: a test that takes the number
 * from the module under test cannot notice the module changing it.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIsMobile } from '../useIsMobile'

const originalWidth = window.innerWidth

function setWidth(px: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: px })
}

afterEach(() => setWidth(originalWidth))

describe('useIsMobile', () => {
  it('is DESKTOP exactly at 768 — where Tailwind `max-md:` has already stopped', () => {
    setWidth(768)
    expect(renderHook(() => useIsMobile()).result.current).toBe(false)
  })

  it('is mobile at 767', () => {
    setWidth(767)
    expect(renderHook(() => useIsMobile()).result.current).toBe(true)
  })

  it('is desktop above it', () => {
    setWidth(1024)
    expect(renderHook(() => useIsMobile()).result.current).toBe(false)
  })

  it('subscribes with a media query that excludes 768 itself', () => {
    const queries: string[] = []
    const original = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => {
        queries.push(query)
        return original(query)
      }
    })
    try {
      renderHook(() => useIsMobile())
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: original
      })
    }
    // `(max-width: 768px)` MATCHES at 768 and so would disagree with the
    // initial read above — the two halves of this hook have to answer the same
    // question. 767.98 is the width Tailwind's own `max-md:` resolves to.
    expect(queries).toEqual(['(max-width: 767.98px)'])
  })
})
