/**
 * Layer 2: Component tests for AutomationRunHistory FC.
 *
 * Tested flows:
 *   1. loads run history on mount via IPC
 *   2. onSend calls sendAutomationMessage IPC
 *   3. onStop cancels + dismisses the run
 *   4. onBack clears run selection
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useAutomationStore } from '../../../../stores/automation-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { AutomationRunHistoryViewProps } from '../View'
import type { AutomationRun, ChatMessage } from '../../../../../../shared/types'

let viewProps: AutomationRunHistoryViewProps
vi.mock('../View', () => ({
  AutomationRunHistoryView: (props: AutomationRunHistoryViewProps) => {
    viewProps = props
    return null
  },
}))

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    totalCostUsd: 0,
    error: null,
    ...overrides,
  } as AutomationRun
}

describe('AutomationRunHistory FC', () => {
  let app: TestApp
  let loadHistoryCalls: Array<{ automationId: string; runId: string }>
  let sendCalls: Array<{ id: string; prompt: string }>
  let cancelCalls: string[]
  let dismissCalls: Array<{ automationId: string; runId: string }>

  beforeEach(async () => {
    app = await bootTestApp()
    loadHistoryCalls = []
    sendCalls = []
    cancelCalls = []
    dismissCalls = []

    app.bridge.ipcMain.handle('automation:load-run-history', async (_e, automationId: string, runId: string) => {
      loadHistoryCalls.push({ automationId, runId })
      return [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hello' }], timestamp: 1 }] as ChatMessage[]
    })
    app.bridge.ipcMain.handle('automation:send-message', async (_e, id: string, prompt: string) => {
      sendCalls.push({ id, prompt })
    })
    app.bridge.ipcMain.handle('automation:cancel', async (_e, id: string) => { cancelCalls.push(id) })
    app.bridge.ipcMain.handle('automation:dismiss-run', async (_e, automationId: string, runId: string) => {
      dismissCalls.push({ automationId, runId })
    })

    useAutomationStore.setState({
      automations: [],
      selectedAutomationId: 'auto-1',
      selectedRunId: 'run-1',
      runs: { 'auto-1': [makeRun()] },
      runMessages: null,
      streamingText: '',
      isRunProcessing: false,
    })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(): Promise<ReturnType<typeof render>> {
    const { AutomationRunHistory } = await import('../AutomationRunHistory')
    return render(React.createElement(AutomationRunHistory))
  }

  it('loads run history on mount via loadAutomationRunHistory IPC', async () => {
    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(loadHistoryCalls).toEqual([{ automationId: 'auto-1', runId: 'run-1' }])
    expect(useAutomationStore.getState().runMessages).toHaveLength(1)
  })

  it('onSend calls sendAutomationMessage IPC', async () => {
    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    act(() => { viewProps.onSend('follow-up question') })

    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(sendCalls).toEqual([{ id: 'auto-1', prompt: 'follow-up question' }])
  })

  it('onStop cancels + dismisses via IPC', async () => {
    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    act(() => { viewProps.onStop() })

    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(cancelCalls).toEqual(['auto-1'])
    expect(dismissCalls).toEqual([{ automationId: 'auto-1', runId: 'run-1' }])
  })

  it('onBack clears run selection', async () => {
    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    act(() => { viewProps.onBack() })

    expect(useAutomationStore.getState().selectedRunId).toBeNull()
  })

  it('re-fetches history when selectedRunId changes to a different run', async () => {
    const historyByRun: Record<string, ChatMessage[]> = {
      'run-1': [{ id: 'a', role: 'assistant', content: [{ type: 'text', text: 'first' }], timestamp: 1 } as ChatMessage],
      'run-2': [{ id: 'b', role: 'assistant', content: [{ type: 'text', text: 'second' }], timestamp: 2 } as ChatMessage],
    }
    app.bridge.ipcMain.handle('automation:load-run-history', async (_e, _id: string, runId: string) => {
      loadHistoryCalls.push({ automationId: 'auto-1', runId })
      return historyByRun[runId] ?? []
    })

    // Seed a second run so we can select it
    useAutomationStore.setState({
      runs: {
        'auto-1': [
          makeRun({ id: 'run-1' }),
          makeRun({ id: 'run-2' }),
        ],
      },
    })

    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(useAutomationStore.getState().runMessages?.[0]?.id).toBe('a')

    // Switch selection to run-2
    await act(async () => {
      useAutomationStore.getState().selectRun('auto-1', 'run-2')
      await new Promise((r) => setTimeout(r, 0))
    })

    // History should be re-loaded; runMessages should briefly be null in between
    // but definitely updated by now.
    expect(loadHistoryCalls.some((c) => c.runId === 'run-2')).toBe(true)
    expect(useAutomationStore.getState().runMessages?.[0]?.id).toBe('b')
  })

  it('falls back to an empty message list when loadAutomationRunHistory rejects', async () => {
    app.bridge.ipcMain.handle('automation:load-run-history', async () => { throw new Error('IPC failed') })
    app.bridge.ipcMain.handle('log:error' as any, async () => {})

    await act(async () => { await renderFC() })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })

    // runMessages should be [] (not null = "Loading..." stuck forever)
    expect(useAutomationStore.getState().runMessages).toEqual([])
  })
})
