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
  vendorId: 'anthropic'
})

const CATALOG: ModelInfo[] = [
  model('claude', 'default'),
  model('claude', 'sonnet'),
  model('claude', 'haiku')
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
})
