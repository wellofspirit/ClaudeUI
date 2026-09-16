/**
 * Layer 1: Codex's configured session default (ADR-068 §6, Slice 5b).
 *
 * `engines/codex.json#codexConfig.defaultModel` is the Codex twin of
 * `piConfig.defaultModel`, with one rule the other engines do not have: a
 * CONFIGURED default IS an explicit choice (ADR-059), so the session it seeds
 * must carry `codexModelExplicit: true` — that flag is what puts the model on
 * the `turn/start` wire (`resolveSessionSdkOptions`). Left blank, nothing
 * changes: the session runs on whatever the working directory's native `model`
 * resolves to and the pill still reads "Native default".
 *
 * Pure store transitions, no React, no real binary.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore, resolveEngineDefaultModel } from '../session-store'
import type { EngineDefaultModels } from '../session-store'
import type { EngineId, ModelInfo } from '../../../../shared/types'
import { resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

const codexModel = (id: string): ModelInfo => ({
  value: id,
  displayName: id,
  description: '',
  engineId: 'codex',
  vendorId: 'openai'
})

const CATALOG: ModelInfo[] = [codexModel('gpt-5.6-codex'), codexModel('gpt-5.6-codex-mini')]

const defaults = (patch: Partial<EngineDefaultModels> = {}): EngineDefaultModels => ({
  opencodeDefaultModel: 'opencode/mimo-v2.5-free',
  opencodeDefaultModelConfigured: false,
  piDefaultModel: 'openai-codex/gpt-5.6-luna',
  piDefaultModelConfigured: false,
  codexDefaultModel: '',
  codexDefaultModelConfigured: false,
  ...patch
})

beforeEach(() => {
  resetReplicaSeam()
  ;(globalThis as unknown as { window: Window }).window = globalThis.window || ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    saveSlashCommands: vi.fn(),
    logError: vi.fn()
  }
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
    lastSelectedEngineId: 'codex' as EngineId,
    lastSelectedModelByEngine: {},
    availableModels: CATALOG,
    codexDefaultModel: '',
    codexDefaultModelConfigured: false,
    codexDefaultEffort: '',
    terminalGroups: {},
    activeView: { type: 'chat' }
  })
  mirrorStoreIntoReplica()
})

describe('resolveEngineDefaultModel — codex', () => {
  it('returns the configured default when the catalog still lists it', () => {
    expect(
      resolveEngineDefaultModel(
        'codex',
        CATALOG,
        defaults({ codexDefaultModel: 'gpt-5.6-codex-mini', codexDefaultModelConfigured: true })
      )
    ).toBe('gpt-5.6-codex-mini')
  })

  it('returns null — never a substitute — when the configured default is gone', () => {
    expect(
      resolveEngineDefaultModel(
        'codex',
        CATALOG,
        defaults({ codexDefaultModel: 'gpt-4.1-codex', codexDefaultModelConfigured: true })
      )
    ).toBeNull()
  })

  it('falls through to the first catalog entry when nothing is configured', () => {
    expect(resolveEngineDefaultModel('codex', CATALOG, defaults())).toBe('gpt-5.6-codex')
  })

  it('an EMPTY catalog still answers null, configured or not', () => {
    // Unlike opencode and pi, Codex owns this failure: an empty catalog means a
    // broken install OR a refused ChatGPT credential, and `createNewSession`
    // probes the vendor to say which. Passing a configured value through here
    // would swallow that banner.
    expect(resolveEngineDefaultModel('codex', [], defaults())).toBeNull()
    expect(
      resolveEngineDefaultModel(
        'codex',
        [],
        defaults({ codexDefaultModel: 'gpt-5.6-codex', codexDefaultModelConfigured: true })
      )
    ).toBeNull()
  })
})

describe('createNewSession — codex default model', () => {
  it('seeds the configured default and marks it EXPLICIT (ADR-059)', () => {
    useSessionStore.setState({
      codexDefaultModel: 'gpt-5.6-codex-mini',
      codexDefaultModelConfigured: true
    })
    mirrorStoreIntoReplica()
    store().createNewSession('cx-1', '/tmp/proj')
    expect(store().sessions['cx-1']?.selectedEngineId).toBe('codex')
    expect(store().sessions['cx-1']?.selectedModel).toBe('gpt-5.6-codex-mini')
    expect(store().sessions['cx-1']?.codexModelExplicit).toBe(true)
  })

  it('a blank default keeps today behaviour: catalog head, NOT explicit', () => {
    store().createNewSession('cx-2', '/tmp/proj')
    expect(store().sessions['cx-2']?.selectedModel).toBe('gpt-5.6-codex')
    expect(store().sessions['cx-2']?.codexModelExplicit).toBe(false)
  })

  it('a sticky pick still beats the configured default', () => {
    useSessionStore.setState({
      codexDefaultModel: 'gpt-5.6-codex-mini',
      codexDefaultModelConfigured: true,
      lastSelectedModelByEngine: { codex: 'gpt-5.6-codex' }
    })
    mirrorStoreIntoReplica()
    store().createNewSession('cx-3', '/tmp/proj')
    expect(store().sessions['cx-3']?.selectedModel).toBe('gpt-5.6-codex')
    expect(store().sessions['cx-3']?.codexModelExplicit).toBe(true)
  })

  it('an orphaned configured default leaves the picker unset and banners the model by name', () => {
    useSessionStore.setState({
      codexDefaultModel: 'gpt-4.1-codex',
      codexDefaultModelConfigured: true
    })
    mirrorStoreIntoReplica()
    store().createNewSession('cx-4', '/tmp/proj')
    expect(store().sessions['cx-4']?.selectedModel).toBe('')
    expect(store().sessions['cx-4']?.errors.join(' ')).toContain('gpt-4.1-codex')
  })
})

describe('setSelectedEngine — switching TO codex', () => {
  it('lands on the configured default, explicit', () => {
    useSessionStore.setState({
      lastSelectedEngineId: 'claude' as EngineId,
      codexDefaultModel: 'gpt-5.6-codex-mini',
      codexDefaultModelConfigured: true
    })
    mirrorStoreIntoReplica()
    store().createNewSession('cx-5', '/tmp/proj')
    store().setSelectedEngine('codex')
    expect(store().sessions['cx-5']?.selectedModel).toBe('gpt-5.6-codex-mini')
    expect(store().sessions['cx-5']?.codexModelExplicit).toBe(true)
  })

  it('an empty catalog keeps the DISCOVERY banner, not the stale-model one', async () => {
    // Codex owns this failure: an empty catalog is a broken install or a
    // refused ChatGPT credential, and only `vendorAuthProbe` tells them apart.
    // A configured default must not be named here — that advice ("pick another
    // model") is wrong when the catalog itself never arrived.
    const probe = vi.fn(async () => ({ openai: { authState: 'unauthenticated' } }))
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...(window as unknown as { api: Record<string, unknown> }).api,
      vendorAuthProbe: probe
    }
    useSessionStore.setState({
      lastSelectedEngineId: 'claude' as EngineId,
      availableModels: [],
      codexDefaultModel: 'gpt-5.6-codex',
      codexDefaultModelConfigured: true
    })
    mirrorStoreIntoReplica()
    store().createNewSession('cx-7', '/tmp/proj')
    store().setSelectedEngine('codex')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(probe).toHaveBeenCalledWith('codex')
    const errors = store().sessions['cx-7']?.errors.join(' ') ?? ''
    expect(errors).toContain('Sign in again')
    expect(errors).not.toContain('gpt-5.6-codex')
  })

  it('names the configured default when the catalog reported WITHOUT it', () => {
    useSessionStore.setState({
      lastSelectedEngineId: 'claude' as EngineId,
      codexDefaultModel: 'gpt-4.1-codex',
      codexDefaultModelConfigured: true
    })
    mirrorStoreIntoReplica()
    store().createNewSession('cx-8', '/tmp/proj')
    store().setSelectedEngine('codex')
    expect(store().sessions['cx-8']?.selectedModel).toBe('')
    expect(store().sessions['cx-8']?.errors.join(' ')).toContain('gpt-4.1-codex')
  })

  it('stays non-explicit when nothing is configured', () => {
    useSessionStore.setState({ lastSelectedEngineId: 'claude' as EngineId })
    mirrorStoreIntoReplica()
    store().createNewSession('cx-6', '/tmp/proj')
    store().setSelectedEngine('codex')
    expect(store().sessions['cx-6']?.selectedModel).toBe('gpt-5.6-codex')
    expect(store().sessions['cx-6']?.codexModelExplicit).toBe(false)
  })
})

describe('retrySend — codex effort (F15)', () => {
  const CATALOG_ROW = CATALOG.find((m) => m.engineId === 'codex')!
  function codexSessionWithEffort(effort: string | null): void {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        'codex-1': {
          ...useSessionStore.getState().sessions['codex-1'],
          cwd: '/tmp/x',
          selectedEngineId: 'codex' as EngineId,
          selectedModel: CATALOG_ROW.value,
          effort,
          messages: [],
          permissionMode: 'default',
          thinkingMode: null
        } as unknown as ReturnType<typeof useSessionStore.getState>['sessions'][string]
      }
    }))
  }
  function api(): {
    createSession: ReturnType<typeof vi.fn>
    sendPrompt: ReturnType<typeof vi.fn>
  } {
    const created = {
      createSession: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined)
    }
    Object.assign((window as unknown as { api: Record<string, unknown> }).api, created)
    return created
  }

  it('respawns with a pick the selected model publishes', async () => {
    useSessionStore.setState({
      availableModels: [
        { ...CATALOG_ROW, nativeEffortOptions: [{ value: 'high', description: '' }] }
      ]
    })
    codexSessionWithEffort('high')
    const { createSession } = api()
    await useSessionStore.getState().retrySend('codex-1', 'again')
    expect(createSession.mock.calls[0]?.[2]).toBe('high')
  })

  it('drops a pick the selected model does not publish, so the respawn is not refused', async () => {
    // The store keeps the user's last pick at every lifecycle stage; a model
    // switched on a started session skips the coercion, so the pick can be off
    // the new model's ladder and `CodexSession.validateEffort` would refuse it.
    useSessionStore.setState({
      availableModels: [
        { ...CATALOG_ROW, nativeEffortOptions: [{ value: 'low', description: '' }] }
      ]
    })
    codexSessionWithEffort('max')
    const { createSession } = api()
    await useSessionStore.getState().retrySend('codex-1', 'again')
    expect(createSession.mock.calls[0]?.[2]).toBeUndefined()
  })
})
