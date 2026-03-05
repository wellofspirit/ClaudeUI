import { useState, useEffect, useCallback, useRef } from 'react'
import QRCode from 'qrcode'
import type { RemoteStatus, NetworkInterfaceInfo } from '../../../shared/types'

interface RemoteAccessModalProps {
  onClose: () => void
}

export function RemoteAccessModal({ onClose }: RemoteAccessModalProps): React.JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [interfaces, setInterfaces] = useState<NetworkInterfaceInfo[]>([])
  const [selectedHost, setSelectedHost] = useState<string>('') // '' = auto (0.0.0.0)

  // Fetch initial status + network interfaces
  useEffect(() => {
    window.api.getRemoteStatus().then(setStatus)
    window.api.getNetworkInterfaces().then((ifaces) => {
      setInterfaces(ifaces)
      // Default selection is empty (auto = all interfaces)
    })
    const cleanup = window.api.onRemoteStatus(setStatus)
    return cleanup
  }, [])

  // Generate QR code when URL changes
  useEffect(() => {
    const url = status?.lanUrl
    if (!url) {
      setQrDataUrl(null)
      return
    }
    QRCode.toDataURL(url, {
      width: 256,
      margin: 2,
      color: { dark: '#d1d5db', light: '#00000000' }
    }).then(setQrDataUrl).catch(() => setQrDataUrl(null))
  }, [status?.lanUrl])

  const handleStart = useCallback(async () => {
    setStarting(true)
    try {
      await window.api.startRemoteServer(selectedHost ? { host: selectedHost } : undefined)
      const s = await window.api.getRemoteStatus()
      setStatus(s)
    } catch (err) {
      console.error('Failed to start remote server:', err)
    } finally {
      setStarting(false)
    }
  }, [selectedHost])

  const handleStop = useCallback(async () => {
    await window.api.stopRemoteServer()
    const s = await window.api.getRemoteStatus()
    setStatus(s)
  }, [])

  const handleCopy = useCallback(() => {
    if (status?.lanUrl) {
      navigator.clipboard.writeText(status.lanUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [status?.lanUrl])

  // Close on overlay click
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose()
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const isRunning = status?.running ?? false

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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
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
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                  <path d="M12 18h.01" />
                </svg>
              </div>
              <div className="text-center">
                <div className="text-text-primary text-[13px] font-medium mb-1">Control from your phone</div>
                <div className="text-text-muted text-[12px] leading-relaxed">
                  Start the remote server, then scan the QR code on your phone to connect.
                </div>
              </div>

              {/* Network interface picker */}
              {interfaces.length > 0 && (
                <div className="w-full">
                  <label className="block text-[11px] text-text-muted mb-1.5 px-0.5">Network Interface</label>
                  <select
                    value={selectedHost}
                    onChange={(e) => setSelectedHost(e.target.value)}
                    className="w-full bg-bg-primary border border-border rounded-lg px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors appearance-none cursor-pointer"
                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
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
                onClick={handleStart}
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

              {/* URL */}
              <div className="w-full">
                <div className="flex items-center gap-2 bg-bg-primary rounded-lg px-3 py-2 border border-border">
                  <code className="flex-1 text-[11px] text-text-secondary truncate font-mono">
                    {status.lanUrl}
                  </code>
                  <button
                    onClick={handleCopy}
                    className="shrink-0 text-text-muted hover:text-accent transition-colors"
                    title="Copy URL"
                  >
                    {copied ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-success">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
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
                  <div className={`w-2 h-2 rounded-full ${(status.connectedClients ?? 0) > 0 ? 'bg-success' : 'bg-warning animate-pulse'}`} />
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
                    <span key={i} className="mr-2">{ip}</span>
                  ))}
                </div>
              )}

              {/* Stop button */}
              <button
                onClick={handleStop}
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
