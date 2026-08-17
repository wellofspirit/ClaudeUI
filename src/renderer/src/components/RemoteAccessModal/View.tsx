import { useRef, useCallback } from 'react'
import type { RemoteStatus, NetworkInterfaceInfo } from '../../../../shared/types'
import { SelectMenu } from '../shared/SelectMenu'
import { AccessLinks } from './AccessLinks'

export interface RemoteAccessModalViewProps {
  status: RemoteStatus | null
  starting: boolean
  interfaces: NetworkInterfaceInfo[]
  selectedHost: string
  tunnelMode: boolean
  onSelectHost: (host: string) => void
  onSetTunnelMode: (on: boolean) => void
  onStart: () => void
  onStop: () => void
  onSetTunnel: (on: boolean) => Promise<void>
  onSetPassword: () => void
  onClose: () => void
}

export function RemoteAccessModalView({
  status,
  starting,
  interfaces,
  selectedHost,
  tunnelMode,
  onSelectHost,
  onSetTunnelMode,
  onStart,
  onStop,
  onSetTunnel,
  onSetPassword,
  onClose
}: RemoteAccessModalViewProps): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose()
    },
    [onClose]
  )

  const isRunning = status?.running ?? false
  const isTunnelActive = status?.tunnelState != null && status.tunnelState !== 'stopped'
  const isTunnelConnected = status?.tunnelState === 'connected'
  const isTunnelLoading =
    status?.tunnelState === 'starting' ||
    status?.tunnelState === 'downloading' ||
    status?.tunnelState === 'restarting'
  const isTunnelError = status?.tunnelState === 'error'

  return (
    <div
      ref={overlayRef}
      data-testid="RemoteAccessModal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleOverlayClick}
    >
      {/* Wider than the pre-ADR-056 card: the running state now carries three
          link rows with actions rather than one URL under a QR. The BODY
          scrolls, not the card, so the header (and its close button) stays put
          when the rows expand a QR. */}
      <div className="bg-bg-secondary rounded-xl border border-border shadow-2xl w-[440px] max-h-[90vh] overflow-hidden flex flex-col animate-fade-in">
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
            data-testid="RemoteAccessModal.close"
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
          {!isRunning ? (
            /* Not running state */
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="w-16 h-16 rounded-2xl bg-bg-tertiary flex items-center justify-center">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-text-muted"
                >
                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                  <path d="M12 18h.01" />
                </svg>
              </div>
              <div className="text-center">
                <div className="text-text-primary text-[13px] font-medium mb-1">
                  Control from your phone
                </div>
                <div className="text-text-muted text-[12px] leading-relaxed">
                  Start the remote server, then scan the QR code on your phone to connect.
                </div>
              </div>

              {/* Mode toggle */}
              <div className="w-full">
                <label className="block text-[11px] text-text-muted mb-1.5 px-0.5">
                  Connection Mode
                </label>
                <div className="flex rounded-lg border border-border overflow-hidden">
                  <button
                    onClick={() => onSetTunnelMode(false)}
                    className={`flex-1 px-3 py-2 text-[12px] font-medium transition-colors ${
                      !tunnelMode
                        ? 'bg-accent/15 text-accent border-r border-border'
                        : 'bg-bg-primary text-text-muted hover:text-text-secondary border-r border-border'
                    }`}
                  >
                    LAN Only
                  </button>
                  <button
                    onClick={() => onSetTunnelMode(true)}
                    className={`flex-1 px-3 py-2 text-[12px] font-medium transition-colors ${
                      tunnelMode
                        ? 'bg-accent/15 text-accent'
                        : 'bg-bg-primary text-text-muted hover:text-text-secondary'
                    }`}
                  >
                    Internet (Tunnel)
                  </button>
                </div>
                {tunnelMode && (
                  <div className="mt-1.5 text-[11px] text-text-muted px-0.5 flex items-center gap-1">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0110 0v4" />
                    </svg>
                    End-to-end encrypted messages over a Cloudflare tunnel
                  </div>
                )}
              </div>

              {/* Network interface picker (only for LAN mode) */}
              {!tunnelMode && interfaces.length > 0 && (
                <div className="w-full">
                  <label className="block text-[11px] text-text-muted mb-1.5 px-0.5">
                    Network Interface
                  </label>
                  <SelectMenu
                    testid="RemoteAccessModal.interface"
                    value={selectedHost}
                    onChange={onSelectHost}
                    options={[
                      { value: '', label: 'All interfaces (auto-detect)' },
                      ...interfaces.map((iface) => ({
                        value: iface.address,
                        label: `${iface.name} — ${iface.address}${
                          iface.priority >= 9 ? ' (VPN)' : iface.priority <= 1 ? ' ★' : ''
                        }`
                      }))
                    ]}
                    triggerClassName="w-full bg-bg-primary border border-border rounded-lg px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors"
                  />
                </div>
              )}

              <button
                data-testid="RemoteAccessModal.start"
                onClick={onStart}
                disabled={starting}
                className="px-5 py-2 rounded-lg bg-accent text-white text-[13px] font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                {starting ? 'Starting...' : 'Start Remote Server'}
              </button>

              {/* Surfaces a failed listen attempt (e.g. from a failed autostart —
                  there's no modal open at that point to show it any other way). */}
              {status?.lastError && (
                <div
                  data-testid="RemoteAccessModal.lastError"
                  className="w-full text-danger text-[11px] text-center px-2"
                >
                  {status.lastError}
                </div>
              )}
            </div>
          ) : status ? (
            /* Running state */
            <div className="flex flex-col items-center gap-4">
              {/* The links themselves — one row per ORIGIN, because the origin
                  decides both the channel and the identity a device will still
                  have to present inside it (ADR-056). */}
              <AccessLinks
                status={status}
                onSetTunnel={onSetTunnel}
                onSetPassword={onSetPassword}
              />

              {/* Tunnel status */}
              {isTunnelActive && (
                <div className="w-full">
                  <div className="flex items-center gap-1.5 text-[12px] px-1">
                    {isTunnelLoading && (
                      <>
                        <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
                        <span className="text-text-secondary">
                          {status.tunnelState === 'downloading'
                            ? 'Downloading tunnel binary...'
                            : status.tunnelState === 'restarting'
                              ? 'Tunnel reconnecting...'
                              : 'Tunnel starting...'}
                        </span>
                      </>
                    )}
                    {isTunnelConnected && (
                      <>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="text-success"
                        >
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0110 0v4" />
                        </svg>
                        <span className="text-success text-[11px]">End-to-end encrypted</span>
                      </>
                    )}
                    {isTunnelError && (
                      <>
                        <div className="w-2 h-2 rounded-full bg-danger" />
                        <span className="text-danger text-[11px] truncate">
                          {status.tunnelError || 'Tunnel error'}
                        </span>
                      </>
                    )}
                  </div>
                  {(isTunnelConnected || isTunnelLoading) &&
                    status.tunnelState === 'restarting' && (
                      <div className="text-[10px] text-text-muted mt-1 px-1">
                        URL may change — re-scan QR if needed
                      </div>
                    )}
                </div>
              )}

              {/* The tailnet row's own copy now carries what the standalone TLS
                  identity line used to say ("No secret in the link — sign-in is
                  your passkey"), so it is not repeated here. */}

              {/* TLS mode asked for but `tailscale serve` is not up (autostart
                  keeps retrying) — this is the only place the reason surfaces. */}
              {status.tls?.detectionMessage && (
                <div
                  data-testid="RemoteAccessModal.tlsDetection"
                  className="w-full text-danger text-[11px] text-center px-2"
                >
                  {status.tls.detectionMessage}
                </div>
              )}

              {/* Connection status */}
              <div className="w-full flex items-center justify-between text-[12px] px-1">
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-2 h-2 rounded-full ${(status.connectedClients ?? 0) > 0 ? 'bg-success' : 'bg-warning animate-pulse'}`}
                  />
                  <span className="text-text-secondary">
                    {(status.connectedClients ?? 0) === 0
                      ? 'Waiting for connection...'
                      : `${status.connectedClients} client${status.connectedClients === 1 ? '' : 's'} connected`}
                  </span>
                </div>
                <span className="text-text-muted">Port {status.port}</span>
              </div>

              {/* Connected clients — the tailnet login when we know it (every row
                  reads 127.0.0.1 behind the serve proxy, which tells the user
                  nothing), otherwise the address. */}
              {status.clientIps && status.clientIps.length > 0 && (
                <div className="w-full text-[11px] text-text-muted px-1">
                  {status.clientIps.map((ip, i) => (
                    <span key={i} className="mr-2">
                      {status.clientLogins?.[i] ?? ip}
                    </span>
                  ))}
                </div>
              )}

              {/* Stop button */}
              <button
                data-testid="RemoteAccessModal.stop"
                onClick={onStop}
                className="px-4 py-1.5 rounded-lg border border-danger/30 text-danger text-[12px] hover:bg-danger/10 transition-colors"
              >
                Stop Remote Server
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
