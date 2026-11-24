import { useEffect, useState } from 'react'
import { useConnectionHoldsAdmin } from '../SettingsDialog/connection-admin'

/**
 * Offer "Relaunch ClaudeUI" only where it can run: the host says it is
 * available (`app:relaunch-availability`) and this client holds `admin`.
 * Read once per mount (the menu that shows it is short-lived).
 */
export function useRelaunchOffered(): boolean {
  const holdsAdmin = useConnectionHoldsAdmin()
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    // Through a promise, so a client without the member (an older harness) reads "no".
    Promise.resolve()
      .then(() => window.api.relaunchAvailability())
      .then((a) => {
        if (!cancelled) setAvailable(a.available)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return available && holdsAdmin
}
