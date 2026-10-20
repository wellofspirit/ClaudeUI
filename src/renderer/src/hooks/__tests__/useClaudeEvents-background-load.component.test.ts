import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('electron', async () => import('@test/stubs/electron-shim'))

import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useClaudeEvents } from '../useClaudeEvents'
import { useSessionStore } from '../../stores/session-store'
import { resetBackgroundLoadForTests } from '../../lib/subagent-prefetch'
import { makeAssistantMessage } from '@test/factories/messages'

/**
 * ADR-102 Arc 2 (R2): the background phase of a load is started by which session is
 * ACTIVE, and the one place that watches for it is mounted by `useClaudeEvents` — in
 * the desktop renderer and the web client alike. Without that wiring a committed
 * session would show "Loading usage…" for ever.
 */

let app: TestApp
const loadSessionStatusLine = vi.fn()
const loadSubagentHistory = vi.fn()

function EventHarness(): null {
  useClaudeEvents()
  return null
}

beforeEach(async () => {
  app = await bootTestApp()
  loadSessionStatusLine.mockReset().mockResolvedValue({ totalCostUsd: 4, totalTokens: 4 })
  loadSubagentHistory.mockReset().mockResolvedValue([])
  Object.assign(window.api, { loadSessionStatusLine, loadSubagentHistory })
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {}
  })
})

afterEach(() => {
  cleanup()
  resetBackgroundLoadForTests()
  app.teardown()
})

function commitPending(): void {
  useSessionStore
    .getState()
    .loadHistoricalSession(
      'sess',
      [makeAssistantMessage('m')],
      '/p',
      [],
      undefined,
      null,
      undefined,
      {
        subagentIndex: {},
        source: { sessionId: 'sess', projectKey: '-p' },
        statusPending: true,
        statusBytes: 10
      }
    )
}

describe('useClaudeEvents — the background load', () => {
  it('starts the status pass when the committed session becomes the active one, and lands it', async () => {
    render(createElement(EventHarness))
    commitPending()
    expect(loadSessionStatusLine).not.toHaveBeenCalled() // committed, not active: the click path starts nothing

    useSessionStore.setState({ activeSessionId: 'sess' })

    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions['sess'].statusLine).not.toBeNull()
    )
    expect(loadSessionStatusLine).toHaveBeenCalledWith('sess', '-p', expect.any(Function))
    expect(useSessionStore.getState().sessions['sess'].backgroundLoad).toBeNull()
  })

  it('stops reconciling when the hook unmounts', async () => {
    const view = render(createElement(EventHarness))
    view.unmount()
    commitPending()
    useSessionStore.setState({ activeSessionId: 'sess' })
    await Promise.resolve()
    expect(loadSessionStatusLine).not.toHaveBeenCalled()
  })
})
