/**
 * Layer 2: Component tests for the mobile permissions UI (viewport ≤768px).
 *
 * The container is shared with desktop — only the presentation forks — so what
 * these tests pin is the mobile contract that makes it usable under a soft
 * keyboard:
 *
 *   • the BROWSE layer contains zero text inputs. This is the load-bearing
 *     invariant: `interactive-widget=resizes-content` shrinks the layout
 *     viewport on Android but iOS ignores it and overlays the keyboard, so an
 *     inline input anywhere in a scrolling list is unreachable on one platform
 *     or the other. Editing happens only in the top-anchored entry sheet.
 *   • add / edit / delete and Save all route through the same props the desktop
 *     view uses, so nothing about persistence forks.
 *
 * Rendered through the real PermissionsDialog container (not the View in
 * isolation) so the fork itself — useIsMobile picking MobileView — is covered.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { ClaudePermissions, PermissionScope } from '../../../../../shared/types'

let mockIsMobile = true
vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile,
  useVisualViewportHeight: () => undefined
}))

const CWD = '/d/repo-perms-mobile'

function makePerms(overrides: Partial<ClaudePermissions> = {}): ClaudePermissions {
  return {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined,
    ...overrides
  }
}

describe('PermissionsDialog — mobile view', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn>
  let saveCalls: Array<{ scope: PermissionScope; perms: ClaudePermissions }>
  let loaded: Record<PermissionScope, ClaudePermissions>

  beforeEach(async () => {
    mockIsMobile = true
    onClose = vi.fn()
    saveCalls = []
    loaded = {
      user: makePerms({ allow: ['Bash(git:*)'] }),
      project: makePerms(),
      local: makePerms({ deny: ['Bash(rm -rf:*)'], additionalDirectories: ['/d/other'] })
    }

    app = await bootTestApp()
    app.bridge.ipcMain.handle(
      'claude:load-permissions',
      async (_e, scope: PermissionScope) => loaded[scope]
    )
    app.bridge.ipcMain.handle(
      'claude:save-permissions',
      async (_e, scope: PermissionScope, perms: ClaudePermissions) => {
        saveCalls.push({ scope, perms })
      }
    )
    app.bridge.ipcMain.handle('claude:workspace-trust' as never, async () => true)
    app.bridge.ipcMain.handle('file:list-dir' as never, async (_e, path: string) => ({
      path,
      entries: [
        { name: 'src', isDirectory: true },
        { name: 'docs', isDirectory: true },
        { name: 'README.md', isDirectory: false }
      ],
      isRoot: false
    }))
  })

  afterEach(() => {
    cleanup()
    app.teardown()
  })

  async function mount(initialTab: PermissionScope = 'local'): Promise<void> {
    const { PermissionsDialog } = await import('../PermissionsDialog')
    await act(async () => {
      render(
        React.createElement(PermissionsDialog, {
          open: true,
          cwd: CWD,
          initialTab,
          onClose: onClose as () => void
        })
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  const addButton = (category: string): HTMLElement =>
    screen
      .getAllByTestId('PermissionsDialog.mobileAdd')
      .find((b) => b.dataset.category === category)!

  const ruleRows = (category: string): HTMLElement[] =>
    screen
      .queryAllByTestId('PermissionsDialog.mobileRule')
      .filter((r) => r.dataset.category === category)

  it('renders a browse layer with no text inputs anywhere', async () => {
    await mount()

    expect(screen.getByTestId('PermissionsDialog')).toBeInTheDocument()
    expect(screen.queryByTestId('PermissionsDialog.entrySheet')).toBeNull()
    expect(document.querySelectorAll('input')).toHaveLength(0)
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
    // All four sections have a + affordance instead.
    expect(screen.getAllByTestId('PermissionsDialog.mobileAdd')).toHaveLength(4)
    // Existing local-scope rules are listed.
    expect(ruleRows('deny')[0]).toHaveTextContent('Bash(rm -rf:*)')
    expect(ruleRows('dir')[0]).toHaveTextContent('/d/other')
  })

  it('＋(allow) opens the entry sheet; typing + Add appends the rule', async () => {
    await mount()

    await act(async () => {
      addButton('allow').click()
    })

    const sheet = screen.getByTestId('PermissionsDialog.entrySheet')
    expect(sheet).toHaveTextContent('Add Allow rule')
    expect(sheet).toHaveTextContent('Local')
    // Exactly one input, and it is the sheet's.
    const inputs = document.querySelectorAll('input')
    expect(inputs).toHaveLength(1)
    // Empty value can't be committed.
    expect(screen.getByTestId('PermissionsDialog.sheetConfirm')).toBeDisabled()

    await act(async () => {
      fireEvent.change(inputs[0], { target: { value: 'Edit(src/**)' } })
    })
    await act(async () => {
      screen.getByTestId('PermissionsDialog.sheetConfirm').click()
    })

    // Sheet closes back to browse, and the rule shows up in the Allow section.
    expect(screen.queryByTestId('PermissionsDialog.entrySheet')).toBeNull()
    expect(ruleRows('allow').map((r) => r.textContent)).toEqual(['Edit(src/**)'])
  })

  it('a template chip fills the sheet input', async () => {
    await mount()

    await act(async () => {
      addButton('ask').click()
    })

    const chip = screen
      .getAllByTestId('PermissionsDialog.templateChip')
      .find((c) => c.dataset.template === 'WebSearch')!
    await act(async () => {
      chip.click()
    })

    expect(document.querySelector('input')).toHaveValue('WebSearch')
  })

  it('tapping an existing rule opens the sheet pre-filled and Save replaces it', async () => {
    await mount()

    await act(async () => {
      ruleRows('deny')[0].click()
    })

    const sheet = screen.getByTestId('PermissionsDialog.entrySheet')
    expect(sheet).toHaveTextContent('Edit Deny rule')
    const input = document.querySelector('input')!
    expect(input).toHaveValue('Bash(rm -rf:*)')
    expect(screen.getByTestId('PermissionsDialog.sheetConfirm')).toHaveTextContent('Save')

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Bash(rm:*)' } })
    })
    await act(async () => {
      screen.getByTestId('PermissionsDialog.sheetConfirm').click()
    })

    expect(ruleRows('deny').map((r) => r.textContent)).toEqual(['Bash(rm:*)'])
  })

  it('sheet Cancel discards the edit', async () => {
    await mount()

    await act(async () => {
      ruleRows('deny')[0].click()
    })
    await act(async () => {
      fireEvent.change(document.querySelector('input')!, { target: { value: 'clobbered' } })
    })
    await act(async () => {
      screen.getByTestId('PermissionsDialog.sheetCancel').click()
    })

    expect(screen.queryByTestId('PermissionsDialog.entrySheet')).toBeNull()
    expect(ruleRows('deny').map((r) => r.textContent)).toEqual(['Bash(rm -rf:*)'])
  })

  it('delete removes a rule without a confirm (desktop parity)', async () => {
    await mount()

    const del = screen
      .getAllByTestId('PermissionsDialog.mobileDelete')
      .find((b) => b.dataset.category === 'deny')!
    await act(async () => {
      del.click()
    })

    expect(ruleRows('deny')).toHaveLength(0)
  })

  it('the directory sheet drills into listed directories and ✓ commits a full path', async () => {
    await mount()

    await act(async () => {
      addButton('dir').click()
    })
    const input = document.querySelector('input')!
    await act(async () => {
      fireEvent.change(input, { target: { value: '/d/' } })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Only directories, with `..` prepended for a non-root listing.
    const names = screen.getAllByTestId('PermissionsDialog.dirEntry').map((e) => e.dataset.name)
    expect(names).toEqual(['..', 'src', 'docs'])

    // Tapping the row name descends (input only — nothing committed yet).
    await act(async () => {
      screen.getAllByTestId('PermissionsDialog.dirEntry')[1].click()
    })
    expect(document.querySelector('input')).toHaveValue('/d/src/')
    expect(screen.getByTestId('PermissionsDialog.entrySheet')).toBeInTheDocument()

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // ✓ on a row commits that directory and closes the sheet.
    const select = screen
      .getAllByTestId('PermissionsDialog.dirEntrySelect')
      .find((b) => b.dataset.name === 'docs')!
    await act(async () => {
      select.click()
    })

    expect(screen.queryByTestId('PermissionsDialog.entrySheet')).toBeNull()
    expect(ruleRows('dir').map((r) => r.textContent)).toEqual(['/d/other', '/d/src/docs'])
  })

  it('footer Save persists the dirty scope', async () => {
    await mount()

    await act(async () => {
      addButton('allow').click()
    })
    await act(async () => {
      fireEvent.change(document.querySelector('input')!, { target: { value: 'Read' } })
    })
    await act(async () => {
      screen.getByTestId('PermissionsDialog.sheetConfirm').click()
    })

    await act(async () => {
      screen.getByTestId('PermissionsDialog.save').click()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(saveCalls).toHaveLength(1)
    expect(saveCalls[0].scope).toBe('local')
    expect(saveCalls[0].perms.allow).toEqual(['Read'])
  })

  it('close (✕) delegates to the container close handler', async () => {
    await mount()

    await act(async () => {
      screen.getByTestId('PermissionsDialog.close').click()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('desktop still gets the old dialog (regression lock)', async () => {
    mockIsMobile = false
    await mount()

    expect(screen.getByTestId('PermissionsDialog')).toBeInTheDocument()
    // The desktop view keeps its per-section add inputs; the mobile affordances
    // must not appear.
    expect(screen.queryByTestId('PermissionsDialog.mobileAdd')).toBeNull()
    expect(document.querySelectorAll('input').length).toBeGreaterThan(0)
  })
})
