/**
 * PiConfigPanes.tsx
 *
 * The pi engine page's group bodies (ADR-065): curated panes over the settings
 * worth a real control, plus a full-file text editor ("Raw config") for
 * everything else — pi publishes no JSON schema for `settings.json`, so there is
 * no generic schema-driven form to fall back on the way opencode has one.
 *
 * All of them read and write pi's OWN global settings file
 * (`~/.pi/agent/settings.json`) through the leaf-patch IPC pair
 * (readPiNativeRaw / patchPiNative), which byte-preserves untouched siblings.
 * GLOBAL SCOPE ONLY: pi's project-local `.pi/settings.json` overrides the global
 * file and is not ClaudeUI's to edit.
 *
 * Every row renders through the ADR-065 row vocabulary — the shared row
 * primitives in OpencodeConfigPanes.tsx (which wrap `SettingRow`) under the
 * `PiConfigPane` testid prefix, or `SettingRow` itself for the few controls that
 * are pi-only. There are no sub-headers and no per-pane footers: a divider
 * inside a pane is a GROUP boundary, so each former sub-header is now its own
 * exported section (PiRetrySection, PiResourcesSection, PiFallbacksSection), and
 * "saved immediately / applies to new sessions" is the group card's note.
 *
 * Behavioural conventions are unchanged, and they are what the tests pin:
 *
 *  · IMMEDIATE SAVES. No Save button: a toggle, chip, segment or select click
 *    commits at once; number and text inputs commit on blur AND Enter. Each
 *    commit is ONE leaf patch, and the file is re-read afterwards. The Raw
 *    config pane is the one exception — a whole-file text editor cannot commit
 *    per keystroke, so it has an explicit Save.
 *  · ABSENT MEANS DEFAULT. A key whose absence already gives the wanted
 *    behaviour is DELETED rather than written with its default value. An empty
 *    number/text input deletes its key, and that is also what the row's Reset
 *    affordance does (a key is "changed from default" exactly when it is
 *    PRESENT in the file). The one deliberate exception is `defaultTools`, where
 *    an explicit `[]` means "no built-in tools" and is a different thing from
 *    absent — see the chip row.
 *  · LEAF PATCHES ONLY. `compaction.enabled`, `retry.provider.maxRetries`,
 *    `thinkingBudgets.low` are patched at their own path, never by writing the
 *    parent — a user file may hold sibling keys these panes don't model (pi's
 *    TUI-only settings, most of them), and a whole-object write would erase them.
 *
 * `PiModelsSection` also carries ClaudeUI's OWN pi session-default model + model
 * allowlist, which live in `engines/pi.json` rather than pi's settings.json.
 * Two files behind one group is deliberate: "which model do pi sessions start
 * with" is one question, and answering it in two places was the confusion.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSessionStore, PI_DEFAULT_MODEL } from '../../stores/session-store'
import {
  SettingRow,
  Segmented,
  SelectField,
  TextField,
  ChipSet,
  ListEditor,
  Button
} from './settings-controls'
import { ModelPicker } from '../shared/InlinePickers'
import { RawJsonField } from './OpencodeSchemaForm'
import {
  LeafRow,
  StackedRow,
  ToggleRow,
  LeafNumberInput,
  LeafTextInput
} from './OpencodeConfigPanes'
import { PiModelAllowlistDialog } from './PiModelAllowlistDialog'
import { toModelDisplays, selectedModelDisplay, StaleModelNotice } from './settings-model-display'
import { usePiInstalled } from './use-engine-installed'
import { deepEqual, isPlainObject } from '../../../../shared/opencode-config-diff'
import type { EngineConfig, ModelInfo, RawConfigPatch } from '../../../../shared/types'

/** Testid namespace for every control these panes render (ADR-027 tier 2). */
const PANE = 'PiConfigPane'

// ── Leaf read/write plumbing ─────────────────────────────────────────────────

type LeafPath = (string | number)[]

/** Stable string form of a path — used to key inline errors, testids, labels. */
const pathId = (path: LeafPath): string => path.join('.')

function readLeaf(root: unknown, path: LeafPath): unknown {
  let cur: unknown = root
  for (const seg of path) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[String(seg)]
  }
  return cur
}

interface PiNativeConfigLeaf {
  /** null until the first read resolves — panes render Loading… meanwhile. */
  config: Record<string, unknown> | null
  /** The file's text as stored (BOM-stripped); '' when it does not exist yet. */
  text: string
  /** Resolved settings file path (the Raw config row's key line). */
  filePath: string
  read: (path: LeafPath) => unknown
  /**
   * Commit ONE leaf. `undefined` deletes the key. A no-op when the value already
   * matches, so a blur without an edit never touches the file.
   */
  patch: (path: LeafPath, value: unknown) => void
  errorAt: (path: LeafPath) => string | null
  reload: () => void
}

/**
 * The pi twin of `useOpencodeNativeConfigLeaf`. Kept as its own hook rather than
 * hoisting a shared generic out of the opencode panes: the two differ (this one
 * also carries the raw file `text` the Raw config pane edits), and B1 set the
 * precedent of leaving opencode's shipped code untouched where the overlap is
 * boilerplate rather than behaviour.
 */
function usePiNativeConfigLeaf(): PiNativeConfigLeaf {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [text, setText] = useState('')
  const [filePath, setFilePath] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const reload = useCallback((): void => {
    window.api
      .readPiNativeRaw()
      .then(({ config: next, path, text: raw }) => {
        setConfig(next)
        setFilePath(path)
        setText(raw)
      })
      .catch(() => setConfig({}))
  }, [])

  useEffect(() => reload(), [reload])

  const read = useCallback((path: LeafPath) => readLeaf(config, path), [config])

  const patch = useCallback(
    (path: LeafPath, value: unknown): void => {
      if (deepEqual(readLeaf(config, path), value)) return
      const id = pathId(path)
      const one: RawConfigPatch = value === undefined ? { path } : { path, value }
      window.api
        .patchPiNative([one])
        .then(() => {
          setErrors((prev) => {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          })
          reload()
        })
        .catch((e: unknown) => {
          setErrors((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }))
        })
    },
    [config, reload]
  )

  const errorAt = useCallback((path: LeafPath) => errors[pathId(path)] ?? null, [errors])

  return { config, text, filePath, read, patch, errorAt, reload }
}

// ── Pane shell (install gate) ────────────────────────────────────────────────

/**
 * The install gate, and the hairline between rows.
 *
 * A group CARD divides its items (View.tsx), but a whole pane is one item, so
 * the rows inside it need the same divider to read as the card's rows rather
 * than as one block of text. There is no footer: what the group applies to and
 * where it is stored are the card header's storage tag and its note (ADR-065).
 */
function PaneShell({
  testid,
  api,
  children
}: {
  testid: string
  api: PiNativeConfigLeaf
  children: React.ReactNode
}): React.JSX.Element {
  const installed = usePiInstalled()

  if (installed === null || api.config === null) {
    return (
      <div data-testid={testid}>
        <SettingRow testid={`${PANE}.status`} dataId="loading" description="Loading…" />
      </div>
    )
  }
  if (!installed) {
    return (
      <div data-testid={testid}>
        <SettingRow
          testid={`${PANE}.status`}
          dataId="not-installed"
          dimmed
          description="pi is not installed. These settings edit pi's own settings file."
        />
      </div>
    )
  }
  return (
    <div data-testid={testid} className="divide-y divide-border/55">
      {children}
    </div>
  )
}

// ── Row bindings ─────────────────────────────────────────────────────────────

/**
 * Toggle over a key whose ABSENCE already means `defaultOn`. Switching TO the
 * default deletes the key instead of writing the default value, so the file
 * keeps only real overrides and follows pi if the default ever moves.
 */
function AbsentDefaultToggleRow({
  api,
  path,
  label,
  helper,
  defaultOn
}: {
  api: PiNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  defaultOn: boolean
}): React.JSX.Element {
  const raw = api.read(path)
  const on = typeof raw === 'boolean' ? raw : defaultOn
  return (
    <ToggleRow
      testidPrefix={PANE}
      configKey={pathId(path)}
      label={label}
      helper={helper}
      checked={on}
      onChange={(next) => api.patch(path, next === defaultOn ? undefined : next)}
      error={api.errorAt(path)}
      modified={raw !== undefined}
      onReset={() => api.patch(path, undefined)}
    />
  )
}

/** Number row bound to one leaf; an emptied field deletes the key. */
function NumberRow({
  api,
  path,
  label,
  helper,
  placeholder,
  unit
}: {
  api: PiNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  placeholder: string
  /** tokens / ms / lines … omitted for a plain count. */
  unit?: string
}): React.JSX.Element {
  const key = pathId(path)
  const raw = api.read(path)
  return (
    <LeafRow
      testidPrefix={PANE}
      configKey={key}
      label={label}
      helper={helper}
      error={api.errorAt(path)}
      modified={raw !== undefined}
      onReset={() => api.patch(path, undefined)}
    >
      <LeafNumberInput
        testid={`${PANE}.number`}
        configKey={key}
        value={raw}
        placeholder={placeholder}
        unit={unit}
        onCommit={(v) => api.patch(path, v)}
      />
    </LeafRow>
  )
}

/** Text row bound to one leaf; an emptied input deletes the key. */
function TextRow({
  api,
  path,
  label,
  helper,
  placeholder
}: {
  api: PiNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  placeholder: string
}): React.JSX.Element {
  const key = pathId(path)
  const raw = api.read(path)
  return (
    <LeafRow
      testidPrefix={PANE}
      configKey={key}
      label={label}
      helper={helper}
      error={api.errorAt(path)}
      modified={raw !== undefined}
      onReset={() => api.patch(path, undefined)}
    >
      <LeafTextInput
        testid={`${PANE}.text`}
        configKey={key}
        value={raw}
        placeholder={placeholder}
        onCommit={(v) => api.patch(path, v)}
      />
    </LeafRow>
  )
}

/**
 * Segmented row for a small closed set of string values (ADR-065: five options
 * or fewer). `defaultValue` is the choice pi already makes when the key is
 * ABSENT, so selecting it deletes the key rather than writing pi's own default
 * back into the file.
 */
function SegmentedRow({
  api,
  path,
  label,
  helper,
  options,
  defaultValue
}: {
  api: PiNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  options: { value: string; label: string }[]
  defaultValue: string
}): React.JSX.Element {
  const key = pathId(path)
  const raw = api.read(path)
  const current = typeof raw === 'string' ? raw : defaultValue
  return (
    <LeafRow
      testidPrefix={PANE}
      configKey={key}
      label={label}
      helper={helper}
      error={api.errorAt(path)}
      modified={raw !== undefined}
      onReset={() => api.patch(path, undefined)}
    >
      <Segmented
        value={current}
        options={options}
        onChange={(v) => api.patch(path, v === defaultValue ? undefined : v)}
        testid={`${PANE}.segmented`}
        // The option id call sites have always asserted; the row's `data-id`
        // scopes it, so the option keeps the raw value as its discriminator.
        optionTestid={`${PANE}.segment`}
      />
    </LeafRow>
  )
}

/** Select row for a closed set too large (or too wide) for a segmented control. */
function SelectRow({
  api,
  path,
  label,
  helper,
  options,
  defaultValue,
  width
}: {
  api: PiNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  options: { value: string; label: string }[]
  defaultValue: string
  /** A literal Tailwind width class — Tailwind v4 cannot see built strings. */
  width?: string
}): React.JSX.Element {
  const key = pathId(path)
  const raw = api.read(path)
  return (
    <LeafRow
      testidPrefix={PANE}
      configKey={key}
      label={label}
      helper={helper}
      error={api.errorAt(path)}
      modified={raw !== undefined}
      onReset={() => api.patch(path, undefined)}
    >
      <SelectField
        testid={`${PANE}.select`}
        value={typeof raw === 'string' ? raw : defaultValue}
        options={options}
        width={width}
        onChange={(v) => api.patch(path, v === defaultValue ? undefined : v)}
      />
    </LeafRow>
  )
}

/**
 * String-list row bound to one leaf; an emptied list deletes the key. Entries
 * this control cannot represent (pi's object-form `packages`) are carried
 * through untouched rather than dropped on the next edit.
 */
function StringListRow({
  api,
  path,
  label,
  helper,
  placeholder,
  opaqueNote
}: {
  api: PiNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  placeholder: string
  /** Sentence shown when the list holds entries the chips cannot render. */
  opaqueNote?: (count: number) => string
}): React.JSX.Element {
  const key = pathId(path)
  const raw = api.read(path)
  const items = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  const opaque = Array.isArray(raw) ? raw.filter((v) => typeof v !== 'string') : []
  return (
    <StackedRow
      testidPrefix={PANE}
      configKey={key}
      label={label}
      helper={helper}
      error={api.errorAt(path)}
      modified={raw !== undefined}
      onReset={() => api.patch(path, undefined)}
    >
      <ListEditor
        items={items}
        placeholder={placeholder}
        onUpdate={(next) => {
          const merged = [...next, ...opaque]
          api.patch(path, merged.length > 0 ? merged : undefined)
        }}
        testid={`${PANE}.list`}
      />
      {opaque.length > 0 && (
        <span
          data-testid={`${PANE}.opaqueNote`}
          data-id={key}
          className="block mt-2 text-[12px] leading-4 text-text-secondary"
        >
          {opaqueNote
            ? opaqueNote(opaque.length)
            : `${opaque.length} advanced ${opaque.length === 1 ? 'entry' : 'entries'} in this list are kept as-is and not shown here.`}
        </span>
      )}
    </StackedRow>
  )
}

// ── Session behaviour ────────────────────────────────────────────────────────

export function PiSessionBehaviorSection(): React.JSX.Element {
  const api = usePiNativeConfigLeaf()
  return (
    <PaneShell testid="PiSessionBehaviorSection" api={api}>
      <AbsentDefaultToggleRow
        api={api}
        path={['compaction', 'enabled']}
        label="Compact automatically"
        helper="Summarise the session when the context window fills."
        defaultOn={true}
      />
      <NumberRow
        api={api}
        path={['compaction', 'reserveTokens']}
        label="Reserved tokens"
        helper="Headroom kept free for the model's reply so compaction can't overflow the window."
        placeholder="16384"
        unit="tokens"
      />
      <NumberRow
        api={api}
        path={['compaction', 'keepRecentTokens']}
        label="Recent tokens preserved"
        helper="Verbatim tail kept out of the summary."
        placeholder="20000"
        unit="tokens"
      />
      <NumberRow
        api={api}
        path={['branchSummary', 'reserveTokens']}
        label="Branch summary reserve"
        helper="Tokens reserved when a forked branch is summarised."
        placeholder="16384"
        unit="tokens"
      />
    </PaneShell>
  )
}

/**
 * Was the "Automatic retry" sub-header inside Session behaviour. ADR-065 has no
 * sub-header inside a pane: a divider is a group boundary, so this is its own
 * group on the pi page.
 */
export function PiRetrySection(): React.JSX.Element {
  const api = usePiNativeConfigLeaf()
  return (
    <PaneShell testid="PiRetrySection" api={api}>
      <AbsentDefaultToggleRow
        api={api}
        path={['retry', 'enabled']}
        label="Retry on transient errors"
        helper="Agent-level retry with exponential backoff."
        defaultOn={true}
      />
      <NumberRow
        api={api}
        path={['retry', 'maxRetries']}
        label="Max retries"
        helper="Agent-level attempts before the turn fails."
        placeholder="3"
      />
      <NumberRow
        api={api}
        path={['retry', 'baseDelayMs']}
        label="Base delay"
        helper="Doubles each attempt, so 2s becomes 4s then 8s."
        placeholder="2000"
        unit="ms"
      />
      <NumberRow
        api={api}
        path={['retry', 'provider', 'timeoutMs']}
        label="Provider request timeout"
        helper="SDK-level timeout for one request; empty uses the SDK's own."
        placeholder="SDK default"
        unit="ms"
      />
      <NumberRow
        api={api}
        path={['retry', 'provider', 'maxRetryDelayMs']}
        label="Provider max retry delay"
        helper="Longer server-requested waits fail loudly instead of blocking; 0 disables the cap."
        placeholder="60000"
        unit="ms"
      />
      <NumberRow
        api={api}
        path={['retry', 'provider', 'maxRetries']}
        label="Provider retries"
        helper="Keep at 0 — SDK retries can swallow quota errors before pi sees them."
        placeholder="0"
      />
    </PaneShell>
  )
}

// ── Models & thinking ────────────────────────────────────────────────────────

/**
 * ClaudeUI's OWN pi defaults — `EngineConfig.piConfig.defaultModel` and the
 * private model allowlist, both in `engines/pi.json` via
 * loadEngineConfig/saveEngineConfig, NOT pi's settings.json. Discovered models
 * use the themed picker, with an explicit custom-ID escape hatch for a model pi
 * supports locally that ClaudeUI has not discovered yet.
 *
 * Its testids are unchanged across the ADR-065 restyle so the deep links and
 * tests that name them keep working. The install gate lives in `PaneShell`.
 */
function PiSessionDefaultModel(): React.JSX.Element {
  const [cfg, setCfg] = useState<EngineConfig | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [customMode, setCustomMode] = useState(false)
  const [managingModels, setManagingModels] = useState(false)

  useEffect(() => {
    window.api
      .loadEngineConfig('pi')
      .then(setCfg)
      .catch(() => setCfg({}))
    window.api
      .getEngineModels()
      .then((groups) => {
        const pi = groups.filter((g) => g.engineId === 'pi')
        setModels(pi.flatMap((g) => g.models))
      })
      .catch(() => {})
  }, [])

  const refreshModels = (): void => {
    window.api
      .getEngineModels()
      .then((groups) =>
        setModels(groups.filter((g) => g.engineId === 'pi').flatMap((g) => g.models))
      )
      .catch(() => {})
  }

  if (cfg === null) {
    return (
      <div data-testid="PiDefaultModelSection">
        <SettingRow testid={`${PANE}.status`} dataId="models-loading" description="Loading…" />
      </div>
    )
  }

  const current = cfg.piConfig?.defaultModel ?? ''
  const known = current === '' || models.some((m) => m.value === current)
  const allowlist = cfg.piConfig?.modelAllowlist
  const defaultExcluded = !!current && allowlist !== undefined && !allowlist.includes(current)

  const saveAllowlist = async (modelAllowlist: string[]): Promise<void> => {
    const latest = await window.api.loadEngineConfig('pi')
    const next: EngineConfig = {
      ...latest,
      piConfig: { ...latest.piConfig, modelAllowlist }
    }
    await window.api.saveEngineConfig('pi', next)
    setCfg(next)
    useSessionStore.getState().reloadModels()
    refreshModels()
  }

  const update = (value: string): void => {
    const next: EngineConfig = {
      ...cfg,
      piConfig: { ...cfg.piConfig, defaultModel: value || undefined }
    }
    setCfg(next)
    window.api.saveEngineConfig('pi', next).catch(() => {})
    // Mirror the default-model choice into the store so new/reopened pi
    // sessions pick it up immediately, and refresh the picker model list.
    // The RAW value (not the constant): an empty string is what tells the store
    // that nothing is configured, which is what separates "the builtin default
    // may fall back silently" from "the user named this model".
    useSessionStore.getState().setPiDefaultModel(value)
    useSessionStore.getState().reloadModels()
  }

  return (
    <div data-testid="PiDefaultModelSection">
      <div className="divide-y divide-border/55">
        <SettingRow
          testid={`${PANE}.row`}
          dataId="piConfig.defaultModel"
          label="Default model"
          description={`The model new pi sessions start with; unset falls back to pi's own default (${PI_DEFAULT_MODEL}).`}
          keyText="engines/pi.json · defaultModel"
          modified={current !== ''}
          onReset={() => update('')}
        >
          {models.length > 0 && (
            // Themed ModelPicker rather than a native <select> (OS-painted option
            // lists are unreadable in dark themes). `__custom__` stays a real
            // selectable VALUE — it is a mode switch, not a model, so it rides
            // the picker's pinned trailing row instead of the model groups.
            <span
              data-testid="PiDefaultModelSection.defaultModel"
              data-value={customMode || !known ? '__custom__' : current}
            >
              <ModelPicker
                variant="field"
                placement="down"
                emptyOption={{ label: `Default (${PI_DEFAULT_MODEL})` }}
                trailingOption={{ value: '__custom__', label: 'Custom model ID...' }}
                models={toModelDisplays(models)}
                selectedModel={
                  customMode || !known
                    ? {
                        value: '__custom__',
                        displayName: 'Custom model ID...',
                        shortName: 'Custom model ID...'
                      }
                    : selectedModelDisplay(models, current, `Default (${PI_DEFAULT_MODEL})`)
                }
                onSelectModel={(v) => {
                  if (v === '__custom__') setCustomMode(true)
                  else {
                    setCustomMode(false)
                    update(v)
                  }
                }}
              />
            </span>
          )}
        </SettingRow>

        {models.length === 0 && (
          <SettingRow
            testid="PiDefaultModelSection.empty"
            label="No pi models discovered. Authenticate a provider, then refresh the model list."
            labelClassName="text-warning"
          />
        )}

        {(models.length === 0 || customMode || !known) && (
          <SettingRow
            testid={`${PANE}.row`}
            dataId="piConfig.defaultModel.custom"
            layout="stacked"
            indent
            label="Custom model ID"
            description="A provider/model-id pi supports locally that ClaudeUI has not discovered — e.g. openai-codex/gpt-5.6-luna."
          >
            <TextField
              testid="PiDefaultModelSection.customModel"
              value={current}
              onChange={update}
              placeholder="provider/model-id"
            />
          </SettingRow>
        )}

        {defaultExcluded ? (
          <SettingRow
            testid="PiDefaultModelSection.excludedDefaultWarning"
            label="The configured default is excluded by the model list, so new pi sessions will start with no model until it is enabled or replaced."
            labelClassName="text-warning"
          />
        ) : (
          <StaleModelNotice
            testid="PiDefaultModelSection.defaultModel"
            models={models}
            value={current}
          />
        )}

        {!known && !defaultExcluded && (
          <SettingRow
            testid="PiDefaultModelSection.unknownWarning"
            label="Not in pi's currently-discovered model list, so it is used as-is — check the provider is authenticated and the id is spelled correctly."
            labelClassName="text-warning"
          />
        )}

        <SettingRow
          testid={`${PANE}.row`}
          dataId="piConfig.modelAllowlist"
          label="Model list"
          description="Which discovered pi models the picker offers; all of them unless you curate the list."
          keyText="engines/pi.json · modelAllowlist"
        >
          <Button variant="link" testid="PiDefaultModelSection.refresh" onClick={refreshModels}>
            Refresh
          </Button>
          <Button
            testid="PiDefaultModelSection.manageModels"
            onClick={() => setManagingModels(true)}
          >
            Manage (
            {allowlist === undefined
              ? 'all'
              : allowlist.length === 0
                ? 'none'
                : `${allowlist.length} selected`}
            )
          </Button>
        </SettingRow>
      </div>
      {managingModels && (
        <PiModelAllowlistDialog
          providerName="pi"
          current={allowlist}
          onClose={() => setManagingModels(false)}
          onSave={saveAllowlist}
        />
      )}
    </div>
  )
}

export function PiModelsSection(): React.JSX.Element {
  const api = usePiNativeConfigLeaf()
  return (
    <PaneShell testid="PiModelsSection" api={api}>
      <PiSessionDefaultModel />
    </PaneShell>
  )
}

/**
 * The thinking levels pi documents a budget for. Each is its own leaf, so a
 * level the user has not set stays absent; clearing the LAST one removes the
 * `thinkingBudgets` object rather than leaving `{}` behind.
 */
const THINKING_BUDGET_LEVELS = ['minimal', 'low', 'medium', 'high'] as const

/**
 * `defaultThinkingLevel`'s closed set, plus the pinned "absent" choice. Eight
 * options is past the segmented limit (ADR-065: five), so this is a select.
 * Labels are the literal config values — these rows write pi's own enum.
 */
const THINKING_LEVEL_OPTIONS = [
  { value: '', label: 'default' },
  { value: 'off', label: 'off' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' }
]

function ThinkingBudgetsRow({ api }: { api: PiNativeConfigLeaf }): React.JSX.Element {
  const raw = api.read(['thinkingBudgets'])
  const budgets = isPlainObject(raw) ? raw : {}

  const commit = (level: string, value: number | undefined): void => {
    if (value !== undefined) {
      api.patch(['thinkingBudgets', level], value)
      return
    }
    // Clearing the last remaining budget deletes the whole object: the writer
    // leaves an emptied parent alone, so collapsing it is the pane's job. Every
    // OTHER key counts, including levels this grid doesn't render.
    const others = Object.keys(budgets).filter((k) => k !== level)
    if (others.length === 0) api.patch(['thinkingBudgets'], undefined)
    else api.patch(['thinkingBudgets', level], undefined)
  }

  return (
    <StackedRow
      testidPrefix={PANE}
      configKey="thinkingBudgets"
      label="Thinking budgets"
      helper="Per-level token budgets, native on Anthropic, Google and Bedrock; OpenAI-compatible models need compat support."
      error={
        // One shared row error: only one field can be in flight at a time.
        THINKING_BUDGET_LEVELS.map((l) => api.errorAt(['thinkingBudgets', l])).find(Boolean) ??
        api.errorAt(['thinkingBudgets'])
      }
      modified={raw !== undefined}
      onReset={() => api.patch(['thinkingBudgets'], undefined)}
    >
      <span className="grid grid-cols-4 gap-x-4 gap-y-2">
        {THINKING_BUDGET_LEVELS.map((level) => (
          <span key={level} className="block min-w-0">
            <span className="block text-[12px] leading-4 text-text-secondary mb-1">{level}</span>
            <span className="flex items-center gap-2">
              <LeafNumberInput
                testid={`${PANE}.number`}
                configKey={`thinkingBudgets.${level}`}
                value={budgets[level]}
                placeholder="default"
                unit="tokens"
                onCommit={(v) => commit(level, v)}
              />
            </span>
          </span>
        ))}
      </span>
    </StackedRow>
  )
}

/**
 * Was the "pi fallbacks" sub-header inside Models & thinking: pi's OWN
 * settings.json defaults, used when the ClaudeUI session default is unset and by
 * standalone pi. Its own group (ADR-065) because it writes a different file from
 * the rows above it.
 */
export function PiFallbacksSection(): React.JSX.Element {
  const api = usePiNativeConfigLeaf()
  return (
    <PaneShell testid="PiFallbacksSection" api={api}>
      <TextRow
        api={api}
        path={['defaultProvider']}
        label="Default provider"
        helper="Used when no model is picked."
        placeholder="unset"
      />
      <TextRow
        api={api}
        path={['defaultModel']}
        label="Default model"
        helper="Model id used with that provider."
        placeholder="unset"
      />
      <SelectRow
        api={api}
        path={['defaultThinkingLevel']}
        label="Default thinking level"
        helper="Reasoning effort pi starts a session with."
        options={THINKING_LEVEL_OPTIONS}
        defaultValue=""
      />
      <ThinkingBudgetsRow api={api} />
    </PaneShell>
  )
}

// ── Tools & shell ────────────────────────────────────────────────────────────

/** pi's built-in tool ids, in the order settings.md lists them. */
const PI_BUILTIN_TOOLS = [
  'read',
  'bash',
  'powershell',
  'edit',
  'write',
  'grep',
  'find',
  'ls'
] as const

/**
 * The built-ins pi actually enables when `defaultTools` is ABSENT. The docs only
 * say "Pi uses its standard defaults" without naming them, so this set was
 * PROBED on 2026-08-28 against the vendored pi 0.84.3 (RPC mode, Windows). It is
 * used for one thing only: seeding the explicit array on the FIRST chip click,
 * so that click doesn't silently drop the tools that were already on.
 */
const PI_DEFAULT_TOOLS_WHEN_ABSENT = ['read', 'bash', 'edit', 'write'] as const

const TOOL_CHIP_OPTIONS = PI_BUILTIN_TOOLS.map((id) => ({ value: id, label: id }))

function DefaultToolsRow({ api }: { api: PiNativeConfigLeaf }): React.JSX.Element {
  const path: LeafPath = ['defaultTools']
  const raw = api.read(path)
  // ABSENT vs EXPLICIT is the whole semantic here: an explicit `[]` means "no
  // built-in tools at all" and must be written, never deleted.
  const explicit = Array.isArray(raw) ? raw : null
  const selected = explicit?.filter((v): v is string => typeof v === 'string') ?? []
  const opaque = explicit?.filter((v) => typeof v !== 'string') ?? []

  const toggle = (id: string): void => {
    const base = explicit === null ? [...PI_DEFAULT_TOOLS_WHEN_ABSENT] : selected
    const next = base.includes(id) ? base.filter((t) => t !== id) : [...base, id]
    api.patch(path, [...next, ...opaque])
  }

  return (
    <StackedRow
      testidPrefix={PANE}
      configKey="defaultTools"
      label="Built-in tools"
      helper="Which of pi's own tools load at session start; extension and SDK tools are unaffected."
      error={api.errorAt(path)}
      modified={explicit !== null}
      onReset={() => api.patch(path, undefined)}
    >
      {/* The chip set's own testid is the pane prefix so each chip stays
          `PiConfigPane.chip` + its tool id, which is the asserted contract. */}
      <ChipSet testid={PANE} value={selected} options={TOOL_CHIP_OPTIONS} onToggle={toggle} />
      <span className="block mt-2 text-[12px] leading-4 text-text-secondary">
        {explicit === null ? (
          <span data-testid={`${PANE}.toolsDefaultCaption`}>
            pi standard defaults active ({PI_DEFAULT_TOOLS_WHEN_ABSENT.join(', ')}). Picking a chip
            starts from that set.
          </span>
        ) : (
          <span className="inline-flex items-center gap-2">
            {selected.length === 0 && <span>No built-in tools — extension tools still load.</span>}
            <Button
              variant="link"
              testid={`${PANE}.toolsUseDefaults`}
              onClick={() => api.patch(path, undefined)}
            >
              Use pi defaults
            </Button>
          </span>
        )}
      </span>
    </StackedRow>
  )
}

export function PiToolsSection(): React.JSX.Element {
  const api = usePiNativeConfigLeaf()
  const npmPath: LeafPath = ['npmCommand']
  const npmValue = api.read(npmPath)
  return (
    <PaneShell testid="PiToolsSection" api={api}>
      <DefaultToolsRow api={api} />
      <TextRow
        api={api}
        path={['shellPath']}
        label="Shell path"
        helper="Custom shell for the bash tool, e.g. Git Bash on Windows."
        placeholder="system default"
      />
      <TextRow
        api={api}
        path={['shellCommandPrefix']}
        label="Command prefix"
        helper="Prepended to every bash command."
        placeholder="unset"
      />
      <StackedRow
        testidPrefix={PANE}
        configKey="npmCommand"
        label="npm command"
        helper={
          'Argv used for package installs, as a JSON array — empty runs npm, e.g. ["mise","exec","node@20","--","npm"].'
        }
        error={api.errorAt(npmPath)}
        modified={npmValue !== undefined}
        onReset={() => api.patch(npmPath, undefined)}
      >
        {/* Keyed on the committed value so a re-read reseeds the textarea
            instead of showing a value that is no longer in the file. */}
        <RawJsonField
          key={String(JSON.stringify(npmValue))}
          fieldKey="npmCommand"
          value={npmValue}
          onChange={(v) => api.patch(npmPath, v)}
        />
      </StackedRow>
    </PaneShell>
  )
}

// ── Image attachments ────────────────────────────────────────────────────────

export function PiImagesSection(): React.JSX.Element {
  const api = usePiNativeConfigLeaf()
  return (
    <PaneShell testid="PiImagesSection" api={api}>
      <AbsentDefaultToggleRow
        api={api}
        path={['images', 'autoResize']}
        label="Auto-resize images"
        helper="Downscale attachments, read results and tool-returned images to 2000×2000 before sending."
        defaultOn={true}
      />
      <AbsentDefaultToggleRow
        api={api}
        path={['images', 'blockImages']}
        label="Block all images"
        helper="Never send images to the model."
        defaultOn={false}
      />
    </PaneShell>
  )
}

// ── Workspace & trust ────────────────────────────────────────────────────────

const PROJECT_TRUST_OPTIONS = [
  { value: 'ask', label: 'ask' },
  { value: 'always', label: 'always' },
  { value: 'never', label: 'never' }
]

export function PiWorkspaceSection(): React.JSX.Element {
  const api = usePiNativeConfigLeaf()
  return (
    <PaneShell testid="PiWorkspaceSection" api={api}>
      <SegmentedRow
        api={api}
        path={['defaultProjectTrust']}
        label="Project trust fallback"
        helper="ClaudeUI sessions never see a trust prompt, so under ask or never an untrusted project's .pi settings, extensions and skills are skipped."
        options={PROJECT_TRUST_OPTIONS}
        defaultValue="ask"
      />
      <TextRow
        api={api}
        path={['sessionDir']}
        label="Session directory"
        helper="Where new session files are written; existing sessions are tracked by absolute path and stay put."
        placeholder="default"
      />
      <AbsentDefaultToggleRow
        api={api}
        path={['enableSkillCommands']}
        label="Skill slash commands"
        helper="Register skills as /skill:name commands."
        defaultOn={true}
      />
    </PaneShell>
  )
}

/**
 * Was the "Resources" sub-header inside Workspace & trust: the four path/package
 * lists pi loads skills, extensions and prompts from. Its own group (ADR-065).
 */
export function PiResourcesSection(): React.JSX.Element {
  const api = usePiNativeConfigLeaf()
  return (
    <PaneShell testid="PiResourcesSection" api={api}>
      <StringListRow
        api={api}
        path={['packages']}
        label="Packages"
        helper="npm or git packages providing skills, extensions and prompts."
        placeholder="pi-skills, @org/my-extension…"
        opaqueNote={(n) =>
          `${n} package ${n === 1 ? 'entry uses' : 'entries use'} the object form (filtered resources) — edit ${n === 1 ? 'it' : 'them'} in Raw config.`
        }
      />
      <StringListRow
        api={api}
        path={['extensions']}
        label="Extension paths"
        helper="Local extension files or directories, resolved relative to ~/.pi/agent."
        placeholder="/path/to/extension.js"
      />
      <StringListRow
        api={api}
        path={['skills']}
        label="Skill paths"
        helper="Local skill files or directories."
        placeholder="/path/to/skills"
      />
      <StringListRow
        api={api}
        path={['prompts']}
        label="Prompt paths"
        helper="Local prompt-template files or directories."
        placeholder="/path/to/prompts"
      />
    </PaneShell>
  )
}

// ── Network & telemetry ──────────────────────────────────────────────────────

const TRANSPORT_OPTIONS = [
  { value: '', label: 'auto (default)' },
  { value: 'sse', label: 'sse' },
  { value: 'websocket', label: 'websocket' },
  { value: 'websocket-cached', label: 'websocket-cached' }
]

export function PiNetworkSection(): React.JSX.Element {
  const api = usePiNativeConfigLeaf()

  return (
    <PaneShell testid="PiNetworkSection" api={api}>
      <TextRow
        api={api}
        path={['httpProxy']}
        label="HTTP proxy"
        helper="Applied as HTTP_PROXY and HTTPS_PROXY; global setting only."
        placeholder="unset"
      />
      <SelectRow
        api={api}
        path={['transport']}
        label="Transport"
        helper="Stream transport for providers that offer more than one."
        options={TRANSPORT_OPTIONS}
        defaultValue=""
        width="min-w-[180px]"
      />
      <NumberRow
        api={api}
        path={['httpIdleTimeoutMs']}
        label="HTTP idle timeout"
        helper="Header and body idle timeout; 0 disables it."
        placeholder="300000"
        unit="ms"
      />
      <NumberRow
        api={api}
        path={['websocketConnectTimeoutMs']}
        label="WebSocket connect timeout"
        helper="Handshake timeout; 0 disables it."
        placeholder="15000"
        unit="ms"
      />
      <AbsentDefaultToggleRow
        api={api}
        path={['enableInstallTelemetry']}
        label="Install telemetry"
        helper="Anonymous version ping to pi.dev after installs and updates."
        defaultOn={true}
      />
      <AbsentDefaultToggleRow
        api={api}
        path={['enableAnalytics']}
        label="Analytics"
        helper="Opt-in usage analytics."
        defaultOn={false}
      />
      {/* `trackingId` is deliberately NOT surfaced: pi generates it when
          analytics is turned on, so it is a value to read in Raw config, not a
          setting to type. */}
    </PaneShell>
  )
}

// ── Raw config ───────────────────────────────────────────────────────────────

/**
 * Why the text has to be valid JSON with an object at the top: pi's loader reads
 * strict JSON and merges the result as an object. Returned message, not a
 * boolean, so the pane can show the parser's own position information.
 */
export function validatePiSettingsText(text: string): string | null {
  if (text.trim() === '') return 'Settings must be a JSON object — the file cannot be empty.'
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid JSON'
  }
  if (!isPlainObject(parsed)) return 'The top level must be a JSON object.'
  return null
}

/**
 * The whole file, as text. Mounted only once `api.text` has loaded (PaneShell
 * renders Loading… until then), so the draft can be seeded from it directly.
 */
function PiRawEditor({ api }: { api: PiNativeConfigLeaf }): React.JSX.Element {
  const [draft, setDraft] = useState(api.text)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Re-seed when the committed text moves — i.e. after our own save + re-read.
  useEffect(() => setDraft(api.text), [api.text])

  const parseError = validatePiSettingsText(draft)
  const dirty = draft !== api.text
  const shownError = parseError ?? saveError

  const save = (): void => {
    setSaving(true)
    setSaveError(null)
    window.api
      .writePiNativeText(draft)
      .then(() => {
        setSaving(false)
        api.reload()
      })
      .catch((e: unknown) => {
        setSaving(false)
        setSaveError(e instanceof Error ? e.message : String(e))
      })
  }

  return (
    <SettingRow
      testid={`${PANE}.row`}
      dataId="rawText"
      layout="stacked"
      label="Settings file"
      description="pi's TUI-only keys (theme, tuiMode, markdown, terminal, keybindings) are deliberately not in the panes, so edit them here; Save replaces the whole file rather than patching one field."
      keyText={api.filePath}
      error={shownError ?? undefined}
      // `.rawError` is the id every caller of this pane asserts; the row's own
      // would be `${PANE}.row.error`, shared with every other pi row.
      errorTestid={`${PANE}.rawError`}
    >
      <textarea
        data-testid={`${PANE}.rawText`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={18}
        spellCheck={false}
        placeholder={'{\n  "defaultProvider": "anthropic"\n}'}
        className="w-full bg-bg-input border border-border rounded-md px-2.5 py-1.5 font-mono text-[12px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors resize-y"
      />
      <span className="mt-2 block">
        <Button
          variant="primary"
          testid={`${PANE}.rawSave`}
          disabled={saving || !dirty || parseError !== null}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </span>
    </SettingRow>
  )
}

export function PiRawConfigSection(): React.JSX.Element {
  const api = usePiNativeConfigLeaf()
  return (
    <PaneShell testid="PiRawConfigSection" api={api}>
      <PiRawEditor api={api} />
    </PaneShell>
  )
}
