import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { NetworkInterfaceInfo, RemoteConfig } from '../../../../shared/types'
import type { IdeAvailability } from '../../../../shared/remote-protocol'
import { RemotePasskeySettings } from './RemotePasskeySettings'
import { SessionSecuritySettings } from './SessionSecuritySettings'
import { RemoteStatusCard } from './RemoteStatusCard'
import { isWebClient } from './remote-settings-transport'
import { EnrollCard } from './EnrollCard'
import { useEnrollOffer } from './enroll-flow'
import {
  Button,
  NumberField,
  SelectField,
  SettingRow,
  SettingsToggle,
  TextField
} from './settings-controls'

/**
 * Settings › Remote access — the four group bodies (ADR-065).
 *
 * ## What these panes are
 *
 * The persisted remote-server config (fixed port, bind interface, autostart,
 * TLS mode, the terminal/IDE master switches, the break-glass credential) plus
 * the credential surfaces that hang off it. They talk directly to the main-only
 * `remote:*` IPC (`window.api.getRemoteConfig` et al.) — deliberately NOT through
 * the UISettings store/AppSettings, because a remote client can read and write
 * UISettings via `config:save-settings`, and this config (the password above
 * all) must never cross that surface.
 *
 * ## Why four exports over one hook
 *
 * This was ONE 660-line component rendering three screens of controls in one
 * card. ADR-065 makes a divider a GROUP boundary, so each former block is now
 * its own exported section and the page composes them:
 *
 *  - {@link RemoteServerSection}   — the listener: port, interface, autostart, TLS.
 *  - {@link RemoteAccessSection}   — what a signed-in client may reach: shell, VS Code.
 *  - {@link RemoteSecuritySection} — who may sign in: enrolment, the settings
 *    editor, the break-glass credential, the passkey list.
 *  - {@link RemoteLinksSection}    — through which channel: status + access links.
 *
 * Each calls {@link useRemoteServerConfig} for its own read of the config, the
 * way every `PiConfigPanes` section calls `usePiNativeConfigLeaf`. The sections
 * partition the config cleanly — no field is edited from two of them — so
 * per-section state costs one extra `remote:get-config` read and buys sections
 * that mount independently, in any order, on any page.
 *
 * The PROBES stay with the section that renders them (the Tailscale detection in
 * `RemoteServerSection`, `ide:availability` in `RemoteAccessSection`) rather than
 * moving into the hook: a probe execs a binary on the host, and a hook shared by
 * four sections would exec it four times per page open.
 *
 * {@link RemoteServerSettings} keeps its name and its testid as a thin
 * composition of the four, so the legacy single-item mount keeps working.
 */

/**
 * Testid namespace, kept from before the split (ADR-027).
 *
 * The parts below are addressed as `RemoteServerSettings.*` by their tests, by
 * `docs/adr/adr-064`, and by the app-shot drive. The component that renders a
 * part changed; the part did not, so its id did not either.
 */
const R = 'RemoteServerSettings'

/**
 * Lazy for the same reason `SettingsPanel` loads `RemoteAccessModal` lazily: the
 * card drags `qrcode` in, and neither belongs in the eagerly-loaded settings
 * chunk. Only the WEB branch renders it, so on the desktop this chunk is never
 * fetched at all — and on the web it is fetched when the section renders, not at
 * boot.
 */
const WebAccessLinks = lazy(() => import('./WebAccessLinks'))

// ── The shared config read ───────────────────────────────────────────

export interface RemoteServerConfigApi {
  /** null until the first read resolves — sections render a Loading… row. */
  config: RemoteConfig | null
  /** Adopt the config a write handed back, so the section stays the truth. */
  setConfig: (config: RemoteConfig) => void
  /**
   * Re-read from main. Credential mutations move `credentialCount` /
   * `effectiveAuthPolicy` without any config write, so a section cannot just
   * keep the object a `setRemoteConfig` handed back.
   */
  reload: () => Promise<void>
}

export function useRemoteServerConfig(): RemoteServerConfigApi {
  const [config, setConfig] = useState<RemoteConfig | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setConfig(await window.api.getRemoteConfig())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { config, setConfig, reload }
}

/**
 * The bind-interface options. Only `RemoteServerSection` asks for these, and
 * only on the host: a web client renders no picker, so asking the host to
 * enumerate its NICs for it would be a round trip for nothing.
 */
function useNetworkInterfaces(enabled: boolean): NetworkInterfaceInfo[] {
  const [interfaces, setInterfaces] = useState<NetworkInterfaceInfo[]>([])
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // Its own read rather than a sibling of the config's: a machine that cannot
    // enumerate its NICs still has a port and an autostart flag to edit.
    window.api
      .getNetworkInterfaces()
      .then((next) => {
        if (!cancelled) setInterfaces(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [enabled])
  return interfaces
}

/**
 * A section's row container.
 *
 * A group CARD divides its ITEMS (View.tsx), but a whole section is one item, so
 * the rows inside it need the same hairline to read as the card's rows rather
 * than as one block. Same shell as `PiConfigPanes`' `PaneShell`.
 */
function Rows({
  testid,
  children
}: {
  testid: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-testid={testid} className="divide-y divide-border/55">
      {children}
    </div>
  )
}

/** `section` discriminates the three that can be loading at once (ADR-027). */
function LoadingRow({ section }: { section: string }): React.JSX.Element {
  return <SettingRow testid={`${R}.loading`} dataId={section} description="Loading…" />
}

// ── 1. Server ────────────────────────────────────────────────────────

/**
 * The listener itself.
 *
 * Not the host anchor (ADR-054 decision 6): every row here is TRANSPORT
 * configuration — which port to listen on, which interface to bind, whether
 * `tailscale serve` runs — and none of it has a web-reachable writer,
 * deliberately. A remote client must never be able to take over the transport it
 * is talking through (the ADR-042 rule, generalised by the host anchor), so the
 * web client gets one explanatory row instead of a wall of refused controls.
 */
export function RemoteServerSection(): React.JSX.Element {
  const web = isWebClient()
  const { config, setConfig } = useRemoteServerConfig()
  const interfaces = useNetworkInterfaces(!web)
  const [portError, setPortError] = useState<string | null>(null)
  const [tlsPortError, setTlsPortError] = useState<string | null>(null)
  /** Actionable message from the last failed `detectTailscale()` probe. */
  const [tlsDetection, setTlsDetection] = useState<string | null>(null)
  /** True once detection passed and we're waiting for the confirm click. */
  const [confirmTls, setConfirmTls] = useState(false)
  const [busy, setBusy] = useState(false)

  const commitPort = useCallback(
    async (value: number | undefined): Promise<void> => {
      // An empty field is the RANDOM port (0), which is a legal value here.
      const next = value ?? 0
      if (!Number.isInteger(next) || (next !== 0 && (next < 1024 || next > 65535))) {
        setPortError('Port must be 0 (random) or between 1024 and 65535')
        return
      }
      setPortError(null)
      setConfig(await window.api.setRemoteConfig({ port: next }))
    },
    [setConfig]
  )

  /**
   * The pinned `tailscale serve` HTTPS port (ADR-042). Unlike the listen port, 0
   * is not a legal value — serve binds one concrete port and the pin exists so
   * the user's bookmark never moves. An empty field means "back to the 443
   * default" rather than an error, so the field can't be left in a broken state.
   */
  const commitTlsPort = useCallback(
    async (value: number | undefined): Promise<void> => {
      const next = value ?? 443
      if (!Number.isInteger(next) || next < 1 || next > 65535) {
        setTlsPortError('Tailscale HTTPS port must be between 1 and 65535')
        return
      }
      setTlsPortError(null)
      setConfig(await window.api.setRemoteConfig({ tlsHttpsPort: next }))
    },
    [setConfig]
  )

  const handleBindHostChange = useCallback(
    async (value: string): Promise<void> => {
      setConfig(await window.api.setRemoteConfig({ bindHost: value === '' ? null : value }))
    },
    [setConfig]
  )

  const handleAutostartToggle = useCallback(async (): Promise<void> => {
    if (!config) return
    setConfig(await window.api.setRemoteConfig({ autostart: !config.autostart }))
  }, [config, setConfig])

  /**
   * TLS mode is gated on a LIVE probe, not on optimism: `tailscale serve` on a
   * tailnet without HTTPS certificates either silently no-ops or blocks, so
   * enabling the toggle when detection is not `ok` would produce a server that
   * binds loopback and is reachable from nowhere. Detection failure therefore
   * leaves the toggle OFF and renders the actionable message instead.
   *
   * A passing probe still needs one confirm — the Confirm button, or a second
   * press of the toggle — because turning this on mutates machine state that
   * outlives the app.
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
  }, [config, confirmTls, setConfig])

  if (web) {
    return (
      <Rows testid="RemoteServerSection">
        <SettingRow
          testid={`${R}.hostOnlyNote`}
          dimmed
          description="Port, network interface and Tailscale HTTPS are set on the machine itself — the desktop app, or the server’s own configuration on a headless install."
        />
      </Rows>
    )
  }

  if (!config) {
    return (
      <Rows testid="RemoteServerSection">
        <LoadingRow section="server" />
      </Rows>
    )
  }

  const bindHostKnown =
    config.bindHost == null || interfaces.some((iface) => iface.address === config.bindHost)
  const tlsEnabled = config.tlsMode === 1

  return (
    <Rows testid="RemoteServerSection">
      <SettingRow
        testid={`${R}.portRow`}
        label="Port"
        description="Leave it empty for a random port on every start."
        error={portError ?? undefined}
        errorTestid={`${R}.portError`}
      >
        <NumberField
          testid={`${R}.port`}
          value={config.port === 0 ? undefined : config.port}
          placeholder="Random"
          onChange={(v) => void commitPort(v)}
        />
      </SettingRow>

      <SettingRow
        testid={`${R}.bindHostRow`}
        label="Bind interface"
        dimmed={tlsEnabled}
        description={
          tlsEnabled
            ? 'TLS mode binds 127.0.0.1 — reached via your tailnet name.'
            : 'Which address the server listens on; all interfaces means the whole LAN can reach it.'
        }
      >
        <SelectField
          testid={`${R}.bindHost`}
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
        />
      </SettingRow>

      <SettingsToggle
        testid={`${R}.autostart`}
        label="Start remote access on launch"
        description="Starts the server with ClaudeUI instead of waiting for you to start it."
        checked={config.autostart}
        onChange={() => void handleAutostartToggle()}
      />

      <SettingsToggle
        testid={`${R}.tls`}
        label="Tailscale HTTPS (tailnet identity)"
        description="Serves over your tailnet name with a real certificate, and admits only Tailscale clients."
        checked={tlsEnabled}
        disabled={busy}
        onChange={() => void handleTlsToggle()}
        error={tlsDetection ?? undefined}
        errorTestid={`${R}.tlsDetection`}
      />

      {confirmTls && (
        <SettingRow
          testid={`${R}.tlsConfirm`}
          indent
          description="Configures `tailscale serve` on this machine — it persists until turned off — and restricts the server to Tailscale-only access."
        >
          <Button
            testid={`${R}.tlsConfirmApply`}
            variant="primary"
            disabled={busy}
            onClick={() => void handleTlsToggle()}
          >
            Confirm
          </Button>
        </SettingRow>
      )}

      {/* Pinned HTTPS port (ADR-042) — only meaningful while TLS mode is on. */}
      <SettingRow
        testid={`${R}.tlsHttpsPortRow`}
        label="HTTPS port (Tailscale)"
        indent
        dimmed={!tlsEnabled}
        description="The only port used — no fallback: 443 gives a bare https://<your-node>.ts.net URL, and 443, 8443 and 10000 are the ports Tailscale Funnel would accept."
        error={tlsPortError ?? undefined}
        errorTestid={`${R}.tlsHttpsPortError`}
      >
        <NumberField
          testid={`${R}.tlsHttpsPort`}
          value={config.tlsHttpsPort}
          placeholder="443"
          disabled={!tlsEnabled}
          onChange={(v) => void commitTlsPort(v)}
        />
      </SettingRow>
    </Rows>
  )
}

// ── 2. Remote access ─────────────────────────────────────────────────

/**
 * What a signed-in remote client may reach on this machine.
 *
 * Host-anchor only, like the transport rows: the IDE's CLI path is a value this
 * host later SPAWNS, so a remotely writable one would be remote code execution
 * by config write.
 */
export function RemoteAccessSection(): React.JSX.Element {
  const { config, setConfig } = useRemoteServerConfig()
  /**
   * ADR-064 — the VS Code CLI override, edited locally, committed on blur/Enter.
   *
   * `null` = not being edited, so the STORED value is the truth (the
   * `NumberField` draft pattern). A committed write clears the draft and the
   * field follows the config; a REFUSED write keeps it, so the value the
   * operator has to fix is still on screen.
   */
  const [ideCliPathDraft, setIdeCliPathDraft] = useState<string | null>(null)
  const [ideCliPathError, setIdeCliPathError] = useState<string | null>(null)
  /** The last `ide:availability` answer, whose `probe` is the status line. */
  const [ideProbe, setIdeProbe] = useState<IdeAvailability | null>(null)
  const [ideProbing, setIdeProbing] = useState(false)

  const ideCliPathInput = ideCliPathDraft ?? config?.ideCliPath ?? ''

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
  }, [config, setConfig])

  /**
   * Re-ask `ide:availability` for its typed CLI probe (ADR-064 §5).
   *
   * The desktop asks this for real rather than pinning a constant the way the
   * terminal does: whether a usable VS Code CLI exists is a fact about the
   * MACHINE, not about the transport, and this section is the surface that
   * renders it. The service caches the probe, so the cost is one
   * `serve-web --help` exec per override change rather than per call.
   *
   * Never throws: an instance with remote access disabled has no IDE service and
   * the channel refuses outright, which is simply "no status line" here.
   */
  const runIdeProbe = useCallback(async (): Promise<void> => {
    setIdeProbing(true)
    try {
      setIdeProbe(await window.api.ideAvailability())
    } catch {
      setIdeProbe(null)
    } finally {
      setIdeProbing(false)
    }
  }, [])

  /**
   * Probe on mount when the toggle is already on, and on every toggle-on. Keyed
   * on the BOOLEAN rather than on `config`, so an unrelated config write (a port
   * commit, a policy change) does not re-exec the CLI. Toggle-off clears the
   * line rather than leaving a stale "Using …" under a switch that is now off.
   */
  const allowIde = config?.allowIde ?? false
  useEffect(() => {
    if (allowIde) {
      void runIdeProbe()
    } else {
      setIdeProbe(null)
    }
  }, [allowIde, runIdeProbe])

  /**
   * The remote-IDE master switch (ADR-064). Same reasoning as the terminal
   * toggle above and the same storage: `remote_config`, written only through the
   * host-anchored `remote:set-config`. It gates its OWN capability (`ide`) — the
   * ceremony arms it only while this is on — and turning it off revokes in place:
   * grants stripped, cookie sessions cleared, live sockets destroyed, the
   * `serve-web` child killed.
   */
  const handleIdeToggle = useCallback(async (): Promise<void> => {
    if (!config) return
    setConfig(await window.api.setRemoteConfig({ allowIde: !config.allowIde }))
  }, [config, setConfig])

  /**
   * Commit the CLI override.
   *
   * Empty commits `null` EXPLICITLY (clear ⇒ auto-detect) rather than an empty
   * string the host would have to normalize. A non-absolute path makes the whole
   * write throw at the host anchor — the host EXECUTES this value, so a relative
   * one would resolve against whatever cwd the host process happens to hold —
   * and that refusal is rendered inline under the field, where the operator can
   * fix the character they got wrong, rather than as a toast that outlives the
   * field it is about.
   *
   * The no-change guard is what makes "blur AND Enter" one write instead of two:
   * pressing Enter commits, and the blur that follows finds nothing to do.
   */
  const commitIdeCliPath = useCallback(async (): Promise<void> => {
    if (!config) return
    const trimmed = ideCliPathInput.trim()
    if (trimmed === (config.ideCliPath ?? '')) {
      setIdeCliPathError(null)
      return
    }
    try {
      const updated = await window.api.setRemoteConfig({
        ideCliPath: trimmed === '' ? null : trimmed
      })
      setIdeCliPathError(null)
      setConfig(updated)
      setIdeCliPathDraft(null)
      // The probe is cached per override, so a fresh path is a fresh answer —
      // and the answer is the whole reason the operator typed one.
      void runIdeProbe()
    } catch (err) {
      setIdeCliPathError(err instanceof Error ? err.message : String(err))
    }
  }, [config, ideCliPathInput, runIdeProbe, setConfig])

  if (isWebClient()) {
    return (
      <Rows testid="RemoteAccessSection">
        <SettingRow
          testid={`${R}.accessHostOnlyNote`}
          dimmed
          description="The remote-terminal and VS Code switches are set on the machine itself — the desktop app, or the server’s own configuration on a headless install."
        />
      </Rows>
    )
  }

  if (!config) {
    return (
      <Rows testid="RemoteAccessSection">
        <LoadingRow section="access" />
      </Rows>
    )
  }

  /**
   * The one-line CLI-detection status, or null when there is nothing to say
   * (never probed, or the channel refused). Derived here rather than inline so
   * the discriminated `IdeCliProbe` is narrowed ONCE — "install VS Code" and
   * "the path you configured is not a VS Code CLI" are different instructions to
   * a human, and the union exists to keep them apart.
   */
  const ideProbeLine: { text: string; detail?: string } | null = ideProbing
    ? { text: 'Checking…' }
    : !ideProbe
      ? null
      : ideProbe.probe.ok
        ? { text: `Using ${ideProbe.probe.cliPath}` }
        : {
            text:
              ideProbe.probe.reason === 'cli-not-found'
                ? 'No VS Code CLI found on this machine — install VS Code or set a path below.'
                : 'That path did not answer as a VS Code CLI.',
            ...(ideProbe.probe.detail ? { detail: ideProbe.probe.detail } : {})
          }

  return (
    <Rows testid="RemoteAccessSection">
      {/* Say plainly what this exposes — it is a raw shell, not a sandbox. */}
      <SettingsToggle
        testid={`${R}.allowTerminal`}
        label="Allow remote terminal"
        description="Lets a signed-in remote client open a real shell on this machine, running as you, with no per-command approval — each client re-enters the remote password to unlock it, access ends after the terminal re-check window in Session security, and you can watch any remote shell live from this app."
        checked={config.allowTerminal}
        onChange={() => void handleTerminalToggle()}
      />

      {/* Remote VS Code (ADR-064) — deliberately its own toggle beside the
          terminal's rather than a rider on it: the IDE is shell-equivalent
          (editor AND integrated terminal) but it is a separate decision, and
          each toggle gates its own capability. */}
      <SettingsToggle
        testid={`${R}.allowIde`}
        label="Allow VS Code on the web"
        description="Serves this machine’s own VS Code to a signed-in remote client, on the Tailscale HTTPS address (or on this machine itself) — never over the Cloudflare tunnel or plain LAN."
        checked={config.allowIde}
        onChange={() => void handleIdeToggle()}
      />

      {/* The license sentence is not boilerplate — flipping that switch IS the
          acceptance act (ADR-064 §1), so the terms have to be one click away
          from the switch itself. Its own row because a real <a> may not be
          nested inside the toggle's <button>. */}
      <SettingRow testid={`${R}.allowIdeNote`} layout="stacked" indent>
        <span className="block text-[12px] leading-4 text-text-secondary">
          A full editor with an integrated terminal, running as you, with no per-command approval
          and reaching any file you can — each client must re-enter the remote password to unlock
          it, and enabling runs Microsoft’s VS Code Server under the{' '}
          <a
            data-testid={`${R}.ideLicense`}
            href="https://aka.ms/vscode-server-license"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            VS Code Server license terms
          </a>
          .
        </span>
      </SettingRow>

      {ideProbeLine && (
        <SettingRow testid={`${R}.ideProbe`} indent description={ideProbeLine.text} />
      )}
      {ideProbeLine?.detail && (
        <SettingRow
          testid={`${R}.ideProbeDetail`}
          indent
          dimmed
          description={ideProbeLine.detail}
        />
      )}

      {/* The CLI override. In `remote_config` with the toggle, NOT in
          settings.json: `config:save-settings` is remotely reachable, and a
          remotely writable path this host later SPAWNS is remote code execution
          by config write. */}
      <SettingRow
        testid={`${R}.ideCliPathRow`}
        layout="stacked"
        indent
        label="VS Code CLI path"
        description="Absolute path to the VS Code CLI (code-tunnel.exe on Windows, the standalone code CLI elsewhere); leave it empty to detect it."
        error={ideCliPathError ?? undefined}
        errorTestid={`${R}.ideCliPathError`}
      >
        <TextField
          testid={`${R}.ideCliPath`}
          value={ideCliPathInput}
          placeholder="Auto-detect"
          onChange={setIdeCliPathDraft}
          onBlur={() => void commitIdeCliPath()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitIdeCliPath()
          }}
        />
      </SettingRow>
    </Rows>
  )
}

// ── 3. Security ──────────────────────────────────────────────────────

/**
 * Who may sign in: the enrolment offer, the break-glass credential, the settings
 * editor and the passkey list.
 *
 * `EnrollCard` renders ABOVE the config gate on purpose. It needs no config, it
 * is the one thing on this page a phone operator came here to DO, and its offer
 * is alive only while this connection is a password one on an origin that can
 * bind a credential.
 */
export function RemoteSecuritySection(): React.JSX.Element {
  const { config, setConfig, reload } = useRemoteServerConfig()
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * The web client's enrolment bridge while a passkey is worth offering on THIS
   * connection, else null. Null on the desktop by construction — see
   * `enroll-flow.ts`.
   */
  const enrollBridge = useEnrollOffer()

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

  const web = isWebClient()

  return (
    <Rows testid="RemoteSecuritySection">
      {enrollBridge && <EnrollCard bridge={enrollBridge} />}

      {config === null ? (
        <LoadingRow section="security" />
      ) : (
        <>
          {/* CLEARING the break-glass credential lives here, and only here: it
              is host-anchor only (`remote:clear-password` has no remote
              registration at all), so removing the last way back in over the
              network is not something the editor below — which a phone can open
              — is allowed to offer. SETTING / rotating it IS one of the six
              facts that editor reviews and changes together. */}
          {config.passwordSet && !web && (
            <SettingRow
              testid={`${R}.clearPasswordRow`}
              label="Break-glass password"
              description="Removes the password entirely; change it in Session security below."
            >
              <Button
                testid={`${R}.clearPassword`}
                variant="danger"
                disabled={busy}
                onClick={() => void handleClearPassword()}
              >
                {confirmClear ? 'Confirm clear?' : 'Clear password'}
              </Button>
            </SettingRow>
          )}

          {/* ADR-054's SECOND axis: how fresh a presence proof has to stay AFTER
              sign-in, together with the rest of the auth surface, in one bounded
              editing mode. */}
          <SessionSecuritySettings config={config} onConfigChange={setConfig} />

          {/* Passkeys (ADR-052). Its own component: this block owns credential
              state that changes without any local action (a phone enrolling
              lands here), which the pure-config rows above never do. */}
          <RemotePasskeySettings config={config} onReload={reload} />
        </>
      )}
    </Rows>
  )
}

// ── 4. Links ─────────────────────────────────────────────────────────

/**
 * Through which channel a device reaches this machine.
 *
 * BELOW the credential rows deliberately: those answer "who may sign in", this
 * answers "through which channel", and the second question only becomes
 * interesting once the first is settled. `AccessLinks`' own locked-state copy
 * ("Unlock in Session security above") depends on that order.
 */
export function RemoteLinksSection(): React.JSX.Element {
  if (!isWebClient()) {
    return (
      <Rows testid="RemoteLinksSection">
        <SettingRow
          testid={`${R}.linksHostOnlyNote`}
          dimmed
          description="Access links, the connected-device list and the tunnel live in this app’s Remote Access window."
        />
      </Rows>
    )
  }

  return (
    <Rows testid="RemoteLinksSection">
      {/* What the desktop reads off `remote:status` and shows in the sidebar
          pill + Remote Access modal, both of which are desktop-only. The web
          client gets the same facts through the REDACTED `remote:status-view`
          (owner ruling, 2026-08-28) — no link fields, and no controls. */}
      <RemoteStatusCard />
      {/* ADR-056 item C: the phone can reveal, QR and ROTATE the LAN link
          without walking back to the desktop. */}
      <Suspense fallback={null}>
        <WebAccessLinks />
      </Suspense>
    </Rows>
  )
}

// ── The legacy single-item mount ─────────────────────────────────────

/**
 * All four sections in one item, in page order.
 *
 * Kept so the pre-ADR-065 mount (`settings-sections.tsx`'s `remoteServerConfig`
 * item) keeps working, and so the whole pane stays renderable in one test. The
 * page wires the four sections as four groups; this is not where they are
 * composed for real.
 */
export function RemoteServerSettings(): React.JSX.Element {
  return (
    <div data-testid="RemoteServerSettings" data-transport={isWebClient() ? 'web' : 'host'}>
      <RemoteServerSection />
      <RemoteAccessSection />
      <RemoteSecuritySection />
      <RemoteLinksSection />
    </div>
  )
}
