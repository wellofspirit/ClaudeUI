/**
 * An evicted session is still a conversation to RESUME (ADR-087 §2).
 *
 * Every lazy spawn chooses between `--resume <id>` and a brand-new conversation by
 * asking whether the session has a transcript. That used to be `messages.length >
 * 0`, true of anything that had one because it always held it. An evicted entry
 * holds none, so a prompt sent before the disk reload landed — or after it failed
 * — started a NEW conversation under a row the user believes they are continuing.
 *
 * The decision sites that live in components (`InputBox` send and push-to-talk,
 * `ReviewBar`) are pinned in their own component tests; this file owns the shared
 * predicate and the store action.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  clearViewEvicted,
  hasResumableTranscript,
  markViewEvicted,
  useSessionStore
} from '../session-store'
import { patchLocalSession } from '../replica'
import { resetReplicaSeam } from '@test/helpers/replica-seed'
import { makeAssistantMessage } from '@test/factories/messages'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

const createSession = vi.fn(async (..._args: unknown[]) => undefined)
const sendPrompt = vi.fn(async (..._args: unknown[]) => undefined)

beforeEach(() => {
  resetReplicaSeam()
  createSession.mockClear()
  sendPrompt.mockClear()
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: { createSession, sendPrompt, saveSessionConfig: vi.fn() }
  } as never
  useSessionStore.setState({ activeSessionId: null, sessions: {}, availableModels: [] })
})

describe('hasResumableTranscript', () => {
  const base = { messages: [], evicted: false, isHistorical: false }

  it('is false only for a session that genuinely has nothing to resume', () => {
    expect(hasResumableTranscript(base)).toBe(false)
  })

  it('is true for a held transcript, an evicted entry and a historical one', () => {
    expect(hasResumableTranscript({ ...base, messages: [makeAssistantMessage('hi')] })).toBe(true)
    expect(hasResumableTranscript({ ...base, evicted: true })).toBe(true)
    expect(hasResumableTranscript({ ...base, isHistorical: true })).toBe(true)
  })
})

describe('retrySend on an evicted, empty session', () => {
  function emptyClaudeSession(): void {
    patchLocalSession(
      'sess-1',
      { cwd: '/p', selectedEngineId: 'claude', selectedModel: 'default' },
      { create: true }
    )
  }

  it('control: a never-spawned empty session starts fresh', async () => {
    emptyClaudeSession()
    await store().retrySend('sess-1', 'again')
    // createSession args: routingId, cwd, effort, resumeId, ...
    expect(createSession.mock.calls[0]?.[3]).toBeUndefined()
  })

  it('resumes by id', async () => {
    emptyClaudeSession()
    markViewEvicted(['sess-1'])

    await store().retrySend('sess-1', 'again')

    expect(createSession.mock.calls[0]?.[3]).toBe('sess-1')
    expect(sendPrompt).toHaveBeenCalledWith('sess-1', 'again')
  })
})

describe('clearViewEvicted', () => {
  it('clears only entries that carry the flag, in one write', () => {
    patchLocalSession('a', {}, { create: true })
    patchLocalSession('b', {}, { create: true })
    markViewEvicted(['a'])
    const untouched = store().sessions['b']
    const listener = vi.fn()
    const off = useSessionStore.subscribe(listener)

    clearViewEvicted(['a', 'b', 'unknown'])
    off()

    expect(store().sessions['a'].evicted).toBe(false)
    expect(store().sessions['b']).toBe(untouched)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when nothing carries the flag', () => {
    patchLocalSession('a', {}, { create: true })
    const listener = vi.fn()
    const off = useSessionStore.subscribe(listener)

    clearViewEvicted(['a'])
    off()

    expect(listener).not.toHaveBeenCalled()
  })
})
