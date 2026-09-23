import { useLayoutEffect, useMemo, useRef } from 'react'
import { effectiveZoom } from '../../../lib/effective-zoom'

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
 * Size the layer to the scroll container and put the flash over `rect` (the
 * match, page px), in the layer's CSS px. The one positioning path, used both
 * when the flash mounts and each time the chat scrolls under it.
 */
function placeFlash(
  layer: HTMLElement,
  flash: HTMLElement,
  text: HTMLElement | null,
  range: Range,
  rect: DOMRect,
  scrollEl: HTMLElement
): void {
  // Clip to the scroll container's visible box (both share an offsetParent).
  layer.style.left = `${scrollEl.offsetLeft}px`
  layer.style.top = `${scrollEl.offsetTop}px`
  layer.style.width = `${scrollEl.clientWidth}px`
  layer.style.height = `${scrollEl.clientHeight}px`

  const layerRect = layer.getBoundingClientRect()
  const z = effectiveZoom(layer, layerRect)
  const width = rect.width / z
  const height = rect.height / z
  flash.style.left = `${(rect.left - layerRect.left) / z + width / 2}px`
  flash.style.top = `${(rect.top - layerRect.top) / z + height / 2}px`

  const source = range.startContainer.parentElement
  if (!text || !source) {
    flash.style.width = `${width}px`
    flash.style.height = `${height}px`
    return
  }
  const cs = getComputedStyle(source)
  flash.style.fontFamily = cs.fontFamily
  flash.style.fontWeight = cs.fontWeight
  flash.style.fontStyle = cs.fontStyle
  flash.style.letterSpacing = cs.letterSpacing
  flash.style.fontSize = cs.fontSize
  // offsetWidth ignores the transform, so this is the clone's unscaled width.
  const cloneWidth = text.offsetWidth
  const s = cloneWidth > 0 ? width / cloneWidth : 1
  flash.style.setProperty('--s', String(s))
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
 * A single-line match gets a clone of its text, styled like the source and
 * scaled by `--s` so it overlays the match exactly; a match that wraps across
 * lines gets a plain box over its bounding rect.
 *
 * Rects are page px; the flash's `left`/`top`/`width`/`height` resolve in the
 * layer's own CSS px, which differ under the app's `zoom: uiFontScale` (THE
 * ZOOM TRAP in `use-anchored-menu.ts`). Every measurement is divided by the
 * layer's effective zoom before it is written.
 *
 * It follows its match while the chat scrolls (a reveal's own late layout
 * shifts, the user's wheel) instead of vanishing, and removes itself only once
 * the match is entirely outside the scroll container or gone from the DOM.
 * Repositioning only moves it; the animation keeps running.
 */
export function ChatSearchFlash({ range, scrollEl, onDone }: Props): React.JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  const flashRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const singleLine = useMemo(
    () => typeof range.getClientRects === 'function' && range.getClientRects().length === 1,
    [range]
  )

  useLayoutEffect(() => {
    const layer = layerRef.current
    const flash = flashRef.current
    if (!layer || !flash || typeof range.getBoundingClientRect !== 'function') return
    placeFlash(layer, flash, textRef.current, range, range.getBoundingClientRect(), scrollEl)

    // rAF-throttled: at most one re-measure per frame however many scroll
    // events arrive.
    let frame = 0
    const onScroll = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const rect = range.getBoundingClientRect()
        if (range.collapsed || isOutside(rect, scrollEl.getBoundingClientRect())) {
          onDone()
          return
        }
        placeFlash(layer, flash, textRef.current, range, rect, scrollEl)
      })
    }
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scrollEl.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [range, scrollEl, onDone])

  return (
    <div
      ref={layerRef}
      data-search="skip"
      aria-hidden="true"
      className="absolute pointer-events-none overflow-hidden z-40"
    >
      <div
        ref={flashRef}
        data-testid="ChatSearchOverlay.flash"
        data-kind={singleLine ? 'text' : 'box'}
        className="chat-search-flash"
        onAnimationEnd={onDone}
      >
        {singleLine && <span ref={textRef}>{range.toString()}</span>}
      </div>
    </div>
  )
}
