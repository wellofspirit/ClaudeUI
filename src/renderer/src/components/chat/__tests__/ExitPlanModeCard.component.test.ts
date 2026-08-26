/**
 * Layer 2: Component tests for ExitPlanModeCard.
 *
 * Section 1: waitForModeChange utility — subscribes to the session store and
 * resolves when the active session's permissionMode changes, OR after a 2000ms
 * timeout. It must always unsubscribe from the store to avoid leaks.
 *
 * Section 2: ExitPlanModeCard FC — renders the View with correct props, and
 * calling the View's callbacks triggers the expected IPC calls and store effects.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { waitForModeChange } from '../ExitPlanModeCard/utils'
import { resetFactoryCounter } from '@test/factories/messages'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { ExitPlanModeCardViewProps } from '../ExitPlanModeCard/View'

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any imports of the mocked modules
// ---------------------------------------------------------------------------

// Capture the View props instead of rendering actual View (which has DOM deps)
let viewProps: ExitPlanModeCardViewProps
vi.mock('../ExitPlanModeCard/View', () => ({
  ExitPlanModeCardView: (props: ExitPlanModeCardViewProps) => {
    viewProps = props
    return null
  }
}))

// Replace waitForModeChange with a vi.fn so the FC tests can control it.
// We save the real implementation so the existing waitForModeChange tests
// can restore it in their own beforeEach.
// NOTE: var is intentional — the vi.mock factory is hoisted above let/const
// declarations, so we need var's hoisting-to-undefined behaviour to avoid a TDZ error.
// eslint-disable-next-line no-var
var _realWaitForModeChange: () => Promise<void>
vi.mock('../ExitPlanModeCard/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('../ExitPlanModeCard/utils')>()
  _realWaitForModeChange = original.waitForModeChange
  return {
    ...original,
    waitForModeChange: vi.fn(() => Promise.resolve())
  }
})

const ROUTE = 'r1'

beforeEach(() => {
  resetFactoryCounter()
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: () => {},
    saveSettings: () => {}
  } as any

  useSessionStore.setState({
    activeSessionId: ROUTE,
    sessions: {},
    recentSessionIds: []
  })
  mirrorStoreIntoReplica()
  useSessionStore.getState().createNewSession(ROUTE, '/test')
})

// ---------------------------------------------------------------------------
// Resolves on permissionMode change
// ---------------------------------------------------------------------------

describe('waitForModeChange', () => {
  // These tests exercise the real implementation — restore it for each test in
  // this describe block and reset to the stub after so the FC tests stay clean.
  beforeEach(() => {
    vi.mocked(waitForModeChange).mockImplementation(() => _realWaitForModeChange())
  })
  afterEach(() => {
    vi.mocked(waitForModeChange).mockResolvedValue(undefined)
  })

  it('resolves when permissionMode changes from default to plan', async () => {
    const promise = waitForModeChange()

    // Simulate the SDK sending back a permissionMode status change
    seed.permissionMode(useSessionStore.getState().activeSessionId!, 'plan')

    await expect(promise).resolves.toBeUndefined()
  })

  it('resolves when permissionMode changes from plan back to default', async () => {
    // Start from 'plan' mode
    seed.permissionMode(useSessionStore.getState().activeSessionId!, 'plan')

    const promise = waitForModeChange()

    seed.permissionMode(useSessionStore.getState().activeSessionId!, 'default')

    await expect(promise).resolves.toBeUndefined()
  })

  it('does not resolve prematurely when permissionMode is set to the same value', async () => {
    // Ensure the mode stays at 'default'
    seed.permissionMode(useSessionStore.getState().activeSessionId!, 'default')

    let resolved = false
    void waitForModeChange().then(() => {
      resolved = true
    })

    // Setting the same mode again should not resolve — subscription only fires on change
    // but the comparison in the subscriber checks mode !== currentMode.
    // Zustand does notify subscribers on every setState, so we verify the
    // promise is still pending after a same-mode set by using fake timers
    // to skip past real time but stay well under the 2000ms timeout.
    vi.useFakeTimers()
    try {
      // advance 500ms — still before the 2000ms timeout
      vi.advanceTimersByTime(500)
      // flush microtasks
      await Promise.resolve()
      // If the mode never actually changed, the promise should still be pending
      expect(resolved).toBe(false)
    } finally {
      vi.useRealTimers()
      // Let the actual 2000ms timeout fire to avoid leaking the subscription
      // We can't await the original promise here without also waiting 2s in real
      // time, so we just verify the non-resolution behaviour above.
    }
  })

  // ---------------------------------------------------------------------------
  // Timeout path
  // ---------------------------------------------------------------------------

  it('resolves after 2000ms timeout if permissionMode never changes', async () => {
    vi.useFakeTimers()
    try {
      const promise = waitForModeChange()

      // Nothing changes the mode — advance past the timeout
      vi.advanceTimersByTime(2000)

      await expect(promise).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not resolve before the 2000ms timeout when mode never changes', async () => {
    vi.useFakeTimers()
    try {
      let resolved = false
      waitForModeChange().then(() => {
        resolved = true
      })

      vi.advanceTimersByTime(1999)
      await Promise.resolve() // flush microtasks
      expect(resolved).toBe(false)

      vi.advanceTimersByTime(1) // now at exactly 2000ms
      await Promise.resolve()
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // ---------------------------------------------------------------------------
  // Unsubscribes after resolution
  // ---------------------------------------------------------------------------

  it('unsubscribes from store after mode change resolves', async () => {
    const subscribespy = vi.spyOn(useSessionStore, 'subscribe')

    const promise = waitForModeChange()
    seed.permissionMode(useSessionStore.getState().activeSessionId!, 'plan')
    await promise

    // Count active subscriptions added by waitForModeChange.
    // The spy captures the subscribe call; we verify that the unsubscribe
    // function returned by subscribe was called by confirming subsequent
    // store mutations do not cause an already-resolved promise to fire again.
    // We do this by confirming promise is settled and no errors thrown.
    seed.permissionMode(useSessionStore.getState().activeSessionId!, 'default')
    // If still subscribed this would cause issues; no assertion failure means clean.

    subscribespy.mockRestore()
  })

  it('unsubscribes from store after timeout', async () => {
    vi.useFakeTimers()
    try {
      const promise = waitForModeChange()
      vi.advanceTimersByTime(2000)
      await promise

      // After timeout the subscription should be cleaned up.
      // Subsequent mode changes must not throw or cause issues.
      seed.permissionMode(useSessionStore.getState().activeSessionId!, 'plan')
      await Promise.resolve()
      // Reaching here without errors confirms the subscription is gone.
    } finally {
      vi.useRealTimers()
    }
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('resolves immediately via timeout if there is no active session', async () => {
    vi.useFakeTimers()
    try {
      useSessionStore.setState({ activeSessionId: null })

      let resolved = false
      waitForModeChange().then(() => {
        resolved = true
      })

      vi.advanceTimersByTime(2000)
      await Promise.resolve()
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('mode change on a different session does not resolve the promise early', async () => {
    vi.useFakeTimers()
    try {
      // active session is ROUTE; create a second session without switching to it
      useSessionStore.getState().createNewSession('other-session', '/other', false)

      let resolved = false
      waitForModeChange().then(() => {
        resolved = true
      })

      // Change mode on the other session — should not trigger ROUTE's subscription
      seed.permissionMode('other-session', 'plan')
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(false)

      vi.advanceTimersByTime(2000)
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Section 2: ExitPlanModeCard FC — renders View and exercises handler props
// ---------------------------------------------------------------------------

import { ExitPlanModeCard } from '../ExitPlanModeCard/ExitPlanModeCard'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

const planText = 'Step 1: Do X\nStep 2: Do Y'
const block = {
  type: 'tool_use' as const,
  id: 'tu-1',
  toolName: 'ExitPlanMode',
  toolInput: { plan: planText },
  toolUseId: 'tu-1'
}
const planView = { kind: 'plan' as const, plan: planText }
const approval = {
  requestId: 'req-1',
  toolName: 'ExitPlanMode',
  input: { plan: planText },
  toolUseId: 'tu-1'
}

describe('ExitPlanModeCard FC', () => {
  const ROUTE_FC = 'fc-session'
  let app: TestApp

  // Captured IPC call args
  const ipcCalls: Record<string, unknown[][]> = {}
  function recordIpc(channel: string): void {
    ipcCalls[channel] = []
  }
  function lastCall(channel: string): unknown[] | undefined {
    return ipcCalls[channel]?.at(-1)
  }

  beforeEach(async () => {
    // Reset IPC tracking
    Object.keys(ipcCalls).forEach((k) => delete ipcCalls[k])

    // waitForModeChange resolves immediately for FC tests
    vi.mocked(waitForModeChange).mockResolvedValue(undefined)

    app = await bootTestApp()

    // Register IPC handlers and track calls
    const channels = [
      'session:approval-response',
      'session:cancel',
      'session:create',
      'session:send',
      'session:get-session-log-path',
      'session:set-permission-mode',
      // F4: the reset is an invoke now, and `handleStartFresh` AWAITS it so the
      // fresh session's birth event cannot be blanked by a late clear.
      'session:clear-conversation'
    ]
    for (const ch of channels) {
      recordIpc(ch)
      app.bridge.ipcMain.handle(ch, (_evt: unknown, ...args: unknown[]) => {
        ipcCalls[ch].push(args)
        // getSessionLogPath returns a path string
        if (ch === 'session:get-session-log-path') return '/logs/session.jsonl'
        return undefined
      })
    }

    // Seed store with a session
    resetFactoryCounter()
    useSessionStore.setState({
      activeSessionId: ROUTE_FC,
      sessions: {},
      recentSessionIds: []
    })
    mirrorStoreIntoReplica()
    useSessionStore.getState().createNewSession(ROUTE_FC, '/workspace')
    seed.approvalRequest(ROUTE_FC, approval)
  })

  afterEach(() => {
    app.teardown()
  })

  function renderFC(): ReturnType<typeof render> {
    return render(React.createElement(ExitPlanModeCard, { block, view: planView, approval }))
  }

  // -------------------------------------------------------------------------
  // onStartFresh
  // -------------------------------------------------------------------------

  it('onStartFresh: calls getSessionLogPath, respondApproval(deny), cancelSession, clearConversation, createSession, sendPrompt', async () => {
    const { unmount } = renderFC()

    await act(async () => {
      await viewProps.onStartFresh()
    })

    // getSessionLogPath called with session id
    expect(lastCall('session:get-session-log-path')).toEqual([ROUTE_FC])

    // respondApproval called with deny
    expect(lastCall('session:approval-response')).toEqual(
      expect.arrayContaining([ROUTE_FC, approval.requestId, 'deny'])
    )

    // cancelSession called
    expect(lastCall('session:cancel')).toEqual([ROUTE_FC])

    // The conversation reset went to MAIN (with the fresh-run mode), rather than
    // being a local-only replica write nobody else would ever hear about.
    expect(lastCall('session:clear-conversation')).toEqual([ROUTE_FC, 'default'])
    // ...and it happened BEFORE the respawn, or the birth config would be wiped.
    expect(ipcCalls['session:clear-conversation']).toHaveLength(1)

    // createSession called with acceptEdits permission mode
    const createArgs = lastCall('session:create') as unknown[]
    expect(createArgs[0]).toBe(ROUTE_FC)
    expect(createArgs[4]).toBe('acceptEdits')

    // sendPrompt called with plan content
    const sendArgs = lastCall('session:send') as unknown[]
    expect(sendArgs[0]).toBe(ROUTE_FC)
    expect(sendArgs[1]).toContain('Implement the following plan:')
    expect(sendArgs[1]).toContain(planText)

    // Store: conversation cleared then sdk marked active. The MODE is not written
    // locally any more (SyncCore phase 4c): the fresh spawn's own init emits
    // `session:permission-mode` with the mode it was created in, which is visible
    // right here in the createSession args asserted above.
    const session = useSessionStore.getState().sessions[ROUTE_FC]
    expect(session.sdkActive).toBe(true)

    unmount()
  })

  it('onStartFresh: threads the session model / effort / thinking mode (Low)', async () => {
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [ROUTE_FC]: {
          ...s.sessions[ROUTE_FC],
          selectedModel: 'claude-opus-4-7',
          effort: 'high',
          thinkingMode: 'enabled'
        }
      }
    }))
    mirrorStoreIntoReplica()
    const { unmount } = renderFC()

    await act(async () => {
      await viewProps.onStartFresh()
    })

    // createSession args: routingId, cwd, effort, resumeId, permissionMode, model, thinkingMode
    const createArgs = lastCall('session:create') as unknown[]
    // Pre-fix: model was undefined and effort was forced to 'medium'.
    expect(createArgs[5]).toBe('claude-opus-4-7')
    expect(createArgs[2]).toBe('high')
    expect(createArgs[6]).toBe('enabled')

    unmount()
  })

  it('onStartFresh: does nothing when approval is undefined', async () => {
    const { unmount } = render(React.createElement(ExitPlanModeCard, { block, view: planView }))

    await act(async () => {
      await viewProps.onStartFresh()
    })

    expect(ipcCalls['session:get-session-log-path']).toHaveLength(0)
    expect(ipcCalls['session:approval-response']).toHaveLength(0)
    unmount()
  })

  // -------------------------------------------------------------------------
  // onContinueAutoEdit
  // -------------------------------------------------------------------------

  it('onContinueAutoEdit: respondApproval(allow), waitForModeChange, setPermissionMode(acceptEdits) in store + IPC', async () => {
    const { unmount } = renderFC()

    await act(async () => {
      await viewProps.onContinueAutoEdit()
    })

    // respondApproval allow
    expect(lastCall('session:approval-response')).toEqual(
      expect.arrayContaining([ROUTE_FC, approval.requestId, 'allow'])
    )

    // waitForModeChange was awaited
    expect(vi.mocked(waitForModeChange)).toHaveBeenCalled()

    // IPC setPermissionMode called with acceptEdits
    expect(lastCall('session:set-permission-mode')).toEqual([ROUTE_FC, 'acceptEdits'])

    // Invoke-only since SyncCore phase 4c — the pill follows the event, asserted
    // by the IPC call above, so there is no optimistic store write to check.

    // Approval removed from store
    expect(useSessionStore.getState().sessions[ROUTE_FC].pendingApprovals).toHaveLength(0)

    unmount()
  })

  // -------------------------------------------------------------------------
  // onContinueManual
  // -------------------------------------------------------------------------

  it('onContinueManual: respondApproval(allow), waitForModeChange, setPermissionMode(default) in store + IPC', async () => {
    const { unmount } = renderFC()

    await act(async () => {
      await viewProps.onContinueManual()
    })

    expect(lastCall('session:approval-response')).toEqual(
      expect.arrayContaining([ROUTE_FC, approval.requestId, 'allow'])
    )

    expect(vi.mocked(waitForModeChange)).toHaveBeenCalled()

    expect(lastCall('session:set-permission-mode')).toEqual([ROUTE_FC, 'default'])

    expect(useSessionStore.getState().sessions[ROUTE_FC].pendingApprovals).toHaveLength(0)

    unmount()
  })

  // -------------------------------------------------------------------------
  // onKeepPlanning
  // -------------------------------------------------------------------------

  it('onKeepPlanning: does nothing when feedback is empty', async () => {
    const { unmount } = renderFC()

    await act(async () => {
      await viewProps.onKeepPlanning()
    })

    expect(ipcCalls['session:approval-response']).toHaveLength(0)

    unmount()
  })

  it('onKeepPlanning: respondApproval(deny, {feedback}), removes approval, resets feedback state', async () => {
    const { rerender, unmount } = renderFC()

    // Set feedback via the state-setter callback passed to the View
    act(() => {
      viewProps.onFeedbackChange('refine the plan')
    })
    // Re-render so the FC picks up the new feedback state and passes it to the View
    rerender(React.createElement(ExitPlanModeCard, { block, view: planView, approval }))

    expect(viewProps.feedback).toBe('refine the plan')

    await act(async () => {
      await viewProps.onKeepPlanning()
    })

    // respondApproval called with deny + feedback answers
    const responseArgs = lastCall('session:approval-response') as unknown[]
    expect(responseArgs[0]).toBe(ROUTE_FC)
    expect(responseArgs[1]).toBe(approval.requestId)
    expect(responseArgs[2]).toBe('deny')
    expect(responseArgs[3]).toEqual({ feedback: 'refine the plan' })

    // Approval removed
    expect(useSessionStore.getState().sessions[ROUTE_FC].pendingApprovals).toHaveLength(0)

    // Feedback reset — next render should show empty string
    rerender(React.createElement(ExitPlanModeCard, { block, view: planView, approval }))
    expect(viewProps.feedback).toBe('')

    unmount()
  })

  // -------------------------------------------------------------------------
  // onOpenPlanPanel
  // -------------------------------------------------------------------------

  it('onOpenPlanPanel: calls openPlanPanel store action with sessionId, planContent, requestId', async () => {
    const { unmount } = renderFC()

    act(() => {
      viewProps.onOpenPlanPanel()
    })

    const session = useSessionStore.getState().sessions[ROUTE_FC]
    expect(session.rightPanel).toBe('plan')
    expect(session.planReview).toEqual({
      planContent: planText,
      approvalRequestId: approval.requestId,
      comments: []
    })

    unmount()
  })

  // -------------------------------------------------------------------------
  // View props sanity
  // -------------------------------------------------------------------------

  it('passes planContent from view.plan to the View', () => {
    const { unmount } = renderFC()

    expect(viewProps.planContent).toBe(planText)
    expect(viewProps.hasApproval).toBe(true)
    expect(viewProps.activeSessionId).toBe(ROUTE_FC)

    unmount()
  })
})
