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
 * siblings survive. The built-in tool switches, which live in the top-level
 * `permissions` rules, have their own writer (`setOpencodeToolDisabled`).
 *
 * opencode 2.x keys only (ADR-093 S8): a 1.x key the user still has (2.x reads
 * it) shows as the effective value where 2.x maps it one-to-one, and a pane
 * edit writes the 2.x key and deletes the 1.x one in the same write. 1.x keys
 * with no 2.x meaning (compaction.prune/tail_turns, logLevel,
 * experimental.batch_tool) have no row any more.
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
import { deepEqual, isPlainObject } from '../../../../shared/opencode-config-diff'
import {
  OPENCODE_SWITCHABLE_TOOLS,
  agentsOverridingSwitch,
  configAgentRules,
  toolDisabledIn
} from '../../../../shared/opencode-config-v1'
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
  path: LeafPath,
  legacy?: LeafPath
): { modified: boolean; onReset: () => void } {
  return {
    modified: api.read(path) !== undefined || (!!legacy && api.read(legacy) !== undefined),
    onReset: () => commitLeaf(api, path, undefined, legacy)
  }
}

/**
 * A 2.x key that opencode 2.x also reads from a 1.x key (`snapshot` →
 * `snapshots`): the row shows the 2.x value, else the 1.x one (what 2.x uses),
 * and a commit writes the 2.x key and deletes the 1.x one in ONE write.
 */
function readLeafOrLegacy(
  api: OpencodeNativeConfigLeaf,
  path: LeafPath,
  legacy?: LeafPath
): unknown {
  const value = api.read(path)
  return value === undefined && legacy ? api.read(legacy) : value
}

function commitLeaf(
  api: OpencodeNativeConfigLeaf,
  path: LeafPath,
  value: unknown,
  legacy?: LeafPath
): void {
  if (legacy && api.read(legacy) !== undefined) api.patchMany([{ path, value }, { path: legacy }])
  else api.patch(path, value)
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
  /** Dependent row: nests exactly one level under the row it depends on. */
  indent?: boolean
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
  indent,
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
      indent={indent}
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
  indent,
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
      indent={indent}
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
  onReset,
  indent
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
  /** Dependent row: nests exactly one level under the row it depends on. */
  indent?: boolean
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
        indent={indent}
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
  defaultOn,
  legacy
}: {
  api: OpencodeNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  defaultOn: boolean
  /** The 1.x key 2.x also reads for this one (moved on the next commit). */
  legacy?: LeafPath
}): React.JSX.Element {
  const raw = readLeafOrLegacy(api, path, legacy)
  const on = typeof raw === 'boolean' ? raw : defaultOn
  return (
    <ToggleRow
      configKey={pathId(path)}
      label={label}
      helper={helper}
      checked={on}
      onChange={(next) => commitLeaf(api, path, next === defaultOn ? undefined : next, legacy)}
      error={api.errorAt(path)}
      {...leafState(api, path, legacy)}
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
  unit,
  legacy
}: {
  api: OpencodeNativeConfigLeaf
  path: LeafPath
  label: string
  helper: string
  placeholder: string
  unit?: string
  /** The 1.x key 2.x also reads for this one (moved on the next commit). */
  legacy?: LeafPath
}): React.JSX.Element {
  const key = pathId(path)
  return (
    <LeafRow
      configKey={key}
      label={label}
      helper={helper}
      error={api.errorAt(path)}
      {...leafState(api, path, legacy)}
    >
      <LeafNumberInput
        configKey={key}
        value={readLeafOrLegacy(api, path, legacy)}
        placeholder={placeholder}
        unit={unit}
        onCommit={(v) => commitLeaf(api, path, v, legacy)}
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

// ── Pane shell ───────────────────────────────────────────────────────────────

/**
 * Loading is ONE description-only row (ADR-065), and there is no footer: the
 * group card already carries `opencode.jsonc` and the "Next server start" note.
 *
 * Nothing here asks whether opencode is installed: the opencode page cannot be
 * opened while it is not (ADR-082 §8), and the file is ClaudeUI's own read.
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
  if (api.config === null) {
    return <SettingRow testid={testid} description="Loading…" />
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
      <NumberRow
        api={api}
        path={['compaction', 'keep', 'tokens']}
        legacy={['compaction', 'preserve_recent_tokens']}
        label="Recent tokens preserved"
        helper="Token budget for the verbatim tail."
        placeholder="default"
        unit="tokens"
      />
      <NumberRow
        api={api}
        path={['compaction', 'buffer']}
        legacy={['compaction', 'reserved']}
        label="Reserved tokens"
        helper="Headroom so compaction itself cannot overflow the window."
        placeholder="default"
        unit="tokens"
      />
      <NumberRow
        api={api}
        path={['experimental', 'subagent_depth']}
        label="Subagent nesting depth"
        helper="1 stops subagents from launching their own subagents."
        placeholder="1"
      />
      <AbsentDefaultToggleRow
        api={api}
        path={['snapshots']}
        legacy={['snapshot']}
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
  const widthPath: LeafPath = ['media', 'image', 'max_width']
  const heightPath: LeafPath = ['media', 'image', 'max_height']
  // 2.x still reads the 1.x `attachment` block as `media`; a commit moves it.
  const legacyWidth: LeafPath = ['attachment', 'image', 'max_width']
  const legacyHeight: LeafPath = ['attachment', 'image', 'max_height']
  const width = readLeafOrLegacy(api, widthPath, legacyWidth)
  const height = readLeafOrLegacy(api, heightPath, legacyHeight)
  const dimsSet = width !== undefined || height !== undefined
  return (
    <PaneShell testid="OpencodeAttachmentsSection" api={api}>
      <AbsentDefaultToggleRow
        api={api}
        path={['media', 'image', 'auto_resize']}
        legacy={['attachment', 'image', 'auto_resize']}
        label="Resize oversized images"
        helper="Off rejects an over-limit image instead of shrinking it."
        defaultOn={true}
      />
      <LeafRow
        configKey="media.image.max_width"
        keyText="media.image.max_width / max_height"
        label="Maximum dimensions"
        helper="Width and height an image is measured against before resize or rejection."
        error={api.errorAt(widthPath) ?? api.errorAt(heightPath)}
        modified={dimsSet}
        // One write, not two: two `patch` calls in the same tick would be two
        // concurrent read-modify-write cycles over the same file.
        onReset={() =>
          api.patchMany([
            { path: widthPath },
            { path: heightPath },
            { path: legacyWidth },
            { path: legacyHeight }
          ])
        }
      >
        <LeafNumberInput
          configKey={pathId(widthPath)}
          value={width}
          placeholder="2000"
          onCommit={(v) => commitLeaf(api, widthPath, v, legacyWidth)}
          width="w-[72px]"
        />
        <span className="text-[12px] text-text-secondary">×</span>
        <LeafNumberInput
          configKey={pathId(heightPath)}
          value={height}
          placeholder="2000"
          onCommit={(v) => commitLeaf(api, heightPath, v, legacyHeight)}
          width="w-[72px]"
          unit="px"
        />
      </LeafRow>
      <NumberRow
        api={api}
        path={['media', 'image', 'max_base64_bytes']}
        legacy={['attachment', 'image', 'max_base64_bytes']}
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
 * The opencode 2.x built-in tools this pane can switch off (`shared/
 * opencode-config-v1.ts` `OPENCODE_SWITCHABLE_TOOLS`, the 2.x permission
 * actions). OFF is a top-level `{action, resource:"*", effect:"deny"}` rule in
 * `permissions`; MCP and plugin tools are never touched here.
 */
const OPENCODE_BUILTIN_TOOLS = OPENCODE_SWITCHABLE_TOOLS

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

/**
 * The 1.x `plugin` list (strings or `[package, options]` tuples) as 2.x
 * `plugins` entries (`normalize.ts`: a tuple becomes `{package, options}`).
 */
function pluginsFromLegacy(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) =>
    Array.isArray(entry) && typeof entry[0] === 'string'
      ? { package: entry[0], ...(isPlainObject(entry[1]) ? { options: entry[1] } : {}) }
      : entry
  )
}

/**
 * `plugins`: the 2.x list, which 2.x reads AFTER the 1.x `plugin` list. Shown
 * as the two in that order; a commit writes the whole 2.x list (the 1.x
 * entries moved into it) and deletes `plugin` in the same write.
 */
function PluginsRow({ api }: { api: OpencodeNativeConfigLeaf }): React.JSX.Element {
  const legacy = pluginsFromLegacy(api.read(['plugin']))
  const native = api.read(['plugins'])
  const all = [...legacy, ...(Array.isArray(native) ? native : [])]
  const items = all.filter((v): v is string => typeof v === 'string')
  const opaque = all.filter((v) => typeof v !== 'string')
  const opaqueNote =
    opaque.length > 0
      ? ` ${opaque.length} advanced ${opaque.length === 1 ? 'entry is' : 'entries are'} kept as-is and not shown here.`
      : ''
  return (
    <StackedRow
      configKey="plugins"
      label="Plugins"
      helper={`Loads alongside ClaudeUI's injected caller-identity plugin.${opaqueNote}`}
      error={api.errorAt(['plugins'])}
      modified={all.length > 0}
      onReset={() => api.patchMany([{ path: ['plugins'] }, { path: ['plugin'] }])}
    >
      <ListEditor
        items={items}
        placeholder="npm package or plugin directory…"
        onUpdate={(next) => {
          const merged = [...next, ...opaque]
          api.patchMany([
            { path: ['plugins'], value: merged.length > 0 ? merged : undefined },
            { path: ['plugin'] }
          ])
        }}
        testid={`${PANE_TESTID}.list`}
      />
    </StackedRow>
  )
}

/** `skills`: a 2.x list of paths/URLs; the 1.x `{paths, urls}` object is read as one. */
function SkillsRow({ api }: { api: OpencodeNativeConfigLeaf }): React.JSX.Element {
  const raw = api.read(['skills'])
  const list = Array.isArray(raw)
    ? raw
    : isPlainObject(raw)
      ? [
          ...(Array.isArray(raw.paths) ? raw.paths : []),
          ...(Array.isArray(raw.urls) ? raw.urls : [])
        ]
      : []
  const items = list.filter((v): v is string => typeof v === 'string')
  return (
    <StackedRow
      configKey="skills"
      label="Skill folders"
      helper="Searched in addition to the skills ClaudeUI already discovers (paths or URLs)."
      error={api.errorAt(['skills'])}
      {...leafState(api, ['skills'])}
    >
      <ListEditor
        items={items}
        placeholder="/path/to/skills"
        onUpdate={(next) => api.patch(['skills'], next.length > 0 ? next : undefined)}
        testid={`${PANE_TESTID}.list`}
      />
    </StackedRow>
  )
}

export function OpencodeToolsSection(): React.JSX.Element {
  const api = useOpencodeNativeConfigLeaf()
  const [toolError, setToolError] = useState<string | null>(null)
  const [mdAgents, setMdAgents] = useState<OpencodeAgentSummary[]>([])
  useEffect(() => {
    let cancelled = false
    window.api
      .listOpencodeAgents()
      .then((all) => {
        if (!cancelled) setMdAgents(all)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  const config = api.config ?? {}
  // The case-folding platform of the matcher: shared code never reads `process`.
  const platform = window.api.platform
  const off = OPENCODE_BUILTIN_TOOLS.filter((id) => toolDisabledIn(config, id, platform))
  // 2.x appends top-level rules BEFORE a config-defined agent's own rules, so
  // an agent whose own rules allow the tool still offers it.
  const ownRules = [
    ...configAgentRules(config),
    ...mdAgents.flatMap((a) => (a.rules?.length ? [{ name: a.name, rules: a.rules }] : []))
  ]
  const overriding = off.flatMap((id) => {
    const names = agentsOverridingSwitch(id, ownRules, platform)
    return names.length ? [`${id}: ${[...new Set(names)].join(', ')}`] : []
  })

  const setTool = (id: string, disabled: boolean): void => {
    window.api
      .setOpencodeToolDisabled(id, disabled)
      .then(() => {
        setToolError(null)
        api.reload()
      })
      .catch((e: unknown) => {
        setToolError(e instanceof Error ? e.message : String(e))
        api.reload()
      })
  }

  return (
    <PaneShell testid="OpencodeToolsSection" api={api}>
      <StackedRow
        configKey="permissions"
        keyText='permissions: {"action":"<tool>","resource":"*","effect":"deny"}'
        label="Built-in tools"
        helper={`Off adds a deny-all rule to opencode's top-level permissions, which hides the tool from the built-in agents. An agent with its own rules for the tool still offers it, and a tool your own rules switch off cannot be switched on here.${overriding.length ? ` Still offered by: ${overriding.join('; ')}.` : ''}`}
        error={toolError}
        modified={off.length > 0}
        onReset={() => off.forEach((id) => setTool(id, false))}
      >
        <ChipSet
          testid={PANE_TESTID}
          value={OPENCODE_BUILTIN_TOOLS.filter((id) => !off.includes(id))}
          options={OPENCODE_BUILTIN_TOOLS.map((id) => ({ value: id, label: id }))}
          onToggle={(id) =>
            setTool(id, !off.includes(id as (typeof OPENCODE_BUILTIN_TOOLS)[number]))
          }
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
      <PluginsRow api={api} />
      <SkillsRow api={api} />
    </PaneShell>
  )
}

// ── 2f · Diagnostics ─────────────────────────────────────────────────────────

/**
 * opencode 2.x has no log-level key (it is the `--log-level` flag) and no
 * batch tool; its MCP timeouts are `mcp.timeout.{startup,catalog,execution}`
 * (the 1.x `experimental.mcp_timeout` set both catalog and execution: both
 * rows show it, and the writer moves it into whichever leaf is still unset).
 */
export function OpencodeDiagnosticsSection(): React.JSX.Element {
  const api = useOpencodeNativeConfigLeaf()
  return (
    <PaneShell testid="OpencodeDiagnosticsSection" api={api}>
      <NumberRow
        api={api}
        path={['mcp', 'timeout', 'execution']}
        legacy={['experimental', 'mcp_timeout']}
        label="MCP call timeout"
        helper="How long an MCP tool call may run before it is cancelled."
        placeholder="default"
        unit="ms"
      />
      <NumberRow
        api={api}
        path={['mcp', 'timeout', 'catalog']}
        legacy={['experimental', 'mcp_timeout']}
        label="MCP catalog timeout"
        helper="How long listing a server's tools may take."
        placeholder="default"
        unit="ms"
      />
      <NumberRow
        api={api}
        path={['mcp', 'timeout', 'startup']}
        label="MCP startup timeout"
        helper="How long a server may take to connect."
        placeholder="default"
        unit="ms"
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
    configKey: 'update',
    label: 'Self-update',
    forcedOn: false,
    why: 'ClaudeUI installs and updates its own opencode; a self-update would replace it under a running session.'
  },
  {
    configKey: 'share',
    label: 'Cloud session sharing',
    forcedOn: false,
    why: "Uploads full session content — messages, file diffs — to opencode's cloud."
  }
]

/**
 * Static pane — no IPC, nothing writable. ClaudeUI's spawn switches both off
 * (`OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_SHARE`), so a value in the
 * user's file would be overridden anyway; showing them read-only is
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
        description="Elsewhere in Settings: model and the small model (agents.title) under Models & providers, providers under its provider list, agents under Agents; ClaudeUI's own MCP servers are bridged at spawn and per-session permissions follow Sessions & autonomy."
      />
    </div>
  )
}
