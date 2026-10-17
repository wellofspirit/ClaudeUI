/**
 * Layer 2b: Settings › Sessions & autonomy › Context pressure on a phone (session tools,
 * slice 4) — real Chromium, real Tailwind, the owner's S25 Ultra size, under the app's `zoom`.
 *
 * The group has to work in the phone's settings view: the three mode buttons, four threshold
 * chips with their remove buttons and the add field must fit a ~400px card without leaving it,
 * every control a 32px touch target, and the ceiling lines wrap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  DEFAULT_SETTINGS,
  EMPTY_SESSION_STATE,
  useSessionStore
} from '../../../stores/session-store'
import type { StatusLineData } from '../../../../../shared/types'
import {
  FONT_SCALES,
  PROFILE,
  ZoomFrame,
  allByTestId,
  byTestId,
  hasNoHorizontalOverflow,
  isInside,
  isInsideViewportX,
  rectOf,
  settle
} from '@test/helpers/mobile-layout'
import { ContextPressureSettings } from '../ContextPressureSettings'

beforeEach(() => {
  useSessionStore.setState({
    sessions: {
      a: {
        ...EMPTY_SESSION_STATE,
        selectedEngineId: 'claude',
        selectedModel: 'claude-sonnet-4-5-with-a-rather-long-model-name',
        statusLine: { contextWindow: { used: 1000, size: 200_000 } } as StatusLineData
      }
    }
  })
})

afterEach(() => {
  cleanup()
})

/** A settings card as the mobile view draws one: inset from the screen, bordered, clipped. */
function Card({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      data-testid="Card"
      className="mx-3 mb-3 rounded-xl border border-border bg-bg-secondary overflow-hidden"
    >
      {children}
    </div>
  )
}

describe('Context pressure settings on the phone', () => {
  for (const scale of FONT_SCALES) {
    it(`uiFontScale ${scale}: every row stays in the card and every control is a 32 px target`, async () => {
      expect(window.innerWidth).toBe(PROFILE.width)
      const view = render(
        <ZoomFrame scale={scale}>
          <Card>
            <ContextPressureSettings
              settings={{
                ...DEFAULT_SETTINGS,
                contextPressure: { mode: 'ask', thresholds: [30, 50, 70, 90] }
              }}
              update={() => {}}
            />
          </Card>
        </ZoomFrame>
      )
      await settle()
      await settle()
      const card = byTestId(view.container, 'Card')
      expect(isInsideViewportX(card)).toBe(true)
      for (const id of [
        'ContextPressureSettings.modeRow',
        'ContextPressureSettings.thresholdsRow',
        'ContextPressureSettings.ceilingRow'
      ]) {
        const row = byTestId(card, id)
        expect(isInside(row, card), id).toBe(true)
        expect(hasNoHorizontalOverflow(row), id).toBe(true)
      }
      const controls = [
        ...allByTestId(card, 'ContextPressureSettings.mode.option'),
        ...allByTestId(card, 'ContextPressureSettings.remove'),
        byTestId(card, 'ContextPressureSettings.input'),
        byTestId(card, 'ContextPressureSettings.add')
      ]
      expect(allByTestId(card, 'ContextPressureSettings.mode.option')).toHaveLength(3)
      expect(allByTestId(card, 'ContextPressureSettings.threshold')).toHaveLength(4)
      for (const control of controls) {
        expect(isInside(control, card)).toBe(true)
        expect(rectOf(control).height).toBeGreaterThanOrEqual(32 * scale - 1)
      }
      // 90 % is past Claude's 83 % on a 200k window: the warning is there and fits.
      const never = byTestId(card, 'ContextPressureSettings.never')
      expect(isInside(never, card)).toBe(true)
      expect(hasNoHorizontalOverflow(byTestId(card, 'ContextPressureSettings.ceiling'))).toBe(true)
    })
  }
})
