/**
 * use-anchored-menu — position a dropdown so no `overflow` ancestor clips it.
 *
 * THE DEFECT. Every picker in the app drew its list as `position: absolute`
 * under the trigger, which keeps the menu inside the trigger's clipping chain.
 * That is invisible in the composer (nothing clips there) and fatal in
 * settings: a group card is `overflow-hidden` (ADR-065's one row vocabulary
 * draws its divider that way), the page body is `overflow-y-auto`, and a sheet
 * adds a third scroll body — so on Default models › Opus 4.8 the effort menu
 * was cut at the card's bottom edge with "High" half visible and Extra high /
 * Max unreachable.
 *
 * THE FIX. `position: fixed` makes the viewport the containing block, so no
 * `overflow` ancestor clips the menu. It stays in the SAME DOM subtree (no
 * portal): the pickers' click-outside is `ref.contains`, the stacking context
 * is the dialog's, and the theme tokens are inherited — all three would need
 * separate work with a portal, for nothing.
 *
 * THE ZOOM TRAP. `SessionView` renders the whole app under CSS
 * `zoom: uiFontScale`. Inside a zoomed subtree a fixed element's `top`/`left`
 * resolve in the ZOOMED px, while `getBoundingClientRect()` reports page px
 * (Chromium's standardised zoom) — at 115% a menu placed at the measured
 * `rect.bottom` lands 15% further down the window than its trigger. Every
 * measured coordinate is therefore divided by the effective scale, which is
 * derived from the anchor itself rather than from the settings store:
 * `rect.width / el.offsetWidth` — `offsetWidth` is in the element's own CSS px
 * and the rect is in page px, so the ratio IS the effective zoom, whichever
 * ancestor applies it (and 1 when none does).
 *
 * WHAT SCROLL DOES. A fixed menu does not move with its anchor, so a scroll
 * outside the menu RE-MEASURES it — the menu follows the trigger. It used to
 * close instead, which lost to the app's own scrolling: clicking a trigger that
 * is only half visible scrolls it into view AFTER the menu opens (the browser
 * does this for the focus the click gives the button), and that scroll killed
 * the menu the click had just opened — reproduced in Settings › Engines ›
 * Codex, where such a trigger could not be opened at all. Trackpad inertia
 * after a deliberate scroll does the same. The menu now closes only once the
 * anchor's rect is entirely outside the viewport, which is the one case where a
 * fixed menu really would be stranded beside nothing. Scrolling the menu's own
 * option list is exempt from both. Accepted: while the anchor is inside the
 * viewport but clipped by an `overflow` ancestor, the menu tracks the clipped
 * anchor and stays visible — the alternative is per-ancestor clip tests for a
 * case the user is actively scrolling out of.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import { effectiveZoom } from '../../lib/effective-zoom'

export interface AnchoredMenu {
  style: React.CSSProperties
  side: 'up' | 'down'
}

/** The menus' `max-h-72` (288px) + the 4px gap: the room a side needs to fit. */
const MENU_ROOM = 292

/** Gap between the trigger and the menu, in the anchor's own CSS px. */
const GAP = 4

/** Keep the menu this far from the viewport's right edge when it overflows. */
const EDGE = 8

/** The anchor and the viewport in the anchor's own CSS px, plus that scale. */
interface Frame {
  scale: number
  top: number
  bottom: number
  left: number
  right: number
  width: number
  vh: number
  vw: number
}

/**
 * Measure the anchor and the viewport in the anchor's OWN CSS px — the space a
 * fixed offset resolves in. `offsetWidth` is already in that space while the
 * rect is in page px, so their ratio is the effective zoom (THE ZOOM TRAP
 * above). Both the placement pass and the scroll handler read through this, so
 * "still on screen?" is asked in the same coordinates the menu is placed in.
 */
function frameOf(anchor: HTMLElement): Frame {
  const rect = anchor.getBoundingClientRect()
  const scale = effectiveZoom(anchor, rect)
  return {
    scale,
    top: rect.top / scale,
    bottom: rect.bottom / scale,
    left: rect.left / scale,
    right: rect.right / scale,
    width: rect.width / scale,
    vh: window.innerHeight / scale,
    vw: window.innerWidth / scale
  }
}

/**
 * Position a menu next to `anchorRef` with `position: fixed`, so no overflow
 * ancestor clips it.
 *
 * Measured when `open` turns true, and re-measured on window resize and on any
 * scroll outside the menu itself, so the fixed menu follows its anchor; it
 * closes only once the anchor has left the viewport entirely. `placement` is
 * the PREFERRED side: it flips when that side has less room than the menu needs
 * and the other side has more.
 *
 * Returns `null` while closed, and on the first render of an open menu — the
 * measurement happens in a layout effect, before paint, so the caller renders
 * once without a style and never shows it unpositioned.
 */
export function useAnchoredMenu({
  open,
  anchorRef,
  menuRef,
  placement,
  onClose
}: {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  menuRef: React.RefObject<HTMLElement | null>
  placement: 'up' | 'down'
  onClose: () => void
}): AnchoredMenu | null {
  const [anchored, setAnchored] = useState<AnchoredMenu | null>(null)

  // Read through a ref so the effect below depends on `open`/`placement` only:
  // call sites pass inline arrows, and re-running would re-measure (and
  // re-register the listeners) on every render of their parent.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    if (!open) {
      setAnchored(null)
      return
    }

    const measure = (): void => {
      const anchor = anchorRef.current
      if (!anchor) return
      const menu = menuRef.current

      // Take the menu out of flow BEFORE measuring the anchor. On the render
      // that opens it the menu is still statically positioned, so it grows the
      // row it sits in — and in a vertically centred row that moves the very
      // anchor we are about to measure.
      if (menu) menu.style.position = 'fixed'

      const f = frameOf(anchor)

      const room = { down: f.vh - f.bottom, up: f.top }
      const other = placement === 'down' ? 'up' : 'down'
      const side = room[placement] < MENU_ROOM && room[other] > room[placement] ? other : placement

      const minWidth = f.width
      let left = f.left
      // Only ONE inset is ever set; the other stays `auto` so the menu grows
      // away from the trigger rather than being stretched between two edges.
      const inset: React.CSSProperties =
        side === 'down' ? { top: f.bottom + GAP } : { bottom: f.vh - f.top + GAP }

      // Second pass: the menu can be wider than its trigger (`w-max`), so a
      // trigger near the right edge would push it off screen. Apply what we
      // have, measure the result, and shift left by the overflow.
      if (menu) {
        menu.style.left = `${left}px`
        menu.style.minWidth = `${minWidth}px`
        menu.style.top = inset.top === undefined ? '' : `${inset.top}px`
        menu.style.bottom = inset.bottom === undefined ? '' : `${inset.bottom}px`
        const overflow = menu.getBoundingClientRect().right / f.scale - (f.vw - EDGE)
        if (overflow > 0) left -= overflow
      }

      setAnchored({ style: { position: 'fixed', left, minWidth, ...inset }, side })
    }

    measure()

    const onScroll = (e: Event): void => {
      const menu = menuRef.current
      if (menu && e.target instanceof Node && menu.contains(e.target)) return
      const anchor = anchorRef.current
      if (!anchor) return

      // The anchor moved under a fixed menu: follow it, unless it has left the
      // viewport altogether — only then is there nothing left to sit beside.
      const f = frameOf(anchor)
      if (f.bottom <= 0 || f.top >= f.vh || f.right <= 0 || f.left >= f.vw) {
        closeRef.current()
        return
      }
      measure()
    }
    // Capture phase: a scroll event does not bubble, but it is still seen on
    // the way down to its target, which is how an arbitrary scroll container
    // deep in the dialog reaches us without a listener per container.
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', measure)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, placement, anchorRef, menuRef])

  return open ? anchored : null
}
