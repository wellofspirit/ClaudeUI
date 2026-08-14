/**
 * Take-back contract (ADR-053).
 *
 * The pre-fix path was `dequeueMessage(blob)` → `removed > 0 ? restore : clear
 * anyway`. Both branches cleared the card, so the "already executing" case
 * silently erased a message that then ran unseen — one of the four stacked
 * defects behind the ghost-message class. `recallQueuedInto` never clears
 * anything: `session:queue-changed` is the only thing that moves items off the
 * card.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../../../../stores/session-store'
import { recallQueuedInto } from '../recall-queued'
import type { QueuedItem } from '../../../../../../shared/types'
import { seed, resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

const ROUTE = 'r-recall'
const recallQueued = vi.fn()

const queued = (itemId: string, text: string): QueuedItem => ({ itemId, text, state: 'queued' })

beforeEach(() => {
  // The replica is a module singleton holding canonical state: resetting only the
  // store would leave the two disagreeing and the next projection would resurrect
  // the previous test's sessions (SyncCore phase 4c).
  resetReplicaSeam()
  recallQueued.mockReset()
  ;(globalThis as unknown as { window: unknown }).window = globalThis.window || {}
  ;(globalThis.window as unknown as { api: unknown }).api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    logError: vi.fn(),
    recallQueued
  }
  useSessionStore.setState({ activeSessionId: null, sessions: {} })
  mirrorStoreIntoReplica()
  useSessionStore.getState().createNewSession(ROUTE, '/test')
  useSessionStore.setState({ activeSessionId: ROUTE })
  seed.queue(ROUTE, [queued('q1', 'first'), queued('q2', 'second')])
})

describe('recallQueuedInto', () => {
  it('joins the recalled texts with a newline into the draft', async () => {
    recallQueued.mockResolvedValue({ recalled: ['first', 'second'], notRecalled: 0 })
    const setDraft = vi.fn()

    await recallQueuedInto(ROUTE, setDraft)

    expect(recallQueued).toHaveBeenCalledWith(ROUTE)
    expect(setDraft).toHaveBeenCalledWith('first\nsecond')
    expect(useSessionStore.getState().sessions[ROUTE].warnings).toEqual([])
  })

  it('a partially-recalled queue warns and leaves the un-recalled item on the card', async () => {
    recallQueued.mockResolvedValue({ recalled: ['second'], notRecalled: 1 })
    const setDraft = vi.fn()

    await recallQueuedInto(ROUTE, setDraft)

    expect(setDraft).toHaveBeenCalledWith('second')
    const session = useSessionStore.getState().sessions[ROUTE]
    // Pre-fix this cleared the card regardless of the outcome.
    expect(session.queuedItems.map((i) => i.text)).toEqual(['first', 'second'])
    expect(session.warnings).toHaveLength(1)
    expect(session.warnings[0]).toMatch(/1 queued message is already being executed/)
  })

  it('nothing recallable: no draft write, and the card is untouched', async () => {
    recallQueued.mockResolvedValue({ recalled: [], notRecalled: 2 })
    const setDraft = vi.fn()

    await recallQueuedInto(ROUTE, setDraft)

    expect(setDraft).not.toHaveBeenCalled()
    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.queuedItems).toHaveLength(2)
    expect(session.warnings[0]).toMatch(/2 queued messages are already being executed/)
  })

  it('a failed IPC leaves the queue visible instead of swallowing the text', async () => {
    recallQueued.mockRejectedValue(new Error('disconnected'))
    const setDraft = vi.fn()

    await expect(recallQueuedInto(ROUTE, setDraft)).resolves.toBeUndefined()

    expect(setDraft).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[ROUTE].queuedItems).toHaveLength(2)
  })

  it('is a no-op with no active session', async () => {
    const setDraft = vi.fn()
    await recallQueuedInto(null, setDraft)
    expect(recallQueued).not.toHaveBeenCalled()
    expect(setDraft).not.toHaveBeenCalled()
  })
})
