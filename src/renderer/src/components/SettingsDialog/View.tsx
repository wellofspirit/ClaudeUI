import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useSessionStore, type AppSettings } from '../../stores/session-store'
import type { EngineConfig, EngineId, VendorConfig } from '../../../../shared/types'
import { engineMeta } from '../../../../shared/engine-meta'
import type { SettingItem } from './settings-sections'
import { APPLIES_ON_LABEL, Button } from './settings-controls'
import {
  PAGES,
  RAIL_GROUPS,
  appliesOnOf,
  bucketSearchHits,
  enginesOf,
  itemsFor,
  noteOf,
  pageOf,
  storageOf,
  visibleGroups,
  type SettingsGroup
} from './settings-pages'
import { groupKey } from './settings-target'
import { ChevronIcon } from '../shared/ChevronIcon'
import type {
  SettingsPageId,
  SettingsRenderContext,
  SettingsTarget,
  VersionInfo
} from './settings-target'

export type { VersionInfo } from './settings-target'

export interface SettingsDialogViewProps {
  settings: AppSettings
  updateSettings: (patch: Partial<AppSettings>) => void
  engineConfig: EngineConfig
  updateEngineConfig: (patch: Partial<EngineConfig>) => void
  vendorConfig: VendorConfig
  updateVendorConfig: (patch: Partial<VendorConfig>) => void
  versionInfo: VersionInfo | null
  activePage: SettingsPageId
  onSelectPage: (page: SettingsPageId) => void
  /** The rail-highlighted group: set by scroll-spy, rail clicks and deep links. */
  activeGroup: string | null
  onActiveGroupChange: (group: string) => void
  /**
   * Bumped by the container whenever `activeGroup` was set IMPERATIVELY (a deep
   * link), which is the only case where the pane must scroll itself. Scroll-spy
   * updates must not, or the pane would fight the user's own scrolling.
   */
  scrollNonce: number
  /** `<pageId>/<groupId>` → the engine its segment currently shows. */
  engineByGroup: Record<string, EngineId>
  onSelectEngine: (key: string, engine: EngineId) => void
  search: string
  onSearchChange: (value: string) => void
  navigate: (target: SettingsTarget) => void
  onClose: () => void
}

/** How far below the pane's top edge a group header counts as "the current one". */
export const SPY_OFFSET_PX = 84

/**
 * How long after a programmatic scroll the spy stays quiet. `scrollIntoView` is
 * smooth-capable and fires a burst of scroll events on the way; letting the spy
 * answer them would re-mark the group the user scrolled AWAY from.
 */
const PROGRAMMATIC_SCROLL_MS = 700

/**
 * Which modifier to NAME in the search hint. Display only — the handler accepts
 * ctrl and meta everywhere. `window.api.platform` is 'web' for every host OS, so
 * a browser client's only signal about its keyboard is the UA hint (the rule
 * TopBar's shortcut tooltips already use).
 */
function isMacKeyboard(): boolean {
  const platform = window.api?.platform
  return platform === 'darwin' || (platform === 'web' && /^mac/i.test(navigator.platform ?? ''))
}

/**
 * Which group the rail should mark, given where the headers are.
 *
 * The last header at or above the spy line wins — EXCEPT at the bottom of the
 * pane, where the last group wins outright. A group near the end of a page can
 * never bring its header to the top edge (there is not enough content below it
 * to scroll), so without the `atBottom` case clicking the last sub-entry
 * scrolls correctly and is then immediately re-marked as the previous group.
 *
 * Pure and exported so this can be tested with fake rects — jsdom has no layout.
 */
export function pickActiveGroup(
  paneTop: number,
  headers: Array<{ id: string; top: number }>,
  atBottom: boolean
): string | null {
  if (headers.length === 0) return null
  if (atBottom) return headers[headers.length - 1].id
  const line = paneTop + SPY_OFFSET_PX
  let current: string | null = null
  for (const header of headers) if (header.top <= line) current = header.id
  return current
}

function CloseIcon(): React.JSX.Element {
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
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-text-muted"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
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
      data-testid="SettingsGroup.storage"
      title={`Written to ${file}`}
      className="shrink-0 inline-flex items-center gap-1.5 border border-border rounded px-1.5 py-px font-mono text-[10.5px] leading-4 text-text-muted whitespace-nowrap"
    >
      <FileIcon />
      {file}
    </span>
  )
}

/** The header's engine segment: one items list per engine, one shown at a time. */
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
      data-testid="SettingsGroup.engineSegment"
      data-id={groupId}
      className="shrink-0 inline-flex items-center gap-0.5 bg-bg-input border border-border rounded-md p-0.5"
    >
      {engines.map((engine) => (
        <button
          key={engine}
          type="button"
          data-testid="SettingsGroup.engineSegment.option"
          data-id={engine}
          onClick={() => onChange(engine)}
          className={`px-2.5 py-[3px] text-[12px] leading-4 rounded transition-colors cursor-default ${
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

/** A card of rows: the only container a setting is ever drawn in. */
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
        <div key={item.key} data-testid="SettingsItem" data-id={item.key}>
          {render(item)}
        </div>
      ))}
    </div>
  )
}

export function SettingsDialogView({
  settings,
  updateSettings,
  engineConfig,
  updateEngineConfig,
  vendorConfig,
  updateVendorConfig,
  versionInfo,
  activePage,
  onSelectPage,
  activeGroup,
  onActiveGroupChange,
  scrollNonce,
  engineByGroup,
  onSelectEngine,
  search,
  onSearchChange,
  navigate,
  onClose
}: SettingsDialogViewProps): React.JSX.Element {
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)
  const macKeyboard = useMemo(isMacKeyboard, [])
  const overlayRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const groupRefs = useRef<Map<string, HTMLElement>>(new Map())
  /** `performance.now()` before which scroll events are ours, not the user's. */
  const programmaticUntil = useRef(0)

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose()
    },
    [onClose]
  )

  const query = search.trim()
  const searching = query.length > 0

  const page = pageOf(activePage)
  const groups = useMemo(() => visibleGroups(page), [page])
  /**
   * The group the rail dots. Switching page clears `activeGroup`, and the spy
   * only speaks once the user scrolls — so without a display-side default the
   * rail shows a page's sub-entries with none of them marked. Display only: it
   * is never written back, because `null` is what tells the scroll effect that
   * nothing has asked to be scrolled to.
   */
  const highlighted = activeGroup ?? groups[0]?.id

  // Collapsing the rail must preserve the selected group and pane scroll.
  const [railOpen, setRailOpen] = useState(true)
  useEffect(() => {
    setRailOpen(true)
  }, [activePage])
  // Same-page deep links also reopen the rail; scroll-spy updates do not.
  useEffect(() => {
    if (scrollNonce > 0) setRailOpen(true)
  }, [scrollNonce])

  // Capability visibility is static; one-group pages need no disclosure.
  const expandablePages = useMemo(
    () => new Set(PAGES.filter((p) => visibleGroups(p).length > 1).map((p) => p.id)),
    []
  )
  const railId = useId()

  /**
   * The render arguments every item body takes. `ctx` is the 7th, positional
   * argument (see `SettingItem`) — the rows that show app metadata or link to
   * another page are the only ones that read it.
   */
  const ctx: SettingsRenderContext = useMemo(
    () => ({ versionInfo, navigate }),
    [versionInfo, navigate]
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

  const engineOf = useCallback(
    (group: SettingsGroup): EngineId | undefined => {
      if (!group.byEngine) return undefined
      // `engineFrom` names the SIBLING group whose segment this one follows, so
      // two cards about the same target can never fall out of step.
      const key = groupKey(activePage, group.engineFrom ?? group.id)
      return engineByGroup[key] ?? enginesOf(group)[0]
    },
    [activePage, engineByGroup]
  )

  const scrollToGroup = useCallback((id: string) => {
    // The scroll this starts must not be answered by the spy, or the clicked
    // group loses the mark before the scroll has even finished.
    programmaticUntil.current = performance.now() + PROGRAMMATIC_SCROLL_MS
    // jsdom implements neither scrollIntoView nor layout, so guard rather than
    // let a component test explode on a purely visual affordance.
    groupRefs.current.get(id)?.scrollIntoView?.({ block: 'start' })
  }, [])

  // One scroll container serves every page, so switching page would otherwise
  // inherit the previous page's scrollTop — landing past the end of a short one.
  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = 0
  }, [activePage])

  // A deep link (or a rail click routed through the container) asked for a
  // group: scroll it under the pane's top edge.
  useEffect(() => {
    if (scrollNonce === 0 || !activeGroup || searching) return
    scrollToGroup(activeGroup)
  }, [scrollNonce, activeGroup, searching, scrollToGroup])

  // Scroll-spy: the rail names the block you are reading, never the next one
  // down. See `pickActiveGroup` for the rule (and why the bottom is special).
  useEffect(() => {
    const pane = paneRef.current
    if (!pane || searching) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      const headers = groups
        .map((group) => ({ id: group.id, el: groupRefs.current.get(group.id) }))
        .filter((h): h is { id: string; el: HTMLElement } => h.el !== undefined)
        .map((h) => ({ id: h.id, top: h.el.getBoundingClientRect().top }))
      const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2
      const current = pickActiveGroup(pane.getBoundingClientRect().top, headers, atBottom)
      if (current && current !== activeGroup) onActiveGroupChange(current)
    }
    const onScroll = (): void => {
      // Our own scroll, not the user's — leave the clicked group marked.
      if (performance.now() < programmaticUntil.current) return
      if (frame) return
      frame = requestAnimationFrame(measure)
    }
    pane.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      pane.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [groups, activeGroup, onActiveGroupChange, searching])

  // Ctrl+, / Cmd+, focuses search. It lives here rather than in the container
  // because the input this must focus is here.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== ',' || !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  /**
   * Search hits as page › group cards, capped — the shared reducer, so the two
   * presentations can never bucket or cap the same query differently.
   */
  const { buckets, total } = useMemo(
    () => (searching ? bucketSearchHits(query) : { buckets: [], total: 0 }),
    [searching, query]
  )

  return (
    <div
      data-testid="SettingsDialog"
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center"
    >
      {/* SessionView renders the whole app under CSS `zoom: uiFontScale`, and a
          fixed overlay inside a zoomed subtree resolves vw/vh in the ZOOMED
          coordinate space — so a plain 92vw cap is multiplied by the scale and
          the dialog grows past the window (1098x759 inside a 1099x760 viewport
          at 115%, corners clipped). Divide the viewport caps by the scale,
          exactly as SessionView does for its own root. */}
      <div
        style={{
          width: `min(1040px, calc(92vw / ${uiFontScale}))`,
          height: `min(700px, calc(88vh / ${uiFontScale}))`
        }}
        className="rounded-xl border border-border bg-bg-secondary shadow-2xl shadow-black/40 flex flex-col overflow-hidden"
      >
        {/* Header: title · global search · close */}
        <div className="h-[52px] shrink-0 flex items-center gap-4 px-[18px] border-b border-border">
          <span className="w-[166px] shrink-0 text-[15px] font-semibold text-text-primary">
            Settings
          </span>
          <div className="flex-1 min-w-0 flex justify-center">
            <div className="w-[380px] max-w-full h-[30px] flex items-center gap-2 px-2.5 bg-bg-input border border-border rounded-[7px] focus-within:border-accent/50 transition-colors">
              <SearchIcon />
              <input
                ref={searchRef}
                type="text"
                data-testid="SettingsDialog.search"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search all settings"
                spellCheck={false}
                autoComplete="off"
                className="flex-1 min-w-0 bg-transparent text-[12px] text-text-primary placeholder:text-text-muted outline-none"
                autoFocus
              />
              <span
                data-testid="SettingsDialog.searchHint"
                className="shrink-0 font-mono text-[11px] leading-4 text-text-muted border border-border rounded px-[5px]"
              >
                {macKeyboard ? '⌘ ,' : 'Ctrl ,'}
              </span>
            </div>
          </div>
          <div className="w-[166px] shrink-0 flex justify-end">
            <button
              data-testid="SettingsDialog.close"
              onClick={onClose}
              className="flex items-center justify-center w-6 h-6 rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
              title="Close"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Body: rail + one scrolling page */}
        <div className="flex flex-1 min-h-0">
          <nav
            aria-label="Settings pages"
            className={`w-[204px] shrink-0 border-r border-border bg-bg-primary/35 overflow-y-auto px-2 py-1 transition-opacity ${
              // Search replaces the page, so the rail describes nothing the pane
              // is showing. Dimmed AND disabled: `pointer-events-none` stops the
              // mouse but leaves every button in the tab order, so a keyboard
              // user could still "navigate" to a page they cannot see.
              searching ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            {RAIL_GROUPS.map((railGroup) => (
              <div key={railGroup.id}>
                <div className="px-2.5 pt-3 pb-[3px] text-[10px] uppercase tracking-wider text-text-muted">
                  {railGroup.label}
                </div>
                {PAGES.filter((p) => p.rail === railGroup.id).map((p) => {
                  const active = p.id === activePage
                  const expandable = expandablePages.has(p.id)
                  const open = active && expandable && railOpen
                  // A one-group page has no sub-entry to mark, so the page row
                  // is itself the leaf — and wears the accent a child would.
                  const leaf = active && !expandable
                  const listId = `${railId}-rail-${p.id}`
                  return (
                    <div key={p.id}>
                      <button
                        data-testid="SettingsDialog.railItem"
                        data-id={p.id}
                        data-active={active ? 'true' : 'false'}
                        data-expanded={expandable ? (open ? 'true' : 'false') : undefined}
                        disabled={searching}
                        aria-expanded={expandable ? open : undefined}
                        // Only while the list is mounted: `aria-controls` naming
                        // an element that is not in the DOM is a broken
                        // reference, not a hint.
                        aria-controls={open ? listId : undefined}
                        aria-current={leaf ? 'page' : undefined}
                        onClick={() => {
                          // On the page you are already on the header is the
                          // accordion's own trigger; anywhere else it navigates,
                          // and arriving somewhere always opens it.
                          if (!active) {
                            onSelectPage(p.id)
                            setRailOpen(true)
                          } else if (expandable) {
                            setRailOpen((v) => !v)
                          }
                        }}
                        className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] leading-[18px] text-left transition-colors cursor-default outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                          leaf
                            ? 'bg-accent/15 text-accent font-medium'
                            : active
                              ? 'bg-bg-hover/60 text-text-primary font-medium'
                              : 'text-text-secondary hover:bg-bg-hover'
                        }`}
                      >
                        <span
                          className={
                            leaf ? 'text-accent' : active ? 'text-text-primary' : 'text-text-muted'
                          }
                        >
                          {p.icon}
                        </span>
                        <span className="flex-1 min-w-0 truncate">{p.label}</span>
                        {expandable && (
                          <ChevronIcon
                            open={open}
                            className={active ? 'text-text-secondary' : 'text-text-muted'}
                            testid="SettingsDialog.railChevron"
                          />
                        )}
                      </button>
                      {open && (
                        <div
                          id={listId}
                          data-testid="SettingsDialog.railSubList"
                          data-id={p.id}
                          // The rule the indent draws: these belong to the page
                          // above them. Hanging off one hairline, starting under
                          // the page label, never a second column.
                          className="mt-px mb-1 ml-[17px] pl-[6px] border-l border-border"
                        >
                          {groups.map((g) => {
                            const on = g.id === highlighted
                            return (
                              <button
                                key={g.id}
                                data-testid="SettingsDialog.railSub"
                                data-id={g.id}
                                data-active={on ? 'true' : 'false'}
                                disabled={searching}
                                // `location`, not `page`: the page is the page,
                                // this is the place within it.
                                aria-current={on ? 'location' : undefined}
                                onClick={() => {
                                  onActiveGroupChange(g.id)
                                  scrollToGroup(g.id)
                                }}
                                className={`relative isolate w-full min-h-8 my-0.5 flex items-center pl-2 pr-5 py-1.5 rounded-md text-left text-[12px] leading-4 transition-[color] duration-100 motion-reduce:transition-none cursor-default outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                                  on
                                    ? 'text-accent'
                                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                                }`}
                              >
                                {/* One opacity transition keeps the background and dot in sync. */}
                                <span
                                  data-testid="SettingsDialog.railSubSelection"
                                  data-id={g.id}
                                  aria-hidden="true"
                                  className={`pointer-events-none absolute inset-0 rounded-md bg-accent/15 transition-opacity duration-100 motion-reduce:transition-none ${
                                    on ? 'opacity-100' : 'opacity-0'
                                  }`}
                                >
                                  <span className="absolute right-2 top-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-accent" />
                                </span>
                                <span className="relative z-10 flex-1 min-w-0 truncate">
                                  {g.label}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </nav>

          <div ref={paneRef} className="flex-1 min-w-0 overflow-y-auto pt-[22px] px-7 pb-10">
            {searching ? (
              <div data-testid="SettingsDialog.results">
                {total === 0 ? (
                  <div
                    data-testid="SettingsDialog.noResults"
                    className="pt-10 text-center text-[13px] text-text-secondary"
                  >
                    No settings match “{query}”
                  </div>
                ) : (
                  buckets.map((bucket) => (
                    <div
                      key={bucket.id}
                      data-testid="SettingsDialog.resultBucket"
                      // The engine is part of a byEngine bucket's identity, or
                      // the same id would appear two or three times (ADR-027).
                      data-id={bucket.id}
                    >
                      <div className="flex items-center gap-2 h-8 px-1 mt-5 mb-2">
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
                {total > buckets.length && (
                  <div
                    data-testid="SettingsDialog.moreResults"
                    className="mt-5 px-1 text-[12px] text-text-secondary"
                  >
                    {total - buckets.length} more groups match — keep typing to narrow it.
                  </div>
                )}
              </div>
            ) : (
              <div data-testid="SettingsDialog.page" data-id={page.id}>
                <div
                  data-testid="SettingsDialog.pageTitle"
                  className="text-[18px] font-semibold leading-6 text-text-primary"
                >
                  {page.label}
                </div>
                <div className="mt-[3px] text-[12px] leading-4 text-text-secondary">
                  {page.description}
                </div>
                {groups.map((group) => {
                  const engine = engineOf(group)
                  // A group that FOLLOWS a sibling's segment draws none itself.
                  const engines = group.engineFrom ? [] : enginesOf(group)
                  const storage = storageOf(group, engine)
                  const note = noteOf(group, engine)
                  const appliesOn = appliesOnOf(group, engine)
                  return (
                    <div
                      key={group.id}
                      data-testid="SettingsGroup"
                      data-id={group.id}
                      ref={(el) => {
                        if (el) groupRefs.current.set(group.id, el)
                        else groupRefs.current.delete(group.id)
                      }}
                      // The header must clear the pane's top padding when the
                      // rail scrolls a group into view.
                      className="scroll-mt-[22px]"
                    >
                      <div
                        data-testid="SettingsGroup.header"
                        className="flex items-center gap-3 h-8 px-1 mt-5 mb-2"
                      >
                        <span className="flex-1 min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                          {group.label}
                        </span>
                        {engines.length > 0 && engine && (
                          <EngineSegment
                            groupId={group.id}
                            engines={engines}
                            value={engine}
                            onChange={(next) =>
                              onSelectEngine(groupKey(activePage, group.id), next)
                            }
                          />
                        )}
                        {group.badge && (
                          <span
                            data-testid="SettingsGroup.badge"
                            className="shrink-0 bg-text-muted/20 text-text-secondary text-[10.5px] font-semibold leading-4 px-[7px] rounded-full"
                          >
                            {group.badge}
                          </span>
                        )}
                        {storage && <StorageTag file={storage} />}
                        {group.action && (
                          <Button
                            testid="SettingsGroup.action"
                            dataId={group.id}
                            disabled={group.action.disabled}
                            title={group.action.title}
                            // A static group definition holds no closure, so the
                            // header speaks to the pane it renders by event —
                            // see `SettingsGroup.action`.
                            onClick={() =>
                              window.dispatchEvent(new CustomEvent(group.action!.event))
                            }
                          >
                            {group.action.label}
                          </Button>
                        )}
                      </div>
                      <GroupCard items={itemsFor(group, engine)} render={renderItem} />
                      {note && (
                        <div
                          data-testid="SettingsGroup.note"
                          className="flex items-center gap-2 pt-2 px-1 text-[12px] leading-4 text-text-secondary"
                        >
                          {appliesOn && (
                            <span
                              data-testid="SettingsGroup.note.badge"
                              data-id={appliesOn}
                              className="shrink-0 bg-warning/15 text-warning text-[10.5px] font-semibold tracking-[0.02em] leading-4 px-[7px] rounded-full"
                            >
                              {APPLIES_ON_LABEL[appliesOn]}
                            </span>
                          )}
                          <span>{note}</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
