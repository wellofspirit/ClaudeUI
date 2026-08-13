/**
 * Layer 1: the pure gesture math behind ImageViewerOverlay.
 *
 * jsdom cannot synthesise a real wheel/pinch/drag, so this is the layer that
 * actually verifies the zoom anchoring and pan clamping. Anchors are offsets
 * from the viewport centre (see transform.ts).
 */

import { describe, it, expect } from 'vitest'
import {
  DOUBLE_TAP_SCALE,
  FIT_TRANSFORM,
  MAX_SCALE,
  MIN_SCALE,
  SWIPE_MIN_DISTANCE_PX,
  clampPan,
  clampScale,
  distance,
  fitSize,
  isDoubleTap,
  midpoint,
  panBy,
  pinchFactor,
  swipeDirection,
  wheelZoomFactor,
  zoomAt,
  zoomTo,
  type Point,
  type Size,
  type ViewerTransform
} from '../transform'

const VIEWPORT: Size = { width: 1000, height: 800 }
/** A landscape image fitted into VIEWPORT: 1000x500. */
const FITTED: Size = { width: 1000, height: 500 }

/** Where the image content originally under `anchor` renders after `t`. */
function screenOf(t: ViewerTransform, imageOffset: Point): Point {
  return { x: t.tx + t.scale * imageOffset.x, y: t.ty + t.scale * imageOffset.y }
}

/** The image-local point currently under `anchor`. */
function contentUnder(t: ViewerTransform, anchor: Point): Point {
  return { x: (anchor.x - t.tx) / t.scale, y: (anchor.y - t.ty) / t.scale }
}

describe('clampScale', () => {
  it('clamps to [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.1)).toBe(MIN_SCALE)
    expect(clampScale(3)).toBe(3)
    expect(clampScale(99)).toBe(MAX_SCALE)
  })

  it('falls back to fit on a non-finite scale', () => {
    expect(clampScale(Number.NaN)).toBe(MIN_SCALE)
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(MAX_SCALE)
  })
})

describe('zoomAt', () => {
  it('keeps the content under the anchor pinned there', () => {
    const anchor = { x: 120, y: -60 }
    const start: ViewerTransform = { scale: 1.4, tx: 30, ty: -12 }
    const before = contentUnder(start, anchor)

    const next = zoomAt(start, anchor, 2.3)

    expect(next.scale).toBeCloseTo(1.4 * 2.3, 10)
    const after = screenOf(next, before)
    expect(after.x).toBeCloseTo(anchor.x, 10)
    expect(after.y).toBeCloseTo(anchor.y, 10)
  })

  it('zooming about the centre never introduces a pan', () => {
    const next = zoomAt(FIT_TRANSFORM, { x: 0, y: 0 }, 4)
    expect(next).toEqual({ scale: 4, tx: 0, ty: 0 })
  })

  it('anchors correctly even when the requested factor is clamped away', () => {
    const anchor = { x: 200, y: 100 }
    // 1 * 50 would be 50x; the clamp caps it at MAX_SCALE, and the pan must be
    // computed from the scale that was actually applied — not the requested one.
    const next = zoomAt(FIT_TRANSFORM, anchor, 50)
    expect(next.scale).toBe(MAX_SCALE)
    const after = screenOf(next, contentUnder(FIT_TRANSFORM, anchor))
    expect(after.x).toBeCloseTo(anchor.x, 10)
    expect(after.y).toBeCloseTo(anchor.y, 10)
  })

  it('cannot zoom out below fit', () => {
    expect(zoomAt(FIT_TRANSFORM, { x: 50, y: 50 }, 0.2)).toEqual({
      scale: MIN_SCALE,
      tx: 0,
      ty: 0
    })
  })

  it('treats a non-finite factor as no change', () => {
    const start: ViewerTransform = { scale: 2, tx: 10, ty: 20 }
    expect(zoomAt(start, { x: 5, y: 5 }, Number.NaN)).toEqual(start)
  })
})

describe('zoomTo', () => {
  it('reaches the absolute target scale while pinning the anchor', () => {
    const anchor = { x: -80, y: 40 }
    const next = zoomTo(FIT_TRANSFORM, anchor, DOUBLE_TAP_SCALE)
    expect(next.scale).toBe(DOUBLE_TAP_SCALE)
    const after = screenOf(next, contentUnder(FIT_TRANSFORM, anchor))
    expect(after.x).toBeCloseTo(anchor.x, 10)
    expect(after.y).toBeCloseTo(anchor.y, 10)
  })
})

describe('clampPan', () => {
  it('forces a fit-scale image back to centre (no fling-off)', () => {
    const panned = panBy({ ...FIT_TRANSFORM }, 400, -300)
    expect(clampPan(panned, VIEWPORT, FITTED)).toEqual({ scale: 1, tx: 0, ty: 0 })
  })

  it('allows exactly the overhang on the axis that overflows', () => {
    // scale 2 → 2000x1000. Overhang x = (2000-1000)/2 = 500, y = (1000-800)/2 = 100.
    const state: ViewerTransform = { scale: 2, tx: 9999, ty: -9999 }
    expect(clampPan(state, VIEWPORT, FITTED)).toEqual({ scale: 2, tx: 500, ty: -100 })
  })

  it('keeps an axis centred while it still fits inside the viewport', () => {
    // scale 1.2 → 1200x600: x overflows by 100 each side, y (600 < 800) does not.
    const state: ViewerTransform = { scale: 1.2, tx: 80, ty: 300 }
    expect(clampPan(state, VIEWPORT, FITTED)).toEqual({ scale: 1.2, tx: 80, ty: 0 })
  })

  it('leaves an in-bounds pan untouched', () => {
    const state: ViewerTransform = { scale: 2, tx: -120, ty: 40 }
    expect(clampPan(state, VIEWPORT, FITTED)).toEqual(state)
  })

  it('passes through unchanged while the layout is unknown', () => {
    // naturalWidth is 0 until the image loads (and always in jsdom) — a pan
    // must not be silently snapped to centre in that window.
    const state: ViewerTransform = { scale: 3, tx: 70, ty: -20 }
    expect(clampPan(state, VIEWPORT, { width: 0, height: 0 })).toEqual(state)
    expect(clampPan(state, { width: 0, height: 0 }, FITTED)).toEqual(state)
  })
})

describe('panBy', () => {
  it('adds the delta and preserves the scale', () => {
    expect(panBy({ scale: 2.5, tx: 10, ty: -5 }, -30, 15)).toEqual({
      scale: 2.5,
      tx: -20,
      ty: 10
    })
  })
})

describe('fitSize', () => {
  it('contains a wide image by width', () => {
    expect(fitSize({ width: 2000, height: 1000 }, VIEWPORT)).toEqual({
      width: 1000,
      height: 500
    })
  })

  it('contains a tall image by height', () => {
    expect(fitSize({ width: 800, height: 1600 }, VIEWPORT)).toEqual({ width: 400, height: 800 })
  })

  it('never upscales a small image (mirrors max-width/max-height: 100%)', () => {
    expect(fitSize({ width: 120, height: 60 }, VIEWPORT)).toEqual({ width: 120, height: 60 })
  })

  it('returns a zero size when either dimension is unknown', () => {
    expect(fitSize({ width: 0, height: 0 }, VIEWPORT)).toEqual({ width: 0, height: 0 })
    expect(fitSize({ width: 100, height: 100 }, { width: 0, height: 800 })).toEqual({
      width: 0,
      height: 0
    })
  })

  describe('allowUpscale (vector content)', () => {
    it('grows small content to fill the viewport on the tighter axis', () => {
      // 125x50 is 5:2, the viewport 5:4 — so width is the binding constraint.
      expect(fitSize({ width: 125, height: 50 }, VIEWPORT, true)).toEqual({
        width: 1000,
        height: 400
      })
      // Portrait content binds on height instead.
      expect(fitSize({ width: 100, height: 200 }, VIEWPORT, true)).toEqual({
        width: 400,
        height: 800
      })
    })

    it('downscales oversized content exactly as the default does', () => {
      expect(fitSize({ width: 2000, height: 1000 }, VIEWPORT, true)).toEqual(
        fitSize({ width: 2000, height: 1000 }, VIEWPORT)
      )
    })

    it('still returns a zero size when either dimension is unknown', () => {
      expect(fitSize({ width: 0, height: 60 }, VIEWPORT, true)).toEqual({ width: 0, height: 0 })
      expect(fitSize({ width: 120, height: 60 }, { width: 1000, height: 0 }, true)).toEqual({
        width: 0,
        height: 0
      })
    })

    it('is opt-in — the default is unchanged', () => {
      expect(fitSize({ width: 120, height: 60 }, VIEWPORT, false)).toEqual({
        width: 120,
        height: 60
      })
    })
  })
})

describe('pinchFactor', () => {
  it('is the ratio of the two-finger spans', () => {
    expect(pinchFactor(100, 250)).toBe(2.5)
    expect(pinchFactor(200, 100)).toBe(0.5)
  })

  it('is a no-op for a degenerate span', () => {
    expect(pinchFactor(0, 120)).toBe(1)
    expect(pinchFactor(120, 0)).toBe(1)
  })

  it('composes with zoomAt to scale about the pinch midpoint', () => {
    const a = { x: 100, y: 0 }
    const b = { x: 300, y: 0 }
    const mid = midpoint(a, b)
    expect(mid).toEqual({ x: 200, y: 0 })
    expect(distance(a, b)).toBe(200)
    const next = zoomAt(FIT_TRANSFORM, mid, pinchFactor(200, 400))
    expect(next.scale).toBe(2)
    expect(next.tx).toBe(-200)
  })
})

describe('wheelZoomFactor', () => {
  it('zooms in on scroll up and out on scroll down', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100)).toBeLessThan(1)
  })

  it('is symmetric — one notch each way returns to the start', () => {
    expect(wheelZoomFactor(-100) * wheelZoomFactor(100)).toBeCloseTo(1, 10)
  })

  it('is a no-op for a zero delta', () => {
    expect(wheelZoomFactor(0)).toBe(1)
    expect(wheelZoomFactor(Number.NaN)).toBe(1)
  })

  it('scales line-mode deltas up to px', () => {
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0), 10)
  })

  it('bounds a single huge delta so one event cannot leap the whole range', () => {
    const oneEvent = wheelZoomFactor(-100000)
    expect(clampScale(MIN_SCALE * oneEvent)).toBeLessThan(MAX_SCALE)
  })
})

describe('swipeDirection', () => {
  it('advances on a leftward swipe and goes back on a rightward one', () => {
    expect(swipeDirection(-120, 5)).toBe(-1)
    expect(swipeDirection(120, 5)).toBe(1)
  })

  it('ignores a drag shorter than the threshold', () => {
    expect(swipeDirection(SWIPE_MIN_DISTANCE_PX - 1, 0)).toBe(0)
  })

  it('ignores a mostly-vertical drag', () => {
    expect(swipeDirection(60, 200)).toBe(0)
  })
})

describe('isDoubleTap', () => {
  it('needs a previous tap', () => {
    expect(isDoubleTap(null, { time: 1000, x: 10, y: 10 })).toBe(false)
  })

  it('accepts two nearby taps in quick succession', () => {
    expect(isDoubleTap({ time: 1000, x: 10, y: 10 }, { time: 1200, x: 18, y: 14 })).toBe(true)
  })

  it('rejects taps that are too far apart in time', () => {
    expect(isDoubleTap({ time: 1000, x: 10, y: 10 }, { time: 1600, x: 10, y: 10 })).toBe(false)
  })

  it('rejects taps that are too far apart on screen', () => {
    expect(isDoubleTap({ time: 1000, x: 10, y: 10 }, { time: 1100, x: 300, y: 10 })).toBe(false)
  })
})
