/**
 * Layer 2b: Settings › Voice input › On-device speech model on a phone (ADR-101
 * §6) — real Chromium, real Tailwind, the owner's S25 Ultra size, under the app's
 * `zoom`. The row's state text and its one button share the control column that
 * the row caps at 58% of its width below `md`; a long failure message must wrap
 * there rather than push the button or the row off the card.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  FONT_SCALES,
  PROFILE,
  ZoomFrame,
  byTestId,
  hasNoHorizontalOverflow,
  isInside,
  isInsideViewportX,
  settle
} from '@test/helpers/mobile-layout'
import { VoicePackSetting, VoicePreviewSetting } from '../VoicePackSetting'
import {
  applyVoicePackStatus,
  resetVoicePackStoreForTests
} from '../../../lib/voice/voice-pack-store'
import type { VoicePackState, VoicePackStatus } from '../../../../../shared/voice-pack'

const realApi = window.api

const status = (state: VoicePackState, over: Partial<VoicePackStatus> = {}): VoicePackStatus => ({
  state,
  packId: 'parakeet-tdt-0.6b-v2-int8',
  label: 'Parakeet TDT 0.6B v2 (English)',
  approxBytes: 700_000_000,
  ...over
})

const LONG_ERROR =
  'Downloading encoder.int8.onnx from huggingface.co failed: the connection was reset by peer after 412 MB'

beforeEach(() => {
  resetVoicePackStoreForTests()
  // The row re-reads the status when it mounts: answer with what the test pushed.
  Object.defineProperty(window, 'api', {
    value: { voicePackStatus: async () => hostStatus },
    configurable: true,
    writable: true
  })
})
afterEach(() => {
  cleanup()
  resetVoicePackStoreForTests()
  Object.defineProperty(window, 'api', { value: realApi, configurable: true, writable: true })
})

let hostStatus: VoicePackStatus

const CASES: Array<[string, VoicePackStatus, string]> = [
  ['not installed', status('missing'), 'VoicePackSetting.install'],
  [
    'downloading',
    status('installing', { progress: { receivedBytes: 294_000_000, totalBytes: 700_000_000 } }),
    'VoicePackSetting.cancel'
  ],
  ['installed', status('ready'), 'VoicePackSetting.remove'],
  ['a long failure', status('failed', { error: LONG_ERROR }), 'VoicePackSetting.install']
]

describe('the speech model row on the phone', () => {
  for (const scale of FONT_SCALES) {
    for (const [name, pack, buttonId] of CASES) {
      it(`uiFontScale ${scale}: ${name} fits the card, its button whole beside the state`, async () => {
        expect(window.innerWidth).toBe(PROFILE.width)
        hostStatus = pack
        const view = render(
          <ZoomFrame scale={scale}>
            <div
              data-testid="Card"
              className="mx-3 rounded-xl border border-border overflow-hidden"
            >
              <VoicePackSetting />
              <VoicePreviewSetting enabled />
            </div>
          </ZoomFrame>
        )
        applyVoicePackStatus(pack)
        await settle()
        const card = byTestId(view.container, 'Card')
        const row = byTestId(card, 'VoicePackSetting')
        const button = byTestId(row, buttonId)
        const state = byTestId(row, 'VoicePackSetting.state')

        expect(isInsideViewportX(card)).toBe(true)
        expect(hasNoHorizontalOverflow(row)).toBe(true)
        expect(isInside(button, row)).toBe(true)
        expect(isInside(state, row)).toBe(true)
        // The button label is whole; the state text wraps instead of clipping.
        expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1)
        expect(state.scrollWidth).toBeLessThanOrEqual(state.clientWidth + 1)

        // And the toggle row under it fits too.
        const preview = byTestId(card, 'VoicePreviewSetting.toggle')
        expect(hasNoHorizontalOverflow(preview)).toBe(true)
        expect(isInside(preview, card)).toBe(true)
      })
    }
  }
})
