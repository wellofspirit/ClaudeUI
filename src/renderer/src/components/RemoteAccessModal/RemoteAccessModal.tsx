import { useState, useEffect, useCallback } from 'react'
import type { RemoteStatus, NetworkInterfaceInfo } from '../../../../shared/types'
import { RemoteAccessModalView } from './View'

interface RemoteAccessModalProps {
  onClose: () => void
}

export function RemoteAccessModal({ onClose }: RemoteAccessModalProps): React.JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [interfaces, setInterfaces] = useState<NetworkInterfaceInfo[]>([])
  const [selectedHost, setSelectedHost] = useState<string>('')
  const [tunnelMode, setTunnelMode] = useState(false)

  // The link/QR presentation lives in `AccessLinks` (ADR-056 item C): there is
  // no single share URL any more, because each origin carries a different
  // channel and a different identity, and picking one for the whole modal was
  // what hid that.

  useEffect(() => {
    window.api.getRemoteStatus().then(setStatus)
    window.api.getNetworkInterfaces().then((ifaces) => {
      setInterfaces(ifaces)
    })
    const cleanup = window.api.onRemoteStatus(setStatus)
    return cleanup
  }, [])

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

  /**
   * Turn the tunnel on or off for a RUNNING server.
   *
   * A restart, and it has to be: the tunnel's channel key is minted per run
   * (`start()` refuses while a server is up), so there is no tunnel-only verb to
   * call — this is the modal's own start/stop, re-parameterized. The card that
   * calls it confirms the consequence first (connected devices are dropped).
   * Errors propagate so the row can render them; `tunnelMode` follows, so the
   * pre-start toggle agrees with what is running.
   */
  const handleSetTunnel = useCallback(
    async (on: boolean): Promise<void> => {
      setStarting(true)
      try {
        await window.api.stopRemoteServer()
        const opts: { host?: string; tunnel?: boolean } = {}
        if (selectedHost) opts.host = selectedHost
        if (on) opts.tunnel = true
        await window.api.startRemoteServer(Object.keys(opts).length > 0 ? opts : undefined)
        setTunnelMode(on)
        setStatus(await window.api.getRemoteStatus())
      } finally {
        setStarting(false)
      }
    },
    [selectedHost]
  )

  /**
   * Leave for the break-glass password field. The modal closes first: the field
   * is in the settings dialog, which this modal would otherwise cover.
   */
  const handleSetPassword = useCallback(() => {
    onClose()
    // `remote` is the SECTION id (`SECTION_SCOPE_MAP` is keyed by those, not by
    // the item keys inside them) — the password field lives in its remote-server
    // block.
    window.dispatchEvent(new CustomEvent('open-settings', { detail: { section: 'remote' } }))
  }, [onClose])

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
      interfaces={interfaces}
      selectedHost={selectedHost}
      tunnelMode={tunnelMode}
      onSelectHost={setSelectedHost}
      onSetTunnelMode={setTunnelMode}
      onStart={handleStart}
      onStop={handleStop}
      onSetTunnel={handleSetTunnel}
      onSetPassword={handleSetPassword}
      onClose={onClose}
    />
  )
}
