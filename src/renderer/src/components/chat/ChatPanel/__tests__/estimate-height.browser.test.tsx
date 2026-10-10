/**
 * Layer 2b: the height estimate against REAL rendered messages (real
 * MessageBubble, real Tailwind, real Chromium, under CSS zoom).
 *
 * The unit tests pin the arithmetic; this one pins that the arithmetic still
 * describes the components: when someone changes a card's padding, a max-height
 * cap or the markdown spacing, the ratio drifts and this fails. The bounds are
 * deliberately loose (the estimate is an order-of-magnitude heuristic for a
 * never-rendered message, not a layout engine): the point is "not 100px for
 * everything", not pixel accuracy.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import {
  useSessionStore,
  EMPTY_SESSION_STATE,
  DEFAULT_SETTINGS
} from '../../../../stores/session-store'
import { MessageBubble } from '../../MessageBubble'
import { effectiveZoom } from '../../../../lib/effective-zoom'
import { settle } from '@test/helpers/mobile-layout'
import type { ChatMessage } from '../../../../../../shared/types'
import { estimateMessageHeight, type EstimateOptions } from '../estimate-height'
import { SAMPLES } from './estimate-samples'

const ROUTE = 'route-estimate'
/**
 * Samples are built from the components' own constants, so they land within a few
 * percent on this machine. The slack is for the font: prose wraps on the system
 * sans (Segoe UI here, Noto/Helvetica on Linux CI, SF on macOS), whose advance
 * differs by up to ~10%.
 */
const MIN_RATIO = 0.7
const MAX_RATIO = 1.45

function seed(forkRow: boolean, settings: Partial<typeof DEFAULT_SETTINGS>): void {
  useSessionStore.setState({
    activeSessionId: ROUTE,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    sessions: {
      [ROUTE]: {
        ...EMPTY_SESSION_STATE,
        status: {
          ...EMPTY_SESSION_STATE.status,
          engineId: 'claude',
          capabilities: { ...EMPTY_SESSION_STATE.status.capabilities, forkFromMessage: forkRow }
        }
      }
    }
  })
}

/** The chat column as ChatPanel builds it: zoomed content div, `px-8`, a column of the given width. */
async function measure(
  message: ChatMessage,
  column: number,
  zoom: number
): Promise<{ actual: number; el: HTMLElement }> {
  const view = render(
    <div style={{ width: (column + 64) * zoom }}>
      <div
        data-testid="column"
        style={{ zoom: zoom !== 1 ? zoom : undefined }}
        className="mx-auto pt-5 pb-6 flex flex-col gap-3 px-8"
      >
        <div data-testid="wrapper">
          <MessageBubble message={message} pendingApprovals={[]} isLastAssistant={false} />
        </div>
      </div>
    </div>
  )
  await settle()
  const el = view.getByTestId('wrapper')
  const rect = el.getBoundingClientRect()
  return { actual: rect.height / effectiveZoom(el, rect), el }
}

afterEach(() => cleanup())

describe('estimateMessageHeight vs rendered messages', () => {
  for (const [column, zoom] of [
    [700, 1],
    [380, 1],
    [700, 1.15]
  ] as const) {
    for (const sample of SAMPLES) {
      it(`${sample.name} @${column}px zoom ${zoom}`, async () => {
        const options: Partial<EstimateOptions> = { ...sample.options, forkRow: !!sample.fork }
        seed(!!sample.fork, {
          ...(sample.options?.expandToolCalls !== undefined
            ? { expandToolCalls: sample.options.expandToolCalls }
            : {}),
          expandReadResults: !!sample.options?.expandReadResults,
          expandThinking: !!sample.options?.expandThinking,
          hideToolInput: !!sample.options?.hideToolInput
        })
        const { actual } = await measure(sample.message, column, zoom)
        // The column's own content width in the wrapper's units is `column`.
        const estimate = estimateMessageHeight(sample.message, column, options)
        const ratio = estimate / actual
        expect(
          ratio,
          `${sample.name}: estimate ${estimate}px, rendered ${actual.toFixed(0)}px`
        ).toBeGreaterThan(sample.min ?? MIN_RATIO)
        expect(
          ratio,
          `${sample.name}: estimate ${estimate}px, rendered ${actual.toFixed(0)}px`
        ).toBeLessThan(sample.max ?? MAX_RATIO)
      })
    }
  }
})

describe('contain-intrinsic-size units under the column zoom', () => {
  for (const zoom of [1, 1.15, 1.5]) {
    it(`a skipped wrapper occupies exactly its estimate in its own CSS px, zoom ${zoom}`, async () => {
      // Far below the 728px viewport, so content-visibility skips it and only the
      // intrinsic size is laid out.
      const view = render(
        <div style={{ width: 764 * zoom }}>
          <div
            style={{ zoom: zoom !== 1 ? zoom : undefined, marginTop: 4000 }}
            className="mx-auto flex flex-col gap-3 px-8"
          >
            <div
              data-testid="skipped"
              className="cv-auto"
              style={{ containIntrinsicSize: 'auto 480px' }}
            >
              <div style={{ height: 2000 }} />
            </div>
          </div>
        </div>
      )
      await settle()
      const el = view.getByTestId('skipped')
      const rect = el.getBoundingClientRect()
      // Page px divided by the zoom is the children's own CSS px — the unit the
      // estimate is in.
      expect(rect.height / effectiveZoom(el, rect)).toBeCloseTo(480, 0)
    })
  }
})
