/**
 * ModelCurationList — the "Models in the picker" control on the provider Manage
 * sheet, as a grouped, filterable LIST (owner-approved mockup `0a41c623`,
 * settings-v2 follow-up G).
 *
 * WHY NOT CHIPS. The row vocabulary's chip set (ADR-065) is right for a fixed
 * handful of values and wrong for a catalog: OpenRouter delivers 358 models, a
 * chip shows only the display name, and `GPT-5.6 Luna` from OpenAI and the same
 * name proxied by a gateway are then indistinguishable. So this control is a
 * list — name AND mono id on every line — grouped by the id's VENDOR PREFIX,
 * with facets that narrow and one bulk action that acts on what is shown.
 *
 * IT OWNS NO STATE OF RECORD, and it performs no IPC. `selected` comes in,
 * `onSet` goes out, and `onSet` is the ONLY writer: a single row toggle, a
 * vendor's checkbox and Select all all reduce to "here is the next list", so
 * the caller's orphan guard and its commit-per-change sit on one path rather
 * than three. Search / facets / sort are LIFTED to the caller too — not because
 * this component wants them there, but because `ModelCurationActions` renders
 * in the row's TITLE line (`SettingRow`'s `trailing`), outside this subtree,
 * and "Select all" has to mean "all of what the list is showing".
 *
 * `visibleModels` is that shared predicate, exported so the two halves and the
 * tests cannot disagree about what "shown" means.
 *
 * WHAT THE FILTERS DO, precisely, because the distinction is the design:
 *
 *  · search and facets NARROW (AND-ed). A facet never selects anything —
 *    `Selected` is a view of what is in the picker today, not a bulk action.
 *  · a group is EXPANDED by default only when it has a selection; while a
 *    filter is active every group that still matches is expanded, and a user's
 *    own toggle wins until the filter changes (which resets them).
 *  · previews (`ROW_PREVIEW`, `GROUP_HEADERS_PREVIEW`) exist only when NO
 *    filter is active. Once the user has narrowed, hiding matches behind
 *    "Show more" would hide the very thing they searched for.
 */

import { useState } from 'react'
import { ChevronIcon } from '../shared/ChevronIcon'
import { Button } from './settings-controls'

/** Rows per expanded group before "Show n more" (mockup density). */
export const ROW_PREVIEW = 3
/** Vendor groups before "… n more vendors" (mockup density). */
export const GROUP_HEADERS_PREVIEW = 8

/**
 * The catalog facts a row needs. Structurally `OpencodeCatalogModel`, declared
 * here so the control is not opencode-shaped — pi's catalog carries the same
 * four flags and is the obvious next caller.
 */
export interface CurationModel {
  id: string
  name: string
  releaseDate?: string
  free?: boolean
  reasoning?: boolean
  toolCalling?: boolean
}

export type CurationFacet = 'selected' | 'free' | 'reasoning' | 'tools'
export type CurationSort = 'newest' | 'name'

/** The vendor prefix a model groups under: `openai/gpt-6` → `openai`. */
export function modelPrefix(id: string): string {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash) : 'other'
}

/**
 * The vendors that show up in every gateway catalog, spelled the way their own
 * docs spell them. Anything else gets its first letter capitalised — a wrong
 * guess here is a cosmetic miss on a long tail, and an incomplete map is not a
 * reason to print `x-ai` at people.
 */
const VENDOR_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  moonshotai: 'Moonshot',
  nvidia: 'NVIDIA',
  'meta-llama': 'Meta',
  mistralai: 'Mistral',
  'x-ai': 'xAI',
  qwen: 'Qwen',
  'z-ai': 'Z.ai',
  minimax: 'MiniMax',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  amazon: 'Amazon',
  microsoft: 'Microsoft',
  xiaomi: 'Xiaomi',
  baidu: 'Baidu',
  inception: 'Inception',
  sakana: 'Sakana'
}

export function vendorLabel(prefix: string): string {
  return VENDOR_LABELS[prefix] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * `2026-07-31` → `Jul 2026`. Parsed off the STRING, not through `Date`: the
 * catalog's dates are calendar dates, and `new Date('2026-07-01')` is UTC
 * midnight, which prints as June in every timezone west of London.
 */
function formatReleaseDate(iso: string | undefined): string {
  const match = /^(\d{4})-(\d{2})/.exec(iso ?? '')
  if (!match) return ''
  const month = MONTHS[Number(match[2]) - 1]
  return month ? `${month} ${match[1]}` : ''
}

const displayName = (model: CurationModel): string => model.name || model.id

/** Every model the search text and the active facets leave visible. */
export function visibleModels(
  models: CurationModel[],
  selected: string[],
  filter: string,
  facets: CurationFacet[]
): CurationModel[] {
  const q = filter.trim().toLowerCase()
  const selectedSet = new Set(selected)
  return models.filter((model) => {
    if (q && !model.id.toLowerCase().includes(q) && !model.name.toLowerCase().includes(q))
      return false
    if (facets.includes('selected') && !selectedSet.has(model.id)) return false
    if (facets.includes('free') && !model.free) return false
    if (facets.includes('reasoning') && !model.reasoning) return false
    if (facets.includes('tools') && !model.toolCalling) return false
    return true
  })
}

const isFilterActive = (filter: string, facets: CurationFacet[]): boolean =>
  filter.trim().length > 0 || facets.length > 0

const union = (selected: string[], add: string[]): string[] => {
  const have = new Set(selected)
  return [...selected, ...add.filter((id) => !have.has(id))]
}

// ── Bulk actions (rendered in the row's TITLE line, not in this subtree) ─────

/**
 * `Select all n` / `Clear`, both acting on what search + facets currently show
 * — collapsed groups included, because "shown" is what the FILTERS say, not
 * what the disclosure state happens to reveal. Search a vendor, press Select
 * all: a vendor is curated in two moves.
 */
export function ModelCurationActions({
  testid,
  models,
  selected,
  onSet,
  filter,
  facets
}: {
  testid: string
  models: CurationModel[]
  selected: string[]
  onSet: (next: string[]) => void
  filter: string
  facets: CurationFacet[]
}): React.JSX.Element {
  const shown = visibleModels(models, selected, filter, facets)
  const shownIds = shown.map((model) => model.id)
  const selectedSet = new Set(selected)
  const selectedShown = shownIds.filter((id) => selectedSet.has(id)).length

  return (
    <span className="shrink-0 flex items-center gap-3">
      <Button
        variant="link"
        testid={`${testid}.selectAll`}
        disabled={shown.length === 0 || selectedShown === shown.length}
        onClick={() => onSet(union(selected, shownIds))}
      >
        Select all {shown.length}
      </Button>
      <Button
        variant="link"
        testid={`${testid}.clearShown`}
        disabled={selectedShown === 0}
        onClick={() => {
          const drop = new Set(shownIds)
          onSet(selected.filter((id) => !drop.has(id)))
        }}
      >
        Clear
      </Button>
    </span>
  )
}

// ── Atoms ────────────────────────────────────────────────────────────────────

/**
 * The tri-state box. `mixed` is an unfilled box with an accent bar rather than
 * a filled one: a half-selected vendor must not read as a selected vendor at a
 * glance, which is the whole reason the state exists.
 */
function CheckBox({ state }: { state: 'on' | 'mixed' | 'off' }): React.JSX.Element {
  return (
    <span
      className={`w-3.5 h-3.5 shrink-0 rounded-[3px] border flex items-center justify-center ${
        state === 'on' ? 'bg-accent border-accent' : 'border-border-bright'
      }`}
    >
      {state === 'on' && (
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="text-bg-secondary"
        >
          <path d="m5 13 4 4L19 7" />
        </svg>
      )}
      {state === 'mixed' && <span className="w-[7px] h-[2px] rounded-full bg-accent" />}
    </span>
  )
}

function ModelTags({ testid, model }: { testid: string; model: CurationModel }): React.JSX.Element {
  const tag = (id: string, label: string, className: string): React.JSX.Element => (
    <span
      key={id}
      data-testid={`${testid}.tag`}
      data-id={id}
      className={`shrink-0 rounded px-1.5 text-[10.5px] leading-4 ${className}`}
    >
      {label}
    </span>
  )
  return (
    <>
      {model.reasoning && tag('reasoning', 'reasoning', 'bg-bg-hover text-text-muted')}
      {model.toolCalling && tag('tools', 'tools', 'bg-bg-hover text-text-muted')}
      {model.free && tag('free', 'free', 'bg-emerald-500/15 text-emerald-300 font-medium')}
    </>
  )
}

// ── The list ─────────────────────────────────────────────────────────────────

interface Group {
  prefix: string
  label: string
  /** Every model in the group, filters ignored — what the header counts. */
  all: CurationModel[]
  /** The ones search + facets leave visible. */
  shown: CurationModel[]
  selectedCount: number
  freeCount: number
}

export function ModelCurationList({
  testid,
  models,
  selected,
  onSet,
  filterRef,
  total,
  filter,
  onFilterChange,
  facets,
  onFacetsChange,
  sort,
  onSortChange,
  filterTestid
}: {
  /** `${SHEET}.models` — every part below is namespaced under it (ADR-027). */
  testid: string
  models: CurationModel[]
  selected: string[]
  /** The ONLY writer. Single toggles, vendor bulk and Select all all land here. */
  onSet: (next: string[]) => void
  filterRef?: React.RefObject<HTMLInputElement | null>
  /** The catalog size, for the search placeholder. */
  total: number
  filter: string
  onFilterChange: (next: string) => void
  facets: CurationFacet[]
  onFacetsChange: (next: CurationFacet[]) => void
  sort: CurationSort
  onSortChange: (next: CurationSort) => void
  /**
   * Overrides the search input's `${testid}.filter`. The Manage sheet passes
   * its pre-existing `ProviderSheet.modelFilter`, which "Curate models ›"
   * focuses and the sheet's tests address — one node cannot carry two
   * `data-testid` values, and an id already in the verification contract is
   * not ours to rename.
   */
  filterTestid?: string
}): React.JSX.Element {
  /**
   * Disclosure state, keyed by the filter it was formed under: a filter change
   * drops it, so "every matching group is open while searching" is not fighting
   * a stale set of user toggles. Storing the key WITH the map (rather than
   * resetting from an effect) keeps the reset in the same render as the change.
   */
  const filterKey = `${filter} ${[...facets].sort().join(',')}`
  const [expanded, setExpanded] = useState<{ key: string; map: Record<string, boolean> }>({
    key: filterKey,
    map: {}
  })
  /** Which groups the user asked past `ROW_PREVIEW` for. */
  const [showAllRows, setShowAllRows] = useState<Record<string, boolean>>({})
  /** Whether the vendor list is past `GROUP_HEADERS_PREVIEW`. */
  const [showAllVendors, setShowAllVendors] = useState(false)

  const filterActive = isFilterActive(filter, facets)
  const selectedSet = new Set(selected)
  const shown = visibleModels(models, selected, filter, facets)
  const shownSet = new Set(shown.map((model) => model.id))

  // Facet counts are over the WHOLE catalog, never over the current view: a
  // count that moved as you filtered would be unreadable as a total.
  const facetDefs: Array<{ id: CurationFacet; label: string; count: number }> = [
    { id: 'selected', label: 'Selected', count: selected.length },
    { id: 'free', label: 'Free', count: models.filter((m) => m.free).length },
    { id: 'reasoning', label: 'Reasoning', count: models.filter((m) => m.reasoning).length },
    { id: 'tools', label: 'Tool calling', count: models.filter((m) => m.toolCalling).length }
  ]

  // ── Grouping ───────────────────────────────────────────────────────────────

  const byPrefix = new Map<string, CurationModel[]>()
  for (const model of models) {
    const prefix = modelPrefix(model.id)
    const bucket = byPrefix.get(prefix)
    if (bucket) bucket.push(model)
    else byPrefix.set(prefix, [model])
  }
  /** One prefix (or none) is not a grouping — a provider with plain ids. */
  const flat = byPrefix.size < 2

  const groups: Group[] = [...byPrefix.entries()]
    .map(([prefix, all]) => ({
      prefix,
      label: vendorLabel(prefix),
      all,
      shown: all.filter((model) => shownSet.has(model.id)),
      selectedCount: all.filter((model) => selectedSet.has(model.id)).length,
      freeCount: all.filter((model) => model.free).length
    }))
    .sort((a, b) => {
      const aHas = a.selectedCount > 0
      const bHas = b.selectedCount > 0
      if (aHas !== bHas) return aHas ? -1 : 1
      if (aHas && a.selectedCount !== b.selectedCount) return b.selectedCount - a.selectedCount
      if (!aHas && a.all.length !== b.all.length) return b.all.length - a.all.length
      return a.label.localeCompare(b.label)
    })

  const matchingGroups = filterActive ? groups.filter((g) => g.shown.length > 0) : groups
  const previewGroups =
    flat || filterActive || showAllVendors
      ? matchingGroups
      : matchingGroups.slice(0, GROUP_HEADERS_PREVIEW)
  const hiddenVendors = matchingGroups.length - previewGroups.length

  // ── Disclosure ─────────────────────────────────────────────────────────────

  const expandedMap = expanded.key === filterKey ? expanded.map : {}
  const isExpanded = (group: Group): boolean =>
    flat || (expandedMap[group.prefix] ?? (filterActive ? true : group.selectedCount > 0))
  const toggleExpanded = (group: Group): void =>
    setExpanded({ key: filterKey, map: { ...expandedMap, [group.prefix]: !isExpanded(group) } })

  // ── Writes ─────────────────────────────────────────────────────────────────

  const toggleModel = (id: string): void =>
    onSet(selectedSet.has(id) ? selected.filter((value) => value !== id) : [...selected, id])

  const groupState = (group: Group): 'on' | 'mixed' | 'off' => {
    if (group.shown.length === 0) return 'off'
    const count = group.shown.filter((model) => selectedSet.has(model.id)).length
    return count === 0 ? 'off' : count === group.shown.length ? 'on' : 'mixed'
  }

  const toggleGroup = (group: Group): void => {
    const ids = group.shown.map((model) => model.id)
    if (groupState(group) === 'on') {
      const drop = new Set(ids)
      onSet(selected.filter((id) => !drop.has(id)))
    } else onSet(union(selected, ids))
  }

  const toggleFacet = (facet: CurationFacet): void =>
    onFacetsChange(
      facets.includes(facet) ? facets.filter((value) => value !== facet) : [...facets, facet]
    )

  // ── Row order ──────────────────────────────────────────────────────────────

  /** Selected first — what you curated must not fall off the bottom of a preview. */
  const orderedRows = (group: Group): CurationModel[] =>
    [...group.shown].sort((a, b) => {
      const aOn = selectedSet.has(a.id)
      const bOn = selectedSet.has(b.id)
      if (aOn !== bOn) return aOn ? -1 : 1
      if (sort === 'newest' && a.releaseDate !== b.releaseDate) {
        if (!a.releaseDate) return 1
        if (!b.releaseDate) return -1
        return a.releaseDate < b.releaseDate ? 1 : -1
      }
      return displayName(a).localeCompare(displayName(b)) || a.id.localeCompare(b.id)
    })

  // ── Parts ──────────────────────────────────────────────────────────────────

  function groupHeader(group: Group): React.JSX.Element {
    const open = isExpanded(group)
    const state = groupState(group)
    return (
      <span
        key={`head-${group.prefix}`}
        data-testid={`${testid}.group`}
        data-id={group.prefix}
        onClick={() => toggleExpanded(group)}
        className="flex items-center gap-2.5 px-3.5 py-2 bg-bg-tertiary/40 hover:bg-bg-tertiary/60 transition-colors cursor-default"
      >
        <span
          role="checkbox"
          aria-checked={state === 'on' ? true : state === 'mixed' ? 'mixed' : false}
          data-testid={`${testid}.groupToggle`}
          data-id={group.prefix}
          data-state={state}
          onClick={(e) => {
            e.stopPropagation()
            toggleGroup(group)
          }}
        >
          <CheckBox state={state} />
        </span>
        <button
          type="button"
          data-testid={`${testid}.groupExpand`}
          data-id={group.prefix}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            toggleExpanded(group)
          }}
          className="shrink-0 flex items-center cursor-default"
        >
          {/* The one chevron, rotated to a TREE caret: right when collapsed,
              down when open. `ChevronIcon`'s own flip is up/down, which is the
              vocabulary of a select field, not of a disclosure group. */}
          <span
            className={`inline-flex transition-transform duration-150 ${open ? '' : '-rotate-90'}`}
          >
            <ChevronIcon className="text-text-secondary" />
          </span>
        </button>
        <span className="shrink-0 text-[13px] leading-[18px] text-text-primary">{group.label}</span>
        <span className="min-w-0 truncate text-[11px] leading-4 text-text-muted">
          {`${group.prefix}/ · ${group.selectedCount} of ${group.all.length}`}
          {group.freeCount > 0 ? ` · ${group.freeCount} free` : ''}
        </span>
      </span>
    )
  }

  function modelRow(model: CurationModel): React.JSX.Element {
    const on = selectedSet.has(model.id)
    const date = formatReleaseDate(model.releaseDate)
    return (
      <button
        key={model.id}
        type="button"
        role="checkbox"
        aria-checked={on}
        data-testid={`${testid}.row`}
        data-id={model.id}
        onClick={() => toggleModel(model.id)}
        className="w-full flex items-center gap-2.5 px-3.5 py-[7px] text-left hover:bg-bg-hover/40 transition-colors cursor-default"
      >
        <CheckBox state={on ? 'on' : 'off'} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[13px] leading-[18px] text-text-primary">
            <span className="min-w-0 truncate">{displayName(model)}</span>
            <ModelTags testid={testid} model={model} />
          </span>
          <span className="block font-mono text-[11px] leading-4 text-text-muted truncate">
            {model.id}
          </span>
        </span>
        {date && <span className="shrink-0 text-[11px] leading-4 text-text-muted">{date}</span>}
      </button>
    )
  }

  function showMoreRow(group: Group, hidden: number): React.JSX.Element {
    return (
      <button
        key={`more-${group.prefix}`}
        type="button"
        data-testid={`${testid}.showMore`}
        data-id={group.prefix}
        onClick={() => setShowAllRows({ ...showAllRows, [group.prefix]: true })}
        className="w-full flex items-center gap-2.5 px-3.5 py-[7px] text-left hover:bg-bg-hover/40 transition-colors cursor-default"
      >
        {/* An empty box slot, so the link starts on the rows' text column. */}
        <span className="w-3.5 shrink-0" />
        <span className="text-[12px] leading-[18px] text-accent">Show {hidden} more</span>
      </button>
    )
  }

  const rowsOf = (group: Group): React.JSX.Element[] => {
    const ordered = orderedRows(group)
    const capped = !filterActive && !showAllRows[group.prefix]
    const visible = capped ? ordered.slice(0, ROW_PREVIEW) : ordered
    const parts = visible.map(modelRow)
    if (ordered.length > visible.length)
      parts.push(showMoreRow(group, ordered.length - visible.length))
    return parts
  }

  const items: React.JSX.Element[] = []
  for (const group of previewGroups) {
    if (!flat) items.push(groupHeader(group))
    if (isExpanded(group)) items.push(...rowsOf(group))
  }
  if (hiddenVendors > 0) {
    items.push(
      <button
        key="more-vendors"
        type="button"
        data-testid={`${testid}.moreVendors`}
        onClick={() => setShowAllVendors(true)}
        className="w-full flex items-center justify-center px-3.5 py-[7px] text-[11px] leading-4 text-accent hover:text-accent-hover transition-colors cursor-default"
      >
        … {hiddenVendors} more vendors — type to search, or show them
      </button>
    )
  }
  if (items.length === 0) {
    items.push(
      <span
        key="empty"
        data-testid={`${testid}.empty`}
        className="block px-3.5 py-[7px] text-[12px] leading-[18px] text-text-secondary"
      >
        {models.length === 0 ? 'No models in this provider’s catalog.' : 'No models match.'}
      </span>
    )
  }

  return (
    <span className="block">
      <input
        ref={filterRef}
        type="text"
        data-testid={filterTestid ?? `${testid}.filter`}
        value={filter}
        placeholder={`Search ${total} models by name or id…`}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onFilterChange(e.target.value)}
        className="w-full h-7 bg-bg-input border border-border rounded-md px-2.5 text-[12px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors"
      />

      <span className="mt-2 flex items-center gap-1.5 flex-wrap">
        {facetDefs
          .filter((facet) => facet.count > 0)
          .map((facet) => {
            const on = facets.includes(facet.id)
            return (
              <button
                key={facet.id}
                type="button"
                data-testid={`${testid}.facet`}
                data-id={facet.id}
                aria-pressed={on}
                onClick={() => toggleFacet(facet.id)}
                className={`rounded-full px-2.5 py-px text-[11px] leading-[18px] transition-colors cursor-default ${
                  on
                    ? 'bg-accent/15 text-accent'
                    : 'border border-border text-text-secondary hover:text-text-primary'
                }`}
              >
                {`${facet.label} · ${facet.count}`}
              </button>
            )
          })}
        <span className="ml-auto flex items-center gap-1 text-[11px] leading-4 text-text-muted">
          Sort:
          {(['newest', 'name'] as CurationSort[]).map((option, index) => (
            <span key={option} className="flex items-center gap-1">
              {index > 0 && <span>·</span>}
              <button
                type="button"
                data-testid={`${testid}.sort`}
                data-id={option}
                onClick={() => onSortChange(option)}
                className={`transition-colors cursor-default ${
                  sort === option
                    ? 'text-text-secondary'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {option === 'newest' ? 'Newest' : 'Name'}
              </button>
            </span>
          ))}
        </span>
      </span>

      {/* Full-bleed: the list's separators are the CARD's separators, so the
          negative margins undo the row's own padding rather than drawing a
          second, inset box inside it. */}
      <span className="block mt-2 -mx-3.5 -mb-2.5 divide-y divide-border/55">{items}</span>
    </span>
  )
}
