/**
 * Pure transform math for `ImageViewerOverlay`.
 *
 * ## The model
 *
 * The content is laid out **fit-to-viewport and centred** — a raster `<img>` via
 * `max-width:100%; max-height:100%` (so it is never upscaled past its natural
 * size), an inline-SVG wrapper via an explicit `fitSize` box — and the
 * interactive transform is then applied as
 * `translate(tx px, ty px) scale(scale)` with `transform-origin: center center`.
 *
 * In that model a point `d` — an offset from the content's own centre, measured
 * in *fitted* CSS px — renders at viewport offset `t + scale * d` from the viewport
 * centre. Every function below is stated in those terms:
 *
 * - **anchor points are offsets from the viewport centre**, not client coords.
 *   The component converts once (`clientX - (rect.left + rect.width / 2)`), so
 *   this module never needs to know where the viewport sits on screen.
 * - `scale === MIN_SCALE` (1) is "fit", and at fit the pan is always 0 because
 *   `clampPan` collapses it.
 *
 * jsdom cannot synthesise real wheel/pinch/drag gestures, so this file is where
 * the gesture *behaviour* is actually tested; the component only wires DOM
 * events to these functions.
 */

export interface ViewerTransform {
  /** 1 = fit-to-viewport. */
  scale: number
  /** Horizontal translate in viewport px, applied before `scale`. */
  tx: number
  /** Vertical translate in viewport px, applied before `scale`. */
  ty: number
}

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** Fit. Zooming out never goes below the fitted size. */
export const MIN_SCALE = 1
export const MAX_SCALE = 8
/** Scale a double-click / double-tap toggles up to. */
export const DOUBLE_TAP_SCALE = 2.5

export const FIT_TRANSFORM: ViewerTransform = { scale: MIN_SCALE, tx: 0, ty: 0 }

/** Movement (px) between pointerdown and pointerup that still counts as a tap. */
export const TAP_SLOP_PX = 8
/** Max gap (ms) between the two taps of a double-tap. */
export const DOUBLE_TAP_MAX_GAP_MS = 300
/** Max distance (px) between the two taps of a double-tap. */
export const DOUBLE_TAP_MAX_DIST_PX = 30
/** Minimum horizontal travel (px) for a swipe to change image. */
export const SWIPE_MIN_DISTANCE_PX = 48
/** A swipe must be this many times more horizontal than vertical. */
const SWIPE_AXIS_RATIO = 1.5
/** Wheel zoom rate, per normalised px of `deltaY`. */
const WHEEL_ZOOM_SENSITIVITY = 0.0025
/** `deltaMode: 1` reports lines; treat one line as this many px. */
const WHEEL_LINE_HEIGHT_PX = 16
/** One wheel notch is often ~100px; clamp so a coarse device can't leap 8x. */
const WHEEL_MAX_DELTA_PX = 120

function clamp(value: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, value))
  // Normalise -0 (which `Math.max(-0, -300)` happily produces) so callers can
  // compare transforms with plain equality.
  return clamped === 0 ? 0 : clamped
}

export function clampScale(scale: number): number {
  // NaN has no ordering, so a clamp would pass it straight through — fall back
  // to fit. ±Infinity does order, and clamps to the nearer limit.
  if (Number.isNaN(scale)) return MIN_SCALE
  return clamp(scale, MIN_SCALE, MAX_SCALE)
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * Scale by `factor` while keeping the image content under `anchor` pinned there.
 *
 * Solves `anchor = t' + s' * d` for `t'`, where `d = (anchor - t) / s` is the
 * image-local point currently under the anchor. Substituting gives
 * `t' = anchor * (1 - k) + k * t` with `k = s' / s` — and because `s'` is the
 * *clamped* scale, hitting a zoom limit correctly stops the pan from drifting.
 *
 * @param anchor offset from the viewport centre (cursor / pinch midpoint).
 */
export function zoomAt(state: ViewerTransform, anchor: Point, factor: number): ViewerTransform {
  const scale = clampScale(state.scale * (Number.isNaN(factor) ? 1 : factor))
  const k = scale / state.scale
  return {
    scale,
    tx: anchor.x * (1 - k) + k * state.tx,
    ty: anchor.y * (1 - k) + k * state.ty
  }
}

/** `zoomAt` expressed as an absolute target scale — used by the double-tap toggle. */
export function zoomTo(state: ViewerTransform, anchor: Point, target: number): ViewerTransform {
  return zoomAt(state, anchor, clampScale(target) / state.scale)
}

export function panBy(state: ViewerTransform, dx: number, dy: number): ViewerTransform {
  return { scale: state.scale, tx: state.tx + dx, ty: state.ty + dy }
}

/**
 * Keep the image from being flung off-screen.
 *
 * Along each axis: if the scaled image is larger than the viewport it must still
 * cover it (`|t| <= (scaled - viewport) / 2`); if it is smaller it stays centred
 * (`t = 0`). At fit scale that collapses to `{0, 0}`, which is what makes
 * "zoom out returns to a centred fit" fall out for free.
 *
 * `fitted` is the image's fitted (un-transformed) CSS size. When it is unknown —
 * the image has not loaded, or jsdom reports `naturalWidth: 0` — the state is
 * returned untouched rather than snapped to centre, so a pan is never silently
 * swallowed before layout is known.
 */
export function clampPan(
  state: ViewerTransform,
  viewport: Size,
  fitted: Size
): ViewerTransform {
  if (fitted.width <= 0 || fitted.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return state
  }
  const maxX = Math.max(0, (fitted.width * state.scale - viewport.width) / 2)
  const maxY = Math.max(0, (fitted.height * state.scale - viewport.height) / 2)
  return {
    scale: state.scale,
    tx: clamp(state.tx, -maxX, maxX),
    ty: clamp(state.ty, -maxY, maxY)
  }
}

/**
 * The size the content renders at before any transform — `object-fit: contain`
 * semantics.
 *
 * By default it never upscales, mirroring the `max-width/max-height: 100%` a
 * raster `<img>` is laid out with: blowing a 120x60 thumbnail up to fill a 4K
 * viewport just magnifies its pixels, so "fit" for a raster image means "at most
 * natural size". `allowUpscale` drops that cap for content that has no pixel
 * grid to lose — an inline SVG re-rasterizes at whatever size it is given, so a
 * small diagram *should* grow to fill the viewport rather than sit tiny in the
 * middle of it.
 *
 * Returns a zero size when either input is unknown, which `clampPan` reads as
 * "layout not known yet".
 */
export function fitSize(natural: Size, viewport: Size, allowUpscale = false): Size {
  if (
    natural.width <= 0 ||
    natural.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return { width: 0, height: 0 }
  }
  const contain = Math.min(viewport.width / natural.width, viewport.height / natural.height)
  const ratio = allowUpscale ? contain : Math.min(1, contain)
  return { width: natural.width * ratio, height: natural.height * ratio }
}

/**
 * Pinch scale factor from the two-finger span before and after a move.
 * Degenerate spans (a finger landing exactly on the other) yield 1.
 */
export function pinchFactor(previousSpan: number, nextSpan: number): number {
  if (!(previousSpan > 0) || !(nextSpan > 0)) return 1
  return nextSpan / previousSpan
}

/**
 * Wheel/trackpad zoom factor. Scroll up (`deltaY < 0`) zooms in, matching every
 * image viewer and map on the platform. Exponential so successive notches
 * compose evenly instead of accelerating near the limits.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1
  const px = deltaMode === 1 ? deltaY * WHEEL_LINE_HEIGHT_PX : deltaY
  const bounded = clamp(px, -WHEEL_MAX_DELTA_PX, WHEEL_MAX_DELTA_PX)
  return Math.exp(-bounded * WHEEL_ZOOM_SENSITIVITY)
}

/**
 * Classify a one-finger drag at fit scale as a gallery swipe.
 *
 * @returns `-1` to advance (swipe left), `1` to go back (swipe right), `0` for
 *   "not a swipe" — too short, or too vertical to be anything but a mis-drag.
 */
export function swipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE_PX) return 0
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return 0
  return dx < 0 ? -1 : 1
}

/** True when two taps are close enough in time and space to be one double-tap. */
export function isDoubleTap(
  previous: { time: number; x: number; y: number } | null,
  next: { time: number; x: number; y: number }
): boolean {
  if (!previous) return false
  if (next.time - previous.time > DOUBLE_TAP_MAX_GAP_MS) return false
  return distance(previous, next) <= DOUBLE_TAP_MAX_DIST_PX
}
