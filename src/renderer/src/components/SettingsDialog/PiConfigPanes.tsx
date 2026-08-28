/**
 * PiConfigPanes.tsx
 *
 * The pi "Configuration" nav subgroup: six curated panes over the settings worth
 * a real control, plus a full-file text editor ("Raw config") for everything
 * else — pi publishes no JSON schema for `settings.json`, so there is no generic
 * schema-driven form to fall back on the way opencode has one.
 *
 * All of them read and write pi's OWN global settings file
 * (`~/.pi/agent/settings.json`) through the leaf-patch IPC pair
 * (readPiNativeRaw / patchPiNative), which byte-preserves untouched siblings.
 * GLOBAL SCOPE ONLY: pi's project-local `.pi/settings.json` overrides the global
 * file and is not ClaudeUI's to edit.
 *
 * Conventions are the opencode Configuration panes' (OpencodeConfigPanes.tsx,
 * whose row primitives these reuse), and they are what the tests pin:
 *
 *  · IMMEDIATE SAVES. No Save button: a toggle, chip, segment or select click
 *    commits at once; number and text inputs commit on blur AND Enter. Each
 *    commit is ONE leaf patch, and the file is re-read afterwards. The Raw
 *    config pane is the one exception — a whole-file text editor cannot commit
 *    per keystroke, so it has an explicit Save.
 *  · ABSENT MEANS DEFAULT. A key whose absence already gives the wanted
 *    behaviour is DELETED rather than written with its default value. An empty
 *    number/text input deletes its key. The one deliberate exception is
 *    `defaultTools`, where an explicit `[]` means "no built-in tools" and is a
 *    different thing from absent — see the chip row.
 *  · LEAF PATCHES ONLY. `compaction.enabled`, `retry.provider.maxRetries`,
 *    `thinkingBudgets.low` are patched at their own path, never by writing the
 *    parent — a user file may hold sibling keys these panes don't model (pi's
 *    TUI-only settings, most of them), and a whole-object write would erase them.
 *
 * The Models pane also carries ClaudeUI's OWN pi session-default model + model
 * allowlist, which live in `engines/pi.json` rather than pi's settings.json.
 * Two files behind one pane is deliberate: "which model do pi sessions start
 * with" is one question, and answering it in two places was the confusion.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSessionStore, PI_DEFAULT_MODEL } from '../../stores/session-store'
import { SandboxListSetting, InfoTooltip } from './settings-controls'
import { SelectMenu } from '../shared/SelectMenu'
import { ModelPicker } from '../shared/InlinePickers'
import { RawJsonField, inputClass } from './OpencodeSchemaForm'
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
  /** Resolved settings file path (shown in the pane footer). */
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

// ── Pane shell (install gate + file footer) ──────────────────────────────────

function PaneShell({
  testid,
  api,
  footer,
  footerNote,
  children
}: {
  testid: string
  api: PiNativeConfigLeaf
  /** Replaces the standard "saved immediately" footer entirely (Raw config). */
  footer?: React.ReactNode
  /** Extra sentence appended to the standard footer. */
  footerNote?: string
  children: React.ReactNode
}): React.JSX.Element {
  const installed = usePiInstalled()

  if (installed === null || api.config === null) {
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
        pi is not installed. This edits pi&apos;s own settings file.
      </div>
    )
  }
  return (
    <div data-testid={testid} className="py-1 text-[13px] text-text-secondary">
      {children}
      <div className="px-3 pt-2 mt-1 border-t border-border/20 text-[10px] text-text-muted/50 leading-relaxed">
        {footer ?? (
          <>
            Saved immediately to {api.filePath || '~/.pi/agent/settings.json'}. Only the field you
            change is written — other keys are preserved. Changes apply to newly started pi
            sessions.
            {footerNote ? ` ${footerNote}` : ''}
          </>
        )}
      </div>
    </div>
  )
}

/** Small caps divider inside a pane (AUTOMATIC RETRY, PI FALLBACKS, RESOURCES). */
function SubHeader({ label, note }: { label: string; note?: string }): React.JSX.Element {
  return (
    <div
      data-testid={`${PANE}.subheader`}
      data-id={label}
      className="mt-3 mb-1 mx-3 pb-1 border-b border-border/20 text-[10px] font-semibold uppercase tracking-wider text-text-muted/70"
    >
      {label}
      {note && <span className="ml-1.5 normal-case tracking-normal font-normal">— {note}</span>}
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
    />
  )
}

/** Number row bound to one leaf. */
function NumberRow({
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
  return (
    <LeafRow
      testidPrefix={PANE}
      configKey={key}
      label={label}
      helper={helper}
      error={api.errorAt(path)}
    >
      <LeafNumberInput
        testid={`${PANE}.number`}
        configKey={key}
        value={api.read(path)}
        placeholder={placeholder}
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
  return (
    <LeafRow
      testidPrefix={PANE}
      configKey={key}
      label={label}
      helper={helper}
      error={api.errorAt(path)}
    >
      <LeafTextInput
        testid={`${PANE}.text`}
        configKey={key}
        value={api.read(path)}
        placeholder={placeholder}
        onCommit={(v) => api.patch(path, v)}
      />
    </LeafRow>
  )
}

/**
 * Pill row for a small closed set of string values. `defaultValue` is the choice
 * pi already makes when the key is ABSENT, so selecting it deletes the key
 * rather than writing pi's own default back into the file.
 *
 * `stacked` puts the pills UNDER the label instead of beside it: LeafRow pins
 * its control column `shrink-0`, so a long option set (the eight thinking
 * levels) would squeeze the label away rather than wrap.
 */
function SegmentedRow({
  api,
  path,
  label,
  helper,
  options,
  defaultValue,
  stacked = false
}: {
  api: PiNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  options: { value: string; label: string }[]
  defaultValue: string
  stacked?: boolean
}): React.JSX.Element {
  const key = pathId(path)
  const raw = api.read(path)
  const current = typeof raw === 'string' ? raw : defaultValue
  const Row = stacked ? StackedRow : LeafRow
  const pills = (
    <div className={`flex flex-wrap gap-1 ${stacked ? 'px-3' : 'justify-end'}`}>
      {options.map((opt) => {
        const on = current === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            data-testid={`${PANE}.segment`}
            data-id={`${key}:${opt.value}`}
            aria-pressed={on}
            onClick={() => api.patch(path, opt.value === defaultValue ? undefined : opt.value)}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
              on
                ? 'bg-accent/20 text-accent border-accent/40'
                : 'bg-bg-hover text-text-muted border-border hover:text-text-secondary'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
  return (
    <Row
      testidPrefix={PANE}
      configKey={key}
      label={label}
      helper={helper}
      error={api.errorAt(path)}
    >
      {pills}
    </Row>
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
    >
      <SandboxListSetting
        label=""
        labelColor="text-text-secondary"
        items={items}
        placeholder={placeholder}
        onUpdate={(next) => {
          const merged = [...next, ...opaque]
          api.patch(path, merged.length > 0 ? merged : undefined)
        }}
        testid={`${PANE}.list`}
      />
      {opaque.length > 0 && (
        <div
          data-testid={`${PANE}.opaqueNote`}
          data-id={key}
          className="px-3 text-[10px] text-text-muted/50 leading-relaxed"
        >
          {opaqueNote
            ? opaqueNote(opaque.length)
            : `${opaque.length} advanced ${opaque.length === 1 ? 'entry' : 'entries'} in this list are kept as-is and not shown here.`}
        </div>
      )}
    </StackedRow>
  )
}

// ── Session behavior ─────────────────────────────────────────────────────────

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
      />
      <NumberRow
        api={api}
        path={['compaction', 'keepRecentTokens']}
        label="Recent tokens preserved"
        helper="Verbatim tail kept out of the summary."
        placeholder="20000"
      />
      <NumberRow
        api={api}
        path={['branchSummary', 'reserveTokens']}
        label="Branch summary reserve"
        helper="Tokens reserved when a forked branch is summarised."
        placeholder="16384"
      />

      <SubHeader label="Automatic retry" />
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
        helper="Milliseconds; doubles each attempt (2s, 4s, 8s)."
        placeholder="2000"
      />
      <NumberRow
        api={api}
        path={['retry', 'provider', 'timeoutMs']}
        label="Provider request timeout"
        helper="SDK-level request timeout in milliseconds."
        placeholder="SDK default"
      />
      <NumberRow
        api={api}
        path={['retry', 'provider', 'maxRetryDelayMs']}
        label="Provider max retry delay"
        helper="Longer server-requested waits fail loudly instead of blocking. 0 disables the cap."
        placeholder="60000"
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
 * Moved verbatim out of settings-sections.tsx when the `pi-models` section was
 * folded into this pane; its testids are unchanged so the deep links and tests
 * that name them keep working. The install gate moved up to `PaneShell`.
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

  if (cfg === null) {
    return (
      <div data-testid="PiDefaultModelSection" className="px-3 py-1.5 text-[13px] text-text-muted">
        Loading…
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
    window.api
      .getEngineModels()
      .then((groups) =>
        setModels(
          groups.filter((group) => group.engineId === 'pi').flatMap((group) => group.models)
        )
      )
      .catch(() => {})
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
    <div data-testid="PiDefaultModelSection" className="space-y-1">
      <div className="px-3 py-1.5 text-[13px] text-text-secondary">
        <div className="mb-1 flex items-center gap-1">
          Default model
          <InfoTooltip text="The primary model for new pi sessions. Format: provider/model-id, e.g. openai-codex/gpt-5.6-luna. Free text is allowed for models pi supports locally that ClaudeUI hasn't discovered yet." />
          <span className="font-mono text-[10px] text-text-muted/60">engines/pi.json</span>
        </div>
        {models.length > 0 ? (
          // Themed ModelPicker rather than a native <select> (OS-painted option
          // lists are unreadable in dark themes). `__custom__` stays a real
          // selectable VALUE — it is a mode switch, not a model, so it rides
          // the picker's pinned trailing row instead of the model groups.
          <div
            data-testid="PiDefaultModelSection.defaultModel"
            data-value={customMode || !known ? '__custom__' : current}
          >
            <ModelPicker
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
          </div>
        ) : (
          <div data-testid="PiDefaultModelSection.empty" className="text-[11px] text-warning">
            No pi models discovered. Authenticate a provider, then refresh models.
          </div>
        )}
        {(models.length === 0 || customMode || !known) && (
          <input
            data-testid="PiDefaultModelSection.customModel"
            type="text"
            value={current}
            onChange={(e) => update(e.target.value)}
            placeholder="Custom provider/model-id"
            className="mt-1 w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary"
          />
        )}
        <button
          data-testid="PiDefaultModelSection.refresh"
          onClick={() => {
            window.api
              .getEngineModels()
              .then((groups) =>
                setModels(groups.filter((g) => g.engineId === 'pi').flatMap((g) => g.models))
              )
              .catch(() => {})
          }}
          className="mt-1 text-[11px] text-accent"
        >
          Refresh models
        </button>
        <button
          data-testid="PiDefaultModelSection.manageModels"
          onClick={() => setManagingModels(true)}
          className="mt-1 ml-3 text-[11px] text-accent"
        >
          Manage models (
          {allowlist === undefined
            ? 'all'
            : allowlist.length === 0
              ? 'none'
              : `${allowlist.length} selected`}
          )
        </button>
        {defaultExcluded ? (
          <div
            data-testid="PiDefaultModelSection.excludedDefaultWarning"
            className="mt-1 text-[10px] text-warning/90"
          >
            The configured default is excluded by the model allowlist. New pi sessions will start
            with no model selected until it is enabled or replaced.
          </div>
        ) : (
          <StaleModelNotice
            testid="PiDefaultModelSection.defaultModel"
            models={models}
            value={current}
          />
        )}
        {!known && !defaultExcluded && (
          <div
            data-testid="PiDefaultModelSection.unknownWarning"
            className="mt-1 text-[10px] text-warning/90"
          >
            Not in pi&rsquo;s currently-discovered model list — used as-is. Double-check the
            provider is authenticated and the model id is spelled correctly.
          </div>
        )}
      </div>
      <div className="px-3 pb-1 text-[10px] text-text-muted/50 leading-relaxed">
        Applies to new pi sessions. Falls back to pi&rsquo;s own default ({PI_DEFAULT_MODEL}) when
        unset. Stored in <span className="font-mono">engines/pi.json</span>, not pi&rsquo;s
        settings.json.
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

/**
 * The thinking levels pi documents a budget for. Each is its own leaf, so a
 * level the user has not set stays absent; clearing the LAST one removes the
 * `thinkingBudgets` object rather than leaving `{}` behind.
 */
const THINKING_BUDGET_LEVELS = ['minimal', 'low', 'medium', 'high'] as const

/** `defaultThinkingLevel`'s closed set, plus the pinned "absent" choice. */
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
      helper="Custom token budgets per level. Native on Anthropic, Google and Bedrock; OpenAI-compatible models need compat support —"
      error={
        // One shared row error: only one field can be in flight at a time.
        THINKING_BUDGET_LEVELS.map((l) => api.errorAt(['thinkingBudgets', l])).find(Boolean) ??
        api.errorAt(['thinkingBudgets'])
      }
    >
      <div className="px-3 flex flex-wrap gap-x-3 gap-y-1">
        {THINKING_BUDGET_LEVELS.map((level) => (
          <span key={level} className="flex items-center gap-1.5">
            <span className="w-12 text-right text-[11px] text-text-muted/70">{level}</span>
            <LeafNumberInput
              testid={`${PANE}.number`}
              configKey={`thinkingBudgets.${level}`}
              value={budgets[level]}
              placeholder="default"
              onCommit={(v) => commit(level, v)}
              width="w-20"
            />
          </span>
        ))}
      </div>
    </StackedRow>
  )
}

export function PiModelsSection(): React.JSX.Element {
  const api = usePiNativeConfigLeaf()
  return (
    <PaneShell
      testid="PiModelsSection"
      api={api}
      footerNote="Rows tagged engines/pi.json are ClaudeUI's own and are stored there instead."
    >
      <PiSessionDefaultModel />
      <SubHeader
        label="pi fallbacks"
        note="settings.json; used when the session default is unset, and by standalone pi"
      />
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
      <SegmentedRow
        api={api}
        path={['defaultThinkingLevel']}
        label="Default thinking level"
        helper="Reasoning effort pi starts a session with —"
        options={THINKING_LEVEL_OPTIONS}
        defaultValue=""
        stacked
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
      helper="Enabled at session start; unset = pi's standard defaults. Extension tools stay on —"
      error={api.errorAt(path)}
    >
      <div
        data-testid={`${PANE}.chips`}
        data-id="defaultTools"
        className="px-3 flex flex-wrap gap-1.5"
      >
        {PI_BUILTIN_TOOLS.map((id) => {
          const on = selected.includes(id)
          return (
            <button
              key={id}
              type="button"
              data-testid={`${PANE}.chip`}
              data-id={id}
              aria-pressed={on}
              onClick={() => toggle(id)}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                on
                  ? 'bg-accent/20 text-accent border-accent/40'
                  : 'bg-bg-hover text-text-muted border-border hover:text-text-secondary'
              }`}
            >
              {id}
            </button>
          )
        })}
      </div>
      <div className="px-3 mt-1 text-[10px] text-text-muted/60 leading-relaxed">
        {explicit === null ? (
          <span data-testid={`${PANE}.toolsDefaultCaption`}>
            pi standard defaults active ({PI_DEFAULT_TOOLS_WHEN_ABSENT.join(', ')}). Picking a chip
            starts from that set.
          </span>
        ) : (
          <>
            {selected.length === 0 && 'No built-in tools — extension and SDK tools still load. '}
            <button
              type="button"
              data-testid={`${PANE}.toolsUseDefaults`}
              onClick={() => api.patch(path, undefined)}
              className="text-accent hover:text-accent/80 transition-colors"
            >
              Use pi defaults
            </button>
          </>
        )}
      </div>
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
        helper="Custom shell for the bash tool (e.g. Git Bash on Windows)."
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
          'Argv used for package installs, as a JSON array — e.g. ["mise","exec","node@20","--","npm"]. Empty = npm —'
        }
        error={api.errorAt(npmPath)}
      >
        <div className="px-3">
          {/* Keyed on the committed value so a re-read reseeds the textarea
              instead of showing a value that is no longer in the file. */}
          <RawJsonField
            key={String(JSON.stringify(npmValue))}
            fieldKey="npmCommand"
            value={npmValue}
            onChange={(v) => api.patch(npmPath, v)}
          />
        </div>
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
        helper="Downscale to 2000×2000 before sending — attachments, read, and tool-returned images."
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
        helper="ClaudeUI sessions never see a trust prompt: under ask or never, an untrusted project's .pi settings, extensions and skills are skipped. Global setting only."
        options={PROJECT_TRUST_OPTIONS}
        defaultValue="ask"
      />
      <TextRow
        api={api}
        path={['sessionDir']}
        label="Session directory"
        helper="Where new session files are written. Affects new sessions only — existing ones are tracked by absolute path."
        placeholder="default"
      />
      <AbsentDefaultToggleRow
        api={api}
        path={['enableSkillCommands']}
        label="Skill slash commands"
        helper="Register skills as /skill:name commands."
        defaultOn={true}
      />

      <SubHeader label="Resources" />
      <StringListRow
        api={api}
        path={['packages']}
        label="Packages"
        helper="npm / git packages providing skills, extensions and prompts —"
        placeholder="pi-skills, @org/my-extension…"
        opaqueNote={(n) =>
          `${n} package ${n === 1 ? 'entry uses' : 'entries use'} the object form (filtered resources) — edit ${n === 1 ? 'it' : 'them'} in Raw config.`
        }
      />
      <StringListRow
        api={api}
        path={['extensions']}
        label="Extension paths"
        helper="Local extension files or directories, resolved relative to ~/.pi/agent —"
        placeholder="/path/to/extension.js"
      />
      <StringListRow
        api={api}
        path={['skills']}
        label="Skill paths"
        helper="Local skill files or directories —"
        placeholder="/path/to/skills"
      />
      <StringListRow
        api={api}
        path={['prompts']}
        label="Prompt paths"
        helper="Local prompt-template files or directories —"
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
  const transportPath: LeafPath = ['transport']
  const transport = api.read(transportPath)

  return (
    <PaneShell testid="PiNetworkSection" api={api}>
      <TextRow
        api={api}
        path={['httpProxy']}
        label="HTTP proxy"
        helper="Applied as HTTP_PROXY / HTTPS_PROXY. Global setting only."
        placeholder="unset"
      />
      <LeafRow
        testidPrefix={PANE}
        configKey={pathId(transportPath)}
        label="Transport"
        helper="For providers offering more than one stream transport —"
        error={api.errorAt(transportPath)}
      >
        <SelectMenu
          testid={`${PANE}.select`}
          dataAttrs={{ 'data-id': pathId(transportPath) }}
          value={typeof transport === 'string' ? transport : ''}
          onChange={(v) => api.patch(transportPath, v === '' ? undefined : v)}
          options={TRANSPORT_OPTIONS}
          triggerClassName={`${inputClass} w-44 text-left`}
        />
      </LeafRow>
      <NumberRow
        api={api}
        path={['httpIdleTimeoutMs']}
        label="HTTP idle timeout"
        helper="Header/body idle timeout in milliseconds; 0 disables."
        placeholder="300000"
      />
      <NumberRow
        api={api}
        path={['websocketConnectTimeoutMs']}
        label="WebSocket connect timeout"
        helper="Handshake timeout in milliseconds; 0 disables."
        placeholder="15000"
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
    <div className="px-3 py-1.5">
      <div className="text-[11px] text-text-muted/60 leading-relaxed mb-1.5">
        The whole of <span className="font-mono break-all">{api.filePath}</span>. pi&rsquo;s
        TUI-only keys (theme, tuiMode, markdown, terminal, keybindings…) are deliberately not in the
        panes — edit them here.
      </div>
      <textarea
        data-testid={`${PANE}.rawText`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={18}
        spellCheck={false}
        placeholder={'{\n  "defaultProvider": "anthropic"\n}'}
        className={`${inputClass} w-full font-mono resize-y`}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          data-testid={`${PANE}.rawSave`}
          disabled={saving || !dirty || parseError !== null}
          onClick={save}
          className="px-2 py-1 text-[11px] font-medium text-accent hover:text-accent-hover bg-accent/10 hover:bg-accent/15 rounded transition-colors cursor-default disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {parseError !== null && (
          <span data-testid={`${PANE}.rawError`} className="text-[11px] text-red-400">
            {parseError}
          </span>
        )}
        {parseError === null && saveError !== null && (
          <span data-testid={`${PANE}.rawError`} className="text-[11px] text-red-400">
            {saveError}
          </span>
        )}
      </div>
    </div>
  )
}

export function PiRawConfigSection(): React.JSX.Element {
  const api = usePiNativeConfigLeaf()
  return (
    <PaneShell
      testid="PiRawConfigSection"
      api={api}
      footer={
        <>
          Written verbatim when you press Save — the panes&rsquo; per-field writes are what preserve
          formatting, this one replaces the file. Changes apply to newly started pi sessions.
        </>
      }
    >
      <PiRawEditor api={api} />
    </PaneShell>
  )
}
