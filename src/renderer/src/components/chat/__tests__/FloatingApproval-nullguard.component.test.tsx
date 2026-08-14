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
import { seed, resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

const ROUTE = 'route-nullguard'

beforeEach(() => {
  // The replica is a module singleton holding canonical state: resetting only the
  // store would leave the two disagreeing and the next projection would resurrect
  // the previous test's sessions (SyncCore phase 4c).
  resetReplicaSeam()
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
  mirrorStoreIntoReplica()
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
    seed.approvalRequest(ROUTE, malformed)

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<FloatingApproval />)).not.toThrow()
    spy.mockRestore()
  })
})
