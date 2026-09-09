import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteStatusView } from '../../../../shared/types'

/**
 * The WEB client's remote-access overlay — the compact twin of
 * {@link RemoteAccessModalView}, behind the sidebar footer's wifi indicator
 * (owner UX ruling, 2026-08-29: the icon should raise an overlay like the
 * desktop's, not jump to settings).
 *
 * ## What is structurally absent, and why
 *
 * This is a *view*, and the two things the desktop modal adds to a view are
 * exactly the two a remote client must not have:
 *
 *  - **No Stop/Start.** Not restraint on this component's part: every
 *    remote-server mutation (`remote:start` / `stop` / `set-config` / …) is raw
 *    `ipcMain.handle` on the host anchor with no registration on the remote
 *    transport (`core/ipc/remote-view-commands.ts`), so a button here would have
 *    nothing to call. It would also be a self-kill — the client rides the
 *    listener it would be stopping.
 *  - **No access links, no Copy, no QR.** A LAN or tunnel link carries the
 *    channel key in its fragment (ADR-056 item C), and handing one to a
 *    connected device is handing it the power to admit further devices. The
 *    web-sanctioned path is `SettingsDialog/WebAccessLinks`, which sits behind
 *    the settings-session step-up; this overlay replaces the ACCESS LINKS block
 *    with a locked row that says so and offers the way there.
 *
 * The block is not rendered-then-disabled: `AccessLinks` is never imported here,
 * so the links (and `qrcode`) are absent from this file's chunk entirely.
 *
 * ## One data source
 *
 * `window.api.getRemoteStatusView()` and nothing else. `remote:status` — the
 * object the desktop modal reads — is host-local by classification
 * (`shared/sync/channels.ts`) and never crosses the WS; the redacted view is the
 * one readable channel, so it is also the only thing that can end up on screen
 * here. It has no event twin, hence the poll (same 5s cadence and same
 * last-good-reading failure rule as `SettingsDialog/RemoteStatusCard`, which
 * shows the same reading inside settings).
 *
 * ## Why the shell is duplicated rather than shared
 *
 * The overlay/card/header markup below is a deliberate copy of the desktop
 * `View`'s. Factoring it out would mean editing the desktop modal to serve a
 * surface it must never converge with — and the whole point of this file is that
 * the privileged blocks cannot appear here by accident, which is a property of
 * *separate* trees, not of a shared shell with a `web` prop threaded through it.
 */

/** How often the overlay re-reads while it is open. Mirrors `RemoteStatusCard`. */
const POLL_MS = 5_000

export interface WebRemoteStatusModalProps {
  onClose: () => void
  /**
   * Escalate to Settings › Remote, where `WebAccessLinks` lives behind the
   * settings-session step-up. The host panel owns the navigation because the
   * destination differs by viewport (a mobile drawer hands the dialog to
   * SessionView), so this overlay only asks.
   */
  onOpenSettings: () => void
}

/**
 * Default-exported so `SettingsPanel` can `React.lazy` this FILE directly —
 * importing it through `RemoteAccessModal/index.ts` would pull the desktop modal
 * (and `AccessLinks`, and `qrcode`) into the web client's chunk, which is the
 * opposite of what this component is for.
 */
export default function WebRemoteStatusModal({
  onClose,
  onOpenSettings
}: WebRemoteStatusModalProps): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<RemoteStatusView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose()
    },
    [onClose]
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // The poll. Closing the overlay unmounts it (the panel renders it
  // conditionally), so the unmount cleanup is also the close cleanup.
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
        // Keep the last good reading: a dropped poll says nothing about the
        // server, and blanking the count would read as "it stopped".
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

  const clients = status?.connectedClients ?? 0
  const isRunning = status?.running ?? false

  return (
    <div
      ref={overlayRef}
      data-testid="WebRemoteStatusModal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleOverlayClick}
    >
      <div className="bg-bg-secondary rounded-xl border border-border shadow-2xl w-[440px] max-w-[calc(100vw-2rem)] max-h-[90vh] overflow-hidden flex flex-col animate-fade-in">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-accent"
            >
              <path d="M5 12.55a11 11 0 0114.08 0" />
              <path d="M1.42 9a16 16 0 0121.16 0" />
              <path d="M8.53 16.11a6 6 0 016.95 0" />
              <circle cx="12" cy="20" r="1" />
            </svg>
            <span className="text-text-primary font-medium text-[14px]">Remote Access</span>
          </div>
          <button
            data-testid="WebRemoteStatusModal.close"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 overflow-y-auto">
          <div className="flex flex-col items-center gap-4">
            {/* Where the desktop's ACCESS LINKS block would be. */}
            <div data-testid="WebRemoteStatusModal.linksLocked" className="w-full">
              <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
                Access links
              </div>
              <div className="rounded-xl border border-border bg-bg-primary px-3 py-2.5 flex items-start gap-2.5">
                <div className="mt-0.5 h-7 w-7 shrink-0 rounded-lg flex items-center justify-center text-[12px] bg-bg-tertiary text-text-secondary">
                  🔒
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-text-muted leading-snug">
                    Access links can enroll new devices, so they sit behind a step-up in settings.
                  </div>
                  <button
                    data-testid="WebRemoteStatusModal.openSettings"
                    onClick={onOpenSettings}
                    className="mt-2 text-[11px] px-2 py-1 rounded-md bg-bg-tertiary hover:bg-bg-hover text-text-secondary transition-colors"
                  >
                    Open Settings › Remote
                  </button>
                </div>
              </div>
            </div>

            {status === null ? (
              <div
                data-testid="WebRemoteStatusModal.loading"
                className="w-full text-[12px] text-text-muted px-1"
              >
                Loading…
              </div>
            ) : (
              <>
                {/* Connection status — the desktop modal's strip, same reading. */}
                <div
                  data-testid="WebRemoteStatusModal.status"
                  data-running={String(isRunning)}
                  className="w-full flex items-center justify-between text-[12px] px-1"
                >
                  <div className="flex items-center gap-1.5">
                    <div
                      className={`w-2 h-2 rounded-full ${isRunning && clients > 0 ? 'bg-success' : 'bg-warning animate-pulse'}`}
                    />
                    <span className="text-text-secondary">
                      {!isRunning
                        ? 'Server stopped'
                        : clients === 0
                          ? 'Waiting for connection...'
                          : `${clients} client${clients === 1 ? '' : 's'} connected`}
                    </span>
                  </div>
                  <span className="text-text-muted">
                    {status.port === null ? 'Not listening' : `Port ${status.port}`}
                  </span>
                </div>

                {/* Connected clients — the tailnet login when the server knows it
                    (every row reads 127.0.0.1 behind the serve proxy, which tells
                    the user nothing), otherwise the address. `clientLogins` is
                    parallel to `clientIps` by contract, so the index is the join. */}
                {status.clientIps.length > 0 && (
                  <div
                    data-testid="WebRemoteStatusModal.clientList"
                    className="w-full text-[11px] text-text-muted px-1"
                  >
                    {status.clientIps.map((ip, i) => (
                      <span
                        key={`${ip}-${i}`}
                        data-testid="WebRemoteStatusModal.client"
                        className="mr-2"
                      >
                        {status.clientLogins[i] ?? ip}
                      </span>
                    ))}
                  </div>
                )}

                {status.lastError && (
                  <div
                    data-testid="WebRemoteStatusModal.lastError"
                    className="w-full text-danger text-[11px] text-center px-2"
                  >
                    {status.lastError}
                  </div>
                )}
              </>
            )}

            {error && (
              <div
                data-testid="WebRemoteStatusModal.loadError"
                className="w-full text-[10px] text-danger px-1"
              >
                {error}
              </div>
            )}

            {/* Says why there is no Stop button, rather than leaving the operator
                hunting for one. Same sentence as the settings card's. */}
            <div
              data-testid="WebRemoteStatusModal.hostOnlyNote"
              className="w-full text-[10px] text-text-muted/60 leading-snug px-1"
            >
              Starting, stopping and configuring the server happen on the machine itself — the
              desktop app, or the server’s own console on a headless install. A remote client cannot
              switch off the connection it is using.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
