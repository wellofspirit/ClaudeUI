/**
 * H15 — remote snapshot must carry engine identity, and external session-config
 * syncs must not zero the engine map.
 *
 * Covers:
 * - the replica projected to a wire snapshot includes per-session sdkActive/selectedEngineId/
 *   selectedModel + top-level sessionEngines/hiddenSessions/hiddenProjects.
 * - hydrateReplica (the replica's snapshot path) round-trips all of them.
 * - applyExternalSessionConfig without a sessionEngines key leaves the existing
 *   map intact (the file-watcher payload strips it); with the key it overwrites.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'
import { getReplicaState } from '../replica'
import { toSnapshot } from '../../../../core/shared/sync/state'
import { resetFactoryCounter } from '@test/factories/messages'
import type { ModelRef } from '../../../../shared/types'
import { seed, resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import { hydrateReplica } from '@renderer/stores/replica'

const store = () => useSessionStore.getState()
const ROUTE = 'r-engine-1'
const OPENCODE_MODEL: ModelRef = {
  engineId: 'opencode',
  vendorId: 'openai',
  modelId: 'openai/gpt-5'
}

beforeEach(() => {
  // The replica is a module singleton holding canonical state: resetting only the
  // store would leave the two disagreeing and the next projection would resurrect
  // the previous test's sessions (SyncCore phase 4c).
  resetReplicaSeam()
  resetFactoryCounter()
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    logError: vi.fn()
  } as any

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {},
    hiddenSessionIds: [],
    hiddenProjectKeys: [],
    sessionEngines: {},
    availableModels: []
  })
  mirrorStoreIntoReplica()
})

function setupOpencodeSession(): void {
  store().createNewSession(ROUTE, '/test')
  useSessionStore.setState((s) => ({
    activeSessionId: ROUTE,
    sessions: {
      [ROUTE]: {
        ...s.sessions[ROUTE],
        sdkActive: true,
        selectedEngineId: 'opencode',
        selectedModel: 'openai/gpt-5'
      }
    },
    sessionEngines: { [ROUTE]: { engineId: 'opencode', model: OPENCODE_MODEL } },
    hiddenSessionIds: ['h-1'],
    hiddenProjectKeys: ['p-1']
  }))
  mirrorStoreIntoReplica()
}

describe('replica → wire snapshot — engine identity (H15)', () => {
  it('carries per-session sdkActive/selectedEngineId/selectedModel', () => {
    setupOpencodeSession()
    const snap = toSnapshot(getReplicaState(), 0)
    expect(snap.sessions[ROUTE].sdkActive).toBe(true)
    expect(snap.sessions[ROUTE].selectedEngineId).toBe('opencode')
    expect(snap.sessions[ROUTE].selectedModel).toBe('openai/gpt-5')
  })

  it('carries top-level sessionEngines + hidden lists', () => {
    setupOpencodeSession()
    const snap = toSnapshot(getReplicaState(), 0)
    expect(snap.sessionEngines![ROUTE].engineId).toBe('opencode')
    expect(snap.hiddenSessions).toEqual(['h-1'])
    expect(snap.hiddenProjects).toEqual(['p-1'])
  })
})

describe('hydrateReplica — engine identity round-trip (H15)', () => {
  it('restores sdkActive/selectedEngineId/selectedModel + sessionEngines + hidden lists', () => {
    setupOpencodeSession()
    const snap = toSnapshot(getReplicaState(), 0)

    // Simulate a fresh remote client: wipe everything, then apply the snapshot.
    useSessionStore.setState({
      sessions: {},
      sessionEngines: {},
      hiddenSessionIds: [],
      hiddenProjectKeys: []
    })
    mirrorStoreIntoReplica()
    hydrateReplica({ ...snap, seq: 1 } as any)

    const s = store()
    expect(s.sessions[ROUTE].sdkActive).toBe(true)
    expect(s.sessions[ROUTE].selectedEngineId).toBe('opencode')
    expect(s.sessions[ROUTE].selectedModel).toBe('openai/gpt-5')
    expect(s.sessionEngines[ROUTE]?.engineId).toBe('opencode')
    expect(s.hiddenSessionIds).toEqual(['h-1'])
    expect(s.hiddenProjectKeys).toEqual(['p-1'])
  })
})

describe('applyExternalSessionConfig — sessionEngines preservation (H15)', () => {
  it('leaves the existing map intact when the payload omits sessionEngines', () => {
    useSessionStore.setState({
      sessionEngines: { s1: { engineId: 'opencode', model: OPENCODE_MODEL } }
    })
    mirrorStoreIntoReplica()

    // File-watcher payload (sessions.json) — carries lists but NOT sessionEngines.
    seed.sessionsConfig({ recentSessions: ['a'], pinnedSessions: ['b'] })

    expect(store().sessionEngines).toEqual({ s1: { engineId: 'opencode', model: OPENCODE_MODEL } })
    // Present keys still applied.
    expect(store().recentSessionIds).toEqual(['a'])
    expect(store().pinnedSessionIds).toEqual(['b'])
  })

  it('overwrites sessionEngines only when the key is genuinely present', () => {
    useSessionStore.setState({
      sessionEngines: { s1: { engineId: 'opencode', model: OPENCODE_MODEL } }
    })
    mirrorStoreIntoReplica()
    seed.sessionsConfig({ sessionEngines: { s2: { engineId: 'pi' } } })
    expect(store().sessionEngines).toEqual({ s2: { engineId: 'pi' } })
  })
})
