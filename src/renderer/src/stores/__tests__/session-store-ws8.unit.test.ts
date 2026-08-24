/**
 * WS8 guard tests for session-store: engine identity on local historical
 * load + fork (gpt#3), inactive-transcript eviction + re-hydration (Opus B),
 * rekey (xhigh#9) and per-session draft attachments (gpt#14).
 *
 * Pure store-level tests — drive actions via useSessionStore.getState().
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'
import { makeChatMessage } from '@test/factories/messages'
import type { DirectoryGroup } from '../../../../shared/types'
import { seed, resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

function onDisk(sessionId: string, cwd = '/p'): DirectoryGroup[] {
  return [
    {
      cwd,
      projectKey: 'pk',
      folderName: 'p',
      sessions: [{ sessionId, cwd, projectKey: 'pk', title: 't', timestamp: 0, lastActivityAt: 0 }]
    }
  ]
}

beforeEach(() => {
  // The replica is a module singleton holding canonical state: resetting only the
  // store would leave the two disagreeing and the next projection would resurrect
  // the previous test's sessions (SyncCore phase 4c).
  resetReplicaSeam()
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    saveSlashCommands: vi.fn(),
    logError: vi.fn(),
    resolveForkAnchor: vi.fn()
  } as any

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {},
    hiddenSessionIds: [],
    hiddenProjectKeys: [],
    sessionEngines: {},
    availableModels: [],
    terminalGroups: {},
    activeView: { type: 'chat' }
  })
  mirrorStoreIntoReplica()
})

// ---------------------------------------------------------------------------
// Engine identity on LOCAL historical load (gpt#3)
// ---------------------------------------------------------------------------

describe('loadHistoricalSession — engine identity (gpt#3)', () => {
  it('restores status.engineId from the persisted engine, not Claude defaults', () => {
    useSessionStore.setState({
      sessionEngines: {
        s1: { engineId: 'pi', model: { engineId: 'pi', vendorId: 'openai-codex', modelId: 'x' } }
      }
    })
    mirrorStoreIntoReplica()
    store().loadHistoricalSession('s1', [], '/p')
    const sess = store().sessions['s1']
    // Pre-fix, status.engineId stayed 'claude' while only selectedEngineId flipped.
    expect(sess.selectedEngineId).toBe('pi')
    expect(sess.status.engineId).toBe('pi')
  })

  it('seeds capabilities for the restored engine (opencode ≠ Claude default caps)', () => {
    useSessionStore.setState({
      sessionEngines: {
        s2: {
          engineId: 'opencode',
          model: { engineId: 'opencode', vendorId: 'anthropic', modelId: 'claude' }
        }
      }
    })
    mirrorStoreIntoReplica()
    store().loadHistoricalSession('s2', [], '/p')
    const caps = store().sessions['s2'].status.capabilities
    // opencode does not support Claude-only fork-from-message; Claude default does.
    expect(caps.forkFromMessage).toBe(false)
  })

  it('claude sessions still load as claude (no regression)', () => {
    store().loadHistoricalSession('s3', [], '/p')
    expect(store().sessions['s3'].status.engineId).toBe('claude')
    expect(store().sessions['s3'].selectedEngineId).toBe('claude')
  })
})

// ---------------------------------------------------------------------------
// Engine identity on fork (gpt#3)
// ---------------------------------------------------------------------------

describe('forkFromMessage — engine identity (gpt#3)', () => {
  it('inherits the source engine into status + sessionEngines (no Claude fallback)', async () => {
    // Build a pi source session that supports fork-from-message.
    store().createNewSession('src', '/p')
    seed.message('src', makeChatMessage({ id: 'm1', role: 'assistant' }))
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        src: {
          ...s.sessions['src'],
          selectedEngineId: 'pi',
          selectedModel: 'openai-codex/gpt',
          status: {
            ...s.sessions['src'].status,
            engineId: 'pi',
            capabilities: { ...s.sessions['src'].status.capabilities, forkFromMessage: true }
          }
        }
      }
    }))
    mirrorStoreIntoReplica()
    ;(window.api.resolveForkAnchor as any).mockResolvedValue({ anchorUuid: 'anchor-1' })

    const newId = await store().forkFromMessage('src', 'm1')
    expect(newId).toBeTruthy()
    const forked = store().sessions[newId!]
    // Pre-fix, the fork used createEmptySession defaults → selectedEngineId 'claude'.
    expect(forked.selectedEngineId).toBe('pi')
    expect(forked.status.engineId).toBe('pi')
    expect(store().sessionEngines[newId!]?.engineId).toBe('pi')
  })
})

// ---------------------------------------------------------------------------
// Eviction + re-hydration (Opus B)
// ---------------------------------------------------------------------------

describe('evict cold sessions on switch, re-hydrate on reselect (Opus B)', () => {
  function seedColdAndActive(): void {
    store().createNewSession('cold', '/p')
    seed.message('cold', makeChatMessage({ id: 'c1', content: [{ type: 'text', text: 'hi' }] }))
    store().createNewSession('active', '/p')
    seed.message('active', makeChatMessage({ id: 'a1' }))
    // Keep 'cold' out of the last-N recent set, on disk, with an unsent draft.
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        cold: { ...s.sessions['cold'], draftText: 'keep me', effort: 'high' }
      },
      directories: onDisk('cold'),
      recentSessionIds: ['active'],
      activeSessionId: 'active'
    }))
    mirrorStoreIntoReplica()
  }

  it('evicts a cold on-disk session heavy arrays but preserves the lightweight entry', () => {
    seedColdAndActive()
    store().switchSession('active')

    const cold = store().sessions['cold']
    expect(cold.evicted).toBe(true)
    expect(cold.messages).toHaveLength(0)
    // Lightweight fields survive eviction.
    expect(cold.draftText).toBe('keep me')
    expect(cold.effort).toBe('high')
    // The active session is never evicted.
    expect(store().sessions['active'].evicted).toBe(false)
    expect(store().sessions['active'].messages.length).toBeGreaterThan(0)
  })

  it('re-hydration restores messages and preserves the preserved draft', () => {
    seedColdAndActive()
    store().switchSession('active')
    expect(store().sessions['cold'].evicted).toBe(true)

    // Reselect → Sidebar's disk-load path calls loadHistoricalSession.
    store().loadHistoricalSession('cold', [makeChatMessage({ id: 'c1' })], '/p')
    const cold = store().sessions['cold']
    expect(cold.evicted).toBe(false)
    expect(cold.messages).toHaveLength(1)
    expect(cold.draftText).toBe('keep me')
  })

  it('never evicts a session that is not on disk (not reloadable)', () => {
    store().createNewSession('fresh', '/p')
    seed.message('fresh', makeChatMessage({ id: 'f1' }))
    store().createNewSession('active', '/p')
    seed.message('active', makeChatMessage({ id: 'a1' }))
    useSessionStore.setState({
      directories: [],
      recentSessionIds: ['active'],
      activeSessionId: 'active'
    })

    store().switchSession('active')
    // 'fresh' has no on-disk transcript → must keep its messages.
    expect(store().sessions['fresh'].evicted).toBe(false)
    expect(store().sessions['fresh'].messages).toHaveLength(1)
  })

  it('never evicts a running (sdkActive) or watched session', () => {
    store().createNewSession('running', '/p')
    seed.message('running', makeChatMessage({ id: 'r1' }))
    store().markSdkActive('running')
    store().createNewSession('active', '/p')
    seed.message('active', makeChatMessage({ id: 'a1' }))
    useSessionStore.setState({
      directories: onDisk('running'),
      recentSessionIds: ['active'],
      activeSessionId: 'active'
    })

    store().switchSession('active')
    expect(store().sessions['running'].evicted).toBe(false)
    expect(store().sessions['running'].messages).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Rekey (xhigh#9, re-expressed for SyncCore phase 4c)
// ---------------------------------------------------------------------------
//
// `resolveRoutingId` + its bounded `rekeyMap` are DELETED. They existed because the
// renderer rekeyed its own store and then had to translate events the main process
// was still emitting under the old id. Core owns the rekey now: it applies
// `rekeyTargetFor` to canonical state and re-keys its own session registry in the
// SAME tick it emits the `session:status` that implies one, so every later event
// already carries the new id. What remains testable — and is what the deleted
// helper was really protecting — is that a rekey leaves no ghost behind.

describe('rekey (session:status carrying a stable sessionId)', () => {
  it('moves the session entry and leaves no ghost under the stale id', () => {
    store().createNewSession('old', '/p')
    seed.message('old', makeChatMessage({ id: 'before' }))
    seed.rekey('old', 'new')

    expect(store().sessions['old']).toBeUndefined()
    expect(store().sessions['new'].messages.some((m) => m.id === 'before')).toBe(true)
    expect(store().activeSessionId).toBe('new')
  })

  it('carries the recents / engine-map entries to the new id', () => {
    store().createNewSession('old', '/p')
    seed.rekey('old', 'new')

    expect(store().recentSessionIds).toContain('new')
    expect(store().recentSessionIds).not.toContain('old')
    expect(store().sessionEngines['new']).toBeDefined()
    expect(store().sessionEngines['old']).toBeUndefined()
  })

  it('a post-rekey event lands on the new session', () => {
    store().createNewSession('old', '/p')
    seed.rekey('old', 'new')
    seed.message('new', makeChatMessage({ id: 'late' }))

    expect(store().sessions['new'].messages.some((m) => m.id === 'late')).toBe(true)
    expect(store().sessions['old']).toBeUndefined()
  })
})
