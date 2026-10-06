/**
 * Layer 2b: Settings › <engine> › Agent colours on a phone (ADR-093) — real
 * Chromium, real Tailwind, the owner's S25 Ultra size, under the app's `zoom`.
 *
 * The group has to work in the phone's settings view: eight swatches and a
 * Reset button per row must fit a ~400px card without leaving it, each swatch a
 * real touch target, and the name still readable beside the tile. The settings
 * sheet divides its width by `uiFontScale` (SheetFrame), so this wraps the group
 * in a card inside the same zoomed root as the other layout tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { page } from 'vitest/browser'
import { render, cleanup } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '../../../stores/session-store'
import type { AgentTypeInfo } from '../../../../../shared/types'
import {
  FONT_SCALES,
  PROFILE,
  rowCount,
  ZoomFrame,
  allByTestId,
  byTestId,
  hasNoHorizontalOverflow,
  isInside,
  isInsideViewportX,
  rectOf,
  settle
} from '@test/helpers/mobile-layout'
import { resetAgentTypeCatalog } from '../../../hooks/useAgentTypeCatalog'
import { AgentColoursSection, DispatchTileColourSection } from '../AgentColours'

const TYPES: AgentTypeInfo[] = [
  { type: 'general-purpose', source: 'builtin' },
  { type: 'Explore', source: 'builtin' },
  { type: 'migration-reviewer-with-a-long-name', source: 'project', nativeColor: 'purple' }
]

const realApi = window.api

beforeEach(() => {
  resetAgentTypeCatalog()
  Object.defineProperty(window, 'api', {
    value: { listAgentTypes: async () => TYPES },
    configurable: true,
    writable: true
  })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { value: realApi, configurable: true, writable: true })
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

describe('Agent colours on the phone', () => {
  for (const scale of FONT_SCALES) {
    describe(`uiFontScale ${scale}`, () => {
      it('keeps every row inside the card, every swatch reachable and the name readable', async () => {
        const view = render(
          <ZoomFrame scale={scale}>
            <Card>
              <AgentColoursSection
                engine="claude"
                // Explore has an override, so its Reset link is on the row too.
                settings={{ ...DEFAULT_SETTINGS, agentTypeColors: { claude: { Explore: 'rose' } } }}
                update={() => {}}
              />
            </Card>
          </ZoomFrame>
        )
        await settle()
        await settle()
        const card = byTestId(view.container, 'Card')
        expect(isInsideViewportX(card)).toBe(true)
        const rows = allByTestId(card, 'AgentColours.row')
        expect(rows).toHaveLength(TYPES.length)
        for (const row of rows) {
          expect(hasNoHorizontalOverflow(row)).toBe(true)
          expect(isInside(row, card)).toBe(true)
        }
        // A pickable row: all eight swatches inside it, each a >=24 CSS px target.
        for (const type of ['Explore', 'migration-reviewer-with-a-long-name']) {
          const row = rows.find((r) => r.getAttribute('data-id') === type)!
          const swatches = allByTestId(row, 'AgentColours.swatch')
          expect(swatches).toHaveLength(8)
          // Two rows of four on the phone, however large the type.
          expect(rowCount(swatches, 2)).toBe(2)
          for (const swatch of swatches) {
            expect(isInside(swatch, row)).toBe(true)
            expect(rectOf(swatch).width).toBeGreaterThanOrEqual(24 * scale - 0.75)
            expect(rectOf(swatch).height).toBeGreaterThanOrEqual(24 * scale - 0.75)
          }
          if (type === 'Explore') {
            expect(isInside(byTestId(row, 'AgentColours.reset'), row)).toBe(true)
          }
          // The tile keeps its 16px, and the name keeps a readable share of the row.
          expect(byTestId(row, 'AgentColours.tile').clientHeight).toBe(16)
          const label = Array.from(row.querySelectorAll<HTMLElement>('span')).find(
            (el) => el.textContent === type
          )!
          expect(rectOf(label).width).toBeGreaterThanOrEqual(64 * scale - 1)
        }
      })

      it('lays the dispatch tile row out inside its card too', async () => {
        const view = render(
          <ZoomFrame scale={scale}>
            <Card>
              <DispatchTileColourSection settings={DEFAULT_SETTINGS} update={() => {}} />
            </Card>
          </ZoomFrame>
        )
        await settle()
        const card = byTestId(view.container, 'Card')
        const row = byTestId(card, 'DispatchTileColourSection.row')
        expect(hasNoHorizontalOverflow(row)).toBe(true)
        expect(isInside(row, card)).toBe(true)
        for (const swatch of allByTestId(row, 'DispatchTileColour.swatch')) {
          expect(isInside(swatch, row)).toBe(true)
        }
      })
    })
  }
})

// The settings dialog on a desktop window: the same group, one row of eight.
describe('Agent colours on a desktop window', () => {
  beforeEach(async () => {
    await page.viewport(1280, 720)
  })
  afterEach(async () => {
    cleanup()
    // The other browser tests are written for the phone.
    await page.viewport(PROFILE.width, PROFILE.height)
  })

  for (const scale of [1, 1.25, 1.5]) {
    it(`keeps all eight swatches on ONE row, inside a 560px card (uiFontScale ${scale})`, async () => {
      const view = render(
        <ZoomFrame scale={scale}>
          <div
            data-testid="Card"
            className="rounded-xl border border-border bg-bg-secondary w-[560px]"
          >
            <AgentColoursSection engine="claude" settings={DEFAULT_SETTINGS} update={() => {}} />
          </div>
        </ZoomFrame>
      )
      await settle()
      await settle()
      expect(window.innerWidth).toBe(1280)
      const card = byTestId(view.container, 'Card')
      for (const type of ['Explore', 'migration-reviewer-with-a-long-name']) {
        const row = allByTestId(card, 'AgentColours.row').find(
          (r) => r.getAttribute('data-id') === type
        )!
        const swatches = allByTestId(row, 'AgentColours.swatch')
        expect(swatches).toHaveLength(8)
        // 7 + 1 was the bug: the cap was 6px short of 8 x 24px plus the gaps.
        expect(rowCount(swatches, 2)).toBe(1)
        for (const swatch of swatches) expect(isInside(swatch, row)).toBe(true)
        expect(hasNoHorizontalOverflow(row)).toBe(true)
      }
    })
  }
})
