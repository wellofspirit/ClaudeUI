/**
 * use-engine-installed.ts
 *
 * "Is this engine's binary present?" as one live boolean. Settings no longer
 * asks it for a harness's page or parts: those follow the harness store's
 * readiness (`useEngineRuns`, ADR-082 §8). What still does is the permissions
 * summary, whose Codex chip claims a rules file only a present Codex is
 * compiled for.
 *
 * `null` means "not resolved yet" (a caller treats it as absent until it
 * answers, never as a verdict), so a slow IPC round-trip can't flash
 * "installed" or "not installed" at a user.
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
