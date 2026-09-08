/**
 * Layer 1: the anchored-menu positioner.
 *
 * Three things here are load-bearing and none of them are observable from a
 * component test — jsdom has no layout, so only stubbed geometry can exercise
 * them:
 *
 *   1. THE ZOOM DIVISION. `SessionView` renders the app under CSS
 *      `zoom: uiFontScale`, where a fixed element's offsets resolve in ZOOMED
 *      px while `getBoundingClientRect()` reports page px. Every measurement is
 *      divided by the effective scale, which the hook derives from the anchor
 *      (`rect.width / offsetWidth`) instead of reading the settings store. A
 *      missing division puts the menu 15% of the window below its trigger.
 *   2. THE FLIP. `placement` is honoured unless that side cannot fit the menu
 *      and the other side is roomier.
 *   3. SCROLL CLOSES IT. A fixed menu is measured once and cannot follow its
 *      anchor, so a scroll anywhere outside must close it — while scrolling the
 *      menu's own option list must not. The listeners must also be gone the
 *      moment the menu closes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { useRef } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { useAnchoredMenu, type AnchoredMenu } from '../use-anchored-menu'

/** The menus' `max-h-72` (288px) + the 4px gap — the room a side needs to fit. */
const MENU_ROOM = 292

interface Box {
  top: number
  left: number
  width: number
  height: number
}

/**
 * Give a real DOM node a fake box. `box` is in the element's OWN CSS px; the
 * rect is reported multiplied by `scale` (page px, which is what Chromium
 * reports inside a `zoom`ed subtree) while `offsetWidth` stays in CSS px — so
 * `rect.width / offsetWidth` is exactly the effective zoom.
 */
function stubLayout(el: HTMLElement, box: Box, scale: number): void {
  const rect = {
    top: box.top * scale,
    left: box.left * scale,
    width: box.width * scale,
    height: box.height * scale
  }
  el.getBoundingClientRect = () =>
    ({
      x: rect.left,
      y: rect.top,
      top: rect.top,
      left: rect.left,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({})
    }) as DOMRect
  Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => box.width })
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}

/** The hook's latest return, captured out of the harness's render. */
let latest: AnchoredMenu | null = null

interface HarnessProps {
  open: boolean
  placement: 'up' | 'down'
  onClose: () => void
  /** The anchor's box in its own CSS px. */
  anchor: Box
  /** The effective CSS `zoom` of the subtree (1 = none). */
  scale: number
  /** The menu's own box, for the off-screen-right second pass. */
  menu?: Box
}

/**
 * The anchor and the menu are real nodes — `menuRef.contains(target)` and the
 * hook's imperative pre-measure pass must work exactly as they do in the app;
 * only the geometry is stubbed.
 */
function Harness(props: HarnessProps): React.JSX.Element {
  const { open, placement, onClose, anchor, scale, menu } = props
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  latest = useAnchoredMenu({ open, anchorRef, menuRef, placement, onClose })
  return (
    <div>
      <button
        data-testid="anchor"
        ref={(el) => {
          anchorRef.current = el
          if (el) stubLayout(el, anchor, scale)
        }}
      />
      {open && (
        <div
          data-testid="menu"
          style={latest?.style}
          ref={(el) => {
            menuRef.current = el
            if (el && menu) stubLayout(el, menu, scale)
          }}
        >
          <span data-testid="inside" />
        </div>
      )}
      <div data-testid="outside" />
    </div>
  )
}

/** 150x28 at (200, 100) — a settings row's `SelectField`, roughly. */
const ANCHOR: Box = { top: 100, left: 200, width: 150, height: 28 }

function renderHook(props: Partial<HarnessProps> = {}): {
  onClose: ReturnType<typeof vi.fn>
  close: () => void
} {
  const onClose = vi.fn()
  const all: HarnessProps = {
    open: true,
    placement: 'down',
    anchor: ANCHOR,
    scale: 1,
    onClose,
    ...props
  }
  const { rerender } = render(<Harness {...all} />)
  return { onClose, close: () => rerender(<Harness {...all} open={false} />) }
}

function scrollOn(testid: string): void {
  // Scroll does not bubble — the hook listens in the CAPTURE phase, which sees
  // the event on its way down to the target.
  document.querySelector(`[data-testid="${testid}"]`)!.dispatchEvent(new Event('scroll'))
}

afterEach(() => {
  cleanup()
  latest = null
  setViewport(1024, 768)
})

describe('useAnchoredMenu', () => {
  it('is null while closed and registers no scroll listener', () => {
    const add = vi.spyOn(document, 'addEventListener')
    renderHook({ open: false })
    expect(latest).toBeNull()
    expect(add.mock.calls.filter(([type]) => type === 'scroll')).toHaveLength(0)
    add.mockRestore()
  })

  it('places the menu under the trigger, no narrower than it', () => {
    renderHook()
    expect(latest).not.toBeNull()
    expect(latest!.side).toBe('down')
    expect(latest!.style.position).toBe('fixed')
    expect(latest!.style.top).toBe(ANCHOR.top + ANCHOR.height + 4)
    expect(latest!.style.left).toBe(ANCHOR.left)
    expect(latest!.style.minWidth).toBe(ANCHOR.width)
    expect(latest!.style.bottom).toBeUndefined()
  })

  it('divides every measurement by the effective zoom (the owner runs 115%)', () => {
    renderHook({ scale: 1.15 })
    // The rect came back 15% larger; dividing it out lands the menu back on the
    // anchor's OWN coordinates, which is the space a fixed offset resolves in.
    expect(latest!.style.top).toBeCloseTo(ANCHOR.top + ANCHOR.height + 4, 5)
    expect(latest!.style.left).toBeCloseTo(ANCHOR.left, 5)
    expect(latest!.style.minWidth).toBeCloseTo(ANCHOR.width, 5)
    expect(latest!.side).toBe('down')
  })

  it('flips to the roomier side when the preferred one cannot fit the menu', () => {
    // 40px below the trigger, 700 above → 'down' is hopeless.
    renderHook({ anchor: { ...ANCHOR, top: 700 } })
    expect(latest!.side).toBe('up')
    // Pinned to the viewport bottom: the gap above the trigger's top edge.
    expect(latest!.style.bottom).toBe(768 - 700 + 4)
    expect(latest!.style.top).toBeUndefined()
  })

  it('flips under zoom using the ZOOMED viewport, not the raw one', () => {
    // 600 CSS px down in a 768px window is off the bottom third at 115%:
    // vh becomes 668, so only 40px remain below the trigger.
    renderHook({ scale: 1.15, anchor: { ...ANCHOR, top: 600 } })
    expect(latest!.side).toBe('up')
    expect(latest!.style.bottom).toBeCloseTo(768 / 1.15 - 600 + 4, 5)
  })

  it('keeps the preferred side when it fits, even if the other is roomier', () => {
    const top = 768 - MENU_ROOM - ANCHOR.height - 20
    expect(768 - (top + ANCHOR.height)).toBeGreaterThan(MENU_ROOM) // room below fits
    expect(top).toBeGreaterThan(768 - (top + ANCHOR.height)) // …and above is roomier
    renderHook({ anchor: { ...ANCHOR, top } })
    expect(latest!.side).toBe('down')
  })

  it('stays on the preferred side when neither side has room', () => {
    setViewport(1024, 200)
    renderHook({ placement: 'down', anchor: { ...ANCHOR, top: 4 } })
    // 168px below, 4px above: both too small, so the flip must not fire — a
    // flip to a WORSE side would be strictly harmful.
    expect(latest!.side).toBe('down')
  })

  it('shifts a right-overflowing menu back on screen', () => {
    // A 400px-wide menu (`w-max`) off a trigger at x=800 would end at 1200; the
    // viewport allows 1016 (1024 - 8), so it comes back 184px.
    renderHook({
      anchor: { ...ANCHOR, left: 800 },
      menu: { top: 132, left: 800, width: 400, height: 200 }
    })
    expect(latest!.style.left).toBe(800 - 184)
  })

  it('leaves a menu that fits where it is', () => {
    renderHook({ menu: { top: 132, left: 200, width: 400, height: 200 } })
    expect(latest!.style.left).toBe(ANCHOR.left)
  })

  it('re-measures on window resize', () => {
    renderHook()
    expect(latest!.side).toBe('down')
    act(() => {
      setViewport(1024, 200)
      window.dispatchEvent(new Event('resize'))
    })
    // 72px below the trigger now against 100 above → the side flips with no reopen.
    expect(latest!.side).toBe('up')
  })

  it('closes on an outside scroll but not on a scroll inside the menu', () => {
    const { onClose } = renderHook()
    scrollOn('inside')
    expect(onClose).not.toHaveBeenCalled()
    scrollOn('menu')
    expect(onClose).not.toHaveBeenCalled()

    scrollOn('outside')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('drops its listeners the moment the menu closes', () => {
    const { onClose, close } = renderHook()
    act(close)
    expect(latest).toBeNull()
    scrollOn('outside')
    window.dispatchEvent(new Event('resize'))
    expect(onClose).not.toHaveBeenCalled()
  })
})
