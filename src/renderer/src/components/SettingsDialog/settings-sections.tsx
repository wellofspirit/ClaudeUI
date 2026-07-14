import { useState, useEffect, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useActiveSession, useSessionStore, OPENCODE_DEFAULT_MODEL } from '../../stores/session-store'
import type { AppSettings } from '../../stores/session-store'
import { PermissionsDialog } from '../PermissionsDialog'
import type {
  ClaudePermissions,
  ProxySettings,
  VoiceLanguageCode,
  AccountsState,
  EngineId,
  EngineConfig,
  VendorConfig,
  AnthropicEndpointSettings,
  ModelOverrideSettings,
  SandboxSettings,
  VendorAuthOption,
  AutoModeConfig,
  DispatchConfig,
  ModelInfo,
  OpencodeProviderSettings,
  OpencodeConfigSettings
} from '../../../../shared/types'
import { VOICE_LANGUAGES } from '../../../../shared/types'
import {
  supportedEffortLevels,
  defaultEffort,
  type EffortLevel,
  type AutonomyMode,
  type EngineCapabilities,
  CLAUDE_ENGINE_CAPABILITIES
} from '../../../../shared/model-capabilities'
import { engineMeta } from '../../../../shared/engine-meta'
import {
  SettingsToggle,
  SettingsSlider,
  SettingsSelect,
  SettingsTextarea,
  SandboxListSetting,
  ChatRetentionSetting,
  InfoTooltip
} from './settings-controls'
import { OpencodeAgentsSection } from './OpencodeAgents'
import { OpencodeSchemaForm, type SchemaDefs, type SchemaNode } from './OpencodeSchemaForm'
import { diffToPatches } from '../../../../shared/opencode-config-diff'
import opencodeConfigSchema from '../../../../shared/opencode-config-schema.1.17.14.json'

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
    <div data-testid="ProxyTestButton" className="px-3 py-1.5 text-[13px] text-text-secondary">
      <div className="flex items-center gap-2">
        <button
          data-testid="ProxyTestButton.test"
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
    <div data-testid="GlobalPermissionsSummary" className="px-3 py-1.5 text-[13px] text-text-secondary">
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
          data-testid="GlobalPermissionsSummary.edit"
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
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
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
    <div data-testid="ModelEffortRow" data-id={modelId} className="pl-4 px-3 py-1.5 text-[13px] text-text-secondary">
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
    <div data-testid="AccountsSetting" className="px-3 py-1.5 space-y-2.5">
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
                data-testid="AccountsSetting.accountRow"
                data-id={a.id}
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
            data-testid="AccountsSetting.addAccount"
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
    <div data-testid="AutonomyModePicker" className="px-3 py-1.5 text-[13px] text-text-secondary">
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

// ── opencode availability probe ──────────────────────────────────────

/**
 * Whether the opencode engine is installed.
 *
 * Uses `engineIsInstalled('opencode')` — a cheap, deterministic binary-on-disk
 * check that NEVER spawns a server. The earlier `vendorAuthProbe`/`getEngineModels`
 * approaches both required a successful server spawn + HTTP round-trip, so any
 * transient spawn failure (e.g. an opencode startup crash) made the engine read as
 * "not installed" and hid the very sections that configure it. Auth/model state is
 * a separate, allowed-to-fail concern — not "installed".
 *
 * Returns null while probing, then true/false.
 */
function useOpencodeInstalled(): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api
      .engineIsInstalled('opencode')
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
  const installed = useOpencodeInstalled()

  useEffect(() => {
    window.api
      .loadEngineConfig('opencode')
      .then(setEngineCfg)
      .catch(() => setEngineCfg({}))
    window.api
      .getEngineModels()
      .then((groups) => {
        const oc = groups.filter((g) => g.engineId === 'opencode')
        setModels(oc.flatMap((g) => g.models))
      })
      .catch(() => {})
  }, [])

  if (engineCfg === null || installed === null) {
    return <div data-testid="OpencodeAutoModeSection" className="px-3 py-1.5 text-[13px] text-text-muted">Loading…</div>
  }
  if (!installed) {
    return (
      <div data-testid="OpencodeAutoModeSection" className="px-3 py-2 text-[12px] text-text-muted/70 leading-relaxed">
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
    <div data-testid="OpencodeAutoModeSection" className="space-y-1">
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

// ── cross-engine dispatch settings (ADR-033) ─────────────────────────

/**
 * Shared render/load/save core for the per-engine dispatch-config editor.
 * Both `OpencodeDispatchSection` and `ClaudeDispatchSection` are thin
 * copy/gating wrappers around this — the load/merge/toggle logic and markup
 * are otherwise identical (DRY per CLAUDE.md), so they keep distinct root
 * testids via the `testid` prop while sharing everything else.
 *
 * `installed`: null = still probing (shows Loading), false = gate closed
 * (shows `notInstalledMessage`), true = render the editor. Claude has no
 * "not installed" state (it's the bundled default engine — `engine:is-installed`
 * always returns true for it), so `ClaudeDispatchSection` passes a literal `true`.
 */
function DispatchSection({
  engineId,
  testid,
  installed,
  notInstalledMessage,
  defaultModelTooltip,
  noModelsMessage,
  footerText
}: {
  engineId: EngineId
  testid: string
  installed: boolean | null
  notInstalledMessage?: string
  defaultModelTooltip: string
  noModelsMessage: string
  footerText: string
}): React.JSX.Element {
  const [engineCfg, setEngineCfg] = useState<EngineConfig | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])

  useEffect(() => {
    window.api
      .loadEngineConfig(engineId)
      .then(setEngineCfg)
      .catch(() => setEngineCfg({}))
    window.api
      .getEngineModels()
      .then((groups) => {
        const own = groups.filter((g) => g.engineId === engineId)
        setModels(own.flatMap((g) => g.models))
      })
      .catch(() => {})
  }, [engineId])

  if (engineCfg === null || installed === null) {
    return <div data-testid={testid} className="px-3 py-1.5 text-[13px] text-text-muted">Loading…</div>
  }
  if (!installed) {
    return (
      <div data-testid={testid} className="px-3 py-2 text-[12px] text-text-muted/70 leading-relaxed">
        {notInstalledMessage}
      </div>
    )
  }

  const dispatch = engineCfg.dispatch ?? {}
  const defaultModel = dispatch.defaultModel ?? ''
  const allowedModels = dispatch.allowedModels ?? []

  const update = (patch: Partial<DispatchConfig>): void => {
    const next: EngineConfig = { ...engineCfg, dispatch: { ...dispatch, ...patch } }
    setEngineCfg(next)
    window.api.saveEngineConfig(engineId, next).catch(() => {})
  }

  const toggleAllowed = (model: string): void => {
    const nextList = allowedModels.includes(model)
      ? allowedModels.filter((m) => m !== model)
      : [...allowedModels, model]
    // Drop the key entirely when empty — empty and absent both mean "all
    // models allowed", and the absent form keeps the hand-editable file clean.
    update({ allowedModels: nextList.length > 0 ? nextList : undefined })
  }

  return (
    <div data-testid={testid} className="space-y-1">
      <div className="px-3 py-1.5 text-[13px] text-text-secondary">
        <div className="mb-1 flex items-center gap-1">
          Default model
          <InfoTooltip text={defaultModelTooltip} />
        </div>
        <select
          data-testid={`${testid}.defaultModel`}
          value={defaultModel}
          onChange={(e) => update({ defaultModel: e.target.value || undefined })}
          className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
        >
          <option value="">(not set)</option>
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.displayName || m.value}
            </option>
          ))}
        </select>
      </div>
      <div className="px-3 py-1.5 text-[13px] text-text-secondary">
        <div className="mb-1 flex items-center gap-1">
          Allowed models
          <InfoTooltip text="Models a dispatching agent may request explicitly. With NONE checked, all models are allowed." />
        </div>
        <div className="space-y-0.5">
          {models.length === 0 && (
            <div className="text-[11px] text-text-muted/70">{noModelsMessage}</div>
          )}
          {models.map((m) => {
            const checked = allowedModels.includes(m.value)
            return (
              <button
                key={m.value}
                data-testid={`${testid}.allowedModel`}
                data-id={m.value}
                onClick={() => toggleAllowed(m.value)}
                className="w-full flex items-center justify-between py-1 text-[12px] text-text-secondary hover:bg-bg-hover rounded transition-colors cursor-default"
              >
                <span className="truncate">{m.displayName || m.value}</span>
                <span
                  className={`w-7 h-4 shrink-0 rounded-full relative transition-colors ${checked ? 'bg-accent' : 'bg-text-muted/30'}`}
                >
                  <span
                    className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${checked ? 'left-3.5' : 'left-0.5'}`}
                  />
                </span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="px-3 pb-1 text-[10px] text-text-muted/50 leading-relaxed">{footerText}</div>
    </div>
  )
}

/**
 * Governs `dispatch_agent` calls INTO opencode (the live Claude→opencode
 * direction). Self-contained: loads/saves its own opencode EngineConfig via
 * window.api, editing only the `dispatch` block (never clobbers autoMode etc.).
 */
export function OpencodeDispatchSection(): React.JSX.Element {
  const installed = useOpencodeInstalled()
  return (
    <DispatchSection
      engineId="opencode"
      testid="OpencodeDispatchSection"
      installed={installed}
      notInstalledMessage="opencode is not installed. Cross-engine dispatch lets a Claude session delegate a task to an opencode agent (e.g. a GPT-backed review)."
      defaultModelTooltip="Used when the dispatching agent doesn't request a model. Format: provider/model-id. With no default set, dispatch_agent calls without an explicit model are rejected."
      noModelsMessage="No opencode models detected."
      footerText="Governs dispatch_agent calls INTO opencode (e.g. a Claude session asking a GPT-backed agent for a second opinion). Empty allowed-models list = any model may be requested."
    />
  )
}

/**
 * Governs `dispatch_agent` calls INTO Claude (the M2 opencode→Claude
 * direction, plus any future engine). Self-contained: loads/saves its own
 * Claude EngineConfig via window.api, editing only the `dispatch` block
 * (never clobbers `sandbox`/`proxy`). Claude is always installed (bundled
 * default engine), so there's no "not installed" gate — see DispatchSection.
 */
export function ClaudeDispatchSection(): React.JSX.Element {
  return (
    <DispatchSection
      engineId="claude"
      testid="ClaudeDispatchSection"
      installed={true}
      defaultModelTooltip="Used when the dispatching agent doesn't request a model. Claude model aliases (e.g. sonnet, haiku, opus). With no default set, dispatch_agent calls without an explicit model are rejected."
      noModelsMessage="No Claude models detected."
      footerText="Governs dispatch_agent calls INTO Claude from other engines (e.g. an opencode session asking Claude for a second opinion). Empty allowed-models list = any model may be requested."
    />
  )
}

// ── Vendor Anthropic editable form ───────────────────────────────────

const DEFAULT_ENDPOINT: AnthropicEndpointSettings = { enabled: false, baseUrl: '', authToken: '' }
const DEFAULT_MODEL_OVERRIDE: ModelOverrideSettings = {
  enabled: false,
  model: '',
  sonnetModel: '',
  opusModel: '',
  haikuModel: ''
}

function VendorAnthropicEditableForm({
  vendorConfig,
  updateVendorConfig
}: {
  vendorConfig: VendorConfig
  updateVendorConfig: (p: Partial<VendorConfig>) => void
}): React.JSX.Element {
  const endpoint: AnthropicEndpointSettings = vendorConfig.endpoint ?? DEFAULT_ENDPOINT
  const modelOverride: ModelOverrideSettings = vendorConfig.modelOverride ?? DEFAULT_MODEL_OVERRIDE

  const inputClass =
    'bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors'

  const modelFields: { field: keyof ModelOverrideSettings; label: string }[] = [
    { field: 'model', label: 'Model (default)' },
    { field: 'sonnetModel', label: 'Sonnet model' },
    { field: 'opusModel', label: 'Opus model' },
    { field: 'haikuModel', label: 'Haiku model' }
  ]

  return (
    <div data-testid="VendorAnthropicEditableForm" className="px-3 py-1.5 text-[13px] text-text-secondary space-y-4">
      {/* Endpoint */}
      <div className="space-y-2">
        <div className="text-[11px] text-text-muted uppercase tracking-wide">Endpoint</div>
        <SettingsToggle
          label="Enable custom endpoint"
          checked={endpoint.enabled}
          onChange={(v) =>
            updateVendorConfig({ endpoint: { ...endpoint, enabled: v } })
          }
        />
        {endpoint.enabled && (
          <div className="space-y-1.5 pl-1">
            <div>
              <div className="text-[10px] text-text-muted mb-0.5">Base URL</div>
              <input
                type="text"
                className={`${inputClass} w-full`}
                placeholder="https://api.anthropic.com"
                value={endpoint.baseUrl}
                onChange={(e) =>
                  updateVendorConfig({ endpoint: { ...endpoint, baseUrl: e.target.value } })
                }
              />
            </div>
            <div>
              <div className="text-[10px] text-text-muted mb-0.5">Auth token</div>
              <input
                type="password"
                className={`${inputClass} w-full`}
                placeholder="sk-ant-..."
                value={endpoint.authToken}
                onChange={(e) =>
                  updateVendorConfig({ endpoint: { ...endpoint, authToken: e.target.value } })
                }
              />
            </div>
          </div>
        )}
      </div>

      {/* Model override */}
      <div className="space-y-2">
        <div className="text-[11px] text-text-muted uppercase tracking-wide">Model override</div>
        <SettingsToggle
          label="Enable model override"
          checked={modelOverride.enabled}
          onChange={(v) =>
            updateVendorConfig({ modelOverride: { ...modelOverride, enabled: v } })
          }
        />
        {modelOverride.enabled && (
          <div className="space-y-1.5 pl-1">
            {modelFields.map(({ field, label }) => (
              <div key={String(field)}>
                <div className="text-[10px] text-text-muted mb-0.5">{label}</div>
                <input
                  type="text"
                  className={`${inputClass} w-full`}
                  placeholder={`e.g. claude-${field === 'model' ? '3-5-sonnet-latest' : String(field).replace('Model', '-latest')}`}
                  value={modelOverride[field] as string}
                  onChange={(e) =>
                    updateVendorConfig({
                      modelOverride: { ...modelOverride, [field]: e.target.value }
                    })
                  }
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-[10px] text-text-muted/50 leading-relaxed">
        Changes apply on next session start. Persists to vendors/anthropic.json.
      </div>
    </div>
  )
}

// ── Vendor opencode auth UI ──────────────────────────────────────────

type VendorOAuthFlowState =
  | { stage: 'idle' }
  | { stage: 'instructions'; url: string; instructions: string; method: number; vendorId: string }
  | { stage: 'submitting'; vendorId: string }

/**
 * Per-provider model-allowlist dialog. Lists every catalog model for a provider
 * so the user picks which appear in the model picker — preventing huge providers
 * (openrouter ships 300+) from flooding it.
 *
 * Semantics: an undefined incoming allowlist means "all currently shown", so we
 * pre-check every model (saving then writes an explicit list). A defined list
 * pre-checks exactly those ids. Saving an empty selection writes [] → no models.
 */
function ModelAllowlistDialog({
  providerId,
  providerName,
  current,
  onSave,
  onClose
}: {
  providerId: string
  providerName: string
  current: string[] | undefined
  onSave: (ids: string[]) => void
  onClose: () => void
}): React.JSX.Element {
  const [models, setModels] = useState<import('../../../../shared/types').OpencodeCatalogModel[] | null>(
    null
  )
  const [checked, setChecked] = useState<Set<string>>(new Set(current ?? []))
  const [search, setSearch] = useState('')
  const [freeOnly, setFreeOnly] = useState(false)
  // When the incoming allowlist is undefined (legacy "show all"), default every
  // model to checked once the list loads so saving doesn't silently hide them.
  const seededRef = useRef(current !== undefined)

  useEffect(() => {
    let cancelled = false
    window.api
      .getOpencodeProviderModels(providerId)
      .then((list) => {
        if (cancelled) return
        setModels(list)
        if (!seededRef.current) {
          seededRef.current = true
          setChecked(new Set(list.map((m) => m.id)))
        }
      })
      .catch(() => {
        if (!cancelled) setModels([])
      })
    return () => {
      cancelled = true
    }
  }, [providerId])

  const hasFreeModels = (models ?? []).some((m) => m.free)
  const filtered = (models ?? []).filter((m) => {
    // Ignore a stale toggle when the loaded entries contain no free models — the
    // chip is unmounted then, so an active filter would otherwise leave a
    // permanently empty list (same dead-end guard as ModelPicker.displayedGroups).
    if (freeOnly && hasFreeModels && !m.free) return false
    const q = search.trim().toLowerCase()
    if (!q) return true
    return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
  })

  const toggle = (id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div
      data-testid="ModelAllowlistDialog"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[min(560px,92vw)] max-h-[80vh] flex flex-col bg-bg-primary border border-border rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
          <div>
            <div className="text-[13px] font-medium text-text-primary">Models · {providerName}</div>
            <div className="text-[11px] text-text-muted/70">
              Pick which models appear in the picker. {checked.size} selected.
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted/60 hover:text-text-primary transition-colors text-[16px] leading-none px-1"
          >
            ✕
          </button>
        </div>

        <div className="px-4 py-2 border-b border-border/30 flex items-center gap-2">
          <input
            type="text"
            data-testid="ModelAllowlistDialog.search"
            placeholder="Search models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 px-2 py-1 text-[11px] rounded bg-bg-input border border-border/40 text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent/60"
          />
          <button
            data-testid="ModelAllowlistDialog.selectAll"
            onClick={() => setChecked(new Set((models ?? []).map((m) => m.id)))}
            className="text-[10px] text-accent hover:text-accent/80 transition-colors whitespace-nowrap"
          >
            Select all
          </button>
          <button
            data-testid="ModelAllowlistDialog.clear"
            onClick={() => setChecked(new Set())}
            className="text-[10px] text-text-muted/70 hover:text-text-primary transition-colors whitespace-nowrap"
          >
            Clear
          </button>
          {hasFreeModels && (
            <button
              type="button"
              data-testid="ModelAllowlistDialog.freeFilter"
              aria-pressed={freeOnly}
              onClick={() => setFreeOnly((v) => !v)}
              className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wide transition-colors cursor-pointer border whitespace-nowrap ${
                freeOnly
                  ? 'bg-emerald-500/25 text-emerald-300 border-emerald-500/40'
                  : 'bg-bg-hover text-text-muted border-border hover:text-text-secondary'
              }`}
            >
              Free only
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-1">
          {models === null ? (
            <div className="px-2 py-3 text-[11px] text-text-muted/60">Loading models…</div>
          ) : filtered.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-text-muted/60">No models match.</div>
          ) : (
            filtered.map((m) => (
              <button
                key={m.id}
                data-testid="ModelAllowlistDialog.modelRow"
                data-id={m.id}
                onClick={() => toggle(m.id)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-hover transition-colors text-left cursor-default"
              >
                <span
                  className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center text-[9px] ${
                    checked.has(m.id)
                      ? 'bg-accent border-accent text-white'
                      : 'border-border/60 text-transparent'
                  }`}
                >
                  ✓
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[12px] text-text-secondary truncate">{m.name}</span>
                    {m.free && (
                      <span
                        data-testid="ModelAllowlistDialog.freeBadge"
                        className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-medium uppercase tracking-wide shrink-0"
                      >
                        Free
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-text-muted/50 truncate block">
                    {m.id}
                    {m.releaseDate ? ` · ${m.releaseDate}` : ''}
                    {m.toolCalling ? ' · tools' : ''}
                    {m.reasoning ? ' · reasoning' : ''}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="px-4 py-3 border-t border-border/50 flex items-center justify-end gap-2">
          <button
            data-testid="ModelAllowlistDialog.cancel"
            onClick={onClose}
            className="px-3 py-1 text-[11px] rounded hover:bg-bg-hover text-text-muted transition-colors"
          >
            Cancel
          </button>
          <button
            data-testid="ModelAllowlistDialog.save"
            onClick={() => onSave([...checked])}
            className="px-3 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * opencode provider manager — the catalog-driven add/auth/curate experience.
 *
 * Surfaces the FULL provider catalog (~146 providers, incl. ones with no custom
 * auth loader like openrouter) so users can ADD any supported provider, authenticate
 * it (OAuth or plain API key), and then pick which of its models appear in the
 * picker (per-provider allowlist). Replaces the old narrow vendor-auth list that
 * only showed providers from /provider/auth ∪ /config/providers.
 */
function VendorOpencodeSection(): React.JSX.Element {
  const installed = useOpencodeInstalled()
  const [catalog, setCatalog] = useState<
    import('../../../../shared/types').OpencodeProviderCatalogEntry[] | null
  >(null)
  const [opencodeCfg, setOpencodeCfg] = useState<OpencodeConfigSettings | null>(null)
  const [options, setOptions] = useState<Record<string, VendorAuthOption[]>>({})
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [removing, setRemoving] = useState<Record<string, boolean>>({})
  const [oauthFlow, setOauthFlow] = useState<VendorOAuthFlowState>({ stage: 'idle' })
  const [oauthCode, setOauthCode] = useState('')
  const [oauthError, setOauthError] = useState<string | null>(null)
  // Add-provider picker state.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [addSearch, setAddSearch] = useState('')
  // Provider currently mid-add (auth UI expanded inline in the picker).
  const [addingId, setAddingId] = useState<string | null>(null)
  // Provider whose model-allowlist dialog is open.
  const [modelDialogId, setModelDialogId] = useState<string | null>(null)
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

  const reload = (): void => {
    Promise.all([
      window.api.getOpencodeProviders().catch(() => []),
      window.api.loadOpencodeSettings().catch(() => ({})),
      window.api.vendorAuthListOptions('opencode').catch(() => ({})) as Promise<
        Record<string, VendorAuthOption[]>
      >
    ]).then(([cat, settings, opts]) => {
      if (!mountedRef.current) return
      setCatalog(cat)
      setOpencodeCfg(settings)
      setOptions(opts)
    })
  }

  useEffect(() => {
    reload()
  }, [])

  const cfg = opencodeCfg ?? {}
  const disabled = cfg.disabledProviders ?? []
  const allowlist = cfg.modelAllowlist ?? {}

  /** Merge a patch into opencode settings, persist, and refresh the picker model list. */
  const updateCfg = (
    patch: Partial<import('../../../../shared/types').OpencodeConfigSettings>
  ): OpencodeConfigSettings => {
    const next: OpencodeConfigSettings = { ...cfg, ...patch }
    setOpencodeCfg(next)
    window.api.saveOpencodeSettings(next).catch(() => {})
    useSessionStore.getState().reloadModels()
    return next
  }

  // A provider is "active" (added) when it's usable now: authenticated/free AND
  // not explicitly removed (disabledProviders). authState already reflects
  // /config/providers, which excludes credential-less providers.
  const activeProviders = (catalog ?? []).filter(
    (p) => (p.authState === 'authenticated' || p.authState === 'free') && !disabled.includes(p.id)
  )
  const activeIds = new Set(activeProviders.map((p) => p.id))
  const addable = (catalog ?? [])
    .filter((p) => !activeIds.has(p.id))
    .filter((p) => {
      const q = addSearch.trim().toLowerCase()
      if (!q) return true
      return p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    })

  const allowlistLabel = (id: string): string => {
    const a = allowlist[id]
    if (a === undefined) return 'all models'
    return `${a.length} model${a.length === 1 ? '' : 's'}`
  }

  // Finalize adding a provider: clear it from disabledProviders, seed an empty
  // model allowlist (so it doesn't flood the picker), close the picker, and open
  // the model dialog so the user curates its models.
  const finishAdd = (id: string): void => {
    const nextDisabled = disabled.filter((d) => d !== id)
    updateCfg({
      disabledProviders: nextDisabled.length > 0 ? nextDisabled : undefined,
      modelAllowlist: { ...allowlist, [id]: allowlist[id] ?? [] }
    })
    setAddingId(null)
    setPickerOpen(false)
    setApiKeys((prev) => ({ ...prev, [id]: '' }))
    reload()
    setModelDialogId(id)
  }

  const handleSaveKey = async (vendorId: string): Promise<void> => {
    const key = (apiKeys[vendorId] ?? '').trim()
    if (!key) return
    setSaving((prev) => ({ ...prev, [vendorId]: true }))
    try {
      await window.api.vendorAuthSetKey('opencode', vendorId, key)
      finishAdd(vendorId)
    } catch {
      setOauthError(`Failed to save key for ${vendorId}`)
    } finally {
      if (mountedRef.current) setSaving((prev) => ({ ...prev, [vendorId]: false }))
    }
  }

  const handleRemove = async (vendorId: string, isFree: boolean): Promise<void> => {
    setRemoving((prev) => ({ ...prev, [vendorId]: true }))
    try {
      // Free/credential-less providers have nothing to remove from auth.json;
      // hide them via disabledProviders. Authed providers also get their creds
      // dropped so they leave /config/providers.
      if (!isFree) await window.api.vendorAuthRemove('opencode', vendorId).catch(() => {})
      const nextDisabled = disabled.includes(vendorId) ? disabled : [...disabled, vendorId]
      const nextAllow = { ...allowlist }
      delete nextAllow[vendorId]
      updateCfg({
        disabledProviders: nextDisabled,
        modelAllowlist: Object.keys(nextAllow).length > 0 ? nextAllow : undefined
      })
      reload()
    } finally {
      if (mountedRef.current) setRemoving((prev) => ({ ...prev, [vendorId]: false }))
    }
  }

  const handleOAuthStart = async (vendorId: string): Promise<void> => {
    setOauthError(null)
    try {
      const result = await authorizeVendorOAuth('opencode', vendorId)
      if (result.ok) {
        finishAdd(vendorId)
      } else if (result.needsPaste) {
        setOauthFlow({
          stage: 'instructions',
          url: result.needsPaste.url,
          instructions: result.needsPaste.instructions,
          method: result.needsPaste.method,
          vendorId
        })
      }
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
      finishAdd(vendorId)
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : 'OAuth callback failed')
      setOauthFlow({ stage: 'idle' })
    }
  }

  if (installed === null || catalog === null) {
    return <div data-testid="VendorOpencodeSection" className="px-3 py-1.5 text-[11px] text-text-muted/60">Loading…</div>
  }
  if (!installed) {
    return (
      <div data-testid="VendorOpencodeSection" className="px-3 py-1.5 text-[11px] text-text-muted/60 leading-relaxed">
        opencode is not installed. Install it to add providers and authenticate them.
      </div>
    )
  }

  const dialogProvider = modelDialogId
    ? (catalog.find((p) => p.id === modelDialogId) ?? null)
    : null

  return (
    <div data-testid="VendorOpencodeSection" className="px-3 py-1.5 space-y-3 text-[13px] text-text-secondary">
      {oauthError && (
        <div className="text-[11px] text-red-400 leading-relaxed">{oauthError}</div>
      )}

      {/* Active (added) providers */}
      <div className="space-y-1.5">
        <div className="text-[11px] text-text-muted uppercase tracking-wide">Added providers</div>
        {activeProviders.length === 0 && (
          <div className="text-[10px] text-text-muted/60 leading-relaxed">
            No providers added yet. Click “Add provider” to choose one.
          </div>
        )}
        {activeProviders.map((p) => {
          const isFree = p.authState === 'free'
          return (
            <div
              key={p.id}
              data-testid="VendorOpencodeSection.providerRow"
              data-id={p.id}
              className="border border-border/30 rounded-md p-2 flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-[12px] truncate">{p.name}</span>
                  {isFree ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
                      Free
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">
                      Authenticated
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-text-muted/60 truncate">
                  {p.id} · showing {allowlistLabel(p.id)}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => setModelDialogId(p.id)}
                  className="px-2 py-1 text-[11px] rounded bg-accent/15 hover:bg-accent/25 text-accent transition-colors"
                >
                  Manage models
                </button>
                <button
                  onClick={() => void handleRemove(p.id, isFree)}
                  disabled={removing[p.id]}
                  className="px-2 py-1 text-[11px] rounded hover:bg-bg-hover text-text-muted/70 hover:text-red-400 transition-colors disabled:opacity-40"
                >
                  {removing[p.id] ? '…' : 'Remove'}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Add provider */}
      {!pickerOpen ? (
        <button
          data-testid="VendorOpencodeSection.addProvider"
          onClick={() => {
            setPickerOpen(true)
            setAddSearch('')
            setAddingId(null)
          }}
          className="text-[11px] text-accent hover:text-accent/80 transition-colors"
        >
          + Add provider
        </button>
      ) : (
        <div className="border border-border/40 rounded-md p-2 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              autoFocus
              placeholder="Search providers (e.g. openrouter, anthropic, google)…"
              value={addSearch}
              onChange={(e) => setAddSearch(e.target.value)}
              className="flex-1 px-2 py-1 text-[11px] rounded bg-bg-input border border-border/40 text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent/60"
            />
            <button
              onClick={() => {
                setPickerOpen(false)
                setAddingId(null)
              }}
              className="text-[10px] text-text-muted/70 hover:text-text-primary transition-colors"
            >
              Close
            </button>
          </div>
          <div className="max-h-[280px] overflow-y-auto -mx-1">
            {addable.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-text-muted/60">No providers match.</div>
            ) : (
              addable.slice(0, 60).map((p) => {
                const opts = options[p.id] ?? []
                const apiOption = opts.find((o) => o.type === 'api')
                const oauthOptions = opts.filter((o) => o.type === 'oauth')
                const canOauth = p.authMethods.includes('oauth') && oauthOptions.length > 0
                const expanded = addingId === p.id
                return (
                  <div key={p.id} data-testid="VendorOpencodeSection.catalogRow" data-id={p.id} className="px-1 py-0.5">
                    <button
                      onClick={() => setAddingId(expanded ? null : p.id)}
                      className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-bg-hover transition-colors text-left cursor-default"
                    >
                      <span className="min-w-0">
                        <span className="text-[12px] text-text-secondary truncate block">
                          {p.name}
                        </span>
                        <span className="text-[10px] text-text-muted/50 truncate block">
                          {p.id}
                          {p.modelCount > 0 ? ` · ${p.modelCount} models` : ''}
                          {canOauth ? ' · OAuth' : ''}
                        </span>
                      </span>
                      <span className="text-[11px] text-accent shrink-0">
                        {expanded ? '−' : 'Add'}
                      </span>
                    </button>
                    {/* Free (credential-less) providers only ever show up here after
                        being removed (disabledProviders) — re-adding just needs the
                        un-disable in finishAdd, no OAuth / API key. */}
                    {expanded && p.authState === 'free' && (
                      <div className="px-2 pb-2 pt-1">
                        <button
                          data-testid="VendorOpencodeSection.addFree"
                          onClick={() => finishAdd(p.id)}
                          className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
                        >
                          Add — no credentials needed
                        </button>
                      </div>
                    )}
                    {expanded && p.authState !== 'free' && (
                      <div className="px-2 pb-2 pt-1 space-y-1.5">
                        {canOauth && (
                          <button
                            onClick={() => void handleOAuthStart(p.id)}
                            className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
                          >
                            {oauthOptions[0]?.label ?? 'Sign in with OAuth'}
                          </button>
                        )}
                        {/* API key (always offered for non-free providers — the
                            generic /auth path accepts a key even when the provider
                            has no custom auth loader, e.g. openrouter). */}
                        <div className="flex items-center gap-1.5">
                          <input
                            type="password"
                            placeholder={apiOption?.prompts?.[0]?.message ?? 'API key'}
                            value={apiKeys[p.id] ?? ''}
                            onChange={(e) =>
                              setApiKeys((prev) => ({ ...prev, [p.id]: e.target.value }))
                            }
                            className="flex-1 px-2 py-1 text-[11px] rounded bg-bg-input border border-border/40 text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent/60"
                          />
                          <button
                            onClick={() => void handleSaveKey(p.id)}
                            disabled={saving[p.id] || !(apiKeys[p.id] ?? '').trim()}
                            className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            {saving[p.id] ? 'Saving…' : 'Add'}
                          </button>
                        </div>

                        {vendorOAuth?.vendorId === p.id && vendorOAuth.stage === 'waiting' && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-text-muted/80">
                              Waiting for browser authorization…
                            </span>
                            <button
                              onClick={() => cancelVendorOAuth()}
                              className="px-2 py-0.5 text-[10px] rounded hover:bg-bg-hover text-text-muted/70 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                        {vendorOAuth?.vendorId === p.id && vendorOAuth.stage === 'error' && (
                          <div className="text-[10px] text-red-400">
                            Authentication failed. Try again.
                          </div>
                        )}

                        {oauthFlow.stage === 'instructions' && oauthFlow.vendorId === p.id && (
                          <div className="space-y-1.5">
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
                                onClick={() => {
                                  void window.api.vendorAuthOauthCancel('opencode').catch(() => {})
                                  setOauthFlow({ stage: 'idle' })
                                  setOauthCode('')
                                }}
                                className="px-2 py-1 text-[11px] rounded hover:bg-bg-hover text-text-muted transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                        {oauthFlow.stage === 'submitting' && oauthFlow.vendorId === p.id && (
                          <div className="text-[10px] text-text-muted/60">Submitting code…</div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}
            {addable.length > 60 && (
              <div className="px-2 py-1 text-[10px] text-text-muted/50">
                {addable.length - 60} more — refine your search.
              </div>
            )}
          </div>
        </div>
      )}

      <div className="text-[10px] text-text-muted/50 leading-relaxed">
        Credentials are stored in opencode&apos;s own auth.json. After adding a provider, pick
        which of its models appear in the picker via “Manage models”.
      </div>

      {dialogProvider && (
        <ModelAllowlistDialog
          providerId={dialogProvider.id}
          providerName={dialogProvider.name}
          current={allowlist[dialogProvider.id]}
          onClose={() => setModelDialogId(null)}
          onSave={(ids) => {
            updateCfg({ modelAllowlist: { ...allowlist, [dialogProvider.id]: ids } })
            setModelDialogId(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

// ── opencode Models section ──────────────────────────────────────────

/**
 * Default model + small model selects for the opencode engine.
 * Self-gates on opencode availability (mirrors OpencodeAutoModeSection).
 */
function OpencodeModelsSection(): React.JSX.Element {
  const [cfg, setCfg] = useState<OpencodeConfigSettings | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const installed = useOpencodeInstalled()

  useEffect(() => {
    window.api
      .loadOpencodeSettings()
      .then(setCfg)
      .catch(() => setCfg({}))
    window.api
      .getEngineModels()
      .then((groups) => {
        const oc = groups.filter((g) => g.engineId === 'opencode')
        setModels(oc.flatMap((g) => g.models))
      })
      .catch(() => {})
  }, [])

  if (cfg === null || installed === null) {
    return <div data-testid="OpencodeModelsSection" className="px-3 py-1.5 text-[13px] text-text-muted">Loading…</div>
  }
  if (!installed) {
    return (
      <div data-testid="OpencodeModelsSection" className="px-3 py-2 text-[12px] text-text-muted/70 leading-relaxed">
        opencode is not installed. Model settings apply to opencode sessions.
      </div>
    )
  }

  const update = (patch: Partial<OpencodeConfigSettings>): void => {
    const next: OpencodeConfigSettings = { ...cfg, ...patch }
    setCfg(next)
    window.api.saveOpencodeSettings(next).catch(() => {})
    // Mirror the default-model choice into the store so new/reopened opencode
    // sessions pick it up immediately, and refresh the picker model list.
    if ('model' in patch) {
      useSessionStore.getState().setOpencodeDefaultModel(patch.model || OPENCODE_DEFAULT_MODEL)
    }
    useSessionStore.getState().reloadModels()
  }

  const modelOptions = [
    { value: '', label: 'Default (use opencode default)' },
    ...models.map((m) => ({ value: m.value, label: m.displayName || m.value }))
  ]

  return (
    <div data-testid="OpencodeModelsSection" className="space-y-1">
      <div className="px-3 py-1.5 text-[13px] text-text-secondary">
        <div className="mb-1 flex items-center gap-1">
          Default model
          <InfoTooltip text="The primary model for opencode sessions. Format: provider/model-id, e.g. anthropic/claude-sonnet-4-6. Applies on next cwd spawn." />
        </div>
        <select
          value={cfg.model ?? ''}
          onChange={(e) => update({ model: e.target.value || undefined })}
          className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
        >
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="px-3 py-1.5 text-[13px] text-text-secondary">
        <div className="mb-1 flex items-center gap-1">
          Small model
          <InfoTooltip text="A cheaper/faster model used by opencode for lightweight tasks (titles, summaries). Format: provider/model-id." />
        </div>
        <select
          value={cfg.smallModel ?? ''}
          onChange={(e) => update({ smallModel: e.target.value || undefined })}
          className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
        >
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="px-3 pb-1 text-[10px] text-text-muted/50 leading-relaxed">
        Changes apply on the next opencode server start for each working directory.
      </div>
    </div>
  )
}

// ── opencode Providers section ───────────────────────────────────────

const inputClass =
  'bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors'

/**
 * A provider row carries two distinct identities:
 *   _key — stable React/list key + transient-state map key (apiKeys, expandedCaps);
 *          never changes during the session, so editing the provider id doesn't
 *          remount the row.
 *   _id  — the EDITABLE opencode provider id (the map key used at save time).
 */
type ProviderRow = OpencodeProviderSettings & { _key: string; _id: string }

/** Empty provider row factory — stable _key, blank editable id. */
function newProvider(): ProviderRow {
  return { _key: crypto.randomUUID(), _id: '', name: '', baseURL: '', models: [] }
}

/**
 * Custom OpenAI-compatible provider editor (self-hosted / compatible endpoints).
 * Built-in provider add/remove/auth + per-provider model curation lives in the
 * Providers manager (VendorOpencodeSection). API keys are set there, not here.
 */
function OpencodeProvidersSection(): React.JSX.Element {
  const [cfg, setCfg] = useState<OpencodeConfigSettings | null>(null)
  const installed = useOpencodeInstalled()
  // Local editing state for provider rows (has a transient _id key for React diffing)
  const [providerRows, setProviderRows] = useState<ProviderRow[]>([])
  // Which "provider._key / modelId" capability editors are expanded.
  const [expandedCaps, setExpandedCaps] = useState<Set<string>>(new Set())
  // Per-row API key input — TRANSIENT UI state only, keyed by the stable _key.
  // Never merged into the OpencodeConfigSettings payload (ADR-028: opencode.json
  // stays credential-free); saved separately to opencode's own auth.json via
  // vendor-auth:set-key, the same mechanism the Providers (catalog) section uses.
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [keyBusy, setKeyBusy] = useState<Record<string, boolean>>({})
  const [keyError, setKeyError] = useState<Record<string, string>>({})
  // Which vendor ids have stored credentials in opencode's auth.json — a
  // read-only file peek (vendor-auth:list-keys), NOT the auth probe: the probe
  // reports any declared custom provider as 'authenticated' whether or not it
  // has a key, which would hide the key input for fresh providers.
  const [credIds, setCredIds] = useState<Record<string, 'api' | 'oauth'>>({})

  const reloadCredIds = (): void => {
    window.api
      .vendorAuthListKeys('opencode')
      .then((ids) => setCredIds(ids))
      .catch(() => {})
  }

  useEffect(() => {
    window.api
      .loadOpencodeSettings()
      .then((settings) => {
        setCfg(settings)
        // Hydrate provider rows from saved config. The saved provider id becomes
        // both the stable _key and the editable _id.
        const saved = settings.providers ?? {}
        const rows: ProviderRow[] = Object.entries(saved).map(([id, p]) => ({
          _key: id,
          _id: id,
          name: p.name ?? '',
          baseURL: p.baseURL ?? '',
          models: p.models ?? []
        }))
        setProviderRows(rows)
      })
      .catch(() => setCfg({}))
    reloadCredIds()
  }, [])

  if (cfg === null || installed === null) {
    return <div data-testid="OpencodeProvidersSection" className="px-3 py-1.5 text-[13px] text-text-muted">Loading…</div>
  }
  if (!installed) {
    return (
      <div data-testid="OpencodeProvidersSection" className="px-3 py-2 text-[12px] text-text-muted/70 leading-relaxed">
        opencode is not installed. Provider settings apply to opencode sessions.
      </div>
    )
  }

  const saveProviders = (rows: ProviderRow[]): void => {
    // Reconstruct providers Record from rows. The Record is keyed by the editable
    // provider id (_id). Rows with an empty id are skipped. Model id/name flow
    // through this projection writer (ADR-031 leaf merge); model CAPABILITY fields
    // are written separately via patchOpencodeNative and are preserved here.
    const providers: Record<string, OpencodeProviderSettings> = {}
    for (const row of rows) {
      if (!row._id.trim()) continue
      const models = (row.models ?? [])
        .filter((m) => m.id.trim())
        .map((m) => (m.name?.trim() ? { id: m.id.trim(), name: m.name.trim() } : { id: m.id.trim() }))
      const entry: OpencodeProviderSettings = {}
      if (row.name) entry.name = row.name
      if (row.baseURL) entry.baseURL = row.baseURL
      if (models.length > 0) entry.models = models
      providers[row._id] = entry
    }
    const next: OpencodeConfigSettings = {
      ...cfg,
      providers: Object.keys(providers).length > 0 ? providers : undefined
    }
    setCfg(next)
    window.api.saveOpencodeSettings(next).catch(() => {})
    // Custom-provider edits change the discoverable model set — reload the picker.
    useSessionStore.getState().reloadModels()
  }

  const updateRow = (key: string, patch: Partial<ProviderRow>): void => {
    const next = providerRows.map((r) => (r._key === key ? { ...r, ...patch } : r))
    setProviderRows(next)
    saveProviders(next)
  }

  const addModel = (key: string): void => {
    const next = providerRows.map((r) =>
      r._key === key ? { ...r, models: [...(r.models ?? []), { id: '' }] } : r
    )
    setProviderRows(next)
    // No save yet — an empty-id model is skipped by saveProviders anyway.
  }

  const updateModel = (key: string, idx: number, patch: { id?: string; name?: string }): void => {
    const next = providerRows.map((r) =>
      r._key === key
        ? { ...r, models: (r.models ?? []).map((m, i) => (i === idx ? { ...m, ...patch } : m)) }
        : r
    )
    setProviderRows(next)
    saveProviders(next)
  }

  const removeModel = (key: string, idx: number): void => {
    const next = providerRows.map((r) =>
      r._key === key ? { ...r, models: (r.models ?? []).filter((_, i) => i !== idx) } : r
    )
    setProviderRows(next)
    saveProviders(next)
  }

  const toggleCaps = (capKey: string): void => {
    setExpandedCaps((prev) => {
      const n = new Set(prev)
      if (n.has(capKey)) n.delete(capKey)
      else n.add(capKey)
      return n
    })
  }

  const addRow = (): void => {
    const row = newProvider()
    const next = [...providerRows, row]
    setProviderRows(next)
  }

  const removeRow = (key: string): void => {
    const next = providerRows.filter((r) => r._key !== key)
    setProviderRows(next)
    saveProviders(next)
    setApiKeys((prev) => {
      const n = { ...prev }
      delete n[key]
      return n
    })
    setKeyBusy((prev) => {
      const n = { ...prev }
      delete n[key]
      return n
    })
    setKeyError((prev) => {
      const n = { ...prev }
      delete n[key]
      return n
    })
  }

  /** Save the transient per-row API key to opencode's own auth.json (never opencode.json). */
  const saveProviderKey = async (row: ProviderRow): Promise<void> => {
    const id = row._id.trim()
    const key = (apiKeys[row._key] ?? '').trim()
    if (!id || !key) return
    setKeyBusy((prev) => ({ ...prev, [row._key]: true }))
    setKeyError((prev) => {
      const n = { ...prev }
      delete n[row._key]
      return n
    })
    try {
      await window.api.vendorAuthSetKey('opencode', id, key)
      setApiKeys((prev) => ({ ...prev, [row._key]: '' }))
      reloadCredIds()
    } catch {
      setKeyError((prev) => ({ ...prev, [row._key]: 'Failed to save key.' }))
    } finally {
      setKeyBusy((prev) => ({ ...prev, [row._key]: false }))
    }
  }

  /** Remove credentials for a custom provider id from opencode's auth.json. */
  const removeProviderKey = async (row: ProviderRow): Promise<void> => {
    const id = row._id.trim()
    if (!id) return
    setKeyBusy((prev) => ({ ...prev, [row._key]: true }))
    setKeyError((prev) => {
      const n = { ...prev }
      delete n[row._key]
      return n
    })
    try {
      await window.api.vendorAuthRemove('opencode', id)
      reloadCredIds()
    } catch {
      setKeyError((prev) => ({ ...prev, [row._key]: 'Failed to remove key.' }))
    } finally {
      setKeyBusy((prev) => ({ ...prev, [row._key]: false }))
    }
  }

  return (
    <div data-testid="OpencodeProvidersSection" className="space-y-3 px-3 py-1.5 text-[13px] text-text-secondary">
      {/* Custom providers editor */}
      <div className="space-y-2">
        <div className="text-[11px] text-text-muted uppercase tracking-wide">
          Custom providers (OpenAI-compatible)
        </div>
        <div className="text-[10px] text-text-muted/60 leading-relaxed">
          Add self-hosted or compatible endpoints. API keys entered here are stored in
          opencode&apos;s own auth.json — the <em>Providers</em> section remains the place to add
          and authenticate catalog providers.
        </div>
        {providerRows.map((row) => {
          const id = row._id.trim()
          const hasKey = id.length > 0 && credIds[id] !== undefined
          const busy = keyBusy[row._key] ?? false
          const error = keyError[row._key]
          return (
            <div key={row._key} data-testid="OpencodeProvidersSection.providerRow" data-id={row._key} className="border border-border/30 rounded-md p-2 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  placeholder="Provider id (e.g. my-ollama)"
                  value={row._id}
                  onChange={(e) => updateRow(row._key, { _id: e.target.value })}
                  className={`${inputClass} flex-1`}
                />
                <button
                  onClick={() => removeRow(row._key)}
                  className="text-[10px] text-text-muted/60 hover:text-red-400 transition-colors px-1"
                  title="Remove provider"
                >
                  ✕
                </button>
              </div>
              <input
                type="text"
                placeholder="Display name (optional)"
                value={row.name ?? ''}
                onChange={(e) => updateRow(row._key, { name: e.target.value })}
                className={`${inputClass} w-full`}
              />
              <input
                type="url"
                placeholder="Base URL (e.g. http://localhost:11434/v1)"
                value={row.baseURL ?? ''}
                onChange={(e) => updateRow(row._key, { baseURL: e.target.value })}
                className={`${inputClass} w-full`}
              />
              <div>
                <div className="text-[10px] text-text-muted mb-0.5">API key (optional)</div>
                {hasKey ? (
                  <div className="flex items-center gap-1.5">
                    <span
                      data-testid="OpencodeProvidersSection.keyStatus"
                      data-id={row._key}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400"
                    >
                      Key set
                    </span>
                    <button
                      data-testid="OpencodeProvidersSection.removeKey"
                      data-id={row._key}
                      onClick={() => void removeProviderKey(row)}
                      disabled={busy}
                      className="text-[10px] text-text-muted/60 hover:text-red-400 transition-colors disabled:opacity-40"
                    >
                      {busy ? 'Removing…' : 'Remove key'}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="password"
                      data-testid="OpencodeProvidersSection.apiKey"
                      data-id={row._key}
                      placeholder="API key"
                      value={apiKeys[row._key] ?? ''}
                      onChange={(e) =>
                        setApiKeys((prev) => ({ ...prev, [row._key]: e.target.value }))
                      }
                      className={`${inputClass} flex-1`}
                    />
                    <button
                      onClick={() => void saveProviderKey(row)}
                      disabled={busy || !id || !(apiKeys[row._key] ?? '').trim()}
                      className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {busy ? 'Saving…' : 'Save key'}
                    </button>
                  </div>
                )}
                {error && <div className="text-[10px] text-red-400 mt-0.5">{error}</div>}
              </div>
              <div className="space-y-1.5">
                <div className="text-[10px] text-text-muted">Models (optional)</div>
                {(row.models ?? []).map((m, idx) => {
                  const modelId = m.id.trim()
                  const capKey = `${row._key}/${idx}`
                  const capsOpen = expandedCaps.has(capKey)
                  const canEditCaps = id.length > 0 && modelId.length > 0
                  return (
                    <div
                      key={idx}
                      data-testid="OpencodeProvidersSection.modelRow"
                      data-id={capKey}
                      className="border border-border/20 rounded p-1.5 space-y-1"
                    >
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          placeholder="Model id (e.g. llama3.2)"
                          value={m.id}
                          onChange={(e) => updateModel(row._key, idx, { id: e.target.value })}
                          className={`${inputClass} flex-1`}
                        />
                        <input
                          type="text"
                          placeholder="Display name"
                          value={m.name ?? ''}
                          onChange={(e) => updateModel(row._key, idx, { name: e.target.value })}
                          className={`${inputClass} flex-1`}
                        />
                        <button
                          type="button"
                          data-testid="OpencodeProvidersSection.removeModel"
                          data-id={capKey}
                          onClick={() => removeModel(row._key, idx)}
                          className="text-[10px] text-text-muted/60 hover:text-red-400 transition-colors px-1"
                          title="Remove model"
                        >
                          ✕
                        </button>
                      </div>
                      {canEditCaps ? (
                        <button
                          type="button"
                          data-testid="OpencodeProvidersSection.toggleCaps"
                          data-id={capKey}
                          onClick={() => toggleCaps(capKey)}
                          className="text-[10px] text-accent hover:text-accent/80 transition-colors"
                        >
                          {capsOpen ? '▾ Capabilities' : '▸ Capabilities'}
                        </button>
                      ) : (
                        <div className="text-[10px] text-text-muted/50">
                          Set a provider id and model id to edit capabilities.
                        </div>
                      )}
                      {canEditCaps && capsOpen && (
                        <ModelCapabilityEditor providerId={row._id.trim()} modelId={modelId} />
                      )}
                    </div>
                  )
                })}
                <button
                  type="button"
                  data-testid="OpencodeProvidersSection.addModel"
                  data-id={row._key}
                  onClick={() => addModel(row._key)}
                  className="text-[11px] text-accent hover:text-accent/80 transition-colors"
                >
                  + Add model
                </button>
              </div>
            </div>
          )
        })}
        <button
          data-testid="OpencodeProvidersSection.addProvider"
          onClick={addRow}
          className="text-[11px] text-accent hover:text-accent/80 transition-colors"
        >
          + Add provider
        </button>
      </div>

      <div className="text-[10px] text-text-muted/50 leading-relaxed">
        Add, remove, and authenticate built-in providers under <em>Providers</em>. Changes apply on
        the next opencode server start for each working directory.
      </div>
    </div>
  )
}

// ── opencode raw-config (schema-driven) editing ─────────────────────

const OPENCODE_SCHEMA_DEFS = (opencodeConfigSchema as { $defs: SchemaDefs }).$defs
const OPENCODE_CONFIG_NODE = OPENCODE_SCHEMA_DEFS.Config as SchemaNode
/** The provider-model entry schema: $defs.ProviderConfig.properties.models.additionalProperties */
const OPENCODE_MODEL_ENTRY_SCHEMA = (
  (
    (OPENCODE_SCHEMA_DEFS.ProviderConfig as SchemaNode).properties as Record<string, SchemaNode>
  ).models as SchemaNode
).additionalProperties as SchemaNode
/** Model capability fields the provider editor exposes (raw opencode names). */
const MODEL_CAP_KEYS = ['attachment', 'reasoning', 'temperature', 'tool_call', 'modalities', 'cost', 'limit']

/**
 * Top-level Config keys owned by a DEDICATED UI (rendered as read-only pointers in
 * the raw editor, never editable there). `provider` is patch-writable via the
 * per-model capability editor, but curated as a whole under Custom providers.
 */
const CONFIG_POINTER_KEYS: Record<string, string> = {
  model: 'Models',
  small_model: 'Models',
  disabled_providers: 'Providers',
  enabled_providers: 'Providers',
  provider: 'Custom providers',
  agent: 'Agents',
  mcp: 'injected at spawn',
  permission: 'Autonomy mode'
}
/** Config keys the raw editor never renders as editable fields. */
const CONFIG_EXCLUDED_KEYS = new Set(['$schema', ...Object.keys(CONFIG_POINTER_KEYS)])

/**
 * Per-model capability editor. Reads the model's raw entry from opencode's config
 * file, edits it via the schema-driven form, and saves ONLY changed leaves through
 * patchOpencodeNative (e.g. ['provider','ec2','models','qwen3.6:27b','attachment']).
 * Composes with the projection writer (saveOpencodeSettings) that owns id/name —
 * both are leaf-scoped so neither clobbers the other.
 */
function ModelCapabilityEditor({
  providerId,
  modelId
}: {
  providerId: string
  modelId: string
}): React.JSX.Element {
  const [original, setOriginal] = useState<Record<string, unknown> | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(() => {
    window.api
      .readOpencodeNativeRaw()
      .then(({ config }) => {
        const prov = (config.provider as Record<string, unknown> | undefined)?.[providerId] as
          | Record<string, unknown>
          | undefined
        const models = prov?.models as Record<string, unknown> | undefined
        const entry = (models?.[modelId] as Record<string, unknown> | undefined) ?? {}
        setOriginal(entry)
        setDraft(structuredClone(entry))
      })
      .catch(() => {
        setOriginal({})
        setDraft({})
      })
  }, [providerId, modelId])
  useEffect(() => load(), [load])

  if (original === null) {
    return <div className="text-[10px] text-text-muted/60 px-1">Loading capabilities…</div>
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(original)
  const handleSave = async (): Promise<void> => {
    const patches = diffToPatches(original, draft, ['provider', providerId, 'models', modelId])
    if (patches.length === 0) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await window.api.patchOpencodeNative(patches)
      load()
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
      useSessionStore.getState().reloadModels()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      data-testid="ModelCapabilityEditor"
      data-id={`${providerId}/${modelId}`}
      className="rounded bg-bg-primary/30 p-1.5 space-y-1"
    >
      <OpencodeSchemaForm
        schema={OPENCODE_MODEL_ENTRY_SCHEMA}
        defs={OPENCODE_SCHEMA_DEFS}
        value={draft}
        onChange={setDraft}
        pickKeys={MODEL_CAP_KEYS}
        keyPrefix={`${providerId}.${modelId}`}
      />
      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          data-testid="ModelCapabilityEditor.save"
          disabled={!dirty || saving}
          onClick={() => void handleSave()}
          className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving…' : 'Save capabilities'}
        </button>
        {saved && <span className="text-[10px] text-success">Saved</span>}
        {error && (
          <span
            data-testid="ModelCapabilityEditor.error"
            className="text-[10px] text-red-400 truncate max-w-[240px]"
            title={error}
          >
            {error}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * "Configuration (opencode.json)" — schema-driven editor over the top-level
 * opencode Config, EXCLUDING keys owned by dedicated UIs (rendered as pointers).
 * Loads the raw config on mount, accumulates edits locally, and on Save computes
 * a deep diff → leaf patches → patchOpencodeNative. ajv errors surface inline.
 */
function OpencodeRawConfigSection(): React.JSX.Element {
  const installed = useOpencodeInstalled()
  const [original, setOriginal] = useState<Record<string, unknown> | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [filePath, setFilePath] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(() => {
    window.api
      .readOpencodeNativeRaw()
      .then(({ config, path }) => {
        setOriginal(config)
        setDraft(structuredClone(config))
        setFilePath(path)
      })
      .catch(() => {
        setOriginal({})
        setDraft({})
      })
  }, [])
  useEffect(() => load(), [load])

  if (installed === null || original === null) {
    return (
      <div data-testid="OpencodeRawConfigSection" className="px-3 py-1.5 text-[13px] text-text-muted">
        Loading…
      </div>
    )
  }
  if (!installed) {
    return (
      <div
        data-testid="OpencodeRawConfigSection"
        className="px-3 py-2 text-[12px] text-text-muted/70 leading-relaxed"
      >
        opencode is not installed. This edits opencode&apos;s own config file.
      </div>
    )
  }

  const configProps = (OPENCODE_CONFIG_NODE.properties as Record<string, SchemaNode>) ?? {}
  const pickKeys = Object.keys(configProps).filter((k) => !CONFIG_EXCLUDED_KEYS.has(k))
  const pointerKeys = Object.keys(configProps).filter((k) => k in CONFIG_POINTER_KEYS)

  const dirty = JSON.stringify(draft) !== JSON.stringify(original)
  const handleSave = async (): Promise<void> => {
    const patches = diffToPatches(original, draft)
    if (patches.length === 0) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await window.api.patchOpencodeNative(patches)
      const { config } = await window.api.readOpencodeNativeRaw()
      setOriginal(config)
      setDraft(structuredClone(config))
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      data-testid="OpencodeRawConfigSection"
      className="px-3 py-1.5 space-y-2 text-[13px] text-text-secondary"
    >
      <div className="text-[10px] text-text-muted/60 leading-relaxed">
        Edit opencode&apos;s own config file directly ({filePath || 'opencode.jsonc'}). Saves touch
        only the fields you change — comments and keys not listed here are preserved.
      </div>
      <OpencodeSchemaForm
        schema={OPENCODE_CONFIG_NODE}
        defs={OPENCODE_SCHEMA_DEFS}
        value={draft}
        onChange={setDraft}
        pickKeys={pickKeys}
      />
      {pointerKeys.length > 0 && (
        <div className="border-t border-border/20 pt-1.5 space-y-0.5">
          {pointerKeys.map((k) => (
            <div
              key={k}
              data-testid="OpencodeRawConfigSection.pointer"
              data-id={k}
              className="flex items-center justify-between text-[10px] text-text-muted/60 px-3"
            >
              <span className="font-mono text-text-muted">{k}</span>
              <span>managed in {CONFIG_POINTER_KEYS[k]}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 px-3 pt-1">
        <button
          type="button"
          data-testid="OpencodeRawConfigSection.save"
          disabled={!dirty || saving}
          onClick={() => void handleSave()}
          className="px-2.5 py-1 text-[11px] font-medium text-accent hover:text-accent-hover bg-accent/10 hover:bg-accent/15 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-[11px] text-success">Saved</span>}
        {error && (
          <span
            data-testid="OpencodeRawConfigSection.error"
            className="text-[11px] text-red-400 truncate max-w-[360px]"
            title={error}
          >
            {error}
          </span>
        )}
      </div>
    </div>
  )
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
        key: 'vendorAnthropicEndpoint',
        label: 'Endpoint & model override',
        keywords: 'anthropic endpoint model override vendor gateway custom url api token',
        render: (_s, _u, _e, _ue, v, uv) => (
          <VendorAnthropicEditableForm vendorConfig={v} updateVendorConfig={uv} />
        )
      }
    ]
  },
  {
    id: 'vendor-opencode',
    label: 'Providers',
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
        label: 'Providers & models',
        keywords:
          'opencode provider add auth api key oauth login openai google anthropic openrouter model allowlist enable disable',
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
    id: 'claude-dispatch',
    label: 'Cross-engine dispatch',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 3l4 4-4 4" />
        <path d="M21 7H9a4 4 0 00-4 4v1" />
        <path d="M7 21l-4-4 4-4" />
        <path d="M3 17h12a4 4 0 004-4v-1" />
      </svg>
    ),
    items: [
      {
        key: 'claudeDispatch',
        label: 'Cross-engine dispatch',
        keywords:
          'claude dispatch cross engine agent delegate collab model allowlist default sonnet haiku opus',
        render: () => <ClaudeDispatchSection />
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
  },
  {
    id: 'opencode-models',
    label: 'Models',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeModels',
        label: 'Default model',
        keywords: 'opencode model default small fast cheap provider',
        render: () => <OpencodeModelsSection />
      }
    ]
  },
  {
    id: 'opencode-dispatch',
    label: 'Cross-engine dispatch',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 3l4 4-4 4" />
        <path d="M21 7H9a4 4 0 00-4 4v1" />
        <path d="M7 21l-4-4 4-4" />
        <path d="M3 17h12a4 4 0 004-4v-1" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeDispatch',
        label: 'Cross-engine dispatch',
        keywords:
          'opencode dispatch cross engine agent delegate collab gpt gemini model allowlist default',
        render: () => <OpencodeDispatchSection />
      }
    ]
  },
  {
    id: 'opencode-config',
    label: 'Configuration',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeConfig',
        label: 'Configuration (opencode.json)',
        keywords:
          'opencode config raw schema attachment modalities tool_call reasoning cost limit instructions layout formatter lsp advanced',
        render: () => <OpencodeRawConfigSection />
      }
    ]
  },
  {
    id: 'opencode-providers',
    label: 'Custom providers',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
        <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeProviders',
        label: 'Custom providers',
        keywords: 'opencode provider custom openai compatible self-hosted disable enable base url ollama',
        render: () => <OpencodeProvidersSection />
      }
    ]
  },
  {
    id: 'opencode-agents',
    label: 'Agents',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="4" />
        <path d="M20 21a8 8 0 10-16 0" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeAgents',
        label: 'Agent overrides',
        keywords: 'opencode agent model temperature build plan general explore override',
        render: () => <OpencodeAgentsSection />
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
  'permissions', 'sandbox', 'proxy', 'claude-dispatch'
])

/** Section ids that belong to Engines > opencode (content self-gates on install) */
const ENGINE_OPENCODE_SECTION_IDS = new Set(['opencode-automode', 'opencode-models', 'opencode-dispatch', 'opencode-config'])

/** Section ids that belong to Vendors > Anthropic */
const VENDOR_ANTHROPIC_SECTION_IDS = new Set([
  'vendor-anthropic', 'effortDefaults'
])

/** Section ids that belong to Vendors > opencode (gated: only shown when opencode engine installs) */
const VENDOR_OPENCODE_SECTION_IDS = new Set(['vendor-opencode', 'opencode-providers'])

/** Section ids that belong to opencode Agents subgroup */
const AGENTS_OPENCODE_SECTION_IDS = new Set(['opencode-agents'])

/** Section ids that belong to Accounts (flat) */
const ACCOUNTS_SECTION_IDS = new Set(['accounts'])

function getSectionsForIds(ids: Set<string>, order?: string[]): Section[] {
  if (!order) return SECTIONS.filter((s) => ids.has(s.id))
  return order
    .filter((id) => ids.has(id))
    .map((id) => SECTIONS.find((s) => s.id === id)!)
    .filter(Boolean)
}

// ── Scoped navigation (Option A, ADR settings-ia-refactor) ──────────

export type SettingsScope = 'common' | 'claude' | 'opencode'

export interface ScopeSubgroup {
  id: string
  label?: string // undefined = flat (no header)
  sections: Section[]
}

export interface ScopeDef {
  id: SettingsScope
  label: string
  subgroups: ScopeSubgroup[]
}

/**
 * Ordered scope→section mapping. This is the authoritative section order
 * within each scope (fixes the flat SECTIONS order divergence bug).
 */
export const SCOPES: ScopeDef[] = [
  {
    id: 'common',
    label: 'Common',
    subgroups: [
      {
        id: 'common-app',
        label: undefined,
        sections: getSectionsForIds(APP_SECTION_IDS, [
          'appearance', 'chat', 'session', 'tool-output', 'diff', 'git',
          'status-line', 'usage', 'logging', 'voice', 'remote', 'mockup'
        ])
      }
    ]
  },
  {
    id: 'claude',
    label: 'Claude',
    subgroups: [
      {
        id: 'claude-engine',
        label: 'Engine',
        sections: getSectionsForIds(ENGINE_CLAUDE_SECTION_IDS, [
          'permissions', 'sandbox', 'proxy', 'claude-dispatch'
        ])
      },
      {
        id: 'claude-vendor',
        label: 'Vendor · Anthropic',
        sections: getSectionsForIds(VENDOR_ANTHROPIC_SECTION_IDS, ['vendor-anthropic', 'effortDefaults'])
      },
      {
        id: 'claude-account',
        label: 'Account',
        sections: getSectionsForIds(ACCOUNTS_SECTION_IDS, ['accounts'])
      }
    ]
  },
  {
    id: 'opencode',
    label: 'opencode',
    subgroups: [
      {
        id: 'opencode-engine',
        label: 'Engine',
        sections: getSectionsForIds(ENGINE_OPENCODE_SECTION_IDS, ['opencode-automode', 'opencode-models', 'opencode-dispatch', 'opencode-config'])
      },
      {
        id: 'opencode-vendor',
        label: 'Vendor',
        sections: getSectionsForIds(VENDOR_OPENCODE_SECTION_IDS, ['vendor-opencode', 'opencode-providers'])
      },
      {
        id: 'opencode-agents',
        label: 'Agents',
        sections: getSectionsForIds(AGENTS_OPENCODE_SECTION_IDS, ['opencode-agents'])
      }
    ]
  }
]

/** Map from section id → scope id, for search + selection logic */
export const SECTION_SCOPE_MAP: ReadonlyMap<string, SettingsScope> = new Map(
  SCOPES.flatMap((scope) =>
    scope.subgroups.flatMap((sg) =>
      sg.sections.map((sec): [string, SettingsScope] => [sec.id, scope.id])
    )
  )
)

// ── Per-section capability gating (ROADMAP #12) ──────────────────────
//
// A section listed here renders only when the scope's engine has the named
// EngineCapabilities flag. Sections NOT listed are always visible. Today only
// the Claude launch-param sections are gated; Claude has both flags true, so
// there is no user-visible change — the gating is structure-ready for an engine
// that lacks sandbox/proxy (or for surfacing one of these under opencode later).

/** Boolean EngineCapabilities keys that can gate a section. */
type GatingCapability = 'sandbox' | 'proxy'

/** sectionId → the EngineCapabilities flag it requires (absent = always shown). */
export const SECTION_CAPABILITY: Readonly<Record<string, GatingCapability>> = {
  sandbox: 'sandbox',
  proxy: 'proxy'
}

/** Static per-engine capabilities for a settings scope ('common' = engine-agnostic → null). */
export function scopeCapabilities(scope: SettingsScope): EngineCapabilities | null {
  return scope === 'common' ? null : engineMeta(scope).capabilities
}

/**
 * Whether a section should render, given the scope's engine capabilities.
 * Gated sections hide when the engine lacks the capability; ungated sections
 * (and the engine-agnostic 'common' scope, caps=null) always show.
 */
export function isSectionVisible(sectionId: string, caps: EngineCapabilities | null): boolean {
  const flag = SECTION_CAPABILITY[sectionId]
  if (!flag || !caps) return true
  return caps[flag] === true
}
