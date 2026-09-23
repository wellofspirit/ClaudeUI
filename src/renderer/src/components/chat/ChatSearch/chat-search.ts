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
/**
 * Frames a match stays watched after it is reported, ~500ms at 60Hz, shared
 * by every re-report of one reveal so a match that keeps being pushed out
 * cannot loop forever.
 */
const WATCH_FRAMES = 30
/**
 * The neighbourhood pre-render forces anchors visible on each side of the
 * match until their rendered heights sum to this many container heights...
 */
const PRERENDER_VIEWPORTS = 1.5
/** ...or until this many anchors on that side, whichever comes first. */
const PRERENDER_MAX_ANCHORS = 40
/** Input that means the user is scrolling the chat themselves. */
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'pointerdown'] as const
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

/**
 * False for a match with no boxes at all (inside `display: none`): revealing
 * it would scroll to nothing and flash nowhere. jsdom has no
 * `Range.getClientRects`, so there every match counts as rendered.
 */
function isRendered(range: Range): boolean {
  return typeof range.getClientRects !== 'function' || range.getClientRects().length > 0
}

/** The per-axis property names one nested-box reveal step reads and writes. */
const AXES = [
  {
    scroll: 'scrollTop',
    client: 'clientHeight',
    extent: 'scrollHeight',
    border: 'clientTop',
    overflow: 'overflowY',
    start: 'top',
    end: 'bottom'
  },
  {
    scroll: 'scrollLeft',
    client: 'clientWidth',
    extent: 'scrollWidth',
    border: 'clientLeft',
    overflow: 'overflowX',
    start: 'left',
    end: 'right'
  }
] as const
type Axis = (typeof AXES)[number]

/**
 * What a reveal changed on an `overflow: hidden`/`clip` box, to put back:
 * its scroll offsets from before, per axis it moved on, and, when the reveal
 * swapped its ellipsis for a clip, the box's own INLINE `text-overflow` from
 * before (usually '').
 */
type ClipScrolls = Map<
  HTMLElement,
  { scrollTop?: number; scrollLeft?: number; textOverflow?: string }
>

/**
 * Scroll `el` on `axis` so `range` is centred in it, when the match is not
 * already wholly inside its visible box on that axis and `el` has content to
 * scroll there. Any overflow but `visible` qualifies: `hidden` (a `truncate`
 * header) cannot be scrolled by the user, but it can be by script. Such a box
 * is recorded in `clipped` so it can be put back later; a user-scrollable box
 * (`auto`/`scroll`) stays where the reveal left it, as native find does.
 *
 * A scrolled `truncate` box also has its `text-overflow: ellipsis` swapped for
 * `clip` while it is scrolled: Chromium places the ellipsis at the UNSCROLLED
 * client width, so the scrolled text paints nothing there (a blank header) or
 * cuts the match with "…".
 */
function centreInBox(el: HTMLElement, range: Range, axis: Axis, clipped: ClipScrolls): void {
  const max = el[axis.extent] - el[axis.client]
  if (max <= 0) return
  const overflow = getComputedStyle(el)[axis.overflow]
  if (overflow === 'visible') return
  // Re-measured for every box and axis: each adjustment moves the match.
  const rect = range.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  // Page px ↔ the box's own CSS px (THE ZOOM TRAP): borders, client size and
  // scroll offsets are CSS px, rects are page px.
  const z = effectiveZoom(el, elRect)
  const boxStart = elRect[axis.start] + el[axis.border] * z
  const boxEnd = boxStart + el[axis.client] * z
  if (rect[axis.start] >= boxStart && rect[axis.end] <= boxEnd) return
  const offset = (rect[axis.start] + rect[axis.end] - boxStart - boxEnd) / 2 / z
  const target = Math.min(max, Math.max(0, el[axis.scroll] + offset))
  if (overflow === 'hidden' || overflow === 'clip') {
    const saved = clipped.get(el) ?? {}
    // Keep the FIRST values seen: that is how the box was before any reveal.
    // (Once overridden, the computed value reads `clip`, so this runs once.)
    saved[axis.scroll] ??= el[axis.scroll]
    if (saved.textOverflow === undefined && getComputedStyle(el).textOverflow === 'ellipsis') {
      saved.textOverflow = el.style.textOverflow
      el.style.textOverflow = 'clip'
    }
    clipped.set(el, saved)
  }
  el[axis.scroll] = target
}

/**
 * Bring `range` into view inside every box between it and `scrollEl` that
 * clips it: `max-h-* overflow-y-auto` tool output, code blocks, `truncate`
 * headers. Centring only the chat would put a match that is scrolled out of
 * such a box at its OUTER position (often clamped to the top), where nothing
 * of it shows. Innermost first, since scrolling an inner box moves the match
 * within every box around it.
 */
function revealInNestedBoxes(range: Range, scrollEl: HTMLElement, clipped: ClipScrolls): void {
  for (let el = range.startContainer.parentElement; el && el !== scrollEl; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue
    for (const axis of AXES) centreInBox(el, range, axis, clipped)
  }
}

/**
 * Put back every `overflow: hidden`/`clip` box a reveal scrolled, with its
 * ellipsis, and forget them.
 */
function restoreClipped(clipped: ClipScrolls): void {
  for (const [el, saved] of clipped) {
    if (saved.scrollTop !== undefined) el.scrollTop = saved.scrollTop
    if (saved.scrollLeft !== undefined) el.scrollLeft = saved.scrollLeft
    if (saved.textOverflow === '') el.style.removeProperty('text-overflow')
    else if (saved.textOverflow !== undefined) el.style.textOverflow = saved.textOverflow
  }
  clipped.clear()
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
  /**
   * `overflow: hidden`/`clip` boxes the current match's reveal scrolled. They
   * are put back once that match stops being current (a step to another
   * match, `setQuery`, `dispose`), so a `truncate` header does not stay
   * shifted.
   */
  const clipped: ClipScrolls = new Map()
  /** Anchors the current reveal forced to `content-visibility: visible`. */
  let forced: HTMLElement[] = []
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
    watchUserScroll(false)
  }

  /**
   * While a reported match is watched, the user's own scrolling ends the
   * watch: they moved the match away on purpose, and must not be pulled back.
   * Scroll anchoring, the case the watch exists for, sends no input events.
   */
  function watchUserScroll(on: boolean): void {
    for (const type of USER_SCROLL_EVENTS) {
      if (on) scrollEl.addEventListener(type, cancelReveal, { passive: true })
      else scrollEl.removeEventListener(type, cancelReveal)
    }
  }

  /** Hand the forced anchors back to `content-visibility: auto`. */
  function releaseForced(): void {
    for (const el of forced) el.style.removeProperty('content-visibility')
    forced = []
  }

  /**
   * Force the match's message anchor and its neighbours to
   * `content-visibility: visible` before measuring anything. Chromium applies
   * cv:auto relevance changes ASYNCHRONOUSLY: a swap of placeholders for real
   * heights near the new viewport was measured landing ~100ms (several frames)
   * after the reveal had seen two stable frames and reported, and scroll
   * anchoring then carried the match thousands of px off screen. No frame
   * count bounds that, so the neighbourhood is laid out up front instead:
   * whatever the reveal scrolls onto the screen is already its real height.
   *
   * Each side walks outwards in document order until the anchors' rendered
   * heights (measured after forcing) cover PRERENDER_VIEWPORTS container
   * heights, or PRERENDER_MAX_ANCHORS anchors.
   *
   * Releasing later is safe: `contain-intrinsic-size: auto` keeps a released
   * offscreen anchor at its last rendered size, so nothing shifts. And an
   * inline style change is neither a childList nor a characterData mutation,
   * so neither this engine's MutationObserver nor ChatPanel's fires.
   */
  function prerenderNeighbourhood(range: Range): void {
    const anchor = range.startContainer.parentElement?.closest<HTMLElement>(SEARCH_ANCHOR_SELECTOR)
    if (!anchor || !scrollEl.contains(anchor)) return
    const anchors = Array.from(scrollEl.querySelectorAll<HTMLElement>(SEARCH_ANCHOR_SELECTOR))
    const at = anchors.indexOf(anchor)
    const force = (el: HTMLElement): void => {
      el.style.contentVisibility = 'visible'
      forced.push(el)
    }
    force(anchor)
    const budget = PRERENDER_VIEWPORTS * scrollEl.getBoundingClientRect().height
    for (const dir of [-1, 1]) {
      let height = 0
      for (
        let i = at + dir, n = 0;
        i >= 0 && i < anchors.length && n < PRERENDER_MAX_ANCHORS && height < budget;
        i += dir, n++
      ) {
        force(anchors[i])
        height += anchors[i].getBoundingClientRect().height
      }
    }
  }

  /** True when `range` lies wholly inside the chat's visible box, vertically. */
  function isWhollyVisible(range: Range): boolean {
    const rect = range.getBoundingClientRect()
    const box = scrollEl.getBoundingClientRect()
    return rect.top >= box.top && rect.bottom <= box.bottom
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
   * Bring the current match into view inside any box in the chat that clips
   * it, centre it in the chat with an instant scroll, then keep re-measuring
   * every frame: messages painted for the first time by that scroll trade
   * their 100px `content-visibility` placeholder for their real height, which
   * moves the match after it was measured. Reports once the match has held
   * still for STABLE_FRAMES ticks, or at MAX_REVEAL_FRAMES.
   *
   * The neighbourhood pre-render removes most of that movement up front; the
   * frame loop and the post-report watch are what remains for late layout.
   */
  function reveal(): void {
    cancelReveal()
    releaseForced()
    const range = matches[currentIdx]
    if (!range) return
    // Feature-detect layout APIs (jsdom lacks Range.getBoundingClientRect).
    if (typeof range.getBoundingClientRect !== 'function') return
    if (typeof scrollEl.scrollTo !== 'function') return

    prerenderNeighbourhood(range)
    revealInNestedBoxes(range, scrollEl, clipped)

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
    let reported = false
    let watchLeft = WATCH_FRAMES
    /**
     * Whether the next report fires `onReveal`: always the first, and a later
     * one only once a correction scrolled. A match that no scroll can bring
     * wholly into view would otherwise re-flash in place every few frames.
     */
    let owed = true
    // Each frame re-measures and either reports or corrects, never both, so no
    // scroll of ours is in flight when the flash mounts. A correction resets
    // the stable count. At most 1 + (MAX_REVEAL_FRAMES - 1) scrolls per settle.
    const tick = (): void => {
      revealFrame = 0
      if (disposed || range.collapsed) return
      // Idempotent, so every frame: an inner box whose content settles late
      // (an output view re-pinning to its bottom) is re-centred.
      revealInNestedBoxes(range, scrollEl, clipped)
      if (reported) {
        // Watching. Only a match pushed out of view restarts the settle loop;
        // a few px off centre is not worth a jump under the user's eyes.
        watchLeft--
        if (isWhollyVisible(range)) {
          if (watchLeft > 0) revealFrame = requestAnimationFrame(tick)
          else watchUserScroll(false)
          return
        }
        reported = false
        owed = false
        frames = 0
        stable = 0
      }
      frames++
      const target = pendingTarget()
      stable = target === null ? stable + 1 : 0
      // Past the cap the match is as close as layout will let it get; still
      // report it so the find indicator marks where it landed.
      if (stable >= STABLE_FRAMES || frames >= MAX_REVEAL_FRAMES) {
        // A re-report replays the flash where the match now is.
        if (owed) engineOptions.onReveal?.(range)
        owed = false
        reported = true
        if (watchLeft > 0) {
          watchUserScroll(true)
          revealFrame = requestAnimationFrame(tick)
        } else {
          watchUserScroll(false)
        }
        return
      }
      if (target !== null) {
        scrollTo(target)
        owed = true
      }
      revealFrame = requestAnimationFrame(tick)
    }
    revealFrame = requestAnimationFrame(tick)
  }

  function setCurrent(idx: number): void {
    currentIdx = idx
    const r = idx === PENDING ? undefined : matches[idx]
    const anchor = r ? { node: r.startContainer, offset: r.startOffset } : null
    // A live recompute rebuilds every Range yet can keep the same match
    // current: compare where it starts, not the Range, before undoing its
    // reveal. Pending (setQuery, dispose) always differs from a current match.
    if (anchor?.node !== currentAnchor?.node || anchor?.offset !== currentAnchor?.offset) {
      restoreClipped(clipped)
    }
    currentAnchor = anchor
  }

  /**
   * The first rendered match from `start`, stepping by `dir` and wrapping, or
   * null when none renders (at most one pass over the matches).
   */
  function firstRendered(start: number, dir: 1 | -1): number | null {
    const n = matches.length
    for (let i = 0, idx = start; i < n; i++, idx = (idx + dir + n) % n) {
      if (isRendered(matches[idx])) return idx
    }
    return null
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
      releaseForced()
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      recompute(null)
    },
    next() {
      if (disposed || matches.length === 0) return
      // No match at/after the viewport top → the nearest one above it (the last).
      const idx = firstRendered(
        currentIdx === PENDING
          ? Math.min(viewportPick(), matches.length - 1)
          : (currentIdx + 1) % matches.length,
        1
      )
      if (idx !== null) select(idx)
    },
    prev() {
      if (disposed || matches.length === 0) return
      // A pick of `matches.length` ("none at/after") steps back to the last match.
      const from = currentIdx === PENDING ? viewportPick() : currentIdx
      const idx = firstRendered((from - 1 + matches.length) % matches.length, -1)
      if (idx !== null) select(idx)
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
      releaseForced()
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
