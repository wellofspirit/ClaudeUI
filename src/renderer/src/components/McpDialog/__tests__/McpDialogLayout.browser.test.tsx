/**
 * Layer 2b: a desktop dialog inside SessionView's zoom (ADR-092) — real Chromium,
 * real Tailwind, a SMALL desktop window (1280x640), under `zoom: uiFontScale`.
 *
 * The MCP dialog sized itself `maxHeight: 85vh`. Inside the zoomed root that
 * length is multiplied by the scale: 85vh x 1.25 is 106% of a 640px window, so
 * the header and the footer's Close button landed off-screen. It stands for the
 * whole class (Skills, Permissions, Remote access, provider editor, sign-in,
 * mobile config sheet), which all moved to a percentage of their backdrop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { page } from 'vitest/browser'
import { PROFILE, ZoomFrame, byTestId, rectOf, settle } from '@test/helpers/mobile-layout'
import { McpDialogView, type McpDialogViewProps } from '../View'

const WINDOW = { width: 1280, height: 640 }

function props(): McpDialogViewProps {
  const noop = async (): Promise<void> => {}
  return {
    servers: [],
    filteredServers: [],
    groups: [],
    loading: false,
    selected: null,
    selectedServer: null,
    filter: '',
    showAddForm: false,
    actionLoading: null,
    hasRoutingId: true,
    hasCwd: true,
    onSelect: () => {},
    onChangeFilter: () => {},
    onOpenAddForm: () => {},
    onCancelAddForm: () => {},
    onSubmitAddForm: noop,
    onToggleServer: noop,
    onReconnectServer: noop,
    onDeleteServer: noop,
    onClose: () => {}
  }
}

describe('MCP dialog in a 1280x640 window', () => {
  beforeEach(async () => {
    await page.viewport(WINDOW.width, WINDOW.height)
  })
  afterEach(async () => {
    cleanup()
    // The other browser tests are written for the phone.
    await page.viewport(PROFILE.width, PROFILE.height)
  })

  for (const scale of [1, 1.25, 1.5]) {
    it(`keeps the whole dialog, its header and its footer on screen at uiFontScale ${scale}`, async () => {
      const view = render(
        <ZoomFrame scale={scale}>
          <McpDialogView {...props()} />
        </ZoomFrame>
      )
      await settle()
      expect(window.innerWidth).toBe(WINDOW.width)
      expect(window.innerHeight).toBe(WINDOW.height)

      const backdrop = byTestId(view.container, 'McpDialog')
      const panel = backdrop.firstElementChild as HTMLElement
      const panelRect = rectOf(panel)
      expect(panelRect.top).toBeGreaterThanOrEqual(0)
      expect(panelRect.bottom).toBeLessThanOrEqual(window.innerHeight)
      expect(panelRect.left).toBeGreaterThanOrEqual(0)
      expect(panelRect.right).toBeLessThanOrEqual(window.innerWidth)

      // The controls that went off-window: the header's close and the footer's.
      for (const id of ['McpDialog.close', 'McpDialog.closeFooter']) {
        const r = rectOf(byTestId(panel, id))
        expect(r.top).toBeGreaterThanOrEqual(0)
        expect(r.bottom).toBeLessThanOrEqual(window.innerHeight)
        expect(r.right).toBeLessThanOrEqual(window.innerWidth)
      }

      // Readable, not merely contained: the dialog still uses most of the window
      // (it is capped at 85% of it, not collapsed to something tiny).
      expect(panelRect.height).toBeGreaterThanOrEqual(window.innerHeight * 0.8)
    })
  }
})
