/**
 * Layer 2b: nested sidebar rows, the session card and the continued-in bar on a
 * phone — real Chromium, real Tailwind, the owner's S25 Ultra size, under the
 * app's `uiFontScale` zoom (docs/testing-strategy.md).
 *
 * What jsdom cannot see: the mobile drawer is 100% wide, so a row indented three
 * levels with a long title and a fold toggle must still fit the screen and keep
 * the toggle a finger-sized target; and the card and the bar carry the longest
 * strings in the transcript, so they have to wrap or truncate inside the column.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { cleanup, render } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import type { DirectoryGroup, SessionInfo } from '../../../../../shared/types'
import type { SessionLinkInfo } from '../../../../../shared/session-links'
import { resetCollapsedParentsForTests } from '../../../lib/collapsed-parents'
import { DirectoryItem } from '../DirectoryItem'
import { SessionCardView } from '../../chat/SessionCard'
import { SessionLinkBarView } from '../../chat/ChatPanel/SessionLinkBar'
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

const LONG = 'a-rather-long-session-title-that-keeps-going-and-going-and-going-past-the-edge'

const info = (sessionId: string, title: string): SessionInfo => ({
  sessionId,
  cwd: '/work/demo',
  projectKey: 'demo',
  title,
  timestamp: 0,
  lastActivityAt: 0
})

const GROUP: DirectoryGroup = {
  cwd: '/work/demo',
  projectKey: 'demo',
  folderName: 'demo',
  sessions: [info('g', LONG), info('c', LONG), info('p', LONG), info('x', 'Other')]
}

const link = (parentRef: string): SessionLinkInfo => ({
  parentRef,
  kind: 'started',
  state: 'live',
  createdBy: 'agent',
  wakeParent: false,
  createdAt: 1
})

function noop(): void {}

let initial: ReturnType<typeof useSessionStore.getState>
beforeEach(() => {
  initial = useSessionStore.getState()
  localStorage.clear()
  resetCollapsedParentsForTests()
  // p ← c ← g: a parent, a child and a grandchild.
  useSessionStore.setState({
    sessionRefs: { p: 'r-p', c: 'r-c', g: 'r-g' },
    sessionLinks: { 'r-c': link('r-p'), 'r-g': link('r-c') },
    directories: [GROUP]
  })
})
afterEach(() => {
  cleanup()
  useSessionStore.setState(initial, true)
})

async function mountDrawer(scale: number, onToggleWatch: () => void = noop): Promise<HTMLElement> {
  const view = render(
    <ZoomFrame scale={scale}>
      <div style={{ padding: '0 8px' }}>
        <DirectoryItem
          group={GROUP}
          expanded
          activeSessionId={null}
          onClick={noop}
          onDoubleClick={noop}
          onSessionClick={noop}
          onSessionDoubleClick={noop}
          onToggleWatch={onToggleWatch}
          renamingKey={null}
          renamePrefix="project:demo"
          onStartRename={noop}
          onFinishRename={noop}
          onAutoRename={noop}
          onCancelRename={noop}
        />
      </div>
    </ZoomFrame>
  )
  await settle()
  return view.container
}

const rowOf = (root: HTMLElement, id: string): HTMLElement =>
  Array.from(root.querySelectorAll<HTMLElement>('[data-testid="SessionItem"]')).find(
    (el) => el.dataset.id === id
  )!

describe('nested sidebar rows, on the phone drawer', () => {
  for (const scale of FONT_SCALES) {
    it(`uiFontScale ${scale}: every nesting level fits the screen, deeper rows sit further in, the toggle is a 40 px target`, async () => {
      expect(window.innerWidth).toBe(PROFILE.width)
      const root = await mountDrawer(scale)

      const rows = ['x', 'p', 'c', 'g'].map((id) => rowOf(root, id))
      for (const row of rows) {
        expect(isInsideViewportX(row)).toBe(true)
        expect(hasNoHorizontalOverflow(row)).toBe(true)
        expect(rectOf(row).height).toBeGreaterThanOrEqual(32 * scale - 1)
      }
      // The dot of each level starts further right than the level above.
      const dotLeft = (id: string): number =>
        rectOf(byTestId(rowOf(root, id), 'SessionItem.statusDot')).left
      expect(dotLeft('c')).toBeGreaterThan(dotLeft('p'))
      expect(dotLeft('g')).toBeGreaterThan(dotLeft('c'))
      expect(dotLeft('x')).toBeCloseTo(dotLeft('p'), 0)

      // The fold toggle stays inside its row at the deepest level, and is finger-sized.
      for (const id of ['p', 'c']) {
        const toggle = byTestId(rowOf(root, id), 'SessionItem.toggleChildren')
        expect(isInside(toggle, rowOf(root, id))).toBe(true)
        expect(isInsideViewportX(toggle)).toBe(true)
        expect(rectOf(toggle).width).toBeGreaterThanOrEqual(40 * scale - 1)
        expect(rectOf(toggle).height).toBeGreaterThanOrEqual(32 * scale - 1)
      }
    })
  }
})

describe('the session card, on the phone', () => {
  for (const scale of FONT_SCALES) {
    it(`uiFontScale ${scale}: a long title wraps the row, nothing leaves the card, Open stays a 32 px target`, async () => {
      const view = render(
        <ZoomFrame scale={scale}>
          <div style={{ padding: '0 12px' }}>
            <SessionCardView
              kind="handoff"
              title={LONG}
              engineId="claude"
              state="needs-you"
              childRef="s-abcdef"
              onOpen={noop}
            />
          </div>
        </ZoomFrame>
      )
      await settle()
      const card = byTestId(view.container, 'SessionCard')
      const open = byTestId(view.container, 'SessionCard.open')
      const title = byTestId(view.container, 'SessionCard.title')
      const state = byTestId(view.container, 'SessionCard.state')
      for (const el of [card, open, title, state]) {
        expect(isInsideViewportX(el)).toBe(true)
        expect(isInside(el, card)).toBe(true)
      }
      expect(hasNoHorizontalOverflow(card)).toBe(true)
      expect(rectOf(open).height).toBeGreaterThanOrEqual(32 * scale - 1)
    })
  }
})

describe('the continued-in bar, on the phone', () => {
  for (const scale of FONT_SCALES) {
    it(`uiFontScale ${scale}: long names truncate inside the screen and both markers stay 32 px targets`, async () => {
      const view = render(
        <ZoomFrame scale={scale}>
          <SessionLinkBarView
            items={[
              { direction: 'from', id: 'a', title: LONG },
              { direction: 'into', id: 'b', title: LONG }
            ]}
            onOpen={noop}
          />
        </ZoomFrame>
      )
      await settle()
      const bar = byTestId(view.container, 'SessionLinkBar')
      expect(isInsideViewportX(bar)).toBe(true)
      expect(hasNoHorizontalOverflow(bar)).toBe(true)
      for (const id of ['SessionLinkBar.from', 'SessionLinkBar.into']) {
        const marker = byTestId(view.container, id)
        expect(isInside(marker, bar)).toBe(true)
        expect(rectOf(marker).height).toBeGreaterThanOrEqual(32 * scale - 1)
      }
    })
  }
})

describe('the fold toggle and the row’s hover actions', () => {
  const sizes = [
    ['phone', PROFILE.width, 900],
    ['desktop', 1280, 800]
  ] as const
  afterEach(async () => {
    await page.viewport(PROFILE.width, 900)
  })

  for (const [label, width, height] of sizes) {
    for (const hovered of [false, true]) {
      it(`${label}, row ${hovered ? 'hovered' : 'at rest'}: a click on the toggle’s right edge folds, and never starts Watching`, async () => {
        await page.viewport(width, height)
        const watch = vi.fn()
        const root = await mountDrawer(1, watch)
        const row = rowOf(root, 'p')
        const toggle = byTestId(row, 'SessionItem.toggleChildren')
        if (hovered) await userEvent.hover(row)

        // The toggle's right edge is clear of the Watch/Pin strip: the hit test finds the toggle there.
        const r = rectOf(toggle)
        const hit = document.elementFromPoint(r.right - 2, r.top + r.height / 2)
        expect(toggle.contains(hit)).toBe(true)

        await userEvent.click(toggle, { position: { x: r.width - 2, y: r.height / 2 } })
        expect(toggle.getAttribute('data-collapsed')).toBe('true')
        expect(watch).not.toHaveBeenCalled()
        // At rest the invisible strip takes no taps: a tap where Watch sits goes to the row.
        if (!hovered) {
          const at = rectOf(byTestId(row, 'SessionItem.toggleWatch'))
          const under = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2)
          expect(byTestId(row, 'SessionItem.toggleWatch').contains(under)).toBe(false)
        }
        // The strip is not covered by the toggle either: Watch still works from its own icon when hovered.
        if (hovered) {
          const icon = byTestId(row, 'SessionItem.toggleWatch')
          expect(isInside(icon, row)).toBe(true)
          expect(rectOf(icon).left).toBeGreaterThanOrEqual(rectOf(toggle).right - 0.75)
        }
      })
    }
  }
})
