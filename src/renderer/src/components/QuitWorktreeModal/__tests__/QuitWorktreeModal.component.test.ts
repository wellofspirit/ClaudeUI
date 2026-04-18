/**
 * Layer 2: Component tests for QuitWorktreeModal FC.
 *
 * Tested flows:
 *   1. renders null when no quit worktrees
 *   2. onCancel clears quitWorktrees
 *   3. onKeepAll clears + confirmQuit
 *   4. onRemoveAll removes each worktree + confirmQuit
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  },
}))

function makeWorktreeInfo(name: string): WorktreeInfo {
  return {
    worktreeName: name,
    worktreePath: `/d/repo/.claude/worktrees/${name}`,
    worktreeBranch: `feat/${name}`,
    gitRoot: '/d/repo',
  } as WorktreeInfo
}

describe('QuitWorktreeModal FC', () => {
  let app: TestApp
  let confirmQuitCalls: number
  let removeCalls: number

  beforeEach(async () => {
    app = await bootTestApp()
    viewProps = null
    confirmQuitCalls = 0
    removeCalls = 0

    app.bridge.ipcMain.handle('app:quit-confirm', async () => { confirmQuitCalls++ })
    app.bridge.ipcMain.handle('worktree:remove', async () => { removeCalls++; return { ok: true, data: undefined } })

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

  it('onCancel clears quitWorktrees in the store', async () => {
    useSessionStore.setState({ quitWorktrees: [{ routingId: 'r1', worktreeInfo: makeWorktreeInfo('wt1') }] })
    await renderFC()

    act(() => { viewProps!.onCancel() })

    expect(useSessionStore.getState().quitWorktrees).toBeNull()
  })

  it('onKeepAll clears state and calls confirmQuit', async () => {
    useSessionStore.setState({ quitWorktrees: [{ routingId: 'r1', worktreeInfo: makeWorktreeInfo('wt1') }] })
    await renderFC()

    act(() => { viewProps!.onKeepAll() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(confirmQuitCalls).toBe(1)
    expect(useSessionStore.getState().quitWorktrees).toBeNull()
  })

  it('onRemoveAll removes each worktree and calls confirmQuit', async () => {
    useSessionStore.setState({
      quitWorktrees: [
        { routingId: 'r1', worktreeInfo: makeWorktreeInfo('wt1') },
        { routingId: 'r2', worktreeInfo: makeWorktreeInfo('wt2') },
      ],
    })
    await renderFC()

    await act(async () => {
      await viewProps!.onRemoveAll()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(removeCalls).toBe(2)
    expect(confirmQuitCalls).toBe(1)
    expect(useSessionStore.getState().quitWorktrees).toBeNull()
  })
})
