/**
 * The ONE stick-to-bottom implementation: keep a scroll box pinned to its end
 * while content grows under it, until the user scrolls away on purpose.
 *
 * Pinning is done by a `ResizeObserver` on the content element (and on the
 * scroller itself, for a shrinking viewport). Its callbacks run after layout and
 * before paint, so `scrollTop = scrollHeight` assigned inside one is painted in
 * the same frame, and moving `scrollTop` changes no observed size, so it cannot
 * loop. Unlike a mutation observer this also catches growth that never touches
 * the DOM: `content-visibility: auto` placeholders swapping for real heights,
 * images, fonts, expand/collapse. Pins are always instant — a smooth scroll
 * restarted per mutation chases a moving target and falls behind it.
 *
 * `following` is switched off only by user INTENT (an upward wheel / touch drag /
 * key, or a scrollbar drag that moves up). A scroll event with no user input in
 * the last ~250 ms never changes it: programmatic scrolls, scroll anchoring, the
 * clamp when content shrinks and find-in-chat reveals all look like "the view
 * moved up" and must not be mistaken for the user leaving.
 *
 * All geometry is the scroller's own CSS px (scrollTop / scrollHeight /
 * clientHeight — never rects), so CSS `zoom` on the scroller or an ancestor needs
 * no correction, and every comparison is a tolerance, never an equality.
 *
 * Attaching touches no layout. Every consumer sits in a transcript whose cards
 * `content-visibility: auto` may be skipping, and reading `scrollTop` /
 * `scrollHeight` / `clientHeight` of a skipped card forces a layout of its
 * contents (that pattern was ~70% of the time to open a 665-message session).
 * So the first pin and the first `isAtBottom` sync wait for the observer's
 * initial notification, which a browser delivers once the box is laid out — see
 * the pin effect. Geometry is read only inside an observer callback, a scroll or
 * input event, or an explicit call (`scrollToBottom`, `jumpToBottom`, and the
 * catch-up when `paused` ends).
 *
 * The scroller and the content element are callback refs backed by state, so
 * they may mount late, unmount and come back (a conditional content div, an
 * accordion body): listeners and observers re-attach to whatever is live.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** A scroll event this soon after user input (or a user-driven scroll) is the user's. */
const USER_INPUT_WINDOW_MS = 250
/** A user-driven scroll that ends this close to the bottom re-arms following. */
const REARM_PX = 4
/** Default distance from the bottom under which `isAtBottom` holds. */
const AT_BOTTOM_PX = 100
/** Further than this many viewports away, `scrollToBottom` jumps instead of animating. */
const FAR_JUMP_VIEWPORTS = 1.5
/** A smooth scroll that never reports `scrollend` is considered over after this long. */
const SMOOTH_FALLBACK_MS = 1000
/** A touch drag must travel this far down before it counts as scrolling up. */
const TOUCH_SLOP_PX = 4

/**
 * Set directly on the scroller whenever `following` changes (no re-render), so
 * tooling that watches the DOM (the scroll bench, verifiers) can read the state.
 */
const FOLLOWING_ATTR = 'data-following'

/** Keys that scroll the box upwards (Shift+Space is handled beside them). */
const UP_KEYS = new Set(['PageUp', 'ArrowUp', 'Home'])
/** Keys that scroll the box at all: user input for the purposes of the window above. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '])

export interface StickToBottomOptions {
  /** No pinning while true (e.g. a find bar is open and the view must hold still). */
  paused?: boolean
  /** Distance from the bottom, in the scroller's CSS px, under which `isAtBottom` holds. */
  atBottomPx?: number
}

export interface StickToBottom<T extends HTMLElement> {
  /** Callback ref for the scroll box. Stable. */
  scrollerRef: (el: T | null) => void
  /** Callback ref for the element whose size is the content's size. Stable. */
  contentRef: (el: HTMLElement | null) => void
  /** The live scroller, for consumers that take a ref object. Written by `scrollerRef`. */
  scrollerEl: RefObject<T | null>
  /** Mirror of the authoritative `following` ref, for UI. */
  following: boolean
  /** Distance from the bottom is under `atBottomPx`. Re-renders only when it flips. */
  isAtBottom: boolean
  /** Resume following and go to the true bottom, animated when it is close. */
  scrollToBottom: () => void
  /** Resume following and go to the bottom instantly (session switch, first mount). */
  jumpToBottom: () => void
  /** Stop following (e.g. the find bar opened). Re-armed by reaching the bottom. */
  stopFollowing: () => void
}

interface Tracker {
  following: boolean
  paused: boolean
  atBottom: boolean
  atBottomPx: number
  /** `performance.now()` of the last user input; -Infinity before any. */
  lastInputAt: number
  /** The pointer is down on the scroller's own scrollbar. */
  scrollbarHeld: boolean
  /** A finger is on the scroller. */
  touchHeld: boolean
  /** A smooth `scrollToBottom` is in flight. */
  smoothing: boolean
  /**
   * `scrollTop` at the last scroll event or pin: "moved up" is measured from
   * here. `null` until the first pin or scroll event after attaching — nothing
   * on attach may read it (see the layout-free attach note on the hook).
   */
  lastTop: number | null
}

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  // jsdom implements no `isContentEditable`.
  const editableHost = target.closest('[contenteditable]')
  return editableHost !== null && editableHost.getAttribute('contenteditable') !== 'false'
}

/**
 * True when a box between `target` and `root` can itself still scroll UP: the
 * browser hands the wheel/drag to it, so `root` does not move and the user has
 * not left it. Boxes that clip with `overflow: hidden` do not count — the user
 * cannot scroll those.
 */
function innerBoxScrollsUp(target: EventTarget | null, root: HTMLElement): boolean {
  let el = target instanceof Element ? target : null
  while (el && el !== root) {
    if (el.scrollTop > 0) {
      const overflowY = getComputedStyle(el).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll') return true
    }
    el = el.parentElement
  }
  return false
}

export function useStickToBottom<T extends HTMLElement = HTMLElement>(
  options: StickToBottomOptions = {}
): StickToBottom<T> {
  const { paused = false, atBottomPx = AT_BOTTOM_PX } = options

  const scrollerEl = useRef<T | null>(null)
  const [scroller, setScroller] = useState<T | null>(null)
  const [content, setContent] = useState<HTMLElement | null>(null)
  const [following, setFollowingState] = useState(true)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const tracker = useRef<Tracker>({
    following: true,
    paused,
    atBottom: true,
    atBottomPx,
    lastInputAt: -Infinity,
    scrollbarHeld: false,
    touchHeld: false,
    smoothing: false,
    lastTop: null
  })
  const smoothTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scrollerRef = useCallback((el: T | null) => {
    scrollerEl.current = el
    setScroller(el)
  }, [])
  const contentRef = useCallback((el: HTMLElement | null) => setContent(el), [])

  const setFollowing = useCallback((next: boolean) => {
    if (tracker.current.following === next) return
    tracker.current.following = next
    scrollerEl.current?.setAttribute(FOLLOWING_ATTR, String(next))
    setFollowingState(next)
  }, [])

  const endSmooth = useCallback(() => {
    tracker.current.smoothing = false
    if (smoothTimer.current) clearTimeout(smoothTimer.current)
    smoothTimer.current = null
  }, [])

  const pin = useCallback(() => {
    const el = scrollerEl.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    tracker.current.lastTop = el.scrollTop
  }, [])

  const syncAtBottom = useCallback(() => {
    const el = scrollerEl.current
    if (!el) return
    const next = distanceFromBottom(el) < tracker.current.atBottomPx
    if (tracker.current.atBottom === next) return
    tracker.current.atBottom = next
    setIsAtBottom(next)
  }, [])

  const jumpToBottom = useCallback(() => {
    endSmooth()
    setFollowing(true)
    pin()
    syncAtBottom()
  }, [endSmooth, setFollowing, pin, syncAtBottom])

  const scrollToBottom = useCallback(() => {
    const el = scrollerEl.current
    if (!el) return
    const far = distanceFromBottom(el) > FAR_JUMP_VIEWPORTS * el.clientHeight
    if (far || typeof el.scrollTo !== 'function') {
      // A long animation is mostly cv-auto placeholders turning into real
      // heights under it; jump, and let the pin chase the swaps as they land.
      jumpToBottom()
      return
    }
    setFollowing(true)
    endSmooth()
    tracker.current.smoothing = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    // `scrollend` ends it; this is for engines that never send one.
    smoothTimer.current = setTimeout(() => {
      endSmooth()
      if (distanceFromBottom(el) > 1) pin()
    }, SMOOTH_FALLBACK_MS)
  }, [jumpToBottom, setFollowing, endSmooth, pin])

  const stopFollowing = useCallback(() => {
    endSmooth()
    setFollowing(false)
  }, [endSmooth, setFollowing])

  useLayoutEffect(() => {
    tracker.current.atBottomPx = atBottomPx
  }, [atBottomPx])

  useLayoutEffect(() => {
    const was = tracker.current.paused
    tracker.current.paused = paused
    // Growth during the pause was not followed; catch up when it ends.
    if (was && !paused && tracker.current.following) pin()
  }, [paused, pin])

  // The user's scrolling: intent listeners on the scroller, and the scroll
  // events that follow from it.
  useLayoutEffect(() => {
    if (!scroller) return
    const s = tracker.current
    const doc = scroller.ownerDocument
    // No geometry is read here (see the layout-free attach note on the hook): the
    // first pin or the first scroll event establishes where "moved up" is measured from.
    s.lastTop = null
    scroller.setAttribute(FOLLOWING_ATTR, String(s.following))
    let touchLastY = 0
    // How far the finger has moved down since it last moved up.
    let touchDownTravel = 0

    const markInput = (): void => {
      s.lastInputAt = performance.now()
    }
    const userDriven = (): boolean =>
      s.scrollbarHeld || s.touchHeld || performance.now() - s.lastInputAt <= USER_INPUT_WINDOW_MS
    // Up-intent: leave the bottom NOW. Waiting for the scroll event would let a
    // resize callback in between pin the view back under the user's hand.
    const upIntent = (target: EventTarget | null): void => {
      markInput()
      // Nothing to scroll away from, or an inner box takes this one.
      if (scroller.scrollHeight <= scroller.clientHeight + 1) return
      if (innerBoxScrollsUp(target, scroller)) return
      endSmooth()
      setFollowing(false)
    }

    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return // pinch-zoom, not scrolling
      if (e.deltaY < 0) upIntent(e.target)
      else markInput()
    }
    const onTouchStart = (e: TouchEvent): void => {
      const touch = e.touches[0]
      if (!touch) return
      s.touchHeld = true
      touchLastY = touch.clientY
      touchDownTravel = 0
      markInput()
    }
    const onTouchMove = (e: TouchEvent): void => {
      const touch = e.touches[0]
      if (!touch) return
      const dy = touch.clientY - touchLastY
      touchLastY = touch.clientY
      touchDownTravel = dy > 0 ? touchDownTravel + dy : 0
      markInput()
      // A finger moving down drags the content down: the view goes UP.
      if (touchDownTravel > TOUCH_SLOP_PX) upIntent(e.target)
    }
    const onTouchEnd = (): void => {
      s.touchHeld = false
      markInput() // a fling's momentum scroll events are still the user's
    }
    const onPointerDown = (e: PointerEvent): void => {
      // Its own target is the scroller only for the scrollbar (and bare padding).
      if (e.target !== scroller) return
      s.scrollbarHeld = true
      markInput()
    }
    const onPointerEnd = (): void => {
      s.scrollbarHeld = false
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!SCROLL_KEYS.has(e.key)) return
      const target = e.target
      if (isEditable(target)) return // the composer uses arrows and Home for the caret
      // Keys scroll this box when focus is inside it, or nowhere in particular.
      const inScope =
        target === doc.body ||
        target === doc.documentElement ||
        target === doc ||
        (target instanceof Node && scroller.contains(target))
      if (!inScope) return
      if (UP_KEYS.has(e.key) || (e.key === ' ' && e.shiftKey)) upIntent(target)
      else markInput()
    }

    const onScroll = (): void => {
      const top = scroller.scrollTop
      syncAtBottom()
      if (userDriven()) {
        // Chaining: a continuous gesture (smooth wheel, fling) keeps its own
        // scroll events inside the window.
        markInput()
        if (distanceFromBottom(scroller) <= REARM_PX) setFollowing(true)
        else if (s.lastTop !== null && top < s.lastTop - 0.5) {
          endSmooth()
          setFollowing(false)
        }
      }
      s.lastTop = top
    }
    const onScrollEnd = (): void => {
      if (!s.smoothing) return
      endSmooth()
      if (distanceFromBottom(scroller) > 1) pin()
    }

    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: true })
    scroller.addEventListener('touchend', onTouchEnd, { passive: true })
    scroller.addEventListener('touchcancel', onTouchEnd, { passive: true })
    scroller.addEventListener('pointerdown', onPointerDown, { passive: true })
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('scrollend', onScrollEnd, { passive: true })
    doc.addEventListener('pointerup', onPointerEnd, { passive: true })
    doc.addEventListener('pointercancel', onPointerEnd, { passive: true })
    doc.addEventListener('keydown', onKeyDown, { capture: true, passive: true })
    return () => {
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('touchend', onTouchEnd)
      scroller.removeEventListener('touchcancel', onTouchEnd)
      scroller.removeEventListener('pointerdown', onPointerDown)
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('scrollend', onScrollEnd)
      doc.removeEventListener('pointerup', onPointerEnd)
      doc.removeEventListener('pointercancel', onPointerEnd)
      doc.removeEventListener('keydown', onKeyDown, { capture: true })
      s.scrollbarHeld = false
      s.touchHeld = false
    }
  }, [scroller, endSmooth, setFollowing, syncAtBottom, pin])

  // The pin itself.
  useLayoutEffect(() => {
    if (!scroller) return
    const s = tracker.current
    const settle = (): void => {
      // A smooth scrollToBottom in flight is finished instantly rather than left
      // aiming at a bottom that has moved, paused or not.
      if (s.following && (!s.paused || s.smoothing)) {
        pin()
        endSmooth()
      }
      syncAtBottom()
    }
    // Attaching reads no geometry. The first pin and the first `isAtBottom` sync
    // happen in the observer's initial notification, which the browser delivers
    // once the observed box is laid out and before it paints: an on-screen box
    // never paints unpinned, and one that `content-visibility: auto` is skipping
    // reports only when it becomes relevant, instead of being laid out up front.
    // jsdom (and so most unit tests) has no ResizeObserver: settle at once.
    if (typeof ResizeObserver === 'undefined') {
      settle()
      return
    }
    const observer = new ResizeObserver(settle)
    observer.observe(scroller)
    if (content) observer.observe(content, { box: 'border-box' })
    return () => observer.disconnect()
  }, [scroller, content, pin, endSmooth, syncAtBottom])

  useEffect(
    () => () => {
      if (smoothTimer.current) clearTimeout(smoothTimer.current)
    },
    []
  )

  return {
    scrollerRef,
    contentRef,
    scrollerEl,
    following,
    isAtBottom,
    scrollToBottom,
    jumpToBottom,
    stopFollowing
  }
}
