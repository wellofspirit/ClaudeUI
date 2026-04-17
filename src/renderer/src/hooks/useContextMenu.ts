import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSessionStore } from '../stores/session-store'

export type ContextMenuPosition = { x: number; y: number }

/**
 * Self-contained right-click context menu state.
 *
 * Features:
 * - Tracks open/closed + anchor point (zoom-adjusted).
 * - Closes on outside mousedown.
 * - After render, measures the menu and flips horizontally / vertically if
 *   it would overflow the viewport edges, so menus opened near the window
 *   edge don't get clipped.
 *
 * Usage:
 *   const menu = useContextMenu()
 *   <div onContextMenu={menu.open}>...</div>
 *   {menu.isOpen && (
 *     <div ref={menu.ref} style={menu.style}>...</div>
 *   )}
 */
export function useContextMenu(): {
  isOpen: boolean
  ref: React.RefObject<HTMLDivElement | null>
  style: React.CSSProperties
  open: (e: React.MouseEvent) => void
  close: () => void
} {
  const [anchor, setAnchor] = useState<ContextMenuPosition | null>(null)
  const [resolved, setResolved] = useState<ContextMenuPosition | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)

  const open = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const zoom = useSessionStore.getState().settings.uiFontScale
    setAnchor({ x: e.clientX / zoom, y: e.clientY / zoom })
    setResolved(null)
  }, [])

  const close = useCallback(() => {
    setAnchor(null)
    setResolved(null)
  }, [])

  // Outside-click dismissal
  useEffect(() => {
    if (!anchor) return
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [anchor, close])

  // After render, measure the menu; flip the side(s) that would overflow.
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const el = ref.current
    const rect = el.getBoundingClientRect()
    const zoom = useSessionStore.getState().settings.uiFontScale
    // viewport bounds in the same coordinate space as anchor (zoom-adjusted)
    const vw = window.innerWidth / zoom
    const vh = window.innerHeight / zoom
    const width = rect.width / zoom
    const height = rect.height / zoom
    const margin = 4

    let { x, y } = anchor
    // Flip horizontally if the menu would overflow the right edge. Prefer
    // placing the menu's right edge at the anchor (standard "open left").
    if (x + width + margin > vw) x = Math.max(margin, x - width)
    // Flip vertically if the menu would overflow the bottom edge.
    if (y + height + margin > vh) y = Math.max(margin, y - height)

    if (!resolved || resolved.x !== x || resolved.y !== y) {
      setResolved({ x, y })
    }
  }, [anchor, resolved])

  const pos = resolved ?? anchor
  const style: React.CSSProperties = pos
    ? {
        left: pos.x,
        top: pos.y,
        // Hide the first paint at the raw anchor until flipping resolves —
        // otherwise the user sees a one-frame flash of the clipped position.
        visibility: resolved ? 'visible' : 'hidden'
      }
    : {}

  return { isOpen: anchor !== null, ref, style, open, close }
}
