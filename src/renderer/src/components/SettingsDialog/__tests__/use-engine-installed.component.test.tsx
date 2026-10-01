/**
 * `useEngineInstalled` follows the harness live (ADR-082 arc 2, S4): a harness
 * can be installed, removed or re-sourced while the app runs, so the engine
 * gate re-reads `engine:is-installed` on every `harness:changed` for its
 * engine — and only for its engine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { EngineId } from '../../../../../shared/types'

// The hook's one push subscription, captured so a test can fire it. The real
// registry DEFERS a listener while no transport client exists, which would
// swallow the emit in jsdom.
const syncHandlers = vi.hoisted(() => new Map<string, Set<(...args: unknown[]) => void>>())
vi.mock('../../../../../core/shared/sync/client-registry', () => ({
  onSyncEvent: (channel: string, cb: (...args: unknown[]) => void) => {
    const set = syncHandlers.get(channel) ?? new Set()
    set.add(cb)
    syncHandlers.set(channel, set)
    return () => set.delete(cb)
  }
}))

import { useEngineInstalled } from '../use-engine-installed'

function fire(channel: string, ...args: unknown[]): void {
  act(() => {
    for (const cb of syncHandlers.get(channel) ?? []) cb(...args)
  })
}

const engineIsInstalled = vi.fn<(id: EngineId) => Promise<boolean>>()

beforeEach(() => {
  syncHandlers.clear()
  engineIsInstalled.mockReset()
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = { engineIsInstalled }
})

afterEach(() => {
  cleanup()
})

describe('useEngineInstalled', () => {
  it('reads once on mount: null until the answer lands', async () => {
    engineIsInstalled.mockResolvedValue(true)
    const { result } = renderHook(() => useEngineInstalled('opencode'))
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBe(true))
    expect(engineIsInstalled).toHaveBeenCalledTimes(1)
    expect(engineIsInstalled).toHaveBeenCalledWith('opencode')
  })

  it('re-reads on harness:changed for its engine, and ignores the others', async () => {
    engineIsInstalled.mockResolvedValue(false)
    const { result } = renderHook(() => useEngineInstalled('pi'))
    await waitFor(() => expect(result.current).toBe(false))

    fire('harness:changed', { id: 'opencode' })
    expect(engineIsInstalled).toHaveBeenCalledTimes(1)

    engineIsInstalled.mockResolvedValue(true)
    fire('harness:changed', { id: 'pi' })
    await waitFor(() => expect(result.current).toBe(true))
    expect(engineIsInstalled).toHaveBeenCalledTimes(2)
  })

  it('keeps the newest answer when an older read lands after it', async () => {
    let resolveFirst!: (v: boolean) => void
    engineIsInstalled.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFirst = resolve
        })
    )
    engineIsInstalled.mockResolvedValueOnce(true)
    const { result } = renderHook(() => useEngineInstalled('codex'))
    fire('harness:changed', { id: 'codex' })
    await waitFor(() => expect(result.current).toBe(true))

    await act(async () => {
      resolveFirst(false)
    })
    expect(result.current).toBe(true)
  })

  it('stops listening when unmounted', async () => {
    engineIsInstalled.mockResolvedValue(true)
    const { unmount } = renderHook(() => useEngineInstalled('claude'))
    await waitFor(() => expect(engineIsInstalled).toHaveBeenCalledTimes(1))
    unmount()
    expect(syncHandlers.get('harness:changed')?.size ?? 0).toBe(0)
  })
})
