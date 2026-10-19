/**
 * Layer 2b: the held peer-message row with its Allow action on a phone — real
 * Chromium, real Tailwind, the owner's S25 Ultra size, under the app's
 * `uiFontScale` zoom (docs/testing-strategy.md).
 *
 * What jsdom cannot see: the sentence is long and the button label is the longest
 * label in the transcript ("Allow messages from other Claude sessions here"), so
 * both have to WRAP inside the column rather than run off the screen, and the
 * button must stay a finger-sized target (>= 32 px high) whatever the zoom.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { PeerHoldRow } from '../PeerHoldRow'
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

const BLOCK = {
  type: 'peer_hold' as const,
  holdId: 'm1',
  state: 'held' as const,
  lane: 'socket' as const,
  fromName: 'a-rather-long-session-name-that-keeps-going-and-going',
  cause: 'no-mode-asserted'
}

async function mount(scale: number): Promise<HTMLElement> {
  const view = render(
    <ZoomFrame scale={scale}>
      <PeerHoldRow
        block={BLOCK}
        onAllow={() => {}}
        error="settings are managed by your organisation"
      />
    </ZoomFrame>
  )
  await settle()
  return view.container
}

afterEach(() => cleanup())

describe('held peer message row, on the phone', () => {
  for (const scale of FONT_SCALES) {
    it(`uiFontScale ${scale}: the sentence and the Allow button wrap inside the screen, the button stays a 32 px target`, async () => {
      expect(window.innerWidth).toBe(PROFILE.width)
      const root = await mount(scale)
      const row = byTestId(root, 'PeerHoldRow')
      const sentence = byTestId(root, 'PeerHoldRow.sentence')
      const button = byTestId(root, 'PeerHoldRow.allow')
      const error = byTestId(root, 'PeerHoldRow.error')

      for (const el of [row, sentence, button, error]) {
        expect(isInsideViewportX(el)).toBe(true)
        expect(hasNoHorizontalOverflow(el)).toBe(true)
      }
      expect(isInside(button, row)).toBe(true)
      expect(isInside(error, row)).toBe(true)
      expect(rectOf(button).height).toBeGreaterThanOrEqual(32 * scale - 1)
      // The label is whole: wrapped, not clipped.
      expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1)
    })
  }
})
