/**
 * @vitest-environment node
 *
 * A session's idle timer is held while the session owns a RUNNING X-Agent (ADR-105 §3):
 * the timer's `cancel()` would drop the session object the run reports into. The dispatcher
 * arms it again through `rearmIdleTimer()` when the last run ends. `BaseSession` carries the
 * rule that Claude, opencode and pi override around.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineId } from '../../../shared/types'
import type { ResolvedCapabilities } from '../../../shared/model-capabilities'

vi.mock('../../services/sync-host', () => ({
  emitEvent: vi.fn(),
  addExtraSink: vi.fn(),
  removeExtraSink: vi.fn(),
  extraSinks: () => new Set()
}))
vi.mock('../../services/db', () => ({ dispatchedCostsByRouting: () => [] }))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { BaseSession } from '../BaseSession'
import { startRunningDispatch } from '../../../test/helpers/running-dispatch'

const cancel = vi.hoisted(() => vi.fn())

class ProbeSession extends BaseSession {
  readonly engineId: EngineId = 'pi'
  readonly capabilities = {} as ResolvedCapabilities
  busy = false
  live = true
  configureTimeout(ms: number): void {
    this.inactivityTimeoutMs = ms
  }
  get willQueue(): boolean {
    return this.busy
  }
  isEngineLive(): boolean {
    return this.live
  }
  getSessionId(): string | null {
    return null
  }
  async run(): Promise<void> {}
  async interrupt(): Promise<void> {}
  cancel(): void {
    cancel(this.routingId)
  }
  resolveApproval(): void {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  dispose(): void {}
}

const IDLE_MS = 1_000

describe('BaseSession — the idle timer and running X-Agents', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    cancel.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('a session with no running X-Agent still times out (baseline)', () => {
    const session = new ProbeSession('parent-a', null, '/cwd')
    session.setInactivityTimeout(IDLE_MS)
    vi.advanceTimersByTime(IDLE_MS + 1)
    expect(cancel).toHaveBeenCalledWith('parent-a')
  })

  it('does not fire while the session owns a running X-Agent, and fires after the last one ends and the dispatcher re-arms it', () => {
    const session = new ProbeSession('parent-b', null, '/cwd')
    const endRun = startRunningDispatch('parent-b')
    session.setInactivityTimeout(IDLE_MS)
    vi.advanceTimersByTime(10 * IDLE_MS)
    expect(cancel).not.toHaveBeenCalled()

    // The run ends: nothing re-arms by itself, the dispatcher asks.
    endRun()
    vi.advanceTimersByTime(10 * IDLE_MS)
    expect(cancel).not.toHaveBeenCalled()
    session.rearmIdleTimer()
    vi.advanceTimersByTime(IDLE_MS + 1)
    expect(cancel).toHaveBeenCalledWith('parent-b')
  })

  it('another parent’s running X-Agent holds nothing here', () => {
    const session = new ProbeSession('parent-c', null, '/cwd')
    const endRun = startRunningDispatch('someone-else')
    session.setInactivityTimeout(IDLE_MS)
    vi.advanceTimersByTime(IDLE_MS + 1)
    expect(cancel).toHaveBeenCalledWith('parent-c')
    endRun()
  })

  it('a re-arm that finds a run still going leaves the timer held', () => {
    const session = new ProbeSession('parent-d', null, '/cwd')
    // A timeout is configured, so the timer WOULD fire were it not held.
    session.configureTimeout(IDLE_MS)
    const endRun = startRunningDispatch('parent-d')
    session.rearmIdleTimer()
    vi.advanceTimersByTime(10 * IDLE_MS)
    expect(cancel).not.toHaveBeenCalled()
    endRun()
  })

  it('a re-arm does not start a timer under a busy turn or for a session whose engine is down', () => {
    const session = new ProbeSession('parent-e', null, '/cwd')
    session.configureTimeout(IDLE_MS) // sets the length without arming a timer
    session.busy = true
    session.rearmIdleTimer()
    vi.advanceTimersByTime(10 * IDLE_MS)
    expect(cancel).not.toHaveBeenCalled()

    session.busy = false
    session.live = false
    session.rearmIdleTimer()
    vi.advanceTimersByTime(10 * IDLE_MS)
    expect(cancel).not.toHaveBeenCalled()

    session.live = true
    session.rearmIdleTimer()
    vi.advanceTimersByTime(IDLE_MS + 1)
    expect(cancel).toHaveBeenCalledWith('parent-e')
  })
})
