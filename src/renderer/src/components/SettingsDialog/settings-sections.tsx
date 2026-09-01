import { useState, useEffect, useCallback } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import type { AppSettings } from '../../stores/session-store'
import { PermissionsDialog } from '../PermissionsDialog'
import {
  OAuthOutcomeNotice,
  OAuthPasteBackFlow,
  classifyOAuthError
} from '../auth/OAuthPasteBackFlow'
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
  AutoModeConfig,
  DispatchConfig,
  ModelInfo,
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
import { AUTONOMY_TO_PERMISSION, AUTONOMY_LABELS } from '../../../../shared/permission-modes'
import {
  SettingsToggle,
  SettingsSlider,
  SettingsSelect,
  SettingsTextarea,
  SandboxListSetting,
  ChatRetentionSetting,
  InfoTooltip
} from './settings-controls'
import { ModelPicker } from '../shared/InlinePickers'
import { toModelDisplays, selectedModelDisplay, StaleModelNotice } from './settings-model-display'
import { SelectMenu } from '../shared/SelectMenu'
import { OpencodeAgentsSection } from './OpencodeAgents'
import { RemoteServerSettings } from './RemoteServerSettings'
import { PiVendors } from './PiVendors'
import { SharedProviders } from './SharedProviders'
import { VendorOpencodeSection } from './OpencodeProviders'
import { OpencodeSchemaForm, type SchemaDefs, type SchemaNode } from './OpencodeSchemaForm'
import { useOpencodeInstalled, usePiInstalled } from './use-engine-installed'
import {
  OpencodeSessionBehaviorSection,
  OpencodeToolOutputSection,
  OpencodeAttachmentsSection,
  OpencodeWorkspaceSection,
  OpencodeToolsSection,
  OpencodeDiagnosticsSection,
  OpencodeManagedKeysSection
} from './OpencodeConfigPanes'
import {
  PiSessionBehaviorSection,
  PiModelsSection,
  PiToolsSection,
  PiImagesSection,
  PiWorkspaceSection,
  PiNetworkSection,
  PiRawConfigSection
} from './PiConfigPanes'
import { diffToPatches } from '../../../../shared/opencode-config-diff'
import opencodeConfigSchema from '../../../../shared/opencode-config-schema.1.18.23.json'

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
    <div
      data-testid="GlobalPermissionsSummary"
      className="px-3 py-1.5 text-[13px] text-text-secondary"
    >
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
    <div
      data-testid="ModelEffortRow"
      data-id={modelId}
      className="pl-4 px-3 py-1.5 text-[13px] text-text-secondary"
    >
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span>{modelLabel}</span>
        <span className="text-[10px] text-text-muted/50">{modelId}</span>
      </div>
      <SelectMenu
        testid="ModelEffortRow.effort"
        value={current ?? ''}
        onChange={(v) => onChange(v === '' ? undefined : (v as EffortLevel))}
        options={[
          { value: '', label: `Default (${EFFORT_LEVEL_LABEL[fallback]})` },
          ...levels.map((lvl) => ({ value: lvl, label: EFFORT_LEVEL_LABEL[lvl] }))
        ]}
      />
    </div>
  )
}

// ── Accounts (multi-account support, ADR-015) ────────────────────────

/**
 * Adding an account starts a Claude login. On DESKTOP the host opens its own
 * browser and nothing more is needed here. On WEB (ADR-057 / S4-UI) the host
 * opens nothing: `account:add` returns the flow's `pendingSignIn` snapshot, we
 * fold it into the store's `authState` — the SAME field AuthBanner drives, so
 * there is still exactly one Claude-flow state — and the shared paste-back flow
 * finishes it through `submitOAuthCode`.
 */
function AccountsSetting(): React.JSX.Element {
  const accounts = useSessionStore((s) => s.accountsState)
  const setAccounts = useSessionStore((s) => s.setAccountsState)
  const authState = useSessionStore((s) => s.authState)
  const setAuthState = useSessionStore((s) => s.setAuthState)
  const submitOAuthCode = useSessionStore((s) => s.submitOAuthCode)
  const cancelSignIn = useSessionStore((s) => s.cancelSignIn)
  const [busy, setBusy] = useState(false)
  const [submittingCode, setSubmittingCode] = useState(false)

  useEffect(() => {
    void window.api.getAccounts().then(setAccounts)
  }, [setAccounts])

  const enabled = accounts?.enabled ?? false
  const isMac = window.api.platform === 'darwin'
  const isWeb = window.api.platform === 'web'
  const pasteBack = isWeb && authState?.status === 'authorizing'

  const run = async (fn: () => Promise<AccountsState>): Promise<void> => {
    setBusy(true)
    try {
      const next = await fn()
      setAccounts(next)
      // Only `account:add` on a remote connection ever carries this.
      if (next.pendingSignIn) setAuthState(next.pendingSignIn)
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

          {pasteBack && (
            <div
              data-testid="AccountsSetting.signInFlow"
              className="mt-1.5 rounded-md border border-border/40 bg-bg-secondary/40 p-2.5 space-y-2"
            >
              <OAuthPasteBackFlow
                variant="code"
                url={authState?.manualUrl}
                busy={submittingCode}
                onSubmit={(pasted) => {
                  setSubmittingCode(true)
                  void submitOAuthCode(pasted)
                    .then(() => void window.api.getAccounts().then(setAccounts))
                    .finally(() => setSubmittingCode(false))
                }}
                onCancel={() => void cancelSignIn()}
              />
            </div>
          )}
          {isWeb && authState?.status === 'error' && authState.error && (
            <OAuthOutcomeNotice
              kind={classifyOAuthError(authState.error)}
              message={authState.error}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ── Autonomy mode picker ─────────────────────────────────────────────

export function AutonomyModePicker(): React.JSX.Element {
  const setDefaultPermissionMode = useSessionStore((s) => s.setDefaultPermissionMode)
  const currentMode = useSessionStore((s) => s.settings.defaultAutonomyMode)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const availableModes = CLAUDE_ENGINE_CAPABILITIES.autonomyModes

  const handleChange = (mode: AutonomyMode): void => {
    // ClaudeUI-owned, engine-neutral, and deliberately NOT written back to
    // `~/.claude/settings.json`: this governs opencode and pi sessions too, and
    // editing it here should not change how the user's bare `claude` CLI
    // behaves. Claude's own `defaultMode` is read once, to seed this.
    updateSettings({ defaultAutonomyMode: mode })
    // Bootstrap-only for every engine: mirror into the store so sessions created
    // later in this run start in it without an app restart.
    setDefaultPermissionMode(AUTONOMY_TO_PERMISSION[mode])
  }

  return (
    <div data-testid="AutonomyModePicker" className="px-3 py-1.5 text-[13px] text-text-secondary">
      <div className="mb-0.5">Autonomy mode</div>
      <div className="mb-1.5 text-[11px] text-text-muted">
        Applies to new sessions on every engine. Running sessions keep their own mode — change it
        from the mode control next to the chat input.
      </div>
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
              onChange={() => handleChange(mode)}
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
//
// `useEngineInstalled` / `useOpencodeInstalled` / `usePiInstalled` moved to
// ./use-engine-installed (imported above). They gate engine-scoped sections on
// a cheap, deterministic binary-on-disk check that NEVER spawns a
// server/process — the earlier `vendorAuthProbe`/`getEngineModels` approaches
// needed a successful spawn + HTTP round-trip, so any transient spawn failure
// hid the very sections that configure the engine.

// ── opencode auto-mode (Full) LLM gatekeeper settings (ADR-023) ──────

const TWO_STAGE_OPTIONS: { value: 'both' | 'fast' | 'thinking'; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'fast', label: 'Fast' },
  { value: 'thinking', label: 'Thinking' }
]

/** Label for the judge-model picker's "no explicit choice" row (judgeModel unset). */
const JUDGE_MODEL_DEFAULT_LABEL = 'Same as session model (default)'
/** Label for the dispatch default-model picker's "no explicit choice" row. */
const DISPATCH_MODEL_DEFAULT_LABEL = '(not set)'
/** Label for the opencode default/small model pickers' "no explicit choice" row. */
const OPENCODE_MODEL_DEFAULT_LABEL = 'Default (use opencode default)'

/** The `AutoModeConfig` keys that hold a classifier trust/protection list. */
type TrustListKey = 'trustedDomains' | 'trustedRegistries' | 'protectedPatterns'

/**
 * The three trust lists spliced into the classifier environment
 * (src/main/automode/rules/policy.ts). Each `description` states what an EMPTY
 * list means, because for all three that is the load-bearing, non-obvious half
 * of the semantics — and for `protectedPatterns` a non-empty list REPLACES a
 * built-in heuristic rather than adding to it.
 */
const TRUST_LISTS: ReadonlyArray<{
  key: TrustListKey
  label: string
  placeholder: string
  tooltip: string
  description: string
}> = [
  {
    key: 'trustedDomains',
    label: 'Trusted domains',
    placeholder: 'files.example.com',
    tooltip:
      'External destinations the judge may treat as safe to reach or send data to (web fetch, uploads, curl targets). Host names, not URLs.',
    description: 'Empty = no external destination is trusted.'
  },
  {
    key: 'trustedRegistries',
    label: 'Trusted package registries',
    placeholder: 'https://npm.internal.example',
    tooltip:
      'Registries the judge may treat as safe to install from. Anything else is an untrusted supply-chain source.',
    description: "Empty = only the project manifest's default registry."
  },
  {
    key: 'protectedPatterns',
    label: 'Production / protected patterns',
    placeholder: 'acme-live-*',
    tooltip:
      'Names, hosts, or resource patterns the judge must treat as production and refuse to mutate without a human. Setting any pattern REPLACES the built-in heuristic entirely.',
    description:
      "Empty = built-in heuristic: 'prod'/'production' as a whole word or segment. Setting this REPLACES the heuristic."
  }
]

/**
 * Shared render/load/save core for the per-engine auto-mode editor.
 * `OpencodeAutoModeSection` and `PiAutoModeSection` are thin copy/gating
 * wrappers around this — both engines read the SAME `EngineConfig.autoMode`
 * block (`loadEngineConfig(<engine>).autoMode` in OpencodeSession /
 * PiSession), and the classifier policy behind it is engine-neutral
 * (src/main/automode/), so the editor is too. Mirrors `DispatchSection`'s
 * structure for the same DRY reason.
 *
 * Self-contained: loads/saves its own EngineConfig via window.api
 * (SettingsDialog only wires the 'claude' engine config), editing ONLY the
 * `autoMode` block so sibling blocks (`dispatch`, `piConfig`, …) survive.
 *
 * `installed`: null = still probing (Loading), false = gate closed.
 *
 * The judge-model picker is fed from `getEngineModels()` filtered to this
 * engine, so its option values are picker VALUES (`<provider>/<modelId>`) —
 * exactly what both sessions feed to `engineMeta(<engine>).decodeModelValue()`
 * when resolving `autoMode.judgeModel`.
 *
 * `AutoModeConfig`'s trust lists (trustedDomains / trustedRegistries /
 * protectedPatterns) are edited here too, and are engine-neutral for the same
 * reason: both sessions splice them into the classifier environment with the
 * SAME `?.length` guard, so an EMPTY array and an ABSENT key are
 * indistinguishable to the backend. `updateList` therefore deletes the key
 * rather than storing `[]` — one on-disk representation for one meaning, and
 * `engines/<engine>.json` stays clean for hand-editing.
 */
function AutoModeSection({
  engineId,
  testid,
  installed,
  notInstalledMessage,
  toggleTooltip,
  judgeModelTooltip,
  footerText
}: {
  engineId: EngineId
  testid: string
  installed: boolean | null
  notInstalledMessage: string
  toggleTooltip: string
  judgeModelTooltip: string
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
    return (
      <div data-testid={testid} className="px-3 py-1.5 text-[13px] text-text-muted">
        Loading…
      </div>
    )
  }
  if (!installed) {
    return (
      <div
        data-testid={testid}
        className="px-3 py-2 text-[12px] text-text-muted/70 leading-relaxed"
      >
        {notInstalledMessage}
      </div>
    )
  }

  const auto = engineCfg.autoMode ?? {}
  const enabled = auto.enabled !== false // default ON
  const judgeModel = auto.judgeModel ?? ''
  const twoStageMode = auto.twoStageMode ?? 'both'

  const judgeModelOptions = toModelDisplays(models)
  const selectedJudgeModel = selectedModelDisplay(models, judgeModel, JUDGE_MODEL_DEFAULT_LABEL)

  const update = (patch: Partial<AutoModeConfig>): void => {
    const next: EngineConfig = { ...engineCfg, autoMode: { ...auto, ...patch } }
    setEngineCfg(next)
    window.api.saveEngineConfig(engineId, next).catch(() => {})
  }

  // Trust lists: an empty list is written as an ABSENT key, never `[]`. The
  // classifier reads them behind `?.length`, so `[]` is not a distinct state —
  // storing it would invent a second encoding of "restrictive default".
  const updateList = (key: TrustListKey, items: string[]): void => {
    const nextAuto: AutoModeConfig = { ...auto }
    if (items.length > 0) nextAuto[key] = items
    else delete nextAuto[key]
    const next: EngineConfig = { ...engineCfg, autoMode: nextAuto }
    setEngineCfg(next)
    window.api.saveEngineConfig(engineId, next).catch(() => {})
  }

  return (
    <div data-testid={testid} className="space-y-1">
      <SettingsToggle
        testid={`${testid}.enabled`}
        label="Auto mode (LLM gatekeeper)"
        checked={enabled}
        onChange={(v) => update({ enabled: v })}
        tooltip={toggleTooltip}
      />
      {enabled && (
        <>
          <div className="px-3 py-1.5 text-[13px] text-text-secondary">
            <div className="mb-1 flex items-center gap-1">
              Judge model
              <InfoTooltip text={judgeModelTooltip} />
            </div>
            {/* Themed dropdown, not a native <select>: a native option list is
                painted by the OS with UA colors, so the inherited light-on-dark
                text was unreadable under Monokai. ModelPicker (the InputBox /
                AutomationConfig picker) renders options as real DOM styled from
                the same theme tokens as everything else. The section-scoped
                `.judgeModel` testid moves to this wrapper; the picker keeps its
                own `ModelPicker.trigger` / `ModelPicker.option` ids. */}
            <div data-testid={`${testid}.judgeModel`} data-value={judgeModel}>
              <ModelPicker
                placement="down"
                emptyOption={{ label: JUDGE_MODEL_DEFAULT_LABEL }}
                models={judgeModelOptions}
                selectedModel={selectedJudgeModel}
                onSelectModel={(v) => update({ judgeModel: v || undefined })}
              />
            </div>
            <StaleModelNotice testid={`${testid}.judgeModel`} models={models} value={judgeModel} />
          </div>
          <SettingsSelect
            testid={`${testid}.twoStageMode`}
            label="Two-stage judging"
            value={twoStageMode}
            options={TWO_STAGE_OPTIONS}
            onChange={(v) => update({ twoStageMode: v })}
          />
          {TRUST_LISTS.map((f) => (
            <SandboxListSetting
              key={f.key}
              testid={`${testid}.${f.key}`}
              label={f.label}
              labelColor="text-text-secondary"
              items={auto[f.key] ?? []}
              placeholder={f.placeholder}
              onUpdate={(items) => updateList(f.key, items)}
              tooltip={f.tooltip}
              description={f.description}
            />
          ))}
          <div className="px-3 pb-1 text-[10px] text-text-muted/50 leading-relaxed">
            {footerText}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Configures the auto-mode LLM permission gatekeeper that runs in Full
 * autonomy on opencode. See ADR-023.
 */
function OpencodeAutoModeSection(): React.JSX.Element {
  const installed = useOpencodeInstalled()
  return (
    <AutoModeSection
      engineId="opencode"
      testid="OpencodeAutoModeSection"
      installed={installed}
      notInstalledMessage="opencode is not installed. Auto mode gates risky tool calls for opencode sessions in Full autonomy."
      toggleTooltip="In Full autonomy, an LLM judges each risky tool call (bash / web fetch) instead of prompting you; reads and edits are auto-allowed. Fails closed to a human prompt when unsure or unavailable. When off, Full prompts you like Ask mode. See ADR-023."
      judgeModelTooltip="The model that decides allow/block. Defaults to the session's own model. Pick a cheaper model to reduce cost, or a stronger one for safety-critical work."
      footerText="Applies to Full autonomy on opencode. The judge sees tool calls, not their output. No per-turn call cap (parity with Claude) — pick a cheaper judge model if cost matters."
    />
  )
}

/**
 * The pi twin of `OpencodeAutoModeSection`. pi's gatekeeper (PiSession's
 * phase-4 wiring) reads the very same `engines/pi.json#autoMode` block and runs
 * the same engine-neutral classifier — the one behavioral difference worth
 * saying out loud in the copy is that pi's `isAutoMode()` covers BOTH the
 * `auto` and `full` autonomy modes, where opencode's covers Full only.
 */
export function PiAutoModeSection(): React.JSX.Element {
  const installed = usePiInstalled()
  return (
    <AutoModeSection
      engineId="pi"
      testid="PiAutoModeSection"
      installed={installed}
      notInstalledMessage="pi is not installed. Auto mode gates risky tool calls for pi sessions in Auto and Full autonomy."
      toggleTooltip="In Auto and Full autonomy, an LLM judges each risky tool call (bash / web fetch) instead of prompting you; reads and edits are auto-allowed. Fails closed to a human prompt when unsure or unavailable. When off, Auto/Full prompt you like Ask mode. See ADR-023."
      judgeModelTooltip="The model that decides allow/block. Format: provider/model-id. Defaults to the session's own model. Pick a cheaper model to reduce cost, or a stronger one for safety-critical work."
      footerText="Applies to Auto and Full autonomy on pi. The judge runs in its own short-lived pi process. It sees tool calls, not their output. Config is read once per session — reopen a session to pick up changes."
    />
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
 *
 * The ONE genuinely per-direction control is `showTurnTimeouts` — see its prop
 * doc; everything else differs only in copy.
 */
function DispatchSection({
  engineId,
  testid,
  installed,
  notInstalledMessage,
  defaultModelTooltip,
  noModelsMessage,
  footerText,
  showTurnTimeouts = false
}: {
  engineId: EngineId
  testid: string
  installed: boolean | null
  notInstalledMessage?: string
  defaultModelTooltip: string
  noModelsMessage: string
  footerText: string
  /** Render the turn/inactivity timeout editors. OPENCODE ONLY: the watchdog
   *  they configure lives in the opencode dispatch direction (ADR-033's
   *  2026-09-01 amendment); the Claude/pi directions still run on the fixed
   *  10-minute `DISPATCH_TIMEOUT_MS`, so showing these there would be an inert
   *  control that silently writes config nothing reads. */
  showTurnTimeouts?: boolean
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
    return (
      <div data-testid={testid} className="px-3 py-1.5 text-[13px] text-text-muted">
        Loading…
      </div>
    )
  }
  if (!installed) {
    return (
      <div
        data-testid={testid}
        className="px-3 py-2 text-[12px] text-text-muted/70 leading-relaxed"
      >
        {notInstalledMessage}
      </div>
    )
  }

  const dispatch = engineCfg.dispatch ?? {}
  const defaultModel = dispatch.defaultModel ?? ''
  const allowedModels = dispatch.allowedModels ?? []
  const maxCostUsd = dispatch.maxCostUsd
  // Both timeouts are stored in MILLISECONDS (DispatchConfig) but edited in
  // MINUTES — nobody wants to type 3600000. Blank = the built-in default,
  // 0 = disabled; both round-trip through the same undefined-vs-number
  // convention the maxCost input uses.
  const toMinutes = (ms: number | undefined): number | '' => (ms === undefined ? '' : ms / 60000)
  const fromMinutes = (raw: string): number | undefined =>
    raw === '' ? undefined : Number(raw) * 60000

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
        {/* Themed ModelPicker, not a native <select> — see the AutoModeSection
            judge-model note: OS-painted option lists are unreadable in dark
            themes. The section-scoped `.defaultModel` testid moves to this
            wrapper and carries `data-value`; the picker keeps its own
            `ModelPicker.trigger` / `ModelPicker.option` ids. */}
        <div data-testid={`${testid}.defaultModel`} data-value={defaultModel}>
          <ModelPicker
            placement="down"
            emptyOption={{ label: DISPATCH_MODEL_DEFAULT_LABEL }}
            models={toModelDisplays(models)}
            selectedModel={selectedModelDisplay(models, defaultModel, DISPATCH_MODEL_DEFAULT_LABEL)}
            onSelectModel={(v) => update({ defaultModel: v || undefined })}
          />
        </div>
        <StaleModelNotice testid={`${testid}.defaultModel`} models={models} value={defaultModel} />
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
      <div className="px-3 py-1.5 text-[13px] text-text-secondary">
        <div className="mb-1 flex items-center gap-1">
          Max cost per dispatched agent (USD)
          <InfoTooltip text="Per-dispatch-target cumulative cost cap (ADR-033 M4-C). Once a target's tracked cost meets/exceeds this value, further continuation turns on it are rejected — the target stays alive, so raising the cap or starting a fresh dispatch both recover. Leave blank for no cap." />
        </div>
        <input
          data-testid={`${testid}.maxCost`}
          type="number"
          min="0"
          step="0.01"
          value={maxCostUsd ?? ''}
          onChange={(e) => {
            const raw = e.target.value
            update({ maxCostUsd: raw === '' ? undefined : Number(raw) })
          }}
          placeholder="(no cap)"
          className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
        />
      </div>
      {showTurnTimeouts && (
        <>
          <div className="px-3 py-1.5 text-[13px] text-text-secondary">
            <div className="mb-1 flex items-center gap-1">
              Max turn duration (minutes)
              <InfoTooltip text="Absolute cap on one dispatched turn — it is aborted when this elapses, however busy it looks. Leave blank for the 60-minute default; 0 disables the cap entirely." />
            </div>
            <input
              data-testid={`${testid}.turnTimeout`}
              type="number"
              min="0"
              step="1"
              value={toMinutes(dispatch.turnTimeoutMs)}
              onChange={(e) => update({ turnTimeoutMs: fromMinutes(e.target.value) })}
              placeholder="(default: 60)"
              className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
            />
          </div>
          <div className="px-3 py-1.5 text-[13px] text-text-secondary">
            <div className="mb-1 flex items-center gap-1">
              Inactivity timeout (minutes)
              <InfoTooltip text="How long a dispatched turn may go without producing ANY output before it is aborted. This is the liveness guard — a working agent streams continuously, so for a genuinely slow model raise the turn cap rather than this. Leave blank for the 15-minute default; 0 disables it." />
            </div>
            <input
              data-testid={`${testid}.idleTimeout`}
              type="number"
              min="0"
              step="1"
              value={toMinutes(dispatch.idleTimeoutMs)}
              onChange={(e) => update({ idleTimeoutMs: fromMinutes(e.target.value) })}
              placeholder="(default: 15)"
              className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
            />
          </div>
        </>
      )}
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
      showTurnTimeouts
    />
  )
}

/**
 * Governs `dispatch_agent` calls INTO Claude (the M2 opencode→Claude
 * direction, plus any future engine). Self-contained: loads/saves its own
 * Claude EngineConfig via window.api, editing only the `dispatch` block
 * (never clobbers `sandbox`/`proxy`). Claude ITSELF is always installed (the
 * bundled default engine), but dispatch INTO Claude can only be CALLED from
 * opencode today — so this section gates on the same opencode-installed
 * probe as the opencode twin (ADR-030/ADR-033 M4-A: no possible caller means
 * the config has nothing to configure).
 */
export function ClaudeDispatchSection(): React.JSX.Element {
  const installed = useOpencodeInstalled()
  return (
    <DispatchSection
      engineId="claude"
      testid="ClaudeDispatchSection"
      installed={installed}
      notInstalledMessage="opencode is not installed. Cross-engine dispatch lets an opencode session delegate a task to a Claude agent — with no other engine installed, there is no possible caller."
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
    <div
      data-testid="VendorAnthropicEditableForm"
      className="px-3 py-1.5 text-[13px] text-text-secondary space-y-4"
    >
      {/* Endpoint */}
      <div className="space-y-2">
        <div className="text-[11px] text-text-muted uppercase tracking-wide">Endpoint</div>
        <SettingsToggle
          label="Enable custom endpoint"
          checked={endpoint.enabled}
          onChange={(v) => updateVendorConfig({ endpoint: { ...endpoint, enabled: v } })}
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
          onChange={(v) => updateVendorConfig({ modelOverride: { ...modelOverride, enabled: v } })}
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
    return (
      <div data-testid="OpencodeModelsSection" className="px-3 py-1.5 text-[13px] text-text-muted">
        Loading…
      </div>
    )
  }
  if (!installed) {
    return (
      <div
        data-testid="OpencodeModelsSection"
        className="px-3 py-2 text-[12px] text-text-muted/70 leading-relaxed"
      >
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
    // The RAW value, not the constant — an empty string is what tells the store
    // nothing is configured, which is what separates "the builtin default may
    // fall back silently" from "the user named this model".
    if ('model' in patch) {
      useSessionStore.getState().setOpencodeDefaultModel(patch.model ?? '')
    }
    useSessionStore.getState().reloadModels()
  }

  const modelDisplays = toModelDisplays(models)

  return (
    <div data-testid="OpencodeModelsSection" className="space-y-1">
      <div className="px-3 py-1.5 text-[13px] text-text-secondary">
        <div className="mb-1 flex items-center gap-1">
          Default model
          <InfoTooltip text="The primary model for opencode sessions. Format: provider/model-id, e.g. anthropic/claude-sonnet-4-6. Applies on next cwd spawn." />
        </div>
        <div data-testid="OpencodeModelsSection.model" data-value={cfg.model ?? ''}>
          <ModelPicker
            placement="down"
            emptyOption={{ label: OPENCODE_MODEL_DEFAULT_LABEL }}
            models={modelDisplays}
            selectedModel={selectedModelDisplay(
              models,
              cfg.model ?? '',
              OPENCODE_MODEL_DEFAULT_LABEL
            )}
            onSelectModel={(v) => update({ model: v || undefined })}
          />
        </div>
        <StaleModelNotice
          testid="OpencodeModelsSection.model"
          models={models}
          value={cfg.model ?? ''}
        />
      </div>
      <div className="px-3 py-1.5 text-[13px] text-text-secondary">
        <div className="mb-1 flex items-center gap-1">
          Small model
          <InfoTooltip text="A cheaper/faster model used by opencode for lightweight tasks (titles, summaries). Format: provider/model-id." />
        </div>
        <div data-testid="OpencodeModelsSection.smallModel" data-value={cfg.smallModel ?? ''}>
          <ModelPicker
            placement="down"
            emptyOption={{ label: OPENCODE_MODEL_DEFAULT_LABEL }}
            models={modelDisplays}
            selectedModel={selectedModelDisplay(
              models,
              cfg.smallModel ?? '',
              OPENCODE_MODEL_DEFAULT_LABEL
            )}
            onSelectModel={(v) => update({ smallModel: v || undefined })}
          />
        </div>
        <StaleModelNotice
          testid="OpencodeModelsSection.smallModel"
          models={models}
          value={cfg.smallModel ?? ''}
        />
      </div>
      <div className="px-3 pb-1 text-[10px] text-text-muted/50 leading-relaxed">
        Changes apply on the next opencode server start for each working directory.
      </div>
    </div>
  )
}

// ── opencode raw-config (schema-driven) editing ─────────────────────

const OPENCODE_SCHEMA_DEFS = (opencodeConfigSchema as { $defs: SchemaDefs }).$defs
const OPENCODE_CONFIG_NODE = OPENCODE_SCHEMA_DEFS.Config as SchemaNode

/**
 * Top-level Config keys owned by a DEDICATED UI (rendered as read-only pointers in
 * the raw editor, never editable there). `provider` is patch-writable via the
 * per-model capability editor, but curated as a whole under Custom providers.
 * The bulk of them are the curated Configuration panes (OpencodeConfigPanes.tsx);
 * each label here must match that pane's Section label so the pointer is a
 * usable direction and not just a "not here".
 *
 * Exported for the guard test: a key MISSPELLED here silently stays editable in
 * the raw editor while its curated pane also writes it — two writers, one key.
 */
export const CONFIG_POINTER_KEYS: Record<string, string> = {
  model: 'Models',
  small_model: 'Models',
  disabled_providers: 'Providers',
  enabled_providers: 'Providers',
  provider: 'Custom providers',
  agent: 'Agents',
  mcp: 'injected at spawn',
  permission: 'Autonomy mode',
  compaction: 'Session behavior',
  subagent_depth: 'Session behavior',
  snapshot: 'Session behavior',
  tool_output: 'Tool output',
  attachment: 'Image attachments',
  instructions: 'Workspace',
  default_agent: 'Workspace',
  shell: 'Workspace',
  watcher: 'Workspace',
  tools: 'Tools & integrations',
  formatter: 'Tools & integrations',
  lsp: 'Tools & integrations',
  plugin: 'Tools & integrations',
  skills: 'Tools & integrations',
  logLevel: 'Diagnostics',
  experimental: 'Diagnostics',
  autoupdate: 'Managed keys',
  share: 'Managed keys'
}
/**
 * Keys rendered NOWHERE — not editable, not even as a pointer. `$schema` is not
 * user config; `server.*` is overridden by the CLI flags OpencodeServerManager
 * spawns with; `layout` and `autoshare` are deprecated upstream. Listing them as
 * pointers would only imply a UI that owns them.
 */
export const CONFIG_HIDDEN_KEYS = new Set(['$schema', 'layout', 'autoshare', 'server'])
/** Config keys the raw editor never renders as editable fields. */
const CONFIG_EXCLUDED_KEYS = new Set([...CONFIG_HIDDEN_KEYS, ...Object.keys(CONFIG_POINTER_KEYS)])

/**
 * "Raw config (opencode.json)" — schema-driven editor over the top-level
 * opencode Config, EXCLUDING keys owned by dedicated UIs (rendered as pointers)
 * and CONFIG_HIDDEN_KEYS (rendered nowhere). What's left is the long tail no
 * curated pane covers: command, enterprise, mode, reference, references,
 * username. Loads the raw config on mount, accumulates edits locally, and on
 * Save computes a deep diff → leaf patches → patchOpencodeNative. ajv errors
 * surface inline.
 *
 * Unlike the curated Configuration panes (OpencodeConfigPanes.tsx), this one
 * keeps its explicit Save button: a generic form over arbitrary shapes has no
 * per-field commit point to hang an immediate write on.
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
      <div
        data-testid="OpencodeRawConfigSection"
        className="px-3 py-1.5 text-[13px] text-text-muted"
      >
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
  const pointerKeys = Object.keys(configProps).filter(
    (k) => k in CONFIG_POINTER_KEYS && !CONFIG_HIDDEN_KEYS.has(k)
  )

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
            testid="SettingsTheme"
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
              <SelectMenu
                testid="VoiceLanguageSetting.language"
                value={s.voiceLanguage}
                onChange={(v) => u({ voiceLanguage: v as VoiceLanguageCode })}
                options={VOICE_LANGUAGES.map((lang) => ({ value: lang.code, label: lang.label }))}
              />
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
      },
      {
        key: 'remoteServerConfig',
        label: 'Remote server',
        keywords:
          'remote port password autostart bind interface server passkey webauthn biometric fingerprint face authentication sign-in enroll device credential',
        render: () => <RemoteServerSettings />
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
      }
    ]
  },
  {
    // Its own COMMON-scope section, not an item under Claude → Permissions
    // (where it originally lived): the setting is engine-neutral (ADR-050) and
    // parking it inside the Claude tab read as Claude-only — the exact
    // confusion it was built to remove.
    id: 'autonomy',
    label: 'Autonomy',
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
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
    items: [
      {
        key: 'autonomyMode',
        label: 'Autonomy mode',
        keywords: 'autonomy mode plan ask auto edit full permission mode default all engines',
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
    id: 'shared-providers',
    label: 'Providers & models',
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4" />
      </svg>
    ),
    items: [
      {
        key: 'sharedProviders',
        label: 'Providers & models',
        keywords: 'shared provider chatgpt codex api key model pi opencode',
        render: () => <SharedProviders />
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
  // ── opencode > Configuration subgroup ──────────────────────────────
  // Seven curated panes over the config keys worth a real control, plus the
  // generic editor for the long tail. Panes live in OpencodeConfigPanes.tsx;
  // every key they own is also listed in CONFIG_POINTER_KEYS so the raw editor
  // points here instead of offering a second, conflicting editor for it.
  {
    id: 'opencode-session',
    label: 'Session behavior',
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
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v5h5" />
        <path d="M12 8v4l3 2" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeSessionBehavior',
        label: 'Session behavior',
        keywords:
          'opencode compaction auto prune tail_turns preserve_recent_tokens reserved subagent_depth snapshot context window compact undo revert',
        render: () => <OpencodeSessionBehaviorSection />
      }
    ]
  },
  {
    id: 'opencode-tool-output',
    label: 'Tool output',
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
        key: 'opencodeToolOutput',
        label: 'Tool output',
        keywords: 'opencode tool_output max_lines max_bytes truncate truncation preview',
        render: () => <OpencodeToolOutputSection />
      }
    ]
  },
  {
    id: 'opencode-attachments',
    label: 'Image attachments',
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
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeAttachments',
        label: 'Image attachments',
        keywords:
          'opencode attachment image auto_resize max_width max_height max_base64_bytes paste screenshot resize',
        render: () => <OpencodeAttachmentsSection />
      }
    ]
  },
  {
    id: 'opencode-workspace',
    label: 'Workspace',
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
        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeWorkspace',
        label: 'Workspace',
        keywords:
          'opencode instructions default_agent shell watcher ignore AGENTS.md context primary agent terminal bash',
        render: () => <OpencodeWorkspaceSection />
      }
    ]
  },
  {
    id: 'opencode-tools',
    label: 'Tools & integrations',
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
        <path d="M14.7 6.3a4 4 0 01-5 5L4 17v3h3l5.7-5.7a4 4 0 015-5l-2.5-2.5 2.1-2.1a4 4 0 00-2.6 1.6z" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeTools',
        label: 'Tools & integrations',
        keywords:
          'opencode tools bash read glob grep edit write task webfetch websearch todowrite skill apply_patch question lsp formatter plugin skills paths disable',
        render: () => <OpencodeToolsSection />
      }
    ]
  },
  {
    id: 'opencode-diagnostics',
    label: 'Diagnostics',
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
        <polyline points="3 12 7 12 10 4 14 20 17 12 21 12" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeDiagnostics',
        label: 'Diagnostics',
        keywords:
          'opencode logLevel log level debug info warn error experimental mcp_timeout batch_tool troubleshoot',
        render: () => <OpencodeDiagnosticsSection />
      }
    ]
  },
  {
    id: 'opencode-managed',
    label: 'Managed keys',
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
        <rect x="4" y="10" width="16" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 018 0v3" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeManagedKeys',
        label: 'Managed keys',
        keywords:
          'opencode autoupdate share autoshare continue_loop_on_deny server layout forced managed self-update sharing cloud',
        render: () => <OpencodeManagedKeysSection />
      }
    ]
  },
  {
    id: 'opencode-config',
    label: 'Raw config',
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
        <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
    items: [
      {
        key: 'opencodeConfig',
        label: 'Raw config (opencode.json)',
        keywords:
          'opencode config raw schema command username enterprise reference references mode advanced json',
        render: () => <OpencodeRawConfigSection />
      }
    ]
  },
  // The 'opencode-providers' ("Custom providers") section is intentionally gone.
  // Custom declarations are no longer a separate surface: they live in the single
  // Providers list alongside catalog providers, and their form is the provider
  // configuration dialog (OpencodeProviderConfigModal) opened from a row's pencil
  // or from "+ Add custom provider". Two lists over the same provider set is what
  // let a declared+disabled provider render nowhere at all.
  {
    id: 'opencode-agents',
    label: 'Agents',
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
  },
  {
    id: 'pi-automode',
    label: 'Auto mode',
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
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
    items: [
      {
        key: 'piAutoMode',
        label: 'Auto mode',
        keywords:
          'pi auto mode full autonomy classifier gatekeeper judge llm permission bash security monitor',
        render: () => <PiAutoModeSection />
      }
    ]
  },
  // ── pi > Configuration subgroup ────────────────────────────────────
  // Six curated panes over pi's own settings.json plus a full-file text editor
  // for the long tail (pi publishes no config schema, so there is no generic
  // schema-driven form the way opencode has one). Panes live in
  // PiConfigPanes.tsx. `pi-config-models` also carries ClaudeUI's OWN pi
  // session-default model + allowlist, which is what the old `pi-models`
  // ENGINE section used to be on its own.
  {
    id: 'pi-config-session',
    label: 'Session behavior',
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
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v5h5" />
        <path d="M12 8v4l3 2" />
      </svg>
    ),
    items: [
      {
        key: 'piSessionBehavior',
        label: 'Session behavior',
        keywords:
          'pi compaction enabled reserveTokens keepRecentTokens branchSummary retry maxRetries baseDelayMs provider timeoutMs maxRetryDelayMs backoff context window compact summarise',
        render: () => <PiSessionBehaviorSection />
      }
    ]
  },
  {
    id: 'pi-config-models',
    label: 'Models & thinking',
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
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      </svg>
    ),
    items: [
      {
        key: 'piModels',
        label: 'Models & thinking',
        keywords:
          'pi model default provider openai-codex anthropic allowlist defaultProvider defaultModel defaultThinkingLevel thinkingBudgets reasoning effort',
        render: () => <PiModelsSection />
      }
    ]
  },
  {
    id: 'pi-config-tools',
    label: 'Tools & shell',
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
        <path d="M14.7 6.3a4 4 0 01-5 5L4 17v3h3l5.7-5.7a4 4 0 015-5l-2.5-2.5 2.1-2.1a4 4 0 00-2.6 1.6z" />
      </svg>
    ),
    items: [
      {
        key: 'piTools',
        label: 'Tools & shell',
        keywords:
          'pi defaultTools read bash powershell edit write grep find ls shellPath shellCommandPrefix npmCommand shell prefix npm',
        render: () => <PiToolsSection />
      }
    ]
  },
  {
    id: 'pi-config-images',
    label: 'Image attachments',
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
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    ),
    items: [
      {
        key: 'piImages',
        label: 'Image attachments',
        keywords: 'pi images autoResize blockImages resize paste screenshot attachment',
        render: () => <PiImagesSection />
      }
    ]
  },
  {
    id: 'pi-config-workspace',
    label: 'Workspace & trust',
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
        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      </svg>
    ),
    items: [
      {
        key: 'piWorkspace',
        label: 'Workspace & trust',
        keywords:
          'pi defaultProjectTrust ask always never sessionDir enableSkillCommands packages extensions skills prompts resources trust',
        render: () => <PiWorkspaceSection />
      }
    ]
  },
  {
    id: 'pi-config-network',
    label: 'Network & telemetry',
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
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
      </svg>
    ),
    items: [
      {
        key: 'piNetwork',
        label: 'Network & telemetry',
        keywords:
          'pi httpProxy transport sse websocket cached httpIdleTimeoutMs websocketConnectTimeoutMs enableInstallTelemetry enableAnalytics proxy telemetry analytics',
        render: () => <PiNetworkSection />
      }
    ]
  },
  {
    id: 'pi-config-raw',
    label: 'Raw config',
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
        <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
    items: [
      {
        key: 'piRawConfig',
        label: 'Raw config (settings.json)',
        keywords:
          'pi config raw json settings theme tuiMode fullscreen markdown terminal keybindings externalEditor enabledModels warnings advanced',
        render: () => <PiRawConfigSection />
      }
    ]
  },
  {
    id: 'vendor-pi',
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
        key: 'vendorPiAuth',
        label: 'Providers & subscriptions',
        keywords:
          'pi provider add auth api key oauth subscription login openai anthropic radius xai copilot',
        render: () => <PiVendors />
      }
    ]
  }
]

// ── Navigation groups tree ───────────────────────────────────────────

/** Section ids that belong to the App group (flat, directly visible) */
const APP_SECTION_IDS = new Set([
  'appearance',
  'chat',
  'session',
  'autonomy',
  'shared-providers',
  'tool-output',
  'diff',
  'git',
  'status-line',
  'usage',
  'logging',
  'voice',
  'remote',
  'mockup'
])

/** Section ids that belong to Engines > Claude */
const ENGINE_CLAUDE_SECTION_IDS = new Set(['permissions', 'sandbox', 'proxy', 'claude-dispatch'])

/** Section ids that belong to Engines > opencode (content self-gates on install) */
const ENGINE_OPENCODE_SECTION_IDS = new Set([
  'opencode-automode',
  'opencode-models',
  'opencode-dispatch'
])

/**
 * Section ids that belong to opencode > Configuration — the curated panes over
 * opencode's own config file, then the generic editor for what they don't cover.
 */
const CONFIGURATION_OPENCODE_SECTION_IDS = new Set([
  'opencode-session',
  'opencode-tool-output',
  'opencode-attachments',
  'opencode-workspace',
  'opencode-tools',
  'opencode-diagnostics',
  'opencode-managed',
  'opencode-config'
])

/** Section ids that belong to Vendors > Anthropic */
const VENDOR_ANTHROPIC_SECTION_IDS = new Set(['vendor-anthropic', 'effortDefaults'])

/** Section ids that belong to Vendors > opencode (gated: only shown when opencode engine installs) */
const VENDOR_OPENCODE_SECTION_IDS = new Set(['vendor-opencode'])

/** Section ids that belong to opencode Agents subgroup */
const AGENTS_OPENCODE_SECTION_IDS = new Set(['opencode-agents'])

/** Section ids that belong to Engines > pi (content self-gates on install).
 *  Auto mode alone: `pi-automode` edits the same `EngineConfig.autoMode` block
 *  opencode's does — PiSession reads `loadEngineConfig('pi').autoMode` since the
 *  phase-4 gatekeeper wiring, so the setting was live but unreachable from the
 *  UI until this section. The old `pi-models` section moved INTO
 *  `pi-config-models` below: ClaudeUI's session-default model and pi's own
 *  `defaultProvider`/`defaultModel` fallbacks answer one question between them,
 *  and answering it across two nav entries was the confusion.
 *  No dispatch section: the Claude/opencode dispatch sections configure
 *  dispatches INTO that engine (allowlist/default/cap for incoming targets),
 *  and pi is a dispatch SOURCE only so far — nothing to configure until
 *  pi-as-target ships (crossEngineDispatch is true for the source direction as
 *  of M4b). */
const ENGINE_PI_SECTION_IDS = new Set(['pi-automode'])

/**
 * Section ids that belong to pi > Configuration — the curated panes over pi's
 * own `~/.pi/agent/settings.json`, then the whole-file text editor for what they
 * don't cover (pi ships no config schema, so there is no generic form to
 * fall back on).
 */
const CONFIGURATION_PI_SECTION_IDS = new Set([
  'pi-config-session',
  'pi-config-models',
  'pi-config-tools',
  'pi-config-images',
  'pi-config-workspace',
  'pi-config-network',
  'pi-config-raw'
])

/** Section ids that belong to Vendors > pi (gated: only shown when pi engine installs) */
const VENDOR_PI_SECTION_IDS = new Set(['vendor-pi'])

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

export type SettingsScope = 'common' | 'claude' | 'opencode' | 'pi'

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
          'appearance',
          'chat',
          'session',
          'autonomy',
          'shared-providers',
          'tool-output',
          'diff',
          'git',
          'status-line',
          'usage',
          'logging',
          'voice',
          'remote',
          'mockup'
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
          'permissions',
          'sandbox',
          'proxy',
          'claude-dispatch'
        ])
      },
      {
        id: 'claude-vendor',
        label: 'Vendor · Anthropic',
        sections: getSectionsForIds(VENDOR_ANTHROPIC_SECTION_IDS, [
          'vendor-anthropic',
          'effortDefaults'
        ])
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
        sections: getSectionsForIds(ENGINE_OPENCODE_SECTION_IDS, [
          'opencode-automode',
          'opencode-models',
          'opencode-dispatch'
        ])
      },
      {
        id: 'opencode-configuration',
        label: 'Configuration',
        sections: getSectionsForIds(CONFIGURATION_OPENCODE_SECTION_IDS, [
          'opencode-session',
          'opencode-tool-output',
          'opencode-attachments',
          'opencode-workspace',
          'opencode-tools',
          'opencode-diagnostics',
          'opencode-managed',
          'opencode-config'
        ])
      },
      {
        id: 'opencode-vendor',
        label: 'Vendor',
        sections: getSectionsForIds(VENDOR_OPENCODE_SECTION_IDS, ['vendor-opencode'])
      },
      {
        id: 'opencode-agents',
        label: 'Agents',
        sections: getSectionsForIds(AGENTS_OPENCODE_SECTION_IDS, ['opencode-agents'])
      }
    ]
  },
  {
    id: 'pi',
    label: 'pi',
    subgroups: [
      {
        id: 'pi-engine',
        label: 'Engine',
        sections: getSectionsForIds(ENGINE_PI_SECTION_IDS, ['pi-automode'])
      },
      {
        id: 'pi-configuration',
        label: 'Configuration',
        sections: getSectionsForIds(CONFIGURATION_PI_SECTION_IDS, [
          'pi-config-session',
          'pi-config-models',
          'pi-config-tools',
          'pi-config-images',
          'pi-config-workspace',
          'pi-config-network',
          'pi-config-raw'
        ])
      },
      {
        id: 'pi-vendor',
        label: 'Vendor',
        sections: getSectionsForIds(VENDOR_PI_SECTION_IDS, ['vendor-pi'])
      }
    ]
  }
]

/**
 * The section a scope opens on: its first CAPABILITY-VISIBLE section, so a
 * gated-out one is never selected. Shared by the desktop container and the
 * mobile view (which uses it to tell a deep link apart from a plain tab
 * switch), so the two can't drift.
 */
export function firstSectionOfScope(scope: SettingsScope): string {
  const scopeDef = SCOPES.find((s) => s.id === scope)
  if (!scopeDef) return ''
  const caps = scopeCapabilities(scope)
  for (const sg of scopeDef.subgroups) {
    const sec = sg.sections.find((s) => isSectionVisible(s.id, caps))
    if (sec) return sec.id
  }
  return ''
}

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
