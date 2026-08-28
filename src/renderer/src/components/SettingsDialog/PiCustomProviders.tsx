/**
 * PiCustomProviders.tsx
 *
 * The models.json half of Settings › pi › Providers: the CUSTOM PROVIDERS and
 * BUILT-IN OVERRIDES blocks that hang under PiVendors' authentication content,
 * plus the provider dialog and the per-model capability editor they open.
 *
 * This pane is where the shared provider-editor LOOK was designed; the frame
 * primitives it uses — dialog shell, block header, row card, pill row, create
 * form, disclosure — now live in provider-editor-shell.tsx so the opencode
 * editors wear the same frame. What stays here is pi's own semantics.
 *
 * It edits pi's OWN model catalog (`~/.pi/agent/models.json`,
 * vendor/pi-cli/docs/models.md) through the leaf-patch IPC pair
 * (`readPiModelsRaw` / `patchPiModels`), the models twin of the settings pair
 * the Configuration panes use. Conventions are theirs (PiConfigPanes.tsx,
 * OpencodeModelCapabilities.tsx), and they are what the tests pin:
 *
 *  · IMMEDIATE SAVES. No Save button anywhere: a toggle, segment or button
 *    commits at once; number and text inputs commit on blur AND Enter. Each
 *    commit is ONE leaf patch, and the file is re-read afterwards.
 *  · ABSENT MEANS DEFAULT. A key whose absence already gives the wanted
 *    behaviour is DELETED rather than written with its default value —
 *    `authHeader`, the two `compat` flags, image `input`, every cost rate.
 *  · LEAF PATCHES ONLY. Nothing writes a whole provider or model object except
 *    CREATION. models.json is hand-written by many users and carries fields this
 *    editor does not model — `oauth` (pi's dynamic Radius provider type),
 *    per-model `api`, `compat` keys beyond the two curated flags — and a
 *    whole-object write would erase them. They are preserved by never being part
 *    of a patch, and deliberately not rendered.
 *
 * TWO THINGS models.json HAS THAT settings.json DOES NOT:
 *
 *  · A SECOND WRITER. `shared-providers/PiSharedProviderAdapter.ts` projects
 *    every enabled custom shared provider into a `providers.<id>` entry and
 *    rewrites the file on each sync. `readPiModelsRaw` reports those ids
 *    (`managedProviderIds`); their rows render locked and open read-only, so the
 *    UI says WHY before the writer's refusal could turn into a failed save.
 *  · AN ARRAY. `models` is a list, not a record. Add and remove therefore go
 *    through INDEX leaf patches (`['providers',id,'models',<idx>]`), verified
 *    end-to-end through the real writer in pi-models-raw.test.ts: an index equal
 *    to the length appends, a delete splices rather than leaving a null hole, and
 *    an out-of-range delete is a no-op. Index patches are also what preserves
 *    comments INSIDE the array — a whole-array rewrite loses them (pinned by a
 *    test), which is why add/remove are not done that way.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { RawJsonField, inputClass } from './OpencodeSchemaForm'
import {
  LeafRow,
  StackedRow,
  ToggleRow,
  LeafNumberInput,
  LeafTextInput
} from './OpencodeConfigPanes'
import {
  AddForm,
  BlockHeader,
  DialogShell,
  Disclosure,
  EntityRowCard,
  SegmentPills
} from './provider-editor-shell'
import { ConfirmModal } from '../shared/ConfirmModal'
import { deepEqual, isPlainObject } from '../../../../shared/opencode-config-diff'
import type { RawConfigPatch } from '../../../../shared/types'

/** Testid namespaces (ADR-027 tier 2) for the pane, the dialog and the editor. */
const PANE = 'PiCustomProviders'
const DIALOG = 'PiProviderDialog'
const EDITOR = 'PiModelEditor'

// ── Leaf read/write plumbing ─────────────────────────────────────────────────

type LeafPath = (string | number)[]

/** Stable string form of a path — keys inline errors, testids and labels. */
const pathId = (path: LeafPath): string => path.join('.')

/**
 * Walk a path through objects AND arrays. The settings twin's reader stops at
 * anything that is not a plain object; this one has to index `models[2]`.
 */
function readLeaf(root: unknown, path: LeafPath): unknown {
  let cur: unknown = root
  for (const seg of path) {
    if (Array.isArray(cur)) {
      const idx = typeof seg === 'number' ? seg : Number(seg)
      if (!Number.isInteger(idx) || idx < 0) return undefined
      cur = cur[idx]
    } else if (isPlainObject(cur)) {
      cur = cur[String(seg)]
    } else {
      return undefined
    }
  }
  return cur
}

interface PiModelsLeaf {
  /** null until the first read resolves — the pane renders Loading… meanwhile. */
  config: Record<string, unknown> | null
  /** Resolved models.json path (shown in the pane footer). */
  filePath: string
  /** `providers.<id>` keys the shared-provider projection currently owns. */
  managedIds: ReadonlySet<string>
  read: (path: LeafPath) => unknown
  /**
   * Commit ONE leaf; `undefined` deletes. REJECTS on a writer refusal (the
   * managed-entry and built-in-collision guards) so a creation form can surface
   * it next to the control that caused it. A no-op when the value already
   * matches, so a blur without an edit never touches the file.
   */
  patch: (path: LeafPath, value: unknown) => Promise<void>
  /** `patch` with the rejection swallowed — it is already in `errorAt`. */
  commit: (path: LeafPath, value: unknown) => void
  errorAt: (path: LeafPath) => string | null
  reload: () => void
}

function usePiModelsLeaf(): PiModelsLeaf {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [filePath, setFilePath] = useState('')
  const [managedIds, setManagedIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [errors, setErrors] = useState<Record<string, string>>({})

  const reload = useCallback((): void => {
    window.api
      .readPiModelsRaw()
      .then(({ config: next, path, managedProviderIds }) => {
        setConfig(next)
        setFilePath(path)
        setManagedIds(new Set(managedProviderIds))
      })
      .catch(() => setConfig({}))
  }, [])

  useEffect(() => reload(), [reload])

  const read = useCallback((path: LeafPath) => readLeaf(config, path), [config])

  const patch = useCallback(
    async (path: LeafPath, value: unknown): Promise<void> => {
      if (deepEqual(readLeaf(config, path), value)) return
      const id = pathId(path)
      const one: RawConfigPatch = value === undefined ? { path } : { path, value }
      try {
        await window.api.patchPiModels([one])
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setErrors((prev) => ({ ...prev, [id]: message }))
        throw e instanceof Error ? e : new Error(message)
      }
      setErrors((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      reload()
      // models.json IS the model catalog, so a provider edit the picker cannot
      // see looks broken. The server already dropped its discovery cache; this
      // is the renderer half, mirroring the allowlist save.
      if (path[0] === 'providers') useSessionStore.getState().reloadModels()
    },
    [config, reload]
  )

  const commit = useCallback(
    (path: LeafPath, value: unknown): void => {
      void patch(path, value).catch(() => {
        /* recorded in `errors`; surfaced by the row that owns the path */
      })
    },
    [patch]
  )

  const errorAt = useCallback((path: LeafPath) => errors[pathId(path)] ?? null, [errors])

  return { config, filePath, managedIds, read, patch, commit, errorAt, reload }
}

// ── Entry partition ──────────────────────────────────────────────────────────

interface CustomProviderRow {
  id: string
  entry: Record<string, unknown>
  managed: boolean
}

interface OverrideRow {
  providerId: string
  modelId: string
  entry: Record<string, unknown>
}

/**
 * Split `providers` into the pane's two blocks by ENTRY SHAPE — never by a list
 * of pi's built-in vendor ids, which would rot on every pi release and is a
 * main-process concern anyway (PI_NATIVE_VENDOR_IDS backs the writer's guard).
 *
 * An entry declaring `baseUrl` or `models` is a provider definition, whether its
 * id is custom or a built-in being routed through a proxy (models.md "Overriding
 * Built-in Providers"). An entry declaring NEITHER is a pure per-model override
 * carrier, and contributes one row per `modelOverrides` key.
 *
 * Consequences, both deliberate: an entry with a `baseUrl` AND `modelOverrides`
 * shows only as a provider row (its overrides are preserved, unrendered, like
 * every other unmodeled field), and an entry with neither shape — say a
 * `headers`-only proxy tweak — contributes no row at all. Neither is ever
 * written to by this pane, so neither can be damaged by not being shown.
 */
export function partitionPiProviders(
  config: Record<string, unknown> | null,
  managedIds: ReadonlySet<string>
): { custom: CustomProviderRow[]; overrides: OverrideRow[] } {
  const providers = isPlainObject(config?.providers) ? config.providers : {}
  const custom: CustomProviderRow[] = []
  const overrides: OverrideRow[] = []
  for (const [id, raw] of Object.entries(providers)) {
    if (!isPlainObject(raw)) continue
    if (raw.baseUrl !== undefined || raw.models !== undefined) {
      custom.push({ id, entry: raw, managed: managedIds.has(id) })
      continue
    }
    const modelOverrides = isPlainObject(raw.modelOverrides) ? raw.modelOverrides : {}
    for (const [modelId, override] of Object.entries(modelOverrides)) {
      overrides.push({
        providerId: id,
        modelId,
        entry: isPlainObject(override) ? override : {}
      })
    }
  }
  return { custom, overrides }
}

// ── Summaries ────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** pi's own defaults for the fields the chip line reports (models.md). */
const DEFAULT_CONTEXT_WINDOW = 128_000

function modelSummary(entry: Record<string, unknown>): string {
  const input = Array.isArray(entry.input)
    ? entry.input.filter((v): v is string => typeof v === 'string')
    : ['text']
  const parts = [input.includes('image') ? 'text + image' : 'text']
  if (entry.reasoning === true) parts.push('reasoning')
  const ctx = typeof entry.contextWindow === 'number' ? entry.contextWindow : DEFAULT_CONTEXT_WINDOW
  parts.push(`${formatTokens(ctx)} ctx`)
  const cost = isPlainObject(entry.cost) ? entry.cost : {}
  if (Object.values(cost).every((v) => v === 0)) parts.push('free')
  return parts.join(' · ')
}

/** One line naming what an override actually changes. */
function overrideSummary(entry: Record<string, unknown>): string {
  const keys = Object.keys(entry)
  if (keys.length === 0) return 'no fields overridden yet'
  return keys
    .map((key) => {
      const value = entry[key]
      if (typeof value === 'number') return `${key} → ${value.toLocaleString('en-US')}`
      if (typeof value === 'string' || typeof value === 'boolean')
        return `${key} → ${String(value)}`
      return key
    })
    .join(' · ')
}

// ── Pi-specific bits (the frame primitives live in provider-editor-shell) ────

const API_OPTIONS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
] as const

/** The read-only body a managed (projected) entry gets instead of the form. */
function ManagedNotice({
  testidPrefix,
  name
}: {
  testidPrefix: string
  name: string
}): React.JSX.Element {
  return (
    <div
      data-testid={`${testidPrefix}.managed`}
      className="px-4 py-3 space-y-1.5 text-[11px] leading-relaxed"
    >
      <div className="text-text-primary font-medium">{name} is managed by a shared provider.</div>
      <div className="text-text-muted/70">
        ClaudeUI compiles this entry into models.json on every sync, so an edit made here would be
        reverted — and would make the next shared-provider save refuse as &ldquo;changed outside
        ClaudeUI&rdquo;. Change it where it is owned.
      </div>
      <button
        data-testid={`${testidPrefix}.openShared`}
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent('open-settings', {
              detail: { scope: 'common', section: 'shared-providers' }
            })
          )
        }
        className="text-accent hover:text-accent/80 transition-colors"
      >
        Open Providers &amp; models
      </button>
    </div>
  )
}

// ── Model / override capability editor ───────────────────────────────────────

const COST_FIELDS = [
  { key: 'input', label: 'input' },
  { key: 'output', label: 'output' },
  { key: 'cacheRead', label: 'cache rd' },
  { key: 'cacheWrite', label: 'cache wr' }
]

/**
 * The advanced free-form leaves. `headers` is per-MODEL only inside
 * `modelOverrides` (models.md lists it there and not under Model Configuration),
 * so the override variant gets one more row than the model variant.
 */
const ADVANCED_LEAVES = [
  {
    key: 'samplingParams',
    label: 'Sampling parameters',
    helper: 'Merged verbatim into every request body; keys beat pi’s own —'
  },
  {
    key: 'thinkingLevelMap',
    label: 'Thinking level map',
    helper: 'pi levels → provider values; null marks a level unsupported —'
  },
  {
    key: 'compat',
    label: 'Compatibility overrides',
    helper: 'Merged over the provider’s compat block —'
  }
]

const OVERRIDE_ONLY_LEAVES = [
  {
    key: 'headers',
    label: 'Extra headers',
    helper: 'Request headers for this model only —'
  }
]

function AdvancedLeaf({
  api,
  scope,
  leafKey,
  label,
  helper
}: {
  api: PiModelsLeaf
  scope: LeafPath
  leafKey: string
  label: string
  helper: string
}): React.JSX.Element {
  const path = [...scope, leafKey]
  const value = api.read(path)
  return (
    <div data-testid={`${EDITOR}.rawLeaf`} data-id={leafKey} className="px-3 pb-1.5">
      <div className="text-[11px] text-text-secondary leading-snug">{label}</div>
      <div className="mb-1 text-[10px] text-text-muted/60 leading-relaxed">
        {helper} <span className="font-mono text-text-muted/80">{leafKey}</span>
      </div>
      {/* Keyed on the committed value so a successful write (or a delete)
          reseeds the textarea instead of leaving stale text behind. */}
      <RawJsonField
        key={String(JSON.stringify(value))}
        fieldKey={pathId(path)}
        value={value}
        onChange={(v) => api.commit(path, v)}
      />
      {api.errorAt(path) && (
        <div
          data-testid={`${EDITOR}.error`}
          data-id={leafKey}
          className="text-[11px] text-red-400 mt-1"
        >
          {api.errorAt(path)}
        </div>
      )}
    </div>
  )
}

/**
 * Delete a leaf, collapsing its BLOCK when that leaf was the last key in it.
 * The writer deliberately leaves an emptied parent alone (whether `cost: {}`
 * should survive is the pane's call, not the file writer's), so the collapse
 * lives here. Every remaining key counts — including ones this editor does not
 * render, which is what keeps a hand-written `cost.tiers` from being swept away
 * by clearing the last rate.
 */
function deleteWithCollapse(api: PiModelsLeaf, blockPath: LeafPath, leafKey: string): void {
  const block = api.read(blockPath)
  const siblings = isPlainObject(block) ? Object.keys(block).filter((k) => k !== leafKey) : []
  if (siblings.length === 0) api.commit(blockPath, undefined)
  else api.commit([...blockPath, leafKey], undefined)
}

/**
 * The per-model capability editor, scoped to ONE entry path: a provider's
 * `models[<idx>]` or a built-in's `modelOverrides.<modelId>`. Both accept the
 * same field set (models.md's Model Configuration table and its `modelOverrides`
 * subset); `variant` only decides whether `headers` is offered and what the
 * destructive button is called.
 *
 * A model is addressed by INDEX. Nothing else writes to an unmanaged provider's
 * array while the dialog is open (managed entries never open this editor), so
 * the index stays valid; removing a model closes the editor rather than letting
 * a stale index point at the next element.
 */
export function PiModelEditor({
  api,
  scope,
  title,
  variant,
  onRemoved,
  onClose
}: {
  api: PiModelsLeaf
  scope: LeafPath
  title: string
  variant: 'model' | 'override'
  onRemoved: () => void
  onClose: () => void
}): React.JSX.Element {
  const [tiersOpen, setTiersOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const costPath = [...scope, 'cost']
  const tiersPath = [...costPath, 'tiers']
  const rawTiers = api.read(tiersPath)
  const tiers = Array.isArray(rawTiers) ? rawTiers : []
  // Index 0 is always editable so the FIRST tier can be created by committing a
  // field — no seeded threshold, which would either be a made-up number or a
  // zero-threshold zero-rate tier that silently prices every request at 0.
  const tierSlots = Math.max(tiers.length, 1)

  const inputPath = [...scope, 'input']
  const inputValue = api.read(inputPath)
  const imageOn = Array.isArray(inputValue) && inputValue.includes('image')

  const removeTier = (idx: number): void => {
    // The last tier takes the whole `tiers` key with it (the writer leaves an
    // empty array behind otherwise), and an emptied `cost` collapses with it.
    if (tiers.length <= 1) deleteWithCollapse(api, costPath, 'tiers')
    else api.commit([...tiersPath, idx], undefined)
  }

  const advanced =
    variant === 'override' ? [...ADVANCED_LEAVES, ...OVERRIDE_ONLY_LEAVES] : ADVANCED_LEAVES

  return (
    <>
      <DialogShell
        testid={EDITOR}
        dataId={pathId(scope)}
        title={title}
        subtitle={
          variant === 'override'
            ? 'Per-model override on a built-in provider. Unset fields keep pi’s own values.'
            : 'Capabilities for this custom model. Unset fields use pi’s documented defaults.'
        }
        stacked={variant === 'model'}
        onClose={onClose}
        footer={
          <>
            <button
              type="button"
              data-testid={`${EDITOR}.remove`}
              onClick={() => setConfirmRemove(true)}
              className="px-2 py-1 text-[11px] rounded text-text-muted/70 hover:text-red-400 hover:bg-bg-hover transition-colors"
            >
              {variant === 'override' ? 'Remove override' : 'Remove model'}
            </button>
            <button
              type="button"
              data-testid={`${EDITOR}.done`}
              onClick={onClose}
              className="px-3 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
            >
              Done
            </button>
          </>
        }
      >
        <LeafRow
          testidPrefix={EDITOR}
          configKey="name"
          label="Display name"
          helper="Used for --model matching and secondary detail text; the id is still what pi shows —"
          error={api.errorAt([...scope, 'name'])}
        >
          <LeafTextInput
            testid={`${EDITOR}.text`}
            configKey="name"
            value={api.read([...scope, 'name'])}
            placeholder="same as id"
            onCommit={(v) => api.commit([...scope, 'name'], v)}
          />
        </LeafRow>

        <ToggleRow
          testidPrefix={EDITOR}
          configKey="reasoning"
          label="Extended thinking"
          helper="Model supports reasoning —"
          checked={api.read([...scope, 'reasoning']) === true}
          onChange={(next) => api.commit([...scope, 'reasoning'], next ? true : undefined)}
          error={api.errorAt([...scope, 'reasoning'])}
        />

        <ToggleRow
          testidPrefix={EDITOR}
          configKey="input"
          label="Image input"
          helper="Off = text only, which is what pi assumes when the key is absent —"
          checked={imageOn}
          onChange={(next) => api.commit(inputPath, next ? ['text', 'image'] : undefined)}
          error={api.errorAt(inputPath)}
        />

        <LeafRow
          testidPrefix={EDITOR}
          configKey="contextWindow"
          label="Context window"
          helper="Tokens; pi assumes 128000 when unset —"
          error={api.errorAt([...scope, 'contextWindow'])}
        >
          <LeafNumberInput
            testid={`${EDITOR}.number`}
            configKey="contextWindow"
            value={api.read([...scope, 'contextWindow'])}
            placeholder="128000"
            onCommit={(v) => api.commit([...scope, 'contextWindow'], v)}
          />
        </LeafRow>

        <LeafRow
          testidPrefix={EDITOR}
          configKey="maxTokens"
          label="Max output tokens"
          helper="pi assumes 16384 when unset —"
          error={api.errorAt([...scope, 'maxTokens'])}
        >
          <LeafNumberInput
            testid={`${EDITOR}.number`}
            configKey="maxTokens"
            value={api.read([...scope, 'maxTokens'])}
            placeholder="16384"
            onCommit={(v) => api.commit([...scope, 'maxTokens'], v)}
          />
        </LeafRow>

        <StackedRow
          testidPrefix={EDITOR}
          configKey="cost"
          label="Pricing"
          helper="$ per million tokens; every rate absent = free, which is what a local server wants —"
          error={
            // One shared slot: only one price field can be in flight at a time,
            // and clearing the last one reports against the block it deleted.
            COST_FIELDS.map((f) => api.errorAt([...costPath, f.key])).find(Boolean) ??
            api.errorAt(costPath)
          }
        >
          <div className="px-3 grid grid-cols-4 gap-1.5">
            {COST_FIELDS.map((field) => (
              <label key={field.key} className="min-w-0 block">
                <span className="block text-[10px] text-text-muted/70 mb-0.5 truncate">
                  {field.label}
                </span>
                <LeafNumberInput
                  testid={`${EDITOR}.cost`}
                  configKey={field.key}
                  value={api.read([...costPath, field.key])}
                  placeholder="0"
                  step="any"
                  width="w-full"
                  onCommit={(v) =>
                    v === undefined
                      ? deleteWithCollapse(api, costPath, field.key)
                      : api.commit([...costPath, field.key], v)
                  }
                />
              </label>
            ))}
          </div>
          <div className="px-3 mt-1">
            <Disclosure
              testid={`${EDITOR}.tierDisclosure`}
              id="tiers"
              label={
                tiers.length === 0
                  ? '+ Add tier'
                  : `${tiersOpen ? '▾' : '▸'} Long-context pricing (${tiers.length} tier${tiers.length === 1 ? '' : 's'})`
              }
              open={tiersOpen}
              onToggle={() => setTiersOpen((o) => !o)}
            />
            <div className="mt-0.5 text-[10px] text-text-muted/60 leading-relaxed">
              Alternate rates for the whole request once input exceeds a threshold.{' '}
              <span className="font-mono text-text-muted/80">cost.tiers</span>
            </div>
          </div>
          {tiersOpen &&
            Array.from({ length: tierSlots }, (_, idx) => (
              <div
                key={idx}
                data-testid={`${EDITOR}.tier`}
                data-id={String(idx)}
                className="px-3 mt-1.5 pt-1.5 border-t border-border/20"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-[10px] text-text-muted/70">Tier {idx + 1}</span>
                  {idx < tiers.length && (
                    <button
                      type="button"
                      data-testid={`${EDITOR}.removeTier`}
                      data-id={String(idx)}
                      onClick={() => removeTier(idx)}
                      className="text-[10px] text-text-muted/60 hover:text-red-400 transition-colors"
                    >
                      Remove tier
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  <label className="min-w-0 block">
                    <span className="block text-[10px] text-text-muted/70 mb-0.5 truncate">
                      above
                    </span>
                    <LeafNumberInput
                      testid={`${EDITOR}.tierNumber`}
                      configKey={`${idx}.inputTokensAbove`}
                      value={api.read([...tiersPath, idx, 'inputTokensAbove'])}
                      placeholder="272000"
                      width="w-full"
                      onCommit={(v) => api.commit([...tiersPath, idx, 'inputTokensAbove'], v)}
                    />
                  </label>
                  {COST_FIELDS.map((field) => (
                    <label key={field.key} className="min-w-0 block">
                      <span className="block text-[10px] text-text-muted/70 mb-0.5 truncate">
                        {field.label}
                      </span>
                      <LeafNumberInput
                        testid={`${EDITOR}.tierNumber`}
                        configKey={`${idx}.${field.key}`}
                        value={api.read([...tiersPath, idx, field.key])}
                        placeholder="0"
                        step="any"
                        width="w-full"
                        onCommit={(v) => api.commit([...tiersPath, idx, field.key], v)}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
        </StackedRow>

        <StackedRow
          testidPrefix={EDITOR}
          configKey="advanced"
          label="Advanced"
          helper="Free-form JSON leaves —"
          keyText={advanced.map((leaf) => leaf.key).join(' / ')}
          error={null}
        >
          <div className="px-3">
            <Disclosure
              testid={`${EDITOR}.advancedDisclosure`}
              id="advanced"
              label={`${advancedOpen ? '▾' : '▸'} Show raw leaves`}
              open={advancedOpen}
              onToggle={() => setAdvancedOpen((o) => !o)}
            />
          </div>
          {advancedOpen && (
            <div className="mt-1 space-y-1">
              {advanced.map((leaf) => (
                <AdvancedLeaf
                  key={leaf.key}
                  api={api}
                  scope={scope}
                  leafKey={leaf.key}
                  label={leaf.label}
                  helper={leaf.helper}
                />
              ))}
            </div>
          )}
        </StackedRow>
      </DialogShell>

      {confirmRemove && (
        <ConfirmModal
          testId={`${EDITOR}.confirmRemove`}
          stackedAbove
          title={variant === 'override' ? 'Remove override?' : 'Remove model?'}
          body={
            variant === 'override'
              ? 'The built-in model goes back to pi’s own metadata. models.json keeps everything else.'
              : 'The model disappears from pi’s catalog and from ClaudeUI’s picker. Other models on this provider are untouched.'
          }
          detail={pathId(scope)}
          confirmLabel="Remove"
          onConfirm={async () => {
            await api.patch(scope, undefined)
            onRemoved()
          }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </>
  )
}

// ── Provider dialog ──────────────────────────────────────────────────────────

/** The two OpenAI-compat quirks models.md tells users to reach for first. */
const CURATED_COMPAT_FLAGS = [
  {
    key: 'supportsDeveloperRole',
    label: 'developer role',
    helper: 'Off sends the system prompt as a system message instead of a developer one —'
  },
  {
    key: 'supportsReasoningEffort',
    label: 'reasoning_effort',
    helper: 'Off stops pi sending the reasoning_effort parameter —'
  }
]

/**
 * One custom provider entry. Fields follow models.md's Provider Configuration
 * table in the mockup's order; everything else in the entry (`oauth`, a stray
 * `modelOverrides`, anything hand-written) is left alone because no patch here
 * ever names it.
 *
 * COMPAT is deliberately BOTH curated and raw. The two toggles patch their own
 * leaf (`compat.<flag>`), so flipping one can never disturb a sibling compat
 * key; the raw field edits the WHOLE compat object and is seeded from the
 * committed value, so a raw save carries the curated keys along rather than
 * dropping them. The alternative — hiding the two keys from the raw field and
 * merging them back on commit — silently reinstates keys the user just deleted
 * from the text in front of them, and makes the two flags unremovable by hand.
 * The raw field is keyed on the committed value, so a toggle re-seeds it.
 */
function PiProviderDialog({
  api,
  providerId,
  managed,
  onClose
}: {
  api: PiModelsLeaf
  providerId: string
  managed: boolean
  onClose: () => void
}): React.JSX.Element {
  const [addingModel, setAddingModel] = useState(false)
  const [addModelError, setAddModelError] = useState<string | null>(null)
  const [editingModel, setEditingModel] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const base: LeafPath = ['providers', providerId]
  const entry = api.read(base)
  const provider = isPlainObject(entry) ? entry : {}
  const models = Array.isArray(provider.models) ? provider.models : []
  const compatPath = [...base, 'compat']
  const compat = isPlainObject(api.read(compatPath))
    ? (api.read(compatPath) as Record<string, unknown>)
    : {}

  const addModel = (values: Record<string, string>): void => {
    setAddModelError(null)
    const id = values.id
    if (models.some((m) => isPlainObject(m) && m.id === id)) {
      setAddModelError(`This provider already declares a model with id "${id}".`)
      return
    }
    // Index === length APPENDS (verified through the real writer). A whole-array
    // rewrite would work too but loses any comment inside the array.
    api
      .patch([...base, 'models', models.length], { id })
      .then(() => {
        setAddingModel(false)
        setEditingModel(models.length)
      })
      .catch((e: unknown) => setAddModelError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <>
      <DialogShell
        testid={DIALOG}
        dataId={providerId}
        title={`Custom provider — ${providerId}`}
        subtitle={
          managed
            ? 'Projected from a shared provider — read-only here.'
            : 'models.json entry. Saved as you edit; applies to newly started pi sessions.'
        }
        onClose={onClose}
        footer={
          <>
            {managed ? (
              <span />
            ) : (
              <button
                type="button"
                data-testid={`${DIALOG}.deleteProvider`}
                onClick={() => setConfirmDelete(true)}
                className="px-2 py-1 text-[11px] rounded text-text-muted/70 hover:text-red-400 hover:bg-bg-hover transition-colors"
              >
                Delete provider
              </button>
            )}
            <button
              type="button"
              data-testid={`${DIALOG}.done`}
              onClick={onClose}
              className="px-3 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
            >
              Done
            </button>
          </>
        }
      >
        {managed ? (
          <ManagedNotice testidPrefix={DIALOG} name={providerId} />
        ) : (
          <>
            <LeafRow
              testidPrefix={DIALOG}
              configKey="id"
              label="Provider id"
              helper={`Key under providers; its models appear as ${providerId}/<model id>. Fixed after creation —`}
              keyText="providers.<id>"
              error={null}
            >
              <span
                data-testid={`${DIALOG}.id`}
                className={`${inputClass} w-44 font-mono text-text-muted/80 truncate`}
              >
                {providerId}
              </span>
            </LeafRow>

            <LeafRow
              testidPrefix={DIALOG}
              configKey="baseUrl"
              label="Base URL"
              helper="API endpoint —"
              error={api.errorAt([...base, 'baseUrl'])}
            >
              <LeafTextInput
                testid={`${DIALOG}.text`}
                configKey="baseUrl"
                value={provider.baseUrl}
                placeholder="http://localhost:11434/v1"
                width="w-64"
                onCommit={(v) => api.commit([...base, 'baseUrl'], v)}
              />
            </LeafRow>

            <StackedRow
              testidPrefix={DIALOG}
              configKey="api"
              label="API"
              helper="Wire protocol pi speaks to this endpoint. A model may override it —"
              error={api.errorAt([...base, 'api'])}
            >
              <div className="px-3">
                <SegmentPills
                  testid={`${DIALOG}.segment`}
                  idPrefix="api"
                  options={API_OPTIONS}
                  current={typeof provider.api === 'string' ? provider.api : undefined}
                  onSelect={(v) => api.commit([...base, 'api'], v)}
                />
              </div>
            </StackedRow>

            <LeafRow
              testidPrefix={DIALOG}
              configKey="apiKey"
              label="API key"
              helper={
                'Optional — /login or auth.json works too. Keyless local servers keep a placeholder, since pi gates models on auth either way. Supports $ENV_VAR and !command —'
              }
              error={api.errorAt([...base, 'apiKey'])}
            >
              <LeafTextInput
                testid={`${DIALOG}.text`}
                configKey="apiKey"
                value={provider.apiKey}
                placeholder="ollama"
                width="w-64"
                onCommit={(v) => api.commit([...base, 'apiKey'], v)}
              />
            </LeafRow>

            <ToggleRow
              testidPrefix={DIALOG}
              configKey="authHeader"
              label="Authorization header"
              helper="Send the API key as Authorization: Bearer. Off is pi’s default —"
              checked={provider.authHeader === true}
              onChange={(next) => api.commit([...base, 'authHeader'], next ? true : undefined)}
              error={api.errorAt([...base, 'authHeader'])}
            />

            <StackedRow
              testidPrefix={DIALOG}
              configKey="headers"
              label="Extra headers"
              helper="Sent with every request; values support $ENV_VAR and !command —"
              error={api.errorAt([...base, 'headers'])}
            >
              <div className="px-3">
                <RawJsonField
                  key={String(JSON.stringify(provider.headers))}
                  fieldKey={pathId([...base, 'headers'])}
                  value={provider.headers}
                  onChange={(v) => api.commit([...base, 'headers'], v)}
                />
              </div>
            </StackedRow>

            {CURATED_COMPAT_FLAGS.map((flag) => (
              <ToggleRow
                key={flag.key}
                testidPrefix={DIALOG}
                configKey={`compat.${flag.key}`}
                label={flag.label}
                helper={flag.helper}
                checked={compat[flag.key] !== false}
                onChange={(next) =>
                  next
                    ? deleteWithCollapse(api, compatPath, flag.key)
                    : api.commit([...compatPath, flag.key], false)
                }
                error={api.errorAt([...compatPath, flag.key]) ?? api.errorAt(compatPath)}
              />
            ))}

            <StackedRow
              testidPrefix={DIALOG}
              configKey="compat"
              label="Compatibility (raw)"
              helper="The whole compat object, including the two toggles above —"
              error={api.errorAt(compatPath)}
            >
              <div className="px-3">
                <RawJsonField
                  key={String(JSON.stringify(provider.compat))}
                  fieldKey={pathId(compatPath)}
                  value={provider.compat}
                  onChange={(v) => api.commit(compatPath, v)}
                />
              </div>
            </StackedRow>

            <div className="mt-3 mb-1 mx-3 pb-1 border-b border-border/20 flex items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted/70">
                Models
                <span className="ml-1.5 normal-case tracking-normal font-normal">— models[]</span>
              </div>
              <button
                type="button"
                data-testid={`${DIALOG}.addModel`}
                onClick={() => {
                  setAddModelError(null)
                  setAddingModel(true)
                }}
                className="shrink-0 text-[10px] text-accent hover:text-accent/80 transition-colors"
              >
                + Add model
              </button>
            </div>

            {addingModel && (
              <AddForm
                testidPrefix={`${DIALOG}.addModel`}
                fields={[{ key: 'id', label: 'Model id', placeholder: 'llama3.1:8b' }]}
                submitLabel="Add"
                error={addModelError}
                onSubmit={addModel}
                onCancel={() => {
                  setAddingModel(false)
                  setAddModelError(null)
                }}
              />
            )}

            {models.length === 0 && !addingModel && (
              <div
                data-testid={`${DIALOG}.noModels`}
                className="px-3 py-1.5 text-[10px] text-text-muted/60 leading-relaxed"
              >
                No models declared. pi needs at least one to offer this provider in the picker.
              </div>
            )}

            {models.map((raw, idx) => {
              const model = isPlainObject(raw) ? raw : {}
              const id = typeof model.id === 'string' ? model.id : `#${idx}`
              return (
                <EntityRowCard
                  key={idx}
                  testid={`${DIALOG}.modelRow`}
                  dataId={String(idx)}
                  title={id}
                  subtitle={modelSummary(model)}
                  action="Edit"
                  onClick={() => setEditingModel(idx)}
                />
              )
            })}
          </>
        )}
      </DialogShell>

      {editingModel !== null && (
        <PiModelEditor
          api={api}
          scope={[...base, 'models', editingModel]}
          title={`${providerId} / ${
            isPlainObject(models[editingModel]) && typeof models[editingModel].id === 'string'
              ? String(models[editingModel].id)
              : `#${editingModel}`
          }`}
          variant="model"
          onRemoved={() => setEditingModel(null)}
          onClose={() => setEditingModel(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          testId={`${DIALOG}.confirmDelete`}
          stackedAbove
          title="Delete this provider?"
          body="Its entry, models and overrides are removed from models.json. Any API key stored for it in pi’s auth.json is left alone."
          detail={`providers.${providerId}`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await api.patch(base, undefined)
            onClose()
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  )
}

// ── Creation forms ───────────────────────────────────────────────────────────

/**
 * The one place a WHOLE entry is written: `providers.<id> = {baseUrl, api}`, the
 * minimum models.md requires of a non-built-in provider. The writer refuses this
 * shape at a built-in vendor id (that would replace pi's own definition) and at a
 * projected id, so the rejection is surfaced right here rather than after the
 * dialog has opened on an entry that does not exist.
 */
function AddProviderForm({
  api,
  existingIds,
  onCreated,
  onCancel
}: {
  api: PiModelsLeaf
  existingIds: string[]
  onCreated: (id: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [id, setId] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiType, setApiType] = useState<string>(API_OPTIONS[0])
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const providerId = id.trim()
    const url = baseUrl.trim()
    setError(null)
    if (existingIds.includes(providerId)) {
      setError(`models.json already has a providers."${providerId}" entry.`)
      return
    }
    api
      .patch(['providers', providerId], { baseUrl: url, api: apiType })
      .then(() => onCreated(providerId))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div
      data-testid={`${PANE}.addProvider.form`}
      className="mx-3 my-1 border border-border/30 rounded-md p-2 space-y-1.5"
    >
      <label className="block">
        <span className="block text-[10px] text-text-muted mb-0.5">Provider id</span>
        <input
          type="text"
          data-testid={`${PANE}.addProvider.field`}
          data-id="id"
          placeholder="ollama"
          value={id}
          spellCheck={false}
          onChange={(e) => setId(e.target.value)}
          className={`${inputClass} w-full`}
        />
      </label>
      <label className="block">
        <span className="block text-[10px] text-text-muted mb-0.5">Base URL</span>
        <input
          type="text"
          data-testid={`${PANE}.addProvider.field`}
          data-id="baseUrl"
          placeholder="http://localhost:11434/v1"
          value={baseUrl}
          spellCheck={false}
          onChange={(e) => setBaseUrl(e.target.value)}
          className={`${inputClass} w-full`}
        />
      </label>
      <div>
        <span className="block text-[10px] text-text-muted mb-0.5">API</span>
        <SegmentPills
          testid={`${PANE}.addProvider.segment`}
          idPrefix="api"
          options={API_OPTIONS}
          current={apiType}
          onSelect={setApiType}
          align="start"
        />
      </div>
      {error && (
        <div
          data-testid={`${PANE}.addProvider.error`}
          className="text-[10px] text-red-400 leading-relaxed"
        >
          {error}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`${PANE}.addProvider.submit`}
          disabled={id.trim() === '' || baseUrl.trim() === ''}
          onClick={submit}
          className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Create
        </button>
        <button
          type="button"
          data-testid={`${PANE}.addProvider.cancel`}
          onClick={onCancel}
          className="text-[11px] text-text-muted/70 hover:text-text-primary transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── The pane blocks ──────────────────────────────────────────────────────────

/**
 * CUSTOM PROVIDERS + BUILT-IN OVERRIDES, rendered by PiVendors under its
 * authentication content. The pi-installed gate is PiVendors' (it returns the
 * not-installed copy before this ever mounts), so this component only gates on
 * the first read resolving.
 */
export function PiCustomProviders(): React.JSX.Element {
  const api = usePiModelsLeaf()
  const [addingProvider, setAddingProvider] = useState(false)
  const [addingOverride, setAddingOverride] = useState(false)
  const [overrideError, setOverrideError] = useState<string | null>(null)
  const [openProvider, setOpenProvider] = useState<string | null>(null)
  const [openOverride, setOpenOverride] = useState<{ providerId: string; modelId: string } | null>(
    null
  )

  const { custom, overrides } = partitionPiProviders(api.config, api.managedIds)

  const addOverride = (values: Record<string, string>): void => {
    const providerId = values.provider
    const modelId = values.model
    setOverrideError(null)
    const entry = api.read(['providers', providerId])
    if (isPlainObject(entry) && (entry.baseUrl !== undefined || entry.models !== undefined)) {
      setOverrideError(
        `models.json defines "${providerId}" as a full provider, so it is listed under Custom providers. Its per-model overrides are not editable here.`
      )
      return
    }
    if (api.read(['providers', providerId, 'modelOverrides', modelId]) !== undefined) {
      setOverrideError(`An override for ${providerId} / ${modelId} already exists.`)
      return
    }
    // An empty object is a legal, inert override — pi merges nothing. The editor
    // that opens next fills it in, and "Remove override" deletes the key again.
    api
      .patch(['providers', providerId, 'modelOverrides', modelId], {})
      .then(() => {
        setAddingOverride(false)
        setOpenOverride({ providerId, modelId })
      })
      .catch((e: unknown) => setOverrideError(e instanceof Error ? e.message : String(e)))
  }

  if (api.config === null) {
    return (
      <div data-testid={PANE} className="px-3 py-1.5 text-[11px] text-text-muted/60">
        Loading model catalog…
      </div>
    )
  }

  return (
    <div data-testid={PANE} className="-mx-3">
      <BlockHeader
        label="Custom providers"
        note="models.json"
        actionLabel="+ Add provider"
        actionTestid={`${PANE}.addProvider`}
        onAction={() => setAddingProvider((o) => !o)}
      />

      {addingProvider && (
        <AddProviderForm
          api={api}
          existingIds={Object.keys(isPlainObject(api.config.providers) ? api.config.providers : {})}
          onCreated={(id) => {
            setAddingProvider(false)
            setOpenProvider(id)
          }}
          onCancel={() => setAddingProvider(false)}
        />
      )}

      {custom.length === 0 && !addingProvider && (
        <div
          data-testid={`${PANE}.noProviders`}
          className="px-3 py-1 text-[10px] text-text-muted/60 leading-relaxed"
        >
          No custom providers yet. Add one to reach a local server (Ollama, vLLM, LM Studio) or a
          proxy.
        </div>
      )}

      {custom.map((row) => (
        <EntityRowCard
          key={row.id}
          testid={`${PANE}.providerRow`}
          dataId={row.id}
          title={row.id}
          tag={typeof row.entry.api === 'string' ? row.entry.api : undefined}
          badges={
            row.managed && (
              <span
                data-testid={`${PANE}.managedBadge`}
                data-id={row.id}
                className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-bg-hover text-text-muted/70 uppercase tracking-wide"
              >
                🔒 managed
              </span>
            )
          }
          subtitle={
            <>
              {typeof row.entry.baseUrl === 'string' ? row.entry.baseUrl : 'no baseUrl'} ·{' '}
              {Array.isArray(row.entry.models) ? row.entry.models.length : 0} models
              {row.managed ? ' · managed by Shared Providers' : ''}
            </>
          }
          action={row.managed ? 'View' : 'Edit'}
          onClick={() => setOpenProvider(row.id)}
        />
      ))}

      <BlockHeader
        label="Built-in overrides"
        note="modelOverrides"
        actionLabel="+ Add override"
        actionTestid={`${PANE}.addOverride`}
        onAction={() => {
          setOverrideError(null)
          setAddingOverride((o) => !o)
        }}
      />

      {addingOverride && (
        <AddForm
          testidPrefix={`${PANE}.addOverride`}
          fields={[
            { key: 'provider', label: 'Provider id', placeholder: 'openai' },
            { key: 'model', label: 'Model id', placeholder: 'gpt-5.6-sol' }
          ]}
          submitLabel="Add"
          error={overrideError}
          onSubmit={addOverride}
          onCancel={() => {
            setAddingOverride(false)
            setOverrideError(null)
          }}
        />
      )}

      {overrides.length === 0 && !addingOverride && (
        <div
          data-testid={`${PANE}.noOverrides`}
          className="px-3 py-1 text-[10px] text-text-muted/60 leading-relaxed"
        >
          No overrides. Use one to change a built-in model&rsquo;s context window, pricing or
          thinking map without redefining its provider.
        </div>
      )}

      {overrides.map((row) => (
        <EntityRowCard
          key={`${row.providerId}/${row.modelId}`}
          testid={`${PANE}.overrideRow`}
          dataId={`${row.providerId}/${row.modelId}`}
          title={`${row.providerId} / ${row.modelId}`}
          subtitle={overrideSummary(row.entry)}
          action="Edit"
          onClick={() => setOpenOverride({ providerId: row.providerId, modelId: row.modelId })}
        />
      ))}

      <div
        data-testid={`${PANE}.footer`}
        className="px-3 pt-2 mt-1 border-t border-border/20 text-[10px] text-text-muted/50 leading-relaxed"
      >
        Custom providers and overrides are saved to{' '}
        <span className="font-mono break-all">{api.filePath || '~/.pi/agent/models.json'}</span>.
        Only the field you change is written — other keys and comments are preserved. Keyless local
        servers (Ollama) should keep a placeholder key: pi gates models on auth either way. Changes
        apply to newly started pi sessions.
      </div>

      {openProvider !== null && (
        <PiProviderDialog
          api={api}
          providerId={openProvider}
          managed={api.managedIds.has(openProvider)}
          onClose={() => setOpenProvider(null)}
        />
      )}

      {openOverride !== null && (
        <PiModelEditor
          api={api}
          scope={['providers', openOverride.providerId, 'modelOverrides', openOverride.modelId]}
          title={`${openOverride.providerId} / ${openOverride.modelId}`}
          variant="override"
          onRemoved={() => setOpenOverride(null)}
          onClose={() => setOpenOverride(null)}
        />
      )}
    </div>
  )
}
