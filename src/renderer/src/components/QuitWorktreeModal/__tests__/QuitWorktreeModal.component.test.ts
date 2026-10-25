/**
 * Layer 2: Component tests for QuitWorktreeModal FC.
 *
 * Tested flows:
 *   1. renders null when no quit worktrees
 *   2. onCancel clears quitWorktrees
 *   3. onKeepAll clears + confirmQuit
 *   4. onRemoveAll hands the chosen worktree PATHS to confirmQuit (main removes them after the
 *      teardown, C-S1); the modal itself deletes nothing and no longer clears worktreeInfo
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { QuitWorktreeModalViewProps } from '../View'
import type { WorktreeInfo } from '../../../../../shared/types'

let viewProps: QuitWorktreeModalViewProps | null = null
vi.mock('../View', () => ({
  QuitWorktreeModalView: (props: QuitWorktreeModalViewProps) => {
    viewProps = props
    return null
  }
}))

function makeWorktreeInfo(name: string): WorktreeInfo {
  return {
    worktreeName: name,
    worktreePath: `/d/repo/.claude/worktrees/${name}`,
    worktreeBranch: `feat/${name}`,
    gitRoot: '/d/repo'
  } as WorktreeInfo
}

describe('QuitWorktreeModal FC', () => {
  let app: TestApp
  let confirmQuitCalls: number
  let cancelQuitCalls: number
  let removeCalls: number
  let confirmQuitPaths: string[][]

  beforeEach(async () => {
    app = await bootTestApp()
    viewProps = null
    confirmQuitPaths = []
    confirmQuitCalls = 0
    cancelQuitCalls = 0
    removeCalls = 0

    app.bridge.ipcMain.handle('app:quit-confirm', async (_e, paths: string[]) => {
      confirmQuitCalls++
      confirmQuitPaths.push(paths)
    })
    app.bridge.ipcMain.handle('app:quit-cancel', async () => {
      cancelQuitCalls++
    })
    app.bridge.ipcMain.handle('worktree:remove', async () => {
      removeCalls++
      return { ok: true, data: undefined }
    })

    useSessionStore.setState({ quitWorktrees: null })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(): Promise<void> {
    const { QuitWorktreeModal } = await import('../QuitWorktreeModal')
    await act(async () => {
      render(React.createElement(QuitWorktreeModal))
    })
  }

  it('renders nothing when quitWorktrees is null', async () => {
    await renderFC()
    expect(viewProps).toBeNull()
  })

  it('onCancel aborts the pending quit and clears quitWorktrees in the store', async () => {
    useSessionStore.setState({
      quitWorktrees: [{ routingId: 'r1', worktreeInfo: makeWorktreeInfo('wt1') }]
    })
    await renderFC()

    act(() => {
      viewProps!.onCancel()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Cancel must reach main (clear the fallback timer) and must NOT confirm quit.
    expect(cancelQuitCalls).toBe(1)
    expect(confirmQuitCalls).toBe(0)
    expect(useSessionStore.getState().quitWorktrees).toBeNull()
  })

  it('onKeepAll clears state and calls confirmQuit', async () => {
    useSessionStore.setState({
      quitWorktrees: [{ routingId: 'r1', worktreeInfo: makeWorktreeInfo('wt1') }]
    })
    await renderFC()

    act(() => {
      viewProps!.onKeepAll()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(confirmQuitCalls).toBe(1)
    expect(useSessionStore.getState().quitWorktrees).toBeNull()
  })

  it('onRemoveAll hands the worktree paths to confirmQuit and deletes nothing itself', async () => {
    useSessionStore.setState({
      quitWorktrees: [
        { routingId: 'r1', worktreeInfo: makeWorktreeInfo('wt1') },
        { routingId: 'r2', worktreeInfo: makeWorktreeInfo('wt2') }
      ],
      worktreeInfoMap: {
        r1: makeWorktreeInfo('wt1'),
        r2: makeWorktreeInfo('wt2')
      }
    })
    await renderFC()

    await act(async () => {
      viewProps!.onRemoveAll()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(confirmQuitCalls).toBe(1)
    expect(confirmQuitPaths).toEqual([
      ['/d/repo/.claude/worktrees/wt1', '/d/repo/.claude/worktrees/wt2']
    ])
    // main removes after teardown; the renderer neither removes nor saves a trimmed map
    expect(removeCalls).toBe(0)
    expect(Object.keys(useSessionStore.getState().worktreeInfoMap)).toEqual(['r1', 'r2'])
    // the modal stays up, busy, until the window closes
    expect(useSessionStore.getState().quitWorktrees).toHaveLength(2)
    expect(viewProps!.removing).toBe(true)
  })

  it('two sessions in one worktree send its path once', async () => {
    useSessionStore.setState({
      quitWorktrees: [
        { routingId: 'r1', worktreeInfo: makeWorktreeInfo('wt1') },
        { routingId: 'r2', worktreeInfo: makeWorktreeInfo('wt1') }
      ]
    })
    await renderFC()
    await act(async () => {
      viewProps!.onRemoveAll()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(confirmQuitPaths).toEqual([['/d/repo/.claude/worktrees/wt1']])
  })

  it('Keep all sends no paths', async () => {
    useSessionStore.setState({
      quitWorktrees: [{ routingId: 'r1', worktreeInfo: makeWorktreeInfo('wt1') }]
    })
    await renderFC()
    await act(async () => {
      viewProps!.onKeepAll()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(confirmQuitPaths).toEqual([[]])
  })

  it('stays busy once main has the confirmation, even if a before-quit event arrives: the app is exiting', async () => {
    useSessionStore.setState({
      quitWorktrees: [{ routingId: 'r1', worktreeInfo: makeWorktreeInfo('wt1') }]
    })
    await renderFC()
    await act(async () => {
      viewProps!.onRemoveAll()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(viewProps!.removing).toBe(true)

    // main does not ask again after a confirmation; were a before-quit to arrive, the modal
    // must not re-arm the buttons while main deletes the folders
    await act(async () => {
      app.emit('app:before-quit')
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(viewProps!.removing).toBe(true)
  })
})
