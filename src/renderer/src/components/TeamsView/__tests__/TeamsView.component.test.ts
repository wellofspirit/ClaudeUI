/**
 * Layer 2: Component tests for TeamsView FC.
 *
 * The FC reads `routingId` from `window.location.search`, calls
 * `window.api.getTeamInfo(routingId)` on mount, optionally loads subagent
 * histories via `window.api.loadSubagentHistory`, then passes state down to
 * `<TeamsViewView />`.  The View is mocked so only props are inspected.
 *
 * Tests:
 *  1. shows loading initially then resolves with team info
 *  2. loads subagent message history for all teammates
 *  3. handles null team info (no teammates, loading=false)
 *  4. handles missing routingId (loading=false immediately, no IPC calls)
 *  5. passes teammate list populated from store
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { TeamsViewViewProps } from '../View'
import type { ChatMessage, TeammateInfo } from '../../../../../shared/types'

// ---------------------------------------------------------------------------
// Mock View — capture the latest props without rendering real DOM
// ---------------------------------------------------------------------------

let viewProps: TeamsViewViewProps
vi.mock('../View', () => ({
  TeamsViewView: (props: TeamsViewViewProps) => {
    viewProps = props
    return null
  },
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROUTING_ID = 'team-session-1'

const teammate: TeammateInfo = {
  agentId: 'agent-1',
  toolUseId: 'tu-1',
  name: 'Coder',
  sanitizedName: 'coder',
  teamName: 'my-team',
  sanitizedTeamName: 'my-team',
  status: 'running',
  fileId: 'file-1',
}

function makeMessage(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text: `message ${id}` }],
    timestamp: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setRoutingId(id: string | null): void {
  const search = id ? `?routingId=${id}` : ''
  // JSDOM allows direct assignment to window.location.search via defineProperty
  Object.defineProperty(window, 'location', {
    value: { ...window.location, search },
    writable: true,
    configurable: true,
  })
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TeamsView FC', () => {
  let app: TestApp

  beforeEach(async () => {
    // Wire IPC bridge
    app = await bootTestApp()

    // Register the two IPC channels used by the FC
    app.bridge.ipcMain.handle('session:get-team-info', async () => null)
    app.bridge.ipcMain.handle(
      'session:load-subagent-history',
      async () => [] as ChatMessage[],
    )

    // Seed store: no active sessions
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      recentSessionIds: [],
    })

    // Default: routingId present
    setRoutingId(ROUTING_ID)
  })

  afterEach(() => {
    app.teardown()
  })

  // Lazy import so module mocks above are applied first
  async function renderFC(): Promise<ReturnType<typeof render>> {
    const { TeamsView } = await import('../TeamsView')
    return render(React.createElement(TeamsView))
  }

  // -------------------------------------------------------------------------
  // Test 1 — loading flag transitions and teamName is set
  // -------------------------------------------------------------------------

  it('shows loading initially then sets teamName after getTeamInfo resolves', async () => {
    let resolveTeamInfo!: (v: unknown) => void
    const teamInfoPromise = new Promise((res) => { resolveTeamInfo = res })

    // Override the default stub with a deferred one
    app.bridge.ipcMain.handle('session:get-team-info', () => teamInfoPromise)

    const { unmount } = await act(async () => renderFC())

    // Immediately after mount, loading should be true
    expect(viewProps.loading).toBe(true)

    // Resolve getTeamInfo with real team data (no subagent history needed here)
    await act(async () => {
      resolveTeamInfo({
        routingId: ROUTING_ID,
        teamName: 'Alpha Team',
        teammates: [],
        sessionId: null,
        projectKey: null,
      })
    })

    expect(viewProps.loading).toBe(false)
    expect(viewProps.teamName).toBe('Alpha Team')

    unmount()
  })

  // -------------------------------------------------------------------------
  // Test 2 — subagent history is loaded and stored
  // -------------------------------------------------------------------------

  it('loads subagent message history and populates subagentMessages', async () => {
    const msgs = [makeMessage('m1'), makeMessage('m2')]

    app.bridge.ipcMain.handle('session:get-team-info', async () => ({
      routingId: ROUTING_ID,
      teamName: 'Beta Team',
      teammates: [teammate],
      sessionId: 'sess-abc',
      projectKey: 'proj-xyz',
    }))

    app.bridge.ipcMain.handle(
      'session:load-subagent-history',
      async (_evt: unknown, _sessionId: string, _projectKey: string, _agentId: string) => msgs,
    )

    const { unmount } = await act(async () => renderFC())

    // Wait for all async work to complete
    await act(async () => {
      await Promise.resolve()
    })

    expect(viewProps.loading).toBe(false)

    const subagentMsgs = useSessionStore.getState().sessions[ROUTING_ID]?.subagentMessages
    expect(subagentMsgs?.[teammate.toolUseId]).toHaveLength(2)
    expect(subagentMsgs?.[teammate.toolUseId][0].id).toBe('m1')

    unmount()
  })

  // -------------------------------------------------------------------------
  // Test 3 — null team info: loading=false, no crash
  // -------------------------------------------------------------------------

  it('handles null team info gracefully (loading=false, empty state)', async () => {
    // Default stub already returns null — nothing more to configure

    const { unmount } = await act(async () => renderFC())

    await act(async () => {
      await Promise.resolve()
    })

    expect(viewProps.loading).toBe(false)
    expect(viewProps.teamName).toBeUndefined()
    expect(viewProps.teammateList).toHaveLength(0)

    unmount()
  })

  // -------------------------------------------------------------------------
  // Test 4 — no routingId: loading=false immediately, no IPC calls
  // -------------------------------------------------------------------------

  it('sets loading=false immediately and makes no IPC calls when routingId is absent', async () => {
    setRoutingId(null)

    const getTeamInfoCalls: unknown[][] = []
    app.bridge.ipcMain.handle('session:get-team-info', async (...args) => {
      getTeamInfoCalls.push(args)
      return null
    })

    const { unmount } = await act(async () => renderFC())

    await act(async () => {
      await Promise.resolve()
    })

    expect(viewProps.loading).toBe(false)
    expect(getTeamInfoCalls).toHaveLength(0)

    unmount()
  })

  // -------------------------------------------------------------------------
  // Test 5 — teammate list is populated from store
  // -------------------------------------------------------------------------

  it('passes teammate list from store to the View', async () => {
    // Pre-populate the store with a session that already has a teammate
    useSessionStore.getState().createNewSession(ROUTING_ID, '/workspace')
    useSessionStore.getState().addTeammate(ROUTING_ID, teammate)

    // getTeamInfo resolves immediately with no new data so we can assert store state
    app.bridge.ipcMain.handle('session:get-team-info', async () => ({
      routingId: ROUTING_ID,
      teamName: 'Gamma Team',
      teammates: [teammate],
      sessionId: null,
      projectKey: null,
    }))

    const { unmount } = await act(async () => renderFC())

    await act(async () => {
      await Promise.resolve()
    })

    expect(viewProps.teammateList).toHaveLength(1)
    expect(viewProps.teammateList[0].toolUseId).toBe('tu-1')
    expect(viewProps.teammateList[0].name).toBe('Coder')

    unmount()
  })
})
