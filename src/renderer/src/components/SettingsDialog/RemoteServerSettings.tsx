import { useCallback, useEffect, useState } from 'react'
import type { NetworkInterfaceInfo, RemoteConfig } from '../../../../shared/types'
import { SelectMenu } from '../shared/SelectMenu'

// Mirrors remote-auth.ts's MIN_PASSWORD_LENGTH — kept as a local literal
// because that module is main-only (imports node:crypto) and can't be
// imported into the renderer bundle. The authoritative check still happens
// in main (setRemotePassword throws), this is just fast inline feedback.
const MIN_PASSWORD_LENGTH = 12

const inputClass =
  'bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[12px] text-text-secondary outline-none focus:border-accent/50 transition-colors'

/**
 * Bespoke Settings › Remote control for the persisted remote-server config
 * (fixed port, bind interface, autostart, password credential). Talks
 * directly to the main-only `remote:*` IPC (window.api.getRemoteConfig et
 * al.) — deliberately NOT wired through the UISettings store/AppSettings,
 * because a remote client can read/write UISettings via
 * `config:save-settings` and this config (esp. the password) must never
 * cross that surface (see the Phase-1 kickoff spec's security constraints).
 */
export function RemoteServerSettings(): React.JSX.Element {
  const [config, setConfig] = useState<RemoteConfig | null>(null)
  const [interfaces, setInterfaces] = useState<NetworkInterfaceInfo[]>([])
  const [portInput, setPortInput] = useState('')
  const [portError, setPortError] = useState<string | null>(null)
  const [tlsPortInput, setTlsPortInput] = useState('')
  const [tlsPortError, setTlsPortError] = useState<string | null>(null)
  const [passwordDraft, setPasswordDraft] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)
  /** Actionable message from the last failed `detectTailscale()` probe. */
  const [tlsDetection, setTlsDetection] = useState<string | null>(null)
  /** True once detection passed and we're waiting for the confirm click. */
  const [confirmTls, setConfirmTls] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    const [nextConfig, ifaces] = await Promise.all([
      window.api.getRemoteConfig(),
      window.api.getNetworkInterfaces()
    ])
    setConfig(nextConfig)
    setPortInput(nextConfig.port ? String(nextConfig.port) : '')
    setTlsPortInput(String(nextConfig.tlsHttpsPort))
    setInterfaces(ifaces)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const commitPort = useCallback(async (): Promise<void> => {
    const trimmed = portInput.trim()
    const value = trimmed === '' ? 0 : Number(trimmed)
    if (!Number.isInteger(value) || (value !== 0 && (value < 1024 || value > 65535))) {
      setPortError('Port must be 0 (random) or between 1024 and 65535')
      return
    }
    setPortError(null)
    const updated = await window.api.setRemoteConfig({ port: value })
    setConfig(updated)
    setPortInput(updated.port ? String(updated.port) : '')
  }, [portInput])

  /**
   * The pinned `tailscale serve` HTTPS port (ADR-042). Unlike the listen port, 0
   * is not a legal value — serve binds one concrete port and the pin exists so
   * the user's bookmark never moves. An empty field means "back to the 443
   * default" rather than an error, so the field can't be left in a broken state.
   */
  const commitTlsPort = useCallback(async (): Promise<void> => {
    const trimmed = tlsPortInput.trim()
    const value = trimmed === '' ? 443 : Number(trimmed)
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      setTlsPortError('Tailscale HTTPS port must be between 1 and 65535')
      return
    }
    setTlsPortError(null)
    const updated = await window.api.setRemoteConfig({ tlsHttpsPort: value })
    setConfig(updated)
    setTlsPortInput(String(updated.tlsHttpsPort))
  }, [tlsPortInput])

  const handleBindHostChange = useCallback(async (value: string): Promise<void> => {
    const updated = await window.api.setRemoteConfig({ bindHost: value === '' ? null : value })
    setConfig(updated)
  }, [])

  const handleAutostartToggle = useCallback(async (): Promise<void> => {
    if (!config) return
    const updated = await window.api.setRemoteConfig({ autostart: !config.autostart })
    setConfig(updated)
  }, [config])

  /**
   * TLS mode is gated on a LIVE probe, not on optimism: `tailscale serve` on a
   * tailnet without HTTPS certificates either silently no-ops or blocks, so
   * enabling the toggle when detection is not `ok` would produce a server that
   * binds loopback and is reachable from nowhere. Detection failure therefore
   * leaves the toggle OFF and renders the actionable message instead.
   *
   * A passing probe still needs one confirm click (the Clear-password pattern),
   * because turning this on mutates machine state that outlives the app.
   */
  const handleTlsToggle = useCallback(async (): Promise<void> => {
    if (!config) return
    if (config.tlsMode === 1) {
      setConfirmTls(false)
      setTlsDetection(null)
      setConfig(await window.api.setRemoteConfig({ tlsMode: 0 }))
      return
    }
    if (confirmTls) {
      setConfirmTls(false)
      setConfig(await window.api.setRemoteConfig({ tlsMode: 1 }))
      return
    }
    setBusy(true)
    try {
      const detection = await window.api.detectTailscale()
      if (detection.state !== 'ok') {
        setTlsDetection(detection.message)
        return
      }
      setTlsDetection(null)
      setConfirmTls(true)
    } catch (err) {
      setTlsDetection(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [config, confirmTls])

  const handleSetPassword = useCallback(async (): Promise<void> => {
    setPasswordError(null)
    if (passwordDraft.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
      return
    }
    if (passwordDraft !== passwordConfirm) {
      setPasswordError('Passwords do not match')
      return
    }
    setBusy(true)
    try {
      await window.api.setRemotePassword(passwordDraft)
      setPasswordDraft('')
      setPasswordConfirm('')
      await reload()
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [passwordDraft, passwordConfirm, reload])

  const handleClearPassword = useCallback(async (): Promise<void> => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setBusy(true)
    try {
      await window.api.clearRemotePassword()
      setConfirmClear(false)
      await reload()
    } finally {
      setBusy(false)
    }
  }, [confirmClear, reload])

  if (!config) {
    return (
      <div data-testid="RemoteServerSettings" className="px-3 py-1.5 text-[13px] text-text-muted">
        Loading…
      </div>
    )
  }

  const bindHostKnown =
    config.bindHost == null || interfaces.some((iface) => iface.address === config.bindHost)
  const tlsEnabled = config.tlsMode === 1

  return (
    <div
      data-testid="RemoteServerSettings"
      className="px-3 py-1.5 text-[13px] text-text-secondary space-y-3"
    >
      {/* Port */}
      <div>
        <div className="mb-1">Port</div>
        <input
          data-testid="RemoteServerSettings.port"
          type="text"
          inputMode="numeric"
          value={portInput}
          placeholder="Random port"
          onChange={(e) => setPortInput(e.target.value)}
          onBlur={() => void commitPort()}
          className={`${inputClass} w-full`}
        />
        {portError && (
          <div
            data-testid="RemoteServerSettings.portError"
            className="text-[10px] text-red-400 mt-0.5"
          >
            {portError}
          </div>
        )}
        <div className="text-[10px] text-text-muted/60 mt-1">
          Applies the next time the server starts.
        </div>
      </div>

      {/* Bind interface */}
      <div>
        <div className="mb-1">Bind interface</div>
        <SelectMenu
          testid="RemoteServerSettings.bindHost"
          value={config.bindHost ?? ''}
          disabled={tlsEnabled}
          onChange={(v) => void handleBindHostChange(v)}
          options={[
            { value: '', label: 'All interfaces (0.0.0.0)' },
            ...interfaces.map((iface) => ({
              value: iface.address,
              label: `${iface.address} (${iface.name})`
            })),
            // A stale/hand-edited bindHost that no longer matches a live NIC
            // stays selectable so the control reports what is actually saved.
            ...(!bindHostKnown && config.bindHost
              ? [{ value: config.bindHost, label: `${config.bindHost} (unavailable)` }]
              : [])
          ]}
          triggerClassName={`${inputClass} w-full ${tlsEnabled ? 'opacity-40' : ''}`}
        />
        {tlsEnabled && (
          <div
            data-testid="RemoteServerSettings.bindHostTlsHint"
            className="text-[10px] text-text-muted/60 mt-1"
          >
            TLS mode binds 127.0.0.1 — reached via your tailnet name.
          </div>
        )}
      </div>

      {/* Autostart */}
      <button
        data-testid="RemoteServerSettings.autostart"
        onClick={() => void handleAutostartToggle()}
        className="w-full flex items-center justify-between py-1 text-[13px] text-text-secondary hover:bg-bg-hover rounded transition-colors cursor-default"
      >
        <span>Start remote access on launch</span>
        <span
          className={`w-7 h-4 rounded-full relative transition-colors ${config.autostart ? 'bg-accent' : 'bg-text-muted/30'}`}
        >
          <span
            className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${config.autostart ? 'left-3.5' : 'left-0.5'}`}
          />
        </span>
      </button>

      {/* Tailscale HTTPS (TLS mode) */}
      <div>
        <button
          data-testid="RemoteServerSettings.tls"
          disabled={busy}
          onClick={() => void handleTlsToggle()}
          className="w-full flex items-center justify-between py-1 text-[13px] text-text-secondary hover:bg-bg-hover rounded transition-colors cursor-default disabled:opacity-50"
        >
          <span>Tailscale HTTPS (tailnet identity)</span>
          <span
            className={`w-7 h-4 rounded-full relative transition-colors ${tlsEnabled ? 'bg-accent' : 'bg-text-muted/30'}`}
          >
            <span
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${tlsEnabled ? 'left-3.5' : 'left-0.5'}`}
            />
          </span>
        </button>
        {confirmTls && (
          <div
            data-testid="RemoteServerSettings.tlsConfirm"
            className="text-[10px] text-warning mt-0.5"
          >
            Configures `tailscale serve` on this machine (persists until turned off) and restricts
            the server to Tailscale-only access. Click the toggle again to confirm.
          </div>
        )}
        {tlsDetection && (
          <div
            data-testid="RemoteServerSettings.tlsDetection"
            className="text-[10px] text-red-400 mt-0.5"
          >
            {tlsDetection}
          </div>
        )}
        <div className="text-[10px] text-text-muted/60 mt-1">
          Applies the next time the server starts.
        </div>

        {/* Pinned HTTPS port (ADR-042) — only meaningful while TLS mode is on. */}
        <div className="mt-2">
          <div className="mb-1 text-[12px] text-text-secondary">HTTPS port (Tailscale)</div>
          <input
            data-testid="RemoteServerSettings.tlsHttpsPort"
            type="text"
            inputMode="numeric"
            value={tlsPortInput}
            placeholder="443"
            disabled={!tlsEnabled}
            onChange={(e) => setTlsPortInput(e.target.value)}
            onBlur={() => void commitTlsPort()}
            className={`${inputClass} w-full ${tlsEnabled ? '' : 'opacity-40'}`}
          />
          {tlsPortError && (
            <div
              data-testid="RemoteServerSettings.tlsHttpsPortError"
              className="text-[10px] text-red-400 mt-0.5"
            >
              {tlsPortError}
            </div>
          )}
          <div
            data-testid="RemoteServerSettings.tlsHttpsPortHint"
            className="text-[10px] text-text-muted/60 mt-1 leading-snug"
          >
            The only port used — no fallback. 443 gives a bare https://&lt;your-node&gt;.ts.net URL;
            443, 8443 and 10000 are the ports Tailscale Funnel would accept.
          </div>
        </div>
      </div>

      {/* Password */}
      <div>
        <div className="mb-1">Password</div>
        <div
          data-testid="RemoteServerSettings.passwordStatus"
          className="text-[10px] text-text-muted/70 mb-1"
        >
          {config.passwordSet
            ? `Set${config.passwordUpdatedAt ? ` · updated ${new Date(config.passwordUpdatedAt).toLocaleString()}` : ''}`
            : 'Not set'}
        </div>
        <div className="space-y-1">
          <input
            data-testid="RemoteServerSettings.passwordInput"
            type="password"
            placeholder="New password"
            value={passwordDraft}
            onChange={(e) => setPasswordDraft(e.target.value)}
            className={`${inputClass} w-full`}
          />
          <input
            data-testid="RemoteServerSettings.passwordConfirm"
            type="password"
            placeholder="Confirm password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            className={`${inputClass} w-full`}
          />
        </div>
        {passwordError && (
          <div
            data-testid="RemoteServerSettings.passwordError"
            className="text-[10px] text-red-400 mt-0.5"
          >
            {passwordError}
          </div>
        )}
        <div className="flex items-center gap-2 mt-1.5">
          <button
            data-testid="RemoteServerSettings.setPassword"
            disabled={busy}
            onClick={() => void handleSetPassword()}
            className="rounded bg-accent/15 px-2 py-1 text-accent hover:bg-accent/25 disabled:opacity-40 text-[11px]"
          >
            {config.passwordSet ? 'Change' : 'Set'}
          </button>
          {config.passwordSet && (
            <button
              data-testid="RemoteServerSettings.clearPassword"
              disabled={busy}
              onClick={() => void handleClearPassword()}
              className="rounded px-2 py-1 text-red-400 hover:bg-red-500/10 disabled:opacity-40 text-[11px]"
            >
              {confirmClear ? 'Confirm clear?' : 'Clear'}
            </button>
          )}
        </div>
        {/* Transport honesty (ADR-030 spirit): the password proof is a bearer
            secret, so it is only as private as the network it crosses. */}
        <div
          data-testid="RemoteServerSettings.passwordTransportNote"
          className="text-[10px] text-text-muted/60 mt-1.5 leading-snug"
        >
          Password sign-in is only as private as the network between your browser and this machine.
          Use it over Tailscale or a trusted LAN — not open Wi-Fi.
        </div>
      </div>
    </div>
  )
}
