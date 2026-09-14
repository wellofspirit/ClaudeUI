/**
 * The renderer half of the verifier opt-in: `window.__claudeuiVerifier` must not
 * exist unless `window.api.verifierHooks === true`. A handle that leaked into
 * normal runs would park the whole session store (transcripts included) on a
 * global that any in-page script can read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installVerifierHooks, buildVerifierSnapshot } from '../verifier-hooks'
import { useSessionStore, EMPTY_SESSION_STATE } from '../../stores/session-store'
import type { ChatMessage } from '../../../../shared/types'

function fakeWindow(verifierHooks: unknown): Window {
  return { api: verifierHooks === undefined ? {} : { verifierHooks } } as unknown as Window
}

const msg = (id: string, role: ChatMessage['role']): ChatMessage => ({
  id,
  role,
  content: [],
  timestamp: 0
})

describe('installVerifierHooks', () => {
  it('installs nothing when the flag is false', () => {
    const w = fakeWindow(false)
    expect(installVerifierHooks(w)).toBe(false)
    expect(w.__claudeuiVerifier).toBeUndefined()
  })

  it('installs nothing when the api predates the field (undefined)', () => {
    const w = fakeWindow(undefined)
    expect(installVerifierHooks(w)).toBe(false)
    expect(w.__claudeuiVerifier).toBeUndefined()
  })

  it('installs nothing for a truthy non-true value — the gate is an identity check', () => {
    const w = fakeWindow('1')
    expect(installVerifierHooks(w)).toBe(false)
    expect(w.__claudeuiVerifier).toBeUndefined()
  })

  it('installs the handle when the flag is true', () => {
    const w = fakeWindow(true)
    expect(installVerifierHooks(w)).toBe(true)
    expect(w.__claudeuiVerifier?.sessionStore).toBe(useSessionStore)
    expect(typeof w.__claudeuiVerifier?.canonical).toBe('function')
    expect(typeof w.__claudeuiVerifier?.snapshot).toBe('function')
  })
})

describe('buildVerifierSnapshot', () => {
  const initial = useSessionStore.getState()

  beforeEach(() => {
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })
  afterEach(() => {
    useSessionStore.setState({
      activeSessionId: initial.activeSessionId,
      sessions: initial.sessions
    })
  })

  it('summarises message counts, roles and status.state, and is JSON-safe', () => {
    useSessionStore.setState({
      activeSessionId: 'sess-a',
      sessions: {
        'sess-a': {
          ...EMPTY_SESSION_STATE,
          messages: [
            msg('m1', 'user'),
            msg('m2', 'assistant'),
            msg('m3', 'assistant'),
            msg('m4', 'system')
          ],
          status: { ...EMPTY_SESSION_STATE.status, state: 'running' }
        }
      }
    })

    const snap = buildVerifierSnapshot()
    expect(snap.activeSessionId).toBe('sess-a')
    expect(snap.sessions).toEqual([
      {
        id: 'sess-a',
        messageCount: 4,
        roles: { user: 1, assistant: 2, system: 1 },
        state: 'running'
      }
    ])
    // Canonical is the replica's, untouched by a direct store write — which is
    // precisely the disagreement the snapshot exists to make visible.
    expect(snap.canonical.sessions).toEqual([])
    expect(() => JSON.stringify(snap)).not.toThrow()
  })
})
