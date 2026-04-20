/**
 * Layer 2: Component tests for AutomationConfig FC.
 *
 * The FC wraps selection + IPC. When no automation is selected it renders
 * a placeholder. When selected, it builds an AutomationConfigController
 * that hands models/globalPerms and IPC callbacks to the View.
 *
 * Tested flows:
 *   1. renders placeholder when nothing selected
 *   2. onSave calls saveAutomation IPC
 *   3. onToggleEnabled calls toggleAutomation IPC
 *   4. onRunNow calls runAutomationNow IPC
 *   5. onStopRun calls cancelAutomationRun + dismissAutomationRun
 *   6. onDelete calls deleteAutomation + clears selection
 *   7. loadDirPerms merges project + local permissions
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useAutomationStore } from '../../../../stores/automation-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { AutomationConfigViewProps } from '../View'
import type { Automation, ClaudePermissions } from '../../../../../../shared/types'

let viewProps: AutomationConfigViewProps | null = null
vi.mock('../View', () => ({
  AutomationConfigView: (props: AutomationConfigViewProps) => {
    viewProps = props
    return null
  },
}))

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Test',
    prompt: 'hello',
    cwd: '/d/repo',
    schedule: { type: 'interval', intervalMs: 60_000 },
    enabled: true,
    permissions: { allow: [], deny: [] },
    ...overrides,
  } as Automation
}

function makePerms(overrides: Partial<ClaudePermissions> = {}): ClaudePermissions {
  return {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined,
    ...overrides,
  }
}

describe('AutomationConfig FC', () => {
  let app: TestApp
  let saveCalls: Automation[]
  let toggleCalls: Array<{ id: string; enabled: boolean }>
  let deleteCalls: string[]
  let runCalls: string[]
  let cancelCalls: string[]
  let dismissCalls: Array<{ automationId: string; runId: string }>

  beforeEach(async () => {
    app = await bootTestApp()
    saveCalls = []
    toggleCalls = []
    deleteCalls = []
    runCalls = []
    cancelCalls = []
    dismissCalls = []
    viewProps = null

    // Suppress window.confirm — always accept
    vi.stubGlobal('confirm', () => true)

    app.bridge.ipcMain.handle('session:get-models', async () => [])
    app.bridge.ipcMain.handle('claude:load-permissions', async (_e, scope: string) => {
      if (scope === 'project') return makePerms({ allow: ['ProjectAllow'] })
      if (scope === 'local') return makePerms({ deny: ['LocalDeny'] })
      return makePerms({ allow: ['UserAllow'] })
    })
    app.bridge.ipcMain.handle('automation:save', async (_e, a: Automation) => { saveCalls.push(a) })
    app.bridge.ipcMain.handle('automation:toggle', async (_e, id: string, enabled: boolean) => { toggleCalls.push({ id, enabled }) })
    app.bridge.ipcMain.handle('automation:delete', async (_e, id: string) => { deleteCalls.push(id) })
    app.bridge.ipcMain.handle('automation:run-now', async (_e, id: string) => { runCalls.push(id) })
    app.bridge.ipcMain.handle('automation:cancel', async (_e, id: string) => { cancelCalls.push(id) })
    app.bridge.ipcMain.handle('automation:dismiss-run', async (_e, automationId: string, runId: string) => {
      dismissCalls.push({ automationId, runId })
    })

    useAutomationStore.setState({
      automations: [],
      selectedAutomationId: null,
      runs: {},
    })
  })

  afterEach(() => {
    app.teardown()
    vi.unstubAllGlobals()
  })

  async function renderFC(): Promise<ReturnType<typeof render>> {
    const { AutomationConfig } = await import('../AutomationConfig')
    return render(React.createElement(AutomationConfig))
  }

  async function selectAutomation(a: Automation): Promise<void> {
    useAutomationStore.setState({ automations: [a], selectedAutomationId: a.id })
  }

  it('renders placeholder when no automation is selected', async () => {
    const { container } = await act(async () => renderFC())
    expect(container.textContent).toContain('Select an automation')
    expect(viewProps).toBeNull()
  })

  it('onSave calls saveAutomation IPC', async () => {
    await selectAutomation(makeAutomation())
    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const updated = makeAutomation({ name: 'Renamed', prompt: 'new prompt' })
    act(() => { viewProps!.onSave(updated) })

    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(saveCalls).toHaveLength(1)
    expect(saveCalls[0].name).toBe('Renamed')
  })

  it('onToggleEnabled calls toggleAutomation IPC', async () => {
    await selectAutomation(makeAutomation())
    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    act(() => { viewProps!.onToggleEnabled(false) })

    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(toggleCalls).toHaveLength(1)
    expect(toggleCalls[0]).toEqual({ id: 'auto-1', enabled: false })
  })

  it('onRunNow calls runAutomationNow IPC', async () => {
    await selectAutomation(makeAutomation())
    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    act(() => { viewProps!.onRunNow() })

    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(runCalls).toEqual(['auto-1'])
  })

  it('onStopRun cancels and dismisses the running run', async () => {
    await selectAutomation(makeAutomation())
    useAutomationStore.setState({
      runs: { 'auto-1': [{ id: 'run-xyz', status: 'running', startedAt: Date.now() } as any] },
    })

    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    act(() => { viewProps!.onStopRun() })

    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(cancelCalls).toEqual(['auto-1'])
    expect(dismissCalls).toEqual([{ automationId: 'auto-1', runId: 'run-xyz' }])
  })

  it('onDelete calls deleteAutomation and clears selection', async () => {
    await selectAutomation(makeAutomation())
    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    act(() => { viewProps!.onDelete() })

    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(deleteCalls).toEqual(['auto-1'])
    expect(useAutomationStore.getState().selectedAutomationId).toBeNull()
  })

  it('loadDirPerms merges project + local allow/deny', async () => {
    await selectAutomation(makeAutomation())
    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const perms = await viewProps!.loadDirPerms('/d/repo')
    expect(perms).toEqual({ allow: ['ProjectAllow'], deny: ['LocalDeny'] })
  })
})
