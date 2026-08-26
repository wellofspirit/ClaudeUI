/**
 * Horizontal-swipe navigation between adjacent tabs, for mobile content panes.
 *
 * Same posture as `useFullscreenDoubleTap`: pure DOM listeners on an element the
 * caller already owns, attached passively, and **never** `preventDefault()`.
 * Vertical scrolling, text selection and native controls must keep working
 * exactly as they do without the hook, so the detector observes and gets out of
 * the way the moment the gesture looks vertical.
 *
 * The caller is expected to set `touch-action: pan-y` on the same element: that
 * is what tells the browser to own vertical panning and leave horizontal drags
 * to us, without any `preventDefault()` on our side. A descendant that genuinely
 * scrolls horizontally therefore needs its own `touch-action` AND the
 * `data-hscroll` marker below.
 */

import { useEffect, useRef } from 'react'

/** Horizontal travel (px) a completed drag needs before it changes tab. */
export const SWIPE_THRESHOLD_PX = 50
/** Travel (px) at which the gesture commits to one axis and stays there. */
export const DIRECTION_LOCK_PX = 12

/**
 * A drag that starts on one of these is the user operating a control (dragging
 * a range slider, selecting text in a field), not gesturing at the pane.
 */
const CONTROL_SELECTOR = 'input, textarea, select, [contenteditable="true"]'

/**
 * True when the gesture starts inside something the browser may want to scroll
 * horizontally itself. Two ways to qualify, walking up to (but not including)
 * `root`:
 *
 *  - an explicit `[data-hscroll]` marker — the reliable opt-out, and the one to
 *    reach for;
 *  - any ancestor whose computed `overflow-x` is `auto`/`scroll` AND that has at
 *    least a pixel of horizontal overflow. Note this is BROADER than "a
 *    horizontal scroller": `overflow-x` computes to `auto` on every
 *    `overflow-y: auto` box too, so a merely vertical scroller that happens to
 *    overflow sideways (a stray wide child) also matches.
 *
 * That over-matching is the safe direction. A false positive costs one ignored
 * swipe — the tab bar is still right there — while a false negative steals a
 * scroll the user was actually performing, which is the failure people notice.
 *
 * `root` itself is excluded for exactly this reason: it is a vertical scroller,
 * so its own `overflow-x` is always `auto` and any sub-pixel rounding would
 * disable the gesture everywhere.
 */
function startsInHorizontalScroller(target: EventTarget | null, root: HTMLElement): boolean {
  let el = target instanceof Element ? target : null
  while (el && el !== root) {
    if (el.hasAttribute('data-hscroll')) return true
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflowX = getComputedStyle(el).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') return true
    }
    el = el.parentElement
  }
  return false
}

export interface SwipeTabsOptions {
  /** Index of the currently shown tab. */
  index: number
  /** Total number of tabs. */
  count: number
  /** Called with the index to move to. Never called with an out-of-range value. */
  onChange: (nextIndex: number) => void
  /** Detach entirely when false (default true). */
  enabled?: boolean
}

/**
 * Move between adjacent tabs when the user swipes horizontally across `ref`.
 *
 * Swiping left (finger right→left) advances; swiping right goes back. The ends
 * are hard stops — there is no wrap-around, because a tab bar shows where you
 * are and wrapping from the last tab to the first reads as a glitch.
 *
 * Only touch/pen pointers participate: a mouse drag on desktop must never
 * change tab. Gesture state lives in effect-local variables, so dragging never
 * causes a re-render.
 */
export function useSwipeTabs(
  ref: React.RefObject<HTMLElement | null>,
  { index, count, onChange, enabled = true }: SwipeTabsOptions
): void {
  // Kept in refs so a new tab index / callback identity never re-attaches the
  // listeners mid-gesture (which would drop the in-flight drag).
  const indexRef = useRef(index)
  const onChangeRef = useRef(onChange)
  const countRef = useRef(count)
  indexRef.current = index
  onChangeRef.current = onChange
  countRef.current = count

  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) return

    /**
     * The pointer that started the gesture; null = not tracking. Identity, not
     * a boolean, because a phone can report several at once: without it a
     * second finger would overwrite the origin and ANY finger's release would
     * be judged as the swipe. (iOS ignores `user-scalable=no`, so a pinch over
     * this pane is always reachable.)
     */
    let pointerId: number | null = null
    let startX = 0
    let startY = 0
    /** null = axis not decided yet. */
    let axis: 'h' | 'v' | null = null

    const reset = (): void => {
      pointerId = null
      axis = null
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
      // A second finger while a gesture is in flight means pinch/zoom, not a
      // swipe. Abandon rather than re-anchor — the first finger's release must
      // not be read as a one-finger swipe afterwards.
      if (pointerId !== null) {
        reset()
        return
      }
      const el2 = e.target instanceof Element ? e.target : null
      if (el2?.closest(CONTROL_SELECTOR) || startsInHorizontalScroller(e.target, el)) {
        reset()
        return
      }
      pointerId = e.pointerId
      axis = null
      startX = e.clientX
      startY = e.clientY
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (pointerId === null || e.pointerId !== pointerId || axis !== null) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (Math.abs(dx) < DIRECTION_LOCK_PX && Math.abs(dy) < DIRECTION_LOCK_PX) return
      // Ties go to vertical: scrolling is the common intent, and a diagonal
      // drag that steals the scroll would be the more annoying failure. Once
      // locked the axis never flips — a scroll that drifts sideways at the end
      // must not turn into a tab change.
      axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (pointerId === null || e.pointerId !== pointerId) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      const lockedAxis = axis
      reset()
      if (lockedAxis === 'v') return
      // `null` means the drag never travelled far enough to lock (or the
      // browser coalesced it into a single jump): judge it from the endpoints.
      if (lockedAxis === null && Math.abs(dx) <= Math.abs(dy)) return
      if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return
      const next = indexRef.current + (dx < 0 ? 1 : -1)
      if (next < 0 || next >= countRef.current) return // hard stops, no wrap
      onChangeRef.current(next)
    }

    const onPointerCancel = (e: PointerEvent): void => {
      if (pointerId === null || e.pointerId !== pointerId) return
      reset()
    }

    // Passive: the detector never calls preventDefault(), so the browser stays
    // free to scroll and select as usual.
    el.addEventListener('pointerdown', onPointerDown, { passive: true })
    el.addEventListener('pointermove', onPointerMove, { passive: true })
    el.addEventListener('pointerup', onPointerUp, { passive: true })
    el.addEventListener('pointercancel', onPointerCancel, { passive: true })
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerCancel)
    }
  }, [ref, enabled])
}
