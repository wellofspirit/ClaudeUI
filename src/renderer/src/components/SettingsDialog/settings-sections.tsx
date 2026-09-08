import { useState, useEffect, useCallback, useSyncExternalStore } from 'react'
import { DEFAULT_SETTINGS, useActiveSession, useSessionStore } from '../../stores/session-store'
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
  CLAUDE_ENGINE_CAPABILITIES
} from '../../../../shared/model-capabilities'
import { AUTONOMY_TO_PERMISSION, AUTONOMY_LABELS } from '../../../../shared/permission-modes'
import {
  SettingsToggle,
  SettingsSlider,
  SettingsSelect,
  SettingsTextarea,
  SandboxListSetting,
  ChatRetentionSetting,
  ChipSet,
  SettingRow,
  RadioRow,
  ActionRow,
  SelectField,
  TextField,
  NumberField,
  Segmented,
  Button
} from './settings-controls'
import type { SettingsRenderContext } from './settings-target'
import { ModelPicker } from '../shared/InlinePickers'
import { toModelDisplays, selectedModelDisplay, StaleModelNotice } from './settings-model-display'
import { OpencodeAgentsSection } from './OpencodeAgents'
import { TrustListsSection } from './TrustLists'
import {
  RemoteAccessSection,
  RemoteLinksSection,
  RemoteSecuritySection,
  RemoteServerSection
} from './RemoteServerSettings'
import { ProviderList } from './ProviderList'
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
  PiRawConfigSection,
  PiRetrySection,
  PiResourcesSection,
  PiFallbacksSection
} from './PiConfigPanes'
import { diffToPatches } from '../../../../shared/opencode-config-diff'
import opencodeConfigSchema from '../../../../shared/opencode-config-schema.1.18.29.json'

// ── Section definitions ──────────────────────────────────────────────
//
// This file is the ITEM SOURCE and nothing else: `SECTIONS` holds every
// setting's render body, and `settings-pages.tsx` arranges those very objects
// into the ADR-065 pages. The store-derived scope tree that used to live at the
// tail of this file (SCOPES / SECTION_SCOPE_MAP / the per-scope id sets) went
// with phase 7 — organisation is the page model's job, and a second, disagreeing
// tree of the same sections is exactly what that redesign removed. The import
// edge is one-way: settings-pages imports from here, never the reverse.

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
    updateVendorConfig: (p: Partial<VendorConfig>) => void,
    /**
     * Shell context (ADR-065): app metadata and cross-page navigation. Kept
     * POSITIONAL and last so the ~130 existing bodies — which declare fewer
     * parameters and ignore it — did not have to be touched. Optional because
     * the type must stay satisfiable by a body that ignores it; both
     * presentations do pass one.
     */
    ctx?: SettingsRenderContext
  ) => React.JSX.Element
}

export interface Section {
  id: string
  label: string
  icon: React.JSX.Element
  items: SettingItem[]
}

/**
 * The changed-from-default state of a row backed by ClaudeUI's own settings
 * (ADR-065): an accent dot after the label, and a Reset link on row hover.
 *
 * Scalars only — comparison is by identity, so an object-valued key (e.g.
 * `modelEffortDefaults`) would read as permanently modified. Engine-native keys
 * get the same treatment in phase 2, where "modified" means "present in the
 * engine's own config file" rather than "differs from a constant".
 */
function appDefault<K extends keyof AppSettings>(
  settings: AppSettings,
  update: (p: Partial<AppSettings>) => void,
  key: K
): { modified: boolean; onReset: () => void } {
  return {
    modified: !Object.is(settings[key], DEFAULT_SETTINGS[key]),
    onReset: () => update({ [key]: DEFAULT_SETTINGS[key] } as Partial<AppSettings>)
  }
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

// ── Proxy test connection row ────────────────────────────────────────

/**
 * The "Test connection" row (ADR-065). The outcome IS the row's description,
 * so there is no bespoke status text beside a bespoke button; a failure's
 * message goes to the row's `error` slot and reads in the danger colour.
 *
 * A `SettingRow` with a `Button` rather than `ActionRow`: this is a dependent
 * row that has to nest and dim with the rest of the proxy fields and show an
 * error, none of which `ActionRow` takes, and its chevron link means "opens an
 * editor" rather than "runs a check".
 */
function ProxyTestButton({ proxy }: { proxy: ProxySettings }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [result, setResult] = useState<{ latencyMs?: number; error?: string } | null>(null)

  // Nothing to reach until the proxy is on and points somewhere.
  const ready = proxy.enabled && !!proxy.hostname

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

  const outcome =
    state === 'testing'
      ? 'Testing…'
      : state === 'success'
        ? `Reachable · ${result?.latencyMs ?? 0} ms`
        : state === 'error'
          ? 'The proxy did not answer.'
          : 'Not tested yet.'

  return (
    <SettingRow
      testid="ClaudeProxy.test"
      label="Test connection"
      description={outcome}
      error={state === 'error' ? result?.error : undefined}
      indent
      dimmed={!ready}
    >
      <Button
        testid="ClaudeProxy.test.action"
        onClick={() => void handleTest()}
        disabled={!ready || state === 'testing'}
      >
        Test
      </Button>
    </SettingRow>
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

  // The counts ARE the description (the board): "58 allow · 3 ask · 7 deny".
  const summary = !perms
    ? undefined
    : totalRules === 0 && perms.additionalDirectories.length === 0
      ? 'No rules configured'
      : [
          `${perms.allow.length} allow`,
          `${perms.ask.length} ask`,
          `${perms.deny.length} deny`,
          ...(perms.additionalDirectories.length > 0
            ? [
                `${perms.additionalDirectories.length} dir${perms.additionalDirectories.length !== 1 ? 's' : ''}`
              ]
            : [])
        ].join(' · ')

  return (
    <>
      <ActionRow
        testid="GlobalPermissionsSummary"
        label="Permission rules"
        description={summary}
        engine="claude"
        action="Edit rules"
        onAction={() => setDialogOpen(true)}
      />
      <PermissionsDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        cwd={cwd}
        initialTab="user"
      />
    </>
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

/**
 * One row per Claude model, on the ADR-065 vocabulary: the display name is the
 * label, the canonical model id is the config key under it (11px mono, not the
 * old 10px `text-muted/50` at the right edge), and the effort levels are a
 * `SelectField`.
 *
 * `modified` is passed in rather than derived from `current`: the phase-1
 * `appDefault` helper excludes `modelEffortDefaults` because it is object-valued,
 * so "changed from default" for THIS row means its key is present in that
 * object — which only the caller holding the whole object can answer.
 */
function ModelEffortRow({
  modelId,
  modelLabel,
  current,
  modified,
  onChange
}: {
  modelId: string
  modelLabel: string
  current: EffortLevel | undefined
  modified: boolean
  onChange: (next: EffortLevel | undefined) => void
}): React.JSX.Element {
  const levels = supportedEffortLevels(modelId)
  const fallback = defaultEffort(modelId)
  return (
    <SettingRow
      testid="ModelEffortRow"
      dataId={modelId}
      label={modelLabel}
      keyText={modelId}
      modified={modified}
      onReset={() => onChange(undefined)}
    >
      <SelectField
        testid="ModelEffortRow.effort"
        dataId={modelId}
        value={current ?? ''}
        onChange={(v) => onChange(v === '' ? undefined : (v as EffortLevel))}
        options={[
          { value: '', label: `Default (${EFFORT_LEVEL_LABEL[fallback]})` },
          ...levels.map((lvl) => ({ value: lvl, label: EFFORT_LEVEL_LABEL[lvl] }))
        ]}
      />
    </SettingRow>
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
    <div data-testid="AccountsSetting" className="divide-y divide-border/55">
      <SettingsToggle
        testid="AccountsSetting.multiAccount"
        label="Multiple accounts"
        checked={enabled}
        onChange={(v) => void run(() => window.api.setMultiAccountEnabled(v))}
        description="Hold several Claude subscriptions and switch between them; credentials are stored per account in plaintext files rather than the macOS Keychain."
      />

      {enabled && isMac && (
        // A real row, not an 11px callout box: the warning colour rides on the
        // row's background rather than on a type size ADR-065 retired.
        <SettingRow
          testid="AccountsSetting.keychainNotice"
          className="bg-warning/10"
          description="Multi-account mode uses file-based credentials, separate from your macOS Keychain login — you may need to sign in again for each account."
        />
      )}

      {enabled &&
        (accounts?.accounts ?? []).map((a) => {
          const active = a.id === accounts?.activeId
          return (
            // `as="label"` rather than `as="button"`: the row carries a Remove
            // BUTTON, and a button inside a button is invalid HTML (the same
            // reason SettingRow's own Reset is a role="button" span). A click on
            // an interactive descendant of a <label> does not activate the
            // label's control, so Remove never doubles as "switch to this one".
            <SettingRow
              key={a.id}
              as="label"
              testid="AccountsSetting.accountRow"
              dataId={a.id}
              label={a.email || 'Account'}
              description={a.subscriptionType ?? undefined}
              className={active ? 'bg-accent/5' : 'hover:bg-bg-hover/40'}
              leading={
                <input
                  type="radio"
                  name="claude-account"
                  value={a.id}
                  checked={active}
                  disabled={busy}
                  onChange={() => void run(() => window.api.switchAccount(a.id))}
                  className="appearance-none w-4 h-4 shrink-0 rounded-full border-[1.5px] border-border-bright bg-transparent checked:border-accent checked:bg-accent checked:shadow-[inset_0_0_0_3.5px_var(--color-bg-secondary)] cursor-pointer"
                />
              }
            >
              <Button
                testid="AccountsSetting.removeAccount"
                dataId={a.id}
                variant="danger"
                disabled={busy}
                onClick={() => void run(() => window.api.deleteAccount(a.id))}
              >
                Remove
              </Button>
            </SettingRow>
          )
        })}

      {enabled && (
        <SettingRow
          testid="AccountsSetting.addRow"
          description="Signs in to another Claude subscription and adds it to the list."
        >
          <Button
            testid="AccountsSetting.addAccount"
            variant="tinted"
            disabled={busy}
            onClick={() => void run(() => window.api.addAccount())}
          >
            + Add account
          </Button>
        </SettingRow>
      )}

      {enabled && pasteBack && (
        <div data-testid="AccountsSetting.signInFlow" className="px-3.5 py-2.5">
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
      {enabled && isWeb && authState?.status === 'error' && authState.error && (
        <div className="px-3.5 py-2.5">
          <OAuthOutcomeNotice
            kind={classifyOAuthError(authState.error)}
            message={authState.error}
          />
        </div>
      )}
    </div>
  )
}

// ── Autonomy mode picker ─────────────────────────────────────────────

/**
 * One sentence per mode, so the choice is legible without a tooltip (ADR-065).
 * Kept next to the picker rather than in `shared/permission-modes.ts`: the mode
 * PILL next to the composer shows the label alone and has no room for these.
 */
const AUTONOMY_DESCRIPTIONS: Record<AutonomyMode, string> = {
  plan: 'Explore and plan. Never edits or runs anything.',
  ask: 'Confirms every tool call with you.',
  autoEdit: 'Edits freely, asks before running commands.',
  full: 'A judge model approves routine calls; risky ones still ask you.'
}

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
    <div data-testid="AutonomyModePicker" className="divide-y divide-border/55">
      {availableModes.map((mode) => (
        <RadioRow
          key={mode}
          testid="AutonomyModePicker.mode"
          dataId={mode}
          name="autonomyMode"
          value={mode}
          label={AUTONOMY_LABELS[mode]}
          description={AUTONOMY_DESCRIPTIONS[mode]}
          checked={currentMode === mode}
          onSelect={() => handleChange(mode)}
        />
      ))}
      {/* The group's closing note. It stays INSIDE this component rather than
          becoming a card-level note so the copy guard in
          AutonomyModePicker.component.test.tsx keeps testing the thing that
          must not overclaim: this setting governs NEW sessions only. */}
      <div className="px-3.5 py-2.5 text-[12px] leading-4 text-text-secondary">
        Applies to new sessions on every engine. Running sessions keep their own mode — change it
        from the mode control next to the chat input.
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

// The three classifier trust lists are NOT here any more: they are the same
// values for every engine, so ADR-065 phase 4 moved them out of
// `engines/<engine>.json#autoMode` into one shared file, edited by
// `TrustLists.tsx` under Sessions & autonomy › Trust & protection.

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
 * What this editor does NOT own is the three trust lists: they are the same
 * values for every engine, so ADR-065 phase 4 moved them to one shared file with
 * its own group (`TrustLists.tsx`). Judge model, two-stage mode and the master
 * switch are genuinely per engine and stay here.
 */
function AutoModeSection({
  engineId,
  testid,
  installed,
  notInstalledMessage,
  toggleDescription,
  judgeModelDescription
}: {
  engineId: EngineId
  testid: string
  installed: boolean | null
  notInstalledMessage: string
  /** One sentence under the master switch — the ⓘ is gone (ADR-065). */
  toggleDescription: string
  judgeModelDescription: string
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

  // Both gated states are description-only ROWS, not bespoke markup: a card of
  // rows that sometimes isn't one was three of the six row grammars ADR-065
  // counted. Same testid on every branch, per ADR-027.
  if (engineCfg === null || installed === null) {
    return (
      <div data-testid={testid}>
        <SettingRow description="Loading…" />
      </div>
    )
  }
  if (!installed) {
    return (
      <div data-testid={testid}>
        <SettingRow description={notInstalledMessage} />
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

  return (
    <div data-testid={testid} className="divide-y divide-border/55">
      <SettingsToggle
        testid={`${testid}.enabled`}
        label="Auto mode (LLM gatekeeper)"
        checked={enabled}
        onChange={(v) => update({ enabled: v })}
        description={toggleDescription}
      />
      {enabled && (
        <>
          {/* Themed dropdown, not a native <select>: a native option list is
              painted by the OS with UA colors, so the inherited light-on-dark
              text was unreadable under Monokai. ModelPicker (the InputBox /
              AutomationConfig picker) renders options as real DOM styled from
              the same theme tokens as everything else. The section-scoped
              `.judgeModel` testid stays on the wrapper; the picker keeps its
              own `ModelPicker.trigger` / `ModelPicker.option` ids. */}
          <SettingRow
            testid={`${testid}.judgeModelRow`}
            label="Judge model"
            description={judgeModelDescription}
          >
            <span data-testid={`${testid}.judgeModel`} data-value={judgeModel}>
              <ModelPicker
                placement="down"
                emptyOption={{ label: JUDGE_MODEL_DEFAULT_LABEL }}
                models={judgeModelOptions}
                selectedModel={selectedJudgeModel}
                onSelectModel={(v) => update({ judgeModel: v || undefined })}
              />
            </span>
          </SettingRow>
          <StaleModelNotice testid={`${testid}.judgeModel`} models={models} value={judgeModel} />
          {/* `SettingsSelect` IS a `SettingRow` + `Segmented` (settings-controls),
              so using it keeps the row vocabulary and the `.twoStageMode` /
              `.twoStageMode.option` testids the call sites already assert. */}
          <SettingsSelect
            testid={`${testid}.twoStageMode`}
            label="Two-stage judging"
            description="Fast pass first, thinking pass only when it is unsure."
            value={twoStageMode}
            options={TWO_STAGE_OPTIONS}
            onChange={(v) => update({ twoStageMode: v })}
          />
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
      toggleDescription="In Full autonomy a judge model approves each risky tool call instead of prompting you, and asks you when it is unsure; off, Full prompts you like Ask."
      judgeModelDescription="Sees each tool call and decides whether to allow it; unset uses the session's own model."
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
      toggleDescription="In Auto and Full autonomy a judge model approves each risky tool call instead of prompting you, and asks you when it is unsure; off, both prompt you like Ask."
      judgeModelDescription="Sees each tool call and decides whether to allow it, in its own short-lived pi process; unset uses the session's own model."
    />
  )
}

// ── cross-engine dispatch settings (ADR-033) ─────────────────────────

/**
 * The dispatch page is TWO groups (ADR-065): "Dispatch into" — what a caller
 * may ask for — and "Limits" — what the target will spend on it. A divider is a
 * group boundary, so the one pane that used to draw both is now two exported
 * bodies per engine.
 *
 * ## Why a shared external store and not a hook-local `useState`
 *
 * `saveEngineConfig` takes the WHOLE `EngineConfig` and replaces the file with
 * it — unlike `setRemoteConfig`, which takes a partial that main merges, and
 * which is the only reason the four Remote sections can each hold their own
 * copy. Two halves each holding their own copy of an engine's config would lose
 * data the moment both are on screen, which on the dispatch page is always:
 * pick a default model in "Dispatch into" (it saves A′), then commit a max cost
 * in "Limits" (which still holds the pre-edit A, and saves A + maxCost) — and
 * the model choice is silently reverted on disk.
 *
 * So there is exactly ONE config object per engine, in a module-level store the
 * halves subscribe to through `useSyncExternalStore`:
 *
 *  - the entry is created by the FIRST subscriber, which starts the single
 *    `loadEngineConfig` read; later subscribers join the entry and the in-flight
 *    read, so mounting both halves is one IPC round trip, not two;
 *  - every `update` writes the entry and notifies both halves before persisting,
 *    so the second edit is always computed against the first;
 *  - the entry is DROPPED when the last subscriber unsubscribes, so a fresh
 *    mount re-reads the file (the behaviour every other settings pane has) and
 *    one test cannot leak an engine's config into the next.
 *
 * The MODEL probe stays per-component (`useDispatchModels`) and runs in the
 * into-half only: it is the expensive half of the load and the limits-half has
 * no picker to fill.
 */
interface DispatchStoreEntry {
  /** null until the first read resolves — the halves render a Loading row. */
  config: EngineConfig | null
  listeners: Set<() => void>
}

const DISPATCH_STORES = new Map<EngineId, DispatchStoreEntry>()

function emitDispatchConfig(entry: DispatchStoreEntry): void {
  for (const listener of entry.listeners) listener()
}

/**
 * The entry for one engine, creating it — and starting its single read — on
 * first use. A late-resolving read is dropped if the entry it belongs to has
 * since been discarded, so an unmounted pane cannot resurrect stale config.
 */
function dispatchEntry(engineId: EngineId): DispatchStoreEntry {
  const existing = DISPATCH_STORES.get(engineId)
  if (existing) return existing

  const entry: DispatchStoreEntry = { config: null, listeners: new Set() }
  DISPATCH_STORES.set(engineId, entry)

  const adopt = (config: EngineConfig): void => {
    if (DISPATCH_STORES.get(engineId) !== entry) return
    entry.config = config
    emitDispatchConfig(entry)
  }
  window.api
    .loadEngineConfig(engineId)
    .then(adopt)
    .catch(() => adopt({}))

  return entry
}

function subscribeDispatchConfig(engineId: EngineId, listener: () => void): () => void {
  const entry = dispatchEntry(engineId)
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
    // Last one out drops the entry, so the next mount re-reads the file.
    if (entry.listeners.size === 0 && DISPATCH_STORES.get(engineId) === entry) {
      DISPATCH_STORES.delete(engineId)
    }
  }
}

/**
 * Read during render, so it must NOT create the entry (React calls this before
 * it calls `subscribe`) and must return a stable reference between updates.
 */
function dispatchSnapshot(engineId: EngineId): EngineConfig | null {
  return DISPATCH_STORES.get(engineId)?.config ?? null
}

/** Merge a patch into the engine's `dispatch` block and persist the whole file. */
function updateDispatchConfig(engineId: EngineId, patch: Partial<DispatchConfig>): void {
  const entry = DISPATCH_STORES.get(engineId)
  if (!entry || entry.config === null) return
  const next: EngineConfig = {
    ...entry.config,
    dispatch: { ...(entry.config.dispatch ?? {}), ...patch }
  }
  entry.config = next
  emitDispatchConfig(entry)
  window.api.saveEngineConfig(engineId, next).catch(() => {})
}

interface DispatchConfigApi {
  /** null until the first read resolves — the halves render a Loading row. */
  engineCfg: EngineConfig | null
  dispatch: DispatchConfig
  /** Merge a patch into the `dispatch` block and persist the WHOLE config. */
  update: (patch: Partial<DispatchConfig>) => void
}

function useDispatchConfig(engineId: EngineId): DispatchConfigApi {
  const subscribe = useCallback(
    (listener: () => void) => subscribeDispatchConfig(engineId, listener),
    [engineId]
  )
  const getSnapshot = useCallback(() => dispatchSnapshot(engineId), [engineId])
  const engineCfg = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return {
    engineCfg,
    dispatch: engineCfg?.dispatch ?? {},
    update: (patch) => updateDispatchConfig(engineId, patch)
  }
}

/** The engine's own models, for the into-half's picker and chip set. */
function useDispatchModels(engineId: EngineId): ModelInfo[] {
  const [models, setModels] = useState<ModelInfo[]>([])
  useEffect(() => {
    let cancelled = false
    window.api
      .getEngineModels()
      .then((groups) => {
        if (cancelled) return
        setModels(groups.filter((g) => g.engineId === engineId).flatMap((g) => g.models))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [engineId])
  return models
}

/**
 * Gate shared by both halves: `null` = still probing (Loading), `false` = no
 * possible caller / target (the explanatory row), `true` = render the rows.
 * A gated state is a description-only ROW now, not a bare paragraph — the id is
 * on the same root either way, so the halves stay assertable in every state
 * (ADR-027).
 */
function dispatchGateRow(
  testid: string,
  installed: boolean | null,
  loaded: boolean,
  notInstalledMessage: string
): React.JSX.Element | null {
  if (installed === null || !loaded) {
    return (
      <div data-testid={testid} className="divide-y divide-border/55">
        <SettingRow testid={`${testid}.status`} dataId="loading" description="Loading…" />
      </div>
    )
  }
  if (!installed) {
    return (
      <div data-testid={testid} className="divide-y divide-border/55">
        <SettingRow
          testid={`${testid}.status`}
          dataId="not-installed"
          dimmed
          description={notInstalledMessage}
        />
      </div>
    )
  }
  return null
}

/** Past this many models the chip set collapses behind a "Show all N" link. */
const DISPATCH_CHIP_PREVIEW = 8

/**
 * "Dispatch into <engine>" — the two rows that say what a calling agent may ask
 * this target for: the model used when it names none, and the set it may name.
 */
function DispatchIntoSection({
  engineId,
  testid,
  installed,
  notInstalledMessage,
  noModelsMessage
}: {
  engineId: EngineId
  testid: string
  installed: boolean | null
  notInstalledMessage: string
  noModelsMessage: string
}): React.JSX.Element {
  const { engineCfg, dispatch, update } = useDispatchConfig(engineId)
  const models = useDispatchModels(engineId)
  const [showAll, setShowAll] = useState(false)

  const gate = dispatchGateRow(testid, installed, engineCfg !== null, notInstalledMessage)
  if (gate) return gate

  const defaultModel = dispatch.defaultModel ?? ''
  const allowedModels = dispatch.allowedModels ?? []

  const toggleAllowed = (model: string): void => {
    const nextList = allowedModels.includes(model)
      ? allowedModels.filter((m) => m !== model)
      : [...allowedModels, model]
    // Drop the key entirely when empty — empty and absent both mean "all
    // models allowed", and the absent form keeps the hand-editable file clean.
    update({ allowedModels: nextList.length > 0 ? nextList : undefined })
  }

  const collapsed = !showAll && models.length > DISPATCH_CHIP_PREVIEW
  const shownModels = collapsed ? models.slice(0, DISPATCH_CHIP_PREVIEW) : models

  return (
    <div data-testid={testid} className="divide-y divide-border/55">
      {/* The row and its stale-value warning are ONE child of the divider, so
          the warning reads as part of the row rather than as its own. */}
      <div>
        <SettingRow
          testid={`${testid}.defaultModelRow`}
          label="Default model"
          description="Used when the calling agent does not name one. Required."
          modified={dispatch.defaultModel !== undefined}
          onReset={() => update({ defaultModel: undefined })}
        >
          {/* Themed ModelPicker, not a native <select> — see the AutoModeSection
              judge-model note: OS-painted option lists are unreadable in dark
              themes. The section-scoped `.defaultModel` testid stays on this
              wrapper and carries `data-value`; the picker keeps its own
              `ModelPicker.trigger` / `ModelPicker.option` ids. The wrapper draws
              the bordered menu the row vocabulary asks for, since the shared
              picker paints a bare caret for the composer. */}
          <span
            data-testid={`${testid}.defaultModel`}
            data-value={defaultModel}
            className="inline-flex items-center bg-bg-input border border-border rounded-md"
          >
            <ModelPicker
              placement="down"
              emptyOption={{ label: DISPATCH_MODEL_DEFAULT_LABEL }}
              models={toModelDisplays(models)}
              selectedModel={selectedModelDisplay(
                models,
                defaultModel,
                DISPATCH_MODEL_DEFAULT_LABEL
              )}
              onSelectModel={(v) => update({ defaultModel: v || undefined })}
            />
          </span>
        </SettingRow>
        <StaleModelNotice testid={`${testid}.defaultModel`} models={models} value={defaultModel} />
      </div>

      <SettingRow
        testid={`${testid}.allowedModelsRow`}
        layout="stacked"
        label="Allowed models"
        description="Empty allows any model the provider offers. Only these can be requested otherwise."
        modified={dispatch.allowedModels !== undefined}
        onReset={() => update({ allowedModels: undefined })}
      >
        {models.length === 0 ? (
          <span className="block text-[12px] leading-4 text-text-secondary">{noModelsMessage}</span>
        ) : (
          <ChipSet
            testid={`${testid}.allowedModels`}
            chipTestid={`${testid}.allowedModel`}
            value={allowedModels}
            options={shownModels.map((m) => ({ value: m.value, label: m.displayName || m.value }))}
            onToggle={toggleAllowed}
            trailing={
              collapsed ? (
                <Button
                  testid={`${testid}.showAllModels`}
                  variant="link"
                  onClick={() => setShowAll(true)}
                >
                  Show all {models.length}
                </Button>
              ) : undefined
            }
          />
        )}
      </SettingRow>
    </div>
  )
}

/**
 * "Limits" — the budget the target enforces on a dispatched agent. Its own
 * group on the page, and its own body here, but the SAME config block: it calls
 * `useDispatchConfig` for its own read and edits keys the into-half never
 * touches.
 */
function DispatchLimitsSection({
  engineId,
  testid,
  installed,
  notInstalledMessage,
  showTurnTimeouts = false
}: {
  engineId: EngineId
  /**
   * The DIRECTION's namespace (`ClaudeDispatchSection`), not this half's root.
   * The half's own root is `<testid>.limits`, but each ROW keeps the id it had
   * before the split — `.maxCost`, `.turnTimeout`, `.idleTimeout` name parts
   * that did not move, and ADR-027 ties an id to the part, not to whichever
   * component happens to render it.
   */
  testid: string
  installed: boolean | null
  notInstalledMessage: string
  /** Render the turn/inactivity timeout editors. OPENCODE ONLY: the watchdog
   *  they configure lives in the opencode dispatch direction (ADR-033's
   *  2026-09-01 amendment); the Claude/pi directions still run on the fixed
   *  10-minute `DISPATCH_TIMEOUT_MS`, so showing these there would be an inert
   *  control that silently writes config nothing reads. */
  showTurnTimeouts?: boolean
}): React.JSX.Element {
  const { engineCfg, dispatch, update } = useDispatchConfig(engineId)
  const root = `${testid}.limits`

  const gate = dispatchGateRow(root, installed, engineCfg !== null, notInstalledMessage)
  if (gate) return gate

  // Both timeouts are stored in MILLISECONDS (DispatchConfig) but edited in
  // MINUTES — nobody wants to type 3600000. Blank = the built-in default,
  // 0 = disabled; both round-trip through the same undefined-vs-number
  // convention the maxCost field uses. A NEGATIVE minute count drops the key
  // rather than persisting a negative duration: the watchdog's `> 0` gates read
  // a persisted negative as "cap disabled", silently — not what someone
  // fumbling a keystroke meant to configure. (Which is also why these fields
  // carry no `min`: clamping -5 to 0 would MEAN "disabled".)
  const toMinutes = (ms: number | undefined): number | undefined =>
    ms === undefined ? undefined : ms / 60000
  const fromMinutes = (minutes: number | undefined): number | undefined =>
    minutes === undefined || !Number.isFinite(minutes) || minutes < 0 ? undefined : minutes * 60000

  return (
    <div data-testid={root} className="divide-y divide-border/55">
      <SettingRow
        testid={`${testid}.maxCostRow`}
        label="Max cost per dispatched agent"
        description="A continuation past this cumulative cost is refused; the target survives."
        modified={dispatch.maxCostUsd !== undefined}
        onReset={() => update({ maxCostUsd: undefined })}
      >
        <NumberField
          testid={`${testid}.maxCost`}
          value={dispatch.maxCostUsd}
          min={0}
          unit="USD"
          placeholder="no cap"
          onChange={(v) => update({ maxCostUsd: v })}
        />
      </SettingRow>

      {showTurnTimeouts && (
        <>
          <SettingRow
            testid={`${testid}.turnTimeoutRow`}
            label="Max turn duration"
            description="One dispatched turn is cut off after this long. 0 disables."
            modified={dispatch.turnTimeoutMs !== undefined}
            onReset={() => update({ turnTimeoutMs: undefined })}
          >
            <NumberField
              testid={`${testid}.turnTimeout`}
              value={toMinutes(dispatch.turnTimeoutMs)}
              unit="min"
              placeholder="60"
              onChange={(v) => update({ turnTimeoutMs: fromMinutes(v) })}
            />
          </SettingRow>

          <SettingRow
            testid={`${testid}.idleTimeoutRow`}
            label="Inactivity timeout"
            description="Give up on a target that stops producing output."
            modified={dispatch.idleTimeoutMs !== undefined}
            onReset={() => update({ idleTimeoutMs: undefined })}
          >
            <NumberField
              testid={`${testid}.idleTimeout`}
              value={toMinutes(dispatch.idleTimeoutMs)}
              unit="min"
              placeholder="15"
              onChange={(v) => update({ idleTimeoutMs: fromMinutes(v) })}
            />
          </SettingRow>
        </>
      )}
    </div>
  )
}

// ── The six exported bodies, two per direction ───────────────────────
//
// Dispatch INTO Claude can only be CALLED from another engine, and opencode is
// the only one installed separately — so both Claude halves gate on the same
// opencode-installed probe as the opencode twin (ADR-030/ADR-033 M4-A: no
// possible caller means the config has nothing to configure). pi gates on pi.

const CLAUDE_DISPATCH_ABSENT =
  'opencode is not installed. Cross-engine dispatch lets an opencode session delegate a task to a Claude agent — with no other engine installed, there is no possible caller.'
const OPENCODE_DISPATCH_ABSENT =
  'opencode is not installed. Cross-engine dispatch lets a Claude or pi session delegate a task to an opencode agent (e.g. a GPT-backed review).'
const PI_DISPATCH_ABSENT =
  'pi is not installed. Cross-engine dispatch lets a Claude or opencode session delegate a task to a pi agent.'

export function ClaudeDispatchIntoSection(): React.JSX.Element {
  const installed = useOpencodeInstalled()
  return (
    <DispatchIntoSection
      engineId="claude"
      testid="ClaudeDispatchSection"
      installed={installed}
      notInstalledMessage={CLAUDE_DISPATCH_ABSENT}
      noModelsMessage="No Claude models detected."
    />
  )
}

export function ClaudeDispatchLimitsSection(): React.JSX.Element {
  const installed = useOpencodeInstalled()
  return (
    <DispatchLimitsSection
      engineId="claude"
      testid="ClaudeDispatchSection"
      installed={installed}
      notInstalledMessage={CLAUDE_DISPATCH_ABSENT}
    />
  )
}

export function OpencodeDispatchIntoSection(): React.JSX.Element {
  const installed = useOpencodeInstalled()
  return (
    <DispatchIntoSection
      engineId="opencode"
      testid="OpencodeDispatchSection"
      installed={installed}
      notInstalledMessage={OPENCODE_DISPATCH_ABSENT}
      noModelsMessage="No opencode models detected."
    />
  )
}

export function OpencodeDispatchLimitsSection(): React.JSX.Element {
  const installed = useOpencodeInstalled()
  return (
    <DispatchLimitsSection
      engineId="opencode"
      testid="OpencodeDispatchSection"
      installed={installed}
      notInstalledMessage={OPENCODE_DISPATCH_ABSENT}
      showTurnTimeouts
    />
  )
}

/**
 * pi as a dispatch TARGET. Core has accepted it since M4c —
 * `cross-engine-dispatcher.ts`'s `resolveAndRunPi` reads
 * `engines/pi.json#dispatch` and its error text already points at this pane —
 * the settings UI simply never gained one (ADR-065 § Cross-engine dispatch into
 * pi). No timeouts: the watchdog is the opencode target path's.
 */
export function PiDispatchIntoSection(): React.JSX.Element {
  const installed = usePiInstalled()
  return (
    <DispatchIntoSection
      engineId="pi"
      testid="PiDispatchSection"
      installed={installed}
      notInstalledMessage={PI_DISPATCH_ABSENT}
      noModelsMessage="No pi models detected."
    />
  )
}

export function PiDispatchLimitsSection(): React.JSX.Element {
  const installed = usePiInstalled()
  return (
    <DispatchLimitsSection
      engineId="pi"
      testid="PiDispatchSection"
      installed={installed}
      notInstalledMessage={PI_DISPATCH_ABSENT}
    />
  )
}

// ── Whole-direction compositions ─────────────────────────────────────
//
// One direction's two halves, in page order. The dialog mounts the halves
// separately (one per group); these keep the pre-split name and testid so a
// caller — or a test — that wants "the whole dispatch pane for this engine"
// still has one thing to render.

export function ClaudeDispatchSection(): React.JSX.Element {
  return (
    <>
      <ClaudeDispatchIntoSection />
      <ClaudeDispatchLimitsSection />
    </>
  )
}

export function OpencodeDispatchSection(): React.JSX.Element {
  return (
    <>
      <OpencodeDispatchIntoSection />
      <OpencodeDispatchLimitsSection />
    </>
  )
}

export function PiDispatchSection(): React.JSX.Element {
  return (
    <>
      <PiDispatchIntoSection />
      <PiDispatchLimitsSection />
    </>
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

/** The four `ANTHROPIC_DEFAULT_*_MODEL` env vars claude-spawn-prep writes. */
const MODEL_OVERRIDE_FIELDS: ReadonlyArray<{
  field: keyof ModelOverrideSettings
  label: string
  placeholder: string
}> = [
  { field: 'model', label: 'Model id', placeholder: 'claude-3-5-sonnet-latest' },
  { field: 'sonnetModel', label: 'Sonnet alias', placeholder: 'claude-sonnet-latest' },
  { field: 'opusModel', label: 'Opus alias', placeholder: 'claude-opus-latest' },
  { field: 'haikuModel', label: 'Haiku alias', placeholder: 'claude-haiku-latest' }
]

/**
 * The Anthropic endpoint group, on the row vocabulary (ADR-065).
 *
 * The uppercase ENDPOINT / MODEL OVERRIDE sub-headers and the prose footer are
 * gone: a sub-header inside a card is a group boundary the page model expresses
 * itself, and "applies on next session start / persists to vendors/anthropic.json"
 * is the group's `appliesOn` badge plus its storage tag. Dependent fields stay
 * MOUNTED when their master toggle is off — indented, dimmed and disabled — so
 * what is configured is readable without flipping the switch to find out.
 *
 * Every write still goes through `updateVendorConfig` with the same whole-object
 * patch shape the pre-ADR-065 form used; nothing about the file changed.
 */
function VendorAnthropicEditableForm({
  vendorConfig,
  updateVendorConfig
}: {
  vendorConfig: VendorConfig
  updateVendorConfig: (p: Partial<VendorConfig>) => void
}): React.JSX.Element {
  const endpoint: AnthropicEndpointSettings = vendorConfig.endpoint ?? DEFAULT_ENDPOINT
  const modelOverride: ModelOverrideSettings = vendorConfig.modelOverride ?? DEFAULT_MODEL_OVERRIDE
  /** Reveal is per-view and deliberately not persisted anywhere. */
  const [revealToken, setRevealToken] = useState(false)

  const endpointOff = !endpoint.enabled
  const overrideOff = !modelOverride.enabled

  return (
    <div data-testid="VendorAnthropicEditableForm" className="divide-y divide-border/55">
      <SettingsToggle
        testid="VendorAnthropicEditableForm.endpointEnabled"
        label="Custom endpoint"
        checked={endpoint.enabled}
        description="Route Claude through a gateway or proxy instead of api.anthropic.com."
        onChange={(v) => updateVendorConfig({ endpoint: { ...endpoint, enabled: v } })}
      />

      <SettingRow
        testid="VendorAnthropicEditableForm.baseUrlRow"
        layout="stacked"
        indent
        dimmed={endpointOff}
        label="Base URL"
        description="The gateway's Anthropic-compatible base address."
      >
        <TextField
          testid="VendorAnthropicEditableForm.baseUrl"
          value={endpoint.baseUrl}
          placeholder="https://api.anthropic.com"
          disabled={endpointOff}
          onChange={(v) => updateVendorConfig({ endpoint: { ...endpoint, baseUrl: v } })}
        />
      </SettingRow>

      <SettingRow
        testid="VendorAnthropicEditableForm.authTokenRow"
        indent
        dimmed={endpointOff}
        label="Auth token"
        description="Sent as the gateway's bearer credential; leave empty to use your Claude login."
      >
        <TextField
          testid="VendorAnthropicEditableForm.authToken"
          type={revealToken ? 'text' : 'password'}
          className="w-[184px]"
          value={endpoint.authToken}
          placeholder="sk-ant-…"
          disabled={endpointOff}
          onChange={(v) => updateVendorConfig({ endpoint: { ...endpoint, authToken: v } })}
        />
        <Button
          testid="VendorAnthropicEditableForm.revealToken"
          variant="link"
          disabled={endpointOff}
          onClick={() => setRevealToken((v) => !v)}
        >
          {revealToken ? 'Hide' : 'Reveal'}
        </Button>
      </SettingRow>

      <SettingsToggle
        testid="VendorAnthropicEditableForm.modelOverrideEnabled"
        label="Model override"
        checked={modelOverride.enabled}
        description="Pin every session to one model id regardless of the picker."
        onChange={(v) => updateVendorConfig({ modelOverride: { ...modelOverride, enabled: v } })}
      />

      {MODEL_OVERRIDE_FIELDS.map(({ field, label, placeholder }) => (
        <SettingRow
          key={String(field)}
          testid="VendorAnthropicEditableForm.modelFieldRow"
          dataId={String(field)}
          indent
          dimmed={overrideOff}
          label={label}
          description={
            field === 'model'
              ? 'Used for every session that does not hit one of the aliases below.'
              : `Substituted wherever the ${label.replace(' alias', '')} alias is requested.`
          }
        >
          <TextField
            testid="VendorAnthropicEditableForm.modelField"
            dataId={String(field)}
            className="w-[240px]"
            value={modelOverride[field] as string}
            placeholder={placeholder}
            disabled={overrideOff}
            onChange={(v) =>
              updateVendorConfig({ modelOverride: { ...modelOverride, [field]: v } })
            }
          />
        </SettingRow>
      ))}
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
      <div data-testid="OpencodeModelsSection" className="divide-y divide-border/55">
        <SettingRow testid="OpencodeModelsSection.status" dataId="loading" description="Loading…" />
      </div>
    )
  }
  if (!installed) {
    return (
      <div data-testid="OpencodeModelsSection" className="divide-y divide-border/55">
        <SettingRow
          testid="OpencodeModelsSection.status"
          dataId="not-installed"
          dimmed
          description="opencode is not installed. These settings apply to opencode sessions."
        />
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
    <div data-testid="OpencodeModelsSection" className="divide-y divide-border/55">
      {/* Row + stale-value warning are ONE child of the divider, so the warning
          reads as part of the row rather than as a row of its own. */}
      <div>
        <SettingRow
          testid="OpencodeModelsSection.modelRow"
          label="Default model"
          description="Model a new opencode session starts with."
          modified={cfg.model !== undefined}
          onReset={() => update({ model: undefined })}
        >
          <span
            data-testid="OpencodeModelsSection.model"
            data-value={cfg.model ?? ''}
            className="inline-flex items-center bg-bg-input border border-border rounded-md"
          >
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
          </span>
        </SettingRow>
        <StaleModelNotice
          testid="OpencodeModelsSection.model"
          models={models}
          value={cfg.model ?? ''}
        />
      </div>
      <div>
        <SettingRow
          testid="OpencodeModelsSection.smallModelRow"
          label="Small model"
          description="Cheaper model for titles, summaries and compaction."
          modified={cfg.smallModel !== undefined}
          onReset={() => update({ smallModel: undefined })}
        >
          <span
            data-testid="OpencodeModelsSection.smallModel"
            data-value={cfg.smallModel ?? ''}
            className="inline-flex items-center bg-bg-input border border-border rounded-md"
          >
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
          </span>
        </SettingRow>
        <StaleModelNotice
          testid="OpencodeModelsSection.smallModel"
          models={models}
          value={cfg.smallModel ?? ''}
        />
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
    return <SettingRow testid="OpencodeRawConfigSection" description="Loading…" />
  }
  if (!installed) {
    return (
      <SettingRow
        testid="OpencodeRawConfigSection"
        dimmed
        description="opencode is not installed. This edits opencode's own config file."
      />
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
    <div data-testid="OpencodeRawConfigSection" className="divide-y divide-border/55">
      <SettingRow
        description={`Edits opencode's own config file directly (${filePath || 'opencode.jsonc'}); a save touches only the fields you change and keeps comments and unlisted keys.`}
      />
      <OpencodeSchemaForm
        schema={OPENCODE_CONFIG_NODE}
        defs={OPENCODE_SCHEMA_DEFS}
        value={draft}
        onChange={setDraft}
        pickKeys={pickKeys}
      />
      {/* Keys this editor deliberately does not own: each names the page that
          does. Dimmed rows, not links — a pointer is information (ADR-065). */}
      {pointerKeys.map((k) => (
        <SettingRow
          key={k}
          testid="OpencodeRawConfigSection.pointer"
          dataId={k}
          dimmed
          label={k}
          labelClassName="font-mono text-[12px] text-text-primary"
          description={`Managed in ${CONFIG_POINTER_KEYS[k]}.`}
        />
      ))}
      <SettingRow
        label="Save changes"
        description={saved ? 'Saved.' : dirty ? 'Unsaved edits above.' : 'Nothing to save.'}
        error={error ?? undefined}
        errorTestid="OpencodeRawConfigSection.error"
      >
        <Button
          variant="primary"
          testid="OpencodeRawConfigSection.save"
          disabled={!dirty || saving}
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </SettingRow>
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
            {...appDefault(s, u, 'theme')}
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
            {...appDefault(s, u, 'uiFontScale')}
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
            {...appDefault(s, u, 'chatFontScale')}
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
            {...appDefault(s, u, 'mermaidTheme')}
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
            {...appDefault(s, u, 'chatWidthMode')}
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
              {...appDefault(s, u, 'chatWidthPx')}
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
              {...appDefault(s, u, 'chatWidthPercent')}
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
            {...appDefault(s, u, 'maxRecentSessions')}
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
            {...appDefault(s, u, 'sessionTimeoutMins')}
            value={String(s.sessionTimeoutMins)}
            options={[
              { value: '5', label: '5m' },
              { value: '15', label: '15m' },
              { value: '30', label: '30m' },
              { value: '60', label: '1h' },
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
            {...appDefault(s, u, 'expandToolCalls')}
            checked={s.expandToolCalls}
            onChange={(v) => u({ expandToolCalls: v })}
          />
        )
      },
      {
        key: 'expandReadResults',
        label: 'Include read results',
        keywords: 'file content tool',
        // Dependent rows nest exactly one level and stay READABLE when
        // disabled (ADR-065) — the old 40%-opacity wrapper did not.
        render: (s, u) => (
          <SettingsToggle
            label="Include read results"
            {...appDefault(s, u, 'expandReadResults')}
            description="File contents of Read calls, inside the expanded call."
            checked={s.expandReadResults}
            onChange={(v) => u({ expandReadResults: v })}
            indent
            dimmed={!s.expandToolCalls}
            disabled={!s.expandToolCalls}
          />
        )
      },
      {
        key: 'hideToolInput',
        label: 'Hide tool input',
        keywords: 'collapse parameters',
        render: (s, u) => (
          <SettingsToggle
            label="Hide tool input"
            {...appDefault(s, u, 'hideToolInput')}
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
            {...appDefault(s, u, 'expandThinking')}
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
            {...appDefault(s, u, 'toolOutputMaxChars')}
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
            {...appDefault(s, u, 'diffViewSplit')}
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
            {...appDefault(s, u, 'diffIgnoreWhitespace')}
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
            {...appDefault(s, u, 'diffWrapLines')}
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
            {...appDefault(s, u, 'gitCommitMode')}
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
            {...appDefault(s, u, 'gitPanelLayout')}
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
            {...appDefault(s, u, 'statusLineAlign')}
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
          <SettingRow
            testid="StatusLineTemplateSetting"
            {...appDefault(s, u, 'statusLineTemplate')}
            layout="stacked"
            label="Template"
            description="Tokens: {in} {out} {total} · Cost: {cost} · Context: {used} {remaining} · Lines: {lines+} {lines-} · Time: {duration}"
          >
            <TextField
              testid="StatusLineTemplateSetting.input"
              value={s.statusLineTemplate}
              onChange={(v) => u({ statusLineTemplate: v })}
              placeholder="{in} / {out} / {total} · {used}%"
            />
          </SettingRow>
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
          <SettingsSlider
            label="API polling interval"
            {...appDefault(s, u, 'usageRefreshSecs')}
            description="How often to call the usage API for detailed plan data. Rate limits update in real-time from inference headers."
            value={s.usageRefreshSecs}
            min={60}
            max={3600}
            step={60}
            onChange={(v) => u({ usageRefreshSecs: v })}
            formatValue={(v) =>
              v >= 60 ? `${Math.floor(v / 60)}m${v % 60 ? ` ${v % 60}s` : ''}` : `${v}s`
            }
          />
        )
      },
      {
        key: 'analyticsRefreshSecs',
        label: 'Analytics refresh interval',
        keywords: 'analytics token recalculate jsonl refresh block usage',
        render: (s, u) => (
          <SettingsSlider
            label="Analytics refresh interval"
            {...appDefault(s, u, 'analyticsRefreshSecs')}
            description="How often to recalculate token analytics from session transcripts."
            value={s.analyticsRefreshSecs}
            min={10}
            max={120}
            step={5}
            onChange={(v) => u({ analyticsRefreshSecs: v })}
            formatValue={(v) => `${v}s`}
          />
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
            {...appDefault(s, u, 'logLevel')}
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
          <SettingRow
            testid="LogFilterSetting"
            {...appDefault(s, u, 'logFilter')}
            layout="stacked"
            label="Per-source overrides"
            description="Comma-separated. A bare name enables debug for that source; use source:level for an explicit one. Logs are written to ~/.claude/ui/logs/."
          >
            <TextField
              testid="LogFilterSetting.input"
              value={s.logFilter}
              onChange={(v) => u({ logFilter: v })}
              placeholder="UsageFetcher,BlockUsage:debug"
            />
          </SettingRow>
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
          <SettingsToggle
            label="Enable voice input"
            {...appDefault(s, u, 'voiceEnabled')}
            description="Shows a microphone button in the input box. Hold to record, release to transcribe."
            checked={s.voiceEnabled}
            onChange={(v) => u({ voiceEnabled: v })}
          />
        )
      },
      {
        key: 'voiceLanguage',
        label: 'Voice language',
        keywords: 'voice language speech locale',
        render: (s, u) => (
          <SettingRow
            testid="VoiceLanguageSetting"
            {...appDefault(s, u, 'voiceLanguage')}
            label="Language"
            description="What the transcriber expects to hear."
            dimmed={!s.voiceEnabled}
          >
            <SelectField
              testid="VoiceLanguageSetting.language"
              value={s.voiceLanguage}
              disabled={!s.voiceEnabled}
              onChange={(v) => u({ voiceLanguage: v as VoiceLanguageCode })}
              options={VOICE_LANGUAGES.map((lang) => ({ value: lang.code, label: lang.label }))}
            />
          </SettingRow>
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
      // Four items, one per Remote-access group (ADR-065 phase 3B). The item
      // key `remoteServerConfig` predates the split and stays, so the deep
      // links and the inventory guard that name it keep resolving.
      {
        key: 'remoteServerConfig',
        label: 'Remote server',
        keywords: 'remote port autostart bind interface server listen tailscale https tls',
        render: () => <RemoteServerSection />
      },
      {
        key: 'remoteAccess',
        label: 'Remote terminal and VS Code',
        keywords: 'remote terminal shell vs code ide cli path license serve-web',
        render: () => <RemoteAccessSection />
      },
      {
        key: 'remoteSecurity',
        label: 'Sign-in and passkeys',
        keywords:
          'remote password passkey webauthn biometric fingerprint face authentication sign-in enroll device credential step-up session security break-glass',
        render: () => <RemoteSecuritySection />
      },
      {
        key: 'remoteLinks',
        label: 'Access links',
        keywords: 'remote access links url qr code rotate status connected devices tunnel',
        render: () => <RemoteLinksSection />
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
    // The classifier trust lists, ONCE for every engine (ADR-065 phase 4).
    // Its own section rather than three rows inside each engine's auto-mode
    // pane: they are stored in one shared file and derived into whichever
    // engine's judge runs, so an engine-scoped home would misdescribe them.
    id: 'trust-lists',
    label: 'Trust & protection',
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
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    ),
    items: [
      {
        key: 'trustLists',
        label: 'Trust & protection',
        keywords:
          'trusted domains registries production protected patterns judge auto mode classifier supply chain hosts allowlist',
        render: () => <TrustListsSection />
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
            {...appDefault(s, u, 'mockupConnectAllowlist')}
            value={s.mockupConnectAllowlist}
            onChange={(v) => u({ mockupConnectAllowlist: v })}
            placeholder={'api.openweathermap.org\n*.my-startup.com'}
            rows={4}
            monospace
            description="Extends the iframe's CSP connect-src, which otherwise allows only the pinned CDNs and the mockup's own origin. One origin per line, no scheme and no quotes. Add only endpoints you trust — a prompt-injected mockup could exfiltrate to anything on this list."
          />
        )
      },
      {
        key: 'mockupAllowHttp',
        label: 'Allow plaintext (http://) connections',
        keywords: 'mockup http plaintext insecure localhost',
        render: (s, u) => (
          <SettingsToggle
            label="Allow plaintext (http:// & ws://) connections"
            {...appDefault(s, u, 'mockupAllowHttp')}
            description="Lets a mockup reach http:// and ws:// URLs as well as TLS ones — needed for localhost APIs and legacy internal services."
            checked={s.mockupAllowHttp}
            onChange={(v) => u({ mockupAllowHttp: v })}
          />
        )
      },
      {
        key: 'mockupFooter',
        label: 'Mockup security info',
        keywords: 'mockup info csp security',
        render: () => (
          <SettingRow
            testid="MockupSecurityNote"
            description="Mockups render in a sandboxed iframe on a per-mockup origin. Changes apply when the mockup is next loaded or reloaded — open mockups keep the CSP they were served with."
          />
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
            <SettingsToggle
              testid="ClaudeSandbox.enabled"
              label="Command sandbox"
              description="Runs shell commands in an isolated environment — macOS sandbox-exec or Linux bubblewrap, deny-by-default. Not available on Windows."
              checked={sb.enabled}
              onChange={(v) => ue({ sandbox: { ...sb, enabled: v } })}
            />
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
            <SettingsToggle
              testid="ClaudeSandbox.autoAllow"
              label="Auto-approve sandboxed commands"
              description="Skips the permission prompt for bash that runs inside the sandbox, though deny and ask rules still block it."
              checked={sb.autoAllowBashIfSandboxed}
              onChange={(v) => ue({ sandbox: { ...sb, autoAllowBashIfSandboxed: v } })}
              indent
              dimmed={!sb.enabled}
              disabled={!sb.enabled}
            />
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
            <SettingsToggle
              testid="ClaudeSandbox.allowUnsandboxed"
              label="Allow unsandboxed escape"
              description="Lets the model retry a command outside the sandbox when the restrictions make it fail, with a permission prompt each time."
              checked={sb.allowUnsandboxedCommands}
              onChange={(v) => ue({ sandbox: { ...sb, allowUnsandboxedCommands: v } })}
              indent
              dimmed={!sb.enabled}
              disabled={!sb.enabled}
            />
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
            <SettingsToggle
              testid="ClaudeSandbox.localBinding"
              label="Allow local port binding"
              description="Lets sandboxed processes listen on localhost ports, which dev servers like vite and flask need to start."
              checked={sb.network.allowLocalBinding}
              onChange={(v) =>
                ue({ sandbox: { ...sb, network: { ...sb.network, allowLocalBinding: v } } })
              }
              indent
              dimmed={!sb.enabled}
              disabled={!sb.enabled}
            />
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
            <SettingsToggle
              testid="ClaudeSandbox.restrictNetwork"
              label="Restrict network access"
              description="Blocks every outbound connection except the domains listed below; off leaves the sandbox's network open."
              checked={sb.network.restrictNetwork}
              onChange={(v) =>
                ue({ sandbox: { ...sb, network: { ...sb.network, restrictNetwork: v } } })
              }
              indent
              dimmed={!sb.enabled}
              disabled={!sb.enabled}
            />
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
            <SandboxListSetting
              testid="ClaudeSandbox.allowedDomains"
              label="Allowed domains"
              labelColor="text-text-primary"
              description="Domains sandboxed commands may reach, wildcards like *.npmjs.org included; empty blocks all outbound traffic."
              items={sb.network.allowedDomains}
              placeholder="e.g. registry.npmjs.org"
              onUpdate={(items) =>
                ue({ sandbox: { ...sb, network: { ...sb.network, allowedDomains: items } } })
              }
              indent
              dimmed={!(sb.enabled && sb.network.restrictNetwork)}
              disabled={!(sb.enabled && sb.network.restrictNetwork)}
            />
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
            <SettingsToggle
              testid="ClaudeSandbox.managedDomainsOnly"
              label="Managed domains only"
              description="An enterprise policy that honours only the domains from managed settings and ignores the user, project and local ones."
              checked={sb.network.allowManagedDomainsOnly}
              onChange={(v) =>
                ue({
                  sandbox: { ...sb, network: { ...sb.network, allowManagedDomainsOnly: v } }
                })
              }
              indent
              dimmed={!(sb.enabled && sb.network.restrictNetwork)}
              disabled={!(sb.enabled && sb.network.restrictNetwork)}
            />
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
            <SettingsToggle
              testid="ClaudeSandbox.allowAllUnixSockets"
              label="Allow all Unix sockets"
              description="Unblocks every Unix socket including Docker's, which hands sandboxed commands full host access."
              checked={sb.network.allowAllUnixSockets}
              onChange={(v) =>
                ue({ sandbox: { ...sb, network: { ...sb.network, allowAllUnixSockets: v } } })
              }
              indent
              dimmed={!sb.enabled}
              disabled={!sb.enabled}
            />
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
            <SandboxListSetting
              testid="ClaudeSandbox.unixSockets"
              label="Unix socket paths"
              labelColor="text-text-primary"
              description="The socket paths sandboxed commands may open on macOS; Linux filters with seccomp, which cannot match a path."
              items={sb.network.allowUnixSockets}
              placeholder="e.g. /var/run/docker.sock"
              onUpdate={(items) =>
                ue({ sandbox: { ...sb, network: { ...sb.network, allowUnixSockets: items } } })
              }
              indent
              dimmed={!(sb.enabled && !sb.network.allowAllUnixSockets)}
              disabled={!(sb.enabled && !sb.network.allowAllUnixSockets)}
            />
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
            <SandboxListSetting
              testid="ClaudeSandbox.allowWrite"
              label="Additional write paths"
              labelColor="text-text-primary"
              description="Paths outside the project directory that sandboxed commands may write to."
              items={sb.filesystem.allowWrite}
              placeholder="e.g. /usr/local/bin"
              onUpdate={(items) =>
                ue({
                  sandbox: { ...sb, filesystem: { ...sb.filesystem, allowWrite: items } }
                })
              }
              indent
              dimmed={!sb.enabled}
              disabled={!sb.enabled}
            />
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
            <SandboxListSetting
              testid="ClaudeSandbox.denyWrite"
              label="Read-only paths"
              labelColor="text-text-primary"
              description="Paths that stay read-only even when they sit inside a writable area."
              items={sb.filesystem.denyWrite}
              placeholder="e.g. /etc"
              onUpdate={(items) =>
                ue({
                  sandbox: { ...sb, filesystem: { ...sb.filesystem, denyWrite: items } }
                })
              }
              indent
              dimmed={!sb.enabled}
              disabled={!sb.enabled}
            />
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
            <SandboxListSetting
              testid="ClaudeSandbox.denyRead"
              label="Hidden paths"
              labelColor="text-text-primary"
              description="Paths the sandbox cannot read at all, such as ~/.ssh."
              items={sb.filesystem.denyRead}
              placeholder="e.g. ~/.ssh"
              onUpdate={(items) =>
                ue({
                  sandbox: { ...sb, filesystem: { ...sb.filesystem, denyRead: items } }
                })
              }
              indent
              dimmed={!sb.enabled}
              disabled={!sb.enabled}
            />
          )
        }
      },
      {
        key: 'sandboxFooter',
        label: 'Sandbox info',
        keywords: 'sandbox info macos linux bwrap',
        render: () => (
          <SettingRow
            testid="ClaudeSandbox.note"
            description="Filesystem defaults: the project directory and $TMPDIR are writable."
          />
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
        // The label is the search term AND the row's visible label, so it
        // follows the row; the wording it replaces stays in the keywords.
        label: 'Route through a proxy',
        keywords: 'proxy enable http socks5 network tunnel',
        render: (_s, _u, e, ue) => {
          const px = e.proxy ?? DEFAULT_PROXY
          return (
            <SettingsToggle
              testid="ClaudeProxy.enabled"
              label="Route through a proxy"
              description="Sends Claude API traffic through an HTTP or SOCKS5 proxy."
              checked={px.enabled}
              onChange={(v) => ue({ proxy: { ...px, enabled: v } })}
            />
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
            <SettingRow testid="ClaudeProxy.type" label="Type" indent dimmed={!px.enabled}>
              <Segmented
                testid="ClaudeProxy.type.segmented"
                optionTestid="ClaudeProxy.type.option"
                value={px.type}
                options={[
                  { value: 'http' as const, label: 'HTTP' },
                  { value: 'socks5' as const, label: 'SOCKS5' }
                ]}
                onChange={(v) => ue({ proxy: { ...px, type: v } })}
                disabled={!px.enabled}
              />
            </SettingRow>
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
            <SettingRow
              testid="ClaudeProxy.hostname"
              label="Hostname"
              layout="stacked"
              indent
              dimmed={!px.enabled}
            >
              <TextField
                testid="ClaudeProxy.hostname.input"
                value={px.hostname}
                onChange={(v) => ue({ proxy: { ...px, hostname: v } })}
                placeholder="proxy.company.com"
                disabled={!px.enabled}
              />
            </SettingRow>
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
            <SettingRow testid="ClaudeProxy.port" label="Port" indent dimmed={!px.enabled}>
              <NumberField
                testid="ClaudeProxy.port.input"
                value={px.port}
                min={1}
                max={65535}
                placeholder={String(DEFAULT_PROXY.port)}
                // The field commits `undefined` when it is cleared, but the port
                // is a required number: an empty field means "the default".
                onChange={(v) => ue({ proxy: { ...px, port: v ?? DEFAULT_PROXY.port } })}
                disabled={!px.enabled}
              />
            </SettingRow>
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
            <SettingRow
              testid="ClaudeProxy.username"
              label="Username"
              description="Optional."
              indent
              dimmed={!px.enabled}
            >
              <TextField
                testid="ClaudeProxy.username.input"
                value={px.username}
                onChange={(v) => ue({ proxy: { ...px, username: v } })}
                className="w-[240px]"
                disabled={!px.enabled}
              />
            </SettingRow>
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
            <SettingRow
              testid="ClaudeProxy.password"
              label="Password"
              description="Optional."
              indent
              dimmed={!px.enabled}
            >
              <TextField
                testid="ClaudeProxy.password.input"
                type="password"
                value={px.password}
                onChange={(v) => ue({ proxy: { ...px, password: v } })}
                className="w-[240px]"
                disabled={!px.enabled}
              />
            </SettingRow>
          )
        }
      },
      {
        key: 'proxyTestConnection',
        label: 'Test proxy connection',
        keywords: 'test verify check ping connectivity',
        render: (_s, _u, e) => {
          const px = e.proxy ?? DEFAULT_PROXY
          return <ProxyTestButton proxy={px} />
        }
      },
      {
        key: 'proxySubprocesses',
        label: 'Proxy shell commands',
        keywords: 'proxy bash subprocess shell git curl npm everything all',
        render: (_s, _u, e, ue) => {
          const px = e.proxy ?? DEFAULT_PROXY
          return (
            <SettingsToggle
              testid="ClaudeProxy.subprocesses"
              label="Also proxy shell commands"
              description="Sets HTTP_PROXY and HTTPS_PROXY for commands the agent runs; off keeps them direct."
              checked={px.proxySubprocesses === true}
              onChange={(v) => ue({ proxy: { ...px, proxySubprocesses: v } })}
              indent
              dimmed={!px.enabled}
              disabled={!px.enabled}
            />
          )
        }
      },
      {
        key: 'proxyFooter',
        label: 'Proxy info',
        keywords: 'proxy info env environment variable',
        render: () => (
          <SettingRow
            testid="ClaudeProxy.note"
            description="Applies to the Claude API connection; shell commands only when the toggle above is on."
          />
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
        render: () => <ClaudeDispatchIntoSection />
      },
      {
        key: 'claudeDispatchLimits',
        label: 'Dispatch limits',
        keywords: 'claude dispatch cost cap budget usd limit timeout',
        render: () => <ClaudeDispatchLimitsSection />
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
        // ADR-065 phase 6b/6c: ONE list over the three provider stores. The item
        // KEY is unchanged — it is what the page model, the deep links and the
        // inventory guard address — while what it renders is the unified list,
        // whose Manage and Add sheets are now the ONLY provider surface: the
        // vault's own pane, opencode's `vendor-opencode` and pi's `vendor-pi`
        // were retired with 6c.
        key: 'sharedProviders',
        label: 'Providers',
        keywords:
          'shared provider add chatgpt codex api key oauth credential subscription custom endpoint model pi opencode anthropic openrouter ollama',
        render: (_s, _u, _e, _ue, _v, _uv, ctx) => <ProviderList navigate={ctx?.navigate} />
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
            modified={m.id in (s.modelEffortDefaults ?? {})}
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
          <SettingRow
            testid="EffortDefaultsNote"
            description="Applied when a new session starts on the matching model or one of its aliases (picking opus uses the Opus 4.8 row); the per-session effort chip always wins."
          />
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
          'opencode auto mode full autonomy classifier gatekeeper judge model llm permission bash security monitor',
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
        render: () => <OpencodeDispatchIntoSection />
      },
      {
        key: 'opencodeDispatchLimits',
        label: 'Dispatch limits',
        keywords: 'opencode dispatch cost cap budget usd limit turn duration inactivity timeout',
        render: () => <OpencodeDispatchLimitsSection />
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
          'pi auto mode full autonomy classifier gatekeeper judge model llm permission bash security monitor',
        render: () => <PiAutoModeSection />
      }
    ]
  },
  {
    id: 'pi-dispatch',
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
        key: 'piDispatch',
        label: 'Cross-engine dispatch',
        keywords:
          'pi dispatch cross engine agent delegate collab model allowlist default target incoming',
        render: () => <PiDispatchIntoSection />
      },
      {
        key: 'piDispatchLimits',
        label: 'Dispatch limits',
        keywords: 'pi dispatch cost cap budget usd limit',
        render: () => <PiDispatchLimitsSection />
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
    id: 'pi-config-retry',
    label: 'Automatic retry',
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
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
    ),
    items: [
      {
        key: 'piRetry',
        label: 'Automatic retry',
        keywords:
          'pi retry enabled maxRetries baseDelayMs provider timeoutMs maxRetryDelayMs backoff transient errors',
        render: () => <PiRetrySection />
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
    id: 'pi-config-fallbacks',
    label: 'pi fallbacks',
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
        <path d="M4 4v6h6" />
        <path d="M4 10a8 8 0 1 1 2.3 5.7" />
      </svg>
    ),
    items: [
      {
        key: 'piFallbacks',
        label: 'pi fallbacks',
        keywords:
          'pi defaultProvider defaultModel defaultThinkingLevel thinkingBudgets fallback standalone thinking budget reasoning',
        render: () => <PiFallbacksSection />
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
    id: 'pi-config-resources',
    label: 'Resources',
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
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    ),
    items: [
      {
        key: 'piResources',
        label: 'Resources',
        keywords: 'pi packages extensions skills prompts paths npm git resources',
        render: () => <PiResourcesSection />
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
  }
]
