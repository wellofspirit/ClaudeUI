/**
 * Layer 2b: the Updates panel's geometry in real Chromium with real Tailwind
 * (docs/testing-strategy.md). What jsdom cannot see: in the phone drawer the
 * panel must fit a 360 px container at every `uiFontScale` without a
 * horizontal overflow, and on the desktop, at its 344 px, no `from → to` line
 * may truncate (the version pair is the one thing on a row that must read in
 * full). Mockup states A (release), C (local build) and D (working).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { AppUpdateView } from '../../../../../shared/types/app-update'
import type { HarnessInstallProgress } from '../../../../../shared/harness-types'
import { UpdatesPanelView, type UpdatesPanelViewProps } from '../View'
import { appSection, harnessUpdateRows } from '../utils'
import { CHECKED, TREES, buildingView, harnessView, localView, stagedView } from './fixtures'
import {
  FONT_SCALES,
  ZoomFrame,
  allByTestId,
  byTestId,
  hasNoHorizontalOverflow,
  rectOf,
  settle
} from '@test/helpers/mobile-layout'

afterEach(cleanup)

/**
 * Within `outer` across: the panel sits above its footer and scrolls its rows,
 * so only the horizontal extent is the question here.
 */
function insideX(inner: Element, outer: Element): boolean {
  const a = rectOf(inner)
  const b = rectOf(outer)
  return a.left >= b.left - 0.5 && a.right <= b.right + 0.5
}

const INSTALLS: HarnessInstallProgress[] = [
  {
    id: 'opencode',
    version: '2.5.0',
    phase: 'downloading',
    receivedBytes: 14_890_000,
    totalBytes: 24_010_000
  },
  { id: 'pi', version: '0.72.1', phase: 'failed', reason: 'Download stalled: no data for 30 s.' }
]

const STATES: Array<[string, AppUpdateView, HarnessInstallProgress[]]> = [
  ['A · release', stagedView(), []],
  ['C · local build', localView(), INSTALLS.slice(1)],
  ['D · working', buildingView(), INSTALLS]
]

function props(
  view: AppUpdateView,
  installs: HarnessInstallProgress[],
  narrow: boolean
): UpdatesPanelViewProps {
  const noop = vi.fn()
  return {
    narrow,
    writable: true,
    now: Date.parse(CHECKED) + 102_000,
    checking: false,
    working: false,
    checkedAt: CHECKED,
    app: appSection(view, { later: {} }),
    trees: TREES,
    rebuildIntent: false,
    busy: null,
    confirm: null,
    harnessRows: harnessUpdateRows({
      updates: harnessView(),
      installs,
      dismissed: new Set(),
      completed: [],
      started: {},
      later: {}
    }),
    installRows: [],
    harnessMode: 'ask',
    version: view.current.version,
    canRelaunch: true,
    errors: [],
    onCheck: noop,
    onSettings: noop,
    onRelaunch: noop,
    onConfirm: noop,
    onCancelConfirm: noop,
    appActions: {
      onDownload: noop,
      onRestartUpdate: noop,
      onUpdateAndRestart: noop,
      onRebuild: noop,
      onCancelRebuild: noop,
      onRelaunchBuilt: noop,
      onLater: noop,
      onSkip: noop
    },
    harnessActions: {
      onUpdate: noop,
      onLater: noop,
      onSkip: noop,
      onCancel: noop,
      onDismiss: noop,
      onInstallCancel: noop,
      onInstallDismiss: noop
    }
  }
}

/** The footer the panel anchors to: `relative`, at the bottom of a tall column. */
function Footer({
  width,
  children
}: {
  width: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={{ width, paddingTop: 640 }}>
      <div data-testid="Footer" className="relative" style={{ height: 40 }}>
        {children}
      </div>
    </div>
  )
}

describe('in the phone drawer', () => {
  for (const scale of FONT_SCALES) {
    for (const [label, view, installs] of STATES) {
      it(`${label} fits a 360 px container at uiFontScale ${scale}`, async () => {
        const { container } = render(
          <ZoomFrame scale={scale} width="100%">
            <Footer width={360}>
              <UpdatesPanelView {...props(view, installs, true)} />
            </Footer>
          </ZoomFrame>
        )
        await settle()
        const panel = byTestId(container, 'UpdatesPanel')
        const footer = byTestId(container, 'Footer')
        expect(insideX(panel, footer), 'the panel stays inside the drawer').toBe(true)
        expect(hasNoHorizontalOverflow(panel)).toBe(true)
        for (const el of panel.querySelectorAll('*')) {
          if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'hidden') {
            // Truncating text (an ellipsis) is allowed; anything else spilling sideways is not.
            expect(getComputedStyle(el).textOverflow, el.outerHTML.slice(0, 120)).toBe('ellipsis')
          }
        }
        for (const line of allByTestId(panel, 'UpdatesPanel.versions')) {
          expect(hasNoHorizontalOverflow(line), line.textContent ?? '').toBe(true)
          expect(insideX(line, panel)).toBe(true)
        }
      })
    }
  }
})

describe('on the desktop', () => {
  for (const [label, view, installs] of STATES) {
    it(`${label}: 344 px wide, overlapping past the sidebar, no version line truncated`, async () => {
      const { container } = render(
        <div style={{ width: 860 }}>
          <Footer width={240}>
            <UpdatesPanelView {...props(view, installs, false)} />
          </Footer>
        </div>
      )
      await settle()
      const panel = byTestId(container, 'UpdatesPanel')
      expect(Math.round(rectOf(panel).width)).toBe(344)
      // Wider than the 240 px sidebar: it overlaps the chat area.
      expect(rectOf(panel).right).toBeGreaterThan(rectOf(byTestId(container, 'Footer')).right)
      expect(hasNoHorizontalOverflow(panel)).toBe(true)
      const lines = allByTestId(panel, 'UpdatesPanel.versions')
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(hasNoHorizontalOverflow(line), line.textContent ?? '').toBe(true)
        expect(insideX(line, panel)).toBe(true)
      }
    })
  }
})
