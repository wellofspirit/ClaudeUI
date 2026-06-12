/**
 * Layer 2: Component tests for SkillsDialog FC.
 *
 * Tested flows:
 *   1. renders null when not open
 *   2. loadSkillDetails IPC on open → populates View
 *   3. Escape key closes dialog
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { SkillsDialogViewProps } from '../View'
import type { SkillInfo } from '../../../../../shared/types'

let viewProps: SkillsDialogViewProps | null = null
vi.mock('../View', () => ({
  SkillsDialogView: (props: SkillsDialogViewProps) => {
    viewProps = props
    return null
  }
}))

function makeSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: 'test-skill',
    displayName: 'Test Skill',
    description: 'A skill for testing',
    source: 'project',
    path: '.claude/skills/test-skill',
    content: '# Test',
    ...overrides
  } as SkillInfo
}

describe('SkillsDialog FC', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn>
  let loadCalls: string[]

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn()
    loadCalls = []
    viewProps = null

    app.bridge.ipcMain.handle('config:load-skill-details', async (_e, cwd: string) => {
      loadCalls.push(cwd)
      return [makeSkill()]
    })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(props: { open: boolean; cwd: string | null }): Promise<void> {
    const { SkillsDialog } = await import('../SkillsDialog')
    await act(async () => {
      render(React.createElement(SkillsDialog, { ...props, onClose: onClose as () => void }))
    })
  }

  it('renders nothing when not open', async () => {
    await renderFC({ open: false, cwd: '/d/repo' })
    expect(viewProps).toBeNull()
  })

  it('loads skills via IPC and passes them to View', async () => {
    await renderFC({ open: true, cwd: '/d/repo' })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(loadCalls).toEqual(['/d/repo'])
    expect(viewProps?.skills).toHaveLength(1)
    expect(viewProps?.loading).toBe(false)
  })

  it('Escape key closes the dialog', async () => {
    await renderFC({ open: true, cwd: '/d/repo' })

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(onClose).toHaveBeenCalled()
  })

  it('does not call IPC when cwd is null', async () => {
    await renderFC({ open: true, cwd: null })

    expect(loadCalls).toHaveLength(0)
  })

  it('clears stale skills before loading a new cwd on reopen', async () => {
    // Setup: different skill lists per cwd so we can detect leakage
    app.bridge.ipcMain.handle('config:load-skill-details', async (_e, cwd: string) => {
      loadCalls.push(cwd)
      if (cwd === '/a') return [makeSkill({ name: 'skill-a', displayName: 'A' })]
      if (cwd === '/b') return [makeSkill({ name: 'skill-b', displayName: 'B' })]
      return []
    })

    const { SkillsDialog } = await import('../SkillsDialog')
    const onClose = vi.fn()

    // Open with /a — View sees skill-a
    const { rerender, unmount } = await act(async () =>
      render(
        React.createElement(SkillsDialog, { open: true, cwd: '/a', onClose: onClose as () => void })
      )
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(viewProps?.skills.map((s) => s.name)).toEqual(['skill-a'])

    // Close — FC should clear skills immediately
    await act(async () =>
      rerender(
        React.createElement(SkillsDialog, {
          open: false,
          cwd: '/a',
          onClose: onClose as () => void
        })
      )
    )

    // Reopen with /b — before IPC resolves, skills must NOT still be ['skill-a']
    let resolveLoad!: (v: unknown) => void
    const pendingLoad = new Promise((r) => {
      resolveLoad = r
    })
    app.bridge.ipcMain.handle('config:load-skill-details', () => pendingLoad)

    await act(async () =>
      rerender(
        React.createElement(SkillsDialog, { open: true, cwd: '/b', onClose: onClose as () => void })
      )
    )

    // At this point, stale skills must be cleared (view shows loading, not skill-a)
    expect(viewProps?.skills).toEqual([])

    await act(async () => {
      resolveLoad([makeSkill({ name: 'skill-b', displayName: 'B' })])
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(viewProps?.skills.map((s) => s.name)).toEqual(['skill-b'])

    unmount()
  })
})
