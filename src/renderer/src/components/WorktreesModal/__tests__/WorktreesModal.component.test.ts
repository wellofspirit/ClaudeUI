/**
 * Layer 2: Component tests for WorktreesModal FC.
 *
 * Tested flows:
 *   1. listWorktrees on mount, getWorktreeStatus fan-out
 *   2. onRemove → removeWorktree IPC + removes from list
 *   3. Escape key closes
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { WorktreesModalViewProps } from '../View'
import type { WorktreeEntry, WorktreeStatus } from '../../../../../shared/types'

let viewProps: WorktreesModalViewProps
vi.mock('../View', () => ({
  WorktreesModalView: (props: WorktreesModalViewProps) => {
    viewProps = props
    return null
  },
}))

function makeEntry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    name: 'feat-x',
    path: '/d/repo/.claude/worktrees/feat-x',
    branch: 'feat/x',
    exists: true,
    ...overrides,
  } as WorktreeEntry
}

describe('WorktreesModal FC', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn>
  let removeCalls: Array<{ worktreePath: string; branch: string; gitRoot: string }>

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn()
    removeCalls = []

    app.bridge.ipcMain.handle('worktree:list', async (): Promise<{ ok: true; data: WorktreeEntry[] }> => ({
      ok: true,
      data: [makeEntry(), makeEntry({ name: 'feat-y', path: '/d/repo/.claude/worktrees/feat-y', branch: 'feat/y' })],
    }))
    app.bridge.ipcMain.handle('worktree:status', async (): Promise<{ ok: true; data: WorktreeStatus }> => ({
      ok: true,
      data: { uncommittedFiles: 0, commitsAhead: 0, commitsBehind: 0, originalHead: '', files: [] } as unknown as WorktreeStatus,
    }))
    app.bridge.ipcMain.handle('worktree:remove', async (_e, worktreePath: string, branch: string, gitRoot: string) => {
      removeCalls.push({ worktreePath, branch, gitRoot })
      return { ok: true, data: undefined }
    })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(): Promise<void> {
    const { WorktreesModal } = await import('../WorktreesModal')
    await act(async () => {
      render(React.createElement(WorktreesModal, { cwd: '/d/repo', onClose: onClose as () => void }))
    })
  }

  it('fetches worktrees on mount', async () => {
    await renderFC()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(viewProps.loading).toBe(false)
    expect(viewProps.entries).toHaveLength(2)
  })

  it('onRemove calls removeWorktree IPC and removes from list', async () => {
    await renderFC()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    await act(async () => {
      await viewProps.onRemove(viewProps.entries[0])
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(removeCalls).toHaveLength(1)
    expect(removeCalls[0].branch).toBe('feat/x')
    expect(viewProps.entries).toHaveLength(1)
  })

  it('Escape key closes the modal', async () => {
    await renderFC()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(onClose).toHaveBeenCalled()
  })
})
