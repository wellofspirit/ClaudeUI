import { useState, useEffect, useCallback } from 'react'
import QRCode from 'qrcode'
import type { RemoteStatus, NetworkInterfaceInfo } from '../../../../shared/types'
import { RemoteAccessModalView } from './View'

interface RemoteAccessModalProps {
  onClose: () => void
}

export function RemoteAccessModal({ onClose }: RemoteAccessModalProps): React.JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [interfaces, setInterfaces] = useState<NetworkInterfaceInfo[]>([])
  const [selectedHost, setSelectedHost] = useState<string>('')
  const [tunnelMode, setTunnelMode] = useState(false)

  const shareUrl = status?.tunnelUrl ?? status?.lanUrl ?? null

  useEffect(() => {
    window.api.getRemoteStatus().then(setStatus)
    window.api.getNetworkInterfaces().then((ifaces) => {
      setInterfaces(ifaces)
    })
    const cleanup = window.api.onRemoteStatus(setStatus)
    return cleanup
  }, [])

  useEffect(() => {
    if (!shareUrl) {
      setQrDataUrl(null)
      return
    }
    QRCode.toDataURL(shareUrl, {
      width: 256,
      margin: 2,
      color: { dark: '#d1d5db', light: '#00000000' }
    }).then(setQrDataUrl).catch(() => setQrDataUrl(null))
  }, [shareUrl])

  const handleStart = useCallback(async () => {
    setStarting(true)
    try {
      const opts: { host?: string; tunnel?: boolean } = {}
      if (selectedHost) opts.host = selectedHost
      if (tunnelMode) opts.tunnel = true
      await window.api.startRemoteServer(Object.keys(opts).length > 0 ? opts : undefined)
      const s = await window.api.getRemoteStatus()
      setStatus(s)
    } catch (err) {
      console.error('Failed to start remote server:', err)
    } finally {
      setStarting(false)
    }
  }, [selectedHost, tunnelMode])

  const handleStop = useCallback(async () => {
    await window.api.stopRemoteServer()
    const s = await window.api.getRemoteStatus()
    setStatus(s)
  }, [])

  const handleCopy = useCallback(() => {
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [shareUrl])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <RemoteAccessModalView
      status={status}
      starting={starting}
      qrDataUrl={qrDataUrl}
      copied={copied}
      interfaces={interfaces}
      selectedHost={selectedHost}
      tunnelMode={tunnelMode}
      onSelectHost={setSelectedHost}
      onSetTunnelMode={setTunnelMode}
      onStart={handleStart}
      onStop={handleStop}
      onCopy={handleCopy}
      onClose={onClose}
    />
  )
}
