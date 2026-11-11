/**
 * Layer 1: Unit tests for useMockupReload — the postMessage reload + ack +
 * remount-fallback state machine shared by the mockup card and panel.
 */

import type { RefObject } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMockupReload } from '../useMockupReload'
import { mockupReloadTarget } from '../../components/mockup-transport'

const ID = 'abc12345'
const ORIGIN = `mockup-asset://${ID}.m`

let postMessage: ReturnType<typeof vi.fn>
let contentWindow: Window
let iframeRef: RefObject<HTMLIFrameElement | null>

function ack(source: unknown = contentWindow, origin = ORIGIN): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'mockup:reloading' },
        origin,
        source: source as Window
      })
    )
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  postMessage = vi.fn()
  contentWindow = { postMessage } as unknown as Window
  iframeRef = { current: { contentWindow } as unknown as HTMLIFrameElement }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useMockupReload', () => {
  it('posts mockup:reload to the iframe with the mockup target and bumps version', () => {
    const { result } = renderHook(() => useMockupReload(iframeRef, ID, ORIGIN))
    expect(result.current.version).toBe(1)
    act(() => result.current.reload())
    expect(postMessage).toHaveBeenCalledWith({ type: 'mockup:reload' }, mockupReloadTarget(ID))
    expect(result.current.status).toBe('reloading')
    expect(result.current.version).toBe(2)
  })

  it('ack then load: reloading -> updated -> idle, no remount', () => {
    const { result } = renderHook(() => useMockupReload(iframeRef, ID, ORIGIN))
    act(() => result.current.onFrameLoad()) // initial load: ignored
    expect(result.current.status).toBe('idle')

    act(() => result.current.reload())
    ack()
    act(() => vi.advanceTimersByTime(5000)) // ack cancelled the fallback timer
    expect(result.current.frameKey).toBe(0)
    expect(result.current.status).toBe('reloading')

    act(() => result.current.onFrameLoad())
    expect(result.current.status).toBe('updated')
    act(() => vi.advanceTimersByTime(1500))
    expect(result.current.status).toBe('idle')
    expect(result.current.frameKey).toBe(0)
  })

  it('bumps frameKey when no ack arrives within 1500 ms', () => {
    const { result } = renderHook(() => useMockupReload(iframeRef, ID, ORIGIN))
    act(() => result.current.reload())
    act(() => vi.advanceTimersByTime(1499))
    expect(result.current.frameKey).toBe(0)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.frameKey).toBe(1)
    // the remounted iframe's load completes the cycle
    act(() => result.current.onFrameLoad())
    expect(result.current.status).toBe('updated')
  })

  it('falls back immediately when the iframe has no contentWindow', () => {
    iframeRef = { current: { contentWindow: null } as unknown as HTMLIFrameElement }
    const { result } = renderHook(() => useMockupReload(iframeRef, ID, ORIGIN))
    act(() => result.current.reload())
    expect(result.current.frameKey).toBe(1)
  })

  // The view shows its error pane instead of the iframe: nothing can fire onLoad,
  // so a spinner would never stop.
  it('stays idle when no iframe is mounted', () => {
    iframeRef = { current: null }
    const { result } = renderHook(() => useMockupReload(iframeRef, ID, ORIGIN))
    act(() => result.current.reload())
    expect(result.current.status).toBe('idle')
    expect(result.current.frameKey).toBe(0)
  })

  it('ignores an ack from another source or origin', () => {
    const { result } = renderHook(() => useMockupReload(iframeRef, ID, ORIGIN))
    act(() => result.current.reload())
    ack({} as Window)
    ack(contentWindow, 'mockup-asset://other.m')
    act(() => vi.advanceTimersByTime(1500))
    expect(result.current.frameKey).toBe(1)
  })

  it('repeated reload restarts without stacking timers', () => {
    const { result } = renderHook(() => useMockupReload(iframeRef, ID, ORIGIN))
    act(() => result.current.reload())
    act(() => vi.advanceTimersByTime(1000))
    act(() => result.current.reload())
    act(() => vi.advanceTimersByTime(1000)) // first timer would have fired here
    expect(result.current.frameKey).toBe(0)
    act(() => vi.advanceTimersByTime(500))
    expect(result.current.frameKey).toBe(1)
  })

  it('unmount clears pending timers', () => {
    const { result, unmount } = renderHook(() => useMockupReload(iframeRef, ID, ORIGIN))
    act(() => result.current.reload())
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
