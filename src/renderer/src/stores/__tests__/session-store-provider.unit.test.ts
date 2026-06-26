/**
 * Unit tests for engine persistence in session-store.
 *
 * Validates that:
 *   - selectedEngineId is written to sessionEngines on createNewSession
 *   - sessionEngines is carried over correctly through rekeySession
 *   - applyExternalSessionConfig restores sessionEngines from disk config
 *   - SessionStatus.model is a ModelRef and claudeModel() builds anthropic-vendored refs
 *   - The sessionProviders→sessionEngines read-migration path works correctly (incl. 'codex')
 *
 * Pattern: pure store state transitions, no React, no TestIpcBridge.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'
import type { EngineId } from '../../../../shared/types'
import { claudeModel } from '../../../../shared/types'

const store = () => useSessionStore.getState()
let saveSessionConfigSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  saveSessionConfigSpy = vi.fn()
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: saveSessionConfigSpy,
    saveSettings: vi.fn(),
    saveSlashCommands: vi.fn(),
    logError: vi.fn()
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
    lastSelectedEngineId: 'claude' as EngineId,
    terminalGroups: {},
    activeView: { type: 'chat' }
  })
})

// ---------------------------------------------------------------------------
// claudeModel() / ModelRef
// ---------------------------------------------------------------------------

describe('claudeModel helper', () => {
  it('builds an anthropic-vendored ModelRef', () => {
    const ref = claudeModel('claude-opus-4-8')
    expect(ref).toEqual({ engineId: 'claude', vendorId: 'anthropic', modelId: 'claude-opus-4-8' })
  })

  it('builds a default ModelRef', () => {
    const ref = claudeModel('default')
    expect(ref.engineId).toBe('claude')
    expect(ref.vendorId).toBe('anthropic')
    expect(ref.modelId).toBe('default')
  })
})

// ---------------------------------------------------------------------------
// Engine persistence: createNewSession
// ---------------------------------------------------------------------------

describe('engine persistence: createNewSession', () => {
  it('writes engineId to sessionEngines for the new session', () => {
    useSessionStore.setState({ lastSelectedEngineId: 'claude' as EngineId })
    store().createNewSession('r1', '/tmp/proj')
    // sessionEngines should have an entry for r1
    expect(store().sessionEngines['r1']).toBeDefined()
    expect(store().sessionEngines['r1'].engineId).toBe('claude')
  })

  it('selectedEngineId defaults to claude on newly created session when lastSelectedEngineId is claude', () => {
    useSessionStore.setState({ lastSelectedEngineId: 'claude' as EngineId })
    store().createNewSession('r4', '/tmp/proj')
    expect(store().sessions['r4']?.selectedEngineId).toBe('claude')
    expect(store().sessions['r4']?.status.engineId).toBe('claude')
  })

  it('SessionStatus.model seed is a ModelRef', () => {
    store().createNewSession('r1', '/tmp/proj')
    // The session starts with model: null in status (set before any session status arrives)
    // The seed persisted in sessionEngines.model is a ModelRef
    const modelEntry = store().sessionEngines['r1']?.model
    expect(modelEntry).toBeDefined()
    if (modelEntry) {
      expect(typeof modelEntry.engineId).toBe('string')
      expect(typeof modelEntry.vendorId).toBe('string')
      expect(typeof modelEntry.modelId).toBe('string')
    }
  })
})

// ---------------------------------------------------------------------------
// Engine persistence: rekeySession
// ---------------------------------------------------------------------------

describe('engine persistence: rekeySession', () => {
  it('carries sessionEngines entry over to the new key', () => {
    useSessionStore.setState({ lastSelectedEngineId: 'claude' as EngineId })
    store().createNewSession('claude-temp', '/tmp/proj')
    store().rekeySession('claude-temp', 'claude-real')
    // entry should be under the new key, not the old one
    expect(store().sessionEngines['claude-real']).toBeDefined()
    expect(store().sessionEngines['claude-temp']).toBeUndefined()
  })

  it('is a no-op when oldId === newId', () => {
    useSessionStore.setState({
      sessionEngines: { same: { engineId: 'claude' as EngineId } }
    })
    store().rekeySession('same', 'same')
    expect(store().sessionEngines['same']?.engineId).toBe('claude')
  })
})

// ---------------------------------------------------------------------------
// Engine persistence: applyExternalSessionConfig
// ---------------------------------------------------------------------------

describe('engine persistence: applyExternalSessionConfig', () => {
  it('restores sessionEngines from the config snapshot', () => {
    store().applyExternalSessionConfig({
      recentSessions: ['s1', 's2'],
      sessionEngines: { s1: { engineId: 'claude' as EngineId } }
    })
    expect(store().sessionEngines['s1']?.engineId).toBe('claude')
    expect(store().sessionEngines['s2']).toBeUndefined()
  })

  it('defaults sessionEngines to empty object when absent from config', () => {
    store().applyExternalSessionConfig({ recentSessions: [] })
    expect(store().sessionEngines).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// sessionProviders→sessionEngines migration (tested via ui-config migration,
// but we verify the store correctly accepts the post-migration sessionEngines shape)
// ---------------------------------------------------------------------------

describe('sessionEngines migration shape acceptance', () => {
  it('accepts migrated sessionEngines with engineId:claude (formerly codex or any value)', () => {
    // Simulate what loadSessionConfig() returns after migrating 'codex' → { engineId: 'claude' }
    store().applyExternalSessionConfig({
      sessionEngines: {
        'old-codex-session': { engineId: 'claude' as EngineId }
      }
    })
    expect(store().sessionEngines['old-codex-session']?.engineId).toBe('claude')
  })
})

// ---------------------------------------------------------------------------
// Model persistence: full write→rekey→reopen loop
// ---------------------------------------------------------------------------

describe('model persistence loop', () => {
  it('setSelectedModel records the real model into sessionEngines', () => {
    store().createNewSession('r1', '/tmp/proj') // sets activeSessionId = 'r1'
    store().setSelectedModel('claude-opus-4-8')
    expect(store().sessionEngines['r1']?.model?.modelId).toBe('claude-opus-4-8')
    expect(store().sessionEngines['r1']?.model?.engineId).toBe('claude')
    expect(store().sessionEngines['r1']?.model?.vendorId).toBe('anthropic')
  })

  it('rekeySession carries the chosen model to the canonical id', () => {
    store().createNewSession('r-temp', '/tmp/proj')
    store().setSelectedModel('claude-opus-4-8')
    store().rekeySession('r-temp', 'sess-uuid')
    expect(store().sessionEngines['sess-uuid']?.model?.modelId).toBe('claude-opus-4-8')
    expect(store().sessionEngines['r-temp']).toBeUndefined()
  })

  it('reopen (loadHistoricalSession) loads the ENGINE default, not the persisted model', () => {
    // No per-session sticky model: reopening always resets to the engine default.
    // Full loop: create → setModel → rekey → simulate fresh reopen.
    store().createNewSession('r-temp', '/tmp/proj')
    store().setSelectedModel('claude-opus-4-8')
    store().rekeySession('r-temp', 'sess-uuid')

    // Simulate a fresh launch: clear in-memory sessions but keep persisted config
    const persisted = store().sessionEngines
    useSessionStore.setState({ sessions: {}, activeSessionId: null, sessionEngines: persisted })

    store().loadHistoricalSession('sess-uuid', [], '/tmp/proj')
    // Engine is restored (claude), model resets to claude's default — NOT opus.
    expect(store().sessions['sess-uuid']?.selectedEngineId).toBe('claude')
    expect(store().sessions['sess-uuid']?.selectedModel).toBe('default')
  })

  it('reopening an opencode session loads the configured opencode default (never a Claude model)', () => {
    useSessionStore.setState({
      sessionEngines: { 'oc-x': { engineId: 'opencode' as EngineId } },
      opencodeDefaultModel: 'anthropic/claude-sonnet-4-6'
    })
    store().loadHistoricalSession('oc-x', [], '/tmp/proj')
    expect(store().sessions['oc-x']?.selectedEngineId).toBe('opencode')
    expect(store().sessions['oc-x']?.selectedModel).toBe('anthropic/claude-sonnet-4-6')
  })

  it('reopen falls back to default when no persisted model exists', () => {
    useSessionStore.setState({
      sessionEngines: { 'sess-x': { engineId: 'claude' as EngineId } }
    })
    store().loadHistoricalSession('sess-x', [], '/tmp/proj')
    expect(store().sessions['sess-x']?.selectedModel).toBe('default')
  })
})
