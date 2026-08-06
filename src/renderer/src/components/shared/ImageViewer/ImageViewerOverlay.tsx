/**
 * ImageViewerOverlay — the one full-screen image viewer in the app.
 *
 * Desktop and mobile share this component tree (ADR-048: no mobile fork for a
 * surface whose interaction model is identical); the gestures are Pointer Events
 * so mouse, pen and touch all drive the same code with no library.
 *
 * Interaction contract:
 *   - wheel / trackpad zoom, anchored on the cursor, clamped to [1, 8]
 *   - drag to pan once zoomed; one-finger horizontal swipe at fit scale pages
 *     the gallery instead
 *   - two-finger pinch zoom, anchored on the pinch midpoint
 *   - double-click / double-tap toggles fit ↔ 2.5x on the tapped point
 *   - ArrowLeft/ArrowRight page; Esc, ✕ and a tap on the backdrop close
 *     (dismissal is resolved from pointer events, never from `click` — see
 *     `sealFromAncestors` for the pointer-capture retargeting that forces this)
 *   - navigation stops at the ends (no wrap); changing image or tab resets zoom
 *
 * All the transform math lives in `./transform` as pure functions — see the
 * header there for the coordinate model and why it is separated.
 *
 * z-index: `z-[300]`. The app's layers are dialog roots at `z-50`, nested
 * dialogs / mobile sheets at `z-[100]`–`z-[200]`, and a stacked confirm at
 * `z-[110]`. A media viewer is always the topmost thing on screen, so it sits
 * clear above the whole stack.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DOUBLE_TAP_SCALE,
  FIT_TRANSFORM,
  MIN_SCALE,
  TAP_SLOP_PX,
  clampPan,
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
} from './transform'

export interface ViewerImage {
  /** Anything an `<img src>` accepts — a `data:` URI for attachments, an authenticated URL for sent files. */
  src: string
  fileName?: string
}

export interface ViewerTab {
  id: string
  label: string
  images: ViewerImage[]
}

export interface ImageViewerOverlayProps {
  /** One or more galleries. Empty ones are dropped; the tab bar shows only when 2+ survive. */
  tabs: ViewerTab[]
  initialTabId?: string
  initialIndex?: number
  onClose: () => void
}

/** Per-gesture scratch state. Lives in a ref — no pointer event ever re-renders. */
interface GestureState {
  startX: number
  startY: number
  lastX: number
  lastY: number
  /** Travelled past the tap slop, so this is a drag/swipe rather than a tap. */
  moved: boolean
  /** Two-finger span at the previous move, or null while single-pointer. */
  pinchSpan: number | null
  /** The gesture began on the image (pan/zoom/double-tap). */
  onImage: boolean
  /**
   * The gesture began on the viewport itself — the empty backdrop around the
   * image, as opposed to the image or a chevron. A tap there closes.
   */
  onBackdrop: boolean
}

export function ImageViewerOverlay({
  tabs,
  initialTabId,
  initialIndex = 0,
  onClose
}: ImageViewerOverlayProps): React.JSX.Element | null {
  const galleries = useMemo(() => tabs.filter((t) => t.images.length > 0), [tabs])

  const [activeTabId, setActiveTabId] = useState(
    () => galleries.find((t) => t.id === initialTabId)?.id ?? galleries[0]?.id ?? ''
  )
  const activeTab = galleries.find((t) => t.id === activeTabId) ?? galleries[0]
  const images = activeTab?.images ?? []

  const [rawIndex, setIndex] = useState(() =>
    Math.min(Math.max(0, initialIndex), Math.max(0, (images.length || 1) - 1))
  )
  const [transform, setTransform] = useState<ViewerTransform>(FIT_TRANSFORM)

  const viewportRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<GestureState | null>(null)
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null)

  // Read inside pointer handlers, which must never close over a stale scale.
  const transformRef = useRef(transform)
  useLayoutEffect(() => {
    transformRef.current = transform
  }, [transform])

  const total = images.length
  // Clamped at *render* time, not in an effect: the gallery can shrink under an
  // open viewer (switching session re-derives `tabs`), and an effect would only
  // fire after this render had already dereferenced a missing image.
  const index = Math.min(rawIndex, Math.max(0, total - 1))
  const current = images[index]

  // ── Geometry helpers (all ref reads — stable identities) ──────────────────

  const viewportSize = useCallback((): Size => {
    const el = viewportRef.current
    return el ? { width: el.clientWidth, height: el.clientHeight } : { width: 0, height: 0 }
  }, [])

  const fittedSize = useCallback((): Size => {
    const img = imageRef.current
    if (!img) return { width: 0, height: 0 }
    return fitSize({ width: img.naturalWidth, height: img.naturalHeight }, viewportSize())
  }, [viewportSize])

  /** Client coords → offset from the viewport centre, the anchor space `transform.ts` uses. */
  const anchorOf = useCallback((clientX: number, clientY: number): Point => {
    const el = viewportRef.current
    if (!el) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) }
  }, [])

  const applyZoom = useCallback(
    (anchor: Point, factor: number): void => {
      setTransform((t) => clampPan(zoomAt(t, anchor, factor), viewportSize(), fittedSize()))
    },
    [fittedSize, viewportSize]
  )

  // ── Navigation ───────────────────────────────────────────────────────────

  /** Stops at the ends — deliberately no wrap-around (spec), so `next` at the end is a no-op. */
  const step = useCallback(
    (delta: number): void => {
      setIndex((i) => {
        // Same clamp as the render path, so a shrunk gallery self-heals here too.
        const from = Math.min(i, Math.max(0, total - 1))
        const next = from + delta
        return next < 0 || next >= total ? from : next
      })
    },
    [total]
  )

  const selectTab = useCallback((id: string): void => {
    setActiveTabId(id)
    setIndex(0)
  }, [])

  // Changing image or tab always returns to a centred fit.
  useEffect(() => {
    setTransform(FIT_TRANSFORM)
    lastTap.current = null
  }, [activeTabId, index])

  // ── Keyboard ─────────────────────────────────────────────────────────────

  // Capture phase: the keys we own must not reach app-level handlers bound on
  // window (ChatPanel's Cmd/Ctrl+F, the sidebar shortcuts, …).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        step(e.key === 'ArrowRight' ? 1 : -1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, step])

  // ── Body scroll lock ─────────────────────────────────────────────────────

  // The overlay is portalled to <body>, so the page behind it is still
  // scrollable (and on mobile would rubber-band under the viewer) unless the
  // body is pinned for the lifetime of the overlay.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  // ── Wheel zoom ───────────────────────────────────────────────────────────

  // Native + non-passive: React's onWheel cannot preventDefault, and without it
  // the desktop trackpad zoom also scrolls whatever is behind the overlay.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      applyZoom(anchorOf(e.clientX, e.clientY), wheelZoomFactor(e.deltaY, e.deltaMode))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [anchorOf, applyZoom])

  // ── Pointer gestures ─────────────────────────────────────────────────────

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const onImage = imageRef.current?.contains(e.target as Node) ?? false
    // Capture only for a gesture that starts on the image: a pan must keep
    // tracking once the pointer leaves the viewport, whereas capturing a press
    // that began on a chevron would retarget its pointer events away from the
    // button. (Optional-called — jsdom's Element has no pointer-capture methods.)
    if (onImage) e.currentTarget.setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) {
      gesture.current = {
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
        pinchSpan: null,
        onImage,
        onBackdrop: e.target === e.currentTarget
      }
      return
    }
    const g = gesture.current
    if (g && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      g.pinchSpan = distance(a, b)
      // A pinch is never a tap, and never a swipe.
      g.moved = true
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) return

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const span = distance(a, b)
      if (g.pinchSpan !== null) {
        const mid = midpoint(a, b)
        applyZoom(anchorOf(mid.x, mid.y), pinchFactor(g.pinchSpan, span))
      }
      g.pinchSpan = span
      return
    }

    const dx = e.clientX - g.lastX
    const dy = e.clientY - g.lastY
    g.lastX = e.clientX
    g.lastY = e.clientY
    if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > TAP_SLOP_PX) g.moved = true

    // Zoomed in → one finger pans. At fit scale the drag is a candidate swipe,
    // resolved on pointerup.
    if (transformRef.current.scale > MIN_SCALE) {
      setTransform((t) => clampPan(panBy(t, dx, dy), viewportSize(), fittedSize()))
    }
  }

  // No explicit releasePointerCapture: the spec releases capture implicitly on
  // pointerup/pointercancel, and calling it for a pointer that was never
  // captured (a press that started on the backdrop) throws NotFoundError.
  const endPointer = (e: React.PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(e.pointerId)
    const g = gesture.current
    if (!g) return

    // A finger lifted out of a pinch: drop the span and re-anchor the survivor
    // so the remaining finger doesn't jump the pan by the whole gap.
    if (pointers.current.size > 0) {
      const remaining = [...pointers.current.values()][0]
      g.pinchSpan = null
      g.lastX = remaining.x
      g.lastY = remaining.y
      return
    }
    gesture.current = null

    if (g.moved) {
      // Swipe only makes sense at fit scale; while zoomed the drag was a pan.
      if (transformRef.current.scale <= MIN_SCALE) {
        // Swipe left (dx < 0) advances, swipe right goes back.
        const dir = swipeDirection(e.clientX - g.startX, e.clientY - g.startY)
        if (dir !== 0) step(-dir)
      }
      return
    }

    // A tap on the empty area around the image dismisses the viewer. Decided
    // here rather than from a `click` handler — see `sealFromAncestors` below
    // for why `click` is unusable for this.
    if (g.onBackdrop) {
      onClose()
      return
    }

    if (!g.onImage) return
    const tap = { time: Date.now(), x: e.clientX, y: e.clientY }
    if (isDoubleTap(lastTap.current, tap)) {
      lastTap.current = null
      const anchor = anchorOf(tap.x, tap.y)
      setTransform((t) =>
        clampPan(
          t.scale > MIN_SCALE
            ? FIT_TRANSFORM
            : zoomTo(t, anchor, DOUBLE_TAP_SCALE),
          viewportSize(),
          fittedSize()
        )
      )
      return
    }
    lastTap.current = tap
  }

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size === 0) gesture.current = null
  }

  if (!activeTab || total === 0) return null

  const showTabs = galleries.length >= 2
  const showNav = total > 1

  /**
   * The overlay is portalled to `<body>`, but React still bubbles *synthetic*
   * events up the component tree — so an ancestor of the provider would
   * otherwise see every viewer interaction. Sealing them at the root keeps chat
   * gestures and panel click-outs out of it.
   *
   * Bubble phase, not capture: a capture-phase stop would also keep the event
   * from reaching the viewport's own gesture handlers further down.
   *
   * Note that `click` is *only* sealed here, never acted on. Backdrop dismissal
   * used to be `click` with an `e.target === e.currentTarget` test, which is
   * unsound: once a pan sets pointer capture on the viewport, Chromium retargets
   * the following `click` to the capturing element, so a plain click on the
   * image arrived as `target === viewport` and closed the viewer. Dismissal now
   * lives in `endPointer`, which knows what the gesture actually started on and
   * whether it moved (so a swipe across the backdrop pages without also closing).
   */
  const sealFromAncestors = (e: React.SyntheticEvent): void => e.stopPropagation()

  return createPortal(
    <div
      data-testid="ImageViewerOverlay"
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-[300] flex flex-col bg-black/80 select-none animate-fade-in"
      onClick={sealFromAncestors}
      onPointerDown={sealFromAncestors}
      onPointerUp={sealFromAncestors}
      onKeyDown={sealFromAncestors}
    >
      {/* Top bar: tabs · filename · counter · close */}
      <div className="shrink-0 flex items-center gap-3 px-3 h-11 bg-black/40">
        {showTabs && (
          <div className="flex items-center gap-1">
            {galleries.map((tab) => (
              <button
                key={tab.id}
                type="button"
                data-testid="ImageViewerOverlay.tab"
                data-id={tab.id}
                data-active={tab.id === activeTab.id || undefined}
                onClick={() => selectTab(tab.id)}
                className={`px-2.5 py-1 rounded-md text-[12px] transition-colors cursor-default ${
                  tab.id === activeTab.id
                    ? 'bg-white/15 text-white'
                    : 'text-white/60 hover:text-white hover:bg-white/10'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
        <span
          data-testid="ImageViewerOverlay.filename"
          className="flex-1 min-w-0 text-[12px] text-white/70 truncate"
        >
          {current?.fileName ?? ''}
        </span>
        <span
          data-testid="ImageViewerOverlay.counter"
          className="text-[12px] text-white/70 font-mono whitespace-nowrap"
        >
          {index + 1} / {total}
        </span>
        <button
          type="button"
          data-testid="ImageViewerOverlay.close"
          onClick={onClose}
          aria-label="Close image viewer"
          title="Close (Esc)"
          className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors cursor-default"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Viewport — also the backdrop: tapping the empty area around the image
          closes, resolved in `endPointer` rather than by a click handler. */}
      <div
        ref={viewportRef}
        data-testid="ImageViewerOverlay.viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={onPointerCancel}
        className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden"
        style={{ touchAction: 'none' }}
      >
        <img
          ref={imageRef}
          data-testid="ImageViewerOverlay.image"
          data-id={String(index)}
          src={current.src}
          alt={current.fileName ?? 'Image'}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          className="max-w-full max-h-full object-contain"
          style={{
            transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`,
            cursor: transform.scale > MIN_SCALE ? 'grab' : 'zoom-in',
            willChange: 'transform'
          }}
        />

        {showNav && (
          <>
            <NavButton
              testid="ImageViewerOverlay.prev"
              label="Previous image"
              side="left"
              disabled={index === 0}
              onClick={() => step(-1)}
            />
            <NavButton
              testid="ImageViewerOverlay.next"
              label="Next image"
              side="right"
              disabled={index === total - 1}
              onClick={() => step(1)}
            />
          </>
        )}
      </div>
    </div>,
    document.body
  )
}

function NavButton({
  testid,
  label,
  side,
  disabled,
  onClick
}: {
  testid: string
  label: string
  side: 'left' | 'right'
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`absolute top-1/2 -translate-y-1/2 ${
        side === 'left' ? 'left-2' : 'right-2'
      } w-10 h-10 flex items-center justify-center rounded-full bg-black/40 text-white/80 hover:bg-black/60 hover:text-white transition-colors cursor-default disabled:opacity-25 disabled:hover:bg-black/40`}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {side === 'left' ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
      </svg>
    </button>
  )
}
