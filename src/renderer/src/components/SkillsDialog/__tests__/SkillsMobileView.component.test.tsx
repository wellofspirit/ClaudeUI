/**
 * Layer 2: the mobile Skills fork (viewport ≤768px).
 *
 * Drives the REAL container (`SkillsDialog`) so the assertion is both "which
 * presentation did it pick" and "how does that presentation behave". The
 * desktop half is asserted too — a fork that quietly changes desktop is the
 * failure mode this guards.
 *
 * `useIsMobile` reads `window.matchMedia`, which the jsdom setup stubs as
 * never-matching; each block installs its own stub for the breakpoint it needs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { SkillsDialog } from '../SkillsDialog'
import type { SkillInfo } from '../../../../../shared/types'

const CWD = '/d/repo'

const originalMatchMedia = window.matchMedia
const originalInnerWidth = window.innerWidth

function setViewportIsMobile(isMobile: boolean): void {
  // `useIsMobile` seeds its state from innerWidth and only then subscribes to
  // the media query, so BOTH have to say the same thing.
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: isMobile ? 390 : 1280
  })
  window.matchMedia = ((query: string) => ({
    matches: isMobile && query.includes('max-width: 768px'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

function makeSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: 'alpha',
    displayName: 'Alpha',
    description: 'The first skill',
    source: 'project',
    path: '/d/repo/.claude/skills/alpha/SKILL.md',
    content: '# Alpha body',
    ...overrides
  }
}

const SKILLS: SkillInfo[] = [
  makeSkill(),
  makeSkill({
    name: 'beta',
    displayName: 'Beta',
    description: 'The second skill',
    source: 'user',
    path: '~/.claude/skills/beta/SKILL.md',
    content: '# Beta body'
  })
]

describe('SkillsDialog mobile fork', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn<() => void>>

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn<() => void>()
    app.bridge.ipcMain.handle('config:load-skill-details', async () => SKILLS)
  })

  afterEach(() => {
    cleanup()
    app.teardown()
    window.matchMedia = originalMatchMedia
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth
    })
  })

  async function renderDialog(): Promise<void> {
    await act(async () => {
      render(<SkillsDialog open cwd={CWD} onClose={onClose} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  // ── fork guard ────────────────────────────────────────────────────────────

  it('renders the mobile view at ≤768px', async () => {
    setViewportIsMobile(true)
    await renderDialog()

    expect(screen.getByTestId('SkillsMobileView')).toBeInTheDocument()
    expect(screen.queryByTestId('SkillsDialog')).not.toBeInTheDocument()
  })

  it('renders the untouched desktop view above 768px', async () => {
    setViewportIsMobile(false)
    await renderDialog()

    expect(screen.getByTestId('SkillsDialog')).toBeInTheDocument()
    expect(screen.queryByTestId('SkillsMobileView')).not.toBeInTheDocument()
    // Desktop keeps its list column + auto-selected preview.
    expect(screen.getAllByTestId('SkillsDialog.skillRow')).toHaveLength(2)
    expect(screen.getByTestId('SkillsDialog.filter')).toBeInTheDocument()
  })

  describe('on mobile', () => {
    beforeEach(() => setViewportIsMobile(true))

    it('lands on the list — no auto-selected skill', async () => {
      await renderDialog()

      expect(screen.getAllByTestId('SkillsMobileView.row').map((r) => r.dataset.id)).toEqual([
        'alpha',
        'beta'
      ])
      // Desktop auto-selects the first skill; a phone must not open on a
      // preview nobody asked for.
      expect(screen.queryByTestId('SkillsMobileView.detail')).not.toBeInTheDocument()
    })

    it('a row tap opens the detail screen; back returns to the list', async () => {
      await renderDialog()

      await act(async () => {
        fireEvent.click(
          screen.getAllByTestId('SkillsMobileView.row').find((r) => r.dataset.id === 'beta')!
        )
      })

      const detail = screen.getByTestId('SkillsMobileView.detail')
      expect(detail).toHaveAttribute('data-id', 'beta')
      // Full read-only detail: description, path and the rendered body.
      expect(detail.textContent).toContain('The second skill')
      expect(detail.textContent).toContain('~/.claude/skills/beta/SKILL.md')
      expect(detail.textContent).toContain('Beta body')

      await act(async () => {
        fireEvent.click(screen.getByTestId('SkillsMobileView.back'))
      })

      expect(screen.queryByTestId('SkillsMobileView.detail')).not.toBeInTheDocument()
      expect(screen.getAllByTestId('SkillsMobileView.row')).toHaveLength(2)
    })

    it('the filter narrows the list and says so when nothing matches', async () => {
      await renderDialog()
      const input = screen.getByTestId('SkillsMobileView.filter')

      await act(async () => {
        fireEvent.change(input, { target: { value: 'second' } })
      })
      expect(screen.getAllByTestId('SkillsMobileView.row').map((r) => r.dataset.id)).toEqual([
        'beta'
      ])

      await act(async () => {
        fireEvent.change(input, { target: { value: 'zzzznotaskill' } })
      })
      expect(screen.queryAllByTestId('SkillsMobileView.row')).toHaveLength(0)
      expect(screen.getByTestId('SkillsMobileView').textContent).toContain('No matching skills')
    })

    it('does NOT autofocus the filter (a soft keyboard would eat the screen)', async () => {
      await renderDialog()
      expect(screen.getByTestId('SkillsMobileView.filter')).not.toHaveFocus()
    })

    it('the header close button calls onClose from either screen', async () => {
      await renderDialog()

      fireEvent.click(screen.getByTestId('SkillsMobileView.close'))
      expect(onClose).toHaveBeenCalledTimes(1)

      await act(async () => {
        fireEvent.click(screen.getAllByTestId('SkillsMobileView.row')[0])
      })
      fireEvent.click(screen.getByTestId('SkillsMobileView.close'))
      expect(onClose).toHaveBeenCalledTimes(2)
    })
  })
})
