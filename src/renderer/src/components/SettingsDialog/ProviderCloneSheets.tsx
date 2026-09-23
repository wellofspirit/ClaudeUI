/**
 * The two stacked sheets a second key for a catalog provider needs (ADR-074
 * slice 10, owner-approved mockup `b90c7ea5`):
 *
 *  · {@link AddAnotherKeySheet} — "+ Add another key" on a catalog provider's
 *    Manage sheet. A label ("Work" → `openrouter-work`, "OpenRouter (Work)"),
 *    the key, the engines, the endpoint and API (from the catalog, or asked
 *    when it does not say), and the models to declare, pre-ticked with the
 *    original's picks. ONE `saveSharedProvider` (a custom definition with
 *    `derivedFrom`) and ONE `setSharedProviderApiKey` — and when the key cannot
 *    be stored, the definition is removed again.
 *  · {@link RefreshModelsSheet} — "Refresh from catalog ›" on such an entry:
 *    re-copies the declared models' details from the vendor's catalog, and
 *    offers the catalog's other models to add. One `saveSharedProvider`.
 *
 * Why a custom definition, and the rules for what it declares, are in
 * `provider-clone.ts`. The model list is the curation list (`ModelCurationList`)
 * — the same grouped, searchable control, here choosing what to DECLARE rather
 * than what the picker shows.
 *
 * Each sheet owns its busy state and error slot: it is stacked over the Manage
 * sheet, whose own error line it covers.
 */

import { useEffect, useMemo, useState } from 'react'
import type {
  ConfigurableHarnessId,
  SharedProviderDefinition,
  SharedProviderProtocol
} from '../../../../shared/shared-provider'
import { Button, ChipSet, SelectField, SettingRow, TextField } from './settings-controls'
import { SheetFrame, SheetGroup } from './SheetFrame'
import { opencodeCurationAdapter, piCurationAdapter } from './ModelCuration'
import {
  ModelCurationList,
  type CurationFacet,
  type CurationModel,
  type CurationSort
} from './ModelCurationList'
import {
  CLONE_MODEL_CAP,
  catalogEndpoint,
  cloneIdError,
  cloneIdentity,
  declareModels,
  endpointUrlError,
  originPicks,
  seedClonePicks,
  today,
  withinCap,
  type CloneCatalogModel
} from './provider-clone'

const ADD = 'AddAnotherKeySheet'
const REFRESH = 'RefreshModelsSheet'

const ENGINES: readonly ConfigurableHarnessId[] = ['opencode', 'pi']

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The vendor's catalog, with what a declared copy needs: opencode's (limits,
 * vision, its API URL), else pi's row facts when opencode has none to give.
 */
async function loadVendorCatalog(vendorId: string): Promise<CloneCatalogModel[]> {
  const opencode = await window.api.getOpencodeProviderModels(vendorId).catch(() => [])
  if (opencode.length > 0) return opencode
  return piCurationAdapter(vendorId)
    .loadCatalog()
    .catch(() => [])
}

/**
 * The curation list's view state, which this sheet has no reason to lift: the
 * search text, the facets and the sort.
 */
function useListView(): {
  filter: string
  setFilter: (next: string) => void
  facets: CurationFacet[]
  setFacets: (next: CurationFacet[]) => void
  sort: CurationSort
  setSort: (next: CurationSort) => void
} {
  const [filter, setFilter] = useState('')
  const [facets, setFacets] = useState<CurationFacet[]>([])
  const [sort, setSort] = useState<CurationSort>('newest')
  return { filter, setFilter, facets, setFacets, sort, setSort }
}

/** "Up to 50 models" — shown once a pick past the cap was refused. */
function capNote(testid: string): React.JSX.Element {
  return (
    <span data-testid={`${testid}.capNote`} className="text-[12px] text-warning">
      Up to {CLONE_MODEL_CAP} models. Pick the models you use; you can add more later.
    </span>
  )
}

// ── Add another key ──────────────────────────────────────────────────────────

const PROTOCOL_OPTIONS: { value: SharedProviderProtocol; label: string }[] = [
  { value: 'openai-completions', label: 'OpenAI-compatible (chat completions)' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' }
]

/** How the form's first ticks came about — the Models row says which. */
type Seed = 'picks' | 'all' | 'too-many' | 'none-listed'

export function AddAnotherKeySheet({
  origin,
  taken,
  onClose,
  onAdded
}: {
  /** The catalog definition the new key sits beside. */
  origin: SharedProviderDefinition
  /**
   * Every provider id ClaudeUI already shows: the new id must be none of them.
   * The engines' full catalogs are added here, read when the form opens.
   */
  taken: ReadonlySet<string>
  onClose: () => void
  /** Saved and keyed: re-read, and open the new entry. */
  onAdded: (id: string) => Promise<void>
}): React.JSX.Element {
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [engines, setEngines] = useState<ConfigurableHarnessId[]>([...ENGINES])
  const [catalog, setCatalog] = useState<CloneCatalogModel[] | null>(null)
  const [seed, setSeed] = useState<Seed>('picks')
  const [picked, setPicked] = useState<string[]>([])
  const [catalogIds, setCatalogIds] = useState<ReadonlySet<string>>(new Set())
  const [typedUrl, setTypedUrl] = useState('')
  const [typedProtocol, setTypedProtocol] = useState<SharedProviderProtocol | ''>('')
  const [capped, setCapped] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = useListView()

  useEffect(() => {
    let cancelled = false
    // The original's picks, read from each engine's own list rather than from
    // the Manage sheet's curation block — which has nothing to read while the
    // original is switched off, or curates on one engine only.
    const routed = ENGINES.filter((engine) => origin.routes[engine].enabled)
    const read = routed.length > 0 ? routed : [...ENGINES]
    const routeId = (engine: ConfigurableHarnessId): string =>
      origin.routes[engine].providerId ?? origin.id
    void Promise.all([
      loadVendorCatalog(origin.id),
      Promise.all(
        read.map(async (engine) => {
          const adapter =
            engine === 'opencode'
              ? opencodeCurationAdapter(routeId(engine))
              : piCurationAdapter(routeId(engine))
          return [engine, await adapter.loadSelection().catch(() => undefined)] as const
        })
      ),
      // Every id either engine knows, configured or not: the new entry must not
      // land on one (the service refuses it too).
      window.api.getOpencodeProviders().catch(() => []),
      window.api.vendorAuthListOptions('pi').catch(() => ({}))
    ]).then(([models, lists, opencodeCatalog, piOptions]) => {
      if (cancelled) return
      const picks = originPicks(origin.curation, Object.fromEntries(lists), read)
      const seeded = seedClonePicks(picks, models)
      setCatalog(models)
      setPicked(seeded)
      setSeed(
        seeded.length > 0
          ? picks === undefined
            ? 'all'
            : 'picks'
          : picks === undefined
            ? 'too-many'
            : 'none-listed'
      )
      setCatalogIds(new Set([...opencodeCatalog.map((p) => p.id), ...Object.keys(piOptions)]))
    })
    return () => {
      cancelled = true
    }
  }, [origin])

  const allTaken = useMemo(() => new Set([...taken, ...catalogIds]), [taken, catalogIds])
  const { id, name, numbered } = cloneIdentity(origin.id, origin.name, label, allTaken)
  const idError = label.trim() ? cloneIdError(id, allTaken) : null
  const detected = catalog ? catalogEndpoint(catalog) : {}
  const baseUrl = detected.baseUrl ?? typedUrl.trim()
  const urlError = !detected.baseUrl && baseUrl ? endpointUrlError(baseUrl) : null
  const protocol = detected.protocol ?? (typedProtocol || undefined)
  const ready =
    catalog !== null &&
    label.trim().length > 0 &&
    idError === null &&
    key.trim().length > 0 &&
    engines.length > 0 &&
    picked.length > 0 &&
    baseUrl.length > 0 &&
    urlError === null &&
    protocol !== undefined

  const pick = (next: string[]): void => {
    if (!withinCap(next, picked)) {
      setCapped(true)
      return
    }
    setCapped(false)
    setPicked(next)
  }

  const save = async (): Promise<void> => {
    if (!ready || !catalog || !protocol) return
    const definition: SharedProviderDefinition = {
      id,
      name,
      kind: 'custom',
      protocol,
      baseUrl,
      models: declareModels(picked, catalog),
      routes: {
        pi: { enabled: engines.includes('pi') },
        opencode: { enabled: engines.includes('opencode') }
      },
      derivedFrom: origin.id,
      copiedAt: today(),
      managed: true
    }
    setBusy(true)
    setError(null)
    try {
      await window.api.saveSharedProvider(definition)
      try {
        await window.api.setSharedProviderApiKey(id, key.trim())
      } catch (e) {
        // A second key without its key is no entry at all: take the definition
        // back out, so Cancel leaves nothing behind.
        await window.api.removeSharedProvider(id).catch(() => undefined)
        throw e
      }
      await onAdded(id)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  const seedText = ((): string => {
    if (!catalog) return ''
    switch (seed) {
      case 'picks':
        return `Pre-ticked with ${origin.name}’s current picks.`
      case 'all':
        return `${origin.name} shows all its models; every one is ticked.`
      case 'too-many':
        return `${origin.name} shows all ${catalog.length} of its models — too many to declare. Tick the ones you use.`
      case 'none-listed':
        return `None of ${origin.name}’s current picks is in the catalog. Tick the ones you use.`
    }
  })()

  /** What the endpoint row asks for, when the catalog does not say. */
  const endpointAsk = detected.baseUrl
    ? 'which API its models speak — choose it'
    : detected.protocol
      ? 'one endpoint for its models — enter the base URL'
      : 'one endpoint or API for its models — enter both'

  return (
    <SheetFrame
      testid={ADD}
      dataId={origin.id}
      title={`Another ${origin.name} key`}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1 min-w-0 truncate text-[12px] text-text-secondary">
            {error ? (
              <span data-testid={`${ADD}.error`} className="text-danger">
                {error}
              </span>
            ) : (
              'Pick the models you use; you can add more later.'
            )}
          </span>
          <Button variant="link" testid={`${ADD}.cancel`} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            testid={`${ADD}.save`}
            disabled={busy || !ready}
            onClick={() => void save()}
          >
            {`Add ${label.trim() ? name : `${origin.name} (…)`}`}
          </Button>
        </>
      }
    >
      <SheetGroup testid={`${ADD}.group`} id="key" label="New entry">
        <SettingRow
          testid={`${ADD}.field`}
          dataId="label"
          label="Name"
          description={
            idError ? (
              <span data-testid={`${ADD}.idError`} className="text-danger">
                {idError}
              </span>
            ) : (
              <span data-testid={`${ADD}.identity`}>
                {label.trim() ? (
                  <>
                    Shows as {name} · id <span className="font-mono">{id}</span>
                    {numbered && ' — the name has no letters or digits to make an id from'}
                  </>
                ) : (
                  `Work, Personal… It is shown as “${origin.name} (…)”.`
                )}
              </span>
            )
          }
        >
          <TextField
            testid={`${ADD}.label`}
            value={label}
            onChange={setLabel}
            placeholder="Work"
            mono={false}
            className="w-[180px]"
          />
        </SettingRow>
        <SettingRow
          testid={`${ADD}.field`}
          dataId="key"
          label="API key"
          description="Stored once; delivered to the engines below."
        >
          <TextField
            type="password"
            testid={`${ADD}.keyInput`}
            value={key}
            onChange={setKey}
            placeholder="Paste the key"
            className="w-[180px]"
          />
        </SettingRow>
        <SettingRow testid={`${ADD}.field`} dataId="engines" label="Engines">
          <ChipSet
            testid={`${ADD}.engines`}
            value={engines}
            options={ENGINES.map((engine) => ({ value: engine, label: engine }))}
            onToggle={(value) =>
              setEngines((current) =>
                current.includes(value as ConfigurableHarnessId)
                  ? current.filter((engine) => engine !== value)
                  : [...current, value as ConfigurableHarnessId]
              )
            }
          />
        </SettingRow>
        <SettingRow
          testid={`${ADD}.field`}
          dataId="endpoint"
          label="Endpoint"
          description={
            catalog === null ? (
              'Reading the catalog…'
            ) : detected.baseUrl && detected.protocol ? (
              <span data-testid={`${ADD}.endpointFound`}>
                {`${detected.baseUrl} · ${detected.protocol} · from ${origin.name}’s catalog`}
              </span>
            ) : urlError ? (
              <span data-testid={`${ADD}.urlError`} className="text-danger">
                {urlError}
              </span>
            ) : (
              <span data-testid={`${ADD}.endpointAsk`}>
                {`${origin.name}’s catalog does not say ${endpointAsk}.`}
              </span>
            )
          }
        >
          {catalog !== null && !detected.baseUrl && (
            <TextField
              testid={`${ADD}.baseUrl`}
              value={typedUrl}
              onChange={setTypedUrl}
              placeholder="https://…/v1"
              className="w-[220px]"
            />
          )}
          {catalog !== null && !detected.protocol && (
            <SelectField
              testid={`${ADD}.protocol`}
              value={typedProtocol}
              placeholder="Which API?"
              options={PROTOCOL_OPTIONS}
              onChange={(value) => setTypedProtocol(value as SharedProviderProtocol)}
            />
          )}
        </SettingRow>
      </SheetGroup>

      <SheetGroup testid={`${ADD}.group`} id="models" label="Models">
        <SettingRow
          testid={`${ADD}.models`}
          layout="stacked"
          label="Models to declare"
          description={
            <>
              {`${seedText} Details (context, reasoning, vision) are copied from the catalog. ${picked.length} selected.`}
              {capped && <> {capNote(ADD)}</>}
            </>
          }
        >
          {catalog === null ? (
            <span className="text-[12px] text-text-secondary">Reading the catalog…</span>
          ) : catalog.length === 0 ? (
            <span data-testid={`${ADD}.catalogEmpty`} className="text-[12px] text-text-secondary">
              Neither engine lists {origin.name}’s models right now, so there is nothing to copy.
            </span>
          ) : (
            <ModelCurationList
              testid={`${ADD}.list`}
              models={catalog}
              selected={picked}
              onSet={pick}
              total={catalog.length}
              filter={view.filter}
              onFilterChange={view.setFilter}
              facets={view.facets}
              onFacetsChange={view.setFacets}
              sort={view.sort}
              onSortChange={view.setSort}
            />
          )}
        </SettingRow>
      </SheetGroup>
    </SheetFrame>
  )
}

// ── Refresh from catalog ─────────────────────────────────────────────────────

export function RefreshModelsSheet({
  definition,
  originName,
  onClose,
  onSaved
}: {
  /** A custom definition with `derivedFrom` — a second key's entry. */
  definition: SharedProviderDefinition
  /** The origin's display name ("OpenRouter"). */
  originName: string
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const vendorId = definition.derivedFrom ?? definition.id
  const declaredIds = useMemo(() => definition.models.map((model) => model.id), [definition])
  const [catalog, setCatalog] = useState<CloneCatalogModel[] | null>(null)
  const [picked, setPicked] = useState<string[]>(declaredIds)
  const [capped, setCapped] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = useListView()

  useEffect(() => {
    let cancelled = false
    void loadVendorCatalog(vendorId).then((models) => {
      if (!cancelled) setCatalog(models)
    })
    return () => {
      cancelled = true
    }
  }, [vendorId])

  /**
   * The catalog, plus every declared model it no longer lists — those keep their
   * declaration, and stay in the list so they can still be unticked.
   */
  const rows = useMemo((): CurationModel[] => {
    if (!catalog) return []
    const listed = new Set(catalog.map((model) => model.id))
    return [
      ...catalog,
      ...definition.models
        .filter((model) => !listed.has(model.id))
        .map((model) => ({ id: model.id, name: model.name ?? model.id }))
    ]
  }, [catalog, definition])

  const listed = catalog ? new Set(catalog.map((model) => model.id)) : new Set<string>()
  const refreshed = declaredIds.filter((id) => listed.has(id)).length
  const offered = catalog ? catalog.filter((model) => !declaredIds.includes(model.id)).length : 0

  const pick = (next: string[]): void => {
    if (!withinCap(next, picked)) {
      setCapped(true)
      return
    }
    setCapped(false)
    setPicked(next)
  }

  const save = async (): Promise<void> => {
    if (!catalog || picked.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await window.api.saveSharedProvider({
        ...definition,
        models: declareModels(picked, catalog, definition.models),
        copiedAt: today()
      })
      await onSaved()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SheetFrame
      testid={REFRESH}
      dataId={definition.id}
      title={`${definition.name} · refresh from catalog`}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1 min-w-0 truncate text-[12px] text-text-secondary">
            {error ? (
              <span data-testid={`${REFRESH}.error`} className="text-danger">
                {error}
              </span>
            ) : (
              'Saved to the vault, then delivered to each enabled engine.'
            )}
          </span>
          <Button variant="link" testid={`${REFRESH}.cancel`} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            testid={`${REFRESH}.save`}
            disabled={busy || catalog === null || picked.length === 0}
            onClick={() => void save()}
          >
            Refresh models
          </Button>
        </>
      }
    >
      <SheetGroup testid={`${REFRESH}.group`} id="models" label="Declared models">
        <SettingRow
          testid={`${REFRESH}.models`}
          layout="stacked"
          label={`From ${originName}’s catalog`}
          description={
            catalog === null ? (
              'Reading the catalog…'
            ) : (
              <span data-testid={`${REFRESH}.summary`}>
                {`${refreshed} of ${declaredIds.length} declared models get ${originName}’s current details. ${offered} more in the catalog — tick any to add them. ${picked.length} selected.`}
                {capped && <> {capNote(REFRESH)}</>}
              </span>
            )
          }
        >
          {catalog !== null && (
            <ModelCurationList
              testid={`${REFRESH}.list`}
              models={rows}
              selected={picked}
              onSet={pick}
              total={rows.length}
              filter={view.filter}
              onFilterChange={view.setFilter}
              facets={view.facets}
              onFacetsChange={view.setFacets}
              sort={view.sort}
              onSortChange={view.setSort}
            />
          )}
        </SettingRow>
      </SheetGroup>
    </SheetFrame>
  )
}
