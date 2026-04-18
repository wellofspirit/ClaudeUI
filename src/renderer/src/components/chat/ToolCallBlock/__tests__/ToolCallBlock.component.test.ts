/**
 * Layer 2: Component tests for ToolCallBlock FC.
 *
 * The FC lifts approval / background / stop / open-panel handlers from the
 * monolith and hands them to <ToolCallBlockView>. We mock the View to capture
 * props and verify the IPC + store side effects.
 *
 * Tested flows:
 *   1. onApproval('allow') → respondApproval IPC + removePendingApproval
 *   2. onApproval('deny') → respondApproval IPC + removePendingApproval
 *   3. onApproval forwards selected permission suggestions
 *   4. onBackgroundTask → backgroundTask IPC
 *   5. onStopTask → stopTask IPC + setTaskStopping
 *   6. onOpenTaskPanel → openTaskPanel store action
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { makePendingApproval } from '@test/factories/messages'
import type { ToolCallBlockViewProps } from '../View'
import type { ContentBlock, PermissionSuggestion } from '../../../../../../shared/types'

let viewProps: ToolCallBlockViewProps
vi.mock('../View', () => ({
  ToolCallBlockView: (props: ToolCallBlockViewProps) => {
    viewProps = props
    return null
  },
}))

const ROUTE = 'route-tool-block'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

function makeToolUseBlock(overrides: Partial<ToolUseBlock> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    toolUseId: 'tu-1',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    ...overrides,
  } as ToolUseBlock
}

describe('ToolCallBlock FC', () => {
  let app: TestApp
  let respondCalls: Array<{ routingId: string; requestId: string; decision: string; answers: unknown; permissions: unknown }>
  let backgroundCalls: Array<{ routingId: string; toolUseId: string }>
  let stopCalls: Array<{ routingId: string; toolUseId: string }>

  beforeEach(async () => {
    app = await bootTestApp()
    respondCalls = []
    backgroundCalls = []
    stopCalls = []

    app.bridge.ipcMain.handle('session:approval-response', async (_e, routingId: string, requestId: string, decision: string, answers: unknown, permissions: unknown) => {
      respondCalls.push({ routingId, requestId, decision, answers, permissions })
    })
    app.bridge.ipcMain.handle('session:background-task', async (_e, routingId: string, toolUseId: string) => {
      backgroundCalls.push({ routingId, toolUseId })
      return { success: true }
    })
    app.bridge.ipcMain.handle('session:stop-task', async (_e, routingId: string, toolUseId: string) => {
      stopCalls.push({ routingId, toolUseId })
      return { success: true }
    })
    app.bridge.ipcMain.handle('log:error' as any, async () => {})

    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  async function renderFC(props: { block: ToolUseBlock; approval?: ReturnType<typeof makePendingApproval> }): Promise<void> {
    const { ToolCallBlock } = await import('../ToolCallBlock')
    await act(async () => {
      render(React.createElement(ToolCallBlock, props as any))
    })
  }

  it('onApproval allow calls respondApproval IPC and removes pending', async () => {
    const approval = makePendingApproval({ requestId: 'req-1' })
    useSessionStore.getState().addPendingApproval(ROUTE, approval)

    await renderFC({ block: makeToolUseBlock(), approval })

    await act(async () => {
      await viewProps.onApproval('allow')
    })

    expect(respondCalls).toHaveLength(1)
    expect(respondCalls[0].decision).toBe('allow')
    expect(respondCalls[0].requestId).toBe('req-1')
    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('onApproval deny calls respondApproval IPC and removes pending', async () => {
    const approval = makePendingApproval({ requestId: 'req-2' })
    useSessionStore.getState().addPendingApproval(ROUTE, approval)

    await renderFC({ block: makeToolUseBlock(), approval })

    await act(async () => {
      await viewProps.onApproval('deny')
    })

    expect(respondCalls[0].decision).toBe('deny')
    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('onApproval forwards permission suggestions when provided', async () => {
    const approval = makePendingApproval({ requestId: 'req-3' })
    useSessionStore.getState().addPendingApproval(ROUTE, approval)

    await renderFC({ block: makeToolUseBlock(), approval })

    const suggestions: PermissionSuggestion[] = [{ type: 'addRules', rules: [], destination: 'localSettings' } as PermissionSuggestion]
    await act(async () => {
      await viewProps.onApproval('allow', suggestions)
    })

    expect(respondCalls[0].permissions).toEqual(suggestions)
  })

  it('onBackgroundTask calls backgroundTask IPC', async () => {
    const block = makeToolUseBlock({ toolInput: { command: 'long-cmd', run_in_background: false } })
    await renderFC({ block })

    await act(async () => {
      await viewProps.onBackgroundTask()
    })

    expect(backgroundCalls).toEqual([{ routingId: ROUTE, toolUseId: 'tu-1' }])
  })

  it('onStopTask calls stopTask IPC and sets stopping flag', async () => {
    const block = makeToolUseBlock({ toolInput: { command: 'long-cmd', run_in_background: true } })
    await renderFC({ block })

    await act(async () => {
      await viewProps.onStopTask()
    })

    expect(stopCalls).toEqual([{ routingId: ROUTE, toolUseId: 'tu-1' }])
    expect(useSessionStore.getState().sessions[ROUTE].stoppingTaskIds).toContain('tu-1')
  })

  it('onOpenTaskPanel opens the task panel for the current session', async () => {
    await renderFC({ block: makeToolUseBlock() })

    act(() => { viewProps.onOpenTaskPanel() })

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.rightPanel).toBe('task')
  })

  it('onStopTask on IPC failure clears the stopping flag (rollback)', async () => {
    // Have the handler await a signal so we can observe the intermediate
    // "stopping flag set" state before the promise rejects the IPC.
    let resolveStop!: (v: { success: boolean; error?: string }) => void
    const pendingStop = new Promise<{ success: boolean; error?: string }>((r) => { resolveStop = r })
    app.bridge.ipcMain.handle('session:stop-task', () => pendingStop)

    const block = makeToolUseBlock({ toolInput: { command: 'x', run_in_background: true } })
    await renderFC({ block })

    // Kick off onStopTask but don't await — the FC synchronously sets the flag before awaiting the IPC
    let stopPromise!: Promise<void>
    act(() => { stopPromise = viewProps.onStopTask() })

    // FC should have primed the flag to true
    expect(useSessionStore.getState().sessions[ROUTE].stoppingTaskIds).toContain('tu-1')

    // Now resolve the IPC with a failure and let the FC's error-branch run
    await act(async () => {
      resolveStop({ success: false, error: 'boom' })
      await stopPromise
    })

    // Rollback: stoppingTaskIds should NOT contain tu-1 after the failure
    expect(useSessionStore.getState().sessions[ROUTE].stoppingTaskIds).not.toContain('tu-1')
  })

  it('onBackgroundTask on IPC failure resets isBackgrounding flag', async () => {
    // Pending IPC so we can observe the interim isBackgrounding=true state
    let resolveBg!: (v: { success: boolean; error?: string }) => void
    const pendingBg = new Promise<{ success: boolean; error?: string }>((r) => { resolveBg = r })
    app.bridge.ipcMain.handle('session:background-task', () => pendingBg)

    const block = makeToolUseBlock({ toolInput: { command: 'x', run_in_background: false } })
    await renderFC({ block })

    expect(viewProps.isBackgrounding).toBe(false)

    let bgPromise!: Promise<void>
    act(() => { bgPromise = viewProps.onBackgroundTask() })

    // FC synchronously flips isBackgrounding=true before awaiting
    await act(async () => { await Promise.resolve() })
    expect(viewProps.isBackgrounding).toBe(true)

    await act(async () => {
      resolveBg({ success: false, error: 'nope' })
      await bgPromise
    })

    // Rollback after failure
    expect(viewProps.isBackgrounding).toBe(false)
  })

  it('onStopTask sets stopping flag with a 10s cleanup timer', async () => {
    vi.useFakeTimers()
    try {
      const block = makeToolUseBlock({ toolInput: { command: 'x', run_in_background: true } })
      await renderFC({ block })

      await act(async () => { await viewProps.onStopTask() })
      expect(useSessionStore.getState().sessions[ROUTE].stoppingTaskIds).toContain('tu-1')

      await act(async () => {
        vi.advanceTimersByTime(10_000)
      })

      expect(useSessionStore.getState().sessions[ROUTE].stoppingTaskIds).not.toContain('tu-1')
    } finally {
      vi.useRealTimers()
    }
  })
})
