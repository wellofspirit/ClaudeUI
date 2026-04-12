import { useState, useRef, useEffect, useCallback, useMemo } from 'react'

interface LogEntry {
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error'
  source: string
  message: string
  error?: string
}

type LogViewerApi = {
  ready: () => void
  onEntry: (cb: (entry: LogEntry) => void) => void
  onBatch: (cb: (entries: LogEntry[]) => void) => void
  getTheme: () => Promise<string | null>
  setTheme: (theme: string) => void
  minimize: () => void
  maximize: () => void
  close: () => void
  platform: string
}

declare global {
  interface Window {
    logViewerApi?: LogViewerApi
  }
}

const isMac = window.logViewerApi?.platform === 'darwin'

const LEVELS = ['debug', 'info', 'warn', 'error'] as const
const LEVEL_LABELS: Record<string, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }
const THEMES = ['dark', 'light', 'monokai'] as const
type Theme = typeof THEMES[number]

function sourceClass(src: string): string {
  if (src === 'renderer' || src === 'renderer:error') return 'renderer'
  if (src.startsWith('plugin:')) return 'plugin'
  return ''
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function EntryRow({ entry, onSourceClick }: { entry: LogEntry; onSourceClick: (src: string) => void }): React.JSX.Element {
  let msgHtml = escapeHtml(entry.message)
  if (entry.error) {
    msgHtml += `<span class="err">${escapeHtml(entry.error)}</span>`
  }

  return (
    <div className="log-entry" data-level={entry.level} data-source={entry.source}>
      <span className="log-ts">{entry.timestamp}</span>
      <span className={`log-level ${entry.level}`}>
        {entry.level.toUpperCase().padEnd(5)}
      </span>
      <span
        className={`log-source ${sourceClass(entry.source)}`}
        title={`Click to filter by "${entry.source}"`}
        onClick={() => onSourceClick(entry.source)}
      >
        {entry.source}
      </span>
      <span className="log-msg" dangerouslySetInnerHTML={{ __html: msgHtml }} />
    </div>
  )
}

function SourceFilter({
  allSources,
  activeSources,
  onToggle,
  onClose
}: {
  allSources: string[]
  activeSources: Set<string> | null
  onToggle: (src: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [filterText, setFilterText] = useState('')
  const filterLower = filterText.toLowerCase()
  const visible = filterText
    ? allSources.filter((s) => s.toLowerCase().includes(filterLower))
    : allSources

  const allActive = activeSources === null
  const activeCount = activeSources ? activeSources.size : allSources.length

  return (
    <div className="source-dropdown" onClick={(e) => e.stopPropagation()}>
      <input
        className="source-filter-input"
        placeholder="Type to filter sources..."
        value={filterText}
        onChange={(e) => setFilterText(e.target.value)}
        autoFocus
      />
      <div className="source-list">
        <label className="source-item" key="__all__">
          <input
            type="checkbox"
            checked={allActive}
            onChange={() => onToggle('__all__')}
          />
          <span className="source-label">All sources ({allSources.length})</span>
        </label>
        {visible.map((src) => (
          <label className="source-item" key={src}>
            <input
              type="checkbox"
              checked={activeSources === null || activeSources.has(src)}
              onChange={() => onToggle(src)}
            />
            <span className={`source-label ${sourceClass(src)}`}>{src}</span>
          </label>
        ))}
      </div>
      <div className="source-footer">
        <span className="source-footer-count">{activeCount} selected</span>
        <button className="source-footer-btn" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}

export function LogViewer(): React.JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [theme, setThemeState] = useState<Theme>('dark')
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    window.logViewerApi?.setTheme(t)
  }, [])
  const [activeLevels, setActiveLevels] = useState<Set<string>>(
    () => new Set(LEVELS)
  )
  // null = all sources active (default), Set = only these sources
  const [activeSources, setActiveSources] = useState<Set<string> | null>(null)
  const [showSourceDropdown, setShowSourceDropdown] = useState(false)
  const logAreaRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  // Collect unique sources from entries
  const allSources = useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) set.add(e.source)
    return [...set].sort()
  }, [entries])

  // Apply theme to root element
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.removeAttribute('data-theme')
    } else {
      document.documentElement.setAttribute('data-theme', theme)
    }
  }, [theme])

  // Subscribe to IPC once on mount
  useEffect(() => {
    const api = window.logViewerApi
    if (!api) return

    // Restore persisted theme
    api.getTheme().then((saved) => {
      if (saved && (THEMES as readonly string[]).includes(saved)) {
        setThemeState(saved as Theme)
      }
    })

    api.onBatch((batch) => {
      setEntries((prev) => [...prev, ...batch])
    })
    api.onEntry((entry) => {
      setEntries((prev) => [...prev, entry])
    })
    api.ready()
  }, [])

  // Auto-scroll when new entries arrive
  useEffect(() => {
    const el = logAreaRef.current
    if (el && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [entries])

  // Close dropdown on outside click
  useEffect(() => {
    if (!showSourceDropdown) return
    const handleClick = (): void => setShowSourceDropdown(false)
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [showSourceDropdown])

  const handleScroll = useCallback(() => {
    const el = logAreaRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  const toggleLevel = useCallback((level: string) => {
    setActiveLevels((prev) => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }, [])

  const toggleSource = useCallback((src: string) => {
    if (src === '__all__') {
      // Toggle between all and none
      setActiveSources((prev) => (prev === null ? new Set<string>() : null))
      return
    }
    setActiveSources((prev) => {
      if (prev === null) {
        // Was "all" — switch to all-except-this
        const next = new Set(allSources)
        next.delete(src)
        return next
      }
      const next = new Set(prev)
      if (next.has(src)) next.delete(src)
      else next.add(src)
      return next
    })
  }, [allSources])

  // Click a source name in a log entry → filter to just that source
  const handleSourceClick = useCallback((src: string) => {
    setActiveSources(new Set([src]))
  }, [])

  const handleClear = useCallback(() => {
    setEntries([])
  }, [])

  const [messageFilter, setMessageFilter] = useState('')

  // Split by spaces, lowercase, filter empty tokens
  const messageTokens = useMemo(
    () => messageFilter.toLowerCase().split(/\s+/).filter(Boolean),
    [messageFilter]
  )

  const filtered = entries.filter((e) => {
    if (!activeLevels.has(e.level)) return false
    if (activeSources !== null && !activeSources.has(e.source)) return false
    if (messageTokens.length > 0) {
      const msgLower = e.message.toLowerCase()
      for (const token of messageTokens) {
        if (!msgLower.includes(token)) return false
      }
    }
    return true
  })

  return (
    <>
      <div className="toolbar">
        {isMac && <span className="macos-traffic-pad" />}
        <span className="toolbar-title">Log Viewer</span>
        <div className="theme-toggle">
          {THEMES.map((t) => (
            <button
              key={t}
              className={`theme-option${theme === t ? ' active' : ''}`}
              onClick={() => setTheme(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <span className="toolbar-sep" />
        {LEVELS.map((level) => (
          <button
            key={level}
            className={`filter-btn level-${level}${activeLevels.has(level) ? ' active' : ''}`}
            onClick={() => toggleLevel(level)}
          >
            {LEVEL_LABELS[level]}
          </button>
        ))}
        <span className="toolbar-sep" />
        <div className="source-dropdown-wrapper">
          <button
            className={`filter-btn source-btn${activeSources !== null ? ' active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowSourceDropdown((v) => !v) }}
          >
            Sources
          </button>
          {showSourceDropdown && (
            <SourceFilter
              allSources={allSources}
              activeSources={activeSources}
              onToggle={toggleSource}
              onClose={() => setShowSourceDropdown(false)}
            />
          )}
        </div>
        <span className="toolbar-sep" />
        <input
          className="search-input"
          placeholder="Filter messages..."
          value={messageFilter}
          onChange={(e) => setMessageFilter(e.target.value)}
        />
        <span className="toolbar-spacer" />
        <span className="toolbar-count">{filtered.length} entries</span>
        <button className="clear-btn" onClick={handleClear}>
          Clear
        </button>
        {!isMac && (
          <div className="window-controls">
            <button className="win-ctrl win-minimize" onClick={() => window.logViewerApi?.minimize()} title="Minimize">
              <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
            </button>
            <button className="win-ctrl win-maximize" onClick={() => window.logViewerApi?.maximize()} title="Maximize">
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
            </button>
            <button className="win-ctrl win-close" onClick={() => window.logViewerApi?.close()} title="Close">
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.2"/></svg>
            </button>
          </div>
        )}
      </div>
      <div className="log-area" ref={logAreaRef} onScroll={handleScroll}>
        {filtered.map((entry, i) => (
          <EntryRow key={i} entry={entry} onSourceClick={handleSourceClick} />
        ))}
      </div>
    </>
  )
}
