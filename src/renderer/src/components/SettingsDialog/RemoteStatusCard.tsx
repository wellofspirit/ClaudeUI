import { useEffect, useState } from 'react'
import type { RemoteStatusView } from '../../../../shared/types'
import { SettingRow } from './settings-controls'

/** How often the view re-reads while it is on screen. */
const POLL_MS = 5_000

/** Testid namespace (ADR-027 tier 2). */
const S = 'RemoteStatusCard'

/**
 * Settings › Remote access — the WEB client's read-only view of the listener it
 * is talking to (owner ruling, 2026-08-28: "a remote web view should be able to
 * see the connected clients. though they should not be able to disable the
 * remote mode themselves, as it will kill themselves").
 *
 * ## Read-only, and structurally so
 *
 * There are no controls here, and that is not restraint on this component's
 * part: `remote:start` / `stop` / `set-config` / `set-password` /
 * `clear-password` / `force-reserve` have no registration on the remote
 * transport at all (`core/ipc/remote-view-commands.ts` states the rule where the
 * one readable channel is declared), so a button here would have nothing to
 * call. The last row says that to the operator rather than leaving them hunting
 * for a switch.
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
    <div data-testid={S} className="divide-y divide-border/55">
      <SettingRow
        testid={`${S}.stateRow`}
        label="Remote access"
        error={error ?? undefined}
        errorTestid={`${S}.loadError`}
      >
        <span
          data-testid={`${S}.state`}
          data-running={status ? String(status.running) : 'unknown'}
          className={`text-[12px] leading-4 ${status?.running ? 'text-success' : 'text-text-secondary'}`}
        >
          {status === null ? 'Loading…' : status.running ? 'Running' : 'Stopped'}
        </span>
      </SettingRow>

      {status && (
        <>
          <Row testid={`${S}.port`} label="Port">
            {status.port === null ? 'not listening' : String(status.port)}
          </Row>

          <Row testid={`${S}.clients`} label="Connected devices">
            {String(status.connectedClients)}
          </Row>

          {/* login ?? ip per row: the login is the useful handle when the server
              has one, and the ip is what it falls back to for a password client
              off the tailnet. `clientLogins` is parallel to `clientIps` by
              contract, so the index is the join. */}
          {status.clientIps.length > 0 && (
            <div data-testid={`${S}.clientList`} className="divide-y divide-border/55">
              {status.clientIps.map((ip, index) => (
                <SettingRow
                  key={`${ip}-${index}`}
                  testid={`${S}.client`}
                  dataId={ip}
                  indent
                  description={status.clientLogins[index] ?? ip}
                />
              ))}
            </div>
          )}

          <Row testid={`${S}.tunnel`} label="Tunnel">
            {status.tunnelState ?? 'off'}
          </Row>

          {/* The redacted TLS block: mode/ports/detection only — no tailnet
              hostname and no free-text serve message (see RemoteStatusView). */}
          <Row testid={`${S}.tls`} label="Tailscale HTTPS">
            {status.tls === null
              ? 'off'
              : `on · port ${status.tls.httpsPort ?? status.tls.pinnedHttpsPort}${
                  status.tls.detection ? ` · ${status.tls.detection}` : ''
                }`}
          </Row>

          <Row testid={`${S}.authMethods`} label="Sign-in methods">
            {status.authMethods.length > 0 ? status.authMethods.join(', ') : 'none advertised'}
          </Row>

          {status.lastError && (
            <SettingRow
              testid={`${S}.lastErrorRow`}
              label="Last start error"
              error={status.lastError}
              errorTestid={`${S}.lastError`}
            />
          )}
        </>
      )}

      <SettingRow
        testid={`${S}.hostOnlyNote`}
        dimmed
        description="Starting, stopping and configuring the server happen on the machine itself, so a remote client cannot switch off the connection it is using."
      />
    </div>
  )
}

/** One label/value line. A `SettingRow` whose control column is the reading. */
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
    <SettingRow testid={testid} label={label}>
      <span className="text-[12px] leading-4 text-text-secondary text-right break-all">
        {children}
      </span>
    </SettingRow>
  )
}
