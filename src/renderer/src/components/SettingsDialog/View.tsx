import { useRef, useEffect, useCallback } from 'react'
import type { AppSettings } from '../../stores/session-store'
import { SECTIONS, type Section } from './settings-sections'

export interface VersionInfo {
  appVersion: string
  sdkVersion: string
  cliVersion: string
}

export interface SettingsDialogViewProps {
  settings: AppSettings
  updateSettings: (patch: Partial<AppSettings>) => void
  versionInfo: VersionInfo | null
  search: string
  activeSection: string
  filteredSections: Section[]
  onSearchChange: (value: string) => void
  onSelectSection: (id: string) => void
  onScrollTo: (id: string) => void
  onClose: () => void
}

export function SettingsDialogView({
  settings,
  updateSettings,
  versionInfo,
  search,
  activeSection,
  filteredSections,
  onSearchChange,
  onSelectSection,
  onScrollTo,
  onClose,
}: SettingsDialogViewProps): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const overlayRef = useRef<HTMLDivElement>(null)
  const isScrollingFromClick = useRef(false)

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose()
    },
    [onClose]
  )

  // Track active section as the user scrolls
  useEffect(() => {
    const container = contentRef.current
    if (!container) return
    const handleScroll = (): void => {
      if (isScrollingFromClick.current) return
      const scrollTop = container.scrollTop + 8
      let current = filteredSections[0]?.id ?? ''
      for (const section of filteredSections) {
        const el = sectionRefs.current[section.id]
        if (el && el.offsetTop <= scrollTop) {
          current = section.id
        }
      }
      onSelectSection(current)
    }
    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [filteredSections, onSelectSection])

  const scrollToSection = useCallback((id: string): void => {
    onScrollTo(id)
    const el = sectionRefs.current[id]
    if (el && contentRef.current) {
      isScrollingFromClick.current = true
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setTimeout(() => {
        isScrollingFromClick.current = false
      }, 500)
    }
  }, [onScrollTo])

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center"
    >
      <div className="bg-bg-secondary border border-border rounded-xl w-[720px] h-[520px] flex flex-col shadow-2xl shadow-black/40 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-[15px] text-text-primary font-medium">Settings</h2>
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

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left nav */}
          <nav className="w-[180px] border-r border-border/50 py-2 px-2 shrink-0">
            {SECTIONS.map((section) => {
              const hasMatches =
                !search.trim() || filteredSections.some((s) => s.id === section.id)
              return (
                <button
                  key={section.id}
                  onClick={() => scrollToSection(section.id)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] transition-colors cursor-default ${
                    activeSection === section.id
                      ? 'bg-accent/10 text-accent'
                      : hasMatches
                        ? 'text-text-secondary hover:bg-bg-hover'
                        : 'text-text-muted/40'
                  }`}
                  disabled={!hasMatches}
                >
                  <span className="shrink-0 opacity-70">{section.icon}</span>
                  {section.label}
                </button>
              )
            })}
          </nav>

          {/* Right content */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Search */}
            <div className="px-4 py-2 border-b border-border/50 shrink-0">
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
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder="Search settings..."
                  className="w-full bg-bg-primary/50 border border-border/50 rounded-md pl-7 pr-3 py-1.5 text-[13px] text-text-secondary placeholder:text-text-muted/50 outline-none focus:border-accent/50 transition-colors"
                  autoFocus
                />
              </div>
            </div>

            {/* Scrollable settings */}
            <div ref={contentRef} className="flex-1 overflow-y-auto py-2">
              {filteredSections.length === 0 ? (
                <div className="flex items-center justify-center h-full text-text-muted text-[13px]">
                  No settings match &ldquo;{search}&rdquo;
                </div>
              ) : (
                filteredSections.map((section, idx) => (
                  <div
                    key={section.id}
                    ref={(el) => {
                      sectionRefs.current[section.id] = el
                    }}
                    className={idx < filteredSections.length - 1 ? 'mb-6' : ''}
                  >
                    <div className="px-4 pb-1.5 mb-1 border-b border-border/40 flex items-center gap-2">
                      <span className="text-text-muted/60 shrink-0">{section.icon}</span>
                      <span className="text-[12px] text-text-secondary font-semibold tracking-wide uppercase">
                        {section.label}
                      </span>
                    </div>
                    <div>
                      {section.items.map((item) => (
                        <div key={item.key} className="px-1">
                          {item.render(settings, updateSettings)}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Version info footer */}
            {versionInfo && (
              <div className="px-4 py-1.5 text-[11px] text-text-muted/50 text-right border-t border-border/30">
                {/^\d/.test(versionInfo.appVersion) ? `v${versionInfo.appVersion}` : versionInfo.appVersion} · SDK {versionInfo.sdkVersion} · CLI {versionInfo.cliVersion}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
