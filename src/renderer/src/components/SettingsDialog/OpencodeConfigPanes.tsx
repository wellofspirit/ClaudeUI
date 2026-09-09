/**
 * OpencodeConfigPanes.tsx
 *
 * The curated opencode groups on the opencode settings page: seven hand-written
 * panes over the opencode config keys worth a real control, with the generic
 * schema-driven editor ("Raw config", settings-sections.tsx) keeping everything
 * else.
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
 *    input deletes its key for the same reason. That is also what "changed
 *    from default" MEANS here (ADR-065): a row is modified when its key is
 *    present in the file, and its Reset deletes the key.
 *  · LEAF PATCHES ONLY. Nested keys (`compaction.auto`, `experimental.batch_tool`,
 *    `tools.<id>`) are patched at their own path, never by writing the parent
 *    object — a user file may hold sibling keys these panes don't model, and
 *    a whole-object write would erase them.
 *
 * Every row is drawn with the ADR-065 row vocabulary (`settings-controls.tsx`):
 * label, one-sentence description, the raw config key on its own mono line, and
 * a control in the 240px column. The pane footers are gone — the group card
 * carries the storage tag and the "Next server start" note.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  ChipSet,
  ListEditor,
  SelectField,
  SettingRow,
  SettingsToggle
} from './settings-controls'
import { RawJsonField } from './OpencodeSchemaForm'
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
  /** Current value at `path`, or undefined when the key is absent. */
  read: (path: LeafPath) => unknown
  /**
   * Commit ONE leaf. `undefined` deletes the key (the `diffToPatches`
   * convention: a patch with no `value` is a delete). A no-op when the value
   * already matches, so a blur without an edit never touches the file.
   */
  patch: (path: LeafPath, value: unknown) => void
  /**
   * Commit SEVERAL leaves in one write. Two `patch` calls in the same tick
   * would be two concurrent read-modify-write cycles over the same file, so a
   * row that owns more than one key (the image dimensions, the built-in tool
   * chips' Reset) batches them instead.
   */
  patchMany: (entries: { path: LeafPath; value?: unknown }[]) => void
  /** The last patch failure for `path`, or null. */
  errorAt: (path: LeafPath) => string | null
  reload: () => void
}

function useOpencodeNativeConfigLeaf(): OpencodeNativeConfigLeaf {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const reload = useCallback((): void => {
    window.api
      .readOpencodeNativeRaw()
      .then(({ config: next }) => setConfig(next))
      .catch(() => setConfig({}))
  }, [])

  useEffect(() => reload(), [reload])

  const read = useCallback((path: LeafPath) => readLeaf(config, path), [config])

  const patchMany = useCallback(
    (entries: { path: LeafPath; value?: unknown }[]): void => {
      const changed = entries.filter((e) => !deepEqual(readLeaf(config, e.path), e.value))
      if (changed.length === 0) return
      const ids = changed.map((e) => pathId(e.path))
      const patches: RawConfigPatch[] = changed.map((e) =>
        e.value === undefined ? { path: e.path } : { path: e.path, value: e.value }
      )
      window.api
        .patchOpencodeNative(patches)
        .then(() => {
          setErrors((prev) => {
            if (!ids.some((id) => id in prev)) return prev
            const next = { ...prev }
            for (const id of ids) delete next[id]
            return next
          })
          reload()
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e)
          setErrors((prev) => {
            const next = { ...prev }
            for (const id of ids) next[id] = message
            return next
          })
        })
    },
    [config, reload]
  )

  const patch = useCallback(
    (path: LeafPath, value: unknown): void => patchMany([{ path, value }]),
    [patchMany]
  )

  const errorAt = useCallback((path: LeafPath) => errors[pathId(path)] ?? null, [errors])

  return { config, read, patch, patchMany, errorAt, reload }
}

/** The row is "changed from default" when its key is PRESENT in the file. */
function leafState(
  api: OpencodeNativeConfigLeaf,
  path: LeafPath
): { modified: boolean; onReset: () => void } {
  return {
    modified: api.read(path) !== undefined,
    onReset: () => api.patch(path, undefined)
  }
}

// ── Row primitives ───────────────────────────────────────────────────────────

/**
 * The two-tier testid namespace these rows emit (`<prefix>.row`, `.toggle`,
 * `.number`, `.text`, `.error`). Every primitive below takes it as an
 * overridable prop: the per-model capability editor
 * (OpencodeModelCapabilities.tsx), the opencode provider modal
 * (OpencodeProviders.tsx) and the pi panes (PiConfigPanes.tsx,
 * PiCustomProviders.tsx) reuse these rows under their OWN prefix, so a test can
 * address their controls without disambiguating them from an opencode
 * Configuration pane's.
 *
 * `.error` deliberately hangs off the PREFIX rather than off the row's testid:
 * it is the id every one of those call sites' tests already asserts, so the
 * primitive's `errorTestid` override carries it across the restyle.
 */
const PANE_TESTID = 'OpencodeConfigPane'

interface RowProps {
  configKey: string
  label: string
  helper: string
  error: string | null
  /** Raw key(s), on their own mono line. Defaults to `configKey`. */
  keyText?: string
  /** Testid namespace for the row and its error. Defaults to the panes'. */
  testidPrefix?: string
  /** Accent dot + hover Reset (ADR-065). See `leafState`. */
  modified?: boolean
  onReset?: () => void
  children: React.ReactNode
}

/** Label block on the left, control in the 240px column (toggles aside — see ToggleRow). */
export function LeafRow({
  configKey,
  label,
  helper,
  error,
  keyText,
  testidPrefix = PANE_TESTID,
  modified,
  onReset,
  children
}: RowProps): React.JSX.Element {
  return (
    <SettingRow
      testid={`${testidPrefix}.row`}
      dataId={configKey}
      label={label}
      description={helper}
      keyText={keyText ?? configKey}
      error={error ?? undefined}
      errorTestid={`${testidPrefix}.error`}
      modified={modified}
      onReset={onReset}
    >
      {children}
    </SettingRow>
  )
}

/** Control spans the full width UNDER the label block (lists, chip sets, text). */
export function StackedRow({
  configKey,
  label,
  helper,
  error,
  keyText,
  testidPrefix = PANE_TESTID,
  modified,
  onReset,
  children
}: RowProps): React.JSX.Element {
  return (
    <SettingRow
      layout="stacked"
      testid={`${testidPrefix}.row`}
      dataId={configKey}
      label={label}
      description={helper}
      keyText={keyText ?? configKey}
      error={error ?? undefined}
      errorTestid={`${testidPrefix}.error`}
      modified={modified}
      onReset={onReset}
    >
      {children}
    </SettingRow>
  )
}

/**
 * Toggle row: `SettingsToggle` IS the row (label, description, key and switch in
 * one), wrapped only so `<prefix>.row` and `<prefix>.toggle` can both be
 * addressed — one element cannot carry two testids.
 */
export function ToggleRow({
  configKey,
  label,
  helper,
  keyText,
  checked,
  onChange,
  error,
  testidPrefix = PANE_TESTID,
  modified,
  onReset
}: {
  configKey: string
  label: string
  helper: string
  keyText?: string
  checked: boolean
  onChange: (v: boolean) => void
  error: string | null
  testidPrefix?: string
  modified?: boolean
  onReset?: () => void
}): React.JSX.Element {
  return (
    <div data-testid={`${testidPrefix}.row`} data-id={configKey}>
      <SettingsToggle
        label={label}
        description={helper}
        keyText={keyText ?? configKey}
        checked={checked}
        onChange={onChange}
        error={error ?? undefined}
        errorTestid={`${testidPrefix}.error`}
        modified={modified}
        onReset={onReset}
        testid={`${testidPrefix}.toggle`}
        dataId={configKey}
      />
    </div>
  )
}

// ── Controls ─────────────────────────────────────────────────────────────────

/** Right-aligned, tabular numerals, no spinner — `NumberField`'s look exactly. */
const NUMBER_INPUT_CLASS =
  'h-7 shrink-0 bg-bg-input border border-border rounded-md px-2.5 text-[12px] text-text-primary text-right tabular-nums placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

const TEXT_INPUT_CLASS =
  'h-7 bg-bg-input border border-border rounded-md px-2.5 text-[12px] text-text-primary font-mono placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors'

/**
 * Number input with a LOCAL draft, committed on blur and on Enter. An empty
 * field deletes the key. The draft resyncs whenever the committed value moves
 * (i.e. after a successful patch + re-read); a REJECTED patch leaves the value
 * untouched, so the user's text survives next to the error instead of snapping
 * back. That last property is why this is not `NumberField`, which reverts to
 * its prop on every blur.
 */
export function LeafNumberInput({
  configKey,
  value,
  placeholder,
  onCommit,
  unit,
  width = 'w-[88px]',
  testid = `${PANE_TESTID}.number`,
  step = 1
}: {
  configKey: string
  value: unknown
  placeholder: string
  onCommit: (v: number | undefined) => void
  /** tokens · lines · bytes · px · ms — shown after the field, as on the board. */
  unit?: string
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
    <>
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
        className={`${NUMBER_INPUT_CLASS} ${width}`}
      />
      {unit && <span className="text-[12px] text-text-secondary whitespace-nowrap">{unit}</span>}
    </>
  )
}

/** Text input with the same draft / commit-on-blur-or-Enter contract. */
export function LeafTextInput({
  configKey,
  value,
  placeholder,
  onCommit,
  width = 'w-44',
  testid = `${PANE_TESTID}.text`
}: {
  configKey: string
  value: unknown
  placeholder: string
  onCommit: (v: string | undefined) => void
  width?: string
  testid?: string
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
      data-testid={testid}
      data-id={configKey}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      className={`${TEXT_INPUT_CLASS} ${width}`}
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
      {...leafState(api, path)}
    />
  )
}

/** Number row bound to one leaf. */
function NumberRow({
  api,
  path,
  label,
  helper,
  placeholder,
  unit
}: {
  api: OpencodeNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  placeholder: string
  unit?: string
}): React.JSX.Element {
  const key = pathId(path)
  return (
    <LeafRow
      configKey={key}
      label={label}
      helper={helper}
      error={api.errorAt(path)}
      {...leafState(api, path)}
    >
      <LeafNumberInput
        configKey={key}
        value={api.read(path)}
        placeholder={placeholder}
        unit={unit}
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
  const opaqueNote =
    opaque.length > 0
      ? ` ${opaque.length} advanced ${opaque.length === 1 ? 'entry is' : 'entries are'} kept as-is and not shown here.`
      : ''
  return (
    <StackedRow
      configKey={key}
      label={label}
      helper={`${helper}${opaqueNote}`}
      error={api.errorAt(path)}
      {...leafState(api, path)}
    >
      <ListEditor
        items={items}
        placeholder={placeholder}
        onUpdate={(next) => {
          const merged = [...next, ...opaque]
          api.patch(path, merged.length > 0 ? merged : undefined)
        }}
        testid={`${PANE_TESTID}.list`}
      />
    </StackedRow>
  )
}

// ── Pane shell (install gate) ────────────────────────────────────────────────

/**
 * Loading and not-installed are ONE description-only row each (ADR-065), and
 * there is no footer: the group card already carries `opencode.jsonc` and the
 * "Next server start" note.
 */
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
    return <SettingRow testid={testid} description="Loading…" />
  }
  if (!installed) {
    return (
      <SettingRow
        testid={testid}
        dimmed
        description="opencode is not installed. This edits opencode's own config file."
      />
    )
  }
  return (
    <div data-testid={testid} className="divide-y divide-border/55">
      {children}
    </div>
  )
}

// ── 2a · Session behaviour ───────────────────────────────────────────────────

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
        helper="Recent user turns preserved uncompacted."
        placeholder="unlimited"
      />
      <NumberRow
        api={api}
        path={['compaction', 'preserve_recent_tokens']}
        label="Recent tokens preserved"
        helper="Token budget for the verbatim tail."
        placeholder="default"
        unit="tokens"
      />
      <NumberRow
        api={api}
        path={['compaction', 'reserved']}
        label="Reserved tokens"
        helper="Headroom so compaction itself cannot overflow the window."
        placeholder="default"
        unit="tokens"
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
        helper="Required for undo and revert of file changes."
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
        unit="lines"
      />
      <NumberRow
        api={api}
        path={['tool_output', 'max_bytes']}
        label="Max bytes"
        helper="The same truncation, by size."
        placeholder="51200"
        unit="bytes"
      />
    </PaneShell>
  )
}

// ── 2c · Image attachments ───────────────────────────────────────────────────

export function OpencodeAttachmentsSection(): React.JSX.Element {
  const api = useOpencodeNativeConfigLeaf()
  const widthPath: LeafPath = ['attachment', 'image', 'max_width']
  const heightPath: LeafPath = ['attachment', 'image', 'max_height']
  const dimsSet = api.read(widthPath) !== undefined || api.read(heightPath) !== undefined
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
        helper="Width and height an image is measured against before resize or rejection."
        error={api.errorAt(widthPath) ?? api.errorAt(heightPath)}
        modified={dimsSet}
        // One write, not two: two `patch` calls in the same tick would be two
        // concurrent read-modify-write cycles over the same file.
        onReset={() => api.patchMany([{ path: widthPath }, { path: heightPath }])}
      >
        <LeafNumberInput
          configKey={pathId(widthPath)}
          value={api.read(widthPath)}
          placeholder="2000"
          onCommit={(v) => api.patch(widthPath, v)}
          width="w-[72px]"
        />
        <span className="text-[12px] text-text-secondary">×</span>
        <LeafNumberInput
          configKey={pathId(heightPath)}
          value={api.read(heightPath)}
          placeholder="2000"
          onCommit={(v) => api.patch(heightPath, v)}
          width="w-[72px]"
          unit="px"
        />
      </LeafRow>
      <NumberRow
        api={api}
        path={['attachment', 'image', 'max_base64_bytes']}
        label="Maximum payload"
        helper="How large an image attachment may be once base64-encoded."
        placeholder="5242880"
        unit="bytes"
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
        helper="Extra files or globs merged into the system context."
        placeholder="AGENTS.md, docs/*.md…"
      />
      <LeafRow
        configKey={pathId(agentPath)}
        label="Default agent"
        helper="Must be a primary agent; opencode falls back to build."
        error={api.errorAt(agentPath)}
        {...leafState(api, agentPath)}
      >
        <SelectField
          testid={`${PANE_TESTID}.select`}
          dataId={pathId(agentPath)}
          value={typeof current === 'string' ? current : ''}
          onChange={(v) => api.patch(agentPath, v === '' ? undefined : v)}
          options={[
            { value: '', label: 'build (default)' },
            ...agents.map((a) => ({ value: a.name, label: a.name }))
          ]}
        />
      </LeafRow>
      <StackedRow
        configKey={pathId(shellPath)}
        label="Shell"
        helper="Used by the terminal and the bash tool."
        error={api.errorAt(shellPath)}
        {...leafState(api, shellPath)}
      >
        <LeafTextInput
          configKey={pathId(shellPath)}
          value={api.read(shellPath)}
          placeholder="system default"
          onCommit={(v) => api.patch(shellPath, v)}
          width="w-full"
        />
      </StackedRow>
      <StringListRow
        api={api}
        path={['watcher', 'ignore']}
        label="File-watcher ignores"
        helper="Globs the workspace watcher skips."
        placeholder="**/dist/**"
      />
    </PaneShell>
  )
}

// ── 2e · Tools & integrations ────────────────────────────────────────────────

/**
 * opencode's built-in tool ids, from the v1.18.29 registry
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
    <div data-testid={`${PANE_TESTID}.row`} data-id={key}>
      <SettingsToggle
        label={label}
        description={helper}
        keyText={key}
        checked={on}
        onChange={(next) => api.patch(path, next ? undefined : false)}
        error={api.errorAt(path) ?? undefined}
        errorTestid={`${PANE_TESTID}.error`}
        testid={`${PANE_TESTID}.toggle`}
        dataId={key}
        {...leafState(api, path)}
      />
      {/* The disclosure cannot live INSIDE the toggle: that row is itself a
          <button>, and nesting buttons is invalid HTML. */}
      <div className="px-3.5 pb-2.5 -mt-1">
        <Button
          variant="link"
          testid={`${PANE_TESTID}.disclosure`}
          dataId={key}
          ariaExpanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '▾' : '▸'} Overrides…
        </Button>
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
      </div>
    </div>
  )
}

export function OpencodeToolsSection(): React.JSX.Element {
  const api = useOpencodeNativeConfigLeaf()
  const tools = api.read(['tools'])
  const toolsObj = isPlainObject(tools) ? tools : {}
  const overridden = OPENCODE_BUILTIN_TOOLS.filter((id) => toolsObj[id] !== undefined)

  return (
    <PaneShell testid="OpencodeToolsSection" api={api}>
      <StackedRow
        configKey="tools"
        label="Built-in tools"
        helper="Turn one off to hide it from every agent."
        error={
          // One shared row error: only one chip can be in flight at a time.
          OPENCODE_BUILTIN_TOOLS.map((id) => api.errorAt(['tools', id])).find(Boolean) ?? null
        }
        modified={overridden.length > 0}
        onReset={() => api.patchMany(overridden.map((id) => ({ path: ['tools', id] })))}
      >
        <ChipSet
          testid={PANE_TESTID}
          value={OPENCODE_BUILTIN_TOOLS.filter((id) => toolsObj[id] !== false)}
          options={OPENCODE_BUILTIN_TOOLS.map((id) => ({ value: id, label: id }))}
          // ON is the DEFAULT, so turning a tool back on deletes its key rather
          // than writing `true`.
          onToggle={(id) => api.patch(['tools', id], toolsObj[id] !== false ? false : undefined)}
        />
      </StackedRow>
      <UnionToggleRow
        api={api}
        path={['formatter']}
        label="Code formatters"
        helper="Built-in formatters run after edits; Overrides adds or disables one."
      />
      <UnionToggleRow
        api={api}
        path={['lsp']}
        label="Language servers"
        helper="Built-in language servers supply diagnostics; Overrides adds or disables one."
      />
      <StringListRow
        api={api}
        path={['plugin']}
        label="Plugins"
        helper="Loads alongside ClaudeUI's injected caller-identity plugin."
        placeholder="npm package or file path…"
      />
      <StringListRow
        api={api}
        path={['skills', 'paths']}
        label="Skill folders"
        helper="Searched in addition to the skills ClaudeUI already discovers."
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
        helper="Verbosity of opencode's own log file."
        error={api.errorAt(logPath)}
        {...leafState(api, logPath)}
      >
        <SelectField
          testid={`${PANE_TESTID}.select`}
          dataId={pathId(logPath)}
          width="min-w-[120px]"
          value={typeof level === 'string' ? level : ''}
          onChange={(v) => api.patch(logPath, v === '' ? undefined : v)}
          options={LOG_LEVEL_OPTIONS}
        />
      </LeafRow>
      {/* Leaf paths, never a whole-`experimental` write: ClaudeUI itself injects
          experimental.continue_loop_on_deny at spawn and a user file may carry
          other experimental keys. */}
      <NumberRow
        api={api}
        path={['experimental', 'mcp_timeout']}
        label="MCP request timeout"
        helper="How long an MCP call may run before it is cancelled."
        placeholder="5000"
        unit="ms"
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
 * more honest than hiding them. The lock badge is the vocabulary's Managed
 * state (ADR-065): the control is shown, and is not interactive.
 */
export function OpencodeManagedKeysSection(): React.JSX.Element {
  return (
    <div data-testid="OpencodeManagedKeysSection" className="divide-y divide-border/55">
      {MANAGED_KEYS.map((k) => (
        <SettingsToggle
          key={k.configKey}
          testid={`${PANE_TESTID}.managedRow`}
          dataId={k.configKey}
          label={k.label}
          description={k.why}
          keyText={k.configKey}
          locked={k.forcedOn ? 'Forced on' : 'Forced off'}
          checked={k.forcedOn}
          disabled
          onChange={() => {}}
        />
      ))}
      <SettingRow
        testid={`${PANE_TESTID}.elsewhere`}
        description="Elsewhere in Settings: model and small_model under Models & providers, provider under its provider list, agent under Agents and permission under Sessions & autonomy; mcp is bridged at spawn, while server.*, layout and autoshare are hidden."
      />
    </div>
  )
}
