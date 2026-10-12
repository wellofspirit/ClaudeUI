/**
 * Layer 1: the per-client live-preview choice in `localStorage` (ADR-101 §7) —
 * default on, an explicit off sticks, and a storage that is missing or throws
 * reads as the default.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  LIVE_PREVIEW_KEY,
  onLivePreviewChange,
  readLivePreview,
  writeLivePreview
} from '../preview-preference'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('live preview preference', () => {
  it('is ON until someone turns it off', () => {
    expect(readLivePreview()).toBe(true)
  })

  it('round-trips both values under the documented key', () => {
    expect(LIVE_PREVIEW_KEY).toBe('claudeui.voice.livePreview')
    writeLivePreview(false)
    expect(localStorage.getItem(LIVE_PREVIEW_KEY)).toBe('false')
    expect(readLivePreview()).toBe(false)
    writeLivePreview(true)
    // Written, not cleared: a choice made on purpose must outlive a change of the default.
    expect(localStorage.getItem(LIVE_PREVIEW_KEY)).toBe('true')
    expect(readLivePreview()).toBe(true)
  })

  it('reads anything but an explicit "false" as the default', () => {
    for (const raw of ['', 'off', '0', 'null', '{']) {
      localStorage.setItem(LIVE_PREVIEW_KEY, raw)
      expect(readLivePreview()).toBe(true)
    }
  })

  it('a THROWING storage reads as the default and never throws', () => {
    writeLivePreview(false)
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(readLivePreview()).toBe(true)
    expect(() => writeLivePreview(false)).not.toThrow()
  })

  it('a storage whose very ACCESS throws (blocked site data) reads as the default', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError')
      }
    })
    try {
      expect(readLivePreview()).toBe(true)
      expect(() => writeLivePreview(false)).not.toThrow()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', descriptor)
    }
  })

  it('tells listeners — even when storage refused the write', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const heard: boolean[] = []
    const off = onLivePreviewChange((on) => heard.push(on))
    writeLivePreview(false)
    off()
    writeLivePreview(true)
    expect(heard).toEqual([false])
  })

  it('hears another window’s change through the `storage` event', () => {
    const heard: boolean[] = []
    const off = onLivePreviewChange((on) => heard.push(on))
    window.dispatchEvent(new StorageEvent('storage', { key: LIVE_PREVIEW_KEY, newValue: 'false' }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'false' }))
    window.dispatchEvent(new StorageEvent('storage', { key: LIVE_PREVIEW_KEY, newValue: null }))
    off()
    expect(heard).toEqual([false, true])
  })
})
