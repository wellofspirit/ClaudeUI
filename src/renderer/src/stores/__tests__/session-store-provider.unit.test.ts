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
import { useSessionStore, resolveOpencodeModel } from '../session-store'
import type { EngineId, ModelInfo } from '../../../../shared/types'
import { claudeModel } from '../../../../shared/types'

/** Minimal opencode ModelInfo builder for picker-value resolution tests. */
const ocModel = (vendorId: string, modelId: string): ModelInfo => ({
  value: `${vendorId}/${modelId}`,
  displayName: modelId,
  description: '',
  engineId: 'opencode',
  vendorId
})

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
// resolveOpencodeModel — picker-value resolution against available models
// ---------------------------------------------------------------------------

describe('resolveOpencodeModel', () => {
  const models: ModelInfo[] = [
    { value: 'default', displayName: 'Default', description: '' }, // claude (engineId undefined)
    ocModel('opencode', 'mimo-v2.5-free'),
    ocModel('openai', 'gpt-5.4')
  ]

  it('returns the preferred model when it is available', () => {
    expect(resolveOpencodeModel(models, 'openai/gpt-5.4')).toBe('openai/gpt-5.4')
  })

  it('prefers a free OpenCode Zen model when the preferred is unavailable', () => {
    // preferred points at a removed/disabled model → fall to the free zen vendor.
    expect(resolveOpencodeModel(models, 'qwen-sandbox/qwen3.6:27b')).toBe('opencode/mimo-v2.5-free')
  })

  it('falls back to the first opencode model when no free zen vendor is present', () => {
    const noZen = [models[0], ocModel('openai', 'gpt-5.4'), ocModel('openai', 'gpt-5.4-mini')]
    expect(resolveOpencodeModel(noZen, 'opencode/gone')).toBe('openai/gpt-5.4')
  })

  it('returns null when there are no opencode models at all (claude-only list)', () => {
    expect(resolveOpencodeModel([models[0]], 'opencode/mimo-v2.5-free')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// createNewSession — engine validation + opencode default resolution
// ---------------------------------------------------------------------------

describe('createNewSession: opencode engine/model validation', () => {
  it('falls back to claude when the remembered engine is opencode but no opencode model is available', () => {
    // The desync regression: remembered engine = opencode (e.g. its provider was
    // later disabled), so nothing opencode is discoverable. Seeding opencode would
    // show a Claude model in the picker while routing send to a phantom model.
    useSessionStore.setState({
      lastSelectedEngineId: 'opencode' as EngineId,
      availableModels: [{ value: 'default', displayName: 'Default', description: '' }]
    })
    store().createNewSession('oc-none', '/tmp/proj')
    expect(store().sessions['oc-none']?.selectedEngineId).toBe('claude')
    expect(store().sessions['oc-none']?.selectedModel).toBe('default')
    expect(store().sessionEngines['oc-none']?.engineId).toBe('claude')
  })

  it('resolves to a free zen model when the configured default points at a disabled provider', () => {
    useSessionStore.setState({
      lastSelectedEngineId: 'opencode' as EngineId,
      opencodeDefaultModel: 'opencode/mimo-v2.5-free', // its provider is "disabled" → absent below
      availableModels: [ocModel('opencode', 'nemotron-3-ultra-free'), ocModel('openai', 'gpt-5.4')]
    })
    store().createNewSession('oc-zen', '/tmp/proj')
    expect(store().sessions['oc-zen']?.selectedEngineId).toBe('opencode')
    expect(store().sessions['oc-zen']?.selectedModel).toBe('opencode/nemotron-3-ultra-free')
  })

  it('honors the configured default when it is available', () => {
    useSessionStore.setState({
      lastSelectedEngineId: 'opencode' as EngineId,
      opencodeDefaultModel: 'openai/gpt-5.4',
      availableModels: [ocModel('opencode', 'mimo-v2.5-free'), ocModel('openai', 'gpt-5.4')]
    })
    store().createNewSession('oc-cfg', '/tmp/proj')
    expect(store().sessions['oc-cfg']?.selectedModel).toBe('openai/gpt-5.4')
    expect(store().sessions['oc-cfg']?.selectedEngineId).toBe('opencode')
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

  it('reopen (loadHistoricalSession) restores the persisted per-session model', () => {
    // Per-session memory: reopening brings back the model last used in it.
    // Full loop: create → setModel → rekey → simulate fresh reopen.
    store().createNewSession('r-temp', '/tmp/proj')
    store().setSelectedModel('claude-opus-4-8')
    store().rekeySession('r-temp', 'sess-uuid')

    // Simulate a fresh launch: clear in-memory sessions but keep persisted config
    const persisted = store().sessionEngines
    useSessionStore.setState({ sessions: {}, activeSessionId: null, sessionEngines: persisted })

    store().loadHistoricalSession('sess-uuid', [], '/tmp/proj')
    expect(store().sessions['sess-uuid']?.selectedEngineId).toBe('claude')
    expect(store().sessions['sess-uuid']?.selectedModel).toBe('claude-opus-4-8')
  })

  it('reopening an opencode session restores its persisted opencode model', () => {
    useSessionStore.setState({
      sessionEngines: {
        'oc-x': {
          engineId: 'opencode' as EngineId,
          model: { engineId: 'opencode', vendorId: 'qwen-sandbox', modelId: 'qwen3.6:27b' }
        }
      }
    })
    store().loadHistoricalSession('oc-x', [], '/tmp/proj')
    expect(store().sessions['oc-x']?.selectedEngineId).toBe('opencode')
    expect(store().sessions['oc-x']?.selectedModel).toBe('qwen-sandbox/qwen3.6:27b')
  })

  it('reopen with NO persisted model falls back to the engine default (never Claude on opencode)', () => {
    // Fresh load: a Claude session with no stored model → claude default.
    useSessionStore.setState({
      sessionEngines: { 'sess-x': { engineId: 'claude' as EngineId } }
    })
    store().loadHistoricalSession('sess-x', [], '/tmp/proj')
    expect(store().sessions['sess-x']?.selectedModel).toBe('default')

    // An opencode session with no stored model → the configured opencode default,
    // NOT Claude's 'default' (the original bug).
    useSessionStore.setState({
      sessionEngines: { 'oc-y': { engineId: 'opencode' as EngineId } },
      opencodeDefaultModel: 'anthropic/claude-sonnet-4-6'
    })
    store().loadHistoricalSession('oc-y', [], '/tmp/proj')
    expect(store().sessions['oc-y']?.selectedEngineId).toBe('opencode')
    expect(store().sessions['oc-y']?.selectedModel).toBe('anthropic/claude-sonnet-4-6')
  })
})
