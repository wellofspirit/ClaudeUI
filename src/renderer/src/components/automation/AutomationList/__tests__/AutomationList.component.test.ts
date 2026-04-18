/**
 * Layer 2: Component tests for AutomationList FC.
 *
 * Tested flows:
 *   1. onCreate calls saveAutomation + selects new automation
 *   2. onSelect updates store selection
 *   3. onSelectRun updates store run selection
 *   4. onToggleExpand toggles expandedId local state
 *   5. onLoadRuns fetches runs via listAutomationRuns IPC
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useAutomationStore } from '../../../../stores/automation-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { AutomationListViewProps } from '../View'
import type { Automation, AutomationRun } from '../../../../../../shared/types'

let viewProps: AutomationListViewProps
vi.mock('../View', () => ({
  AutomationListView: (props: AutomationListViewProps) => {
    viewProps = props
    return null
  },
}))

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Test',
    prompt: '',
    cwd: '',
    schedule: { type: 'interval', intervalMs: 60_000 },
    permissions: { allow: [], deny: [] },
    enabled: false,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: Date.now(),
    ...overrides,
  } as Automation
}

describe('AutomationList FC', () => {
  let app: TestApp
  let saveCalls: Automation[]
  let listRunsCalls: string[]

  beforeEach(async () => {
    app = await bootTestApp()
    saveCalls = []
    listRunsCalls = []

    app.bridge.ipcMain.handle('automation:save', async (_e, a: Automation) => { saveCalls.push(a) })
    app.bridge.ipcMain.handle('automation:list-runs', async (_e, id: string) => {
      listRunsCalls.push(id)
      return [{ id: 'run-1', status: 'success', startedAt: 1, finishedAt: 2, totalCostUsd: 0 } as AutomationRun]
    })

    useAutomationStore.setState({
      automations: [],
      selectedAutomationId: null,
      selectedRunId: null,
      runs: {},
    })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(): Promise<ReturnType<typeof render>> {
    const { AutomationList } = await import('../AutomationList')
    return render(React.createElement(AutomationList))
  }

  it('onCreate calls saveAutomation IPC and selects new automation', async () => {
    await act(async () => { await renderFC() })

    act(() => { viewProps.onCreate() })

    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(saveCalls).toHaveLength(1)
    expect(useAutomationStore.getState().selectedAutomationId).toBe(saveCalls[0].id)
  })

  it('onSelect updates selectedAutomationId in store', async () => {
    useAutomationStore.setState({ automations: [makeAutomation()] })
    await act(async () => { await renderFC() })

    act(() => { viewProps.onSelect('auto-1') })

    expect(useAutomationStore.getState().selectedAutomationId).toBe('auto-1')
  })

  it('onSelectRun updates selectedRunId', async () => {
    useAutomationStore.setState({ automations: [makeAutomation()] })
    await act(async () => { await renderFC() })

    act(() => { viewProps.onSelectRun('auto-1', 'run-xyz') })

    expect(useAutomationStore.getState().selectedRunId).toBe('run-xyz')
  })

  it('onToggleExpand flips expandedId local state', async () => {
    useAutomationStore.setState({ automations: [makeAutomation()] })
    await act(async () => { await renderFC() })

    expect(viewProps.expandedId).toBeNull()

    act(() => { viewProps.onToggleExpand('auto-1') })
    expect(viewProps.expandedId).toBe('auto-1')

    act(() => { viewProps.onToggleExpand('auto-1') })
    expect(viewProps.expandedId).toBeNull()
  })

  it('onLoadRuns fetches and stores runs via IPC', async () => {
    useAutomationStore.setState({ automations: [makeAutomation()] })
    await act(async () => { await renderFC() })

    await act(async () => {
      viewProps.onLoadRuns('auto-1')
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(listRunsCalls).toEqual(['auto-1'])
    expect(useAutomationStore.getState().runs['auto-1']).toHaveLength(1)
  })

  it('onLoadRuns sets an empty runs list when the IPC rejects', async () => {
    app.bridge.ipcMain.handle('automation:list-runs', async () => { throw new Error('IPC failed') })
    app.bridge.ipcMain.handle('log:error' as any, async () => {})

    useAutomationStore.setState({ automations: [makeAutomation()] })
    await act(async () => { await renderFC() })

    await act(async () => {
      viewProps.onLoadRuns('auto-1')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })

    // setRuns should be called with [] so the UI escapes the loading state
    expect(useAutomationStore.getState().runs['auto-1']).toEqual([])
  })
})
