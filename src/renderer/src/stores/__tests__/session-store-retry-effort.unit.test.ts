/**
 * Layer 1: the post-login retry respawn starts a Claude session at the SAME
 * effort the composer pill shows.
 *
 * The retry used to send `session.effort ?? undefined`: a session on the model's
 * starting effort (`effort === null`) respawned at cli.js's heuristic instead of
 * the effort the user configured. It now goes through the one shared resolver.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'
import type { ModelInfo } from '../../../../shared/types'
import { emitSync, resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

const OPUS: ModelInfo = {
  value: 'opus',
  resolvedModel: 'claude-opus-5-5', // built-in default: medium
  displayName: 'Opus 5.5',
  description: '',
  engineId: 'claude',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
}

let createSession: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetReplicaSeam()
  createSession = vi.fn(async () => undefined)
  ;(globalThis as unknown as { window: Window }).window = globalThis.window || ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    saveSlashCommands: vi.fn(),
    logError: vi.fn(),
    createSession,
    sendPrompt: vi.fn(async () => undefined)
  }
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    recentSessionIds: [],
    availableModels: [OPUS],
    settings: { ...useSessionStore.getState().settings, modelEffortDefaults: { opus: 'high' } }
  })
  mirrorStoreIntoReplica()
  useSessionStore.getState().createNewSession('rt-1', '/tmp/x')
})

function patchSession(patch: Record<string, unknown>): void {
  useSessionStore.setState((s) => ({
    sessions: { ...s.sessions, 'rt-1': { ...s.sessions['rt-1'], selectedModel: 'opus', ...patch } }
  }))
  mirrorStoreIntoReplica() // the fold below projects from the replica
}

describe('retrySend — Claude effort', () => {
  it("respawns at the model's saved starting effort when the session has no pick", async () => {
    patchSession({ effort: null })
    await useSessionStore.getState().retrySend('rt-1', 'again')
    expect(createSession.mock.calls[0]?.[2]).toBe('high')
    // The starting effort freezes into the session: announced with the spawn, so
    // a later change to the per-model value cannot re-label it.
    expect(createSession.mock.calls[0]?.[10]).toEqual({ effort: 'high', thinkingMode: null })
  })

  it("a session's own pick still wins, and is announced", async () => {
    patchSession({ effort: 'low' })
    await useSessionStore.getState().retrySend('rt-1', 'again')
    expect(createSession.mock.calls[0]?.[2]).toBe('low')
    expect(createSession.mock.calls[0]?.[10]).toEqual({ effort: 'low', thinkingMode: null })
  })

  it('an UNKNOWN model (empty catalog) announces no effort, so the pick survives the fold (GUARD)', async () => {
    useSessionStore.setState({ availableModels: [] })
    patchSession({ effort: 'low' })
    await useSessionStore.getState().retrySend('rt-1', 'again')
    const announce = createSession.mock.calls[0]?.[10] as Record<string, unknown>
    // Spawned at the session's own pick, announcing nothing about it: a `null`
    // here would clear it on every replica, this one included.
    expect(createSession.mock.calls[0]?.[2]).toBe('low')
    expect('effort' in announce).toBe(false)
    emitSync('session:created', ['rt-1', { cwd: '/tmp/x', ...announce }])
    expect(useSessionStore.getState().sessions['rt-1'].effort).toBe('low')
  })
})
