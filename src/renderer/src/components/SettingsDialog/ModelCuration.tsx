/**
 * ModelCuration — "Models in the picker" on the provider Manage sheet, for any
 * engine that curates (ADR-074 §2, mockup `7eeb6bff` in its "Separate per
 * engine" state).
 *
 * ONE COMPONENT, ONE ADAPTER PER ENGINE. opencode and pi keep their allowlists
 * in different files under different ids, and read their catalogs from
 * different places — that difference is the adapter's, and nothing below it
 * knows which engine it is talking to. Both engines share the key-presence
 * rule: `undefined` is "All models" (including ones the provider adds later),
 * a list is "Only the ones I pick", `[]` is none.
 *
 * ALL IS A REAL CHOICE, IN BOTH DIRECTIONS. The two-option control writes
 * `null` for All (the key is deleted, not replaced by today's catalog) and
 * seeds Only with every model picked — except a catalog over
 * {@link LARGE_CATALOG}, which starts with nothing but what a setting still
 * uses. Unticking a row while on All is the other way into Only: every other
 * model stays picked, and a toast says so, with Undo.
 *
 * THE ORPHAN GUARD, BEFORE THE CLICK. A model some setting of THIS engine
 * names (its default, its judge, its dispatch models — the scoped
 * `findModelReferences`) shows a lock and cannot be unticked; the tooltip says
 * where the setting lives. Any edit that would still orphan one is refused with
 * the reference sentence, as before.
 *
 * IT OWNS NO STATE OF RECORD. Each commit goes through `adapter.save`
 * (`models:set-provider-allowlist`), then the picker cache is dropped and the
 * registry re-read, exactly as every other write on the sheet.
 */

import { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { engineMeta } from '../../../../shared/engine-meta'
import {
  findModelReferences,
  formatModelReferences,
  type ModelReferenceSources
} from '../../../../shared/model-references'
import type {
  EngineConfig,
  EngineId,
  EngineModelGroup,
  OpencodeConfigSettings
} from '../../../../shared/types'
import { Button, Segmented, SettingRow } from './settings-controls'
import {
  ModelCurationActions,
  ModelCurationList,
  type CurationFacet,
  type CurationModel,
  type CurationSort
} from './ModelCurationList'
import { diagnosisText } from './provider-diagnosis'
import { reloadEngineConfigObject } from './use-engine-config'

/** A catalog larger than this starts "Only the ones I pick" with nothing picked. */
export const LARGE_CATALOG = 50

export type CuratedEngine = 'opencode' | 'pi'

/** What ModelCuration needs from one engine, and nothing else. */
export interface CurationAdapter {
  engine: CuratedEngine
  /** The id the engine's catalog and allowlist key the provider by. */
  providerId: string
  /** The provider's UNFILTERED catalog, in that engine. */
  loadCatalog(): Promise<CurationModel[]>
  /** `undefined` = All models. */
  loadSelection(): Promise<string[] | undefined>
  /** `null` = All models (the key is deleted). */
  save(next: string[] | null): Promise<void>
  /** The picker VALUE a setting would name this model by. */
  pickerValue(modelId: string): string
  /**
   * Why the catalog is empty, when it is — shown instead of a list (ADR-074
   * §5). Absent: the list's own empty state is enough.
   */
  describeEmpty?(): Promise<string>
}

export function opencodeCurationAdapter(providerId: string): CurationAdapter {
  return {
    engine: 'opencode',
    providerId,
    loadCatalog: () => window.api.getOpencodeProviderModels(providerId),
    loadSelection: async () =>
      (await window.api.loadOpencodeSettings()).modelAllowlist?.[providerId],
    save: async (next) => {
      await window.api.setProviderModelAllowlist('opencode', providerId, next)
      await reloadEngineConfigObject('opencode')
    },
    pickerValue: (modelId) => `${providerId}/${modelId}`
  }
}

export function piCurationAdapter(providerId: string): CurationAdapter {
  const prefix = `${providerId}/`
  return {
    engine: 'pi',
    providerId,
    loadCatalog: async () =>
      (await window.api.getPiModelCatalogGroups())
        .filter((group) => group.vendorId === providerId)
        .flatMap((group) =>
          group.models
            .filter((model) => model.value.startsWith(prefix))
            .map((model) => ({
              id: model.value.slice(prefix.length),
              name: model.displayName,
              reasoning: model.supportsEffort === true,
              toolCalling: model.toolCalling === true
            }))
        ),
    loadSelection: async () =>
      (await window.api.loadEngineConfig('pi')).piConfig?.modelAllowlist?.[providerId],
    save: async (next) => {
      await window.api.setProviderModelAllowlist('pi', providerId, next)
      await reloadEngineConfigObject('pi')
    },
    pickerValue: (modelId) => `${prefix}${modelId}`,
    // pi omits a provider it has no usable key for, so an empty catalog for
    // THIS provider while pi reports others is a credential problem.
    describeEmpty: async () =>
      diagnosisText(
        (await window.api.getPiModelCatalogGroups()).length === 0
          ? 'no-models-discovered'
          : 'no-credential'
      )
  }
}

/** One engine's loaded state. `catalog: null` = still loading. */
interface EngineState {
  catalog: CurationModel[] | null
  selection: string[] | undefined
  emptyText?: string
}

interface Toast {
  engine: CuratedEngine
  message: string
  /** The selection Undo restores (`undefined` = All models). */
  previous: string[] | undefined
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * What one engine's list amounts to, as the block itself sees it: the catalog
 * size, and how many of those models are picked (`null` = All models). A picked
 * id the catalog no longer has is not counted.
 */
export interface CurationSummary {
  total: number
  picked: number | null
}

function summarise(state: EngineState | undefined): CurationSummary | null {
  if (!state?.catalog) return null
  const ids = new Set(state.catalog.map((model) => model.id))
  return {
    total: state.catalog.length,
    picked:
      state.selection === undefined ? null : state.selection.filter((id) => ids.has(id)).length
  }
}

/** `n of m` / `all m` — the tab's count, and the group header's. */
export function curationCount(summary: CurationSummary | null): string {
  if (!summary) return '…'
  return summary.picked === null ? `all ${summary.total}` : `${summary.picked} of ${summary.total}`
}

export function ModelCuration({
  testid,
  providerName,
  adapters,
  engine,
  onEngineChange,
  filterRef,
  onSummary,
  onWrote
}: {
  /** The owning sheet's namespace — every part is `${testid}.…` (ADR-027). */
  testid: string
  providerName: string
  /** One per engine this provider reaches that can curate, in engine order. */
  adapters: CurationAdapter[]
  /** The tab on show. Lifted so "Curate models ›" on an engine row can pick it. */
  engine: CuratedEngine
  onEngineChange: (engine: CuratedEngine) => void
  filterRef: React.RefObject<HTMLInputElement | null>
  /**
   * Each engine's count, whenever it changes — so the sheet's header and engine
   * rows say what this block says, not the registry's last snapshot.
   */
  onSummary?: (engine: CuratedEngine, summary: CurationSummary) => void
  onWrote: () => Promise<void>
}): React.JSX.Element {
  const [states, setStates] = useState<Partial<Record<CuratedEngine, EngineState>>>({})
  const [sources, setSources] = useState<ModelReferenceSources | null>(null)
  /** Discovered picker models — the set an edit can actually make disappear. */
  const [discovered, setDiscovered] = useState<EngineModelGroup[]>([])
  const [filter, setFilter] = useState('')
  const [facets, setFacets] = useState<CurationFacet[]>([])
  const [sort, setSort] = useState<CurationSort>('newest')
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  /** Saves run one at a time, in edit order (see `commit`). */
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  /** Bumped per edit, per engine, so a failed save knows whether a later edit is queued. */
  const latestEdit = useRef<Partial<Record<CuratedEngine, number>>>({})

  const adapterKey = adapters.map((a) => `${a.engine}:${a.providerId}`).join(',')

  useEffect(() => {
    let cancelled = false
    for (const adapter of adapters) {
      void Promise.all([
        adapter.loadCatalog().catch((): CurationModel[] => []),
        adapter.loadSelection().catch(() => undefined)
      ]).then(async ([catalog, selection]) => {
        const emptyText =
          catalog.length === 0 ? await adapter.describeEmpty?.().catch(() => undefined) : undefined
        if (cancelled) return
        setStates((prev) => ({ ...prev, [adapter.engine]: { catalog, selection, emptyText } }))
      })
    }
    return () => {
      cancelled = true
    }
    // `adapterKey` is the adapters' identity; the objects are rebuilt per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapterKey])

  useEffect(() => {
    if (!onSummary) return
    for (const engine of Object.keys(states) as CuratedEngine[]) {
      const summary = summarise(states[engine])
      if (summary) onSummary(engine, summary)
    }
  }, [states, onSummary])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.loadOpencodeSettings().catch(() => ({}) as OpencodeConfigSettings),
      window.api.getEngineModels().catch((): EngineModelGroup[] => []),
      Promise.all(
        (['claude', 'opencode', 'pi'] as EngineId[]).map(
          async (id) =>
            [id, await window.api.loadEngineConfig(id).catch(() => ({}) as EngineConfig)] as const
        )
      )
    ]).then(([opencode, groups, configs]) => {
      if (cancelled) return
      setSources({ opencode, engines: Object.fromEntries(configs) })
      setDiscovered(groups)
    })
    return () => {
      cancelled = true
    }
  }, [adapterKey])

  const adapter = adapters.find((a) => a.engine === engine) ?? adapters[0]
  const state = adapter ? states[adapter.engine] : undefined

  if (!adapter || !state?.catalog || sources === null) {
    return <SettingRow testid={`${testid}.models`} dataId="loading" description="Loading models…" />
  }

  const catalog = state.catalog
  const selection = state.selection
  const allIds = catalog.map((model) => model.id)
  const allMode = selection === undefined
  const selected = selection ?? allIds
  const engineLabel = engineMeta(adapter.engine).label

  /** This engine's discovered values for this provider, as `modelId → value`. */
  const prefix = `${adapter.providerId}/`
  const discoveredIds = discovered
    .filter((group) => group.engineId === adapter.engine)
    .flatMap((group) => group.models)
    .filter((model) => model.value.startsWith(prefix))
    .map((model) => model.value.slice(prefix.length))

  const locked: Record<string, string> = {}
  for (const id of discoveredIds) {
    const [ref] = findModelReferences(sources, [adapter.pickerValue(id)], adapter.engine)
    if (ref) locked[id] = ref.where
  }

  const setSelection = (next: string[] | undefined): void =>
    setStates((prev) => {
      const current = prev[adapter.engine]
      return current ? { ...prev, [adapter.engine]: { ...current, selection: next } } : prev
    })

  /**
   * The one writer. Refuses an edit that would orphan a configured model, shows
   * the edit at once, and queues the save behind every earlier one.
   *
   * SAVES ARE SERIAL, AND A FAILURE RE-READS. Each save writes a whole list, so
   * the last one to land is what is on disk. Restoring "the selection before
   * this edit" on a failure would be a guess — a later edit may already be shown
   * and queued — so a failed save re-reads the selection instead, and only when
   * no later edit is behind it (that edit's own save decides the outcome).
   */
  const commit = (next: string[] | null, nextToast: Toast | null = null): void => {
    const kept = new Set(next ?? allIds)
    const removed = next === null ? [] : discoveredIds.filter((id) => !kept.has(id))
    const refs = findModelReferences(sources, removed.map(adapter.pickerValue), adapter.engine)
    if (refs.length > 0) {
      setError(formatModelReferences(refs))
      return
    }
    setError(null)
    setToast(nextToast)
    setSelection(next ?? undefined)
    const target = adapter
    const generation = (latestEdit.current[target.engine] ?? 0) + 1
    latestEdit.current[target.engine] = generation
    const isLatest = (): boolean => latestEdit.current[target.engine] === generation
    saveChain.current = saveChain.current.then(async () => {
      try {
        await target.save(next)
        useSessionStore.getState().reloadModels()
        await onWrote()
      } catch (e) {
        setToast(null)
        setError(message(e))
        if (!isLatest()) return
        // A read that fails too leaves the edit on show: `undefined` would be a
        // claim ("All models") the file never made.
        const onDisk = await target.loadSelection().then(
          (selection) => ({ selection }),
          () => null
        )
        if (onDisk && isLatest()) setSelection(onDisk.selection)
      }
    })
  }

  /** A list edit. From All, it is the way into "Only the ones I pick". */
  const edit = (next: string[]): void => {
    // Same membership is no edit at all — on All models, writing it would
    // silently switch the provider to Only and hide every model added later.
    const current = new Set(selected)
    if (next.length === current.size && next.every((id) => current.has(id))) return
    if (!allMode) {
      commit(next)
      return
    }
    const dropped = allIds.length - next.length
    commit(next, {
      engine: adapter.engine,
      previous: undefined,
      message:
        next.length === 0
          ? 'Switched to Only the ones I pick — none are picked.'
          : dropped === 1
            ? 'Switched to Only the ones I pick — everything but this model is picked.'
            : `Switched to Only the ones I pick — everything but these ${dropped} models is picked.`
    })
  }

  const setMode = (mode: 'all' | 'pick'): void => {
    if (mode === 'all') {
      if (!allMode) commit(null)
      return
    }
    if (!allMode) return
    // A big catalog starts empty (anti-flood) — but never without the models a
    // setting still uses, or the switch itself would be refused.
    commit(
      catalog.length > LARGE_CATALOG ? allIds.filter((id) => locked[id] !== undefined) : allIds
    )
  }

  const selectTab = (engine: CuratedEngine): void => {
    setToast(null)
    setError(null)
    onEngineChange(engine)
  }

  /** Left/Right move AND select, wrapping — the WAI-ARIA tabs pattern. */
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const at = adapters.findIndex((a) => a.engine === adapter.engine)
    const next = adapters[(at + step + adapters.length) % adapters.length].engine
    selectTab(next)
    const tabsEl = Array.from(e.currentTarget.parentElement?.children ?? [])
    const target = tabsEl.find((el) => el.getAttribute('data-id') === next)
    if (target instanceof HTMLElement) target.focus()
  }

  const tabs =
    adapters.length > 1 ? (
      <div
        role="tablist"
        aria-label="Models in the picker, per engine"
        data-testid={`${testid}.curationTabs`}
        className="flex gap-0.5 px-2 border-b border-border/55"
      >
        {adapters.map((a) => {
          const on = a.engine === adapter.engine
          return (
            <button
              key={a.engine}
              type="button"
              role="tab"
              aria-selected={on}
              // One tab stop for the whole strip; the arrows move within it.
              tabIndex={on ? 0 : -1}
              data-testid={`${testid}.curationTab`}
              data-id={a.engine}
              onClick={() => selectTab(a.engine)}
              onKeyDown={onTabKeyDown}
              className={`-mb-px flex items-center gap-1.5 px-3 py-2 text-[12.5px] border-b-2 transition-colors cursor-default outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
                on
                  ? 'border-accent text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {engineMeta(a.engine).label}
              <span
                data-testid={`${testid}.curationTabCount`}
                data-id={a.engine}
                className={`rounded-full border px-1.5 font-mono text-[10.5px] leading-4 ${
                  on ? 'border-accent/40 text-accent' : 'border-border text-text-muted'
                }`}
              >
                {curationCount(summarise(states[a.engine]))}
              </span>
            </button>
          )
        })}
      </div>
    ) : null

  if (catalog.length === 0 && state.emptyText) {
    return (
      <>
        {tabs}
        <SettingRow
          testid={`${testid}.models`}
          dataId="empty"
          label={`No ${engineLabel} models from ${providerName}`}
          description={state.emptyText}
        />
      </>
    )
  }

  const picked = selection?.filter((id) => allIds.includes(id)).length ?? 0

  return (
    <>
      {tabs}
      <SettingRow
        testid={`${testid}.curationModeRow`}
        dataId={adapter.engine}
        label={`Show in the ${engineLabel} picker`}
        description={
          allMode
            ? `Every model ${providerName} offers is shown, including ones added later.`
            : `New models from ${providerName} stay out of the ${engineLabel} picker until you pick them.`
        }
      >
        <Segmented
          testid={`${testid}.curationMode`}
          value={allMode ? 'all' : 'pick'}
          options={[
            { value: 'all', label: 'All models' },
            {
              value: 'pick',
              label: allMode ? 'Only the ones I pick' : `Only the ones I pick · ${picked}`
            }
          ]}
          onChange={setMode}
        />
      </SettingRow>
      <SettingRow
        testid={`${testid}.models`}
        dataId={adapter.providerId}
        layout="stacked"
        label="Models"
        description={
          allMode
            ? `All ${catalog.length} shown. Nothing here changes what ${engineLabel} itself can reach.`
            : `${picked} of ${catalog.length} selected. Nothing here changes what ${engineLabel} itself can reach.`
        }
        error={error ?? undefined}
        errorTestid={`${testid}.modelsError`}
        trailing={
          allMode ? undefined : (
            <ModelCurationActions
              testid={`${testid}.models`}
              models={catalog}
              selected={selected}
              onSet={edit}
              filter={filter}
              facets={facets}
              locked={locked}
            />
          )
        }
      >
        <ModelCurationList
          testid={`${testid}.models`}
          filterTestid={`${testid}.modelFilter`}
          models={catalog}
          selected={selected}
          onSet={edit}
          filterRef={filterRef}
          total={catalog.length}
          filter={filter}
          onFilterChange={setFilter}
          facets={facets}
          onFacetsChange={setFacets}
          sort={sort}
          onSortChange={setSort}
          locked={locked}
          allMode={allMode}
        />
        {toast && toast.engine === adapter.engine && (
          <span
            role="status"
            aria-live="polite"
            data-testid={`${testid}.curationToast`}
            className="mt-2 flex items-center gap-2 rounded-md border border-border bg-bg-tertiary px-2.5 py-1.5 text-[12px] text-text-primary"
          >
            <span className="flex-1 min-w-0">{toast.message}</span>
            <Button
              variant="link"
              testid={`${testid}.curationUndo`}
              onClick={() => commit(toast.previous ?? null)}
            >
              Undo
            </Button>
            <button
              type="button"
              aria-label="Dismiss"
              data-testid={`${testid}.curationToastDismiss`}
              onClick={() => setToast(null)}
              className="shrink-0 px-1 text-[13px] leading-none text-text-muted hover:text-text-primary transition-colors cursor-default"
            >
              ✕
            </button>
          </span>
        )}
      </SettingRow>
    </>
  )
}
