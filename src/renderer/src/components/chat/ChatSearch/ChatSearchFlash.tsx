import { useLayoutEffect, useMemo, useRef } from 'react'
import { effectiveZoom } from '../../../lib/effective-zoom'

/** Character rects whose tops are within this many page px share a line. */
const SAME_LINE_PX = 2

/** One line's worth of the match: its own Range, and the text to clone. */
interface Fragment {
  range: Range
  text: string
}

/** True when `rect` shares no area with `box` (both page px). */
function isOutside(rect: DOMRect, box: DOMRect): boolean {
  return (
    rect.bottom <= box.top ||
    rect.top >= box.bottom ||
    rect.right <= box.left ||
    rect.left >= box.right
  )
}

/**
 * Split the match into one fragment per rendered line. The bounding rect of a
 * match that wraps spans both lines' full extent, so a bubble over it would be
 * a blank bar covering unrelated text.
 *
 * A match always lies within ONE text node (the engine matches per text
 * node), so it is measured one code point at a time and consecutive
 * characters whose tops agree are grouped. Zero-width characters (whitespace
 * collapsed at a soft wrap, combining marks) join the line they follow and do
 * not start one; collapsed whitespace at a line's ends is dropped so the clone
 * is no wider than what is painted.
 */
function lineFragments(range: Range): Fragment[] {
  const node = range.startContainer
  if (
    !(node instanceof Text) ||
    node !== range.endContainer ||
    typeof range.getBoundingClientRect !== 'function'
  ) {
    return [{ range, text: range.toString() }]
  }
  const data = node.data
  type Char = { start: number; end: number; painted: boolean; top: number }
  const lines: Char[][] = []
  const probe = document.createRange()
  for (let i = range.startOffset; i < range.endOffset;) {
    const end = Math.min(range.endOffset, i + ((data.codePointAt(i) ?? 0) > 0xffff ? 2 : 1))
    probe.setStart(node, i)
    probe.setEnd(node, end)
    const rect = probe.getBoundingClientRect()
    const char = { start: i, end, painted: rect.width > 0, top: rect.top }
    const line = lines[lines.length - 1]
    const lineTop = line?.find((c) => c.painted)?.top
    if (
      line &&
      (!char.painted || lineTop === undefined || Math.abs(char.top - lineTop) <= SAME_LINE_PX)
    ) {
      line.push(char)
    } else {
      lines.push([char])
    }
    i = end
  }
  const collapsed = (c: Char): boolean => !c.painted && /^\s+$/.test(data.slice(c.start, c.end))
  const fragments: Fragment[] = []
  for (const line of lines) {
    let first = 0
    let last = line.length - 1
    while (first <= last && collapsed(line[first])) first++
    while (last >= first && collapsed(line[last])) last--
    if (!line.slice(first, last + 1).some((c) => c.painted)) continue
    const r = document.createRange()
    r.setStart(node, line[first].start)
    r.setEnd(node, line[last].end)
    fragments.push({ range: r, text: data.slice(line[first].start, line[last].end) })
  }
  return fragments
}

/**
 * Every box between the match and the chat that clips it (any overflow but
 * `visible`), innermost first, ending with the chat itself. A match scrolled
 * out of an inner box is invisible even while it is inside the chat's box.
 */
function clipBoxes(range: Range, scrollEl: HTMLElement): HTMLElement[] {
  const boxes: HTMLElement[] = []
  for (let el = range.startContainer.parentElement; el && el !== scrollEl; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue
    const cs = getComputedStyle(el)
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') boxes.push(el)
  }
  boxes.push(scrollEl)
  return boxes
}

/** Give the clones the matched text's font, so they render like the source. */
function copyFont(root: HTMLElement, source: Element | null): void {
  if (!source) return
  const cs = getComputedStyle(source)
  root.style.fontFamily = cs.fontFamily
  root.style.fontWeight = cs.fontWeight
  root.style.fontStyle = cs.fontStyle
  root.style.letterSpacing = cs.letterSpacing
  root.style.fontSize = cs.fontSize
}

/**
 * Size the layer to the scroll container and put each bubble over its line of
 * the match, in the layer's CSS px. The one positioning path, used both when
 * the flash mounts and each time the chat, or a box inside it, scrolls.
 */
function placeFlash(
  layer: HTMLElement,
  bubbles: HTMLElement[],
  fragments: Fragment[],
  scrollEl: HTMLElement
): void {
  // Clip to the scroll container's visible box (both share an offsetParent).
  layer.style.left = `${scrollEl.offsetLeft}px`
  layer.style.top = `${scrollEl.offsetTop}px`
  layer.style.width = `${scrollEl.clientWidth}px`
  layer.style.height = `${scrollEl.clientHeight}px`

  const layerRect = layer.getBoundingClientRect()
  const z = effectiveZoom(layer, layerRect)
  bubbles.forEach((bubble, i) => {
    const rect = fragments[i].range.getBoundingClientRect()
    // Positioned by its centre (the CSS translates it back by half its size).
    bubble.style.left = `${(rect.left - layerRect.left + rect.width / 2) / z}px`
    bubble.style.top = `${(rect.top - layerRect.top + rect.height / 2) / z}px`
    // offsetWidth ignores the transform, so this is the clone's unscaled width.
    const cloneWidth = (bubble.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0
    bubble.style.setProperty('--s', String(cloneWidth > 0 ? rect.width / z / cloneWidth : 1))
  })
}

interface Props {
  /** The match the engine just revealed. */
  range: Range
  /** The chat scroll container; the flash layer is sized to its box. */
  scrollEl: HTMLElement
  onDone: () => void
}

/**
 * The find indicator: a yellow bubble that pops over the match a search step
 * landed on (macOS-style). It lives in a layer that is a SIBLING of the scroll
 * container — inserting nodes inside it would trip the search engine's
 * MutationObserver and ChatPanel's auto-scroll observer.
 *
 * Each line of the match gets its own bubble holding a clone of that line's
 * text, styled like the source and scaled by `--s` so it overlays the line
 * exactly; a single-line match is the one-bubble case. The bubbles animate
 * together.
 *
 * Rects are page px; a bubble's `left`/`top` resolve in the layer's own CSS
 * px, which differ under the app's `zoom: uiFontScale` (THE ZOOM TRAP in
 * `use-anchored-menu.ts`). Every measurement is divided by the layer's
 * effective zoom before it is written.
 *
 * It follows its match while the chat or a box inside it scrolls (a reveal's
 * own late layout shifts, the user's wheel) instead of vanishing, and removes
 * itself only once the match is entirely outside a box that clips it, or gone
 * from the DOM. Repositioning only moves it; the animation keeps running.
 */
export function ChatSearchFlash({ range, scrollEl, onDone }: Props): React.JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const fragments = useMemo(() => lineFragments(range), [range])

  useLayoutEffect(() => {
    const layer = layerRef.current
    const root = rootRef.current
    if (!layer || !root || typeof range.getBoundingClientRect !== 'function') return
    // Nothing painted, so no animation would ever end and remove it.
    if (fragments.length === 0) {
      onDone()
      return
    }
    const bubbles = Array.from(root.children) as HTMLElement[]
    copyFont(root, range.startContainer.parentElement)
    placeFlash(layer, bubbles, fragments, scrollEl)
    const clips = clipBoxes(range, scrollEl)

    // rAF-throttled: at most one re-measure per frame however many scroll
    // events arrive. Capture phase, because `scroll` does not bubble: this is
    // how a scroll of a box INSIDE the chat reaches the chat.
    let frame = 0
    const onScroll = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const rect = range.getBoundingClientRect()
        if (range.collapsed || clips.some((el) => isOutside(rect, el.getBoundingClientRect()))) {
          onDone()
          return
        }
        placeFlash(layer, bubbles, fragments, scrollEl)
      })
    }
    scrollEl.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      scrollEl.removeEventListener('scroll', onScroll, { capture: true })
      cancelAnimationFrame(frame)
    }
  }, [range, fragments, scrollEl, onDone])

  return (
    <div
      ref={layerRef}
      data-search="skip"
      aria-hidden="true"
      className="absolute pointer-events-none overflow-hidden z-40"
    >
      {/* Unpositioned: the bubbles are placed against the layer. animationend
          bubbles up from the first bubble to finish; they all finish together. */}
      <div
        ref={rootRef}
        data-testid="ChatSearchOverlay.flash"
        data-fragments={fragments.length}
        onAnimationEnd={onDone}
      >
        {fragments.map((f, i) => (
          <div key={i} data-testid="ChatSearchOverlay.flashFragment" className="chat-search-flash">
            <span>{f.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
