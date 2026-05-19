import { useEffect, useRef, useState, useCallback } from 'react'
import { useSessionStore } from '../../../stores/session-store'
import { createChatSearchEngine, type ChatSearchEngine, type EngineState } from './chat-search'

interface Props {
  scrollRef: React.RefObject<HTMLDivElement | null>
  active: boolean
  query: string
  onQueryChange: (q: string) => void
  onClose: () => void
}

export function ChatSearchOverlay({ scrollRef, active, query, onQueryChange, onClose }: Props): React.JSX.Element | null {
  const searchCaseSensitive = useSessionStore((s) => s.settings.searchCaseSensitive)
  const updateSettings = useSessionStore((s) => s.updateSettings)

  const [state, setState] = useState<EngineState>({ total: 0, index: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  const engineRef = useRef<ChatSearchEngine | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // Mount/unmount engine when overlay activates against a real scroll container
  useEffect(() => {
    if (!active) return
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const engine = createChatSearchEngine(scrollEl)
    engineRef.current = engine
    const unsubscribe = engine.subscribe(setState)
    return () => {
      unsubscribe()
      engine.dispose()
      engineRef.current = null
    }
  }, [active, scrollRef])

  // Capture previously focused element so Esc can restore focus
  useEffect(() => {
    if (!active) return
    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null
    // Autofocus the input synchronously so tests can observe it immediately.
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [active])

  // Push query/case changes into engine
  useEffect(() => {
    engineRef.current?.setQuery(query, searchCaseSensitive)
  }, [query, searchCaseSensitive])

  const handleClose = useCallback(() => {
    const target = previouslyFocused.current
    onClose()
    // Restore focus after the parent has had a chance to react to onClose
    window.setTimeout(() => {
      target?.focus?.()
    }, 0)
  }, [onClose])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) engineRef.current?.prev()
        else engineRef.current?.next()
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        if (e.shiftKey) engineRef.current?.prev()
        else engineRef.current?.next()
      }
    },
    [handleClose]
  )

  const toggleCase = useCallback(() => {
    updateSettings({ searchCaseSensitive: !searchCaseSensitive })
  }, [searchCaseSensitive, updateSettings])

  if (!active) return null

  const counter =
    query.length < 2
      ? ''
      : state.total === 0
        ? 'No results'
        : `${state.index} / ${state.total}`

  return (
    <div
      data-search="skip"
      className="absolute top-2 right-4 z-50 flex items-center gap-1 bg-bg-secondary border border-border rounded-md shadow-lg px-2 py-1.5"
      style={{ width: 340 }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in chat"
        className="flex-1 bg-transparent border-0 outline-none text-[13px] text-text-primary placeholder:text-text-muted"
      />
      <span className="text-[11px] text-text-muted min-w-[48px] text-right select-none">
        {counter}
      </span>
      <button
        onClick={() => engineRef.current?.prev()}
        title="Previous match (Shift+Enter)"
        className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 15l-6-6-6 6" />
        </svg>
      </button>
      <button
        onClick={() => engineRef.current?.next()}
        title="Next match (Enter)"
        className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <button
        onClick={toggleCase}
        title="Case sensitive"
        className={`w-6 h-6 flex items-center justify-center rounded text-[11px] font-mono transition-colors cursor-default ${
          searchCaseSensitive ? 'bg-accent text-bg-primary' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
        }`}
      >
        Aa
      </button>
      <button
        onClick={handleClose}
        title="Close (Esc)"
        className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6L6 18" />
          <path d="M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
