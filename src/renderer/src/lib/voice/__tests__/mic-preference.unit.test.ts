/**
 * Layer 1: the per-client microphone preference in `localStorage` — including a
 * storage that is missing or throws (private windows, blocked site data).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  MIC_PREFERENCE_KEY,
  onMicPreferenceChange,
  readMicPreference,
  writeMicPreference
} from '../mic-preference'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('mic preference', () => {
  it('is null (the system default) until something is chosen', () => {
    expect(readMicPreference()).toBeNull()
  })

  it('round-trips a choice, and null clears it', () => {
    writeMicPreference({ deviceId: 'pods', label: 'AirPods Pro' })
    expect(readMicPreference()).toEqual({ deviceId: 'pods', label: 'AirPods Pro' })
    expect(JSON.parse(localStorage.getItem(MIC_PREFERENCE_KEY)!)).toEqual({
      deviceId: 'pods',
      label: 'AirPods Pro'
    })
    writeMicPreference(null)
    expect(readMicPreference()).toBeNull()
    expect(localStorage.getItem(MIC_PREFERENCE_KEY)).toBeNull()
  })

  it('reads garbage as no preference', () => {
    for (const raw of ['{', '42', 'null', '{"deviceId":7}', '[]']) {
      localStorage.setItem(MIC_PREFERENCE_KEY, raw)
      expect(readMicPreference()).toBeNull()
    }
  })

  it('a THROWING storage reads as no preference and never throws', () => {
    writeMicPreference({ deviceId: 'pods', label: 'AirPods Pro' })
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const removeItem = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(readMicPreference()).toBeNull()
    expect(getItem).toHaveBeenCalled()
    expect(() => writeMicPreference({ deviceId: 'mac', label: 'Mac' })).not.toThrow()
    expect(() => writeMicPreference(null)).not.toThrow()
    expect(setItem).toHaveBeenCalled()
    expect(removeItem).toHaveBeenCalled()
  })

  it('a storage whose very ACCESS throws (blocked site data) reads as no preference', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError')
      }
    })
    try {
      expect(readMicPreference()).toBeNull()
      expect(() => writeMicPreference({ deviceId: 'pods', label: 'AirPods Pro' })).not.toThrow()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', descriptor)
    }
  })

  it('tells listeners — even when storage refused the write', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const heard: unknown[] = []
    const off = onMicPreferenceChange((p) => heard.push(p))
    writeMicPreference({ deviceId: 'pods', label: 'AirPods Pro' })
    off()
    writeMicPreference(null)
    expect(heard).toEqual([{ deviceId: 'pods', label: 'AirPods Pro' }])
  })

  it('hears another window’s change through the `storage` event', () => {
    const heard: unknown[] = []
    const off = onMicPreferenceChange((p) => heard.push(p))
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: MIC_PREFERENCE_KEY,
        newValue: JSON.stringify({ deviceId: 'mac', label: 'MacBook Pro Microphone' })
      })
    )
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'x' }))
    off()
    expect(heard).toEqual([{ deviceId: 'mac', label: 'MacBook Pro Microphone' }])
  })
})
