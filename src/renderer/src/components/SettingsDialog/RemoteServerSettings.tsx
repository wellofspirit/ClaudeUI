import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { NetworkInterfaceInfo, RemoteConfig } from '../../../../shared/types'
import { RemotePasskeySettings } from './RemotePasskeySettings'
import { SelectMenu } from '../shared/SelectMenu'
import { isWebClient } from './remote-settings-transport'
import { EnrollCard } from './EnrollCard'
import { useEnrollOffer } from './enroll-flow'

/**
 * Lazy for the same reason `SettingsPanel` loads `RemoteAccessModal` lazily: the
 * card drags `qrcode` in, and neither belongs in the eagerly-loaded settings
 * chunk. Only the WEB branch below renders it, so on the desktop this chunk is
 * never fetched at all — and on the web it is fetched when the remote section is
 * rendered, not at boot.
 */
const WebAccessLinks = lazy(() => import('./WebAccessLinks'))

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
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)
  /** Actionable message from the last failed `detectTailscale()` probe. */
  const [tlsDetection, setTlsDetection] = useState<string | null>(null)
  /** True once detection passed and we're waiting for the confirm click. */
  const [confirmTls, setConfirmTls] = useState(false)
  /**
   * The web client's enrolment bridge while a passkey is worth offering on THIS
   * connection, else null. Null on the desktop by construction — see
   * `enroll-flow.ts`.
   */
  const enrollBridge = useEnrollOffer()

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

  /**
   * The remote-terminal master switch (ADR-052 decision 6). Persisted in
   * `remote_config`, NOT in UISettings: `config:save-settings` is remotely
   * reachable, so a flag living there would let a remote client arm its own
   * `shell` capability. Turning it off takes effect on live connections
   * immediately (main strips the grant and detaches remote viewers).
   */
  const handleTerminalToggle = useCallback(async (): Promise<void> => {
    if (!config) return
    setConfig(await window.api.setRemoteConfig({ allowTerminal: !config.allowTerminal }))
  }, [config])

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
  /**
   * Not the host anchor (ADR-054 decision 6).
   *
   * Everything from here to the password block is TRANSPORT configuration —
   * which port to listen on, which interface to bind, whether `tailscale serve`
   * runs, whether a remote shell is offered at all — and none of it has a
   * web-reachable writer, deliberately: a remote client must never be able to
   * take over the transport it is talking through (the ADR-042 rule, generalised
   * by the host anchor). So the web client renders the auth surface only, rather
   * than a wall of controls whose every write would be refused.
   */
  const web = isWebClient()

  return (
    <div
      data-testid="RemoteServerSettings"
      data-transport={web ? 'web' : 'host'}
      className="px-3 py-1.5 text-[13px] text-text-secondary space-y-3"
    >
      {/* FIRST, above even the host-only note: on a phone this is the one thing
          in this section the operator came here to DO, and it is time-sensitive
          in a way nothing below it is — the offer is alive only while this
          connection is a password one on an origin that can bind a credential.
          Its own conditions decide whether it renders at all. */}
      {enrollBridge && <EnrollCard bridge={enrollBridge} />}

      {web && (
        <div
          data-testid="RemoteServerSettings.hostOnlyNote"
          className="text-[10px] text-text-muted/60 leading-snug"
        >
          Port, network interface, Tailscale HTTPS and the remote-terminal switch are set on the
          machine itself — the desktop app, or the server’s own configuration on a headless install.
        </div>
      )}

      {!web && (
        <>
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
                Configures `tailscale serve` on this machine (persists until turned off) and
                restricts the server to Tailscale-only access. Click the toggle again to confirm.
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
                The only port used — no fallback. 443 gives a bare https://&lt;your-node&gt;.ts.net
                URL; 443, 8443 and 10000 are the ports Tailscale Funnel would accept.
              </div>
            </div>
          </div>

          {/* Remote terminal (ADR-052) */}
          <div>
            <button
              data-testid="RemoteServerSettings.allowTerminal"
              onClick={() => void handleTerminalToggle()}
              className="w-full flex items-center justify-between py-1 text-[13px] text-text-secondary hover:bg-bg-hover rounded transition-colors cursor-default"
            >
              <span>Allow remote terminal</span>
              <span
                className={`w-7 h-4 rounded-full relative transition-colors ${config.allowTerminal ? 'bg-accent' : 'bg-text-muted/30'}`}
              >
                <span
                  className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${config.allowTerminal ? 'left-3.5' : 'left-0.5'}`}
                />
              </span>
            </button>
            {/* Say plainly what this exposes — it is a raw shell, not a sandbox. */}
            <div
              data-testid="RemoteServerSettings.allowTerminalNote"
              className="text-[10px] text-text-muted/60 mt-1 leading-snug"
            >
              Lets a signed-in remote client open a real shell on this machine, running as you, with
              no per-command approval. Each client must re-enter the remote password to unlock it,
              and access ends after the terminal re-check window in the security section below. You
              can watch any remote shell live from this app.
            </div>
          </div>
        </>
      )}

      {/* CLEARING the break-glass credential stays here, and only here: it is
          host-anchor only (`remote:clear-password` has no remote registration),
          and removing the last way back in over the network belongs beside the
          transport controls rather than inside an editor a phone can open.
          SETTING / rotating it moved into the security editor below, where it is
          one of the six facts an operator reviews and changes together. */}
      {config.passwordSet && !web && (
        <div>
          <div className="mb-1">Break-glass password</div>
          <div className="flex items-center gap-2">
            <button
              data-testid="RemoteServerSettings.clearPassword"
              disabled={busy}
              onClick={() => void handleClearPassword()}
              className="rounded px-2 py-1 text-red-400 hover:bg-red-500/10 disabled:opacity-40 text-[11px]"
            >
              {confirmClear ? 'Confirm clear?' : 'Clear password'}
            </button>
          </div>
          <div className="text-[10px] text-text-muted/60 mt-1 leading-snug">
            Removes the password entirely. Change it in the security section below.
          </div>
        </div>
      )}

      {/* Passkeys + the auth-policy switch (ADR-052). Its own component: this
          block owns credential state that changes without any local action
          (a phone enrolling lands here), which the pure-config blocks above
          never do. */}
      <RemotePasskeySettings config={config} onConfigChange={setConfig} onReload={reload} />

      {/* Access links, web only (ADR-056 item C). BELOW the credential blocks
          deliberately: those answer "who may sign in", this answers "through
          which channel", and the second question only becomes interesting once
          the first is settled. The desktop reaches the same card through
          `RemoteAccessModal`, which also owns the transport controls this
          section withholds from a remote client. */}
      {web && (
        <Suspense fallback={null}>
          <WebAccessLinks />
        </Suspense>
      )}
    </div>
  )
}
