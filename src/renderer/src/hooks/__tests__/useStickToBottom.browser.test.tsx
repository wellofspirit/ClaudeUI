/**
 * Layer 2b: useStickToBottom against real layout, a real ResizeObserver and CSS
 * `zoom`. The jsdom file (useStickToBottom.unit.test.tsx) owns the decision
 * logic with a mocked observer; this one proves the claims only an engine can:
 * that growth which touches no DOM node (a style change here, a cv-auto swap in
 * the app) is pinned before the next paint, that the pin raises no "ResizeObserver
 * loop" error, and that the geometry maths holds under fractional zoom.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useStickToBottom, type StickToBottom } from '../useStickToBottom'

let api!: StickToBottom<HTMLDivElement>

function Harness({ zoom }: { zoom: number }): React.JSX.Element {
  const stick = useStickToBottom<HTMLDivElement>()
  api = stick
  return (
    <div style={{ zoom }}>
      <div
        data-testid="scroller"
        ref={stick.scrollerRef}
        style={{ height: 300, overflowY: 'auto' }}
      >
        <div data-testid="content" ref={stick.contentRef}>
          <div data-testid="tail" style={{ height: 900 }} />
        </div>
      </div>
    </div>
  )
}

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await frame()
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** User input, inside `act` because it flips React state. */
function wheel(el: HTMLElement, deltaY: number): void {
  act(() => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }))
  })
}

function distance(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

const loopErrors: string[] = []
const onError = (e: ErrorEvent): void => {
  if (/ResizeObserver loop/i.test(e.message)) loopErrors.push(e.message)
}

afterEach(() => {
  cleanup()
  window.removeEventListener('error', onError)
  loopErrors.length = 0
})

for (const zoom of [1, 1.15, 1.5]) {
  describe(`useStickToBottom in Chromium, zoom ${zoom}`, () => {
    function setup(): { scroller: HTMLElement; tail: HTMLElement } {
      window.addEventListener('error', onError)
      const view = render(<Harness zoom={zoom} />)
      return {
        scroller: view.getByTestId('scroller'),
        tail: view.getByTestId('tail')
      }
    }

    it('pins growth that adds no DOM node before the next paint, with no observer loop', async () => {
      const { scroller, tail } = setup()
      await frames(2)
      expect(distance(scroller)).toBeLessThan(1)

      for (const height of [1400, 2600, 2650]) {
        tail.style.height = `${height}px`
        await frame()
        expect(distance(scroller)).toBeLessThan(1)
      }
      expect(loopErrors).toEqual([])
    })

    it('a wheel-up leaves the bottom for good; programmatic scrolls do not decide', async () => {
      const { scroller, tail } = setup()
      await frames(2)

      wheel(scroller, -100)
      expect(scroller.getAttribute('data-following')).toBe('false')
      tail.style.height = '2000px'
      await frames(2)
      expect(distance(scroller)).toBeGreaterThan(1000)

      // No input for longer than the window: reaching the bottom by script is not a re-arm.
      await sleep(350)
      scroller.scrollTop = scroller.scrollHeight
      await frames(2)
      expect(scroller.getAttribute('data-following')).toBe('false')

      // A user scroll to the bottom is.
      scroller.scrollTop = 0
      await frames(2)
      await sleep(350)
      wheel(scroller, 100)
      scroller.scrollTop = scroller.scrollHeight
      await frames(2)
      expect(scroller.getAttribute('data-following')).toBe('true')
      tail.style.height = '2400px'
      await frame()
      expect(distance(scroller)).toBeLessThan(1)
    })

    it('a scroll by script, with no input, does not stop following', async () => {
      const { scroller, tail } = setup()
      await frames(2)
      await sleep(350)

      scroller.scrollTop = 0
      await frames(2)
      expect(scroller.getAttribute('data-following')).toBe('true')
      tail.style.height = '1500px'
      await frame()
      expect(distance(scroller)).toBeLessThan(1)
    })

    it('a far scrollToBottom lands on the true bottom and keeps following', async () => {
      const { scroller, tail } = setup()
      await frames(2)
      wheel(scroller, -100)
      tail.style.height = '6000px'
      await frames(2)
      scroller.scrollTop = 0
      await frames(2)

      act(() => api.scrollToBottom())
      await frame()
      expect(distance(scroller)).toBeLessThan(1)
      tail.style.height = '7000px'
      await frame()
      expect(distance(scroller)).toBeLessThan(1)
    })
  })
}
