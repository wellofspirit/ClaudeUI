import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings } from '../../stores/session-store'
import type { EngineConfig, EngineId, VendorConfig } from '../../../../shared/types'
import { engineMeta } from '../../../../shared/engine-meta'
import type { SettingItem } from './settings-sections'
import { APPLIES_ON_LABEL, Button } from './settings-controls'
import { groupKey } from './View'
import {
  PAGES,
  RAIL_GROUPS,
  appliesOnOf,
  enginesOf,
  itemsFor,
  noteOf,
  pageOf,
  searchSettings,
  storageOf,
  visibleGroups,
  type RailGroupId,
  type SettingsGroup,
  type SettingsPage
} from './settings-pages'
import type {
  SettingsPageId,
  SettingsRenderContext,
  SettingsTarget,
  VersionInfo
} from './settings-target'
import { useSwipeTabs } from '../../hooks/useSwipeTabs'

/**
 * The phone's props: the shared half of the desktop view's, plus the three the
 * container computes for BOTH forks (`engineByGroup` / `onSelectEngine` /
 * `navigate`). Page and group navigation is NOT here — a phone shows several
 * pages at once as accordions, so "the active page" is a set this view owns,
 * not a single value the container could hand down.
 */
export interface SettingsMobileViewProps {
  settings: AppSettings
  updateSettings: (patch: Partial<AppSettings>) => void
  engineConfig: EngineConfig
  updateEngineConfig: (patch: Partial<EngineConfig>) => void
  vendorConfig: VendorConfig
  updateVendorConfig: (patch: Partial<VendorConfig>) => void
  versionInfo: VersionInfo | null
  /** `<pageId>/<groupId>` → the engine its segment currently shows. */
  engineByGroup: Record<string, EngineId>
  onSelectEngine: (key: string, engine: EngineId) => void
  navigate: (target: SettingsTarget) => void
  search: string
  onSearchChange: (value: string) => void
  onClose: () => void
  /** A page/group deep link: opens that page, on its rail group's tab. */
  initialTarget?: SettingsTarget
}

/**
 * Mobile (viewport ≤768px) settings UI — ADR-048's content-takeover pattern on
 * ADR-065's page model.
 *
 * The desktop dialog is a 1040×700 modal: a 204px page rail on the left, one
 * scrolling page of group cards on the right. Neither half survives a 360px
 * phone, so this view re-presents the SAME model with the same container behind
 * it (ADR-048 amendment item 2 — the owner picked tabs + swipe + accordions
 * over a drill-down stack):
 *
 *   • a tab per RAIL GROUP — App / Features / Engines — widened to fill, with a
 *     horizontal swipe on the content area as the second way to move between
 *     adjacent tabs;
 *   • the tab's PAGES as accordions, so "which page" stops needing a permanent
 *     204px column. Several may be open, and the open set survives tab switches
 *     and search;
 *   • inside an open page, the same GROUPS the desktop draws: header (label,
 *     engine segment, badge, storage tag), a card of rows, the note with its
 *     applies-later badge;
 *   • search that goes WIDE instead of deep — one flat list of live rows across
 *     every page, because a phone user searching "sandbox" should not first have
 *     to know it lives under Claude.
 *
 * Row bodies are reused verbatim: every one is rendered through the same
 * `item.render(...)` call the desktop makes, with the same seven arguments. This
 * is a presentation fork, not a second settings implementation.
 *
 * The group chrome is deliberately REBUILT here from the same class tokens
 * rather than imported from `View.tsx`: the desktop shell renders one page with
 * a scroll-spy rail and a 240px control column, none of which applies at 390px,
 * and this phase must leave `View.tsx` untouched. The two therefore share the
 * MODEL (`settings-pages.tsx`) and the tokens, not the markup.
 *
 * Lazily mounted, deliberately: `settings-sections.tsx` is ~200KB of definitions
 * and several panes fetch on mount, so a collapsed page renders nothing at all.
 * That matches desktop, which only ever mounts the one selected page.
 *
 * No version footer: ADR-065 moved versions into Advanced › About, which this
 * view now renders like every other group.
 */

/**
 * How many search hits render at once. Mirrors the desktop cap for the same
 * reason: hits are LIVE rows, so each bucket mounts a real pane and a
 * one-character query matches 47 groups. The bucketing below is a second copy
 * of `View.tsx`'s only because that file is frozen this phase; the two must not
 * be allowed to drift (ADR-065 phase 7 folds them together).
 */
const MAX_RESULT_BUCKETS = 8

function CrossIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function FileIcon(): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

/** The storage tag on a group header. Information, never navigation (ADR-065). */
function StorageTag({ file }: { file: string }): React.JSX.Element {
  return (
    <span
      data-testid="SettingsMobileView.groupStorage"
      title={`Written to ${file}`}
      className="shrink-0 inline-flex items-center gap-1.5 border border-border rounded px-1.5 py-px font-mono text-[10.5px] leading-4 text-text-muted whitespace-nowrap"
    >
      <FileIcon />
      {file}
    </span>
  )
}

/**
 * The header's engine segment: one items list per engine, one shown at a time.
 * Taller than the desktop's — this one is a touch target.
 */
function EngineSegment({
  groupId,
  engines,
  value,
  onChange
}: {
  groupId: string
  engines: EngineId[]
  value: EngineId
  onChange: (engine: EngineId) => void
}): React.JSX.Element {
  return (
    <span
      data-testid="SettingsMobileView.engineSegment"
      data-id={groupId}
      className="shrink-0 inline-flex items-center gap-0.5 bg-bg-input border border-border rounded-md p-0.5"
    >
      {engines.map((engine) => (
        <button
          key={engine}
          type="button"
          data-testid="SettingsMobileView.engineSegment.option"
          data-id={engine}
          onClick={() => onChange(engine)}
          className={`px-3 py-1.5 text-[12px] leading-4 rounded transition-colors ${
            engine === value
              ? 'bg-accent/15 text-accent font-medium'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          {engineMeta(engine).label}
        </button>
      ))}
    </span>
  )
}

/** A card of rows: the only container a setting is ever drawn in (ADR-065). */
function GroupCard({
  items,
  render
}: {
  items: SettingItem[]
  render: (item: SettingItem) => React.JSX.Element
}): React.JSX.Element {
  return (
    <div className="border border-border rounded-lg bg-bg-secondary overflow-hidden divide-y divide-border/55">
      {items.map((item) => (
        <div key={item.key} data-testid="SettingsMobileView.item" data-id={item.key}>
          {render(item)}
        </div>
      ))}
    </div>
  )
}

/**
 * A group header. `flex-wrap` where the desktop is a fixed 32px row: at 390px a
 * label plus a three-engine segment plus a storage tag does not fit on one line.
 *
 * The label is `mr-auto shrink-0` and deliberately NOT truncated — the desktop's
 * `flex-1 min-w-0 truncate` turns "Dispatch into" into "D" once a three-engine
 * segment claims the line. Here the CONTROLS wrap to a second, right-aligned
 * line (`justify-end`) and the group keeps its name.
 */
function GroupHeader({
  group,
  engine,
  engines,
  onSelectEngine
}: {
  group: SettingsGroup
  engine: EngineId | undefined
  /** Empty when the group follows a sibling's segment (`engineFrom`). */
  engines: EngineId[]
  onSelectEngine: (engine: EngineId) => void
}): React.JSX.Element {
  const storage = storageOf(group, engine)
  return (
    <div
      data-testid="SettingsMobileView.groupHeader"
      className="flex flex-wrap items-center justify-end gap-2 px-1 pt-4 pb-2"
    >
      <span
        data-testid="SettingsMobileView.groupLabel"
        className="mr-auto shrink-0 min-w-0 text-[11px] font-semibold uppercase tracking-wide text-text-secondary"
      >
        {group.label}
      </span>
      {engines.length > 0 && engine && (
        <EngineSegment
          groupId={group.id}
          engines={engines}
          value={engine}
          onChange={onSelectEngine}
        />
      )}
      {group.badge && (
        <span
          data-testid="SettingsMobileView.groupBadge"
          className="shrink-0 bg-text-muted/20 text-text-secondary text-[10.5px] font-semibold leading-4 px-[7px] rounded-full"
        >
          {group.badge}
        </span>
      )}
      {storage && <StorageTag file={storage} />}
      {group.action && (
        <Button
          testid="SettingsMobileView.groupAction"
          dataId={group.id}
          disabled={group.action.disabled}
          title={group.action.title}
          // Same event channel as the desktop header — a static group definition
          // holds no closure. See `SettingsGroup.action`.
          onClick={() => window.dispatchEvent(new CustomEvent(group.action!.event))}
        >
          {group.action.label}
        </Button>
      )}
    </div>
  )
}

/** The one line under a card, with the applies-later badge (ADR-065). */
function GroupNote({
  group,
  engine
}: {
  group: SettingsGroup
  engine: EngineId | undefined
}): React.JSX.Element | null {
  const note = noteOf(group, engine)
  if (!note) return null
  const appliesOn = appliesOnOf(group, engine)
  return (
    <div
      data-testid="SettingsMobileView.groupNote"
      className="flex flex-wrap items-center gap-2 pt-2 px-1 text-[12px] leading-4 text-text-secondary"
    >
      {appliesOn && (
        <span
          data-testid="SettingsMobileView.groupNote.badge"
          data-id={appliesOn}
          className="shrink-0 bg-warning/15 text-warning text-[10.5px] font-semibold tracking-[0.02em] leading-4 px-[7px] rounded-full"
        >
          {APPLIES_ON_LABEL[appliesOn]}
        </span>
      )}
      <span>{note}</span>
    </div>
  )
}

export function SettingsMobileView({
  settings,
  updateSettings,
  engineConfig,
  updateEngineConfig,
  vendorConfig,
  updateVendorConfig,
  versionInfo,
  engineByGroup,
  onSelectEngine,
  navigate,
  search,
  onSearchChange,
  onClose,
  initialTarget
}: SettingsMobileViewProps): React.JSX.Element {
  /**
   * The tab (a rail group) and the set of unfolded pages. Seeded from the deep
   * link so the FIRST paint is already where the caller asked for — the effect
   * below re-applies it whenever the target changes afterwards.
   */
  const [activeRail, setActiveRail] = useState<RailGroupId>(() =>
    initialTarget ? pageOf(initialTarget.page).rail : 'app'
  )
  /**
   * Which pages are unfolded. One flat set: a page id is unique across every
   * rail group, so this IS per-tab state without the bookkeeping. Several may be
   * open at once, and the set survives tab switches and search, so going back to
   * a tab restores what you had unfolded.
   */
  const [expanded, setExpanded] = useState<Set<SettingsPageId>>(() =>
    initialTarget ? new Set([initialTarget.page]) : new Set()
  )
  /**
   * The group a deep link (or a cross-link) asked to be scrolled to, keyed by
   * `<pageId>/<groupId>`. The nonce is what makes a REPEAT request to the same
   * group scroll again.
   */
  const [scrollTarget, setScrollTarget] = useState<{ key: string; nonce: number } | null>(null)
  const nonce = useRef(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const groupRefs = useRef<Map<string, HTMLElement>>(new Map())

  const openPage = useCallback((target: SettingsTarget): void => {
    setActiveRail(pageOf(target.page).rail)
    setExpanded((prev) => (prev.has(target.page) ? prev : new Set(prev).add(target.page)))
    if (target.group) {
      nonce.current += 1
      setScrollTarget({ key: groupKey(target.page, target.group), nonce: nonce.current })
    }
  }, [])

  const targetPage = initialTarget?.page
  const targetGroup = initialTarget?.group
  useEffect(() => {
    if (!targetPage) return
    openPage({ page: targetPage, group: targetGroup })
  }, [targetPage, targetGroup, openPage])

  const togglePage = useCallback((id: SettingsPageId) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  /**
   * All three tabs share one scroll container, so switching tabs would otherwise
   * inherit the previous tab's scrollTop — landing you in the middle of a short
   * list, or past the end of it. Keyed to `activeRail` ALONE on purpose:
   * unfolding a page or typing in the search box must leave the scroll position
   * exactly where the user put it.
   *
   * Declared BEFORE the scroll-into-view effect below, so a cross-link that
   * changes tab and asks for a group still ends up at the group.
   */
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [activeRail])

  useEffect(() => {
    if (!scrollTarget) return
    // jsdom implements neither scrollIntoView nor layout, so guard rather than
    // let a component test explode on a purely visual affordance.
    groupRefs.current.get(scrollTarget.key)?.scrollIntoView?.({ block: 'start' })
  }, [scrollTarget])

  const q = search.trim()
  const searching = q.length > 0

  const railIndex = Math.max(
    0,
    RAIL_GROUPS.findIndex((g) => g.id === activeRail)
  )

  const handleSwipe = useCallback(
    (nextIndex: number) => setActiveRail(RAIL_GROUPS[nextIndex].id),
    []
  )

  // Swiping while the flat result list is up would move a tab bar that is not
  // even on screen, so the gesture is off during search.
  useSwipeTabs(contentRef, {
    index: railIndex,
    count: RAIL_GROUPS.length,
    onChange: handleSwipe,
    enabled: !searching
  })

  /**
   * A cross-page link inside a row (Sessions › Command sandbox → Claude). The
   * container's `navigate` still runs — it owns `search`, and keeping the
   * desktop half in step means a rotation to a wide viewport lands on the same
   * page — but the tab and the accordion are this view's own state.
   */
  const handleNavigate = useCallback(
    (target: SettingsTarget): void => {
      navigate(target)
      openPage(target)
    },
    [navigate, openPage]
  )

  /**
   * The render arguments every item body takes. `ctx` is the 7th, positional
   * argument (see `SettingItem`) — the rows that show app metadata or link to
   * another page are the only ones that read it.
   */
  const ctx: SettingsRenderContext = useMemo(
    () => ({ versionInfo, navigate: handleNavigate }),
    [versionInfo, handleNavigate]
  )
  const renderItem = useCallback(
    (item: SettingItem): React.JSX.Element =>
      item.render(
        settings,
        updateSettings,
        engineConfig,
        updateEngineConfig,
        vendorConfig,
        updateVendorConfig,
        ctx
      ),
    [
      settings,
      updateSettings,
      engineConfig,
      updateEngineConfig,
      vendorConfig,
      updateVendorConfig,
      ctx
    ]
  )

  /**
   * The engine a group's card shows. `engineFrom` names the SIBLING group whose
   * segment this one follows, so two cards about the same target can never fall
   * out of step — the same rule the desktop applies.
   */
  const engineOf = useCallback(
    (pageId: SettingsPageId, group: SettingsGroup): EngineId | undefined => {
      if (!group.byEngine) return undefined
      const key = groupKey(pageId, group.engineFrom ?? group.id)
      return engineByGroup[key] ?? enginesOf(group)[0]
    },
    [engineByGroup]
  )

  /** The pages of the active tab. */
  const pages = useMemo(() => PAGES.filter((p) => p.rail === activeRail), [activeRail])

  /** Search hits, bucketed by the (page, group, engine) they came from. */
  const buckets = useMemo(() => {
    if (!searching) return []
    const out: Array<{
      id: string
      page: SettingsPage
      group: SettingsGroup
      engine?: EngineId
      items: SettingItem[]
    }> = []
    const byId = new Map<string, (typeof out)[number]>()
    for (const hit of searchSettings(q)) {
      const id = `${hit.page.id}/${hit.group.id}${hit.engine ? `/${hit.engine}` : ''}`
      let bucket = byId.get(id)
      if (!bucket) {
        bucket = { id, page: hit.page, group: hit.group, engine: hit.engine, items: [] }
        byId.set(id, bucket)
        out.push(bucket)
      }
      bucket.items.push(hit.item)
    }
    return out
  }, [searching, q])

  const shownBuckets = useMemo(() => buckets.slice(0, MAX_RESULT_BUCKETS), [buckets])

  /** One group of an open page: header, card, note. */
  const renderGroup = (page: SettingsPage, group: SettingsGroup): React.JSX.Element => {
    const engine = engineOf(page.id, group)
    // A group that FOLLOWS a sibling's segment draws none itself.
    const engines = group.engineFrom ? [] : enginesOf(group)
    const key = groupKey(page.id, group.id)
    return (
      <div
        key={group.id}
        data-testid="SettingsMobileView.group"
        data-id={group.id}
        ref={(el) => {
          if (el) groupRefs.current.set(key, el)
          else groupRefs.current.delete(key)
        }}
        className="scroll-mt-2"
      >
        <GroupHeader
          group={group}
          engine={engine}
          engines={engines}
          onSelectEngine={(next) => onSelectEngine(key, next)}
        />
        <GroupCard items={itemsFor(group, engine)} render={renderItem} />
        <GroupNote group={group} engine={engine} />
      </div>
    )
  }

  return (
    <div
      data-testid="SettingsMobileView"
      className="fixed inset-0 z-[100] bg-bg-primary flex flex-col animate-fade-in"
    >
      {/* Header */}
      <div
        className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-border"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-accent shrink-0"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
        <span className="flex-1 text-[14px] font-medium text-text-primary">Settings</span>
        <button
          data-testid="SettingsMobileView.close"
          onClick={onClose}
          className="shrink-0 w-10 h-10 -mr-2 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          title="Close"
        >
          <CrossIcon />
        </button>
      </div>

      {/* Search — never autofocused: a soft keyboard covering the settings the
          user came to read is not a helpful way to open the screen. */}
      <div className="shrink-0 px-3 py-2 border-b border-border/50">
        <div className="relative">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            data-testid="SettingsMobileView.search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search all settings…"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            className="w-full bg-bg-input border border-border/50 rounded-md pl-8 pr-8 py-2 text-[13px] text-text-secondary placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors"
          />
          {searching && (
            <button
              data-testid="SettingsMobileView.clearSearch"
              onClick={() => onSearchChange('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-text-muted hover:text-text-primary"
              title="Clear search"
            >
              <CrossIcon />
            </button>
          )}
        </div>
      </div>

      {/* Tab bar — one per rail group; hidden during search, which is
          deliberately cross-page. */}
      {!searching && (
        <div className="shrink-0 flex items-center border-b border-border bg-bg-secondary/30">
          {RAIL_GROUPS.map((railGroup) => (
            <button
              key={railGroup.id}
              data-testid="SettingsMobileView.tab"
              data-id={railGroup.id}
              data-active={activeRail === railGroup.id ? 'true' : 'false'}
              onClick={() => setActiveRail(railGroup.id)}
              className={`relative flex-1 min-w-0 px-1 py-2.5 text-[12px] font-medium truncate transition-colors ${
                activeRail === railGroup.id ? 'text-accent' : 'text-text-muted'
              }`}
            >
              {railGroup.label}
              {activeRail === railGroup.id && (
                <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-accent rounded-full" />
              )}
            </button>
          ))}
        </div>
      )}

      {/* Content. `touch-action: pan-y` hands vertical panning to the browser and
          leaves horizontal drags to useSwipeTabs — which is why the swipe never
          needs preventDefault(). No transform on this element: the panes mount
          `position: fixed` modals (model allowlist, provider config), and a
          transformed ancestor would re-anchor them. */}
      <div
        ref={contentRef}
        data-testid="SettingsMobileView.content"
        className="flex-1 overflow-y-auto overscroll-contain"
        style={{ touchAction: 'pan-y' }}
      >
        {searching ? (
          <div data-testid="SettingsMobileView.searchResults" className="px-3 pb-6">
            {buckets.length === 0 ? (
              <div className="px-1 py-8 text-center text-[13px] text-text-muted">
                No settings match “{q}”
              </div>
            ) : (
              shownBuckets.map((bucket) => (
                <div
                  key={bucket.id}
                  data-testid="SettingsMobileView.searchHit"
                  // The engine is part of a byEngine bucket's identity, or the
                  // same id would appear two or three times (ADR-027).
                  data-id={bucket.id}
                >
                  <div className="flex flex-wrap items-center gap-2 px-1 pt-4 pb-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                      {bucket.page.label} › {bucket.group.label}
                    </span>
                    {bucket.engine && (
                      <span className="shrink-0 border border-border rounded-full px-[7px] text-[10.5px] leading-4 text-text-secondary">
                        {engineMeta(bucket.engine).label}
                      </span>
                    )}
                  </div>
                  <GroupCard items={bucket.items} render={renderItem} />
                </div>
              ))
            )}
            {buckets.length > shownBuckets.length && (
              <div
                data-testid="SettingsMobileView.moreResults"
                className="mt-4 px-1 text-[12px] text-text-secondary"
              >
                {buckets.length - shownBuckets.length} more groups match — keep typing to narrow it.
              </div>
            )}
          </div>
        ) : (
          <div className="pb-6">
            {pages.map((page) => {
              const open = expanded.has(page.id)
              return (
                <div
                  key={page.id}
                  data-testid="SettingsMobileView.page"
                  data-id={page.id}
                  data-open={open ? 'true' : 'false'}
                  className="border-b border-border/40"
                >
                  <button
                    data-testid="SettingsMobileView.pageToggle"
                    data-id={page.id}
                    aria-expanded={open}
                    onClick={() => togglePage(page.id)}
                    className="w-full min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 text-left"
                  >
                    <span className={open ? 'text-accent shrink-0' : 'text-text-muted shrink-0'}>
                      {page.icon}
                    </span>
                    <span
                      className={`flex-1 min-w-0 truncate text-[13px] ${open ? 'text-accent' : 'text-text-secondary'}`}
                    >
                      {page.label}
                    </span>
                    <ChevronIcon open={open} />
                  </button>
                  {open && (
                    <div
                      data-testid="SettingsMobileView.pageContent"
                      data-id={page.id}
                      className="px-3 pb-3"
                    >
                      <div className="px-1 text-[12px] leading-4 text-text-secondary">
                        {page.description}
                      </div>
                      {visibleGroups(page).map((group) => renderGroup(page, group))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
