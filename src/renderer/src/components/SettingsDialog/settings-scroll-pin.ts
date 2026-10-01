/**
 * Keep a deep-linked settings group pinned under the pane's top edge while the
 * page is still settling (S7f).
 *
 * A one-shot `scrollIntoView` lands short on a FRESH open: it runs on the first
 * commit, while the page's sections are still loading and growing (measured in
 * the real app: scrollHeight 1059 → 1848 px, Sessions › Trust & protection
 * ending ~550 px below the pane top). With the dialog already open the same
 * link lands exactly. So the scroll is re-applied every time the pane's content
 * resizes — within a window that each resize extends by `settleMs`, never past
 * `maxMs` from the start — and given up at once on any sign the user is
 * scrolling themselves: a wheel, a touch, a pointer press (the scrollbar is the
 * pane's own), or a key.
 *
 * It is driven by RESIZES, never by scroll events: answering the scroll-spy's
 * own marks would snap every newly marked group to the top while the user
 * scrolls (S7d F3).
 *
 * Pure of React and of layout, with every clock and constructor injectable, so
 * it is tested with a fake ResizeObserver — jsdom lays nothing out.
 */

/** The hard cap on how long a deep link keeps its group pinned. */
export const PIN_MAX_MS = 1500

/** The user events that mean "I am scrolling now" — the pin lets go on any of them. */
const PANE_INTENT = ['wheel', 'touchstart', 'pointerdown'] as const

type ResizeObserverCtor = new (callback: () => void) => {
  observe(target: Element): void
  disconnect(): void
}

export interface ScrollPinOptions {
  /** The scroll container: user intent is listened for on it. */
  pane: HTMLElement
  /** What grows while the page settles — observed for size changes. */
  content: Element
  /** Put the target where it belongs. Called at once, then on every resize. */
  apply: () => void
  /** The quiet window after each application (the scroll-spy's, too). */
  settleMs: number
  maxMs?: number
  /**
   * Told the time until which scroll events are the pin's, not the user's —
   * after every application, and `0` when the user takes over.
   */
  onWindow?: (until: number) => void
  now?: () => number
  /** Absent (jsdom, an old engine): the first application is all there is. */
  ResizeObserver?: ResizeObserverCtor
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

/** Pin the target; returns the function that lets go (idempotent). */
export function pinScroll({
  pane,
  content,
  apply,
  settleMs,
  maxMs = PIN_MAX_MS,
  onWindow = () => {},
  now = () => performance.now(),
  ResizeObserver: Observer = globalThis.ResizeObserver as ResizeObserverCtor | undefined,
  setTimeout: schedule = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: unschedule = (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
}: ScrollPinOptions): () => void {
  const start = now()
  const cap = start + maxMs
  const doc = pane.ownerDocument
  let timer: unknown = null
  let observer: InstanceType<ResizeObserverCtor> | null = null
  let done = false

  const stop = (): void => {
    if (done) return
    done = true
    if (timer !== null) unschedule(timer)
    observer?.disconnect()
    for (const type of PANE_INTENT) pane.removeEventListener(type, userTookOver)
    doc.removeEventListener('keydown', userTookOver, true)
  }
  function userTookOver(): void {
    if (done) return
    stop()
    // The user's own scroll is the spy's to follow from the first event.
    onWindow(0)
  }
  /** Apply, and hold the window open `settleMs` past now — never past the cap. */
  const hold = (at: number): void => {
    apply()
    const until = Math.min(cap, at + settleMs)
    onWindow(until)
    if (timer !== null) unschedule(timer)
    timer = schedule(stop, Math.max(0, until - at))
  }

  hold(start)
  if (Observer) {
    observer = new Observer(() => {
      if (done) return
      const at = now()
      if (at >= cap) stop()
      else hold(at)
    })
    observer.observe(content)
  }
  for (const type of PANE_INTENT) pane.addEventListener(type, userTookOver, { passive: true })
  // Keys reach the focused element (the search box, a row's control), not the
  // pane: listen where every one of them passes.
  doc.addEventListener('keydown', userTookOver, true)
  return stop
}

/**
 * Bring a group's header under the pane's top edge. The FIRST group goes to the
 * very top instead: the page title above it is part of what a link to the
 * page's first section should show, and `scrollIntoView` would scroll past it
 * (it landed at scrollTop ≈ 63).
 */
export function scrollGroupToTop(
  pane: { scrollTop: number },
  group: { scrollIntoView?: (options?: ScrollIntoViewOptions) => void } | undefined,
  first: boolean
): void {
  if (first) pane.scrollTop = 0
  // jsdom implements neither scrollIntoView nor layout, so guard rather than
  // let a component test explode on a purely visual affordance.
  else group?.scrollIntoView?.({ block: 'start' })
}
