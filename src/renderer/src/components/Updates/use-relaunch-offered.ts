import { useEffect, useState } from 'react'
import type { RebuiltInPlace } from '../../../../shared/relaunch'
import { useConnectionHoldsAdmin } from '../SettingsDialog/connection-admin'

/**
 * Offer "Relaunch ClaudeUI" only where it can run: the host says it is
 * available (`app:relaunch-availability`) and this client holds `admin`.
 * Read once per mount (the menu that shows it is short-lived). Null when not
 * offered; otherwise the build made in place a relaunch would start, if any.
 */
export function useRelaunchOffered(): { newBuild?: RebuiltInPlace } | null {
  const holdsAdmin = useConnectionHoldsAdmin()
  const [offer, setOffer] = useState<{ newBuild?: RebuiltInPlace } | null>(null)
  useEffect(() => {
    let cancelled = false
    // Through a promise, so a client without the member (an older harness) reads "no".
    Promise.resolve()
      .then(() => window.api.relaunchAvailability())
      .then((a) => {
        if (!cancelled) setOffer(a.available ? (a.newBuild ? { newBuild: a.newBuild } : {}) : null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return holdsAdmin ? offer : null
}
