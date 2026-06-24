import { useRef, useCallback } from 'react'
import type { AppSettings } from '../../stores/session-store'
import type { EngineConfig, VendorConfig } from '../../../../shared/types'
import { SCOPES, type ScopeDef, type SettingsScope } from './settings-sections'

export interface VersionInfo {
  appVersion: string
  sdkVersion: string
  cliVersion: string
}

export interface SettingsDialogViewProps {
  settings: AppSettings
  updateSettings: (patch: Partial<AppSettings>) => void
  engineConfig: EngineConfig
  updateEngineConfig: (patch: Partial<EngineConfig>) => void
  vendorConfig: VendorConfig
  updateVendorConfig: (patch: Partial<VendorConfig>) => void
  versionInfo: VersionInfo | null
  activeScope: SettingsScope
  onSelectScope: (scope: SettingsScope) => void
  activeSectionId: string
  onSelectSection: (id: string) => void
  search: string
  onSearchChange: (value: string) => void
  onClose: () => void
}

export function SettingsDialogView({
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
  onSelectSection,
  search,
  onSearchChange,
  onClose
}: SettingsDialogViewProps): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose()
    },
    [onClose]
  )

  // Resolve the active scope definition
  const scopeDef: ScopeDef = SCOPES.find((s) => s.id === activeScope) ?? SCOPES[0]

  // All sections for the active scope, flattened
  const allScopeSections = scopeDef.subgroups.flatMap((sg) => sg.sections)

  // Apply search filter within scope
  const q = search.trim().toLowerCase()
  const filteredIds = q
    ? new Set(
        allScopeSections
          .filter(
            (sec) =>
              sec.label.toLowerCase().includes(q) ||
              sec.items.some(
                (item) =>
                  item.label.toLowerCase().includes(q) ||
                  (item.keywords && item.keywords.toLowerCase().includes(q))
              )
          )
          .map((s) => s.id)
      )
    : null // null = no filter

  // Resolve the visible active section (auto-select first if current is filtered out)
  const visibleSectionId: string = (() => {
    if (!filteredIds) return activeSectionId
    if (filteredIds.has(activeSectionId)) return activeSectionId
    // auto-select first match
    const first = allScopeSections.find((s) => filteredIds.has(s.id))
    return first?.id ?? activeSectionId
  })()

  // The section to render in the right pane
  const activeSection = allScopeSections.find((s) => s.id === visibleSectionId)

  // Subgroups with filtered sections (for left nav)
  const visibleSubgroups = scopeDef.subgroups
    .map((sg) => ({
      ...sg,
      sections: sg.sections.filter((s) => !filteredIds || filteredIds.has(s.id))
    }))
    .filter((sg) => sg.sections.length > 0)

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center"
    >
      <div className="bg-bg-secondary border border-border rounded-xl w-[760px] h-[540px] flex flex-col shadow-2xl shadow-black/40 overflow-hidden">
        {/* Header: title + tab bar + close */}
        <div className="flex items-center gap-3 px-5 h-12 border-b border-border shrink-0">
          <h2 className="text-[15px] text-text-primary font-medium mr-1">Settings</h2>

          {/* Tab bar — segmented control */}
          <div className="flex items-center gap-0.5 bg-bg-primary/60 p-0.5 rounded-lg border border-border/60">
            {SCOPES.map((scope) => (
              <button
                key={scope.id}
                onClick={() => onSelectScope(scope.id)}
                className={`px-3 py-1 rounded-md text-[12px] transition-colors cursor-default ${
                  activeScope === scope.id
                    ? 'bg-accent/20 text-accent font-medium'
                    : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
                }`}
              >
                {scope.label}
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {/* Close button */}
          <button
            onClick={onClose}
            className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-bg-hover text-text-muted hover:text-text-secondary transition-colors cursor-default"
          >
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
          </button>
        </div>

        {/* Body: scoped left list + single section pane */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left nav — scoped section list */}
          <nav className="w-[178px] border-r border-border/50 py-2 px-2 shrink-0 overflow-y-auto text-[12.5px]">
            {/* Search input */}
            <div className="mb-2 px-1">
              <div className="relative">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder="Search..."
                  className="w-full bg-bg-primary/50 border border-border/50 rounded-md pl-6 pr-2 py-1 text-[11px] text-text-secondary placeholder:text-text-muted/50 outline-none focus:border-accent/50 transition-colors"
                  autoFocus
                />
              </div>
            </div>

            {visibleSubgroups.length === 0 ? (
              <div className="px-2 py-4 text-[11px] text-text-muted/50 text-center">
                No matches
              </div>
            ) : (
              visibleSubgroups.map((sg) => (
                <div key={sg.id}>
                  {sg.label && (
                    <div className="px-2 pt-3 pb-1 text-[10px] uppercase tracking-wider text-text-muted/60 first:pt-1">
                      {sg.label}
                    </div>
                  )}
                  {sg.sections.map((sec) => (
                    <button
                      key={sec.id}
                      onClick={() => onSelectSection(sec.id)}
                      className={`w-full text-left px-3 py-1.5 rounded-md transition-colors cursor-default ${
                        visibleSectionId === sec.id
                          ? 'bg-accent/15 text-accent font-medium'
                          : 'text-text-secondary hover:bg-bg-hover'
                      }`}
                    >
                      {sec.label}
                    </button>
                  ))}
                </div>
              ))
            )}
          </nav>

          {/* Right pane: single focused section */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {activeSection ? (
              <div className="flex-1 overflow-y-auto py-3">
                {/* Section header */}
                <div className="px-4 pb-2 mb-1 border-b border-border/40 flex items-center gap-2">
                  <span className="text-text-muted/60 shrink-0">{activeSection.icon}</span>
                  <span className="text-[12px] text-text-secondary font-semibold tracking-wide uppercase">
                    {activeSection.label}
                  </span>
                </div>
                {/* Section items */}
                <div>
                  {activeSection.items.map((item) => (
                    <div key={item.key} className="px-1">
                      {item.render(
                        settings,
                        updateSettings,
                        engineConfig,
                        updateEngineConfig,
                        vendorConfig,
                        updateVendorConfig
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-text-muted text-[13px]">
                {q ? `No settings match "${search}"` : 'Select a section'}
              </div>
            )}

            {/* Version info footer */}
            {versionInfo && (
              <div className="px-4 py-1.5 text-[11px] text-text-muted/50 text-right border-t border-border/30 shrink-0">
                {/^\d/.test(versionInfo.appVersion)
                  ? `v${versionInfo.appVersion}`
                  : versionInfo.appVersion}{' '}
                · SDK {versionInfo.sdkVersion} · CLI {versionInfo.cliVersion}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
