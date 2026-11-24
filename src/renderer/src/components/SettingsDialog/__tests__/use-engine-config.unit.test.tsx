/**
 * Layer 1: `patchEngineConfigFile` — the write path the replace dialog uses on
 * `engines/<id>.json`. It must never write from a copy it did not just read, and
 * must not report success for a save that did not happen.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act, cleanup } from '@testing-library/react'
import { patchEngineConfigFile, useEngineConfigObject } from '../use-engine-config'
import type { EngineConfig } from '../../../../../shared/types'

afterEach(cleanup)

function setApi(file: { current: EngineConfig }, save: (cfg: EngineConfig) => Promise<void>): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    loadEngineConfig: async () => structuredClone(file.current),
    saveEngineConfig: async (_id: string, cfg: EngineConfig) => save(cfg)
  }
}

describe('patchEngineConfigFile', () => {
  it('mutates a FRESH read, not the live entry, then adopts the saved object and notifies', async () => {
    const file = { current: { dispatch: { maxCostUsd: 1 } } as EngineConfig }
    const saved: EngineConfig[] = []
    setApi(file, async (cfg) => {
      saved.push(cfg)
      file.current = cfg
    })
    const { result } = renderHook(() => useEngineConfigObject('pi'))
    await waitFor(() => expect(result.current.engineCfg).toEqual({ dispatch: { maxCostUsd: 1 } }))

    // Written elsewhere since the live entry read the file.
    file.current = { dispatch: { maxCostUsd: 1 }, piConfig: { defaultModel: 'a/b' } }
    await act(async () => {
      await patchEngineConfigFile('pi', (fresh) => ({
        ...fresh,
        autoMode: { judgeModel: 'x/y' }
      }))
    })

    expect(saved).toEqual([
      {
        dispatch: { maxCostUsd: 1 },
        piConfig: { defaultModel: 'a/b' },
        autoMode: { judgeModel: 'x/y' }
      }
    ])
    expect(result.current.engineCfg).toEqual(saved[0])
  })

  it('works with no live entry at all', async () => {
    const file = { current: { piConfig: { defaultModel: 'a/b' } } as EngineConfig }
    const save = vi.fn(async (cfg: EngineConfig) => {
      file.current = cfg
    })
    setApi(file, save)
    await patchEngineConfigFile('claude', (fresh) => ({ ...fresh, dispatch: { maxCostUsd: 2 } }))
    expect(save).toHaveBeenCalledWith({
      piConfig: { defaultModel: 'a/b' },
      dispatch: { maxCostUsd: 2 }
    })
  })

  it('a live entry whose first read is still in flight ends up holding the SAVED file', async () => {
    const file = { current: { dispatch: { maxCostUsd: 1 } } as EngineConfig }
    let releaseFirst: () => void = () => {}
    let reads = 0
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      loadEngineConfig: async () => {
        const snapshot = structuredClone(file.current)
        // The pane's first read is held until after the dialog's save.
        if (reads++ === 0) await new Promise<void>((r) => (releaseFirst = r))
        return snapshot
      },
      saveEngineConfig: async (_id: string, cfg: EngineConfig) => {
        file.current = cfg
      }
    }
    const { result } = renderHook(() => useEngineConfigObject('pi'))
    expect(result.current.engineCfg).toBeNull()
    await act(async () => {
      await patchEngineConfigFile('pi', (fresh) => ({ ...fresh, autoMode: { judgeModel: 'x/y' } }))
    })
    // The late first read lands with the PRE-patch file; the re-read must win.
    await act(async () => {
      releaseFirst()
    })
    await waitFor(() =>
      expect(result.current.engineCfg).toEqual({
        dispatch: { maxCostUsd: 1 },
        autoMode: { judgeModel: 'x/y' }
      })
    )
  })

  it('a failed save rejects and leaves the live entry as it was', async () => {
    const file = { current: { dispatch: { maxCostUsd: 1 } } as EngineConfig }
    setApi(file, async () => {
      throw new Error('disk full')
    })
    const { result } = renderHook(() => useEngineConfigObject('opencode'))
    await waitFor(() => expect(result.current.engineCfg).not.toBeNull())
    await expect(
      patchEngineConfigFile('opencode', (fresh) => ({ ...fresh, dispatch: { maxCostUsd: 5 } }))
    ).rejects.toThrow('disk full')
    expect(result.current.engineCfg).toEqual({ dispatch: { maxCostUsd: 1 } })
  })
})
