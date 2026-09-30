/**
 * Layer 1: the settings page's scroll-spy pick (ADR-065).
 *
 * jsdom has no layout — every `getBoundingClientRect()` is zero — so the rule
 * itself is a pure function over fake rects and is tested here rather than
 * through the view.
 *
 * The `atBottom` case is the one that bit: a group near the end of a page can
 * never bring its header to the spy line, because there is not enough content
 * below it to scroll. Without it, clicking the last rail sub-entry ("Git panel",
 * "Idle & retention") scrolled correctly and was then immediately re-marked as
 * the group before it.
 *
 * The line itself sits `max(SPY_OFFSET_PX, SPY_LINE_FRACTION × pane height)`
 * below the pane's top. The fixed 84 px line it replaced marked "Permissions"
 * while the Auto-mode judge filled most of the pane (measured in the real app:
 * judge header 115-253 px below the top of a ~600 px pane).
 */
import { describe, it, expect } from 'vitest'
import { pickActiveGroup, SPY_LINE_FRACTION, SPY_OFFSET_PX } from '../View'

/** Headers as the view measures them: viewport-relative tops, in page order. */
const headers = (...tops: number[]): Array<{ id: string; top: number }> =>
  tops.map((top, i) => ({ id: `g${i}`, top }))

const PANE_TOP = 100
/** A pane short enough that the fixed minimum offset is the deeper of the two. */
const SHORT = { top: PANE_TOP, height: 180 }
const LINE = PANE_TOP + SPY_OFFSET_PX

describe('pickActiveGroup', () => {
  it('marks nothing when no header has reached the line yet', () => {
    expect(pickActiveGroup(SHORT, headers(LINE + 1, LINE + 400), false)).toBeNull()
  })

  it('marks a header sitting exactly on the line', () => {
    expect(pickActiveGroup(SHORT, headers(LINE, LINE + 400), false)).toBe('g0')
  })

  it('marks the LAST header past the line, not the first', () => {
    // Reading the third block: two headers have scrolled past the top edge.
    expect(pickActiveGroup(SHORT, headers(-600, -200, LINE + 300), false)).toBe('g1')
  })

  it('keeps the last passed header when everything is above the line', () => {
    expect(pickActiveGroup(SHORT, headers(-900, -600, -200), false)).toBe('g2')
  })

  it('gives the bottom of the pane to the LAST group, whatever the rects say', () => {
    // The tail group's header is still well below the line — it can never reach
    // it — but the user is looking straight at it.
    expect(pickActiveGroup(SHORT, headers(-400, LINE + 250), true)).toBe('g1')
  })

  it('in a short pane the line is the fixed minimum offset', () => {
    expect(SPY_LINE_FRACTION * SHORT.height).toBeLessThan(SPY_OFFSET_PX)
    expect(pickActiveGroup(SHORT, headers(-50, LINE), false)).toBe('g1')
    expect(pickActiveGroup(SHORT, headers(-50, LINE + 1), false)).toBe('g0')
  })

  it('in a tall pane the line sits 45% down', () => {
    const pane = { top: PANE_TOP, height: 600 }
    const line = PANE_TOP + 0.45 * 600
    expect(pickActiveGroup(pane, headers(-50, line), false)).toBe('g1')
    expect(pickActiveGroup(pane, headers(-50, line + 1), false)).toBe('g0')
  })

  it('marks the judge, not Permissions, once the judge fills most of the pane', () => {
    // Sessions & autonomy as measured in the real app: a ~600 px pane, the
    // Permissions group's tail at the top, the judge header 115-253 px down.
    // At 45% the line is 270 px down, so the whole measured range is covered.
    const pane = { top: PANE_TOP, height: 600 }
    const page = (judgeOffset: number): Array<{ id: string; top: number }> => [
      { id: 'autonomy', top: PANE_TOP + judgeOffset - 707 },
      { id: 'permissions', top: PANE_TOP + judgeOffset - 322 },
      { id: 'judge', top: PANE_TOP + judgeOffset },
      { id: 'trust', top: PANE_TOP + judgeOffset + 381 }
    ]
    for (const offset of [115, 184, 253]) {
      expect(pickActiveGroup(pane, page(offset), false), `judge at ${offset}px`).toBe('judge')
    }
    // …while the judge is still in the lower part of the pane, Permissions
    // keeps the mark: the rail names the block you are reading.
    expect(pickActiveGroup(pane, page(391), false)).toBe('permissions')
  })

  it('still marks a group whose header a rail click scrolled to the top', () => {
    // scrollToGroup lands the header just under the pane's top padding (22 px).
    const pane = { top: PANE_TOP, height: 600 }
    expect(pickActiveGroup(pane, headers(-400, PANE_TOP + 22, PANE_TOP + 22 + 381), false)).toBe(
      'g1'
    )
  })

  it('marks nothing on an empty page', () => {
    expect(pickActiveGroup(SHORT, [], false)).toBeNull()
    expect(pickActiveGroup(SHORT, [], true)).toBeNull()
  })
})
