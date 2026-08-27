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
 */

import { useEffect, useState } from 'react'
import type { EngineId } from '../../../../shared/types'

export function useEngineInstalled(engineId: EngineId): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api
      .engineIsInstalled(engineId)
      .then((v) => {
        if (!cancelled) setInstalled(v)
      })
      .catch(() => {
        if (!cancelled) setInstalled(false)
      })
    return () => {
      cancelled = true
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
