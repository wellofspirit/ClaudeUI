/**
 * WS8 guard test for FloatingApproval null-deref (M-RN2). A malformed
 * AskUserQuestion approval with a missing `input` must not throw during render
 * (which, without the top-level ErrorBoundary, blanks the whole app).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import type { PendingApproval } from '../../../../../shared/types'
import { FloatingApproval } from '../FloatingApproval'

const ROUTE = 'route-nullguard'

beforeEach(() => {
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    respondApproval: () => Promise.resolve(),
    saveSessionConfig: () => {},
    saveSettings: () => {},
    saveSlashCommands: () => {},
    logError: () => {}
  }
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {}
  })
})

describe('FloatingApproval — malformed AskUserQuestion approval', () => {
  it('renders without throwing when approval.input is missing', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/test')
    useSessionStore.setState({ activeSessionId: ROUTE })

    // No `input` at all — pre-fix, FloatingQuestionCard dereferenced
    // (approval.input as ...).questions and threw, unmounting the app.
    const malformed = {
      requestId: 'req-malformed',
      toolName: 'AskUserQuestion',
      toolUseId: 'child_call_x'
    } as unknown as PendingApproval
    useSessionStore.getState().addPendingApproval(ROUTE, malformed)

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<FloatingApproval />)).not.toThrow()
    spy.mockRestore()
  })
})
