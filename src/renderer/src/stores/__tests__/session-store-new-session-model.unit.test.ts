/**
 * Layer 1: "New sessions start on" (providers-v3 slice 9, owner ruling
 * 2026-09-23).
 *
 * `settings.newSessionModel` decides whether the model last picked on an engine
 * (the sticky pick) or the engine's configured default seeds a new session.
 * Absent is `'last-picked'`, today's behaviour, and must stay byte-identical.
 * `'configured-default'` ignores the sticky pick for SEEDING only — it is still
 * recorded — so the configured default, or the engine's built-in one, wins.
 *
 * Pure store transitions, no React, no real binary.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore, seedingModelPicks, type NewSessionModel } from '../session-store'
import type { EngineId, ModelInfo } from '../../../../shared/types'
import { resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

const model = (engineId: EngineId, value: string): ModelInfo => ({
  value,
  displayName: value,
  description: '',
  engineId,
  vendorId: engineId === 'codex' ? 'openai' : 'anthropic'
})

const CATALOG: ModelInfo[] = [
  model('claude', 'default'),
  model('claude', 'sonnet'),
  model('claude', 'haiku'),
  model('codex', 'gpt-5.6-codex'),
  model('codex', 'gpt-5.6-codex-mini')
]

function setup(opts: {
  engine: EngineId
  mode?: NewSessionModel
  sticky?: Partial<Record<EngineId, string>>
  patch?: Record<string, unknown>
}): void {
  useSessionStore.setState({
    lastSelectedEngineId: opts.engine,
    lastSelectedModelByEngine: opts.sticky ?? {},
    settings: {
      ...store().settings,
      newSessionModel: opts.mode
    },
    ...opts.patch
  })
  mirrorStoreIntoReplica()
}

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
    availableModels: CATALOG,
    claudeDefaultModel: '',
    claudeDefaultModelConfigured: false,
    codexDefaultModel: '',
    codexDefaultModelConfigured: false,
    codexDefaultEffort: '',
    terminalGroups: {},
    activeView: { type: 'chat' }
  })
  mirrorStoreIntoReplica()
})

describe('seedingModelPicks', () => {
  it('is the recorded map by default, and none at all for the configured default', () => {
    const recorded = { claude: 'haiku' }
    expect(seedingModelPicks({ settings: {}, lastSelectedModelByEngine: recorded })).toBe(recorded)
    expect(
      seedingModelPicks({
        settings: { newSessionModel: 'last-picked' },
        lastSelectedModelByEngine: recorded
      })
    ).toBe(recorded)
    const none = seedingModelPicks({
      settings: { newSessionModel: 'configured-default' },
      lastSelectedModelByEngine: recorded
    })
    expect(none).toEqual({})
    // A stable reference, so a store selector over it does not loop.
    expect(
      seedingModelPicks({
        settings: { newSessionModel: 'configured-default' },
        lastSelectedModelByEngine: { claude: 'sonnet' }
      })
    ).toBe(none)
  })
})

describe('createNewSession — which model a new session starts on', () => {
  const configuredClaude = { claudeDefaultModel: 'sonnet', claudeDefaultModelConfigured: true }

  it("'last-picked' (and absent): the sticky pick wins, as today", () => {
    for (const mode of [undefined, 'last-picked'] as const) {
      setup({ engine: 'claude', mode, sticky: { claude: 'haiku' }, patch: configuredClaude })
      store().createNewSession(`c-${mode}`, '/tmp/proj')
      expect(store().sessions[`c-${mode}`]?.selectedModel).toBe('haiku')
    }
  })

  it("'configured-default': the configured default wins over an AVAILABLE sticky pick", () => {
    setup({
      engine: 'claude',
      mode: 'configured-default',
      sticky: { claude: 'haiku' },
      patch: configuredClaude
    })
    store().createNewSession('c-1', '/tmp/proj')
    expect(store().sessions['c-1']?.selectedModel).toBe('sonnet')
    // The pick is still recorded — only not used for seeding.
    expect(store().lastSelectedModelByEngine.claude).toBe('haiku')
  })

  it("'configured-default' with nothing configured: the built-in default", () => {
    setup({ engine: 'claude', mode: 'configured-default', sticky: { claude: 'haiku' } })
    store().createNewSession('c-2', '/tmp/proj')
    expect(store().sessions['c-2']?.selectedModel).toBe('default')
  })

  it('Codex: the explicit flag follows what actually seeded', () => {
    // Sticky wins → explicit (a model the user chose).
    setup({ engine: 'codex', sticky: { codex: 'gpt-5.6-codex-mini' } })
    store().createNewSession('cx-1', '/tmp/proj')
    expect(store().sessions['cx-1']?.selectedModel).toBe('gpt-5.6-codex-mini')
    expect(store().sessions['cx-1']?.codexModelExplicit).toBe(true)

    // Configured default ignores the pick; nothing configured → the catalog
    // head, NOT explicit, so Codex's own layers decide.
    setup({ engine: 'codex', mode: 'configured-default', sticky: { codex: 'gpt-5.6-codex-mini' } })
    store().createNewSession('cx-2', '/tmp/proj')
    expect(store().sessions['cx-2']?.selectedModel).toBe('gpt-5.6-codex')
    expect(store().sessions['cx-2']?.codexModelExplicit).toBe(false)

    // …and a CONFIGURED Codex default seeds, explicit.
    setup({
      engine: 'codex',
      mode: 'configured-default',
      sticky: { codex: 'gpt-5.6-codex' },
      patch: { codexDefaultModel: 'gpt-5.6-codex-mini', codexDefaultModelConfigured: true }
    })
    store().createNewSession('cx-3', '/tmp/proj')
    expect(store().sessions['cx-3']?.selectedModel).toBe('gpt-5.6-codex-mini')
    expect(store().sessions['cx-3']?.codexModelExplicit).toBe(true)
  })

  it("Codex: a sticky pick gone from the catalog is not a stale-default error under 'configured-default'", () => {
    setup({ engine: 'codex', mode: 'configured-default', sticky: { codex: 'gpt-4.1-codex' } })
    store().createNewSession('cx-4', '/tmp/proj')
    expect(store().sessions['cx-4']?.selectedModel).toBe('gpt-5.6-codex')
    expect(store().sessions['cx-4']?.errors).toEqual([])
  })
})
