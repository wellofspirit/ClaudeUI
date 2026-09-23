import { useEffect, useRef, useState, useCallback } from 'react'
import { useSessionStore } from '../../../stores/session-store'
import { createChatSearchEngine, type ChatSearchEngine, type EngineState } from './chat-search'
import { ChatSearchFlash } from './ChatSearchFlash'

interface Props {
  scrollRef: React.RefObject<HTMLDivElement | null>
  active: boolean
  query: string
  onQueryChange: (q: string) => void
  onClose: () => void
}

export function ChatSearchOverlay({
  scrollRef,
  active,
  query,
  onQueryChange,
  onClose
}: Props): React.JSX.Element | null {
  const searchCaseSensitive = useSessionStore((s) => s.settings.searchCaseSensitive)
  const searchExcludeToolOutput = useSessionStore((s) => s.settings.searchExcludeToolOutput)
  const updateSettings = useSessionStore((s) => s.updateSettings)

  const [state, setState] = useState<EngineState>({ total: 0, index: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  const engineRef = useRef<ChatSearchEngine | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  // The match to flash; `id` remounts the indicator so a repeat reveal replays it.
  const [flash, setFlash] = useState<{
    id: number
    range: Range
    scrollEl: HTMLElement
  } | null>(null)
  const flashSeq = useRef(0)
  const clearFlash = useCallback(() => setFlash(null), [])

  // Mount/unmount engine when overlay activates against a real scroll container
  useEffect(() => {
    if (!active) return
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const engine = createChatSearchEngine(scrollEl, {
      onReveal: (range) => setFlash({ id: ++flashSeq.current, range, scrollEl })
    })
    engineRef.current = engine
    const unsubscribe = engine.subscribe(setState)
    return () => {
      unsubscribe()
      engine.dispose()
      engineRef.current = null
      setFlash(null)
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

  // Push query/option changes into engine. `active` is a dependency so a
  // reopened overlay re-runs its prefilled query against the fresh engine.
  useEffect(() => {
    setFlash(null)
    engineRef.current?.setQuery(query, {
      caseSensitive: searchCaseSensitive,
      excludeToolOutput: searchExcludeToolOutput
    })
  }, [active, query, searchCaseSensitive, searchExcludeToolOutput])

  const step = useCallback((dir: 'next' | 'prev') => {
    setFlash(null)
    if (dir === 'next') engineRef.current?.next()
    else engineRef.current?.prev()
  }, [])

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
      if (e.key === 'Enter') {
        e.preventDefault()
        step(e.shiftKey ? 'prev' : 'next')
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        step(e.shiftKey ? 'prev' : 'next')
      }
    },
    [step]
  )

  // On the bar, not the input, so Escape also closes it from the toggles and
  // the prev/next buttons.
  const handleBarKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      handleClose()
    },
    [handleClose]
  )

  const toggleCase = useCallback(() => {
    updateSettings({ searchCaseSensitive: !searchCaseSensitive })
  }, [searchCaseSensitive, updateSettings])

  const toggleExcludeToolOutput = useCallback(() => {
    updateSettings({ searchExcludeToolOutput: !searchExcludeToolOutput })
  }, [searchExcludeToolOutput, updateSettings])

  if (!active) return null

  const counter =
    query.length < 2
      ? ''
      : state.total === 0
        ? 'No results'
        : `${state.index === 0 ? '–' : state.index} / ${state.total}`

  return (
    <>
      {flash && (
        <ChatSearchFlash
          key={flash.id}
          range={flash.range}
          scrollEl={flash.scrollEl}
          onDone={clearFlash}
        />
      )}
      <div
        data-testid="ChatSearchOverlay"
        data-search="skip"
        onKeyDown={handleBarKeyDown}
        className="absolute top-2 right-4 z-50 flex items-center gap-1 bg-bg-secondary border border-border rounded-md shadow-lg px-2 py-1.5"
        style={{ width: 368 }}
      >
        <input
          data-testid="ChatSearchOverlay.query"
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
          data-testid="ChatSearchOverlay.prev"
          onClick={() => step('prev')}
          title="Previous match (Shift+Enter)"
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 15l-6-6-6 6" />
          </svg>
        </button>
        <button
          data-testid="ChatSearchOverlay.next"
          onClick={() => step('next')}
          title="Next match (Enter)"
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <button
          data-testid="ChatSearchOverlay.caseToggle"
          onClick={toggleCase}
          title="Case sensitive"
          className={`w-6 h-6 flex items-center justify-center rounded text-[11px] font-mono transition-colors cursor-default ${
            searchCaseSensitive
              ? 'bg-accent text-bg-primary'
              : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
          }`}
        >
          Aa
        </button>
        <button
          data-testid="ChatSearchOverlay.excludeToolOutputToggle"
          onClick={toggleExcludeToolOutput}
          title="Exclude tool output"
          aria-pressed={searchExcludeToolOutput}
          className={`w-6 h-6 flex items-center justify-center rounded transition-colors cursor-default ${
            searchExcludeToolOutput
              ? 'bg-accent text-bg-primary'
              : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
          }`}
        >
          {/* Terminal prompt with a slash through it */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 7l5 5-5 5" />
            <path d="M12 19h8" />
            <path d="M21 3L3 21" />
          </svg>
        </button>
        <button
          data-testid="ChatSearchOverlay.close"
          onClick={handleClose}
          title="Close (Esc)"
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      </div>
    </>
  )
}
