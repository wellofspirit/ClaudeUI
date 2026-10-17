/**
 * Layer 2b: the context-pressure banner on the phone and on a desktop-width column (session
 * tools, slice 4) — real Chromium, real Tailwind, the owner's S25 Ultra size, under the app's
 * `uiFontScale` zoom (docs/testing-strategy.md).
 *
 * What jsdom cannot see: the text wraps inside the column instead of pushing the page sideways,
 * Hand off and Not now stay finger-sized (32 px) and inside the banner in both states, and on a
 * desktop column the two buttons sit on the line with the text.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render } from '@testing-library/react'
import type { ContextPressureBanner as BannerData } from '../../../../../../shared/context-pressure'
import { ContextPressureBannerView } from '../ContextPressureBanner'
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

function noop(): void {}

afterEach(async () => {
  cleanup()
  await page.viewport(PROFILE.width, 900)
})

function mount(
  banner: BannerData,
  scale: number,
  error?: string,
  blockedReason?: string
): HTMLElement {
  return render(
    <ZoomFrame scale={scale}>
      <ContextPressureBannerView
        banner={banner}
        error={error}
        blockedReason={blockedReason}
        isMobile
        onHandOff={noop}
        onDismiss={noop}
      />
    </ZoomFrame>
  ).container
}

describe('the context-pressure banner, on the phone', () => {
  for (const scale of FONT_SCALES) {
    for (const banner of [
      { kind: 'ask', percent: 72 },
      { kind: 'failed', percent: 88 }
    ] as BannerData[]) {
      it(`uiFontScale ${scale}, ${banner.kind}: wraps inside the column, both buttons are 32 px targets inside it`, async () => {
        expect(window.innerWidth).toBe(PROFILE.width)
        const root = mount(
          banner,
          scale,
          'Could not reach the session: a very long transport failure message that has to wrap',
          'Switch out of plan mode to hand off.'
        )
        await settle()
        const bar = byTestId(root, 'ContextPressureBanner')
        expect(isInsideViewportX(bar)).toBe(true)
        expect(hasNoHorizontalOverflow(bar)).toBe(true)
        for (const id of [
          'ContextPressureBanner.text',
          'ContextPressureBanner.handoff',
          'ContextPressureBanner.dismiss',
          'ContextPressureBanner.error',
          'ContextPressureBanner.reason'
        ]) {
          const el = byTestId(root, id)
          expect(isInside(el, bar), id).toBe(true)
          expect(isInsideViewportX(el), id).toBe(true)
        }
        for (const id of ['ContextPressureBanner.handoff', 'ContextPressureBanner.dismiss']) {
          expect(rectOf(byTestId(root, id)).height, id).toBeGreaterThanOrEqual(32 * scale - 1)
        }
      })
    }
  }
})

describe('the context-pressure banner, on a desktop-width column', () => {
  it('puts the text and both buttons on one line in a 720 px column', async () => {
    await page.viewport(1280, 800)
    const root = render(
      <div style={{ width: 720 }}>
        <ContextPressureBannerView
          banner={{ kind: 'ask', percent: 72 }}
          isMobile={false}
          onHandOff={noop}
          onDismiss={noop}
        />
      </div>
    ).container
    await settle()
    const bar = byTestId(root, 'ContextPressureBanner')
    const text = byTestId(root, 'ContextPressureBanner.text')
    const handoff = byTestId(root, 'ContextPressureBanner.handoff')
    const dismiss = byTestId(root, 'ContextPressureBanner.dismiss')
    expect(hasNoHorizontalOverflow(bar)).toBe(true)
    expect(isInside(handoff, bar)).toBe(true)
    expect(isInside(dismiss, bar)).toBe(true)
    expect(Math.abs(rectOf(handoff).top - rectOf(text).top)).toBeLessThan(16)
    expect(Math.abs(rectOf(handoff).top - rectOf(dismiss).top)).toBeLessThan(2)
    expect(rectOf(dismiss).left).toBeGreaterThan(rectOf(handoff).right - 1)
  })
})
