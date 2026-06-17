import { useRef, useCallback } from 'react'
import type { RemoteStatus, NetworkInterfaceInfo } from '../../../../shared/types'

export interface RemoteAccessModalViewProps {
  status: RemoteStatus | null
  starting: boolean
  qrDataUrl: string | null
  copied: boolean
  interfaces: NetworkInterfaceInfo[]
  selectedHost: string
  tunnelMode: boolean
  onSelectHost: (host: string) => void
  onSetTunnelMode: (on: boolean) => void
  onStart: () => void
  onStop: () => void
  onCopy: () => void
  onClose: () => void
}

export function RemoteAccessModalView({
  status,
  starting,
  qrDataUrl,
  copied,
  interfaces,
  selectedHost,
  tunnelMode,
  onSelectHost,
  onSetTunnelMode,
  onStart,
  onStop,
  onCopy,
  onClose
}: RemoteAccessModalViewProps): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)

  const shareUrl = status?.tunnelUrl ?? status?.lanUrl ?? null
  const displayUrl = shareUrl ? shareUrl.replace(/#.*$/, '') : null

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleOverlayClick}
    >
      <div className="bg-bg-secondary rounded-xl border border-border shadow-2xl w-[380px] max-h-[90vh] overflow-hidden animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
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
        <div className="px-5 py-5">
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
                    E2E encrypted via Cloudflare Tunnel
                  </div>
                )}
              </div>

              {/* Network interface picker (only for LAN mode) */}
              {!tunnelMode && interfaces.length > 0 && (
                <div className="w-full">
                  <label className="block text-[11px] text-text-muted mb-1.5 px-0.5">
                    Network Interface
                  </label>
                  <select
                    value={selectedHost}
                    onChange={(e) => onSelectHost(e.target.value)}
                    className="w-full bg-bg-primary border border-border rounded-lg px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors appearance-none cursor-pointer"
                    style={{
                      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
                      backgroundRepeat: 'no-repeat',
                      backgroundPosition: 'right 10px center'
                    }}
                  >
                    <option value="">All interfaces (auto-detect)</option>
                    {interfaces.map((iface) => (
                      <option key={`${iface.name}-${iface.address}`} value={iface.address}>
                        {iface.name} — {iface.address}
                        {iface.priority >= 9 ? ' (VPN)' : iface.priority <= 1 ? ' ★' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <button
                onClick={onStart}
                disabled={starting}
                className="px-5 py-2 rounded-lg bg-accent text-white text-[13px] font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                {starting ? 'Starting...' : 'Start Remote Server'}
              </button>
            </div>
          ) : status ? (
            /* Running state */
            <div className="flex flex-col items-center gap-4">
              {/* QR Code */}
              <div className="relative">
                {qrDataUrl ? (
                  <div className="p-3 bg-bg-tertiary rounded-xl">
                    <img src={qrDataUrl} alt="QR Code" width={220} height={220} className="block" />
                  </div>
                ) : (
                  <div className="w-[220px] h-[220px] bg-bg-tertiary rounded-xl animate-pulse" />
                )}
              </div>

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
                        <span className="text-success text-[11px]">E2E Encrypted</span>
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

              {/* URL */}
              <div className="w-full">
                <div className="flex items-center gap-2 bg-bg-primary rounded-lg px-3 py-2 border border-border">
                  <code className="flex-1 text-[11px] text-text-secondary truncate font-mono">
                    {displayUrl}
                  </code>
                  <button
                    onClick={onCopy}
                    className="shrink-0 text-text-muted hover:text-accent transition-colors"
                    title="Copy URL"
                  >
                    {copied ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        className="text-success"
                      >
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    ) : (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

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

              {/* Client IPs */}
              {status.clientIps && status.clientIps.length > 0 && (
                <div className="w-full text-[11px] text-text-muted px-1">
                  {status.clientIps.map((ip, i) => (
                    <span key={i} className="mr-2">
                      {ip}
                    </span>
                  ))}
                </div>
              )}

              {/* Stop button */}
              <button
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
