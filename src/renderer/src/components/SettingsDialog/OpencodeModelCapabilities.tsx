/**
 * OpencodeModelCapabilities.tsx
 *
 * The per-model capability editor behind each model row's "Capabilities" action
 * in the opencode provider dialog (OpencodeProviderConfigModal,
 * OpencodeProviders.tsx). It used to be the generic schema-driven form, which
 * labelled every field with its full raw path (`my-ollama.qwen3:27b.attachment`)
 * and nested modalities/cost behind raw fieldsets; this is the curated version,
 * in the same row language as the Configuration panes (OpencodeConfigPanes.tsx,
 * whose row primitives it reuses) and the same frame language as pi's model
 * editor (provider-editor-shell.tsx — pill chips, accent disclosures, the
 * stacked dialog).
 *
 * TWO FRAMES, ONE SET OF ROWS. With `onClose` it is a stacked `DialogShell` of
 * its own, which is how the provider dialog opens it; without one it renders
 * inline, for a host that wants it embedded in its own scrolling body (how that
 * dialog mounted it before the restyle). The frame is presentation only — every
 * write below is identical either way, pinned by a patch-identity test.
 *
 * WHAT IT WRITES (opencode 2.x, ADR-093 S8). The model's entry lives at
 * `providers.<providerId>.models.<modelId>`. Every commit is a minimal LEAF
 * diff of that entry (diffToPatches → patchOpencodeNative), so the keys this
 * editor does not render — modelID, family, name, hand-written extras — are
 * never part of a patch. A provider that still lives under the 1.x `provider`
 * key is SHOWN in its 2.x form (`nativeProviderEntry`) and MOVED there whole by
 * the main-process writer before the first patch lands.
 *
 * 2.x has no per-model `attachment`, `reasoning` or `temperature` flag (it
 * drops them with a warning). What they meant is expressed as:
 *   attachment  → `image`/`pdf` in `capabilities.input` (the input chips)
 *   reasoning   → `variants`: an empty list means "no reasoning variants";
 *                 absent lets opencode generate effort variants from the package
 *   temperature → no switch any more; a fixed value goes in `body.temperature`
 *   interleaved → `compatibility.reasoningField` (Advanced)
 * The editor says so in a row of its own rather than offering dead switches.
 *
 * WHEN IT WRITES. Immediately, like the Configuration panes: a toggle or chip
 * click commits at once, number inputs commit on blur AND Enter, raw-JSON leaves
 * commit on blur. There is no Save button.
 *
 * THREE RULES RUN THROUGH IT:
 *
 *  · ABSENT MEANS DEFAULT. A key whose absence already produces the wanted
 *    behaviour is deleted rather than written. The defaults are opencode's OWN
 *    (`Model.Capabilities.default()`: tools on, input text+image, output text),
 *    not the schema's — the generated schema carries no `default` keywords.
 *  · EMPTY PARENTS GO. When a delete leaves `capabilities` / `cost` / `limit`
 *    with no keys at all, the block itself is deleted rather than written back
 *    as `{}`. A block still holding keys this editor doesn't render is kept.
 *  · REQUIRED FIELDS COME IN PAIRS. 2.x's `cost` requires input+output, and
 *    the raw writer validates the touched keys with ajv before writing. So
 *    creating a pricing block seeds its missing partner with 0, and clearing
 *    either half removes the block. A TIERED cost (an array) is edited under
 *    Advanced.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { RawJsonField } from './OpencodeSchemaForm'
import { StackedRow, ToggleRow, LeafNumberInput } from './OpencodeConfigPanes'
import { SettingRow } from './settings-controls'
import { DialogShell, Disclosure, pillClass } from './provider-editor-shell'
import { diffToPatches, isPlainObject } from '../../../../shared/opencode-config-diff'
import { nativeProviderEntry } from '../../../../shared/opencode-config-v1'
import type { RawConfigPatch } from '../../../../shared/types'

const TESTID = 'ModelCapabilityEditor'

/** A path INSIDE the model entry (the `providers…models.<id>` prefix is added at
 *  patch time), e.g. `['cost', 'cache', 'read']`. */
type EntryPath = string[]
type Entry = Record<string, unknown>

/** Stable string form of an entry path — keys testids, labels, error slots. */
const pathId = (path: EntryPath): string => path.join('.')

function readAt(root: unknown, path: EntryPath): unknown {
  let cur: unknown = root
  for (const seg of path) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[seg]
  }
  return cur
}

// ── Schema-required blocks ───────────────────────────────────────────────────

/**
 * Fields the generated 2.x schema marks `required` inside a model entry, by
 * the dotted path of the block that requires them (`Config.ModelEncoded` →
 * `Config.Model.CostEncoded`). `patchOpencodeNativeRaw` validates the touched
 * keys with ajv before writing, so `cost: { input: 3 }` is rejected outright;
 * opencode reads an absent cost as 0, so seeding the partner with 0 changes no
 * behaviour. Exported for the guard test (it restates the schema).
 */
export const REQUIRED_FIELDS: Record<string, string[]> = {
  cost: ['input', 'output']
}

// ── Entry mutation (immutable at the call site — these run on a clone) ───────

function setAt(root: Entry, path: EntryPath, value: unknown): void {
  let cur: Entry = root
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    if (!isPlainObject(cur[key])) cur[key] = {}
    cur = cur[key] as Entry
  }
  cur[path[path.length - 1]] = value
}

function deleteAt(root: Entry, path: EntryPath): void {
  const chain: Entry[] = [root]
  let cur: Entry = root
  for (let i = 0; i < path.length - 1; i++) {
    const child = cur[path[i]]
    if (!isPlainObject(child)) return // nothing there to delete
    cur = child
    chain.push(cur)
  }
  delete cur[path[path.length - 1]]
  // Empty-parent cleanup, deepest block first. `Object.keys` — not "every key
  // this editor renders" — so a block still holding a hand-written key stays.
  for (let i = chain.length - 1; i >= 1; i--) {
    if (Object.keys(chain[i]).length > 0) break
    delete chain[i - 1][path[i - 1]]
  }
}

/**
 * The path a DELETE must actually target. Clearing a required field would leave
 * its block invalid, so the block goes instead — which is also the only way to
 * remove a pricing or limit block from the file. Loops because a required field
 * may itself sit in a required block.
 */
function deleteTarget(path: EntryPath): EntryPath {
  let target = path
  for (;;) {
    const parent = target.slice(0, -1)
    const required = REQUIRED_FIELDS[pathId(parent)]
    if (!required?.includes(target[target.length - 1])) return target
    target = parent
  }
}

/** Seed the required siblings of every block a SET at `path` may have created. */
function fillRequired(entry: Entry, path: EntryPath): void {
  for (let depth = 1; depth < path.length; depth++) {
    const blockPath = path.slice(0, depth)
    const required = REQUIRED_FIELDS[pathId(blockPath)]
    if (!required) continue
    const block = readAt(entry, blockPath)
    if (!isPlainObject(block)) continue
    // Only genuinely-absent partners: a hand-written junk value is left alone so
    // ajv rejects it visibly instead of being silently overwritten with 0.
    for (const key of required) if (block[key] === undefined) block[key] = 0
  }
}

// ── Entry read / commit ──────────────────────────────────────────────────────

interface ModelEntryApi {
  /** null until the first read resolves. */
  entry: Entry | null
  read: (path: EntryPath) => unknown
  /**
   * Commit ONE leaf of the entry. `undefined` deletes (promoted to the whole
   * block for a required field). `rowKey` is the row an error belongs to, which
   * is not always the patched path — clearing `cost.input` deletes `cost`.
   */
  commit: (rowKey: string, path: EntryPath, value: unknown) => void
  errorAt: (rowKey: string) => string | null
}

function useModelEntry(providerId: string, modelId: string): ModelEntryApi {
  const [entry, setEntry] = useState<Entry | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const load = useCallback((): void => {
    window.api
      .readOpencodeNativeRaw()
      .then(({ config }) => {
        const provider = nativeProviderEntry(config, providerId)
        const found = readAt(provider, ['models', modelId])
        setEntry(isPlainObject(found) ? found : {})
      })
      .catch(() => setEntry({}))
  }, [providerId, modelId])

  useEffect(() => load(), [load])

  const read = useCallback((path: EntryPath) => readAt(entry, path), [entry])

  const commit = useCallback(
    (rowKey: string, path: EntryPath, value: unknown): void => {
      if (entry === null) return
      const next = structuredClone(entry)
      if (value === undefined) {
        deleteAt(next, deleteTarget(path))
      } else {
        setAt(next, path, value)
        fillRequired(next, path)
      }
      const patches: RawConfigPatch[] = diffToPatches(entry, next, [
        'providers',
        providerId,
        'models',
        modelId
      ])
      // No-op commits (a blur with no edit, a chip click that lands back on the
      // committed value) never touch the file.
      if (patches.length === 0) return
      window.api
        .patchOpencodeNative(patches)
        .then(() => {
          setErrors((prev) => {
            if (!(rowKey in prev)) return prev
            const rest = { ...prev }
            delete rest[rowKey]
            return rest
          })
          load()
          // Capability edits change what the model picker shows (limits, cost,
          // attachment support), so the session store re-reads them.
          useSessionStore.getState().reloadModels()
        })
        .catch((e: unknown) => {
          setErrors((prev) => ({ ...prev, [rowKey]: e instanceof Error ? e.message : String(e) }))
        })
    },
    [entry, providerId, modelId, load]
  )

  const errorAt = useCallback((rowKey: string) => errors[rowKey] ?? null, [errors])

  return { entry, read, commit, errorAt }
}

// ── Boolean capabilities ─────────────────────────────────────────────────────

interface CapabilityToggle {
  /** Row id (and testid data-id). */
  key: string
  /** The entry path the toggle reads and writes. */
  path: EntryPath
  label: string
  helper: string
  /** What opencode assumes when the key is ABSENT. */
  defaultOn: boolean
}

/**
 * The boolean capability 2.x still has, and the value it gets when absent
 * (`Model.Capabilities.default()`, `vendor/opencode-v2-src/packages/schema/
 * src/model.ts`). Exported for a guard test.
 */
export const CAPABILITY_TOGGLES: CapabilityToggle[] = [
  {
    key: 'capabilities.tools',
    path: ['capabilities', 'tools'],
    label: 'Tool calling',
    helper: 'Model can call tools; opencode assumes it can when unset —',
    defaultOn: true
  }
]

function CapabilityToggleRow({
  api,
  spec
}: {
  api: ModelEntryApi
  spec: CapabilityToggle
}): React.JSX.Element {
  const raw = api.read(spec.path)
  const on = typeof raw === 'boolean' ? raw : spec.defaultOn
  return (
    <ToggleRow
      testidPrefix={TESTID}
      configKey={spec.key}
      label={spec.label}
      helper={spec.helper}
      checked={on}
      onChange={(next) =>
        api.commit(spec.key, spec.path, next === spec.defaultOn ? undefined : next)
      }
      error={api.errorAt(spec.key)}
    />
  )
}

/**
 * Reasoning, the 2.x way: OFF is `variants: []` (opencode generates no
 * reasoning-effort variants for the model); ON deletes that empty list. A
 * non-empty list is the user's own variants — ON, and never touched here.
 */
function ReasoningRow({ api }: { api: ModelEntryApi }): React.JSX.Element {
  const variants = api.read(['variants'])
  const off = Array.isArray(variants) && variants.length === 0
  return (
    <ToggleRow
      testidPrefix={TESTID}
      configKey="variants"
      keyText="variants: [] = none"
      label="Reasoning variants"
      helper="Off writes an empty variant list, so opencode offers no reasoning efforts for this model; on lets it generate them from the provider package —"
      checked={!off}
      onChange={(next) => {
        if (next && off) api.commit('variants', ['variants'], undefined)
        if (!next && !off && variants === undefined) api.commit('variants', ['variants'], [])
      }}
      error={api.errorAt('variants')}
    />
  )
}

// ── Modalities (capabilities.input / .output) ──────────────────────────────

/** The modality chips. Exported for the guard test. */
export const MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'] as const
/**
 * opencode 2.x's reading of an ABSENT list (`Model.Capabilities.default()`):
 * input text+image, output text. Shown as the chip state, and a list that lands
 * back on exactly this deletes the key.
 */
export const DEFAULT_MODALITIES: Record<'input' | 'output', readonly string[]> = {
  input: ['text', 'image'],
  output: ['text']
}

function ModalityChips({
  api,
  direction
}: {
  api: ModelEntryApi
  direction: 'input' | 'output'
}): React.JSX.Element {
  const path: EntryPath = ['capabilities', direction]
  const raw = api.read(path)
  const fallback = DEFAULT_MODALITIES[direction]
  const selected = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string')
    : [...fallback]

  const toggle = (id: string): void => {
    const wanted = new Set(selected)
    if (wanted.has(id)) wanted.delete(id)
    else wanted.add(id)
    // Rebuilt in chip order so the file stays predictable.
    const next = MODALITIES.filter((m) => wanted.has(m))
    const isDefault = next.length === fallback.length && next.every((m, i) => m === fallback[i])
    api.commit('modalities', path, isDefault ? undefined : next)
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="w-10 shrink-0 text-[11px] text-text-secondary capitalize">{direction}</span>
      <div className="flex flex-wrap gap-1.5">
        {MODALITIES.map((id) => {
          const on = selected.includes(id)
          return (
            <button
              key={id}
              type="button"
              data-testid={`${TESTID}.modality`}
              data-id={`${direction}:${id}`}
              aria-pressed={on}
              onClick={() => toggle(id)}
              className={pillClass(on)}
            >
              {id}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Rows 8-9 · numeric grids ─────────────────────────────────────────────────

const COST_FIELDS = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cache.read', label: 'Cache read' },
  { key: 'cache.write', label: 'Cache write' }
]

const LIMIT_FIELDS = [
  { key: 'context', label: 'Context window' },
  { key: 'input', label: 'Max input' },
  { key: 'output', label: 'Max output' }
]

/**
 * A labelled grid of leaf number inputs. `basePath` is the block ('cost',
 * 'cost.context_over_200k', 'limit'); the testid's `data-id` is the path
 * RELATIVE to that block's row, so the long-context inputs read
 * `context_over_200k.input`.
 */
function LeafNumberGrid({
  api,
  rowKey,
  testid,
  basePath,
  fields,
  columns,
  placeholder,
  step
}: {
  api: ModelEntryApi
  rowKey: string
  testid: string
  basePath: EntryPath
  fields: { key: string; label: string }[]
  columns: string
  placeholder: string
  step?: number | 'any'
}): React.JSX.Element {
  return (
    <div className={`px-3 grid ${columns} gap-1.5`}>
      {fields.map((field) => {
        const leaf = [...basePath, ...field.key.split('.')]
        const id = pathId(leaf.slice(1))
        return (
          <label key={field.key} className="min-w-0 block">
            <span className="block text-[11px] text-text-secondary mb-0.5 truncate">
              {field.label}
            </span>
            <LeafNumberInput
              testid={testid}
              configKey={id}
              value={api.read(leaf)}
              placeholder={placeholder}
              step={step}
              width="w-full"
              onCommit={(v) => api.commit(rowKey, leaf, v)}
            />
          </label>
        )
      })}
    </div>
  )
}

// ── Row 10 · advanced raw leaves ─────────────────────────────────────────────

const ADVANCED_LEAVES = [
  {
    key: 'settings',
    label: 'Provider settings',
    helper: 'Merged into the provider package settings for this model (1.x `options`) —'
  },
  {
    key: 'body',
    label: 'Request body',
    helper: 'Merged into every request body, e.g. {"temperature":0.2} —'
  },
  {
    key: 'headers',
    label: 'Extra headers',
    helper: 'Merged into requests for this model only —'
  },
  {
    key: 'variants',
    label: 'Variants',
    helper: 'Per-variant overlays, e.g. [{"id":"high","settings":{"reasoningEffort":"high"}}] —'
  },
  {
    key: 'compatibility',
    label: 'Compatibility',
    helper: 'e.g. {"reasoningField":"reasoning_content"} for interleaved reasoning —'
  },
  {
    key: 'cost',
    label: 'Cost (raw)',
    helper:
      'The whole cost value; tiered pricing is a list with tier {"type":"context","size":200000} —'
  }
]

function AdvancedLeaf({
  api,
  leafKey,
  label,
  helper
}: {
  api: ModelEntryApi
  leafKey: string
  label: string
  helper: string
}): React.JSX.Element {
  const value = api.read([leafKey])
  return (
    <div data-testid={`${TESTID}.rawLeaf`} data-id={leafKey} className="px-3 pb-1.5">
      <div className="text-[11px] text-text-secondary leading-snug">{label}</div>
      <div className="mb-1 text-[12px] text-text-secondary leading-relaxed">
        {helper} <span className="font-mono text-text-muted/80">{leafKey}</span>
      </div>
      {/* Keyed on the committed value so a successful write (or a delete)
          reseeds the textarea instead of leaving stale text behind. */}
      <RawJsonField
        key={String(JSON.stringify(value))}
        fieldKey={leafKey}
        value={value}
        onChange={(v) => api.commit(leafKey, [leafKey], v)}
      />
    </div>
  )
}

// ── The editor ───────────────────────────────────────────────────────────────

/**
 * The rows. Rendered inside whichever frame `ModelCapabilityEditor` picked, so
 * the two modes cannot drift into different field sets.
 */
function CapabilityRows({ api }: { api: ModelEntryApi }): React.JSX.Element {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const tiered = Array.isArray(api.read(['cost']))

  return (
    <>
      {CAPABILITY_TOGGLES.map((spec) => (
        <CapabilityToggleRow key={spec.key} api={api} spec={spec} />
      ))}
      <ReasoningRow api={api} />

      <StackedRow
        testidPrefix={TESTID}
        configKey="modalities"
        label="Modalities"
        helper="Content types the model takes and returns; image or pdf input is what 1.x called attachments. Unset is text+image in, text out."
        keyText="capabilities.input / output"
        error={api.errorAt('modalities')}
      >
        <div className="px-3 space-y-1">
          <ModalityChips api={api} direction="input" />
          <ModalityChips api={api} direction="output" />
        </div>
      </StackedRow>

      <StackedRow
        testidPrefix={TESTID}
        configKey="cost"
        label="Pricing"
        helper={
          tiered
            ? 'Tiered pricing (a list): edit it under Advanced.'
            : '$ per 1M tokens; input and output are written together.'
        }
        error={api.errorAt('cost')}
      >
        {!tiered && (
          <LeafNumberGrid
            api={api}
            rowKey="cost"
            testid={`${TESTID}.cost`}
            basePath={['cost']}
            fields={COST_FIELDS}
            columns="grid-cols-4"
            placeholder="0"
            step="any"
          />
        )}
      </StackedRow>

      <SettingRow
        testid={`${TESTID}.gone`}
        dimmed
        label="Not in opencode 2.x"
        description="The 1.x temperature switch is gone: a fixed temperature goes in the request body (Advanced). Attachments are input modalities, interleaved reasoning is compatibility.reasoningField."
      />

      <StackedRow
        testidPrefix={TESTID}
        configKey="limit"
        label="Limits"
        helper="Tokens; each is its own leaf (unset is the provider catalog's value, or unknown)."
        error={api.errorAt('limit')}
      >
        <LeafNumberGrid
          api={api}
          rowKey="limit"
          testid={`${TESTID}.limit`}
          basePath={['limit']}
          fields={LIMIT_FIELDS}
          columns="grid-cols-3"
          placeholder="unset"
        />
      </StackedRow>

      <StackedRow
        testidPrefix={TESTID}
        configKey="advanced"
        label="Advanced"
        helper="Free-form JSON leaves."
        keyText="settings / body / headers / variants / compatibility / cost"
        error={
          // One shared slot: only one raw leaf can be in flight at a time.
          ADVANCED_LEAVES.map((leaf) => api.errorAt(leaf.key)).find(Boolean) ?? null
        }
      >
        <div className="px-3">
          <Disclosure
            testid={`${TESTID}.disclosure`}
            id="advanced"
            label={`${advancedOpen ? '▾' : '▸'} Show raw leaves`}
            open={advancedOpen}
            onToggle={() => setAdvancedOpen((o) => !o)}
          />
        </div>
        {advancedOpen && (
          <div className="mt-1 space-y-1">
            {ADVANCED_LEAVES.map((leaf) => (
              <AdvancedLeaf
                key={leaf.key}
                api={api}
                leafKey={leaf.key}
                label={leaf.label}
                helper={leaf.helper}
              />
            ))}
          </div>
        )}
      </StackedRow>
    </>
  )
}

/**
 * The per-model capability editor, in either of the two frames its hosts need.
 *
 * WITH `onClose` it is its own stacked dialog on the shared `DialogShell` — the
 * frame pi's model editor uses, and the one OpencodeProviderConfigModal opens it
 * in from a declared model's "Capabilities" action. WITHOUT `onClose` it renders
 * INLINE, inside the host's own scrolling body (how that dialog mounted it
 * before the restyle).
 *
 * Both frames render the SAME rows and the same `ModelCapabilityEditor` /
 * `${providerId}/${modelId}` testid pair, so nothing that writes to the file
 * depends on which frame is up.
 */
export function ModelCapabilityEditor({
  providerId,
  modelId,
  onClose,
  onRemove
}: {
  providerId: string
  modelId: string
  /** Present = render as a stacked dialog; absent = render inline. */
  onClose?: () => void
  /**
   * Dialog frame only: the destructive footer action. Removing a model means
   * rewriting the HOST's provider declaration, not patching this entry, so the
   * host owns both the removal and its confirm; the footer just offers it.
   */
  onRemove?: () => void
}): React.JSX.Element {
  const api = useModelEntry(providerId, modelId)

  const body =
    api.entry === null ? (
      <div className="text-[12px] text-text-secondary px-3 py-1">Loading capabilities…</div>
    ) : (
      <CapabilityRows api={api} />
    )

  if (onClose) {
    return (
      <DialogShell
        testid={TESTID}
        dataId={`${providerId}/${modelId}`}
        title={`${providerId} / ${modelId}`}
        subtitle="Capabilities in opencode's own config file. Unset fields use opencode's defaults."
        // Always opened from the provider dialog, which already holds z-[100].
        stacked
        onClose={onClose}
        footer={
          <>
            {onRemove ? (
              <button
                type="button"
                data-testid={`${TESTID}.remove`}
                onClick={onRemove}
                className="px-2 py-1 text-[11px] rounded text-text-muted/70 hover:text-red-400 hover:bg-bg-hover transition-colors"
              >
                Remove model
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              data-testid={`${TESTID}.done`}
              onClick={onClose}
              className="px-3 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
            >
              Done
            </button>
          </>
        }
      >
        {body}
      </DialogShell>
    )
  }

  return (
    <div
      data-testid={TESTID}
      data-id={`${providerId}/${modelId}`}
      className="rounded bg-bg-primary/30 py-1"
    >
      <div className="px-3 pb-0.5 text-[11px] uppercase tracking-wider text-text-secondary">
        Capabilities
      </div>
      {body}
    </div>
  )
}
