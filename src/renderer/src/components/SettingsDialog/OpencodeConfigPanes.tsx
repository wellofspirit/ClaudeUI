/**
 * OpencodeConfigPanes.tsx
 *
 * The curated half of the opencode "Configuration" nav subgroup: seven
 * hand-written panes over the opencode config keys worth a real control, with
 * the generic schema-driven editor ("Raw config", settings-sections.tsx)
 * keeping everything else.
 *
 * All of them read and write opencode's OWN global config file through the
 * leaf-patch IPC pair (readOpencodeNativeRaw / patchOpencodeNative) — the same
 * byte-preserving writer the raw editor uses, so comments and untouched
 * siblings survive.
 *
 * Save semantics are IMMEDIATE: there is no Save button. A toggle click, a
 * select change, a list add/remove commits at once; number and text inputs
 * commit on blur AND Enter. Each commit is ONE leaf patch for exactly the key
 * that changed, and the config is re-read afterwards so the panes never drift
 * from the file.
 *
 * Two conventions run through every pane:
 *
 *  · ABSENT MEANS DEFAULT. A key whose absence already gives the wanted
 *    behaviour is DELETED rather than written with its default value, so the
 *    user's file only ever carries genuine overrides. An empty number/text
 *    input deletes its key for the same reason.
 *  · LEAF PATCHES ONLY. Nested keys (`compaction.auto`, `experimental.batch_tool`,
 *    `tools.<id>`) are patched at their own path, never by writing the parent
 *    object — a user file may hold sibling keys these panes don't model, and
 *    a whole-object write would erase them.
 */

import { useCallback, useEffect, useState } from 'react'
import { SettingsToggle, SandboxListSetting, ToggleSwitch } from './settings-controls'
import { SelectMenu } from '../shared/SelectMenu'
import { RawJsonField, inputClass } from './OpencodeSchemaForm'
import { useOpencodeInstalled } from './use-engine-installed'
import { deepEqual, isPlainObject } from '../../../../shared/opencode-config-diff'
import type { OpencodeAgentSummary, RawConfigPatch } from '../../../../shared/types'

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

export interface OpencodeNativeConfigLeaf {
  /** null until the first read resolves — panes render Loading… meanwhile. */
  config: Record<string, unknown> | null
  /** Resolved config file path (shown in the pane footer). */
  filePath: string
  /** Current value at `path`, or undefined when the key is absent. */
  read: (path: LeafPath) => unknown
  /**
   * Commit ONE leaf. `undefined` deletes the key (the `diffToPatches`
   * convention: a patch with no `value` is a delete). A no-op when the value
   * already matches, so a blur without an edit never touches the file.
   */
  patch: (path: LeafPath, value: unknown) => void
  /** The last patch failure for `path`, or null. */
  errorAt: (path: LeafPath) => string | null
  reload: () => void
}

function useOpencodeNativeConfigLeaf(): OpencodeNativeConfigLeaf {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [filePath, setFilePath] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const reload = useCallback((): void => {
    window.api
      .readOpencodeNativeRaw()
      .then(({ config: next, path }) => {
        setConfig(next)
        setFilePath(path)
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
        .patchOpencodeNative([one])
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

  return { config, filePath, read, patch, errorAt, reload }
}

// ── Row primitives ───────────────────────────────────────────────────────────

/**
 * The two-tier testid namespace these rows emit (`<prefix>.row`, `.toggle`,
 * `.number`, `.error`). Every primitive below takes it as an overridable prop:
 * the per-model capability editor (OpencodeModelCapabilities.tsx) reuses these
 * rows under its OWN prefix, so a test can address its controls without
 * disambiguating them from a Configuration pane's.
 */
const PANE_TESTID = 'OpencodeConfigPane'

/** Label line + helper line; the helper always ENDS with the raw opencode key. */
function RowLabel({
  label,
  helper,
  keyText
}: {
  label: string
  helper: string
  keyText: string
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-text-secondary leading-snug">{label}</div>
      <div className="text-[11px] text-text-muted/60 leading-relaxed">
        {helper} <span className="font-mono break-all text-text-muted/80">{keyText}</span>
      </div>
    </div>
  )
}

function RowError({
  configKey,
  error,
  testidPrefix = PANE_TESTID
}: {
  configKey: string
  error: string | null
  testidPrefix?: string
}): React.JSX.Element | null {
  if (!error) return null
  return (
    <div
      data-testid={`${testidPrefix}.error`}
      data-id={configKey}
      className="text-[11px] text-red-400 mt-1 leading-relaxed"
    >
      {error}
    </div>
  )
}

interface RowProps {
  configKey: string
  label: string
  helper: string
  error: string | null
  /** Raw key(s) shown at the end of the helper. Defaults to `configKey`. */
  keyText?: string
  /** Testid namespace for the row and its error. Defaults to the panes'. */
  testidPrefix?: string
  children: React.ReactNode
}

/** Label block on the left, control on the right (toggles aside — see ToggleRow). */
function LeafRow({
  configKey,
  label,
  helper,
  error,
  keyText,
  testidPrefix = PANE_TESTID,
  children
}: RowProps): React.JSX.Element {
  return (
    <div data-testid={`${testidPrefix}.row`} data-id={configKey} className="px-3 py-1.5">
      <div className="flex items-start justify-between gap-4">
        <RowLabel label={label} helper={helper} keyText={keyText ?? configKey} />
        <div className="shrink-0 flex items-center gap-1.5">{children}</div>
      </div>
      <RowError configKey={configKey} error={error} testidPrefix={testidPrefix} />
    </div>
  )
}

/**
 * Control spans the full width UNDER the label block (lists, chip rows). Only
 * the label and error carry the row's horizontal padding: a control that brings
 * its own (SandboxListSetting) would otherwise sit a step further in than every
 * other row's.
 */
export function StackedRow({
  configKey,
  label,
  helper,
  error,
  keyText,
  testidPrefix = PANE_TESTID,
  children
}: RowProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <div data-testid={`${testidPrefix}.row`} data-id={configKey} className="py-1.5">
      <div className="px-3">
        <RowLabel label={label} helper={helper} keyText={keyText ?? configKey} />
      </div>
      <div className="mt-1">{children}</div>
      <div className="px-3">
        <RowError configKey={configKey} error={error} testidPrefix={testidPrefix} />
      </div>
    </div>
  )
}

/**
 * Toggle row. Reuses `SettingsToggle` (which owns the label + switch layout the
 * rest of the dialog uses) and hangs the helper line under it, matching the
 * schema form's boolean field.
 */
export function ToggleRow({
  configKey,
  label,
  helper,
  checked,
  onChange,
  error,
  testidPrefix = PANE_TESTID
}: {
  configKey: string
  label: string
  helper: string
  checked: boolean
  onChange: (v: boolean) => void
  error: string | null
  testidPrefix?: string
}): React.JSX.Element {
  return (
    <div data-testid={`${testidPrefix}.row`} data-id={configKey} className="py-0.5">
      <SettingsToggle
        label={label}
        checked={checked}
        onChange={onChange}
        testid={`${testidPrefix}.toggle`}
        dataId={configKey}
      />
      <div className="px-3 pb-1 text-[11px] text-text-muted/60 leading-relaxed">
        {helper} <span className="font-mono break-all text-text-muted/80">{configKey}</span>
      </div>
      <div className="px-3">
        <RowError configKey={configKey} error={error} testidPrefix={testidPrefix} />
      </div>
    </div>
  )
}

// ── Controls ─────────────────────────────────────────────────────────────────

/**
 * Number input with a LOCAL draft, committed on blur and on Enter. An empty
 * field deletes the key. The draft resyncs whenever the committed value moves
 * (i.e. after a successful patch + re-read); a REJECTED patch leaves the value
 * untouched, so the user's text survives next to the error instead of snapping
 * back.
 */
export function LeafNumberInput({
  configKey,
  value,
  placeholder,
  onCommit,
  width = 'w-24',
  testid = `${PANE_TESTID}.number`,
  step = 1
}: {
  configKey: string
  value: unknown
  placeholder: string
  onCommit: (v: number | undefined) => void
  width?: string
  testid?: string
  /** `'any'` for fields whose values are genuinely fractional (token prices) —
   *  with an integer step a browser marks `0.3` as an invalid entry. */
  step?: number | 'any'
}): React.JSX.Element {
  const committed = typeof value === 'number' ? String(value) : ''
  const [draft, setDraft] = useState(committed)
  useEffect(() => setDraft(typeof value === 'number' ? String(value) : ''), [value])

  const commit = (): void => {
    const text = draft.trim()
    if (text === '') {
      onCommit(undefined)
      return
    }
    const n = Number(text)
    // `<input type=number>` can still hand back an unparseable string (partial
    // exponent, pasted text) — snap back rather than write NaN.
    if (!Number.isFinite(n)) {
      setDraft(committed)
      return
    }
    onCommit(n)
  }

  return (
    <input
      type="number"
      min={0}
      step={step}
      data-testid={testid}
      data-id={configKey}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      className={`${inputClass} ${width} tabular-nums text-right`}
    />
  )
}

/** Text input with the same draft / commit-on-blur-or-Enter contract. */
function LeafTextInput({
  configKey,
  value,
  placeholder,
  onCommit,
  width = 'w-44'
}: {
  configKey: string
  value: unknown
  placeholder: string
  onCommit: (v: string | undefined) => void
  width?: string
}): React.JSX.Element {
  const committed = typeof value === 'string' ? value : ''
  const [draft, setDraft] = useState(committed)
  useEffect(() => setDraft(typeof value === 'string' ? value : ''), [value])

  const commit = (): void => {
    const text = draft.trim()
    onCommit(text === '' ? undefined : text)
  }

  return (
    <input
      type="text"
      data-testid="OpencodeConfigPane.text"
      data-id={configKey}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      className={`${inputClass} ${width}`}
    />
  )
}

/**
 * Toggle over a key whose ABSENCE already means `defaultOn`. Switching TO the
 * default deletes the key instead of writing the default value, so the file
 * keeps only real overrides and follows opencode if the default ever moves.
 */
function AbsentDefaultToggleRow({
  api,
  path,
  label,
  helper,
  defaultOn
}: {
  api: OpencodeNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  defaultOn: boolean
}): React.JSX.Element {
  const raw = api.read(path)
  const on = typeof raw === 'boolean' ? raw : defaultOn
  return (
    <ToggleRow
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
  api: OpencodeNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  placeholder: string
}): React.JSX.Element {
  const key = pathId(path)
  return (
    <LeafRow configKey={key} label={label} helper={helper} error={api.errorAt(path)}>
      <LeafNumberInput
        configKey={key}
        value={api.read(path)}
        placeholder={placeholder}
        onCommit={(v) => api.patch(path, v)}
      />
    </LeafRow>
  )
}

/** String-list row bound to one leaf; an emptied list deletes the key. */
function StringListRow({
  api,
  path,
  label,
  helper,
  placeholder
}: {
  api: OpencodeNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  placeholder: string
}): React.JSX.Element {
  const key = pathId(path)
  const raw = api.read(path)
  const items = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  // Entries this control can't represent (e.g. `plugin`'s [path, options]
  // tuples) are carried through untouched rather than dropped on the next edit.
  const opaque = Array.isArray(raw) ? raw.filter((v) => typeof v !== 'string') : []
  return (
    <StackedRow configKey={key} label={label} helper={helper} error={api.errorAt(path)}>
      <SandboxListSetting
        label=""
        labelColor="text-text-secondary"
        items={items}
        placeholder={placeholder}
        onUpdate={(next) => {
          const merged = [...next, ...opaque]
          api.patch(path, merged.length > 0 ? merged : undefined)
        }}
        testid="OpencodeConfigPane.list"
      />
      {opaque.length > 0 && (
        <div className="px-3 text-[10px] text-text-muted/50 leading-relaxed">
          {opaque.length} advanced {opaque.length === 1 ? 'entry' : 'entries'} in this list are kept
          as-is and not shown here.
        </div>
      )}
    </StackedRow>
  )
}

// ── Pane shell (install gate + file footer) ──────────────────────────────────

function PaneShell({
  testid,
  api,
  children
}: {
  testid: string
  api: OpencodeNativeConfigLeaf
  children: React.ReactNode
}): React.JSX.Element {
  const installed = useOpencodeInstalled()

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
        opencode is not installed. This edits opencode&apos;s own config file.
      </div>
    )
  }
  return (
    <div data-testid={testid} className="py-1 text-[13px] text-text-secondary">
      {children}
      <div className="px-3 pt-2 mt-1 border-t border-border/20 text-[10px] text-text-muted/50 leading-relaxed">
        Saved immediately to {api.filePath || 'opencode.jsonc'}. Only the field you change is
        written — comments and other keys are preserved.
      </div>
    </div>
  )
}

// ── 2a · Session behavior ────────────────────────────────────────────────────

export function OpencodeSessionBehaviorSection(): React.JSX.Element {
  const api = useOpencodeNativeConfigLeaf()
  return (
    <PaneShell testid="OpencodeSessionBehaviorSection" api={api}>
      <AbsentDefaultToggleRow
        api={api}
        path={['compaction', 'auto']}
        label="Compact automatically"
        helper="Summarise the session when the context window fills."
        defaultOn={true}
      />
      <AbsentDefaultToggleRow
        api={api}
        path={['compaction', 'prune']}
        label="Prune old tool output"
        helper="Drop superseded tool results while compacting."
        defaultOn={false}
      />
      <NumberRow
        api={api}
        path={['compaction', 'tail_turns']}
        label="Turns kept verbatim"
        helper="Recent user turns preserved uncompacted; unset = limited only by the token budget."
        placeholder="unlimited"
      />
      <NumberRow
        api={api}
        path={['compaction', 'preserve_recent_tokens']}
        label="Recent tokens preserved"
        helper="Token budget for the verbatim tail."
        placeholder="default"
      />
      <NumberRow
        api={api}
        path={['compaction', 'reserved']}
        label="Reserved tokens"
        helper="Headroom kept free so compaction itself can't overflow the window."
        placeholder="default"
      />
      <NumberRow
        api={api}
        path={['subagent_depth']}
        label="Subagent nesting depth"
        helper="1 stops subagents from launching their own subagents."
        placeholder="1"
      />
      <AbsentDefaultToggleRow
        api={api}
        path={['snapshot']}
        label="Filesystem snapshots"
        helper="Required for undo / revert of file changes."
        defaultOn={true}
      />
    </PaneShell>
  )
}

// ── 2b · Tool output ─────────────────────────────────────────────────────────

export function OpencodeToolOutputSection(): React.JSX.Element {
  const api = useOpencodeNativeConfigLeaf()
  return (
    <PaneShell testid="OpencodeToolOutputSection" api={api}>
      <NumberRow
        api={api}
        path={['tool_output', 'max_lines']}
        label="Max lines"
        helper="Longer output is written to disk and only previewed to the model."
        placeholder="2000"
      />
      <NumberRow
        api={api}
        path={['tool_output', 'max_bytes']}
        label="Max bytes"
        helper="Same truncation, by size."
        placeholder="51200"
      />
    </PaneShell>
  )
}

// ── 2c · Image attachments ───────────────────────────────────────────────────

export function OpencodeAttachmentsSection(): React.JSX.Element {
  const api = useOpencodeNativeConfigLeaf()
  const widthPath: LeafPath = ['attachment', 'image', 'max_width']
  const heightPath: LeafPath = ['attachment', 'image', 'max_height']
  return (
    <PaneShell testid="OpencodeAttachmentsSection" api={api}>
      <AbsentDefaultToggleRow
        api={api}
        path={['attachment', 'image', 'auto_resize']}
        label="Resize oversized images"
        helper="Off rejects an over-limit image instead of shrinking it."
        defaultOn={true}
      />
      <LeafRow
        configKey="attachment.image.max_width"
        keyText="attachment.image.max_width / max_height"
        label="Maximum dimensions"
        helper="Width × height in pixels before resize or rejection —"
        error={api.errorAt(widthPath) ?? api.errorAt(heightPath)}
      >
        <LeafNumberInput
          configKey={pathId(widthPath)}
          value={api.read(widthPath)}
          placeholder="2000"
          onCommit={(v) => api.patch(widthPath, v)}
          width="w-20"
        />
        <span className="text-[11px] text-text-muted/60">×</span>
        <LeafNumberInput
          configKey={pathId(heightPath)}
          value={api.read(heightPath)}
          placeholder="2000"
          onCommit={(v) => api.patch(heightPath, v)}
          width="w-20"
        />
      </LeafRow>
      <NumberRow
        api={api}
        path={['attachment', 'image', 'max_base64_bytes']}
        label="Maximum payload"
        helper="Base64 bytes an image attachment may occupy."
        placeholder="5242880"
      />
    </PaneShell>
  )
}

// ── 2d · Workspace ───────────────────────────────────────────────────────────

/**
 * opencode accepts a `default_agent` only when it names a PRIMARY, visible
 * agent (agent.ts `defaultInfo`: not `mode: 'subagent'`, not `hidden`), so the
 * picker offers exactly that set. Global agents only — this pane writes the
 * GLOBAL config file, and a project-scoped agent wouldn't resolve elsewhere.
 */
function isDefaultAgentCandidate(a: OpencodeAgentSummary): boolean {
  return a.mode !== 'subagent' && a.hidden !== true && a.disabled !== true
}

function usePrimaryAgents(): OpencodeAgentSummary[] {
  const [agents, setAgents] = useState<OpencodeAgentSummary[]>([])
  useEffect(() => {
    let cancelled = false
    window.api
      .listOpencodeAgents()
      .then((all) => {
        if (!cancelled) setAgents(all.filter(isDefaultAgentCandidate))
      })
      .catch(() => {
        if (!cancelled) setAgents([])
      })
    return () => {
      cancelled = true
    }
  }, [])
  return agents
}

export function OpencodeWorkspaceSection(): React.JSX.Element {
  const api = useOpencodeNativeConfigLeaf()
  const agents = usePrimaryAgents()
  const agentPath: LeafPath = ['default_agent']
  const shellPath: LeafPath = ['shell']
  const current = api.read(agentPath)

  return (
    <PaneShell testid="OpencodeWorkspaceSection" api={api}>
      <StringListRow
        api={api}
        path={['instructions']}
        label="Instruction files"
        helper="Extra files or globs merged into the system context —"
        placeholder="AGENTS.md, docs/*.md…"
      />
      <LeafRow
        configKey={pathId(agentPath)}
        label="Default agent"
        helper="Must be a primary agent; opencode falls back to build —"
        error={api.errorAt(agentPath)}
      >
        <SelectMenu
          testid="OpencodeConfigPane.select"
          dataAttrs={{ 'data-id': pathId(agentPath) }}
          value={typeof current === 'string' ? current : ''}
          onChange={(v) => api.patch(agentPath, v === '' ? undefined : v)}
          options={[
            { value: '', label: 'build (default)' },
            ...agents.map((a) => ({ value: a.name, label: a.name }))
          ]}
          triggerClassName={`${inputClass} w-44 text-left`}
        />
      </LeafRow>
      <LeafRow
        configKey={pathId(shellPath)}
        label="Shell"
        helper="Used by the terminal and the bash tool —"
        error={api.errorAt(shellPath)}
      >
        <LeafTextInput
          configKey={pathId(shellPath)}
          value={api.read(shellPath)}
          placeholder="system default"
          onCommit={(v) => api.patch(shellPath, v)}
        />
      </LeafRow>
      <StringListRow
        api={api}
        path={['watcher', 'ignore']}
        label="File-watcher ignores"
        helper="Globs the workspace watcher skips —"
        placeholder="**/dist/**"
      />
    </PaneShell>
  )
}

// ── 2e · Tools & integrations ────────────────────────────────────────────────

/**
 * opencode's built-in tool ids, from the v1.18.23 registry
 * (`packages/opencode/src/tool/registry.ts` builtin list; `bash` is ShellTool's
 * id). MCP tools and plugin tools also live under `tools` as globs — those keys
 * are NOT rendered here and never touched, since only their owner knows them.
 */
const OPENCODE_BUILTIN_TOOLS = [
  'bash',
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'task',
  'webfetch',
  'websearch',
  'todowrite',
  'skill',
  'apply_patch',
  'question',
  'lsp'
] as const

/**
 * Boolean-or-object key (`formatter`, `lsp`): the toggle owns the boolean
 * reading — OFF iff the value is literally `false` — and the disclosure exposes
 * the object form through the schema editor's raw-JSON leaf so the union stays
 * reachable without a bespoke editor per key.
 */
function UnionToggleRow({
  api,
  path,
  label,
  helper
}: {
  api: OpencodeNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const key = pathId(path)
  const value = api.read(path)
  const on = value !== false

  return (
    <div data-testid="OpencodeConfigPane.row" data-id={key} className="py-0.5">
      <SettingsToggle
        label={label}
        checked={on}
        onChange={(next) => api.patch(path, next ? undefined : false)}
        testid="OpencodeConfigPane.toggle"
        dataId={key}
      />
      <div className="px-3 pb-1 text-[11px] text-text-muted/60 leading-relaxed">
        {helper} <span className="font-mono break-all text-text-muted/80">{key}</span>
      </div>
      <div className="px-3 pb-1">
        <button
          type="button"
          data-testid="OpencodeConfigPane.disclosure"
          data-id={key}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
        >
          {open ? '▾' : '▸'} Overrides…
        </button>
        {open && (
          <div className="mt-1">
            {/* Keyed on the committed value so a re-read (or the toggle
                deleting the key) reseeds the textarea instead of showing a
                value that is no longer in the file. */}
            <RawJsonField
              key={String(JSON.stringify(value))}
              fieldKey={key}
              value={value}
              onChange={(v) => api.patch(path, v)}
            />
          </div>
        )}
        <RowError configKey={key} error={api.errorAt(path)} />
      </div>
    </div>
  )
}

export function OpencodeToolsSection(): React.JSX.Element {
  const api = useOpencodeNativeConfigLeaf()
  const tools = api.read(['tools'])
  const toolsObj = isPlainObject(tools) ? tools : {}

  return (
    <PaneShell testid="OpencodeToolsSection" api={api}>
      <StackedRow
        configKey="tools"
        label="Built-in tools"
        helper="Turn one off to hide it from every agent —"
        error={
          // One shared row error: only one chip can be in flight at a time.
          OPENCODE_BUILTIN_TOOLS.map((id) => api.errorAt(['tools', id])).find(Boolean) ?? null
        }
      >
        <div
          data-testid="OpencodeConfigPane.chips"
          data-id="tools"
          className="px-3 flex flex-wrap gap-1.5"
        >
          {OPENCODE_BUILTIN_TOOLS.map((id) => {
            const on = toolsObj[id] !== false
            return (
              <button
                key={id}
                type="button"
                data-testid="OpencodeConfigPane.chip"
                data-id={id}
                aria-pressed={on}
                // ON is the DEFAULT, so turning a tool back on deletes its key
                // rather than writing `true`.
                onClick={() => api.patch(['tools', id], on ? false : undefined)}
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
      </StackedRow>
      <UnionToggleRow
        api={api}
        path={['formatter']}
        label="Code formatters"
        helper="Built-in formatters run after edits; overrides add or disable one —"
      />
      <UnionToggleRow
        api={api}
        path={['lsp']}
        label="Language servers"
        helper="Built-in LSPs supply diagnostics; overrides add or disable one —"
      />
      <StringListRow
        api={api}
        path={['plugin']}
        label="Plugins"
        helper="Loads alongside ClaudeUI's injected caller-identity plugin —"
        placeholder="npm package or file path…"
      />
      <StringListRow
        api={api}
        path={['skills', 'paths']}
        label="Skill folders"
        helper="Searched in addition to the skills ClaudeUI already discovers —"
        placeholder="/path/to/skills"
      />
    </PaneShell>
  )
}

// ── 2f · Diagnostics ─────────────────────────────────────────────────────────

const LOG_LEVEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'DEBUG', label: 'DEBUG' },
  { value: 'INFO', label: 'INFO' },
  { value: 'WARN', label: 'WARN' },
  { value: 'ERROR', label: 'ERROR' }
]

export function OpencodeDiagnosticsSection(): React.JSX.Element {
  const api = useOpencodeNativeConfigLeaf()
  const logPath: LeafPath = ['logLevel']
  const level = api.read(logPath)

  return (
    <PaneShell testid="OpencodeDiagnosticsSection" api={api}>
      <LeafRow
        configKey={pathId(logPath)}
        label="Log level"
        helper="Verbosity of opencode's own log file —"
        error={api.errorAt(logPath)}
      >
        <SelectMenu
          testid="OpencodeConfigPane.select"
          dataAttrs={{ 'data-id': pathId(logPath) }}
          value={typeof level === 'string' ? level : ''}
          onChange={(v) => api.patch(logPath, v === '' ? undefined : v)}
          options={LOG_LEVEL_OPTIONS}
          triggerClassName={`${inputClass} w-32 text-left`}
        />
      </LeafRow>
      {/* Leaf paths, never a whole-`experimental` write: ClaudeUI itself injects
          experimental.continue_loop_on_deny at spawn and a user file may carry
          other experimental keys. */}
      <NumberRow
        api={api}
        path={['experimental', 'mcp_timeout']}
        label="MCP request timeout"
        helper="Milliseconds before an MCP call is cancelled —"
        placeholder="5000"
      />
      <AbsentDefaultToggleRow
        api={api}
        path={['experimental', 'batch_tool']}
        label="Batch tool"
        helper="Experimental: lets the model group several tool calls into one."
        defaultOn={false}
      />
    </PaneShell>
  )
}

// ── 2g · Managed keys (static) ───────────────────────────────────────────────

interface ManagedKey {
  configKey: string
  label: string
  forcedOn: boolean
  why: string
}

const MANAGED_KEYS: ManagedKey[] = [
  {
    configKey: 'autoupdate',
    label: 'Self-update',
    forcedOn: false,
    why: 'The vendored fork binary must never self-update over our patches.'
  },
  {
    configKey: 'share',
    label: 'Cloud session sharing',
    forcedOn: false,
    why: "Uploads full session content — messages, file diffs — to opencode's cloud."
  },
  {
    configKey: 'experimental.continue_loop_on_deny',
    label: 'Continue loop on deny',
    forcedOn: true,
    why: 'Permission denies stay non-fatal, matching Claude.'
  }
]

/**
 * Static pane — no IPC, nothing writable. These three keys are set by ClaudeUI
 * at spawn (ephemeral env-var config + an env kill switch, ADR-031), so a value
 * in the user's file would be overridden anyway; showing them read-only is
 * more honest than hiding them.
 */
export function OpencodeManagedKeysSection(): React.JSX.Element {
  return (
    <div data-testid="OpencodeManagedKeysSection" className="py-1 text-[13px] text-text-secondary">
      {MANAGED_KEYS.map((k) => (
        <div
          key={k.configKey}
          data-testid="OpencodeConfigPane.managedRow"
          data-id={k.configKey}
          className="px-3 py-1.5 opacity-70"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] text-text-secondary">{k.label}</span>
                <span
                  data-testid="OpencodeConfigPane.forcedBadge"
                  data-id={k.configKey}
                  className="text-[9px] px-1 py-0.5 rounded bg-bg-hover text-text-muted/70 uppercase tracking-wide"
                >
                  {k.forcedOn ? 'Forced on' : 'Forced off'}
                </span>
              </div>
              <div className="text-[11px] text-text-muted/60 leading-relaxed">
                {k.why} <span className="font-mono break-all text-text-muted/80">{k.configKey}</span>
              </div>
            </div>
            <span
              data-testid="OpencodeConfigPane.forcedToggle"
              data-id={k.configKey}
              aria-disabled="true"
              className="shrink-0 mt-0.5"
            >
              <ToggleSwitch checked={k.forcedOn} />
            </span>
          </div>
        </div>
      ))}
      <div className="px-3 pt-2 mt-1 border-t border-border/20 text-[10px] text-text-muted/50 leading-relaxed space-y-0.5">
        <div>
          Elsewhere in Settings: <span className="font-mono">model</span> ·{' '}
          <span className="font-mono">small_model</span> → Models;{' '}
          <span className="font-mono">provider</span> → Providers;{' '}
          <span className="font-mono">agent</span> → Agents;{' '}
          <span className="font-mono">permission</span> → Autonomy mode.
        </div>
        <div>
          <span className="font-mono">mcp</span> is bridged at spawn.{' '}
          <span className="font-mono">server.*</span> is hidden (ClaudeUI&apos;s CLI flags win);{' '}
          <span className="font-mono">layout</span> and <span className="font-mono">autoshare</span>{' '}
          are hidden (deprecated).
        </div>
      </div>
    </div>
  )
}
