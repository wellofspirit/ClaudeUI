import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SettingsDialogViewProps } from './View'
import {
  SCOPES,
  firstSectionOfScope,
  isSectionVisible,
  scopeCapabilities,
  type Section,
  type SettingsScope
} from './settings-sections'
import { useSwipeTabs } from '../../hooks/useSwipeTabs'

/**
 * Mobile (viewport ≤768px) settings UI — ADR-048's content-takeover pattern.
 *
 * The desktop dialog is a fixed 760×540 box: a 178px section nav on the left, a
 * single focused section on the right. Neither half survives a 360px phone, so
 * this view re-presents the SAME data with the same container behind it:
 *
 *   • a 4-scope tab bar (the desktop segmented control, widened to fill), with a
 *     horizontal swipe on the content area as the second way to move between
 *     adjacent tabs;
 *   • sections as accordions inside the tab, so "which section" stops needing a
 *     permanent 178px column;
 *   • search that goes WIDE instead of deep — one flat list across all four
 *     scopes, because a phone user searching "sandbox" should not first have to
 *     know it lives under Claude.
 *
 * Section CONTENT is reused verbatim: every pane is rendered through the same
 * `section.items[].render(...)` call the desktop uses, with the same props. This
 * is a presentation fork, not a second settings implementation.
 *
 * Lazily mounted, deliberately: `settings-sections.tsx` is ~200KB of definitions
 * and several panes fetch on mount, so a collapsed section renders nothing at
 * all. That matches desktop, which only ever mounts the one selected section.
 */

/** The scope a search hit belongs to, shown as a caption above the hit. */
const SCOPE_LABEL: Record<SettingsScope, string> = Object.fromEntries(
  SCOPES.map((s) => [s.id, s.label])
) as Record<SettingsScope, string>

/**
 * The desktop View's search predicate, applied per section.
 *
 * Duplicated rather than lifted because `View.tsx` must stay byte-identical in
 * this change; if it is ever touched, this and the inline copy there should
 * become one exported helper.
 */
function sectionMatches(section: Section, q: string): boolean {
  if (section.label.toLowerCase().includes(q)) return true
  return section.items.some(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      (item.keywords != null && item.keywords.toLowerCase().includes(q))
  )
}

/** Capability-visible sections of a scope, flattened in definition order. */
function visibleSections(scope: SettingsScope): Section[] {
  const def = SCOPES.find((s) => s.id === scope)
  if (!def) return []
  const caps = scopeCapabilities(scope)
  return def.subgroups.flatMap((sg) => sg.sections).filter((sec) => isSectionVisible(sec.id, caps))
}

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

/** Props every accordion needs to render its pane, forwarded unchanged. */
type RenderProps = Pick<
  SettingsDialogViewProps,
  | 'settings'
  | 'updateSettings'
  | 'engineConfig'
  | 'updateEngineConfig'
  | 'vendorConfig'
  | 'updateVendorConfig'
>

function SectionAccordion({
  section,
  open,
  onToggle,
  render
}: {
  section: Section
  open: boolean
  onToggle: () => void
  render: RenderProps
}): React.JSX.Element {
  return (
    <div
      data-testid="SettingsMobileView.section"
      data-id={section.id}
      data-open={open ? 'true' : 'false'}
      className="border-b border-border/40"
    >
      <button
        data-testid="SettingsMobileView.sectionToggle"
        data-id={section.id}
        aria-expanded={open}
        onClick={onToggle}
        className="w-full min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <span className="text-text-muted/60 shrink-0">{section.icon}</span>
        <span
          className={`flex-1 min-w-0 truncate text-[13px] ${open ? 'text-accent' : 'text-text-secondary'}`}
        >
          {section.label}
        </span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div data-testid="SettingsMobileView.sectionContent" data-id={section.id} className="pb-2">
          {section.items.map((item) => (
            <div key={item.key}>
              {item.render(
                render.settings,
                render.updateSettings,
                render.engineConfig,
                render.updateEngineConfig,
                render.vendorConfig,
                render.updateVendorConfig
              )}
            </div>
          ))}
        </div>
      )}
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
  activeScope,
  onSelectScope,
  activeSectionId,
  search,
  onSearchChange,
  onClose
}: SettingsDialogViewProps): React.JSX.Element {
  /**
   * Which sections are unfolded. One flat set of section ids rather than a
   * per-scope map, because a section id belongs to exactly one scope (guarded in
   * `settings-scopes.unit.test.tsx`) — so this IS per-scope state, without the
   * bookkeeping. Several may be open at once, and the set survives tab switches
   * and search, so going back to a tab restores what you had unfolded.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const contentRef = useRef<HTMLDivElement>(null)

  const toggleSection = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  /**
   * A deep link (`initialSection`, e.g. the composer's sandbox pill) lands on
   * the owning tab AND should unfold the section it named. It is told apart from
   * an ordinary tab switch by the container's own rule: switching scope always
   * selects that scope's FIRST section, so anything else was asked for.
   */
  useEffect(() => {
    if (!activeSectionId || activeSectionId === firstSectionOfScope(activeScope)) return
    setExpanded((prev) => (prev.has(activeSectionId) ? prev : new Set(prev).add(activeSectionId)))
  }, [activeScope, activeSectionId])

  /**
   * All four tabs share one scroll container, so switching tabs would otherwise
   * inherit the previous tab's scrollTop — landing you in the middle of a short
   * list, or past the end of it. Keyed to `activeScope` ALONE on purpose:
   * toggling an accordion or typing in the search box must leave the scroll
   * position exactly where the user put it.
   */
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [activeScope])

  const q = search.trim().toLowerCase()
  const searching = q.length > 0

  const tabIndex = Math.max(
    0,
    SCOPES.findIndex((s) => s.id === activeScope)
  )

  const handleSwipe = useCallback(
    (nextIndex: number) => onSelectScope(SCOPES[nextIndex].id),
    [onSelectScope]
  )

  // Swiping while the flat result list is up would move a tab bar that is not
  // even on screen, so the gesture is off during search.
  useSwipeTabs(contentRef, {
    index: tabIndex,
    count: SCOPES.length,
    onChange: handleSwipe,
    enabled: !searching
  })

  /** Sections of the active tab, in definition order, with subgroup captions. */
  const scopeDef = SCOPES.find((s) => s.id === activeScope) ?? SCOPES[0]
  const caps = scopeCapabilities(scopeDef.id)
  const subgroups = scopeDef.subgroups
    .map((sg) => ({
      ...sg,
      sections: sg.sections.filter((sec) => isSectionVisible(sec.id, caps))
    }))
    .filter((sg) => sg.sections.length > 0)

  /** Every matching section across every scope, scope order preserved. */
  const hits = useMemo(() => {
    if (!q) return []
    return SCOPES.flatMap((scope) =>
      visibleSections(scope.id)
        .filter((sec) => sectionMatches(sec, q))
        .map((sec) => ({ scope: scope.id, section: sec }))
    )
  }, [q])

  const renderProps: RenderProps = {
    settings,
    updateSettings,
    engineConfig,
    updateEngineConfig,
    vendorConfig,
    updateVendorConfig
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
            className="w-full bg-bg-input border border-border/50 rounded-md pl-8 pr-8 py-2 text-[13px] text-text-secondary placeholder:text-text-muted/50 outline-none focus:border-accent/50 transition-colors"
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

      {/* Tab bar — hidden during search, which is deliberately cross-scope. */}
      {!searching && (
        <div className="shrink-0 flex items-center border-b border-border bg-bg-secondary/30">
          {SCOPES.map((scope) => (
            <button
              key={scope.id}
              data-testid="SettingsMobileView.tab"
              data-id={scope.id}
              data-active={activeScope === scope.id ? 'true' : 'false'}
              onClick={() => onSelectScope(scope.id)}
              className={`relative flex-1 min-w-0 px-1 py-2.5 text-[12px] font-medium truncate transition-colors ${
                activeScope === scope.id ? 'text-accent' : 'text-text-muted'
              }`}
            >
              {scope.label}
              {activeScope === scope.id && (
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
          <div data-testid="SettingsMobileView.searchResults">
            {hits.length === 0 ? (
              <div className="px-4 py-8 text-center text-[13px] text-text-muted">
                No settings match “{search.trim()}”
              </div>
            ) : (
              hits.map(({ scope, section }) => (
                <div
                  key={section.id}
                  data-testid="SettingsMobileView.searchHit"
                  data-id={section.id}
                >
                  <div className="px-3 pt-2.5 pb-0.5 text-[10px] uppercase tracking-wider text-text-muted/60">
                    {SCOPE_LABEL[scope]}
                  </div>
                  <SectionAccordion
                    section={section}
                    open={expanded.has(section.id)}
                    onToggle={() => toggleSection(section.id)}
                    render={renderProps}
                  />
                </div>
              ))
            )}
          </div>
        ) : (
          subgroups.map((sg) => (
            <div key={sg.id}>
              {sg.label && (
                <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-text-muted/60">
                  {sg.label}
                </div>
              )}
              {sg.sections.map((sec) => (
                <SectionAccordion
                  key={sec.id}
                  section={sec}
                  open={expanded.has(sec.id)}
                  onToggle={() => toggleSection(sec.id)}
                  render={renderProps}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {/* Version footer */}
      {versionInfo && (
        <div
          className="shrink-0 px-3 py-1.5 text-[10px] text-text-muted/50 text-center border-t border-border/30"
          style={{ paddingBottom: 'calc(0.375rem + env(safe-area-inset-bottom))' }}
        >
          {/^\d/.test(versionInfo.appVersion)
            ? `v${versionInfo.appVersion}`
            : versionInfo.appVersion}{' '}
          · CLI {versionInfo.cliVersion}
        </div>
      )}
    </div>
  )
}
