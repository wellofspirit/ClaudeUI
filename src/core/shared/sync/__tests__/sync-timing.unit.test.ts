/**
 * @vitest-environment node
 *
 * The client half of `SyncStats`: one relayed line per sync-full, `info` unless
 * the client spent more than 2 s, numbers only.
 */

import { describe, it, expect, vi } from 'vitest'
import { relaySyncTiming, syncTimingTotalMs, SYNC_TIMING_WARN_MS } from '../sync-timing'

describe('relaySyncTiming', () => {
  it('relays one info line under the SyncStats source', () => {
    const relay = vi.fn()
    relaySyncTiming(relay, {
      transport: 'web',
      frameChars: 123456,
      decodeMs: 12.34,
      syncToFrameMs: 250,
      hydrateMs: 40
    })
    expect(relay).toHaveBeenCalledTimes(1)
    expect(relay).toHaveBeenCalledWith(
      'info',
      'SyncStats',
      'client sync-full applied: transport=web frameChars=123456 decodeMs=12.3 syncToFrameMs=250.0 hydrateMs=40.0 totalMs=302.3'
    )
  })

  it('omits what the transport cannot measure (the desktop has no frame)', () => {
    const relay = vi.fn()
    relaySyncTiming(relay, { transport: 'desktop', hydrateMs: 8 })
    expect(relay.mock.calls[0][2]).toBe(
      'client sync-full applied: transport=desktop hydrateMs=8.0 totalMs=8.0'
    )
  })

  it('escalates to warn past 2 s, and not at exactly 2 s', () => {
    const relay = vi.fn()
    relaySyncTiming(relay, { transport: 'desktop', hydrateMs: SYNC_TIMING_WARN_MS })
    expect(relay.mock.calls[0][0]).toBe('info')
    relaySyncTiming(relay, { transport: 'desktop', hydrateMs: SYNC_TIMING_WARN_MS + 1 })
    expect(relay.mock.calls[1][0]).toBe('warn')
    expect(relay.mock.calls[1][2]).toMatch(/^slow client sync-full applied: /)
  })

  it('totals wait + decode + hydrate', () => {
    expect(
      syncTimingTotalMs({ transport: 'web', syncToFrameMs: 1, decodeMs: 2, hydrateMs: 4 })
    ).toBe(7)
  })

  it('is a no-op without a relay', () => {
    expect(() => relaySyncTiming(undefined, { transport: 'web', hydrateMs: 1 })).not.toThrow()
  })
})
