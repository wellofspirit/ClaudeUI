/**
 * PiVendors — Settings › pi › Vendor. Lean, hand-rolled (NOT a reuse of
 * VendorOpencodeSection — investigated and rejected: that component is
 * tightly coupled to opencode's provider CATALOG endpoint
 * (getOpencodeProviders), its per-provider model-ALLOWLIST dialog
 * (getOpencodeProviderModels/ModelAllowlistDialog), and OpencodeConfigSettings
 * (disabledProviders/per-provider modelAllowlist). pi instead uses one
 * authenticated catalog and a global ClaudeUI-private allowlist under Models.
 *
 * ClaudeUI-managed shared providers are intentionally hidden from these native
 * controls so their route policy cannot be bypassed. Existing external pi
 * credentials remain editable here. ChatGPT links to its Common-settings owner;
 * other interactive subscriptions still use pi's terminal `/login` flow.
 */
import { useEffect, useRef, useState } from 'react'
import type { VendorAuthMap, VendorAuthOption } from '../../../../shared/types'
import { SelectMenu } from '../shared/SelectMenu'

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
    <div
      data-testid="PiVendors.subscriptionHint"
      className="border border-border/30 rounded-md p-2.5 space-y-1.5"
    >
      <div className="text-[11px] text-text-muted uppercase tracking-wide">
        Other subscriptions (Claude Pro/Max, GitHub Copilot, xAI, Radius…)
      </div>
      <div className="text-[11px] text-text-secondary leading-relaxed">
        pi&rsquo;s OAuth login is interactive and runs in a terminal, not inside ClaudeUI — run{' '}
        <code className="text-[10px]">/login</code> in a terminal to connect a subscription (Claude
        Pro/Max, GitHub Copilot, xAI, Radius…). ChatGPT connects from Common settings instead.
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

// ── Shared ChatGPT entry point ──────────────────────────────────────────

function SharedChatgptLink(): React.JSX.Element {
  return (
    <div
      data-testid="PiVendors.sharedChatgpt"
      className="border border-border/30 rounded-md p-2.5 text-[11px] space-y-1"
    >
      <div className="text-text-muted uppercase tracking-wide">ChatGPT (Codex)</div>
      <div>ChatGPT is configured once and can be shared with pi and opencode.</div>
      <button
        data-testid="PiVendors.openSharedProviders"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent('open-settings', {
              detail: { scope: 'common', section: 'shared-providers' }
            })
          )
        }
        className="text-accent"
      >
        Open Providers & models
      </button>
    </div>
  )
}

// ── PiVendors ─────────────────────────────────────────────────────────

export function PiVendors(): React.JSX.Element {
  const installed = usePiInstalled()
  const [probeMap, setProbeMap] = useState<VendorAuthMap | null>(null)
  const [options, setOptions] = useState<Record<string, VendorAuthOption[]> | null>(null)
  const [managedPiIds, setManagedPiIds] = useState<Set<string>>(new Set([CODEX_VENDOR_ID]))
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
      window.api.vendorAuthListOptions('pi').catch((): Record<string, VendorAuthOption[]> => ({})),
      window.api.listSharedProviders().catch(() => [])
    ]).then(([probe, opts, sharedProviders]) => {
      if (!mountedRef.current) return
      setProbeMap(probe)
      setOptions(opts)
      setManagedPiIds(
        new Set(
          [
            CODEX_VENDOR_ID,
            ...sharedProviders.map((provider) => provider.routes.pi.providerId ?? provider.id)
          ]
        )
      )
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
      <div
        data-testid="PiVendors"
        className="px-3 py-1.5 text-[11px] text-text-muted/60 leading-relaxed"
      >
        pi is not installed. Install it to add providers and authenticate them.
      </div>
    )
  }

  const configuredIds = Object.keys(probeMap)
    .filter((id) => !managedPiIds.has(id))
    .sort()
  // Providers offering an api-key option that are NOT yet configured — the
  // add-key select's candidate list.
  const addableIds = Object.keys(options)
    .filter(
      (id) =>
        !managedPiIds.has(id) &&
        !probeMap[id] &&
        (options[id] ?? []).some((o) => o.type === 'api')
    )
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
        <div className="text-[11px] text-text-muted uppercase tracking-wide">
          Configured providers
        </div>
        {configuredIds.length === 0 && (
          <div className="text-[10px] text-text-muted/60 leading-relaxed">
            No providers configured yet. Add an API key below, or connect a subscription via the
            hint below.
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
          <SelectMenu
            testid="PiVendors.addVendorSelect"
            value={addVendorId}
            onChange={setAddVendorId}
            options={[
              { value: '', label: 'Select a provider…' },
              ...addableIds.map((id) => ({ value: id, label: id }))
            ]}
            triggerClassName="px-2 py-1 text-[11px] rounded bg-bg-input border border-border/40 text-text-primary focus:outline-none focus:border-accent/60"
          />
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

      <SharedChatgptLink />
      <SubscriptionHint />
    </div>
  )
}
