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
 */
import { describe, it, expect } from 'vitest'
import { pickActiveGroup, SPY_OFFSET_PX } from '../View'

/** Headers as the view measures them: viewport-relative tops, in page order. */
const headers = (...tops: number[]): Array<{ id: string; top: number }> =>
  tops.map((top, i) => ({ id: `g${i}`, top }))

const PANE_TOP = 100
const LINE = PANE_TOP + SPY_OFFSET_PX

describe('pickActiveGroup', () => {
  it('marks nothing when no header has reached the line yet', () => {
    expect(pickActiveGroup(PANE_TOP, headers(LINE + 1, LINE + 400), false)).toBeNull()
  })

  it('marks a header sitting exactly on the line', () => {
    expect(pickActiveGroup(PANE_TOP, headers(LINE, LINE + 400), false)).toBe('g0')
  })

  it('marks the LAST header past the line, not the first', () => {
    // Reading the third block: two headers have scrolled past the top edge.
    expect(pickActiveGroup(PANE_TOP, headers(-600, -200, LINE + 300), false)).toBe('g1')
  })

  it('keeps the last passed header when everything is above the line', () => {
    expect(pickActiveGroup(PANE_TOP, headers(-900, -600, -200), false)).toBe('g2')
  })

  it('gives the bottom of the pane to the LAST group, whatever the rects say', () => {
    // The tail group's header is still well below the line — it can never reach
    // it — but the user is looking straight at it.
    expect(pickActiveGroup(PANE_TOP, headers(-400, LINE + 250), true)).toBe('g1')
  })

  it('marks nothing on an empty page', () => {
    expect(pickActiveGroup(PANE_TOP, [], false)).toBeNull()
    expect(pickActiveGroup(PANE_TOP, [], true)).toBeNull()
  })
})
