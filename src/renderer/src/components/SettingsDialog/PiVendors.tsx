/**
 * PiVendors — Settings › pi › Vendor. Lean, hand-rolled (NOT a reuse of
 * VendorOpencodeSection — investigated and rejected: that component is
 * tightly coupled to opencode's provider CATALOG endpoint
 * (getOpencodeProviders), its per-provider model-ALLOWLIST dialog
 * (getOpencodeProviderModels/ModelAllowlistDialog), and OpencodeConfigSettings
 * (disabledProviders/modelAllowlist) — none of which exist for pi. pi has no
 * catalog IPC and no model-allowlist concept.
 *
 * Mirrors the opencode section's *structure* only: list configured vendors
 * (from probe()), an add-API-key flow, a remove action, plus a subscription
 * block for pi's OAuth-only vendors.
 *
 * M6c: ONE subscription vendor — `openai-codex` (ChatGPT) — is now driven
 * in-app (`CodexConnect` below), via the SAME `authorizeVendorOAuth('pi', …)`
 * store action opencode's OAuth vendors use, backed by ClaudeUI's own auth
 * vault (M6a AuthVault + M6b CredentialSync; PiAuthProvider.oauthAuthorize/
 * oauthCallback/cancelVendorOauth delegate to it for this one vendor only).
 * pi's OTHER subscription vendors (anthropic, github-copilot, xai, radius)
 * remain undriven — PiAuthProvider's oauthAuthorize/oauthCallback throw for
 * any vendorId other than 'openai-codex' — so `SubscriptionHint` below still
 * shows the run-`pi /login`-in-a-terminal hint for those.
 */
import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSessionStore } from '../../stores/session-store'
import type { PiAuthStatus, VendorAuthMap, VendorAuthOption } from '../../../../shared/types'

/** pi's auth.json key for the Codex (ChatGPT) credential — CredentialSync.PI_CODEX_VENDOR_ID. */
const CODEX_VENDOR_ID = 'openai-codex'

// ── usePiInstalled ────────────────────────────────────────────────────
// Duplicated locally rather than imported from settings-sections.tsx —
// mirrors OpencodeAgents.tsx's identical precedent (avoids a circular import
// between the section-definition file and the giant sections registry file).

function usePiInstalled(): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api
      .engineIsInstalled('pi')
      .then((v) => {
        if (!cancelled) setInstalled(v)
      })
      .catch(() => {
        if (!cancelled) setInstalled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])
  return installed
}

// ── Subscription hint block ──────────────────────────────────────────

function SubscriptionHint(): React.JSX.Element {
  const [binaryPath, setBinaryPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    window.api
      .getPiBinaryPath()
      .then(setBinaryPath)
      .catch(() => setBinaryPath(null))
  }, [])

  const command = binaryPath ? `"${binaryPath}"` : null

  const handleCopy = async (): Promise<void> => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <div data-testid="PiVendors.subscriptionHint" className="border border-border/30 rounded-md p-2.5 space-y-1.5">
      <div className="text-[11px] text-text-muted uppercase tracking-wide">Other subscriptions (Claude Pro/Max, GitHub Copilot, xAI, Radius…)</div>
      <div className="text-[11px] text-text-secondary leading-relaxed">
        pi&rsquo;s OAuth login is interactive and runs in a terminal, not inside ClaudeUI — run{' '}
        <code className="text-[10px]">/login</code> in a terminal to connect a subscription (Claude
        Pro/Max, GitHub Copilot, xAI, Radius…). ChatGPT connects in-app above instead.
      </div>
      {command && (
        <div className="flex items-center gap-1.5">
          <code
            data-testid="PiVendors.subscriptionCommand"
            className="flex-1 min-w-0 truncate px-2 py-1 text-[11px] font-mono bg-bg-input border border-border/40 rounded text-text-primary select-all"
          >
            {command}
          </code>
          <button
            data-testid="PiVendors.copyCommand"
            onClick={() => void handleCopy()}
            className="shrink-0 px-2 py-1 text-[11px] rounded bg-accent/15 hover:bg-accent/25 text-accent transition-colors"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Connect ChatGPT (M6c) ───────────────────────────────────────────────
// Real in-app OAuth for `openai-codex` ONLY, sharing opencode's driven-OAuth
// path (`authorizeVendorOAuth` store action → window.api.vendorAuthOauth-
// Authorize/Callback, PiAuthProvider delegates to the M6a/M6b auth vault for
// this one vendor). Status comes from the read-only `getPiAuthStatus` IPC
// (CredentialSync.getStatus()) — NOT from vendorAuthProbe('pi'), which only
// reflects pi's own auth.json and would otherwise race the vault's feed-forward
// write.

function CodexConnect(): React.JSX.Element {
  const [status, setStatus] = useState<PiAuthStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const mountedRef = useRef(true)
  const { vendorOAuth, authorizeVendorOAuth, cancelVendorOAuth } = useSessionStore(
    useShallow((s) => ({
      vendorOAuth: s.vendorOAuth,
      authorizeVendorOAuth: s.authorizeVendorOAuth,
      cancelVendorOAuth: s.cancelVendorOAuth
    }))
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const reloadStatus = (): void => {
    window.api
      .getPiAuthStatus()
      .then((s) => {
        if (mountedRef.current) setStatus(s)
      })
      .catch(() => {
        if (mountedRef.current) setStatus({ connected: false, needsReauth: false })
      })
  }

  useEffect(() => {
    reloadStatus()
  }, [])

  const isPiCodexFlow = vendorOAuth?.engineId === 'pi' && vendorOAuth?.vendorId === CODEX_VENDOR_ID
  const isConnecting = isPiCodexFlow && vendorOAuth?.stage === 'waiting'
  const hasFlowError = isPiCodexFlow && vendorOAuth?.stage === 'error'

  const handleConnect = async (): Promise<void> => {
    setError(null)
    try {
      const result = await authorizeVendorOAuth('pi', CODEX_VENDOR_ID)
      if (result.ok) reloadStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start the ChatGPT connect flow')
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    setDisconnecting(true)
    setError(null)
    try {
      await window.api.vendorAuthRemove('pi', CODEX_VENDOR_ID)
      reloadStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect ChatGPT')
    } finally {
      if (mountedRef.current) setDisconnecting(false)
    }
  }

  return (
    <div data-testid="PiVendors.codexConnect" className="border border-border/30 rounded-md p-2.5 space-y-1.5">
      <div className="text-[11px] text-text-muted uppercase tracking-wide">ChatGPT (Codex)</div>
      {error && <div className="text-[11px] text-red-400 leading-relaxed">{error}</div>}

      {status === null ? (
        <div className="text-[10px] text-text-muted/60">Loading…</div>
      ) : (
        <>
          {status.connected && (
            <div data-testid="PiVendors.codexConnected" className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-text-secondary truncate">
                Connected as{' '}
                <span className="font-medium text-text-primary">
                  {status.email ?? status.accountId ?? 'ChatGPT'}
                </span>
              </span>
              <button
                data-testid="PiVendors.disconnectCodex"
                onClick={() => void handleDisconnect()}
                disabled={disconnecting}
                className="shrink-0 px-2 py-1 text-[11px] rounded hover:bg-bg-hover text-text-muted/70 hover:text-red-400 transition-colors disabled:opacity-40"
              >
                {disconnecting ? '…' : 'Disconnect'}
              </button>
            </div>
          )}

          {status.needsReauth && (
            <div
              data-testid="PiVendors.codexNeedsReauth"
              className="flex items-center justify-between gap-2 text-[11px] text-amber-400 leading-relaxed"
            >
              <span>Session expired — reconnect to keep using ChatGPT.</span>
              <button
                data-testid="PiVendors.connectCodex"
                onClick={() => void handleConnect()}
                disabled={isConnecting}
                className="shrink-0 px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 transition-colors"
              >
                {isConnecting ? 'Connecting…' : 'Reconnect'}
              </button>
            </div>
          )}

          {!status.connected && !status.needsReauth && (
            <>
              <div className="text-[11px] text-text-secondary leading-relaxed">
                Managed and refreshed by ClaudeUI — the same connection opencode uses.
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  data-testid="PiVendors.connectCodex"
                  onClick={() => void handleConnect()}
                  disabled={isConnecting}
                  className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 transition-colors"
                >
                  {isConnecting ? 'Connecting…' : 'Connect ChatGPT (log in once — shared with opencode)'}
                </button>
                {isConnecting && (
                  <button
                    onClick={cancelVendorOAuth}
                    className="shrink-0 px-2 py-1 text-[11px] rounded hover:bg-bg-hover text-text-muted/70 transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>
              {hasFlowError && <div className="text-[11px] text-red-400">Connect failed — try again.</div>}
            </>
          )}
        </>
      )}
    </div>
  )
}

// ── PiVendors ─────────────────────────────────────────────────────────

export function PiVendors(): React.JSX.Element {
  const installed = usePiInstalled()
  const [probeMap, setProbeMap] = useState<VendorAuthMap | null>(null)
  const [options, setOptions] = useState<Record<string, VendorAuthOption[]> | null>(null)
  const [addVendorId, setAddVendorId] = useState('')
  const [addKey, setAddKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const reload = (): void => {
    Promise.all([
      window.api.vendorAuthProbe('pi').catch((): VendorAuthMap => ({})),
      window.api.vendorAuthListOptions('pi').catch((): Record<string, VendorAuthOption[]> => ({}))
    ]).then(([probe, opts]) => {
      if (!mountedRef.current) return
      setProbeMap(probe)
      setOptions(opts)
    })
  }

  useEffect(() => {
    reload()
  }, [])

  if (installed === null || probeMap === null || options === null) {
    return (
      <div data-testid="PiVendors" className="px-3 py-1.5 text-[11px] text-text-muted/60">
        Loading…
      </div>
    )
  }
  if (!installed) {
    return (
      <div data-testid="PiVendors" className="px-3 py-1.5 text-[11px] text-text-muted/60 leading-relaxed">
        pi is not installed. Install it to add providers and authenticate them.
      </div>
    )
  }

  // openai-codex is excluded here — it gets its own dedicated CodexConnect
  // block below (driven by getPiAuthStatus, not this generic auth.json probe
  // row), so it never shows twice with two different disconnect affordances.
  const configuredIds = Object.keys(probeMap)
    .filter((id) => id !== CODEX_VENDOR_ID)
    .sort()
  // Providers offering an api-key option that are NOT yet configured — the
  // add-key select's candidate list.
  const addableIds = Object.keys(options)
    .filter((id) => !probeMap[id] && (options[id] ?? []).some((o) => o.type === 'api'))
    .sort()

  const handleAddKey = async (): Promise<void> => {
    const vendorId = addVendorId
    const key = addKey.trim()
    if (!vendorId || !key) return
    setSaving(true)
    setError(null)
    try {
      await window.api.vendorAuthSetKey('pi', vendorId, key)
      setAddVendorId('')
      setAddKey('')
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to save key for ${vendorId}`)
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  const handleRemove = async (vendorId: string): Promise<void> => {
    setRemoving((prev) => ({ ...prev, [vendorId]: true }))
    try {
      await window.api.vendorAuthRemove('pi', vendorId)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to remove ${vendorId}`)
    } finally {
      if (mountedRef.current) setRemoving((prev) => ({ ...prev, [vendorId]: false }))
    }
  }

  return (
    <div data-testid="PiVendors" className="px-3 py-1.5 space-y-3 text-[13px] text-text-secondary">
      {error && <div className="text-[11px] text-red-400 leading-relaxed">{error}</div>}

      <div className="space-y-1.5">
        <div className="text-[11px] text-text-muted uppercase tracking-wide">Configured providers</div>
        {configuredIds.length === 0 && (
          <div className="text-[10px] text-text-muted/60 leading-relaxed">
            No providers configured yet. Add an API key below, or connect a subscription via the hint below.
          </div>
        )}
        {configuredIds.map((vendorId) => {
          const status = probeMap[vendorId]
          return (
            <div
              key={vendorId}
              data-testid="PiVendors.row"
              data-id={vendorId}
              className="border border-border/30 rounded-md p-2 flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="font-medium text-[12px] truncate">{vendorId}</div>
                <div className="text-[10px] text-text-muted/60 truncate">
                  {status.label ?? status.billingType} · {status.authState}
                </div>
              </div>
              <button
                data-testid="PiVendors.remove"
                data-id={vendorId}
                onClick={() => void handleRemove(vendorId)}
                disabled={removing[vendorId]}
                className="shrink-0 px-2 py-1 text-[11px] rounded hover:bg-bg-hover text-text-muted/70 hover:text-red-400 transition-colors disabled:opacity-40"
              >
                {removing[vendorId] ? '…' : 'Remove'}
              </button>
            </div>
          )
        })}
      </div>

      <div className="space-y-1.5">
        <div className="text-[11px] text-text-muted uppercase tracking-wide">Add API key</div>
        <div className="flex items-center gap-1.5">
          <select
            data-testid="PiVendors.addVendorSelect"
            value={addVendorId}
            onChange={(e) => setAddVendorId(e.target.value)}
            className="px-2 py-1 text-[11px] rounded bg-bg-input border border-border/40 text-text-primary focus:outline-none focus:border-accent/60"
          >
            <option value="">Select a provider…</option>
            {addableIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <input
            data-testid="PiVendors.addKeyInput"
            type="password"
            placeholder="API key"
            value={addKey}
            onChange={(e) => setAddKey(e.target.value)}
            className="flex-1 min-w-0 px-2 py-1 text-[11px] rounded bg-bg-input border border-border/40 text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent/60"
          />
          <button
            data-testid="PiVendors.addKey"
            onClick={() => void handleAddKey()}
            disabled={saving || !addVendorId || !addKey.trim()}
            className="shrink-0 px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving…' : 'Add'}
          </button>
        </div>
      </div>

      <CodexConnect />
      <SubscriptionHint />
    </div>
  )
}
