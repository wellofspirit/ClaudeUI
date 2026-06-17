/**
 * Layer 2: Component tests for WorktreeCleanupModal FC.
 *
 * Tested flows:
 *   1. fetches getWorktreeStatus on mount
 *   2. onRemove calls removeWorktree + onRemove callback
 *   3. onKeep + onCancel fire parent callbacks without IPC
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { WorktreeCleanupModalViewProps } from '../View'
import type { WorktreeInfo, WorktreeStatus } from '../../../../../shared/types'

let viewProps: WorktreeCleanupModalViewProps
vi.mock('../View', () => ({
  WorktreeCleanupModalView: (props: WorktreeCleanupModalViewProps) => {
    viewProps = props
    return null
  }
}))

function makeWorktreeInfo(): WorktreeInfo {
  return {
    worktreeName: 'feat-x',
    worktreePath: '/d/repo/.claude/worktrees/feat-x',
    worktreeBranch: 'feat/x',
    gitRoot: '/d/repo',
    originalHeadCommit: 'abc123'
  } as WorktreeInfo
}

describe('WorktreeCleanupModal FC', () => {
  let app: TestApp
  let onKeep: ReturnType<typeof vi.fn>
  let onRemove: ReturnType<typeof vi.fn>
  let onCancel: ReturnType<typeof vi.fn>
  let removeCalls: number

  beforeEach(async () => {
    app = await bootTestApp()
    onKeep = vi.fn()
    onRemove = vi.fn()
    onCancel = vi.fn()
    removeCalls = 0

    app.bridge.ipcMain.handle('worktree:status', async () => ({
      ok: true,
      data: {
        uncommittedFiles: 2,
        commitsAhead: 1,
        commitsBehind: 0,
        originalHead: '',
        files: []
      } as unknown as WorktreeStatus
    }))
    app.bridge.ipcMain.handle('worktree:remove', async () => {
      removeCalls++
      return { ok: true, data: undefined }
    })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(): Promise<void> {
    const { WorktreeCleanupModal } = await import('../WorktreeCleanupModal')
    await act(async () => {
      render(
        React.createElement(WorktreeCleanupModal, {
          worktreeInfo: makeWorktreeInfo(),
          onKeep: onKeep as () => void,
          onRemove: onRemove as () => void,
          onCancel: onCancel as () => void
        })
      )
    })
  }

  it('fetches worktree status on mount', async () => {
    await renderFC()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(viewProps.status?.uncommittedFiles).toBe(2)
  })

  it('onRemove calls removeWorktree IPC then parent onRemove', async () => {
    await renderFC()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    await act(async () => {
      await viewProps.onRemove()
    })

    expect(removeCalls).toBe(1)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('onKeep fires parent callback with no IPC', async () => {
    await renderFC()

    act(() => {
      viewProps.onKeep()
    })

    expect(onKeep).toHaveBeenCalledTimes(1)
    expect(removeCalls).toBe(0)
  })

  it('onCancel fires parent callback', async () => {
    await renderFC()

    act(() => {
      viewProps.onCancel()
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
