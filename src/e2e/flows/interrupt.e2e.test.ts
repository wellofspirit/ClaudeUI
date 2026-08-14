/**
 * Layer 3: E2E test — User interrupt mid-stream.
 *
 * User clicks stop mid-stream → session:interrupt IPC invoked → SDK yields no
 * further events → status transitions to idle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import { makeSessionStatus, resetFactoryCounter } from '@test/factories/messages'
import { createSdkStub } from '@test/stubs/sdk-stub'
import { textResponseSequence } from '@test/factories/sdk-events'
import type { ChatMessage, SessionStatus, StreamDelta } from '../../shared/types'

let app: TestApp
let eventCleanups: Array<() => void>
let interruptCalls: string[]

function wireEventHandlers(app: TestApp): Array<() => void> {
  const cleanups: Array<() => void> = []
  const store = useSessionStore.getState

  function onEvent<T extends (...args: never[]) => void>(channel: string): (cb: T) => () => void {
    return (cb: T) => {
      // Replicated + volatile channels arrive on the SYNC CLIENT since SyncCore
      // phase 4c, not the IPC bridge: `app.emit` feeds `SyncClient.receiveEvent`
      // with a ring seq, exactly as the MessagePort / WebSocket transports do.
      const cleanup = app.onSync(channel, cb as unknown as (...args: unknown[]) => void)
      cleanups.push(cleanup)
      return cleanup
    }
  }

  onEvent<(routingId: string, msg: ChatMessage) => void>('session:message')((routingId, msg) => {
    store().addMessage(routingId, msg)
  })
  onEvent<(routingId: string, data: StreamDelta) => void>('session:stream')((routingId, data) => {
    if (data.type === 'thinking') store().appendStreamingThinking(routingId, data.text)
    else store().appendStreamingText(routingId, data.text)
  })
  onEvent<(routingId: string, status: SessionStatus) => void>('session:status')(
    (routingId, status) => {
      let effective = routingId
      if (status.sessionId && status.sessionId !== routingId) {
        const s = store()
        if (s.sessions[routingId]) {
          s.rekeySession(routingId, status.sessionId)
          effective = status.sessionId
        }
      }
      if (status.state === 'disconnected') {
        store().markSdkInactive(effective)
        store().setStatus(effective, { ...status, state: 'idle' })
        store().clearPendingApprovals(effective)
        return
      }
      store().setStatus(effective, status)
      // Do NOT clear pending approvals on idle — background subagents outlive
      // the parent turn's result. See useClaudeEvents.ts's onStatus.
    }
  )
  onEvent<(routingId: string, data: { requestId: string }) => void>('session:approval-dismiss')(
    (routingId, { requestId }) => {
      store().removePendingApproval(routingId, requestId)
    }
  )

  return cleanups
}

beforeEach(async () => {
  resetFactoryCounter()
  interruptCalls = []
  app = await bootTestApp()

  // Spy on the interrupt IPC channel (renderer → main).
  app.bridge.ipcMain.removeHandler?.('session:interrupt')
  app.bridge.ipcMain.handle('session:interrupt', async (_: unknown, routingId: string) => {
    interruptCalls.push(routingId)
    // Mirror claude-session.ts's interrupt(): deny + dismiss every pending
    // approval directly, rather than relying on the subsequent idle status
    // to clear them (it no longer does — see the onStatus fix).
    const session = useSessionStore.getState().sessions[routingId]
    if (session) {
      for (const approval of session.pendingApprovals) {
        app.emit('session:approval-dismiss', routingId, { requestId: approval.requestId })
      }
    }
    return { ok: true, data: null }
  })

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {}
  })
  eventCleanups = wireEventHandlers(app)
})

afterEach(() => {
  eventCleanups.forEach((fn) => fn())
  app.teardown()
})

describe('E2E: interrupt', () => {
  it('user interrupts → interruptSession IPC invoked → no further events → idle', async () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'running', sessionId: routingId })
    )

    // Streaming in progress
    app.emit('session:stream', routingId, { type: 'text', text: 'thinking hard...' })
    expect(useSessionStore.getState().sessions[routingId].status.state).toBe('running')

    // User clicks stop
    await app.api.interruptSession(routingId)

    expect(interruptCalls).toEqual([routingId])

    // Main process would now yield no further stream events and emit status idle
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'idle', sessionId: routingId })
    )

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.status.state).toBe('idle')
    expect(session.pendingApprovals).toHaveLength(0)
  })

  it('SDK stub: abortController.abort() stops the generator from yielding remaining events', async () => {
    // Build an SDK stub with a known sequence. Abort the controller mid-iteration
    // and verify the generator halts without yielding the remaining events.
    const seq = textResponseSequence('s1', 'hello world this is a long answer')
    const { queryFn, tracker } = createSdkStub({ events: seq })
    const abortController = new AbortController()
    const gen = queryFn({ options: { abortController } }) as AsyncGenerator<unknown>

    const collected: unknown[] = []
    const iter = gen[Symbol.asyncIterator]()

    // Pull first two events, then interrupt via the query's interrupt() method
    const first = await iter.next()
    if (!first.done) collected.push(first.value)
    const second = await iter.next()
    if (!second.done) collected.push(second.value)

    await (gen as unknown as { interrupt(): Promise<void> }).interrupt()

    // Drain — should immediately be done due to interrupt flag

    while (true) {
      const next = await iter.next()
      if (next.done) break
      collected.push(next.value)
    }

    expect(collected.length).toBeLessThan(seq.length)
    expect(tracker.interrupts).toBe(1)
  })

  it('interrupt denies and dismisses pending approvals directly — not via the later idle status', async () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'running', sessionId: routingId })
    )

    // Pending approval in-flight
    useSessionStore.getState().addPendingApproval(routingId, {
      requestId: 'req-pending',
      toolName: 'Bash',
      input: {}
    })
    expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(1)

    // User interrupts — main's interrupt() denies + dismisses the approval
    // directly (see claude-session.ts). The card is gone before idle even
    // arrives.
    await app.api.interruptSession(routingId)
    expect(interruptCalls).toEqual([routingId])
    expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(0)

    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'idle', sessionId: routingId })
    )

    expect(useSessionStore.getState().sessions[routingId].status.state).toBe('idle')
  })

  it('idle alone does not clear an approval interrupt never touched (background subagent case)', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'running', sessionId: routingId })
    )

    useSessionStore.getState().addPendingApproval(routingId, {
      requestId: 'req-orphan',
      toolName: 'Bash',
      input: {}
    })

    // Status goes idle with NO interrupt/dismiss in between — e.g. a
    // background subagent's own approval outliving the parent turn's result.
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'idle', sessionId: routingId })
    )

    expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(1)
  })

  it('interrupt on inactive session does not crash', async () => {
    // Should not throw even if no session exists
    await expect(app.api.interruptSession('unknown-routing')).resolves.toBeDefined()
    expect(interruptCalls).toEqual(['unknown-routing'])
  })
})
