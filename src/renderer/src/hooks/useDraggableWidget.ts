/**
 * Makes a floating widget (TodoWidget / SentFilesWidget) draggable by its
 * header — ADR-043 §2.
 *
 * Design notes:
 *
 *  - **Opt-in, not always-on.** Until the user actually drags, the hook returns
 *    an empty style and the widget stays in ChatPanel's flex stack, so the
 *    default layout is exactly what it was. The first real drag promotes the
 *    widget to `position: fixed`, and a double-click on the header sends it
 *    back to the stack.
 *  - **Right-anchored.** The fixed position is `{ top, right }`, not
 *    `{ top, left }`, so the expand-on-click width animation keeps growing
 *    leftwards instead of shoving the widget off-screen.
 *  - **Click still toggles.** A pointer interaction only becomes a drag after
 *    {@link DRAG_THRESHOLD_PX} of movement; below that the header's normal
 *    `onClick` runs. Above it, the caller's `onClick` bails out via
 *    {@link DraggableWidget.didDrag} — a `stopPropagation` trick would be at
 *    the mercy of React's same-element dispatch order, whereas an explicit ref
 *    check is obvious and testable.
 *  - Pure DOM + localStorage, so it behaves identically in the remote web
 *    client.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

/** Movement (px) that separates "a click" from "a drag". */
export const DRAG_THRESHOLD_PX = 4
/** How much of the widget must stay inside the viewport after clamping. */
const MIN_VISIBLE_PX = 48
/** Above ChatPanel's `z-10` stack, below the lightbox (`z-50`). */
const DRAG_Z_INDEX = 30

export interface WidgetPosition {
  top: number
  right: number
}

export interface DraggableWidgetHeaderHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  onDoubleClick: () => void
  /** `touch-action: none` — without it, a touch drag scrolls the page instead. */
  style: CSSProperties
}

export interface DraggableWidget {
  /** True once the widget has been detached from the stack. */
  dragged: boolean
  /** Attach to the widget root — used to measure for viewport clamping. */
  ref: React.RefObject<HTMLDivElement | null>
  /** Spread onto the widget root's `style` (empty while undragged). */
  style: CSSProperties
  /** Spread onto the header element. */
  headerHandlers: DraggableWidgetHeaderHandlers
  /**
   * True when the click currently being handled ended a drag (so the caller
   * must NOT treat it as a header tap). Consumes the flag.
   */
  didDrag: () => boolean
  /** Return to the ChatPanel stack and forget the persisted position. */
  resetPosition: () => void
}

function readStoredPosition(key: string): WidgetPosition | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<WidgetPosition>
    if (typeof parsed?.top !== 'number' || typeof parsed?.right !== 'number') return null
    if (!Number.isFinite(parsed.top) || !Number.isFinite(parsed.right)) return null
    return { top: parsed.top, right: parsed.right }
  } catch {
    // Private mode / corrupt JSON — fall back to the stack.
    return null
  }
}

function writeStoredPosition(key: string, pos: WidgetPosition | null): void {
  try {
    if (pos) window.localStorage.setItem(key, JSON.stringify(pos))
    else window.localStorage.removeItem(key)
  } catch {
    /* storage unavailable — position is still live in memory */
  }
}

function clampToViewport(pos: WidgetPosition, el: HTMLElement | null): WidgetPosition {
  const vw = window.innerWidth || 0
  const vh = window.innerHeight || 0
  const rect = el?.getBoundingClientRect()
  // jsdom (and a not-yet-laid-out element) reports 0×0 — fall back to the
  // minimum so the clamp stays sane instead of pinning everything to 0.
  const width = rect?.width || MIN_VISIBLE_PX
  const height = rect?.height || MIN_VISIBLE_PX
  const keepX = Math.min(width, MIN_VISIBLE_PX)
  const keepY = Math.min(height, MIN_VISIBLE_PX)
  const maxTop = Math.max(0, vh - keepY)
  // `right` may go negative (widget hanging off the right edge) as long as
  // `keepX` pixels stay visible.
  const minRight = Math.min(0, keepX - width)
  const maxRight = Math.max(0, vw - keepX)
  return {
    top: Math.min(Math.max(pos.top, 0), maxTop),
    right: Math.min(Math.max(pos.right, minRight), maxRight)
  }
}

export function useDraggableWidget(storageKey: string): DraggableWidget {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<WidgetPosition | null>(() => readStoredPosition(storageKey))
  const posRef = useRef<WidgetPosition | null>(pos)
  const dragRef = useRef<{
    x: number
    y: number
    top: number
    right: number
    moved: boolean
  } | null>(null)
  const didDragRef = useRef(false)

  const applyPos = useCallback((next: WidgetPosition | null): void => {
    posRef.current = next
    setPos(next)
  }, [])

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    // Primary button only — a right-click must not start a drag.
    if (e.button !== 0) return
    didDragRef.current = false
    const rect = ref.current?.getBoundingClientRect()
    const base =
      posRef.current ??
      (rect
        ? { top: rect.top, right: Math.max(0, (window.innerWidth || 0) - rect.right) }
        : { top: 0, right: 0 })
    dragRef.current = { x: e.clientX, y: e.clientY, top: base.top, right: base.right, moved: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* jsdom / unsupported — move events still arrive while over the header */
    }
  }, [])

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current
      if (!drag) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (!drag.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return
      drag.moved = true
      didDragRef.current = true
      // Stop the browser turning the drag into a text selection.
      e.preventDefault()
      // Right-anchored: moving the pointer right DECREASES `right`.
      applyPos(clampToViewport({ top: drag.top + dy, right: drag.right - dx }, ref.current))
    },
    [applyPos]
  )

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current
      dragRef.current = null
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* never captured */
      }
      if (drag?.moved) writeStoredPosition(storageKey, posRef.current)
    },
    [storageKey]
  )

  const resetPosition = useCallback((): void => {
    dragRef.current = null
    didDragRef.current = false
    applyPos(null)
    writeStoredPosition(storageKey, null)
  }, [applyPos, storageKey])

  const didDrag = useCallback((): boolean => {
    const was = didDragRef.current
    didDragRef.current = false
    return was
  }, [])

  // Keep a detached widget reachable when the window shrinks.
  useEffect(() => {
    const onResize = (): void => {
      const current = posRef.current
      if (!current) return
      const next = clampToViewport(current, ref.current)
      if (next.top === current.top && next.right === current.right) return
      applyPos(next)
      writeStoredPosition(storageKey, next)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [applyPos, storageKey])

  return {
    dragged: pos !== null,
    ref,
    style: pos ? { position: 'fixed', top: pos.top, right: pos.right, zIndex: DRAG_Z_INDEX } : {},
    headerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick: resetPosition,
      style: { touchAction: 'none' }
    },
    didDrag,
    resetPosition
  }
}
