/**
 * Touch scrolling for xterm 6, by SYNTHESIZING wheel events (ADR-060).
 *
 * xterm 6.0 replaced the native-overflow viewport with VS Code's synthetic
 * `ScrollableElement`, which listens for `wheel` and nothing else — the vendored
 * VS Code `Gesture` touch module is dead code (its `addTarget` has no call
 * sites). So on a phone the scrollback is unreachable: wheel scrolls it, a
 * finger moves nothing.
 *
 * Rather than reimplement scrolling, this turns a vertical drag into wheel
 * events and lets xterm's OWN machinery run: scrollback in the normal buffer,
 * the alternate-buffer wheel→arrow-key conversion (so `less`, `vim`, a pager
 * scroll), DECCKM application-cursor encoding, and app mouse reporting — all
 * with byte-exact desktop semantics and no second implementation to keep in
 * step. The arrow keys that conversion produces go through `coreService
 * .triggerDataEvent(…, true)`, i.e. `Terminal.onData`, i.e. the SAME read-only
 * gate the accessory key row uses (ADR-054), so a watching-state refusal and its
 * step-up prompt apply here for free.
 *
 * ## Why the event is shaped the way it is
 *
 * Verified against Chromium (the probes are in ADR-060). xterm reads the wheel
 * TWICE, through two different properties:
 *
 *   - the normal-buffer path (VS Code's `StandardWheelEvent`) prefers the LEGACY
 *     `wheelDeltaY` whenever it is defined, and only falls back to `deltaY`;
 *   - the alternate-buffer path (xterm's own handler) reads `deltaY`.
 *
 * A `new WheelEvent('wheel', { deltaY })` in Chromium gets `wheelDeltaY ===
 * deltaY` — the OPPOSITE sign convention from a real wheel event, where
 * `wheelDeltaY === -deltaY * 1.2`. The two paths therefore disagree: the same
 * synthetic event scrolls the scrollback one way and the alt-buffer pager the
 * other. Defining `wheelDeltaY` explicitly (Chromium honours it, and it is the
 * one mechanism that also works where the init member is ignored) makes the
 * event a faithful copy of a real wheel, so both paths agree and the direction
 * is the desktop's.
 */

/**
 * How far a finger must travel before the gesture is claimed as a vertical
 * scroll. Below it, nothing is preventDefaulted and the touch stays a tap — the
 * tap is what focuses the terminal and raises the soft keyboard.
 */
const CLAIM_SLOP_PX = 8

/**
 * The real-wheel relationship between `deltaY` and the legacy `wheelDeltaY`
 * (Chromium: one notch is `deltaY: 100`, `wheelDeltaY: -120`).
 */
const LEGACY_WHEEL_DELTA_RATIO = -1.2

/**
 * Wheel delta per CSS pixel of finger travel, chosen so the content tracks the
 * finger 1:1.
 *
 * VS Code's `ScrollableElement` scrolls `SCROLL_WHEEL_SENSITIVITY (50) / 120`
 * pixels per unit of `wheelDeltaY`, and our `wheelDeltaY` is `1.2 ×` the
 * `deltaY` we ask for — so one pixel of `deltaY` moves the viewport
 * `50/120 × 1.2 = 0.5` pixels, and 2 is the reciprocal. Getting this wrong
 * costs scroll GAIN, never correctness.
 */
const WHEEL_DELTA_PER_TOUCH_PX = 2

/** Which axis (if either) the current gesture has been claimed for. */
type Axis = 'undecided' | 'vertical' | 'horizontal'

/**
 * Make one-finger vertical drags over `host` scroll the xterm inside it.
 *
 * Horizontal drags are deliberately left alone: the mobile surface wraps the
 * terminal in an `overflow-x: auto`, `touch-action: pan-x` container, so the
 * BROWSER owns horizontal panning of the mirrored grid and this owns vertical.
 * The axis lock below is what keeps the two from fighting over one gesture.
 *
 * Returns the detach function.
 */
export function attachTouchScroll(host: HTMLElement): () => void {
  let axis: Axis = 'undecided'
  let startX = 0
  let startY = 0
  let lastY = 0
  /**
   * Sub-pixel finger travel not yet spent. Without it a slow drag emits a
   * stream of events whose delta rounds to nothing, and VS Code's handler
   * ROUNDS AWAY FROM ZERO, so those would each still move the viewport a pixel.
   */
  let residualPx = 0

  const reset = (): void => {
    axis = 'undecided'
    residualPx = 0
  }

  /**
   * Where to aim the event.
   *
   * It must be a DESCENDANT of the scrollable element (a listener on an ancestor
   * never sees an event dispatched at that ancestor), and it must bubble up
   * through both handlers — `.xterm-scrollable-element` for the scrollback and
   * `.xterm` for the alt-buffer conversion. `elementFromPoint` gives the most
   * faithful target (app mouse reporting derives the cell from the
   * coordinates); a host without layout (jsdom) or without the method at all,
   * and an off-screen touch, all fall through to the screen element — which is
   * on the same bubble path, so only the reported cell is approximated.
   */
  const targetAt = (clientX: number, clientY: number): HTMLElement => {
    const hit =
      typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(clientX, clientY)
        : null
    if (hit instanceof HTMLElement && host.contains(hit)) return hit
    return host.querySelector<HTMLElement>('.xterm-screen') ?? host
  }

  const dispatchWheel = (deltaY: number, clientX: number, clientY: number): void => {
    const target = targetAt(clientX, clientY)
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY,
      deltaMode: 0, // WheelEvent.DOM_DELTA_PIXEL — the alt-buffer path branches on this
      // App mouse reporting derives the reported cell from these.
      clientX,
      clientY
      // No `view`: the only consumer is a `devicePixelRatio` correction VS Code
      // applies to Chrome ≤ 122 alone, and the member is strict enough that
      // passing it fails outright in a jsdom test realm.
    })
    // See the header: this is what makes the two read paths agree.
    Object.defineProperty(event, 'wheelDeltaY', {
      value: deltaY * LEGACY_WHEEL_DELTA_RATIO,
      configurable: true
    })
    target.dispatchEvent(event)
  }

  const onTouchStart = (e: TouchEvent): void => {
    reset()
    // Two fingers are a pinch/zoom the browser should keep.
    if (e.touches.length !== 1) {
      axis = 'horizontal'
      return
    }
    const touch = e.touches[0]
    startX = touch.clientX
    startY = touch.clientY
    lastY = touch.clientY
    // NOT preventDefaulted: the compatibility mouse events a plain tap
    // synthesizes are what focus xterm's hidden textarea and open the keyboard.
  }

  const onTouchMove = (e: TouchEvent): void => {
    if (axis === 'horizontal') return
    if (e.touches.length !== 1) {
      axis = 'horizontal'
      return
    }
    const touch = e.touches[0]
    if (axis === 'undecided') {
      const dx = Math.abs(touch.clientX - startX)
      const dy = Math.abs(touch.clientY - startY)
      if (dy >= CLAIM_SLOP_PX && dy > dx) {
        axis = 'vertical'
        // Measure from where the gesture was CLAIMED, not from touchstart: the
        // slop is the price of deciding, not scroll the user asked for.
        lastY = touch.clientY
      } else if (dx >= CLAIM_SLOP_PX) {
        axis = 'horizontal'
        return
      } else {
        return
      }
    }
    // Claimed: stop the page rubber-banding and the synthetic mousemove that
    // would otherwise start an xterm text selection under the dragging finger.
    if (e.cancelable) e.preventDefault()

    residualPx += touch.clientY - lastY
    lastY = touch.clientY
    if (Math.abs(residualPx) < 1) return
    const travel = residualPx
    residualPx = 0
    // Negated: dragging DOWN pulls earlier content into view, which is a wheel
    // scrolling UP (negative deltaY).
    dispatchWheel(-travel * WHEEL_DELTA_PER_TOUCH_PX, touch.clientX, touch.clientY)
  }

  host.addEventListener('touchstart', onTouchStart, { passive: true })
  // Not passive: a claimed gesture MUST be preventDefaultable.
  host.addEventListener('touchmove', onTouchMove, { passive: false })
  host.addEventListener('touchend', reset, { passive: true })
  host.addEventListener('touchcancel', reset, { passive: true })

  return () => {
    host.removeEventListener('touchstart', onTouchStart)
    host.removeEventListener('touchmove', onTouchMove)
    host.removeEventListener('touchend', reset)
    host.removeEventListener('touchcancel', reset)
  }
}
