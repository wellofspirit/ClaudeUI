import { useCallback, useEffect, useState } from 'react'
import type { RemoteStatus } from '../../../shared/types'
import { NoticeCard } from './shared/NoticeCard'

/**
 * App-level banner for a `tailscale serve` failure while TLS mode is requested
 * (ADR-042).
 *
 * Why app-level rather than inside the Remote-access modal: the failure is
 * usually invisible: autostart brings the server up loopback-only and retries in
 * the background, so the user's bookmark is simply dead until they happen to
 * open the modal. The pinned HTTPS port is a promise about a URL, so breaking it
 * has to be loud.
 *
 * **Force re-serve** calls the desktop-only `remote:force-reserve` IPC, which
 * re-runs serve enablement with `force: true` — it OVERWRITES whatever serve
 * handler currently holds the pinned port. That is destructive to the occupant
 * by design (the user's "my bookmark wins" button), so the copy says so, and
 * only for the `port-occupied` reason where an occupant is what went wrong.
 *
 * Desktop-only: the web client has no serve config to fix, and the channel is in
 * `RemoteDispatcher.BLOCKED` anyway.
 */
export function RemoteServeBanner(): React.JSX.Element | null {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  /** Dismissal is keyed by the error itself, so a NEW failure re-shows. */
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (window.api.platform === 'web') return
    let alive = true
    // A rejected/absent handler must never take the app down with it — this is a
    // passive observer.
    void window.api
      .getRemoteStatus()
      .then((s) => {
        if (alive && s) setStatus(s)
      })
      .catch(() => {})
    const off = window.api.onRemoteStatus((s) => setStatus(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  const serveError = status?.running ? (status.tls?.serveError ?? null) : null
  const key = serveError ? `${serveError.reason}:${serveError.message}` : null

  const onForce = useCallback(async (): Promise<void> => {
    setPending(true)
    setActionError(null)
    try {
      await window.api.forceReserve()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }, [])

  if (window.api.platform === 'web') return null
  if (!serveError || key === null || dismissedKey === key) return null

  const port = status?.tls?.pinnedHttpsPort
  const title = `Remote access: Tailscale serve failed${port ? ` on port ${port}` : ''}`

  return (
    <div
      data-testid="RemoteServeBanner"
      className="fixed top-2 left-0 right-0 z-50 pointer-events-none px-4"
    >
      <div className="pointer-events-auto max-w-[740px] mx-auto">
        <NoticeCard
          // Title only: the message is always visible in `body`, so folding a
          // copy of it behind the expand chevron would just duplicate it.
          text={title}
          variant="error"
          onDismiss={() => setDismissedKey(key)}
          dismissTestId="RemoteServeBanner.dismiss"
          body={
            <div
              data-testid="RemoteServeBanner.message"
              className="text-[11px] text-text-secondary leading-snug"
            >
              {serveError.message}
            </div>
          }
          actions={
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <button
                  data-testid="RemoteServeBanner.forceReserve"
                  disabled={pending}
                  onClick={() => void onForce()}
                  className="rounded bg-danger/15 px-2 py-1 text-[11px] text-danger hover:bg-danger/25 disabled:opacity-40"
                >
                  {pending ? 'Re-serving…' : 'Force re-serve'}
                </button>
              </div>
              {serveError.reason === 'port-occupied' && (
                <div
                  data-testid="RemoteServeBanner.forceHint"
                  className="text-[10px] text-text-muted/70 leading-snug"
                >
                  Force re-serve takes over port {port} for this app, replacing the serve handler
                  that currently holds it.
                </div>
              )}
              {actionError && (
                <div
                  data-testid="RemoteServeBanner.actionError"
                  className="text-[10px] text-red-400 leading-snug"
                >
                  {actionError}
                </div>
              )}
            </div>
          }
        />
      </div>
    </div>
  )
}
