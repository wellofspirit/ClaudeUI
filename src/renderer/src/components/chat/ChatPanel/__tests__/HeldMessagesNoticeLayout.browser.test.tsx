/**
 * Layer 2b: the held-messages notice on the phone and on a desktop-width column (session tools,
 * slice 1a) — real Chromium, real Tailwind, the owner's S25 Ultra size, under the app's
 * `uiFontScale` zoom (docs/testing-strategy.md).
 *
 * What jsdom cannot see: the one-line text wraps inside the column at every zoom instead of
 * pushing the page sideways, the strip stays at least 32 px tall, and at 0 nothing takes room.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render } from '@testing-library/react'
import { HeldMessagesNoticeView } from '../HeldMessagesNotice'
import {
  FONT_SCALES,
  PROFILE,
  ZoomFrame,
  byTestId,
  hasNoHorizontalOverflow,
  isInside,
  isInsideViewportX,
  rectOf,
  settle
} from '@test/helpers/mobile-layout'

afterEach(async () => {
  cleanup()
  await page.viewport(PROFILE.width, 900)
})

describe('the held-messages notice, on the phone', () => {
  for (const scale of FONT_SCALES) {
    it(`uiFontScale ${scale}: the text wraps inside the column and the strip is at least 32 px tall`, async () => {
      expect(window.innerWidth).toBe(PROFILE.width)
      const root = render(
        <ZoomFrame scale={scale}>
          <HeldMessagesNoticeView count={128} isMobile />
        </ZoomFrame>
      ).container
      await settle()
      const bar = byTestId(root, 'HeldMessagesNotice')
      const text = byTestId(root, 'HeldMessagesNotice.text')
      expect(isInsideViewportX(bar)).toBe(true)
      expect(hasNoHorizontalOverflow(bar)).toBe(true)
      expect(isInside(text, bar)).toBe(true)
      expect(rectOf(bar).height).toBeGreaterThanOrEqual(32 * scale - 1)
    })
  }

  it('takes no room at 0', async () => {
    const root = render(
      <ZoomFrame scale={1}>
        <HeldMessagesNoticeView count={0} isMobile />
      </ZoomFrame>
    ).container
    await settle()
    expect(root.querySelector('[data-testid="HeldMessagesNotice"]')).toBeNull()
  })
})

describe('the held-messages notice, on a desktop-width column', () => {
  it('is one line in a 720 px column', async () => {
    await page.viewport(1280, 800)
    const root = render(
      <div style={{ width: 720 }}>
        <HeldMessagesNoticeView count={3} isMobile={false} />
      </div>
    ).container
    await settle()
    const bar = byTestId(root, 'HeldMessagesNotice')
    const text = byTestId(root, 'HeldMessagesNotice.text')
    expect(hasNoHorizontalOverflow(bar)).toBe(true)
    expect(isInside(text, bar)).toBe(true)
    expect(rectOf(text).height).toBeLessThan(24)
  })
})
