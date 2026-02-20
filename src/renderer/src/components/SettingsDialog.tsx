import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useSessionStore } from '../stores/session-store'
import type { AppSettings } from '../stores/session-store'

// ── Shared setting control components ────────────────────────────────

export function SettingsToggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover rounded transition-colors cursor-default"
    >
      <span>{label}</span>
      <span
        className={`w-7 h-4 rounded-full relative transition-colors ${checked ? 'bg-accent' : 'bg-text-muted/30'}`}
      >
        <span
          className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${checked ? 'left-3.5' : 'left-0.5'}`}
        />
      </span>
    </button>
  )
}

export function SettingsSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  formatValue
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  formatValue?: (value: number) => string
}): React.JSX.Element {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="px-3 py-1.5 text-[13px] text-text-secondary">
      <div className="flex items-center justify-between mb-1">
        <span>{label}</span>
        <span className="text-[11px] text-text-muted tabular-nums">
          {formatValue ? formatValue(value) : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-text-muted) ${pct}%)`
        }}
        className="w-full h-1 appearance-none rounded-full opacity-30 [&]:hover:opacity-50 transition-opacity cursor-pointer [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:opacity-100"
      />
    </div>
  )
}

function SettingsSelect<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="px-3 py-1.5 text-[13px] text-text-secondary">
      <div className="mb-1">{label}</div>
      <div className="flex items-center gap-1 bg-bg-primary/50 rounded-md p-0.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`flex-1 text-[11px] py-1 rounded transition-colors ${
              value === opt.value
                ? 'bg-accent/20 text-accent'
                : 'text-text-muted hover:text-text-secondary hover:bg-white/5'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Section definitions ──────────────────────────────────────────────

interface SettingItem {
  key: string
  label: string
  keywords?: string // extra search terms
  render: (settings: AppSettings, update: (p: Partial<AppSettings>) => void) => React.JSX.Element
}

interface Section {
  id: string
  label: string
  icon: React.JSX.Element
  items: SettingItem[]
}

const SECTIONS: Section[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    ),
    items: [
      {
        key: 'theme',
        label: 'Theme',
        keywords: 'dark light monokai color',
        render: (s, u) => (
          <SettingsSelect
            label="Theme"
            value={s.theme}
            options={[
              { value: 'dark' as const, label: 'Dark' },
              { value: 'light' as const, label: 'Light' },
              { value: 'monokai' as const, label: 'Monokai' }
            ]}
            onChange={(v) => u({ theme: v })}
          />
        )
      },
      {
        key: 'uiFontScale',
        label: 'UI font size',
        keywords: 'zoom scale',
        render: (s, u) => (
          <SettingsSlider
            label="UI font size"
            value={s.uiFontScale}
            min={1}
            max={1.5}
            step={0.05}
            onChange={(v) => u({ uiFontScale: v })}
            formatValue={(v) => `${Math.round(v * 100)}%`}
          />
        )
      },
      {
        key: 'chatFontScale',
        label: 'Chat font size',
        keywords: 'zoom scale text',
        render: (s, u) => (
          <SettingsSlider
            label="Chat font size"
            value={s.chatFontScale}
            min={1}
            max={1.5}
            step={0.05}
            onChange={(v) => u({ chatFontScale: v })}
            formatValue={(v) => `${Math.round(v * 100)}%`}
          />
        )
      }
    ]
  },
  {
    id: 'chat',
    label: 'Chat',
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
    items: [
      {
        key: 'chatWidthMode',
        label: 'Chat width mode',
        keywords: 'pixels percent layout',
        render: (s, u) => (
          <SettingsSelect
            label="Chat width"
            value={s.chatWidthMode}
            options={[
              { value: 'px' as const, label: 'Pixels' },
              { value: 'percent' as const, label: 'Percent' }
            ]}
            onChange={(v) => u({ chatWidthMode: v })}
          />
        )
      },
      {
        key: 'chatWidthValue',
        label: 'Chat width',
        keywords: 'width size',
        render: (s, u) =>
          s.chatWidthMode === 'px' ? (
            <SettingsSlider
              label="Width"
              value={s.chatWidthPx}
              min={500}
              max={3420}
              step={10}
              onChange={(v) => u({ chatWidthPx: v })}
              formatValue={(v) => `${v}px`}
            />
          ) : (
            <SettingsSlider
              label="Width"
              value={s.chatWidthPercent}
              min={60}
              max={100}
              step={1}
              onChange={(v) => u({ chatWidthPercent: v })}
              formatValue={(v) => `${v}%`}
            />
          )
      },
      {
        key: 'maxRecentSessions',
        label: 'Recent sessions',
        keywords: 'history sidebar',
        render: (s, u) => (
          <SettingsSlider
            label="Recent sessions"
            value={s.maxRecentSessions}
            min={1}
            max={10}
            onChange={(v) => u({ maxRecentSessions: v })}
          />
        )
      }
    ]
  },
  {
    id: 'tool-output',
    label: 'Tool Output',
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
    items: [
      {
        key: 'expandToolCalls',
        label: 'Expand tool calls',
        keywords: 'collapse show hide tool',
        render: (s, u) => (
          <SettingsToggle
            label="Expand tool calls"
            checked={s.expandToolCalls}
            onChange={(v) => u({ expandToolCalls: v })}
          />
        )
      },
      {
        key: 'expandReadResults',
        label: 'Include read results',
        keywords: 'file content tool',
        render: (s, u) => (
          <div className={s.expandToolCalls ? '' : 'opacity-40 pointer-events-none'}>
            <div className="pl-4">
              <SettingsToggle
                label="Include read results"
                checked={s.expandReadResults}
                onChange={(v) => u({ expandReadResults: v })}
              />
            </div>
          </div>
        )
      },
      {
        key: 'hideToolInput',
        label: 'Hide tool input',
        keywords: 'collapse parameters',
        render: (s, u) => (
          <SettingsToggle
            label="Hide tool input"
            checked={s.hideToolInput}
            onChange={(v) => u({ hideToolInput: v })}
          />
        )
      },
      {
        key: 'expandThinking',
        label: 'Expand thinking',
        keywords: 'thought reasoning chain',
        render: (s, u) => (
          <SettingsToggle
            label="Expand thinking"
            checked={s.expandThinking}
            onChange={(v) => u({ expandThinking: v })}
          />
        )
      }
    ]
  },
  {
    id: 'diff',
    label: 'Diff Viewer',
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3v18" />
        <path d="M3 12h18" />
      </svg>
    ),
    items: [
      {
        key: 'diffViewSplit',
        label: 'Split diff view',
        keywords: 'side by side unified',
        render: (s, u) => (
          <SettingsToggle
            label="Split diff view"
            checked={s.diffViewSplit}
            onChange={(v) => u({ diffViewSplit: v })}
          />
        )
      },
      {
        key: 'diffIgnoreWhitespace',
        label: 'Ignore whitespace in diffs',
        keywords: 'spaces tabs',
        render: (s, u) => (
          <SettingsToggle
            label="Ignore whitespace"
            checked={s.diffIgnoreWhitespace}
            onChange={(v) => u({ diffIgnoreWhitespace: v })}
          />
        )
      },
      {
        key: 'diffWrapLines',
        label: 'Wrap lines in diffs',
        keywords: 'overflow scroll',
        render: (s, u) => (
          <SettingsToggle
            label="Wrap lines"
            checked={s.diffWrapLines}
            onChange={(v) => u({ diffWrapLines: v })}
          />
        )
      }
    ]
  },
  {
    id: 'git',
    label: 'Git',
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M6 21V9a9 9 0 009 9" />
      </svg>
    ),
    items: [
      {
        key: 'gitCommitMode',
        label: 'Default commit mode',
        keywords: 'push',
        render: (s, u) => (
          <SettingsSelect
            label="Default commit"
            value={s.gitCommitMode}
            options={[
              { value: 'commit' as const, label: 'Commit' },
              { value: 'commit-push' as const, label: 'Commit & Push' }
            ]}
            onChange={(v) => u({ gitCommitMode: v })}
          />
        )
      },
      {
        key: 'gitPanelLayout',
        label: 'Git panel layout',
        keywords: 'single double split',
        render: (s, u) => (
          <SettingsSelect
            label="Panel layout"
            value={s.gitPanelLayout}
            options={[
              { value: 'single' as const, label: 'Single' },
              { value: 'double' as const, label: 'Double' }
            ]}
            onChange={(v) => u({ gitPanelLayout: v })}
          />
        )
      }
    ]
  },
  {
    id: 'status-line',
    label: 'Status Line',
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="17" y1="10" x2="3" y2="10" />
        <line x1="21" y1="6" x2="3" y2="6" />
        <line x1="21" y1="14" x2="3" y2="14" />
        <line x1="17" y1="18" x2="3" y2="18" />
      </svg>
    ),
    items: [
      {
        key: 'statusLineAlign',
        label: 'Status line alignment',
        keywords: 'left center right position',
        render: (s, u) => (
          <SettingsSelect
            label="Alignment"
            value={s.statusLineAlign}
            options={[
              { value: 'left' as const, label: 'Left' },
              { value: 'center' as const, label: 'Center' },
              { value: 'right' as const, label: 'Right' }
            ]}
            onChange={(v) => u({ statusLineAlign: v })}
          />
        )
      },
      {
        key: 'statusLineTemplate',
        label: 'Status line template',
        keywords: 'format tokens cost context',
        render: (s, u) => (
          <div className="px-3 py-1.5 text-[13px] text-text-secondary">
            <div className="mb-1">
              Template
            </div>
            <input
              type="text"
              value={s.statusLineTemplate}
              onChange={(e) => u({ statusLineTemplate: e.target.value })}
              className="w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
              placeholder="{in} / {out} / {total} · {used}%"
            />
            <div className="text-[9px] text-text-muted/60 mt-0.5">
              Tokens: {'{in} {out} {total}'} · Cost: {'{cost}'} · Context:{' '}
              {'{used} {remaining}'} · Lines: {'{lines+} {lines-}'} · Time: {'{duration}'}
            </div>
          </div>
        )
      }
    ]
  }
]

// ── SettingsDialog component ─────────────────────────────────────────

export function SettingsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useSessionStore((s) => s.settings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const [search, setSearch] = useState('')
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id)
  const contentRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const overlayRef = useRef<HTMLDivElement>(null)
  const isScrollingFromClick = useRef(false)

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Close on overlay click
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose()
    },
    [onClose]
  )

  // Filter sections by search
  const filteredSections = useMemo(() => {
    if (!search.trim()) return SECTIONS
    const q = search.toLowerCase()
    return SECTIONS.map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          (item.keywords && item.keywords.toLowerCase().includes(q)) ||
          section.label.toLowerCase().includes(q)
      )
    })).filter((section) => section.items.length > 0)
  }, [search])

  // Track active section on scroll
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
      setActiveSection(current)
    }
    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [filteredSections])

  const scrollToSection = useCallback((id: string) => {
    setActiveSection(id)
    const el = sectionRefs.current[id]
    if (el && contentRef.current) {
      isScrollingFromClick.current = true
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setTimeout(() => {
        isScrollingFromClick.current = false
      }, 500)
    }
  }, [])

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
                  onChange={(e) => setSearch(e.target.value)}
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
          </div>
        </div>
      </div>
    </div>
  )
}
