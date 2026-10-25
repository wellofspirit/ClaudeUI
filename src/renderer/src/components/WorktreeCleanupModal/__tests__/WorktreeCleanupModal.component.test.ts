/**
 * Layer 2: Component tests for WorktreeCleanupModal FC.
 *
 * Tested flows:
 *   1. fetches getWorktreeStatus on mount (with the unique-commit count)
 *   2. onRemove calls removeWorktree; only a `removed` result closes the flow (parent onRemove)
 *   3. a refused / partial / failed removal stays in the modal and says why (C-B3); Retry asks again
 *   4. onKeep + onCancel fire parent callbacks without IPC
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { WorktreeCleanupModalViewProps } from '../View'
import type {
  WorktreeInfo,
  WorktreeRemoveResult,
  WorktreeStatus
} from '../../../../../shared/types'

let viewProps: WorktreeCleanupModalViewProps
vi.mock('../View', () => ({
  WorktreeCleanupModalView: (props: WorktreeCleanupModalViewProps) => {
    viewProps = props
    return null
  }
}))

const WT_ID = '/d/repo/.claude/worktrees/feat-x'

function makeWorktreeInfo(): WorktreeInfo {
  return {
    worktreeName: 'feat-x',
    worktreePath: WT_ID,
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
  let removeResult: WorktreeRemoveResult | Error

  beforeEach(async () => {
    app = await bootTestApp()
    onKeep = vi.fn()
    onRemove = vi.fn()
    onCancel = vi.fn()
    removeCalls = 0
    removeResult = { id: WT_ID, outcome: 'removed' }

    app.bridge.ipcMain.handle('worktree:status', async () => ({
      ok: true,
      data: {
        uncommittedFiles: 2,
        commitsAhead: 1,
        uniqueCommits: 1,
        branch: 'feat/x',
        files: []
      } as WorktreeStatus
    }))
    app.bridge.ipcMain.handle('worktree:remove', async () => {
      removeCalls++
      if (removeResult instanceof Error) return { ok: false, error: removeResult.message }
      return { ok: true, data: removeResult }
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
    expect(viewProps.status?.uniqueCommits).toBe(1)
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

  it('a refusal keeps the modal open with the holder named; Retry asks again', async () => {
    removeResult = { id: WT_ID, outcome: 'refused', reason: 'in-use: Fix bug' }
    await renderFC()
    await act(async () => {
      await viewProps.onRemove()
    })

    expect(onRemove).not.toHaveBeenCalled()
    expect(viewProps.outcome).toMatchObject({ tone: 'warn', text: 'Refused: in use by Fix bug.' })
    expect(viewProps.removing).toBe(false)

    removeResult = { id: WT_ID, outcome: 'removed' }
    await act(async () => {
      await viewProps.onRemove()
    })
    expect(removeCalls).toBe(2)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('a partial removal is surfaced, not treated as success', async () => {
    removeResult = {
      id: WT_ID,
      outcome: 'partial',
      failures: [{ path: 'C:/wt/a.bin', code: 'EBUSY' }]
    }
    await renderFC()
    await act(async () => {
      await viewProps.onRemove()
    })

    expect(onRemove).not.toHaveBeenCalled()
    expect(viewProps.outcome?.text).toContain('could not be deleted')
    expect(viewProps.outcome?.paths).toEqual(['C:/wt/a.bin (EBUSY)'])
  })

  it('a thrown removal shows the error instead of closing silently', async () => {
    removeResult = new Error('not a worktree')
    await renderFC()
    await act(async () => {
      await viewProps.onRemove()
    })

    expect(onRemove).not.toHaveBeenCalled()
    expect(viewProps.outcome).toMatchObject({ tone: 'error' })
    expect(viewProps.outcome?.text).toContain('not a worktree')
    expect(viewProps.removing).toBe(false)
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
