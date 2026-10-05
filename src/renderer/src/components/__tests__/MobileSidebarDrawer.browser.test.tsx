/**
 * Layer 2b: the phone's sidebar drawer under SessionView's zoom (ADR-092).
 *
 * `w-[280px]` is 280 ZOOMED px: 420px of a 412px screen at uiFontScale 1.5, so
 * the drawer's right edge was off-screen. It is now capped at 85% of the window.
 * The child stands in for the Sidebar, which SessionView gives `width: 100%`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import {
  FONT_SCALES,
  PROFILE,
  ZoomFrame,
  byTestId,
  rectOf,
  settle
} from '@test/helpers/mobile-layout'
import { MobileSidebarDrawer } from '../MobileSidebarDrawer'

describe('mobile sidebar drawer', () => {
  afterEach(cleanup)

  for (const scale of FONT_SCALES) {
    it(`stays inside the screen at uiFontScale ${scale}`, async () => {
      expect(window.innerWidth).toBe(PROFILE.width)
      const view = render(
        <ZoomFrame scale={scale}>
          <MobileSidebarDrawer onClose={() => {}}>
            <div data-testid="FakeSidebar" style={{ width: '100%', height: '100%' }} />
          </MobileSidebarDrawer>
        </ZoomFrame>
      )
      await settle()
      // It slides in from the left: measure it at rest.
      const panel = byTestId(view.container, 'MobileSidebarDrawer')
      await Promise.all(panel.getAnimations().map((a) => a.finished))
      const drawer = rectOf(panel)
      expect(drawer.left).toBeGreaterThanOrEqual(0)
      expect(drawer.right).toBeLessThanOrEqual(window.innerWidth)
      // Capped at 85% of the window, so the scrim keeps a strip to tap...
      expect(drawer.width).toBeLessThanOrEqual(window.innerWidth * 0.85 + 1)
      // ...and the sidebar inside fills the capped panel instead of overflowing it.
      const inner = rectOf(byTestId(view.container, 'FakeSidebar'))
      expect(inner.right).toBeLessThanOrEqual(drawer.right + 1)
      expect(inner.width).toBeGreaterThanOrEqual(drawer.width - 1)
      // Where it was not capped, it is still the 280px it always was.
      if (scale === 1) expect(drawer.width).toBeCloseTo(280, 0)
    })
  }
})
