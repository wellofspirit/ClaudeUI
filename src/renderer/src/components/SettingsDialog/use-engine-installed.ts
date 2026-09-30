/**
 * use-engine-installed.ts
 *
 * The "is this engine's binary present?" gate every engine-scoped settings
 * section opens with. It lives in its own module rather than in
 * settings-sections.tsx because the curated opencode panes
 * (OpencodeConfigPanes.tsx) need the same gate and settings-sections.tsx
 * IMPORTS those panes — sharing it the other way round would close an import
 * cycle.
 *
 * `null` means "not resolved yet" (render a Loading… row, never the
 * not-installed copy), so a slow IPC round-trip can't flash "not installed" at
 * a user who has it.
 *
 * LIVE since ADR-082: a harness can be installed, removed or re-sourced while
 * the app runs, so the answer is re-read on every `harness:changed` for this
 * engine (a replicated sync event, so the desktop and a phone both hear it).
 * A re-read keeps the previous answer on screen until the new one lands, and
 * only the newest read may set it, so a slow earlier answer cannot overwrite
 * a later one.
 */

import { useEffect, useState } from 'react'
import { onSyncEvent } from '../../../../core/shared/sync/client-registry'
import type { EngineId } from '../../../../shared/types'

export function useEngineInstalled(engineId: EngineId): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    let latest = 0
    const read = (): void => {
      const seq = ++latest
      window.api
        .engineIsInstalled(engineId)
        .then((v) => {
          if (!cancelled && seq === latest) setInstalled(v)
        })
        .catch(() => {
          if (!cancelled && seq === latest) setInstalled(false)
        })
    }
    read()
    const off = onSyncEvent('harness:changed', (data) => {
      if (data?.id === engineId) read()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [engineId])
  return installed
}

export function useOpencodeInstalled(): boolean | null {
  return useEngineInstalled('opencode')
}

export function usePiInstalled(): boolean | null {
  return useEngineInstalled('pi')
}
