/**
 * Pure DOM-walking search engine for the chat panel.
 *
 * Walks the given root with a TreeWalker (SHOW_TEXT), excluding any subtree
 * whose ancestor has data-search="skip" (and, when `excludeToolOutput` is set,
 * any subtree marked with TOOL_OUTPUT_SCOPE). Builds a flat list of Range
 * objects for matches in document order. Applies highlights via the CSS Custom
 * Highlight API when available (Chromium 105+); jsdom has no support, so the
 * application is feature-detected and no-ops gracefully.
 *
 * A MutationObserver on the root recomputes (debounced 150ms) when content
 * changes — supports live updates during streaming.
 *
 * Navigation model: a query (or option) change leaves the engine "pending" —
 * every match is highlighted but none is current and nothing scrolls. The first
 * next()/prev() picks relative to the viewport, so a user parked at the bottom
 * of a long session is not thrown back to the oldest match.
 */

import { effectiveZoom } from '../../../lib/effective-zoom'
import { SEARCH_ANCHOR_SELECTOR, TOOL_OUTPUT_SELECTOR } from './search-scope'

export interface EngineState {
  total: number
  index: number // 1-based; 0 when total = 0 or no match is current yet (pending)
}

export interface SearchOptions {
  caseSensitive: boolean
  excludeToolOutput: boolean
}

export interface ChatSearchEngineOptions {
  /** Called once a reveal's scroll has settled, with the revealed match. */
  onReveal?: (range: Range) => void
}

export interface ChatSearchEngine {
  setQuery(query: string, options: SearchOptions): void
  next(): void
  prev(): void
  getState(): EngineState
  subscribe(listener: (state: EngineState) => void): () => void
  dispose(): void
}

const DEBOUNCE_MS = 150
const MIN_QUERY_LEN = 2
/**
 * Consecutive on-target frames a reveal needs before it reports. One is not
 * proof: a tick runs in a rAF callback, and `content-visibility: auto` updates
 * relevance in the SAME frame's rendering step AFTER the rAF callbacks —
 * swapping placeholders near the new viewport for their real heights, which
 * can move the match thousands of px with no scroll of ours. A swap can also
 * cascade over several frames, so a match must hold still across two ticks.
 */
const STABLE_FRAMES = 2
/**
 * Frames (correcting and stable alike) a reveal may spend, ~330ms at 60Hz.
 * On the cap it reports where the match is without a further scroll.
 */
const MAX_REVEAL_FRAMES = 20
const SKIP_SELECTOR = '[data-search="skip"]'
/** Internal `currentIdx` while matches are highlighted but none is current. */
const PENDING = -1

// Feature detection for CSS Custom Highlight API
type HighlightCtor = new (...ranges: AbstractRange[]) => Highlight
const HighlightImpl: HighlightCtor | null =
  typeof window !== 'undefined' && 'Highlight' in window
    ? (window as unknown as { Highlight: HighlightCtor }).Highlight
    : null

const hasHighlightRegistry =
  typeof CSS !== 'undefined' && 'highlights' in CSS && HighlightImpl !== null

function isExcluded(node: Node, excludeToolOutput: boolean): boolean {
  const parent = node.parentElement
  if (!parent) return false
  if (parent.closest(SKIP_SELECTOR)) return true
  return excludeToolOutput && parent.closest(TOOL_OUTPUT_SELECTOR) !== null
}

function findMatchesIn(root: Node, query: string, options: SearchOptions): Range[] {
  if (!query || query.length < MIN_QUERY_LEN) return []
  const { caseSensitive, excludeToolOutput } = options
  const needle = caseSensitive ? query : query.toLowerCase()
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT
      if (isExcluded(node, excludeToolOutput)) return NodeFilter.FILTER_REJECT
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

/** First index in [0, length) for which `pred` holds, or `length` — `pred` must be monotonic. */
function lowerBound(length: number, pred: (i: number) => boolean): number {
  let lo = 0
  let hi = length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pred(mid)) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** True when `node` is `el`, inside it, or after it in document order. */
function isAtOrAfter(el: Element, node: Node): boolean {
  return el === node || (el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

export function createChatSearchEngine(
  scrollEl: HTMLElement,
  engineOptions: ChatSearchEngineOptions = {}
): ChatSearchEngine {
  let disposed = false
  let query = ''
  let options: SearchOptions = { caseSensitive: false, excludeToolOutput: false }
  let matches: Range[] = []
  let currentIdx = PENDING // 0-based internally; exposed as 1-based via getState
  /**
   * Where the current match started, captured when it BECAME current. Reading
   * it off the live Range at mutation time would be too late: removing the
   * match's text node silently moves the Range's boundary to the (still
   * connected) parent, hiding that the match is gone.
   */
  let currentAnchor: { node: Node; offset: number } | null = null
  const listeners = new Set<(state: EngineState) => void>()

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let revealFrame = 0

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
    const current = currentIdx === PENDING ? undefined : matches[currentIdx]
    if (current) {
      const currentHighlight = new Hi(current)
      registry.set('chat-search-current', currentHighlight)
    } else {
      registry.delete('chat-search-current')
    }
  }

  /**
   * Index of the first match at/after the top of the viewport, or
   * `matches.length` when every match is above it. Anchors are measured, not
   * matches: an anchor's own box is its placeholder/remembered size under
   * `content-visibility: auto`, whereas measuring a match inside a skipped
   * subtree would force that subtree's layout. The one exception is the
   * message crossing the viewport top: it is partly on screen, so already laid
   * out, and its matches above the top are skipped by measuring them.
   */
  function viewportPick(): number {
    const anchors = scrollEl.querySelectorAll(SEARCH_ANCHOR_SELECTOR)
    if (anchors.length === 0) return 0
    const viewportTop = scrollEl.getBoundingClientRect().top
    const a = lowerBound(
      anchors.length,
      (i) => anchors[i].getBoundingClientRect().bottom > viewportTop
    )
    if (a === anchors.length) return matches.length
    const anchor = anchors[a]
    let m = lowerBound(matches.length, (i) => isAtOrAfter(anchor, matches[i].startContainer))
    if (typeof Range.prototype.getBoundingClientRect === 'function') {
      while (
        m < matches.length &&
        anchor.contains(matches[m].startContainer) &&
        matches[m].getBoundingClientRect().bottom <= viewportTop
      ) {
        m++
      }
    }
    return m
  }

  function cancelReveal(): void {
    if (revealFrame) {
      cancelAnimationFrame(revealFrame)
      revealFrame = 0
    }
  }

  /**
   * scrollTop that centres `range`, clamped to the scrollable extent. Rects are
   * page px but scrollTop/clientHeight are the scroller's own CSS px, so the
   * measured offset is divided by the effective zoom (THE ZOOM TRAP) — mixing
   * them overshoots by the zoom factor on every correction.
   */
  function centredScrollTop(range: Range): number {
    const rect = range.getBoundingClientRect()
    const box = scrollEl.getBoundingClientRect()
    const z = effectiveZoom(scrollEl, box)
    const raw =
      scrollEl.scrollTop + (rect.top - box.top + rect.height / 2) / z - scrollEl.clientHeight / 2
    const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight)
    return Math.min(max, Math.max(0, raw))
  }

  /**
   * Centre the current match with an instant scroll, then keep re-measuring
   * every frame: messages painted for the first time by that scroll trade
   * their 100px `content-visibility` placeholder for their real height, which
   * moves the match after it was measured. Reports once the match has held
   * still for STABLE_FRAMES ticks, or at MAX_REVEAL_FRAMES.
   */
  function reveal(): void {
    cancelReveal()
    const range = matches[currentIdx]
    if (!range) return
    // Feature-detect layout APIs (jsdom lacks Range.getBoundingClientRect).
    if (typeof range.getBoundingClientRect !== 'function') return
    if (typeof scrollEl.scrollTo !== 'function') return

    /** The target, or null when already within 1 CSS px of it. */
    const pendingTarget = (): number | null => {
      const target = centredScrollTop(range)
      return Math.abs(target - scrollEl.scrollTop) < 1 ? null : target
    }
    const scrollTo = (top: number): void => scrollEl.scrollTo({ top, behavior: 'instant' })

    const initial = pendingTarget()
    if (initial !== null) scrollTo(initial)
    let frames = 0
    let stable = 0
    // Each frame re-measures and either reports or corrects, never both, so no
    // scroll of ours is in flight when the flash mounts. A correction resets
    // the stable count. At most 1 + (MAX_REVEAL_FRAMES - 1) scrolls in total.
    const tick = (): void => {
      revealFrame = 0
      if (disposed || range.collapsed) return
      frames++
      const target = pendingTarget()
      stable = target === null ? stable + 1 : 0
      // Past the cap the match is as close as layout will let it get; still
      // report it so the find indicator marks where it landed.
      if (stable >= STABLE_FRAMES || frames >= MAX_REVEAL_FRAMES) {
        engineOptions.onReveal?.(range)
        return
      }
      if (target !== null) scrollTo(target)
      revealFrame = requestAnimationFrame(tick)
    }
    revealFrame = requestAnimationFrame(tick)
  }

  function setCurrent(idx: number): void {
    currentIdx = idx
    const r = idx === PENDING ? undefined : matches[idx]
    currentAnchor = r ? { node: r.startContainer, offset: r.startOffset } : null
  }

  function select(idx: number): void {
    setCurrent(idx)
    applyHighlights()
    reveal()
    notify()
  }

  function recompute(prevAnchor: { node: Node; offset: number } | null): void {
    if (disposed) return
    matches = findMatchesIn(scrollEl, query, options)
    setCurrent(nextIndexAfterRecompute(prevAnchor))
    applyHighlights()
    notify()
  }

  function nextIndexAfterRecompute(prevAnchor: { node: Node; offset: number } | null): number {
    if (matches.length === 0) {
      return PENDING
    } else if (prevAnchor) {
      // Try to preserve the previous current match
      const exact = matches.findIndex(
        (r) => r.startContainer === prevAnchor.node && r.startOffset === prevAnchor.offset
      )
      if (exact !== -1) {
        return exact
      } else {
        // The current match's node left the DOM (e.g. its message re-rendered):
        // there is nothing to stay near, so go back to pending and let the next
        // step pick from the viewport rather than jump to the oldest match.
        if (!prevAnchor.node.isConnected) {
          return PENDING
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
          return Math.max(
            0,
            Math.min(matches.length - 1, compareDoc(prevAnchor.node, prevAnchor.offset))
          )
        }
      }
    }
    // No current match to preserve (fresh query, or still pending).
    return PENDING
  }

  const scheduleRecompute = (): void => {
    if (disposed) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      recompute(currentAnchor)
    }, DEBOUNCE_MS)
  }

  const observer = new MutationObserver(() => {
    if (query.length >= MIN_QUERY_LEN) scheduleRecompute()
  })
  observer.observe(scrollEl, { childList: true, subtree: true, characterData: true })

  return {
    setQuery(nextQuery, nextOptions) {
      if (disposed) return
      query = nextQuery
      options = nextOptions
      cancelReveal()
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      recompute(null)
    },
    next() {
      if (disposed || matches.length === 0) return
      // No match at/after the viewport top → the nearest one above it (the last).
      select(
        currentIdx === PENDING
          ? Math.min(viewportPick(), matches.length - 1)
          : (currentIdx + 1) % matches.length
      )
    },
    prev() {
      if (disposed || matches.length === 0) return
      // A pick of `matches.length` ("none at/after") steps back to the last match.
      const from = currentIdx === PENDING ? viewportPick() : currentIdx
      select((from - 1 + matches.length) % matches.length)
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
      cancelReveal()
      if (debounceTimer) clearTimeout(debounceTimer)
      matches = []
      setCurrent(PENDING)
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
