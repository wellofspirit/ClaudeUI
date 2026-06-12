/**
 * Layer 2: Component tests for AutomationList FC.
 *
 * Tested flows:
 *   1. onCreate calls saveAutomation + selects new automation
 *   2. onSelect updates store selection
 *   3. Backfills runs for every automation without cached runs (list
 *      sparklines depend on this initial fetch).
 *   4. Skips backfill for automations that already have runs loaded.
 *   5. Falls back to an empty run list when listAutomationRuns rejects so
 *      the UI doesn't spin forever on a broken IPC.
 */

 

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
    app.bridge.ipcMain.handle('automation:list-runs', async (_e, id: string): Promise<AutomationRun[]> => {
      listRunsCalls.push(id)
      return [{ id: `run-${id}`, automationId: id, status: 'success', startedAt: 1, finishedAt: 2, totalCostUsd: 0 }]
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

  it('backfills runs via listAutomationRuns for each unloaded automation on mount', async () => {
    useAutomationStore.setState({
      automations: [makeAutomation({ id: 'a1' }), makeAutomation({ id: 'a2' })],
    })

    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(listRunsCalls.sort()).toEqual(['a1', 'a2'])
    expect(useAutomationStore.getState().runs['a1']).toHaveLength(1)
    expect(useAutomationStore.getState().runs['a2']).toHaveLength(1)
  })

  it('skips backfill for automations that already have cached runs', async () => {
    useAutomationStore.setState({
      automations: [makeAutomation({ id: 'a1' }), makeAutomation({ id: 'a2' })],
      runs: { a1: [{ id: 'cached', automationId: 'a1', status: 'success', startedAt: 0, finishedAt: 0, totalCostUsd: 0 }] },
    })

    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(listRunsCalls).toEqual(['a2']) // only the uncached one
    expect(useAutomationStore.getState().runs['a1']?.[0].id).toBe('cached')
  })

  it('falls back to an empty run list when listAutomationRuns rejects', async () => {
    app.bridge.ipcMain.handle('automation:list-runs', async () => { throw new Error('boom') })

    useAutomationStore.setState({
      automations: [makeAutomation({ id: 'a1' })],
    })

    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(useAutomationStore.getState().runs['a1']).toEqual([])
  })
})
