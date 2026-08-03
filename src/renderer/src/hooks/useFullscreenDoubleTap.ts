/**
 * Browser-fullscreen toggle for the remote web client on mobile, driven by a
 * double-tap on the chat scroll area (there is no TopBar button — mobile
 * screen space is the whole point of the feature).
 *
 * Everything here is pure DOM: the hook attaches native pointer listeners to
 * the element the caller already owns, and never calls `preventDefault()` —
 * scrolling, tapping links and text selection must all keep working exactly as
 * they do today, so the detector observes and stays out of the way.
 */

import { useEffect, useRef } from 'react'

/** Movement (px) between pointerdown and pointerup that still counts as a tap. */
const TAP_SLOP_PX = 10
/** Max gap (ms) between the two taps' pointerup events. */
const DOUBLE_TAP_MAX_GAP_MS = 350
/** Max distance (px) between the two taps. */
const DOUBLE_TAP_MAX_DIST_PX = 30

/**
 * A tap that lands on (or inside) one of these is the user operating a
 * control, not gesturing at the chat — it never feeds the double-tap streak.
 */
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, summary, [role="button"], [contenteditable="true"]'

/** iOS Safari's pre-standard standalone-mode flag — not in lib.dom's Navigator type. */
type NavigatorWithIosStandalone = Navigator & { standalone?: boolean }

/**
 * The fullscreen gesture is for the remote web client on mobile only: it
 * needs the standard Fullscreen API, and is pointless (and its own toggle
 * would conflict with the OS chrome) once the page is already running as an
 * installed standalone PWA.
 */
export function canUseFullscreenGesture(isMobile: boolean): boolean {
  if (!isMobile || window.api.platform !== 'web') return false
  if (
    document.fullscreenEnabled !== true ||
    typeof document.documentElement.requestFullscreen !== 'function' ||
    typeof document.exitFullscreen !== 'function'
  ) {
    return false
  }
  if (window.matchMedia('(display-mode: standalone)').matches) return false
  if ((navigator as NavigatorWithIosStandalone).standalone) return false
  return true
}

/** Enter fullscreen, or leave it if we're already there. */
export function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {})
  } else {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
  }
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest(INTERACTIVE_SELECTOR) !== null
}

/**
 * Toggle browser fullscreen when the user double-taps `ref`.
 *
 * Only `pointerType === 'touch'` participates — a desktop double-click must
 * never yank the window into fullscreen. Tap state lives in effect-local
 * variables, so no tap ever causes a re-render.
 *
 * @param onToggle called after a gesture actually toggled fullscreen (used to
 *   retire the one-time discovery hint).
 */
export function useFullscreenDoubleTap(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  onToggle?: () => void
): void {
  // Kept in a ref so a new callback identity never re-attaches the listeners.
  const onToggleRef = useRef(onToggle)
  useEffect(() => {
    onToggleRef.current = onToggle
  }, [onToggle])

  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) return

    let downX = 0
    let downY = 0
    let downIsTapCandidate = false
    // 0 = no streak in progress.
    let lastTapAt = 0
    let lastTapX = 0
    let lastTapY = 0

    const resetStreak = (): void => {
      lastTapAt = 0
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return
      if (isInteractiveTarget(e.target)) {
        downIsTapCandidate = false
        resetStreak()
        return
      }
      downIsTapCandidate = true
      downX = e.clientX
      downY = e.clientY
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return
      if (isInteractiveTarget(e.target)) {
        downIsTapCandidate = false
        resetStreak()
        return
      }
      if (!downIsTapCandidate) return
      downIsTapCandidate = false

      // A scroll drag is not a tap.
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_SLOP_PX) {
        resetStreak()
        return
      }

      const now = Date.now()
      const qualifies =
        lastTapAt !== 0 &&
        now - lastTapAt <= DOUBLE_TAP_MAX_GAP_MS &&
        Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) <= DOUBLE_TAP_MAX_DIST_PX

      if (!qualifies) {
        // A tap that misses the window/distance re-anchors the streak rather
        // than clearing it, so a stray earlier tap can't swallow the user's
        // genuine double-tap (tap, pause, tap-tap must still toggle).
        lastTapAt = now
        lastTapX = e.clientX
        lastTapY = e.clientY
        return
      }

      // The streak is spent — a third tap starts fresh instead of immediately
      // toggling back.
      resetStreak()

      // Android Chrome's double-tap selects the word under the finger (iOS
      // doesn't); flipping fullscreen mid-selection is not what was asked for.
      const selection = window.getSelection?.()
      if (selection && !selection.isCollapsed) return

      toggleFullscreen()
      onToggleRef.current?.()
    }

    // Passive: the detector never calls preventDefault(), so the browser is
    // free to scroll/select as usual.
    el.addEventListener('pointerdown', onPointerDown, { passive: true })
    el.addEventListener('pointerup', onPointerUp, { passive: true })
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointerup', onPointerUp)
    }
  }, [ref, enabled])
}
