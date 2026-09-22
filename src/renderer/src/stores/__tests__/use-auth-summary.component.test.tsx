/**
 * The one adapter between the pure `summarizeAuthIssues` and the store
 * (ADR-070 §4) — and the two properties `auth-issues.ts` deliberately left to
 * it: the `inUse` scope, and a RESULT that is referentially stable.
 *
 * The stability half is not cosmetic. The pill lives in the top bar, so a
 * selector that re-minted its answer on every store update would re-render the
 * bar on every streamed token — the same trap `blamedSessions` carries its own
 * comment about.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSessionStore } from '../session-store'
import { useAuthSummary } from '../use-auth-summary'
import type { AuthSummary } from '../auth-issues'
import type { ChatMessage } from '../../../../shared/types'

vi.mock('electron', async () => await import('../../../../test/stubs/electron-shim'))

const CLAUDE = 'r-summary-claude'
const CODEX = 'r-summary-codex'

function installApi(): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform: 'web',
    saveSessionConfig: vi.fn(),
    createSession: vi.fn(async () => ({ ok: true }))
  }
}

/** Tests are exempt from the sealed-field lint rule; this is the fixture seam. */
function patch(routingId: string, fields: Record<string, unknown>): void {
  useSessionStore.setState((s) => ({
    sessions: { ...s.sessions, [routingId]: { ...s.sessions[routingId], ...fields } }
  }))
}

function seed(): void {
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    signInDialog: null,
    authState: null,
    vendorOAuth: null,
    providerAuth: { anthropic: 'unknown', chatgpt: 'unknown', chatgptRoutes: {} }
  })
}

/** Renders the hook and hands back every answer it produced, newest last. */
function observe(): AuthSummary[] {
  const seen: AuthSummary[] = []
  function Probe(): null {
    seen.push(useAuthSummary())
    return null
  }
  render(<Probe />)
  return seen
}

beforeEach(() => {
  installApi()
  seed()
})
afterEach(cleanup)

describe('useAuthSummary — `inUse` comes from the sessions that exist', () => {
  it('a Claude-only install reports nothing about an empty ChatGPT vault', () => {
    useSessionStore.getState().createNewSession(CLAUDE, '/tmp/a')
    useSessionStore.setState({
      providerAuth: { anthropic: 'authenticated', chatgpt: 'unauthenticated', chatgptRoutes: {} }
    })
    const seen = observe()
    expect(seen.at(-1)?.tone).toBe('none')
    expect(seen.at(-1)?.issues).toEqual([])
  })

  it('a Codex session is what puts the ChatGPT credential in scope', () => {
    useSessionStore.getState().createNewSession(CODEX, '/tmp/b')
    patch(CODEX, { selectedEngineId: 'codex', selectedModel: 'gpt-5.6-sol' })
    useSessionStore.setState({
      providerAuth: { anthropic: 'authenticated', chatgpt: 'unauthenticated', chatgptRoutes: {} }
    })
    const seen = observe()
    expect(seen.at(-1)?.tone).toBe('needed')
    expect(seen.at(-1)?.issues.map((issue) => issue.providerId)).toEqual(['chatgpt'])
  })

  it("honours the engine's route gate — pi on a disabled ChatGPT route is not in use", () => {
    useSessionStore.getState().createNewSession(CODEX, '/tmp/b')
    patch(CODEX, { selectedEngineId: 'pi', selectedModel: 'openai-codex/gpt-5.6-luna' })
    useSessionStore.setState({
      providerAuth: {
        anthropic: 'authenticated',
        chatgpt: 'unauthenticated',
        chatgptRoutes: { pi: false }
      }
    })
    expect(observe().at(-1)?.tone).toBe('none')

    cleanup()
    useSessionStore.setState((s) => ({
      providerAuth: { ...s.providerAuth, chatgptRoutes: { pi: true } }
    }))
    expect(observe().at(-1)?.tone).toBe('needed')
  })
})

describe('useAuthSummary — the answer is referentially stable', () => {
  /**
   * THE guard for the memoisation. A streamed token is an ordinary store
   * update; if either input were re-minted per update the top bar would
   * re-render on each one, which is what the selector's shape exists to
   * prevent.
   */
  it('a store update that touches no auth fact returns the identical object', () => {
    useSessionStore.getState().createNewSession(CLAUDE, '/tmp/a')
    const seen = observe()
    const before = seen.at(-1)

    act(() => {
      patch(CLAUDE, {
        messages: [
          { id: 'm1', role: 'assistant', content: [], timestamp: 0 } as unknown as ChatMessage
        ]
      })
    })
    act(() => {
      patch(CLAUDE, { draftText: 'still streaming' })
    })

    expect(seen.at(-1)).toBe(before)
  })

  it('but a new auth fact does produce a new answer', () => {
    useSessionStore.getState().createNewSession(CLAUDE, '/tmp/a')
    const seen = observe()
    const before = seen.at(-1)

    act(() => {
      patch(CLAUDE, { authRequired: { providerId: 'anthropic' } })
    })

    expect(seen.at(-1)).not.toBe(before)
    expect(seen.at(-1)?.tone).toBe('expired')
  })
})
