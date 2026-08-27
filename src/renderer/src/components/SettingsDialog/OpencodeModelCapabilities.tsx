/**
 * OpencodeModelCapabilities.tsx
 *
 * The per-model capability editor behind each model row's "▸ Capabilities"
 * disclosure in the opencode provider dialog (OpencodeProviderConfigModal,
 * settings-sections.tsx). It used to be the generic schema-driven form, which
 * labelled every field with its full raw path (`my-ollama.qwen3:27b.attachment`)
 * and nested modalities/cost behind raw fieldsets; this is the curated version,
 * in the same row language as the Configuration panes (OpencodeConfigPanes.tsx,
 * whose row primitives it reuses).
 *
 * WHAT IT WRITES. The model's entry lives in opencode's own config file at
 * `provider.<providerId>.models.<modelId>`. Every commit is a minimal LEAF diff
 * of that entry (diffToPatches → patchOpencodeNative), so the keys this editor
 * does not render — id, name, family, status, release_date, anything
 * hand-written — are never part of a patch and survive untouched. It composes
 * with the ADR-031 projection writer that owns id/name for the same reason.
 *
 * WHEN IT WRITES. Immediately, like the Configuration panes: a toggle or chip
 * click commits at once, number inputs commit on blur AND Enter, raw-JSON leaves
 * commit on blur. There is no Save button (the dialog's footer already promises
 * "Changes are saved as you type", and the model list needs a saved provider id
 * to target anyway).
 *
 * THREE RULES RUN THROUGH IT:
 *
 *  · ABSENT MEANS DEFAULT. A key whose absence already produces the wanted
 *    behaviour is deleted rather than written. The defaults are opencode's OWN
 *    (provider.ts's model parse), not the JSON schema's — the vendored schema
 *    carries no `default` keywords at all. `tool_call` is the one that bites:
 *    opencode reads an absent `tool_call` as TRUE, so a toggle that showed OFF
 *    for it could never write the `tool_call: false` a user opens this editor
 *    to set.
 *  · EMPTY PARENTS GO. When a delete leaves `cost` / `modalities` / `limit` with
 *    no keys at all, the block itself is deleted rather than written back as
 *    `{}`. A block still holding keys this editor doesn't render is kept.
 *  · REQUIRED FIELDS COME IN PAIRS. `cost` requires input+output, `limit`
 *    requires context+output, and the raw writer validates the whole resulting
 *    config with ajv before writing. A block can therefore never be half-filled:
 *    creating one seeds its missing partner with 0 (exactly what opencode
 *    computes for an absent block), and clearing either half removes the block.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { RawJsonField } from './OpencodeSchemaForm'
import { StackedRow, ToggleRow, LeafNumberInput } from './OpencodeConfigPanes'
import { diffToPatches, isPlainObject } from '../../../../shared/opencode-config-diff'
import type { RawConfigPatch } from '../../../../shared/types'

const TESTID = 'ModelCapabilityEditor'

/** A path INSIDE the model entry (the `provider…models.<id>` prefix is added at
 *  patch time), e.g. `['cost', 'context_over_200k', 'input']`. */
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
 * Fields the v1.18.23 schema marks `required` inside a model entry, by the
 * dotted path of the block that requires them
 * ($defs.ProviderConfig.properties.models.additionalProperties).
 *
 * This is not decoration: `patchOpencodeNativeRaw` validates the ENTIRE
 * resulting config with ajv before writing, and its schema preparation strips
 * only `additionalProperties: false` — `required` survives. So `cost:
 * { input: 3 }` is rejected outright, and a naive per-field commit could never
 * create a pricing block at all. opencode itself reads an absent cost/limit
 * field as 0 (provider.ts, `parsedModel.cost` / `.limit`), so seeding the
 * missing partner with 0 changes no behaviour.
 *
 * Exported for the guard test: this table restates the schema, and a bump that
 * moved it would make the editor either destructive (removing a block for a
 * field no longer required) or unable to write at all (missing a new one).
 */
export const REQUIRED_FIELDS: Record<string, string[]> = {
  cost: ['input', 'output'],
  'cost.context_over_200k': ['input', 'output'],
  limit: ['context', 'output']
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
        const found = readAt(config, ['provider', providerId, 'models', modelId])
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
        'provider',
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

// ── Row 2-6 · boolean capabilities ───────────────────────────────────────────

interface CapabilityToggle {
  key: string
  label: string
  helper: string
  /** What opencode assumes when the key is ABSENT. */
  defaultOn: boolean
  /**
   * Always write an explicit boolean instead of deleting on return-to-default.
   * Only `interleaved` needs it: its absent value is model-DEPENDENT (opencode
   * infers `{ field: "reasoning_content" }` for an openai-compatible model whose
   * id contains "deepseek", `false` otherwise), so deleting the key would not
   * reliably mean "off" and `false` has to be recorded.
   */
  explicit?: boolean
}

/**
 * The five boolean capability keys and the value opencode gives them when they
 * are absent — from `Provider.parseModel` in the vendored source
 * (vendor/opencode-src, packages/opencode/src/provider/provider.ts): temperature
 * / reasoning / attachment default false, `tool_call` defaults TRUE. The JSON
 * schema states none of this (it has no `default` keywords anywhere), which is
 * why the values are pinned here and exported for a guard test.
 */
export const CAPABILITY_TOGGLES: CapabilityToggle[] = [
  {
    key: 'attachment',
    label: 'File attachments',
    helper: 'Model accepts images and files in a message —',
    defaultOn: false
  },
  {
    key: 'reasoning',
    label: 'Reasoning',
    helper: 'Model emits reasoning content —',
    defaultOn: false
  },
  {
    key: 'temperature',
    label: 'Temperature control',
    helper: 'Model honours a temperature setting —',
    defaultOn: false
  },
  {
    key: 'tool_call',
    label: 'Tool calling',
    helper: 'Model can call tools; opencode assumes it can when unset —',
    defaultOn: true
  },
  {
    key: 'interleaved',
    label: 'Interleaved reasoning',
    helper: 'Reasoning arrives interleaved with tool calls —',
    defaultOn: false,
    explicit: true
  }
]

function CapabilityToggleRow({
  api,
  spec
}: {
  api: ModelEntryApi
  spec: CapabilityToggle
}): React.JSX.Element {
  const raw = api.read([spec.key])
  // `interleaved` may hold a string or an object; anything that is not literally
  // `false` is the capability being ON.
  const on = raw === undefined ? spec.defaultOn : raw !== false
  return (
    <ToggleRow
      testidPrefix={TESTID}
      configKey={spec.key}
      label={spec.label}
      helper={spec.helper}
      checked={on}
      onChange={(next) =>
        api.commit(
          spec.key,
          [spec.key],
          !spec.explicit && next === spec.defaultOn ? undefined : next
        )
      }
      error={api.errorAt(spec.key)}
    />
  )
}

// ── Row 7 · modalities ───────────────────────────────────────────────────────

/** `modalities.input` / `.output` item enum, v1.18.23. Exported for the guard test. */
export const MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'] as const
/**
 * opencode's reading of an ABSENT modality list: text on, everything else off
 * (provider.ts `capabilities.input` / `.output`). Shown as the chip state so a
 * user adding `image` gets `["text","image"]` rather than silently dropping text
 * support, and a list that lands back on exactly this deletes the key.
 */
const DEFAULT_MODALITIES: string[] = ['text']

function ModalityChips({
  api,
  direction
}: {
  api: ModelEntryApi
  direction: 'input' | 'output'
}): React.JSX.Element {
  const path: EntryPath = ['modalities', direction]
  const raw = api.read(path)
  const selected = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string')
    : DEFAULT_MODALITIES

  const toggle = (id: string): void => {
    const wanted = new Set(selected)
    if (wanted.has(id)) wanted.delete(id)
    else wanted.add(id)
    // Rebuilt in schema order (and dropping anything outside the enum, which
    // ajv would reject anyway) so the file stays predictable.
    const next = MODALITIES.filter((m) => wanted.has(m))
    const isDefault =
      next.length === DEFAULT_MODALITIES.length && next.every((m, i) => m === DEFAULT_MODALITIES[i])
    api.commit('modalities', path, isDefault ? undefined : next)
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="w-10 shrink-0 text-[10px] text-text-muted/70 capitalize">{direction}</span>
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
    </div>
  )
}

// ── Rows 8-9 · numeric grids ─────────────────────────────────────────────────

const COST_FIELDS = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cache_read', label: 'Cache read' },
  { key: 'cache_write', label: 'Cache write' }
]

const LIMIT_FIELDS = [
  { key: 'context', label: 'Context window' },
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
        const leaf = [...basePath, field.key]
        const id = pathId(leaf.slice(1))
        return (
          <label key={field.key} className="min-w-0 block">
            <span className="block text-[10px] text-text-muted/70 mb-0.5 truncate">
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
    key: 'options',
    label: 'Provider options',
    helper: 'Passed to the AI SDK model on every call —'
  },
  {
    key: 'headers',
    label: 'Extra headers',
    helper: 'Merged into requests for this model only —'
  },
  {
    key: 'variants',
    label: 'Variants',
    helper: 'Per-variant overrides, e.g. {"high":{"disabled":true}} —'
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
      <div className="mb-1 text-[10px] text-text-muted/60 leading-relaxed">
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

function Disclosure({
  id,
  label,
  open,
  onToggle
}: {
  id: string
  label: string
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={`${TESTID}.disclosure`}
      data-id={id}
      aria-expanded={open}
      onClick={onToggle}
      className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
    >
      {open ? '▾' : '▸'} {label}
    </button>
  )
}

// ── The editor ───────────────────────────────────────────────────────────────

export function ModelCapabilityEditor({
  providerId,
  modelId
}: {
  providerId: string
  modelId: string
}): React.JSX.Element {
  const api = useModelEntry(providerId, modelId)
  const [longContextOpen, setLongContextOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  if (api.entry === null) {
    return <div className="text-[10px] text-text-muted/60 px-1">Loading capabilities…</div>
  }

  return (
    <div
      data-testid={TESTID}
      data-id={`${providerId}/${modelId}`}
      className="rounded bg-bg-primary/30 py-1"
    >
      <div className="px-3 pb-0.5 text-[11px] uppercase tracking-wider text-text-muted/60">
        Capabilities
      </div>

      {CAPABILITY_TOGGLES.map((spec) => (
        <CapabilityToggleRow key={spec.key} api={api} spec={spec} />
      ))}

      <StackedRow
        testidPrefix={TESTID}
        configKey="modalities"
        label="Modalities"
        helper="Content types the model takes and returns —"
        keyText="modalities.input / output"
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
        helper="$ per 1M tokens. Input and output are written together —"
        error={api.errorAt('cost')}
      >
        <div className="space-y-1">
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
          <div className="px-3">
            <Disclosure
              id="context_over_200k"
              label="Long-context pricing (>200k)"
              open={longContextOpen}
              onToggle={() => setLongContextOpen((o) => !o)}
            />
          </div>
          {longContextOpen && (
            <LeafNumberGrid
              api={api}
              rowKey="cost"
              testid={`${TESTID}.cost`}
              basePath={['cost', 'context_over_200k']}
              fields={COST_FIELDS}
              columns="grid-cols-4"
              placeholder="0"
              step="any"
            />
          )}
        </div>
      </StackedRow>

      <StackedRow
        testidPrefix={TESTID}
        configKey="limit"
        label="Limits"
        helper="Tokens. Context window and max output are written together —"
        error={api.errorAt('limit')}
      >
        <LeafNumberGrid
          api={api}
          rowKey="limit"
          testid={`${TESTID}.limit`}
          basePath={['limit']}
          fields={LIMIT_FIELDS}
          columns="grid-cols-2"
          placeholder="unset"
        />
      </StackedRow>

      <StackedRow
        testidPrefix={TESTID}
        configKey="advanced"
        label="Advanced"
        helper="Free-form JSON leaves —"
        keyText="options / headers / variants"
        error={
          // One shared slot: only one raw leaf can be in flight at a time.
          ADVANCED_LEAVES.map((leaf) => api.errorAt(leaf.key)).find(Boolean) ?? null
        }
      >
        <div className="px-3">
          <Disclosure
            id="advanced"
            label="Show raw leaves"
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
    </div>
  )
}
