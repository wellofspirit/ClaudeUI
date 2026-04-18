/**
 * Layer 2: Component test for AgentTabBar.
 *
 * Minimal-logic component — tests setFocusedAgent store action + stopTask IPC
 * via DOM interaction.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { AgentTabBar } from '../AgentTabBar'
import type { TeammateInfo } from '../../../../../shared/types'

const ROUTE = 'route-agt'

function makeTeammate(overrides: Partial<TeammateInfo> = {}): TeammateInfo {
  return {
    toolUseId: 'tu-1',
    name: 'Coder',
    sanitizedName: 'coder',
    teamName: 'team',
    sanitizedTeamName: 'team',
    agentId: 'a-1',
    status: 'running',
    fileId: 'f-1',
    ...overrides,
  } as TeammateInfo
}

describe('AgentTabBar', () => {
  let app: TestApp
  let stopCalls: Array<{ routingId: string; toolUseId: string }>

  beforeEach(async () => {
    app = await bootTestApp()
    stopCalls = []

    app.bridge.ipcMain.handle('session:stop-task', async (_e, routingId: string, toolUseId: string) => {
      stopCalls.push({ routingId, toolUseId })
      return { success: true }
    })
    app.bridge.ipcMain.handle('session:open-teams-view', async () => {})

    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('renders nothing when no team is active', () => {
    const { container } = render(<AgentTabBar />)
    expect(container.firstChild).toBeNull()
  })

  it('clicking a teammate tab calls setFocusedAgent', () => {
    useSessionStore.getState().setTeamName(ROUTE, 'my-team')
    useSessionStore.getState().addTeammate(ROUTE, makeTeammate())

    const { getByText } = render(<AgentTabBar />)
    fireEvent.click(getByText('Coder'))

    expect(useSessionStore.getState().sessions[ROUTE].focusedAgentId).toBe('tu-1')
  })

  it('clicking Main tab resets focusedAgent to null', () => {
    useSessionStore.getState().setTeamName(ROUTE, 'my-team')
    useSessionStore.getState().addTeammate(ROUTE, makeTeammate())
    useSessionStore.getState().setFocusedAgent(ROUTE, 'tu-1')

    const { getByText } = render(<AgentTabBar />)
    fireEvent.click(getByText('Main'))

    expect(useSessionStore.getState().sessions[ROUTE].focusedAgentId).toBeNull()
  })

  it('clicking the stop button on a teammate calls stopTask IPC', async () => {
    useSessionStore.getState().setTeamName(ROUTE, 'my-team')
    useSessionStore.getState().addTeammate(ROUTE, makeTeammate({ status: 'running' }))

    const { container } = render(<AgentTabBar />)
    // Stop button is a <span title="Stop agent"> inside the running teammate's tab
    const stopBtn = container.querySelector('[title="Stop agent"]')
    expect(stopBtn).not.toBeNull()

    fireEvent.click(stopBtn!)
    await new Promise((r) => setTimeout(r, 0))

    expect(stopCalls).toEqual([{ routingId: ROUTE, toolUseId: 'tu-1' }])
  })

  it('does not render a stop button for a non-running teammate', () => {
    useSessionStore.getState().setTeamName(ROUTE, 'my-team')
    useSessionStore.getState().addTeammate(ROUTE, makeTeammate({ status: 'completed' }))

    const { container } = render(<AgentTabBar />)
    expect(container.querySelector('[title="Stop agent"]')).toBeNull()
  })

  it('clicking Monitor opens the teams view via IPC', async () => {
    const monitorCalls: string[] = []
    app.bridge.ipcMain.handle('session:open-teams-view', async (_e, routingId: string) => { monitorCalls.push(routingId) })

    useSessionStore.getState().setTeamName(ROUTE, 'my-team')
    useSessionStore.getState().addTeammate(ROUTE, makeTeammate())

    const { getByTitle } = render(<AgentTabBar />)
    fireEvent.click(getByTitle('Open Agent Monitor'))
    await new Promise((r) => setTimeout(r, 0))

    expect(monitorCalls).toEqual([ROUTE])
  })
})
