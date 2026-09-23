/**
 * Layer 1: Claude's configured session default (ADR-074 §8).
 *
 * `engines/claude.json#claudeConfig.defaultModel` is the Claude twin of
 * `piConfig.defaultModel`. The constraint that matters most is the one with
 * nothing configured: Claude never produced anything but `'default'` from
 * `resolveEngineDefaultModel` before, so that path must stay exactly as it was.
 * Configured, it follows the opencode/pi rule (ADR-059): a value the live list
 * no longer offers is `null` — unset picker plus a banner naming it — and an
 * empty (not yet fetched) list lets it through.
 *
 * Pure store transitions, no React, no real binary.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore, resolveEngineDefaultModel } from '../session-store'
import type { EngineDefaultModels } from '../session-store'
import type { EngineId, ModelInfo } from '../../../../shared/types'
import { resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

const claudeModel = (value: string, resolvedModel?: string): ModelInfo => ({
  value,
  displayName: value,
  description: '',
  engineId: 'claude',
  vendorId: 'anthropic',
  ...(resolvedModel ? { resolvedModel } : {})
})

const CATALOG: ModelInfo[] = [
  claudeModel('default', 'claude-opus-5[1m]'),
  claudeModel('opus[1m]', 'claude-opus-5[1m]'),
  claudeModel('sonnet', 'claude-sonnet-5'),
  claudeModel('haiku', 'claude-haiku-4-5-20251001')
]

const defaults = (patch: Partial<EngineDefaultModels> = {}): EngineDefaultModels => ({
  opencodeDefaultModel: 'opencode/mimo-v2.5-free',
  opencodeDefaultModelConfigured: false,
  piDefaultModel: 'openai-codex/gpt-5.6-luna',
  piDefaultModelConfigured: false,
  codexDefaultModel: '',
  codexDefaultModelConfigured: false,
  claudeDefaultModel: '',
  claudeDefaultModelConfigured: false,
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
    lastSelectedEngineId: 'claude' as EngineId,
    lastSelectedModelByEngine: {},
    availableModels: CATALOG,
    claudeDefaultModel: '',
    claudeDefaultModelConfigured: false,
    terminalGroups: {},
    activeView: { type: 'chat' }
  })
  mirrorStoreIntoReplica()
})

describe('resolveEngineDefaultModel — claude', () => {
  it("unset answers 'default', with or without a catalog — today's behaviour", () => {
    expect(resolveEngineDefaultModel('claude', CATALOG, defaults())).toBe('default')
    expect(resolveEngineDefaultModel('claude', [], defaults())).toBe('default')
  })

  it('configured and offered → the configured value', () => {
    expect(
      resolveEngineDefaultModel(
        'claude',
        CATALOG,
        defaults({ claudeDefaultModel: 'sonnet', claudeDefaultModelConfigured: true })
      )
    ).toBe('sonnet')
  })

  it('configured and gone from a non-empty catalog → null, never a substitute', () => {
    expect(
      resolveEngineDefaultModel(
        'claude',
        CATALOG,
        defaults({ claudeDefaultModel: 'claude-opus-4-7', claudeDefaultModelConfigured: true })
      )
    ).toBeNull()
  })

  it('configured with an empty catalog → passes through (discovery has not run)', () => {
    expect(
      resolveEngineDefaultModel(
        'claude',
        [],
        defaults({ claudeDefaultModel: 'claude-opus-4-7', claudeDefaultModelConfigured: true })
      )
    ).toBe('claude-opus-4-7')
  })

  it("ignores other engines' catalog rows when judging the Claude value", () => {
    const foreign: ModelInfo = { ...claudeModel('sonnet'), engineId: 'opencode' }
    expect(
      resolveEngineDefaultModel(
        'claude',
        [foreign, claudeModel('haiku')],
        defaults({ claudeDefaultModel: 'sonnet', claudeDefaultModelConfigured: true })
      )
    ).toBeNull()
  })
})

describe('createNewSession — claude default model', () => {
  it("unset seeds 'default' and raises nothing", () => {
    store().createNewSession('c-1', '/tmp/proj')
    expect(store().sessions['c-1']?.selectedEngineId).toBe('claude')
    expect(store().sessions['c-1']?.selectedModel).toBe('default')
    expect(store().sessions['c-1']?.errors).toEqual([])
  })

  it('seeds the configured default', () => {
    useSessionStore.setState({ claudeDefaultModel: 'sonnet', claudeDefaultModelConfigured: true })
    mirrorStoreIntoReplica()
    store().createNewSession('c-2', '/tmp/proj')
    expect(store().sessions['c-2']?.selectedModel).toBe('sonnet')
  })

  it('an orphaned configured default leaves the picker unset and banners it by name', () => {
    useSessionStore.setState({
      claudeDefaultModel: 'claude-opus-4-7',
      claudeDefaultModelConfigured: true
    })
    mirrorStoreIntoReplica()
    store().createNewSession('c-3', '/tmp/proj')
    expect(store().sessions['c-3']?.selectedModel).toBe('')
    const errors = store().sessions['c-3']?.errors.join(' ') ?? ''
    expect(errors).toContain('claude-opus-4-7')
    expect(errors).toContain('Default models')
  })

  it('a sticky pick still beats the configured default (the opencode/pi order)', () => {
    useSessionStore.setState({
      claudeDefaultModel: 'sonnet',
      claudeDefaultModelConfigured: true,
      lastSelectedModelByEngine: { claude: 'haiku' }
    })
    mirrorStoreIntoReplica()
    store().createNewSession('c-4', '/tmp/proj')
    expect(store().sessions['c-4']?.selectedModel).toBe('haiku')
  })
})

describe('setSelectedEngine — switching TO claude', () => {
  it("unset lands on 'default', as before", () => {
    useSessionStore.setState({ lastSelectedEngineId: 'codex' as EngineId })
    mirrorStoreIntoReplica()
    store().createNewSession('c-5', '/tmp/proj')
    useSessionStore.setState({ activeSessionId: 'c-5' })
    store().setSelectedEngine('claude')
    expect(store().sessions['c-5']?.selectedEngineId).toBe('claude')
    expect(store().sessions['c-5']?.selectedModel).toBe('default')
  })

  it('an orphaned configured default leaves the picker unset and banners it', () => {
    useSessionStore.setState({
      lastSelectedEngineId: 'codex' as EngineId,
      claudeDefaultModel: 'claude-opus-4-7',
      claudeDefaultModelConfigured: true
    })
    mirrorStoreIntoReplica()
    store().createNewSession('c-6', '/tmp/proj')
    useSessionStore.setState({ activeSessionId: 'c-6' })
    store().setSelectedEngine('claude')
    expect(store().sessions['c-6']?.selectedModel).toBe('')
    expect(store().sessions['c-6']?.errors.join(' ')).toContain('claude-opus-4-7')
  })
})

describe('setClaudeDefaultModel', () => {
  it('a value sets the flag, blank clears it', () => {
    store().setClaudeDefaultModel('sonnet')
    expect(store().claudeDefaultModel).toBe('sonnet')
    expect(store().claudeDefaultModelConfigured).toBe(true)
    store().setClaudeDefaultModel('')
    expect(store().claudeDefaultModel).toBe('')
    expect(store().claudeDefaultModelConfigured).toBe(false)
  })
})
