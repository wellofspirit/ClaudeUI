/**
 * Pure DOM-walking search engine for the chat panel.
 *
 * Walks the given root with a TreeWalker (SHOW_TEXT), excluding any subtree
 * whose ancestor has data-search="skip". Builds a flat list of Range objects
 * for matches in document order. Applies highlights via the CSS Custom
 * Highlight API when available (Chromium 105+); jsdom has no support, so the
 * application is feature-detected and no-ops gracefully.
 *
 * A MutationObserver on the root recomputes (debounced 150ms) when content
 * changes — supports live updates during streaming.
 */

export interface EngineState {
  total: number
  index: number // 1-based; 0 when total = 0
}

export interface ChatSearchEngine {
  setQuery(query: string, caseSensitive: boolean): void
  next(): void
  prev(): void
  getState(): EngineState
  subscribe(listener: (state: EngineState) => void): () => void
  dispose(): void
}

const DEBOUNCE_MS = 150
const MIN_QUERY_LEN = 2

// Feature detection for CSS Custom Highlight API
type HighlightCtor = new (...ranges: AbstractRange[]) => Highlight
const HighlightImpl: HighlightCtor | null =
  typeof window !== 'undefined' && 'Highlight' in window
    ? (window as unknown as { Highlight: HighlightCtor }).Highlight
    : null

const hasHighlightRegistry =
  typeof CSS !== 'undefined' && 'highlights' in CSS && HighlightImpl !== null

function isInsideSkip(node: Node): boolean {
  let el: Node | null = node.parentNode
  while (el && el instanceof Element) {
    if (el.getAttribute('data-search') === 'skip') return true
    el = el.parentNode
  }
  return false
}

function findMatchesIn(root: Node, query: string, caseSensitive: boolean): Range[] {
  if (!query || query.length < MIN_QUERY_LEN) return []
  const needle = caseSensitive ? query : query.toLowerCase()
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT
      if (isInsideSkip(node)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let textNode: Text | null = walker.nextNode() as Text | null
  while (textNode) {
    const text = textNode.nodeValue ?? ''
    const haystack = caseSensitive ? text : text.toLowerCase()
    let from = 0
    while (true) {
      const found = haystack.indexOf(needle, from)
      if (found === -1) break
      const range = document.createRange()
      range.setStart(textNode, found)
      range.setEnd(textNode, found + needle.length)
      ranges.push(range)
      from = found + needle.length
    }
    textNode = walker.nextNode() as Text | null
  }
  return ranges
}

export function createChatSearchEngine(scrollEl: HTMLElement): ChatSearchEngine {
  let disposed = false
  let query = ''
  let caseSensitive = false
  let matches: Range[] = []
  let currentIdx = 0 // 0-based internally; exposed as 1-based via getState
  const listeners = new Set<(state: EngineState) => void>()

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  function notify(): void {
    const state = getState()
    for (const listener of listeners) listener(state)
  }

  function getState(): EngineState {
    if (matches.length === 0) return { total: 0, index: 0 }
    return { total: matches.length, index: currentIdx + 1 }
  }

  function applyHighlights(): void {
    if (!hasHighlightRegistry) return
    const Hi = HighlightImpl!
    const registry = (CSS as unknown as { highlights: Map<string, Highlight> }).highlights
    if (matches.length === 0) {
      registry.delete('chat-search')
      registry.delete('chat-search-current')
      return
    }
    const allHighlight = new Hi(...matches)
    registry.set('chat-search', allHighlight)
    const current = matches[currentIdx]
    if (current) {
      const currentHighlight = new Hi(current)
      registry.set('chat-search-current', currentHighlight)
    } else {
      registry.delete('chat-search-current')
    }
  }

  function scrollCurrentIntoView(): void {
    const range = matches[currentIdx]
    if (!range) return
    // Feature-detect Range.getBoundingClientRect (jsdom lacks it).
    if (typeof range.getBoundingClientRect !== 'function') return
    if (typeof scrollEl.scrollTo !== 'function') return
    const rect = range.getBoundingClientRect()
    const containerRect = scrollEl.getBoundingClientRect()
    // Center the match within the scroll container
    const targetTop =
      scrollEl.scrollTop +
      (rect.top - containerRect.top) -
      scrollEl.clientHeight / 2 +
      rect.height / 2
    scrollEl.scrollTo({ top: targetTop, behavior: 'smooth' })
  }

  function rememberCurrent(): { node: Node; offset: number } | null {
    const r = matches[currentIdx]
    if (!r) return null
    return { node: r.startContainer, offset: r.startOffset }
  }

  function recompute(prevAnchor: { node: Node; offset: number } | null): void {
    if (disposed) return
    matches = findMatchesIn(scrollEl, query, caseSensitive)
    if (matches.length === 0) {
      currentIdx = 0
    } else if (prevAnchor) {
      // Try to preserve the previous current match
      const exact = matches.findIndex(
        (r) => r.startContainer === prevAnchor.node && r.startOffset === prevAnchor.offset
      )
      if (exact !== -1) {
        currentIdx = exact
      } else {
        // Anchor disconnected → reset to first match
        if (!prevAnchor.node.isConnected) {
          currentIdx = 0
        } else {
          // Snap to nearest in document order
          const compareDoc = (node: Node, offset: number): number => {
            for (let i = 0; i < matches.length; i++) {
              const r = matches[i]
              const pos = r.startContainer.compareDocumentPosition(node)
              if (pos & Node.DOCUMENT_POSITION_PRECEDING) return i
              if (r.startContainer === node && r.startOffset >= offset) return i
            }
            return matches.length - 1
          }
          currentIdx = Math.max(
            0,
            Math.min(matches.length - 1, compareDoc(prevAnchor.node, prevAnchor.offset))
          )
        }
      }
    } else {
      currentIdx = 0
    }
    applyHighlights()
    notify()
  }

  const scheduleRecompute = (): void => {
    if (disposed) return
    if (debounceTimer) clearTimeout(debounceTimer)
    const anchor = rememberCurrent()
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      recompute(anchor)
    }, DEBOUNCE_MS)
  }

  const observer = new MutationObserver(() => {
    if (query.length >= MIN_QUERY_LEN) scheduleRecompute()
  })
  observer.observe(scrollEl, { childList: true, subtree: true, characterData: true })

  return {
    setQuery(nextQuery, nextCaseSensitive) {
      if (disposed) return
      query = nextQuery
      caseSensitive = nextCaseSensitive
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      recompute(null)
    },
    next() {
      if (disposed || matches.length === 0) return
      currentIdx = (currentIdx + 1) % matches.length
      applyHighlights()
      scrollCurrentIntoView()
      notify()
    },
    prev() {
      if (disposed || matches.length === 0) return
      currentIdx = (currentIdx - 1 + matches.length) % matches.length
      applyHighlights()
      scrollCurrentIntoView()
      notify()
    },
    getState,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      observer.disconnect()
      if (debounceTimer) clearTimeout(debounceTimer)
      matches = []
      currentIdx = 0
      query = ''
      if (hasHighlightRegistry) {
        const registry = (CSS as unknown as { highlights: Map<string, Highlight> }).highlights
        registry.delete('chat-search')
        registry.delete('chat-search-current')
      }
      listeners.clear()
    }
  }
}
