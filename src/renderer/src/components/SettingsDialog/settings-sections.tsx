import { useState, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import type { AppSettings } from '../../stores/session-store'
import { PermissionsDialog } from '../PermissionsDialog'
import type {
  ClaudePermissions,
  ProxySettings,
  VoiceLanguageCode,
  AccountsState,
  EngineConfig,
  VendorConfig,
  SandboxSettings,
  VendorAuthMap,
  VendorAuthOption,
  AutoModeConfig,
  ModelInfo
} from '../../../../shared/types'
import { VOICE_LANGUAGES } from '../../../../shared/types'
import {
  supportedEffortLevels,
  defaultEffort,
  type EffortLevel,
  type AutonomyMode,
  CLAUDE_ENGINE_CAPABILITIES
} from '../../../../shared/model-capabilities'
import {
  SettingsToggle,
  SettingsSlider,
  SettingsSelect,
  SettingsTextarea,
  SandboxListSetting,
  ChatRetentionSetting,
  InfoTooltip
} from './settings-controls'

// ── Section definitions ──────────────────────────────────────────────

export interface SettingItem {
  key: string
  label: string
  keywords?: string // extra search terms
  render: (
    settings: AppSettings,
    update: (p: Partial<AppSettings>) => void,
    engineConfig: EngineConfig,
    updateEngineConfig: (p: Partial<EngineConfig>) => void,
    vendorConfig: VendorConfig,
    updateVendorConfig: (p: Partial<VendorConfig>) => void
  ) => React.JSX.Element
}

export interface Section {
  id: string
  label: string
  icon: React.JSX.Element
  items: SettingItem[]
}

// ── Default engine/vendor config values ─────────────────────────────

const DEFAULT_SANDBOX: SandboxSettings = {
  enabled: false,
  autoAllowBashIfSandboxed: false,
  allowUnsandboxedCommands: false,
  network: {
    restrictNetwork: false,
    allowLocalBinding: false,
    allowedDomains: [],
    allowManagedDomainsOnly: false,
    allowAllUnixSockets: false,
    allowUnixSockets: []
  },
  filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
  excludedCommands: []
}

const DEFAULT_PROXY: ProxySettings = {
  enabled: false,
  type: 'http',
  hostname: '',
  port: 8080,
  username: '',
  password: '',
  proxySubprocesses: false
}

// ── Proxy test connection button ─────────────────────────────────────

function ProxyTestButton({ proxy }: { proxy: ProxySettings }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [result, setResult] = useState<{ latencyMs?: number; error?: string } | null>(null)

  const handleTest = async (): Promise<void> => {
    setState('testing')
    setResult(null)
    try {
      const res = await window.api.testProxyConnection(proxy)
      if (res.ok) {
        setState('success')
        setResult({ latencyMs: res.latencyMs })
      } else {
        setState('error')
        setResult({ error: res.error, latencyMs: res.latencyMs })
      }
    } catch (err) {
      setState('error')
      setResult({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="px-3 py-1.5 text-[13px] text-text-secondary">
      <div className="flex items-center gap-2">
        <button
          onClick={handleTest}
          disabled={state === 'testing'}
          className="px-2.5 py-1 text-[11px] font-medium text-accent hover:text-accent-hover bg-accent/10 hover:bg-accent/15 rounded-md transition-colors cursor-default disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {state === 'testing' ? 'Testing...' : 'Test Connection'}
        </button>
        {state === 'success' && result && (
          <span className="text-[11px] text-success">Connected ({result.latencyMs}ms)</span>
        )}
        {state === 'error' && result && (
          <span className="text-[11px] text-danger truncate max-w-[300px]" title={result.error}>
            Failed: {result.error}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Global Permissions summary (rendered inside SettingsDialog) ──────

function GlobalPermissionsSummary(): React.JSX.Element {
  const [perms, setPerms] = useState<ClaudePermissions | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const cwd = useActiveSession((s) => s.cwd)

  useEffect(() => {
    window.api
      .loadClaudePermissions('user')
      .then(setPerms)
      .catch(() => {})
  }, [dialogOpen]) // reload after dialog closes

  const totalRules = perms ? perms.allow.length + perms.ask.length + perms.deny.length : 0

  return (
    <div className="px-3 py-1.5 text-[13px] text-text-secondary">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-text-secondary mb-0.5">Global permission rules</div>
          {perms && (
            <div className="text-[11px] text-text-muted">
              {perms.allow.length} allow · {perms.ask.length} ask · {perms.deny.length} deny
              {perms.additionalDirectories.length > 0 &&
                ` · ${perms.additionalDirectories.length} dir${perms.additionalDirectories.length !== 1 ? 's' : ''}`}
              {totalRules === 0 && 'No rules configured'}
            </div>
          )}
        </div>
        <button
          onClick={() => setDialogOpen(true)}
          className="px-2.5 py-1 text-[11px] font-medium text-accent hover:text-accent-hover bg-accent/10 hover:bg-accent/15 rounded-md transition-colors cursor-default"
        >
          Edit...
        </button>
      </div>
      <PermissionsDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        cwd={cwd}
        initialTab="user"
      />
    </div>
  )
}

// ── Per-model effort default config ──────────────────────────────────

const EFFORT_LEVEL_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

const EFFORT_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-fable-5', label: 'Fable 5' }
]

function ModelEffortRow({
  modelId,
  modelLabel,
  current,
  onChange
}: {
  modelId: string
  modelLabel: string
  current: EffortLevel | undefined
  onChange: (next: EffortLevel | undefined) => void
}): React.JSX.Element {
  const levels = supportedEffortLevels(modelId)
  const fallback = defaultEffort(modelId)
  return (
    <div className="pl-4 px-3 py-1.5 text-[13px] text-text-secondary">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span>{modelLabel}</span>
        <span className="text-[10px] text-text-muted/50">{modelId}</span>
      </div>
      <select
        value={current ?? ''}
        onChange={(e) => {
          const v = e.target.value
          onChange(v === '' ? undefined : (v as EffortLevel))
        }}
        className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors cursor-pointer"
      >
        <option value="">{`Default (${EFFORT_LEVEL_LABEL[fallback]})`}</option>
        {levels.map((lvl) => (
          <option key={lvl} value={lvl}>
            {EFFORT_LEVEL_LABEL[lvl]}
          </option>
        ))}
      </select>
    </div>
  )
}

// ── Accounts (multi-account support, ADR-015) ────────────────────────

function AccountsSetting(): React.JSX.Element {
  const accounts = useSessionStore((s) => s.accountsState)
  const setAccounts = useSessionStore((s) => s.setAccountsState)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.getAccounts().then(setAccounts)
  }, [setAccounts])

  const enabled = accounts?.enabled ?? false
  const isMac = window.api.platform === 'darwin'

  const run = async (fn: () => Promise<AccountsState>): Promise<void> => {
    setBusy(true)
    try {
      setAccounts(await fn())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-3 py-1.5 space-y-2.5">
      <SettingsToggle
        label="Enable multiple account support"
        checked={enabled}
        onChange={(v) => void run(() => window.api.setMultiAccountEnabled(v))}
        tooltip="Store credentials per-account in plaintext files instead of the macOS Keychain, so you can hold and switch between multiple Claude subscriptions."
      />

      {enabled && isMac && (
        <div className="text-[11px] leading-relaxed text-warning/90 bg-warning/10 border border-warning/30 rounded-md px-2.5 py-1.5">
          Multi-account mode uses file-based credentials, separate from your macOS Keychain login.
          You may need to <b>log in again</b> for each account.
        </div>
      )}

      {enabled && (
        <div className="space-y-1">
          {(accounts?.accounts ?? []).map((a) => {
            const active = a.id === accounts?.activeId
            return (
              <div
                key={a.id}
                className={`flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 ${
                  active ? 'border-accent/50 bg-accent/5' : 'border-border'
                }`}
              >
                <button
                  disabled={busy || active}
                  onClick={() => void run(() => window.api.switchAccount(a.id))}
                  title={active ? 'Active account' : 'Switch to this account'}
                  className="shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center disabled:cursor-default"
                  style={{
                    borderColor: active ? 'var(--color-accent)' : 'var(--color-border-bright)'
                  }}
                >
                  {active && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-text-primary truncate">
                    {a.email || 'Account'}
                  </div>
                  {a.subscriptionType && (
                    <div className="text-[10px] text-text-muted">{a.subscriptionType}</div>
                  )}
                </div>
                <button
                  disabled={busy}
                  onClick={() => void run(() => window.api.deleteAccount(a.id))}
                  title="Delete account"
                  className="shrink-0 text-text-muted hover:text-danger transition-colors disabled:opacity-50"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
                  </svg>
                </button>
              </div>
            )
          })}
          <button
            disabled={busy}
            onClick={() => void run(() => window.api.addAccount())}
            className="text-[12px] font-medium text-accent hover:text-accent-hover bg-accent/10 hover:bg-accent/15 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50"
          >
            + Add account
          </button>
        </div>
      )}
    </div>
  )
}

// ── Autonomy mode picker ─────────────────────────────────────────────

const AUTONOMY_TO_PERMISSION: Record<AutonomyMode, string> = {
  plan: 'plan',
  ask: 'default',
  autoEdit: 'acceptEdits',
  full: 'auto'
}

const PERMISSION_TO_AUTONOMY: Record<string, AutonomyMode> = {
  plan: 'plan',
  default: 'ask',
  acceptEdits: 'autoEdit',
  auto: 'full',
  localAuto: 'full'
}

const AUTONOMY_LABELS: Record<AutonomyMode, string> = {
  plan: 'Read-only (Plan)',
  ask: 'Ask (default)',
  autoEdit: 'Auto-edit files',
  full: 'Full auto'
}

function AutonomyModePicker(): React.JSX.Element {
  const [perms, setPerms] = useState<ClaudePermissions | null>(null)
  const availableModes = CLAUDE_ENGINE_CAPABILITIES.autonomyModes

  useEffect(() => {
    window.api
      .loadClaudePermissions('user')
      .then(setPerms)
      .catch(() => {})
  }, [])

  const currentMode: AutonomyMode = perms?.defaultMode
    ? (PERMISSION_TO_AUTONOMY[perms.defaultMode] ?? 'ask')
    : 'ask'

  const handleChange = async (mode: AutonomyMode): Promise<void> => {
    if (!perms) return
    const next: ClaudePermissions = { ...perms, defaultMode: AUTONOMY_TO_PERMISSION[mode] }
    setPerms(next)
    await window.api.saveClaudePermissions('user', next)
  }

  return (
    <div className="px-3 py-1.5 text-[13px] text-text-secondary">
      <div className="mb-1.5">Autonomy mode</div>
      <div className="space-y-1">
        {availableModes.map((mode) => (
          <label
            key={mode}
            className="flex items-center gap-2 cursor-pointer rounded-md px-2 py-1 hover:bg-bg-hover"
          >
            <input
              type="radio"
              name="autonomyMode"
              value={mode}
              checked={currentMode === mode}
              onChange={() => void handleChange(mode)}
              className="accent-accent"
            />
            <span className="text-[12px] text-text-secondary">{AUTONOMY_LABELS[mode]}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

// ── opencode auto-mode (Full) LLM gatekeeper settings (ADR-023) ──────

const TWO_STAGE_OPTIONS: { value: 'both' | 'fast' | 'thinking'; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'fast', label: 'Fast' },
  { value: 'thinking', label: 'Thinking' }
]

/**
 * Self-contained (loads/saves its own opencode EngineConfig via window.api —
 * SettingsDialog only wires the 'claude' engine config). Configures the auto-mode
 * LLM permission gatekeeper that runs in Full autonomy on opencode. See ADR-023.
 */
function OpencodeAutoModeSection(): React.JSX.Element {
  const [engineCfg, setEngineCfg] = useState<EngineConfig | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    window.api
      .loadEngineConfig('opencode')
      .then(setEngineCfg)
      .catch(() => setEngineCfg({}))
    window.api
      .getEngineModels()
      .then((groups) => {
        const oc = groups.filter((g) => g.engineId === 'opencode')
        setAvailable(oc.length > 0)
        setModels(oc.flatMap((g) => g.models))
      })
      .catch(() => {})
  }, [])

  if (engineCfg === null) {
    return <div className="px-3 py-1.5 text-[13px] text-text-muted">Loading…</div>
  }
  if (!available) {
    return (
      <div className="px-3 py-2 text-[12px] text-text-muted/70 leading-relaxed">
        opencode is not installed. Auto mode gates risky tool calls for opencode sessions in Full
        autonomy.
      </div>
    )
  }

  const auto = engineCfg.autoMode ?? {}
  const enabled = auto.enabled !== false // default ON
  const judgeModel = auto.judgeModel ?? ''
  const twoStageMode = auto.twoStageMode ?? 'both'

  const update = (patch: Partial<AutoModeConfig>): void => {
    const next: EngineConfig = { ...engineCfg, autoMode: { ...auto, ...patch } }
    setEngineCfg(next)
    window.api.saveEngineConfig('opencode', next).catch(() => {})
  }

  return (
    <div className="space-y-1">
      <SettingsToggle
        label="Auto mode (LLM gatekeeper)"
        checked={enabled}
        onChange={(v) => update({ enabled: v })}
        tooltip="In Full autonomy, an LLM judges each risky tool call (bash / web fetch) instead of prompting you; reads and edits are auto-allowed. Fails closed to a human prompt when unsure or unavailable. When off, Full prompts you like Ask mode. See ADR-023."
      />
      {enabled && (
        <>
          <div className="px-3 py-1.5 text-[13px] text-text-secondary">
            <div className="mb-1 flex items-center gap-1">
              Judge model
              <InfoTooltip text="The model that decides allow/block. Defaults to the session's own model. Pick a cheaper model to reduce cost, or a stronger one for safety-critical work." />
            </div>
            <select
              value={judgeModel}
              onChange={(e) => update({ judgeModel: e.target.value || undefined })}
              className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
            >
              <option value="">Same as session model (default)</option>
              {models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.displayName || m.value}
                </option>
              ))}
            </select>
          </div>
          <SettingsSelect
            label="Two-stage judging"
            value={twoStageMode}
            options={TWO_STAGE_OPTIONS}
            onChange={(v) => update({ twoStageMode: v })}
          />
          <div className="px-3 pb-1 text-[10px] text-text-muted/50 leading-relaxed">
            Applies to Full autonomy on opencode. The judge sees tool calls, not their output. No
            per-turn call cap (parity with Claude) — pick a cheaper judge model if cost matters.
          </div>
        </>
      )}
    </div>
  )
}

// ── Vendor Anthropic display (read-only) ─────────────────────────────

function VendorAnthropicDisplaySection(): React.JSX.Element {
  const [vendorCfg, setVendorCfg] = useState<VendorConfig | null>(null)

  useEffect(() => {
    window.api
      .loadVendorConfig('anthropic')
      .then(setVendorCfg)
      .catch(() => {})
  }, [])

  const endpoint = vendorCfg?.endpoint
  const modelOverride = vendorCfg?.modelOverride

  return (
    <div className="px-3 py-1.5 text-[13px] text-text-secondary space-y-2">
      <div>
        <div className="text-[11px] text-text-muted uppercase tracking-wide mb-1">Endpoint</div>
        {endpoint?.enabled ? (
          <div className="text-[12px] font-mono text-text-secondary truncate">
            {endpoint.baseUrl || '(none)'}
          </div>
        ) : (
          <div className="text-[11px] text-text-muted/60">Default Anthropic API</div>
        )}
      </div>
      <div>
        <div className="text-[11px] text-text-muted uppercase tracking-wide mb-1">Model override</div>
        {modelOverride?.enabled ? (
          <div className="text-[11px] text-text-muted space-y-0.5">
            {modelOverride.model && <div>Model: <span className="font-mono text-text-secondary">{modelOverride.model}</span></div>}
            {modelOverride.sonnetModel && <div>Sonnet: <span className="font-mono text-text-secondary">{modelOverride.sonnetModel}</span></div>}
            {modelOverride.opusModel && <div>Opus: <span className="font-mono text-text-secondary">{modelOverride.opusModel}</span></div>}
            {modelOverride.haikuModel && <div>Haiku: <span className="font-mono text-text-secondary">{modelOverride.haikuModel}</span></div>}
          </div>
        ) : (
          <div className="text-[11px] text-text-muted/60">No override</div>
        )}
      </div>
      <div className="text-[10px] text-text-muted/50 leading-relaxed">
        Edit these in engines/claude.json and vendors/anthropic.json under ~/.claude/ui/. Changes apply on next session start.
      </div>
    </div>
  )
}

// ── Vendor opencode auth UI ──────────────────────────────────────────

type VendorOAuthFlowState =
  | { stage: 'idle' }
  | { stage: 'instructions'; url: string; instructions: string; method: number; vendorId: string }
  | { stage: 'submitting'; vendorId: string }

function VendorOpencodeSection(): React.JSX.Element {
  const [authMap, setAuthMap] = useState<VendorAuthMap | null>(null)
  const [options, setOptions] = useState<Record<string, VendorAuthOption[]>>({})
  const [loading, setLoading] = useState(true)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [removing, setRemoving] = useState<Record<string, boolean>>({})
  const [oauthFlow, setOauthFlow] = useState<VendorOAuthFlowState>({ stage: 'idle' })
  const [oauthCode, setOauthCode] = useState('')
  const [oauthError, setOauthError] = useState<string | null>(null)
  // Track if opencode is installed (non-empty probe result)
  const [opencodeAvailable, setOpencodeAvailable] = useState(false)
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
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.vendorAuthProbe('opencode').catch(() => ({})) as Promise<VendorAuthMap>,
      window.api.vendorAuthListOptions('opencode').catch(() => ({})) as Promise<Record<string, VendorAuthOption[]>>
    ]).then(([map, opts]) => {
      if (cancelled) return
      const available = Object.keys(map).length > 0
      setOpencodeAvailable(available)
      setAuthMap(map)
      setOptions(opts)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const refresh = (): void => {
    Promise.all([
      window.api.vendorAuthProbe('opencode').catch(() => ({})) as Promise<VendorAuthMap>,
      window.api.vendorAuthListOptions('opencode').catch(() => ({})) as Promise<Record<string, VendorAuthOption[]>>
    ]).then(([map, opts]) => {
      if (!mountedRef.current) return
      setAuthMap(map)
      setOptions(opts)
    })
  }

  const handleSaveKey = async (vendorId: string): Promise<void> => {
    const key = (apiKeys[vendorId] ?? '').trim()
    if (!key) return
    setSaving((prev) => ({ ...prev, [vendorId]: true }))
    try {
      await window.api.vendorAuthSetKey('opencode', vendorId, key)
      setApiKeys((prev) => ({ ...prev, [vendorId]: '' }))
      refresh()
    } catch (err) {
      // silent failure — user can retry
    } finally {
      if (mountedRef.current) setSaving((prev) => ({ ...prev, [vendorId]: false }))
    }
  }

  const handleRemove = async (vendorId: string): Promise<void> => {
    setRemoving((prev) => ({ ...prev, [vendorId]: true }))
    try {
      await window.api.vendorAuthRemove('opencode', vendorId)
      refresh()
    } catch (err) {
      // silent failure
    } finally {
      if (mountedRef.current) setRemoving((prev) => ({ ...prev, [vendorId]: false }))
    }
  }

  const handleOAuthStart = async (
    vendorId: string,
    _methodIdx: number
  ): Promise<void> => {
    setOauthError(null)
    try {
      const result = await authorizeVendorOAuth('opencode', vendorId)
      if (result.ok) {
        // auto flow succeeded — refresh local auth state
        refresh()
      } else if (result.needsPaste) {
        // method:'code' — show paste-code input
        setOauthFlow({
          stage: 'instructions',
          url: result.needsPaste.url,
          instructions: result.needsPaste.instructions,
          method: result.needsPaste.method,
          vendorId
        })
      }
      // If !ok and !needsPaste: auto flow is in progress or failed (shown via vendorOAuth state)
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : 'Failed to start OAuth flow')
    }
  }

  const handleOAuthSubmit = async (): Promise<void> => {
    if (oauthFlow.stage !== 'instructions') return
    const { vendorId, method } = oauthFlow
    const code = oauthCode.trim()
    if (!code) return
    setOauthFlow({ stage: 'submitting', vendorId })
    try {
      await window.api.vendorAuthOauthCallback('opencode', vendorId, method, code)
      setOauthFlow({ stage: 'idle' })
      setOauthCode('')
      refresh()
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : 'OAuth callback failed')
      setOauthFlow({ stage: 'idle' })
    }
  }

  if (loading) {
    return (
      <div className="px-3 py-1.5 text-[11px] text-text-muted/60">Loading...</div>
    )
  }

  if (!opencodeAvailable) {
    return (
      <div className="px-3 py-1.5 text-[11px] text-text-muted/60 leading-relaxed">
        opencode is not installed or not running. Install it to configure vendor authentication.
      </div>
    )
  }

  const vendorIds = Array.from(
    new Set([...Object.keys(authMap ?? {}), ...Object.keys(options)])
  ).sort()

  return (
    <div className="px-3 py-1.5 space-y-4 text-[13px] text-text-secondary">
      {oauthError && (
        <div className="text-[11px] text-red-400 leading-relaxed">{oauthError}</div>
      )}
      {vendorIds.map((vendorId) => {
        const status = authMap?.[vendorId]
        const vendorOptions = options[vendorId] ?? []
        const isAuth = status?.authState === 'authenticated'
        const isFree = status?.billingType === 'free'
        const apiOption = vendorOptions.find((o) => o.type === 'api')
        const oauthOptions = vendorOptions.filter((o) => o.type === 'oauth')
        const firstOauthIdx = vendorOptions.indexOf(oauthOptions[0] ?? vendorOptions[0])

        return (
          <div key={vendorId} className="border border-border/30 rounded-md p-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="font-medium text-[12px]">{vendorId}</div>
              <div className="flex items-center gap-1.5">
                {status && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      isAuth
                        ? 'bg-green-500/10 text-green-400'
                        : 'bg-yellow-500/10 text-yellow-500'
                    }`}
                  >
                    {isAuth ? 'Authenticated' : 'Not configured'}
                  </span>
                )}
                {isFree && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
                    Free
                  </span>
                )}
              </div>
            </div>

            {!isFree && (
              <>
                {/* API key form */}
                {apiOption && (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="password"
                      placeholder={apiOption.prompts?.[0]?.message ?? 'API key'}
                      value={apiKeys[vendorId] ?? ''}
                      onChange={(e) =>
                        setApiKeys((prev) => ({ ...prev, [vendorId]: e.target.value }))
                      }
                      className="flex-1 px-2 py-1 text-[11px] rounded bg-bg-input border border-border/40 text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent/60"
                    />
                    <button
                      onClick={() => void handleSaveKey(vendorId)}
                      disabled={saving[vendorId] || !(apiKeys[vendorId] ?? '').trim()}
                      className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {saving[vendorId] ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                )}

                {/* OAuth button (paste-code flow only in-app) */}
                {oauthOptions.length > 0 && (
                  <div>
                    <button
                      onClick={() => void handleOAuthStart(vendorId, firstOauthIdx)}
                      className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
                    >
                      {oauthOptions[0]?.label ?? 'Sign in with OAuth'}
                    </button>
                  </div>
                )}

                {/* Auto OAuth waiting/error state */}
                {vendorOAuth?.vendorId === vendorId && vendorOAuth.stage === 'waiting' && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-[10px] text-text-muted/80">Waiting for browser authorization…</span>
                    <button
                      onClick={() => cancelVendorOAuth()}
                      className="px-2 py-0.5 text-[10px] rounded hover:bg-bg-hover text-text-muted/70 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}
                {vendorOAuth?.vendorId === vendorId && vendorOAuth.stage === 'error' && (
                  <div className="text-[10px] text-red-400 mt-1">Authentication failed. Try again.</div>
                )}

                {/* OAuth paste-code input */}
                {oauthFlow.stage === 'instructions' &&
                  oauthFlow.vendorId === vendorId && (
                    <div className="space-y-1.5 mt-1">
                      <div className="text-[10px] text-text-muted/70 leading-relaxed whitespace-pre-wrap">
                        {oauthFlow.instructions}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          placeholder="Paste code here"
                          value={oauthCode}
                          onChange={(e) => setOauthCode(e.target.value)}
                          className="flex-1 px-2 py-1 text-[11px] rounded bg-bg-input border border-border/40 text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent/60"
                        />
                        <button
                          onClick={() => void handleOAuthSubmit()}
                          disabled={!oauthCode.trim()}
                          className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          Submit
                        </button>
                        <button
                          onClick={() => { setOauthFlow({ stage: 'idle' }); setOauthCode('') }}
                          className="px-2 py-1 text-[11px] rounded hover:bg-bg-hover text-text-muted transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                {oauthFlow.stage === 'submitting' && oauthFlow.vendorId === vendorId && (
                  <div className="text-[10px] text-text-muted/60">Submitting code…</div>
                )}

                {/* Remove button */}
                {isAuth && (
                  <button
                    onClick={() => void handleRemove(vendorId)}
                    disabled={removing[vendorId]}
                    className="text-[10px] text-text-muted/60 hover:text-red-400 transition-colors disabled:opacity-40"
                  >
                    {removing[vendorId] ? 'Removing…' : 'Remove credentials'}
                  </button>
                )}
              </>
            )}
          </div>
        )
      })}

      <div className="text-[10px] text-text-muted/50 leading-relaxed">
        Credentials are stored in opencode&apos;s own auth.json. OAuth flows open your browser
        and complete automatically when available.
      </div>
    </div>
  )
}

// ── Nav tree types ───────────────────────────────────────────────────

export interface NavChild {
  id: string
  label: string
  badge?: string
  sections: Section[]
}

export interface NavGroup {
  id: string
  label: string
  icon: React.JSX.Element
  sections?: Section[]
  children?: NavChild[]
}

// ── SECTIONS data ────────────────────────────────────────────────────

export const SECTIONS: Section[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: (
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
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    ),
    items: [
      {
        key: 'theme',
        label: 'Theme',
        keywords: 'dark light monokai color',
        render: (s, u) => (
          <SettingsSelect
            label="Theme"
            value={s.theme}
            options={[
              { value: 'dark' as const, label: 'Dark' },
              { value: 'light' as const, label: 'Light' },
              { value: 'monokai' as const, label: 'Monokai' }
            ]}
            onChange={(v) => u({ theme: v })}
          />
        )
      },
      {
        key: 'uiFontScale',
        label: 'UI font size',
        keywords: 'zoom scale',
        render: (s, u) => (
          <SettingsSlider
            label="UI font size"
            value={s.uiFontScale}
            min={1}
            max={1.5}
            step={0.05}
            onChange={(v) => u({ uiFontScale: v })}
            formatValue={(v) => `${Math.round(v * 100)}%`}
          />
        )
      },
      {
        key: 'chatFontScale',
        label: 'Chat font size',
        keywords: 'zoom scale text',
        render: (s, u) => (
          <SettingsSlider
            label="Chat font size"
            value={s.chatFontScale}
            min={1}
            max={1.5}
            step={0.05}
            onChange={(v) => u({ chatFontScale: v })}
            formatValue={(v) => `${Math.round(v * 100)}%`}
          />
        )
      },
      {
        key: 'mermaidTheme',
        label: 'Mermaid diagram theme',
        keywords: 'diagram chart mermaid flowchart sequence',
        render: (s, u) => (
          <SettingsSelect
            label="Mermaid diagram theme"
            value={s.mermaidTheme}
            options={[
              { value: 'auto' as const, label: 'Auto' },
              { value: 'dark' as const, label: 'Dark' },
              { value: 'default' as const, label: 'Light' },
              { value: 'neutral' as const, label: 'Neutral' },
              { value: 'forest' as const, label: 'Forest' }
            ]}
            onChange={(v) => u({ mermaidTheme: v })}
          />
        )
      }
    ]
  },
  {
    id: 'chat',
    label: 'Chat',
    icon: (
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
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
    items: [
      {
        key: 'chatWidthMode',
        label: 'Chat width mode',
        keywords: 'pixels percent layout',
        render: (s, u) => (
          <SettingsSelect
            label="Chat width"
            value={s.chatWidthMode}
            options={[
              { value: 'px' as const, label: 'Pixels' },
              { value: 'percent' as const, label: 'Percent' }
            ]}
            onChange={(v) => u({ chatWidthMode: v })}
          />
        )
      },
      {
        key: 'chatWidthValue',
        label: 'Chat width',
        keywords: 'width size',
        render: (s, u) =>
          s.chatWidthMode === 'px' ? (
            <SettingsSlider
              label="Width"
              value={s.chatWidthPx}
              min={500}
              max={3420}
              step={10}
              onChange={(v) => u({ chatWidthPx: v })}
              formatValue={(v) => `${v}px`}
            />
          ) : (
            <SettingsSlider
              label="Width"
              value={s.chatWidthPercent}
              min={60}
              max={100}
              step={1}
              onChange={(v) => u({ chatWidthPercent: v })}
              formatValue={(v) => `${v}%`}
            />
          )
      },
      {
        key: 'maxRecentSessions',
        label: 'Recent sessions',
        keywords: 'history sidebar',
        render: (s, u) => (
          <SettingsSlider
            label="Recent sessions"
            value={s.maxRecentSessions}
            min={1}
            max={10}
            onChange={(v) => u({ maxRecentSessions: v })}
          />
        )
      }
    ]
  },
  {
    id: 'session',
    label: 'Session',
    icon: (
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
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
    items: [
      {
        key: 'sessionTimeoutMins',
        label: 'Idle timeout',
        keywords: 'idle timeout disconnect inactive auto session',
        render: (s, u) => (
          <SettingsSelect
            label="Idle timeout"
            value={String(s.sessionTimeoutMins)}
            options={[
              { value: '5', label: '5 min' },
              { value: '15', label: '15 min' },
              { value: '30', label: '30 min' },
              { value: '60', label: '1 hour' },
              { value: '0', label: 'Never' }
            ]}
            onChange={(v) => u({ sessionTimeoutMins: Number(v) })}
          />
        )
      },
      {
        key: 'cleanupPeriodDays',
        label: 'Chat history retention',
        keywords:
          'cleanup retention delete history transcripts privacy purge old chats days forever',
        render: () => <ChatRetentionSetting />
      }
    ]
  },
  {
    id: 'tool-output',
    label: 'Tool Output',
    icon: (
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
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
    items: [
      {
        key: 'expandToolCalls',
        label: 'Expand tool calls',
        keywords: 'collapse show hide tool',
        render: (s, u) => (
          <SettingsToggle
            label="Expand tool calls"
            checked={s.expandToolCalls}
            onChange={(v) => u({ expandToolCalls: v })}
          />
        )
      },
      {
        key: 'expandReadResults',
        label: 'Include read results',
        keywords: 'file content tool',
        render: (s, u) => (
          <div className={s.expandToolCalls ? '' : 'opacity-40 pointer-events-none'}>
            <div className="pl-4">
              <SettingsToggle
                label="Include read results"
                checked={s.expandReadResults}
                onChange={(v) => u({ expandReadResults: v })}
              />
            </div>
          </div>
        )
      },
      {
        key: 'hideToolInput',
        label: 'Hide tool input',
        keywords: 'collapse parameters',
        render: (s, u) => (
          <SettingsToggle
            label="Hide tool input"
            checked={s.hideToolInput}
            onChange={(v) => u({ hideToolInput: v })}
          />
        )
      },
      {
        key: 'expandThinking',
        label: 'Expand thinking',
        keywords: 'thought reasoning chain',
        render: (s, u) => (
          <SettingsToggle
            label="Expand thinking"
            checked={s.expandThinking}
            onChange={(v) => u({ expandThinking: v })}
          />
        )
      },
      {
        key: 'toolOutputMaxChars',
        label: 'Max output chars',
        keywords: 'truncate show more limit tool output chars characters',
        render: (s, u) => (
          <SettingsSlider
            label="Max output chars"
            value={s.toolOutputMaxChars}
            min={500}
            max={50000}
            step={500}
            onChange={(v) => u({ toolOutputMaxChars: v })}
            formatValue={(v) => `${v.toLocaleString()} chars`}
          />
        )
      }
    ]
  },
  {
    id: 'diff',
    label: 'Diff Viewer',
    icon: (
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
        <path d="M12 3v18" />
        <path d="M3 12h18" />
      </svg>
    ),
    items: [
      {
        key: 'diffViewSplit',
        label: 'Split diff view',
        keywords: 'side by side unified',
        render: (s, u) => (
          <SettingsToggle
            label="Split diff view"
            checked={s.diffViewSplit}
            onChange={(v) => u({ diffViewSplit: v })}
          />
        )
      },
      {
        key: 'diffIgnoreWhitespace',
        label: 'Ignore whitespace in diffs',
        keywords: 'spaces tabs',
        render: (s, u) => (
          <SettingsToggle
            label="Ignore whitespace"
            checked={s.diffIgnoreWhitespace}
            onChange={(v) => u({ diffIgnoreWhitespace: v })}
          />
        )
      },
      {
        key: 'diffWrapLines',
        label: 'Wrap lines in diffs',
        keywords: 'overflow scroll',
        render: (s, u) => (
          <SettingsToggle
            label="Wrap lines"
            checked={s.diffWrapLines}
            onChange={(v) => u({ diffWrapLines: v })}
          />
        )
      }
    ]
  },
  {
    id: 'git',
    label: 'Git',
    icon: (
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
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M6 21V9a9 9 0 009 9" />
      </svg>
    ),
    items: [
      {
        key: 'gitCommitMode',
        label: 'Default commit mode',
        keywords: 'push',
        render: (s, u) => (
          <SettingsSelect
            label="Default commit"
            value={s.gitCommitMode}
            options={[
              { value: 'commit' as const, label: 'Commit' },
              { value: 'commit-push' as const, label: 'Commit & Push' }
            ]}
            onChange={(v) => u({ gitCommitMode: v })}
          />
        )
      },
      {
        key: 'gitPanelLayout',
        label: 'Git panel layout',
        keywords: 'single double split',
        render: (s, u) => (
          <SettingsSelect
            label="Panel layout"
            value={s.gitPanelLayout}
            options={[
              { value: 'single' as const, label: 'Single' },
              { value: 'double' as const, label: 'Double' }
            ]}
            onChange={(v) => u({ gitPanelLayout: v })}
          />
        )
      }
    ]
  },
  {
    id: 'status-line',
    label: 'Status Line',
    icon: (
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
        <line x1="17" y1="10" x2="3" y2="10" />
        <line x1="21" y1="6" x2="3" y2="6" />
        <line x1="21" y1="14" x2="3" y2="14" />
        <line x1="17" y1="18" x2="3" y2="18" />
      </svg>
    ),
    items: [
      {
        key: 'statusLineAlign',
        label: 'Status line alignment',
        keywords: 'left center right position',
        render: (s, u) => (
          <SettingsSelect
            label="Alignment"
            value={s.statusLineAlign}
            options={[
              { value: 'left' as const, label: 'Left' },
              { value: 'center' as const, label: 'Center' },
              { value: 'right' as const, label: 'Right' }
            ]}
            onChange={(v) => u({ statusLineAlign: v })}
          />
        )
      },
      {
        key: 'statusLineTemplate',
        label: 'Status line template',
        keywords: 'format tokens cost context',
        render: (s, u) => (
          <div className="px-3 py-1.5 text-[13px] text-text-secondary">
            <div className="mb-1">Template</div>
            <input
              type="text"
              value={s.statusLineTemplate}
              onChange={(e) => u({ statusLineTemplate: e.target.value })}
              className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
              placeholder="{in} / {out} / {total} · {used}%"
            />
            <div className="text-[9px] text-text-muted/60 mt-0.5">
              Tokens: {'{in} {out} {total}'} · Cost: {'{cost}'} · Context: {'{used} {remaining}'} ·
              Lines: {'{lines+} {lines-}'} · Time: {'{duration}'}
            </div>
          </div>
        )
      }
    ]
  },
  {
    id: 'usage',
    label: 'Usage',
    icon: (
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
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    ),
    items: [
      {
        key: 'usageRefreshSecs',
        label: 'API polling interval',
        keywords: 'polling rate limit 5hr refresh update frequency api',
        render: (s, u) => (
          <div>
            <SettingsSlider
              label="API polling interval"
              value={s.usageRefreshSecs}
              min={60}
              max={3600}
              step={60}
              onChange={(v) => u({ usageRefreshSecs: v })}
              formatValue={(v) =>
                v >= 60 ? `${Math.floor(v / 60)}m${v % 60 ? ` ${v % 60}s` : ''}` : `${v}s`
              }
            />
            <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
              How often to call the usage API for detailed plan data. Rate limits update in
              real-time from inference headers.
            </div>
          </div>
        )
      },
      {
        key: 'analyticsRefreshSecs',
        label: 'Analytics refresh interval',
        keywords: 'analytics token recalculate jsonl refresh block usage',
        render: (s, u) => (
          <div>
            <SettingsSlider
              label="Analytics refresh interval"
              value={s.analyticsRefreshSecs}
              min={10}
              max={120}
              step={5}
              onChange={(v) => u({ analyticsRefreshSecs: v })}
              formatValue={(v) => `${v}s`}
            />
            <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
              How often to recalculate token analytics from session transcripts.
            </div>
          </div>
        )
      }
    ]
  },
  {
    id: 'logging',
    label: 'Logging',
    icon: (
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
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    ),
    items: [
      {
        key: 'logLevel',
        label: 'Log level',
        keywords: 'debug info warn error log level verbosity',
        render: (s, u) => (
          <SettingsSelect
            label="Log level"
            value={s.logLevel}
            options={[
              { value: 'debug' as const, label: 'Debug' },
              { value: 'info' as const, label: 'Info' },
              { value: 'warn' as const, label: 'Warn' },
              { value: 'error' as const, label: 'Error' }
            ]}
            onChange={(v) => u({ logLevel: v })}
          />
        )
      },
      {
        key: 'logFilter',
        label: 'Source filter',
        keywords: 'debug log filter sources verbose',
        render: (s, u) => (
          <div className="px-3 py-1.5">
            <div className="text-[13px] text-text-secondary mb-1.5">Per-source overrides</div>
            <input
              type="text"
              value={s.logFilter}
              onChange={(e) => u({ logFilter: e.target.value })}
              className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[12px] font-mono text-text-secondary outline-none focus:border-accent/50 transition-colors"
              placeholder="UsageFetcher,BlockUsage:debug"
              spellCheck={false}
            />
            <div className="text-[10px] text-text-muted/60 mt-1.5 space-y-0.5">
              <div>Comma-separated. Bare names enable debug for that source.</div>
              <div>
                Use <span className="font-mono">source:level</span> for explicit levels.
              </div>
              <div>
                Logs are written to <span className="font-mono">~/.claude/ui/logs/</span>
              </div>
            </div>
          </div>
        )
      }
    ]
  },
  {
    id: 'voice',
    label: 'Voice Input',
    icon: (
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
        <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
        <path d="M19 10v2a7 7 0 01-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    ),
    items: [
      {
        key: 'voiceEnabled',
        label: 'Enable voice input',
        keywords: 'voice microphone speech dictation audio',
        render: (s, u) => (
          <div>
            <SettingsToggle
              label="Enable voice input"
              checked={s.voiceEnabled}
              onChange={(v) => u({ voiceEnabled: v })}
              tooltip="Show a microphone button in the input box. Hold to record, release to transcribe."
            />
            <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
              Hold the mic button to dictate messages
            </div>
          </div>
        )
      },
      {
        key: 'voiceLanguage',
        label: 'Voice language',
        keywords: 'voice language speech locale',
        render: (s, u) => (
          <div className={s.voiceEnabled ? '' : 'opacity-40 pointer-events-none'}>
            <div className="px-3 py-1.5 text-[13px] text-text-secondary">
              <div className="mb-1">Language</div>
              <select
                value={s.voiceLanguage}
                onChange={(e) => u({ voiceLanguage: e.target.value as VoiceLanguageCode })}
                className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors cursor-pointer"
              >
                {VOICE_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )
      }
    ]
  },
  {
    id: 'remote',
    label: 'Remote',
    icon: (
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
        <path d="M5 12.55a11 11 0 0114.08 0" />
        <path d="M1.42 9a16 16 0 0121.16 0" />
        <path d="M8.53 16.11a6 6 0 016.95 0" />
        <circle cx="12" cy="20" r="1" />
      </svg>
    ),
    items: [
      {
        key: 'remoteFollowActions',
        label: 'Follow remote actions',
        keywords: 'remote phone sync follow mirror switch session',
        render: (s, u) => (
          <SettingsToggle
            label="Follow remote actions"
            checked={s.remoteFollowActions}
            onChange={(v) => u({ remoteFollowActions: v })}
            tooltip="When on, the local view auto-switches to sessions created or used by the remote client. When off, remote sessions still run in the background but the local view stays put."
          />
        )
      }
    ]
  },
  {
    id: 'permissions',
    label: 'Permissions',
    icon: (
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
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    items: [
      {
        key: 'globalPermissions',
        label: 'Global permissions',
        keywords: 'allow deny ask rules tools bash edit read write permissions security',
        render: () => <GlobalPermissionsSummary />
      },
      {
        key: 'autonomyMode',
        label: 'Autonomy mode',
        keywords: 'autonomy mode plan ask auto edit full permission mode default',
        render: () => <AutonomyModePicker />
      }
    ]
  },
  {
    id: 'accounts',
    label: 'Accounts',
    icon: (
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
        <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      </svg>
    ),
    items: [
      {
        key: 'multiAccount',
        label: 'Multiple account support',
        keywords: 'account login subscription switch multi keychain credentials sign in',
        render: () => <AccountsSetting />
      }
    ]
  },
  {
    id: 'vendor-anthropic',
    label: 'Anthropic',
    icon: (
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
        <path d="M4 17l6-6-6-6" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
    items: [
      {
        key: 'vendorAnthropicDisplay',
        label: 'Anthropic vendor config',
        keywords: 'anthropic endpoint model override vendor gateway custom url api token',
        render: () => <VendorAnthropicDisplaySection />
      }
    ]
  },
  {
    id: 'vendor-opencode',
    label: 'opencode Vendors',
    icon: (
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
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
      </svg>
    ),
    items: [
      {
        key: 'vendorOpencodeAuth',
        label: 'opencode vendor auth',
        keywords: 'opencode vendor auth api key oauth login openai google anthropic provider',
        render: () => <VendorOpencodeSection />
      }
    ]
  },
  {
    id: 'mockup',
    label: 'Mockups',
    icon: (
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
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="9" y1="9" x2="9" y2="21" />
      </svg>
    ),
    items: [
      {
        key: 'mockupConnectAllowlist',
        label: 'Network allowlist',
        keywords: 'mockup network fetch connect allowlist csp origin api',
        render: (s, u) => (
          <SettingsTextarea
            label="Network allowlist"
            value={s.mockupConnectAllowlist}
            onChange={(v) => u({ mockupConnectAllowlist: v })}
            placeholder={'api.openweathermap.org\n*.my-startup.com'}
            rows={4}
            monospace
            tooltip="Extends the mockup iframe's CSP connect-src directive. By default mockups can only talk to the pinned CDN allowlist (jsDelivr, cdnjs, Tailwind Play, unpkg, jQuery) plus their own origin. Add one origin per line to permit additional fetch/XHR/WebSocket targets."
            description="One origin per line (no scheme prefix needed, no quotes). Only turn this on for endpoints you trust — a compromised or prompt-injected mockup could exfiltrate to entries on this list."
          />
        )
      },
      {
        key: 'mockupAllowHttp',
        label: 'Allow plaintext (http://) connections',
        keywords: 'mockup http plaintext insecure localhost',
        render: (s, u) => (
          <div>
            <SettingsToggle
              label="Allow plaintext (http:// & ws://) connections"
              checked={s.mockupAllowHttp}
              onChange={(v) => u({ mockupAllowHttp: v })}
              tooltip="When on, mockups may fetch from http:// and ws:// URLs in addition to https:// / wss://. Useful for demoing local APIs (http://localhost:8080) or legacy internal services without TLS. Off by default."
            />
            <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
              Needed for localhost APIs and legacy non-TLS services
            </div>
          </div>
        )
      },
      {
        key: 'mockupFooter',
        label: 'Mockup security info',
        keywords: 'mockup info csp security',
        render: () => (
          <div className="px-3 py-1.5 text-[11px] text-text-muted/60 leading-relaxed">
            Mockups render in a sandboxed iframe on a per-mockup origin. Changes apply when the
            mockup is next loaded or reloaded — open mockups keep the CSP they were served with.
          </div>
        )
      }
    ]
  },
  {
    id: 'sandbox',
    label: 'Sandbox',
    icon: (
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
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" />
      </svg>
    ),
    items: [
      {
        key: 'sandboxEnabled',
        label: 'Command sandbox',
        keywords: 'sandbox isolate secure bash commands safety',
        render: (_s, _u, e, ue) => {
          const sb = e.sandbox ?? DEFAULT_SANDBOX
          return (
            <div>
              <SettingsToggle
                label="Command sandbox"
                checked={sb.enabled}
                onChange={(v) => ue({ sandbox: { ...sb, enabled: v } })}
                tooltip="Uses macOS sandbox-exec (Seatbelt profiles) or Linux bubblewrap (bwrap) to restrict filesystem and process access. Commands run in a sandboxed shell with deny-by-default policies. Only macOS and Linux are supported — Windows is not."
              />
              <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
                Run bash commands in an isolated environment
              </div>
            </div>
          )
        }
      },
      {
        key: 'sandboxAutoAllow',
        label: 'Auto-approve sandboxed commands',
        keywords: 'auto allow approve bash',
        render: (_s, _u, e, ue) => {
          const sb = e.sandbox ?? DEFAULT_SANDBOX
          return (
            <div className={sb.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4">
                <SettingsToggle
                  label="Auto-approve sandboxed commands"
                  checked={sb.autoAllowBashIfSandboxed}
                  onChange={(v) => ue({ sandbox: { ...sb, autoAllowBashIfSandboxed: v } })}
                  tooltip="When enabled, bash commands that run inside the sandbox are automatically approved without prompting. Commands matching deny or ask permission rules are still blocked. This is the main UX benefit of sandbox mode."
                />
                <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
                  Skip permission prompts for sandboxed bash
                </div>
              </div>
            </div>
          )
        }
      },
      {
        key: 'sandboxAllowUnsandboxed',
        label: 'Allow unsandboxed escape',
        keywords: 'unsandboxed escape bypass',
        render: (_s, _u, e, ue) => {
          const sb = e.sandbox ?? DEFAULT_SANDBOX
          return (
            <div className={sb.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4">
                <SettingsToggle
                  label="Allow unsandboxed escape"
                  checked={sb.allowUnsandboxedCommands}
                  onChange={(v) => ue({ sandbox: { ...sb, allowUnsandboxedCommands: v } })}
                  tooltip="When a sandboxed command fails due to restrictions, the model can retry it outside the sandbox. You'll still be prompted to approve the unsandboxed execution. Disable this to enforce strict sandbox-only execution."
                />
                <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
                  Let the model retry outside sandbox on failure
                </div>
              </div>
            </div>
          )
        }
      },
      {
        key: 'sandboxLocalBinding',
        label: 'Allow local port binding',
        keywords: 'network port listen bind',
        render: (_s, _u, e, ue) => {
          const sb = e.sandbox ?? DEFAULT_SANDBOX
          return (
            <div className={sb.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4">
                <SettingsToggle
                  label="Allow local port binding"
                  checked={sb.network.allowLocalBinding}
                  onChange={(v) =>
                    ue({ sandbox: { ...sb, network: { ...sb.network, allowLocalBinding: v } } })
                  }
                  tooltip="Lets processes inside the sandbox listen on localhost ports (e.g. webpack-dev-server, vite, flask). Without this, dev servers started by the model will fail to bind."
                />
                <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
                  Allow sandboxed processes to bind to local ports
                </div>
              </div>
            </div>
          )
        }
      },
      {
        key: 'sandboxRestrictNetwork',
        label: 'Restrict network access',
        keywords: 'network restrict domain whitelist proxy',
        render: (_s, _u, e, ue) => {
          const sb = e.sandbox ?? DEFAULT_SANDBOX
          return (
            <div className={sb.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4">
                <SettingsToggle
                  label="Restrict network access"
                  checked={sb.network.restrictNetwork}
                  onChange={(v) =>
                    ue({ sandbox: { ...sb, network: { ...sb.network, restrictNetwork: v } } })
                  }
                  tooltip="When enabled, sandboxed commands can only reach explicitly whitelisted domains via a local proxy. All other network access is blocked. When disabled, sandboxed commands have unrestricted network access."
                />
                <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
                  Only allow connections to whitelisted domains
                </div>
              </div>
            </div>
          )
        }
      },
      {
        key: 'sandboxAllowedDomains',
        label: 'Allowed domains',
        keywords: 'network domain whitelist url',
        render: (_s, _u, e, ue) => {
          const sb = e.sandbox ?? DEFAULT_SANDBOX
          return (
            <div
              className={
                sb.enabled && sb.network.restrictNetwork ? '' : 'opacity-40 pointer-events-none'
              }
            >
              <div className="pl-8">
                <SandboxListSetting
                  label="Allowed domains"
                  labelColor="text-success"
                  items={sb.network.allowedDomains}
                  placeholder="e.g. registry.npmjs.org"
                  onUpdate={(items) =>
                    ue({ sandbox: { ...sb, network: { ...sb.network, allowedDomains: items } } })
                  }
                  tooltip="Domains that sandboxed commands can reach. Supports wildcards like *.npmjs.org. Traffic is routed through a local HTTP/SOCKS proxy. Leave empty to block all outbound network access."
                />
              </div>
            </div>
          )
        }
      },
      {
        key: 'sandboxManagedDomainsOnly',
        label: 'Managed domains only',
        keywords: 'enterprise managed policy domains',
        render: (_s, _u, e, ue) => {
          const sb = e.sandbox ?? DEFAULT_SANDBOX
          return (
            <div
              className={
                sb.enabled && sb.network.restrictNetwork ? '' : 'opacity-40 pointer-events-none'
              }
            >
              <div className="pl-8">
                <SettingsToggle
                  label="Managed domains only"
                  checked={sb.network.allowManagedDomainsOnly}
                  onChange={(v) =>
                    ue({
                      sandbox: { ...sb, network: { ...sb.network, allowManagedDomainsOnly: v } }
                    })
                  }
                  tooltip="Enterprise feature. When enabled, only allowedDomains from managed settings and WebFetch(domain:...) allow rules from managed settings are used. Domains from user, project, local, and flag settings are ignored. Denied domains are still respected from all sources."
                />
                <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
                  Ignore user/project domain settings, only respect managed policy
                </div>
              </div>
            </div>
          )
        }
      },
      {
        key: 'sandboxAllowAllUnixSockets',
        label: 'Allow all Unix sockets',
        keywords: 'unix socket docker ipc',
        render: (_s, _u, e, ue) => {
          const sb = e.sandbox ?? DEFAULT_SANDBOX
          return (
            <div className={sb.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4">
                <SettingsToggle
                  label="Allow all Unix sockets"
                  checked={sb.network.allowAllUnixSockets}
                  onChange={(v) =>
                    ue({ sandbox: { ...sb, network: { ...sb.network, allowAllUnixSockets: v } } })
                  }
                  tooltip="Disables Unix socket blocking on both macOS and Linux. This grants access to all Unix sockets including the Docker socket, which effectively gives full host access. Only enable if you trust the commands being run."
                />
                <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
                  Disable Unix socket blocking (allows Docker, etc.)
                </div>
              </div>
            </div>
          )
        }
      },
      {
        key: 'sandboxUnixSockets',
        label: 'Unix socket paths',
        keywords: 'unix socket path docker',
        render: (_s, _u, e, ue) => {
          const sb = e.sandbox ?? DEFAULT_SANDBOX
          return (
            <div
              className={
                sb.enabled && !sb.network.allowAllUnixSockets
                  ? ''
                  : 'opacity-40 pointer-events-none'
              }
            >
              <div className="pl-8">
                <SandboxListSetting
                  label="Unix socket paths"
                  labelColor="text-warning"
                  items={sb.network.allowUnixSockets}
                  placeholder="e.g. /var/run/docker.sock"
                  onUpdate={(items) =>
                    ue({ sandbox: { ...sb, network: { ...sb.network, allowUnixSockets: items } } })
                  }
                  tooltip="macOS only — specific Unix socket paths to allow. Linux uses seccomp which cannot filter by path. Allowing /var/run/docker.sock grants full host access through the Docker API."
                />
              </div>
            </div>
          )
        }
      },
      {
        key: 'sandboxAllowWrite',
        label: 'Additional write paths',
        keywords: 'filesystem write allow path writable',
        render: (_s, _u, e, ue) => {
          const sb = e.sandbox ?? DEFAULT_SANDBOX
          return (
            <div className={sb.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4">
                <SandboxListSetting
                  label="Additional write paths"
                  labelColor="text-success"
                  items={sb.filesystem.allowWrite}
                  placeholder="e.g. /usr/local/bin"
                  onUpdate={(items) =>
                    ue({
                      sandbox: { ...sb, filesystem: { ...sb.filesystem, allowWrite: items } }
                    })
                  }
                  tooltip="Paths outside the project directory where sandboxed commands can write files. The project directory and $TMPDIR are always writable."
                />
              </div>
            </div>
          )
        }
      },
      {
        key: 'sandboxDenyWrite',
        label: 'Read-only paths',
        keywords: 'filesystem deny write readonly protect',
        render: (_s, _u, e, ue) => {
          const sb = e.sandbox ?? DEFAULT_SANDBOX
          return (
            <div className={sb.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4">
                <SandboxListSetting
                  label="Read-only paths"
                  labelColor="text-warning"
                  items={sb.filesystem.denyWrite}
                  placeholder="e.g. /etc"
                  onUpdate={(items) =>
                    ue({
                      sandbox: { ...sb, filesystem: { ...sb.filesystem, denyWrite: items } }
                    })
                  }
                  tooltip="Paths that should be read-only even within writable areas. Useful for protecting config files or build artifacts from accidental modification."
                />
              </div>
            </div>
          )
        }
      },
      {
        key: 'sandboxDenyRead',
        label: 'Hidden paths',
        keywords: 'filesystem deny block read path hidden',
        render: (_s, _u, e, ue) => {
          const sb = e.sandbox ?? DEFAULT_SANDBOX
          return (
            <div className={sb.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4">
                <SandboxListSetting
                  label="Hidden paths"
                  labelColor="text-danger"
                  items={sb.filesystem.denyRead}
                  placeholder="e.g. ~/.ssh"
                  onUpdate={(items) =>
                    ue({
                      sandbox: { ...sb, filesystem: { ...sb.filesystem, denyRead: items } }
                    })
                  }
                  tooltip="Paths completely hidden from sandboxed commands — they cannot read or detect these files exist. Good for credentials, SSH keys, cloud configs."
                />
              </div>
            </div>
          )
        }
      },
      {
        key: 'sandboxFooter',
        label: 'Sandbox info',
        keywords: 'sandbox info macos linux bwrap',
        render: () => (
          <div className="px-3 py-1.5 text-[11px] text-text-muted/60">
            Filesystem defaults: project dir + $TMPDIR writable. Changes take effect on next session
            start.
          </div>
        )
      }
    ]
  },
  {
    id: 'proxy',
    label: 'Proxy',
    icon: (
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
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
      </svg>
    ),
    items: [
      {
        key: 'proxyEnabled',
        label: 'Enable proxy',
        keywords: 'proxy http socks5 network tunnel',
        render: (_s, _u, e, ue) => {
          const px = e.proxy ?? DEFAULT_PROXY
          return (
            <div>
              <SettingsToggle
                label="Enable proxy"
                checked={px.enabled}
                onChange={(v) => ue({ proxy: { ...px, enabled: v } })}
                tooltip="Route all SDK traffic through a proxy server. Applies to new sessions."
              />
              <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
                Route Claude API traffic through a proxy server
              </div>
            </div>
          )
        }
      },
      {
        key: 'proxyType',
        label: 'Proxy type',
        keywords: 'http socks5 protocol',
        render: (_s, _u, e, ue) => {
          const px = e.proxy ?? DEFAULT_PROXY
          return (
            <div className={px.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4">
                <SettingsSelect
                  label="Proxy type"
                  value={px.type}
                  options={[
                    { value: 'http' as const, label: 'HTTP' },
                    { value: 'socks5' as const, label: 'SOCKS5' }
                  ]}
                  onChange={(v) => ue({ proxy: { ...px, type: v } })}
                />
              </div>
            </div>
          )
        }
      },
      {
        key: 'proxyHostname',
        label: 'Proxy hostname',
        keywords: 'host address server url',
        render: (_s, _u, e, ue) => {
          const px = e.proxy ?? DEFAULT_PROXY
          return (
            <div className={px.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4 px-3 py-1.5 text-[13px] text-text-secondary">
                <div className="mb-1">Hostname</div>
                <input
                  type="text"
                  value={px.hostname}
                  onChange={(ev) => ue({ proxy: { ...px, hostname: ev.target.value } })}
                  className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
                  placeholder="e.g. proxy.company.com"
                />
              </div>
            </div>
          )
        }
      },
      {
        key: 'proxyPort',
        label: 'Proxy port',
        keywords: 'port number',
        render: (_s, _u, e, ue) => {
          const px = e.proxy ?? DEFAULT_PROXY
          return (
            <div className={px.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4 px-3 py-1.5 text-[13px] text-text-secondary">
                <div className="mb-1">Port</div>
                <input
                  type="number"
                  value={px.port}
                  min={1}
                  max={65535}
                  onChange={(ev) => {
                    const n = parseInt(ev.target.value, 10)
                    if (!isNaN(n) && n >= 1 && n <= 65535) ue({ proxy: { ...px, port: n } })
                  }}
                  className="w-24 bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
                  placeholder="8080"
                />
              </div>
            </div>
          )
        }
      },
      {
        key: 'proxyUsername',
        label: 'Proxy username',
        keywords: 'auth authentication user credentials',
        render: (_s, _u, e, ue) => {
          const px = e.proxy ?? DEFAULT_PROXY
          return (
            <div className={px.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4 px-3 py-1.5 text-[13px] text-text-secondary">
                <div className="mb-1">
                  <span>Username</span>
                  <span className="text-[10px] text-text-muted/50 ml-1.5">optional</span>
                </div>
                <input
                  type="text"
                  value={px.username}
                  onChange={(ev) => ue({ proxy: { ...px, username: ev.target.value } })}
                  className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
                  placeholder="username"
                  autoComplete="off"
                />
              </div>
            </div>
          )
        }
      },
      {
        key: 'proxyPassword',
        label: 'Proxy password',
        keywords: 'auth authentication pass credentials secret',
        render: (_s, _u, e, ue) => {
          const px = e.proxy ?? DEFAULT_PROXY
          return (
            <div className={px.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4 px-3 py-1.5 text-[13px] text-text-secondary">
                <div className="mb-1">
                  <span>Password</span>
                  <span className="text-[10px] text-text-muted/50 ml-1.5">optional</span>
                </div>
                <input
                  type="password"
                  value={px.password}
                  onChange={(ev) => ue({ proxy: { ...px, password: ev.target.value } })}
                  className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
                  placeholder="password"
                  autoComplete="off"
                />
              </div>
            </div>
          )
        }
      },
      {
        key: 'proxyTestConnection',
        label: 'Test proxy connection',
        keywords: 'test verify check ping connectivity',
        render: (_s, _u, e) => {
          const px = e.proxy ?? DEFAULT_PROXY
          return (
            <div className={px.enabled && px.hostname ? '' : 'opacity-40 pointer-events-none'}>
              <div className="pl-4">
                <ProxyTestButton proxy={px} />
              </div>
            </div>
          )
        }
      },
      {
        key: 'proxySubprocesses',
        label: 'Proxy shell commands',
        keywords: 'proxy bash subprocess shell git curl npm everything all',
        render: (_s, _u, e, ue) => {
          const px = e.proxy ?? DEFAULT_PROXY
          return (
            <div className={px.enabled ? '' : 'opacity-40 pointer-events-none'}>
              <SettingsToggle
                label="Also proxy shell commands"
                checked={px.proxySubprocesses === true}
                onChange={(v) => ue({ proxy: { ...px, proxySubprocesses: v } })}
                tooltip="When on, git/curl/npm and other commands Claude runs in the shell also route through the proxy. When off (default), only Claude's API traffic is proxied."
              />
              <div className="text-[10px] text-text-muted/50 mt-0.5 pl-3">
                Off by default — shell commands stay direct
              </div>
            </div>
          )
        }
      },
      {
        key: 'proxyFooter',
        label: 'Proxy info',
        keywords: 'proxy info env environment variable',
        render: () => (
          <div className="px-3 py-1.5 text-[11px] text-text-muted/60">
            Sets HTTP_PROXY/HTTPS_PROXY environment variables. Changes apply to new sessions.
          </div>
        )
      }
    ]
  },
  {
    id: 'effortDefaults',
    label: 'Default effort',
    icon: (
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
        <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
    ),
    items: [
      ...EFFORT_MODELS.map((m) => ({
        key: `effortDefault_${m.id}`,
        label: `Default effort · ${m.label}`,
        keywords: `effort default ${m.label} ${m.id} reasoning thinking`,
        render: (s: AppSettings, u: (p: Partial<AppSettings>) => void) => (
          <ModelEffortRow
            modelId={m.id}
            modelLabel={m.label}
            current={s.modelEffortDefaults?.[m.id]}
            onChange={(next) => {
              const map = { ...(s.modelEffortDefaults ?? {}) }
              if (next === undefined) delete map[m.id]
              else map[m.id] = next
              u({ modelEffortDefaults: map })
            }}
          />
        )
      })),
      {
        key: 'effortDefaultsFooter',
        label: 'Effort defaults info',
        keywords: 'effort default fallback per-session',
        render: () => (
          <div className="px-3 py-1.5 text-[11px] text-text-muted/60">
            Picked here when starting a new session with the matching model. A per-session effort
            choice (chip next to the input) always wins. Applies to the canonical model and its
            aliases (e.g. selecting <code>opus</code> in the picker uses your Opus 4.8 default).
          </div>
        )
      }
    ]
  },
  {
    id: 'opencode-automode',
    label: 'Auto mode',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeAutoMode',
        label: 'Auto mode',
        keywords:
          'opencode auto mode full autonomy classifier gatekeeper judge llm permission bash security monitor',
        render: () => <OpencodeAutoModeSection />
      }
    ]
  }
]

// ── Navigation groups tree ───────────────────────────────────────────

/** Section ids that belong to the App group (flat, directly visible) */
const APP_SECTION_IDS = new Set([
  'appearance', 'chat', 'session', 'tool-output', 'diff', 'git',
  'status-line', 'usage', 'logging', 'voice', 'remote', 'mockup'
])

/** Section ids that belong to Engines > Claude */
const ENGINE_CLAUDE_SECTION_IDS = new Set([
  'permissions', 'sandbox', 'proxy'
])

/** Section ids that belong to Engines > opencode (content self-gates on install) */
const ENGINE_OPENCODE_SECTION_IDS = new Set(['opencode-automode'])

/** Section ids that belong to Vendors > Anthropic */
const VENDOR_ANTHROPIC_SECTION_IDS = new Set([
  'vendor-anthropic', 'effortDefaults'
])

/** Section ids that belong to Vendors > opencode (gated: only shown when opencode engine installs) */
const VENDOR_OPENCODE_SECTION_IDS = new Set(['vendor-opencode'])

/** Section ids that belong to Accounts (flat) */
const ACCOUNTS_SECTION_IDS = new Set(['accounts'])

function getSectionsForIds(ids: Set<string>): Section[] {
  return SECTIONS.filter((s) => ids.has(s.id))
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'app',
    label: 'App',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </svg>
    ),
    sections: getSectionsForIds(APP_SECTION_IDS)
  },
  {
    id: 'engines',
    label: 'Engines',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L4 6v12l8 4 8-4V6z" />
        <path d="M4 6l8 4 8-4" />
        <line x1="12" y1="22" x2="12" y2="10" />
      </svg>
    ),
    children: [
      {
        id: 'engine-claude',
        label: 'Claude',
        sections: getSectionsForIds(ENGINE_CLAUDE_SECTION_IDS)
      },
      {
        id: 'engine-opencode',
        label: 'opencode',
        sections: getSectionsForIds(ENGINE_OPENCODE_SECTION_IDS)
      }
    ]
  },
  {
    id: 'vendors',
    label: 'Vendors',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
      </svg>
    ),
    children: [
      {
        id: 'vendor-anthropic-nav',
        label: 'Anthropic',
        sections: getSectionsForIds(VENDOR_ANTHROPIC_SECTION_IDS)
      },
      {
        id: 'vendor-opencode-nav',
        label: 'opencode',
        sections: getSectionsForIds(VENDOR_OPENCODE_SECTION_IDS)
      }
    ]
  },
  {
    id: 'accounts-group',
    label: 'Accounts',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      </svg>
    ),
    sections: getSectionsForIds(ACCOUNTS_SECTION_IDS)
  }
]
