import { useEffect, useState } from 'react'
import type { RemoteStatusView } from '../../../../shared/types'

/** How often the view re-reads while it is on screen. */
const POLL_MS = 5_000

/**
 * Settings › Remote — the WEB client's read-only view of the listener it is
 * talking to (owner ruling, 2026-08-28: "a remote web view should be able to see
 * the connected clients. though they should not be able to disable the remote
 * mode themselves, as it will kill themselves").
 *
 * ## Read-only, and structurally so
 *
 * There are no controls here, and that is not restraint on this component's
 * part: `remote:start` / `stop` / `set-config` / `set-password` /
 * `clear-password` / `force-reserve` have no registration on the remote
 * transport at all (`core/ipc/remote-view-commands.ts` states the rule where the
 * one readable channel is declared), so a button here would have nothing to
 * call. The sentence at the bottom says that to the operator rather than leaving
 * them hunting for a switch.
 *
 * ## Why it POLLS
 *
 * `remote:status` is host-local by classification (`shared/sync/channels.ts`) —
 * the listener pushes it to its own window, never over the WS — and this view
 * deliberately does not add an event lane for a redacted twin. Five seconds is
 * fast enough for "did my other phone drop off" and cheap enough for a `query`
 * that touches no disk. The timer is cleared on unmount, so a settings pane the
 * operator closed stops asking.
 */
export function RemoteStatusCard(): React.JSX.Element {
  const [status, setStatus] = useState<RemoteStatusView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = async (): Promise<void> => {
      try {
        const next = await window.api.getRemoteStatusView()
        if (cancelled) return
        setStatus(next)
        setError(null)
      } catch (err) {
        if (cancelled) return
        // Keep the last good reading on screen: a dropped poll says nothing
        // about the server, and blanking the rows would read as "it stopped".
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    void read()
    const timer = setInterval(() => void read(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return (
    <div data-testid="RemoteStatusCard" className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span>Remote access</span>
        <span
          data-testid="RemoteStatusCard.state"
          data-running={status ? String(status.running) : 'unknown'}
          className={`text-[10px] ${status?.running ? 'text-success' : 'text-text-muted/70'}`}
        >
          {status === null ? 'Loading…' : status.running ? 'Running' : 'Stopped'}
        </span>
      </div>

      {error && (
        <div data-testid="RemoteStatusCard.loadError" className="text-[10px] text-red-400">
          {error}
        </div>
      )}

      {status && (
        <>
          <Row testid="RemoteStatusCard.port" label="Port">
            {status.port === null ? 'not listening' : String(status.port)}
          </Row>

          <Row testid="RemoteStatusCard.clients" label="Connected devices">
            {String(status.connectedClients)}
          </Row>

          {/* login ?? ip per row: the login is the useful handle when the server
              has one, and the ip is what it falls back to for a password client
              off the tailnet. `clientLogins` is parallel to `clientIps` by
              contract, so the index is the join. */}
          {status.clientIps.length > 0 && (
            <div data-testid="RemoteStatusCard.clientList" className="space-y-1">
              {status.clientIps.map((ip, index) => (
                <div
                  key={`${ip}-${index}`}
                  data-testid="RemoteStatusCard.client"
                  className="rounded border border-border/40 px-2 py-1 text-[11px] text-text-secondary"
                >
                  {status.clientLogins[index] ?? ip}
                </div>
              ))}
            </div>
          )}

          <Row testid="RemoteStatusCard.tunnel" label="Tunnel">
            {status.tunnelState ?? 'off'}
          </Row>

          {/* The redacted TLS block: mode/ports/detection only — no tailnet
              hostname and no free-text serve message (see RemoteStatusView). */}
          <Row testid="RemoteStatusCard.tls" label="Tailscale HTTPS">
            {status.tls === null
              ? 'off'
              : `on · port ${status.tls.httpsPort ?? status.tls.pinnedHttpsPort}${
                  status.tls.detection ? ` · ${status.tls.detection}` : ''
                }`}
          </Row>

          <Row testid="RemoteStatusCard.authMethods" label="Sign-in methods">
            {status.authMethods.length > 0 ? status.authMethods.join(', ') : 'none advertised'}
          </Row>

          {status.lastError && (
            <div data-testid="RemoteStatusCard.lastError" className="text-[10px] text-red-400">
              Last start error: {status.lastError}
            </div>
          )}
        </>
      )}

      <div
        data-testid="RemoteStatusCard.hostOnlyNote"
        className="text-[10px] text-text-muted/60 leading-snug"
      >
        Starting, stopping and configuring the server happen on the machine itself — the desktop
        app, or the server’s own console on a headless install. A remote client cannot switch off
        the connection it is using.
      </div>
    </div>
  )
}

/** One label/value line, so every row reads the same and carries a testid. */
function Row({
  testid,
  label,
  children
}: {
  testid: string
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-testid={testid} className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="text-text-muted/70">{label}</span>
      <span className="text-text-secondary text-right break-all">{children}</span>
    </div>
  )
}
