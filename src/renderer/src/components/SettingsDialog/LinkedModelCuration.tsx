/**
 * LinkedModelCuration — "Which engines use this list" (ADR-074 §3, mockup
 * `7eeb6bff`), for a SHARED provider both opencode and pi reach.
 *
 * ONE LIST BY DEFAULT. The definition's `curation` record holds the list in
 * canonical model ids; `SharedProviderService.setCuration` projects it into each
 * engine's allowlist under that engine's ids. Without a record the engines'
 * own lists decide (`effectiveCuration`): the same → one list, different → two.
 *
 * THE SHARED LIST is the union of both catalogs by canonical id, each row
 * marked `oc` / `pi` for the engines that offer it — a model only one engine
 * has stays in the list and simply does not reach the other. A lock is the
 * union of both engines' scoped references: a model either engine's settings
 * name cannot be unticked.
 *
 * JOINING LISTS THAT DIFFER is an explicit choice (the join panel): opencode's
 * list, pi's, or both combined, each with what it does to the other engine.
 * SEPARATE hands back to `ModelCuration`, one tab per engine; nothing changes
 * on disk, because both engines already hold the list the link projected.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { engineMeta } from '../../../../shared/engine-meta'
import {
  findModelReferences,
  formatModelReferences,
  type ModelReferenceSources
} from '../../../../shared/model-references'
import {
  canonicalModelId,
  effectiveCuration,
  engineModelId
} from '../../../../shared/provider-curation'
import type {
  SharedProviderCuration,
  SharedProviderDefinition
} from '../../../../shared/shared-provider'
import type {
  EngineConfig,
  EngineId,
  EngineModelGroup,
  OpencodeConfigSettings
} from '../../../../shared/types'
import { Button, ChoiceCards, RadioRow, Segmented, SettingRow } from './settings-controls'
import {
  ModelCurationActions,
  ModelCurationList,
  type CurationFacet,
  type CurationModel,
  type CurationSort
} from './ModelCurationList'
import {
  LARGE_CATALOG,
  ModelCuration,
  type CuratedEngine,
  type CurationAdapter,
  type CurationSummary
} from './ModelCuration'
import { reloadEngineConfigObject } from './use-engine-config'

const ENGINES: CuratedEngine[] = ['opencode', 'pi']
const MARK: Record<CuratedEngine, string> = { opencode: 'oc', pi: 'pi' }

type JoinPick = CuratedEngine | 'union'

/** One engine's catalog and allowlist entry, in THAT engine's ids. `null` = loading. */
interface EngineList {
  catalog: CurationModel[]
  selection: string[] | undefined
  emptyText?: string
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const count = (list: readonly string[] | undefined): string =>
  list === undefined ? 'all' : String(list.length)

/** "pi changes from 2 to 4 models." — what taking `to` does to an engine now on `from`. */
function joinEffect(
  engine: CuratedEngine,
  from: string[] | undefined,
  to: string[] | undefined
): string {
  const label = engineMeta(engine).label
  if (from === undefined && to === undefined) return `${label} stays on all models.`
  if (from === undefined) return `${label} goes from all models to this list.`
  if (to === undefined) return `${label} goes from ${from.length} models to all models.`
  return `${label} changes from ${from.length} to ${to.length} models.`
}

export function LinkedModelCuration({
  testid,
  providerName,
  definition,
  adapters,
  engine,
  onEngineChange,
  filterRef,
  onSummary,
  onWrote
}: {
  testid: string
  providerName: string
  definition: SharedProviderDefinition
  /** Both engines' adapters — the caller mounts this only when both curate. */
  adapters: CurationAdapter[]
  engine: CuratedEngine
  onEngineChange: (engine: CuratedEngine) => void
  filterRef: React.RefObject<HTMLInputElement | null>
  onSummary?: (engine: CuratedEngine, summary: CurationSummary) => void
  onWrote: () => Promise<void>
}): React.JSX.Element {
  const [lists, setLists] = useState<Partial<Record<CuratedEngine, EngineList>>>({})
  /** The stored record as last written from here — the definition prop lags a write. */
  const [record, setRecord] = useState<SharedProviderCuration | undefined>(definition.curation)
  const [sources, setSources] = useState<ModelReferenceSources | null>(null)
  const [discovered, setDiscovered] = useState<EngineModelGroup[]>([])
  const [joinPick, setJoinPick] = useState<JoinPick | null>(null)
  const [filter, setFilter] = useState('')
  const [facets, setFacets] = useState<CurationFacet[]>([])
  const [sort, setSort] = useState<CurationSort>('newest')
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; previous: string[] | undefined } | null>(
    null
  )
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  const latestEdit = useRef(0)

  const adapterOf = (e: CuratedEngine): CurationAdapter | undefined =>
    adapters.find((a) => a.engine === e)
  const adapterKey = adapters.map((a) => `${a.engine}:${a.providerId}`).join(',')

  const loadLists = useCallback(async (): Promise<void> => {
    const loaded = await Promise.all(
      adapters.map(async (adapter) => {
        const [catalog, selection] = await Promise.all([
          adapter.loadCatalog().catch((): CurationModel[] => []),
          adapter.loadSelection().catch(() => undefined)
        ])
        const emptyText =
          catalog.length === 0 ? await adapter.describeEmpty?.().catch(() => undefined) : undefined
        return [adapter.engine, { catalog, selection, emptyText }] as const
      })
    )
    setLists(Object.fromEntries(loaded))
    // `adapterKey` is the adapters' identity; the objects are rebuilt per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapterKey])

  useEffect(() => {
    void loadLists()
  }, [loadLists])

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

  const opencodeList = lists.opencode
  const piList = lists.pi
  const loaded = opencodeList !== undefined && piList !== undefined && sources !== null

  // Each engine's list in CANONICAL ids — what the link compares and joins.
  const canonical = (e: CuratedEngine): string[] | undefined =>
    lists[e]?.selection?.map((id) => canonicalModelId(definition, e, id))
  const derived = effectiveCuration(
    { models: definition.models, curation: undefined },
    { opencode: opencodeList?.selection, pi: piList?.selection }
  )
  const effective = record ?? derived
  const linked = effective.linked

  /** The union of both catalogs by canonical id, and which engines offer each. */
  const offered: Record<string, Set<CuratedEngine>> = {}
  const union: CurationModel[] = []
  for (const e of ENGINES) {
    for (const model of lists[e]?.catalog ?? []) {
      const id = canonicalModelId(definition, e, model.id)
      if (!offered[id]) {
        offered[id] = new Set()
        union.push({ ...model, id })
      }
      offered[id].add(e)
    }
  }
  const unionIds = union.map((model) => model.id)

  // Each engine's count under the SHARED list, whenever it moves.
  useEffect(() => {
    if (!onSummary || !linked || !opencodeList || !piList) return
    for (const e of ENGINES) {
      const catalog = lists[e]?.catalog ?? []
      const ids = new Set(catalog.map((model) => model.id))
      onSummary(e, {
        total: catalog.length,
        picked:
          effective.models === undefined
            ? null
            : effective.models.filter((id) => ids.has(engineModelId(definition, e, id))).length
      })
    }
  })

  if (!loaded) {
    return <SettingRow testid={`${testid}.models`} dataId="loading" description="Loading models…" />
  }

  /** Model canonical id → where a setting of EITHER engine uses it. */
  const locked: Record<string, string> = {}
  for (const e of ENGINES) {
    const adapter = adapterOf(e)
    if (!adapter) continue
    const prefix = `${adapter.providerId}/`
    for (const group of discovered.filter((g) => g.engineId === e)) {
      for (const model of group.models) {
        if (!model.value.startsWith(prefix)) continue
        const [ref] = findModelReferences(sources, [model.value], e)
        if (ref)
          locked[canonicalModelId(definition, e, model.value.slice(prefix.length))] ??= ref.where
      }
    }
  }

  /** The one writer: persist the record, which the core projects while linked. */
  const writeCuration = (next: SharedProviderCuration, onFail: () => void): void => {
    const generation = ++latestEdit.current
    saveChain.current = saveChain.current.then(async () => {
      try {
        await window.api.setSharedProviderCuration(definition.id, next)
        await Promise.all([reloadEngineConfigObject('opencode'), reloadEngineConfigObject('pi')])
        useSessionStore.getState().reloadModels()
        await loadLists()
        await onWrote()
      } catch (e) {
        setToast(null)
        setError(message(e))
        if (latestEdit.current === generation) onFail()
      }
    })
  }

  const setShared = (next: string[] | undefined, nextToast: typeof toast = null): void => {
    const kept = new Set(next ?? unionIds)
    const removed = next === undefined ? [] : unionIds.filter((id) => !kept.has(id))
    const refs = ENGINES.flatMap((e) => {
      const adapter = adapterOf(e)
      return adapter
        ? findModelReferences(
            sources,
            removed.map((id) => adapter.pickerValue(engineModelId(definition, e, id))),
            e
          )
        : []
    })
    if (refs.length > 0) {
      setError(formatModelReferences(refs))
      return
    }
    setError(null)
    setToast(nextToast)
    const previous = record
    const curation: SharedProviderCuration = { linked: true, ...(next ? { models: next } : {}) }
    setRecord(curation)
    writeCuration(curation, () => setRecord(previous))
  }

  const chooseLink = (value: 'one' | 'separate'): void => {
    setError(null)
    setToast(null)
    if (value === 'separate') {
      setJoinPick(null)
      if (!linked) return
      const previous = record
      setRecord({ linked: false })
      writeCuration({ linked: false }, () => setRecord(previous))
      return
    }
    if (linked) return
    // The lists agree: one list is just the common one. They differ: ask.
    if (derived.linked) {
      const previous = record
      const curation: SharedProviderCuration = {
        linked: true,
        ...(derived.models ? { models: derived.models } : {})
      }
      setRecord(curation)
      writeCuration(curation, () => setRecord(previous))
      return
    }
    setJoinPick('union')
  }

  const cards = (
    <SettingRow
      testid={`${testid}.curationLinkRow`}
      layout="stacked"
      description="Which engines use this list"
    >
      <ChoiceCards
        testid={`${testid}.curationLink`}
        ariaLabel="Which engines use this list"
        value={linked ? 'one' : 'separate'}
        options={[
          {
            value: 'one',
            label: 'One list for all engines',
            description: 'opencode and pi offer the same models.'
          },
          {
            value: 'separate',
            label: 'Separate per engine',
            description: 'Each engine keeps its own list.'
          }
        ]}
        onChange={chooseLink}
      />
    </SettingRow>
  )

  if (!linked) {
    if (joinPick !== null) {
      const oc = canonical('opencode')
      const pi = canonical('pi')
      const unionAll = oc === undefined || pi === undefined
      const combined = unionAll ? undefined : [...new Set([...oc, ...pi])]
      const picked = joinPick === 'opencode' ? oc : joinPick === 'pi' ? pi : combined
      const options: Array<{ value: JoinPick; label: string; description: string }> = [
        {
          value: 'opencode',
          label: `opencode’s list (${count(oc)})`,
          description: joinEffect('pi', pi, oc)
        },
        {
          value: 'pi',
          label: `pi’s list (${count(pi)})`,
          description: joinEffect('opencode', oc, pi)
        },
        {
          value: 'union',
          label: `Both combined (${count(combined)})`,
          description: unionAll
            ? 'One side shows all models, so the combined list is all models.'
            : 'Nothing either engine shows today is removed.'
        }
      ]
      return (
        <>
          {cards}
          <div data-testid={`${testid}.curationJoin`} className="px-3.5 py-3">
            <div className="rounded-lg border border-border bg-bg-tertiary/40 overflow-hidden">
              <SettingRow
                testid={`${testid}.curationJoinHeader`}
                label="opencode and pi have different lists."
                labelClassName="text-warning"
                description="Choose what the shared list starts from:"
              />
              {options.map((option) => (
                <RadioRow
                  key={option.value}
                  testid={`${testid}.curationJoinOption`}
                  name={`${testid}-join`}
                  value={option.value}
                  label={option.label}
                  description={option.description}
                  checked={joinPick === option.value}
                  onSelect={() => setJoinPick(option.value)}
                />
              ))}
              <div className="flex gap-2 px-3.5 py-2.5">
                <Button
                  testid={`${testid}.curationJoinUse`}
                  variant="primary"
                  onClick={() => {
                    setJoinPick(null)
                    const previous = record
                    const curation: SharedProviderCuration = {
                      linked: true,
                      ...(picked ? { models: picked } : {})
                    }
                    setRecord(curation)
                    writeCuration(curation, () => setRecord(previous))
                  }}
                >
                  Use one list
                </Button>
                <Button
                  testid={`${testid}.curationJoinKeep`}
                  variant="link"
                  onClick={() => setJoinPick(null)}
                >
                  Keep separate
                </Button>
              </div>
            </div>
          </div>
        </>
      )
    }
    return (
      <>
        {cards}
        {error && <SettingRow testid={`${testid}.curationLinkRow`} dataId="error" error={error} />}
        <ModelCuration
          testid={testid}
          providerName={providerName}
          adapters={adapters}
          engine={engine}
          onEngineChange={onEngineChange}
          filterRef={filterRef}
          onSummary={onSummary}
          onWrote={async () => {
            await loadLists()
            await onWrote()
          }}
        />
      </>
    )
  }

  // ── One list ───────────────────────────────────────────────────────────────

  if (union.length === 0) {
    const emptyText = ENGINES.map((e) => lists[e]?.emptyText).find(Boolean)
    return (
      <>
        {cards}
        <SettingRow
          testid={`${testid}.models`}
          dataId="empty"
          label={`No models from ${providerName}`}
          description={emptyText ?? 'Neither engine reports a model for this provider.'}
        />
      </>
    )
  }

  const allMode = effective.models === undefined
  const selected = effective.models ?? unionIds
  const picked = effective.models?.filter((id) => offered[id]).length ?? 0

  const edit = (next: string[]): void => {
    const current = new Set(selected)
    if (next.length === current.size && next.every((id) => current.has(id))) return
    if (!allMode) {
      setShared(next)
      return
    }
    const dropped = unionIds.length - next.length
    setShared(next, {
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
      if (!allMode) setShared(undefined)
      return
    }
    if (!allMode) return
    setShared(
      union.length > LARGE_CATALOG ? unionIds.filter((id) => locked[id] !== undefined) : unionIds
    )
  }

  const marks = (model: CurationModel): React.ReactNode => (
    <span className="shrink-0 flex gap-1">
      {ENGINES.map((e) => {
        const has = offered[model.id]?.has(e) === true
        const label = engineMeta(e).label
        return (
          <span
            key={e}
            data-testid={`${testid}.modelMark`}
            data-id={e}
            data-available={has ? 'true' : 'false'}
            title={has ? `Offered by ${label}` : `${label} does not offer this model`}
            className={`rounded px-[5px] font-mono text-[9.5px] font-bold leading-4 border ${
              has ? 'border-accent/30 bg-accent/5 text-accent' : 'border-border text-text-muted'
            }`}
          >
            {MARK[e]}
          </span>
        )
      })}
    </span>
  )

  return (
    <>
      {cards}
      <SettingRow
        testid={`${testid}.curationModeRow`}
        dataId="shared"
        label="Show in the pickers"
        description={
          allMode
            ? `Every model ${providerName} offers is shown, including ones added later.`
            : `New models from ${providerName} stay out of the opencode and pi pickers until you pick them.`
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
        dataId="shared"
        layout="stacked"
        label="Models"
        description={
          allMode
            ? `All ${union.length} shown, across opencode and pi.`
            : `${picked} of ${union.length} selected, across opencode and pi.`
        }
        error={error ?? undefined}
        errorTestid={`${testid}.modelsError`}
        trailing={
          allMode ? undefined : (
            <ModelCurationActions
              testid={`${testid}.models`}
              models={union}
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
          models={union}
          selected={selected}
          onSet={edit}
          filterRef={filterRef}
          total={union.length}
          filter={filter}
          onFilterChange={setFilter}
          facets={facets}
          onFacetsChange={setFacets}
          sort={sort}
          onSortChange={setSort}
          locked={locked}
          allMode={allMode}
          rowMarks={marks}
        />
        {toast && (
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
              onClick={() => setShared(toast.previous)}
            >
              Undo
            </Button>
          </span>
        )}
      </SettingRow>
    </>
  )
}
