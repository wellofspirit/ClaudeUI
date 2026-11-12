/**
 * ADR-050: `disableAutoMode: "disable"` is Claude Code's own setting, and it
 * binds Claude sessions only. With it set, a Claude run starts in `default` at
 * every site that decides the starting mode: a new session, a reopened one, a
 * fork, a cleared conversation, an engine switch before the first prompt, and
 * the composer's preview. An opencode or pi run starts in `auto` whatever the
 * setting says: their auto mode is ClaudeUI's own and Claude's settings file
 * does not govern it. With the setting off every engine starts in `auto`.
 *
 * Pure store transitions, no React. The desktop and the browser client share
 * this store, so one spec covers both.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapPermissionMode, useSessionStore } from '../session-store'
import { seedLocalApp } from '../replica'
import { makeChatMessage } from '@test/factories/messages'
import { mirrorStoreIntoReplica, resetReplicaSeam, seed } from '@test/helpers/replica-seed'
import type { EngineId, ModelInfo } from '../../../../shared/types'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

const ENGINES: EngineId[] = ['claude', 'opencode', 'pi']

const MODEL: Record<EngineId, string> = {
  claude: 'claude-x',
  opencode: 'opencode/plain-free',
  pi: 'openai-codex/plain'
}

const MODELS = ENGINES.map(
  (engineId): ModelInfo =>
    ({
      value: MODEL[engineId],
      displayName: MODEL[engineId],
      description: '',
      engineId,
      vendorId: MODEL[engineId].split('/')[0]
    }) as ModelInfo
)

/**
 * Every engine with both values of the setting, and the mode a run must start
 * in: only Claude with the setting on is kept out of auto.
 */
const CASES = ENGINES.flatMap((engineId) => [
  { engineId, disabled: true, mode: engineId === 'claude' ? 'default' : 'auto' },
  { engineId, disabled: false, mode: 'auto' }
])

/**
 * The setting as it reaches the store in the app: through the replica (the
 * desktop's own hydrate, the host snapshot for a browser client).
 */
function setting(disabled: boolean): void {
  seedLocalApp({ autoModeDisabledBySettings: disabled })
}

/** A session on `engineId` that exists but has not spawned, in `mode`. */
function staged(routingId: string, engineId: EngineId, mode: 'auto' | 'default' | 'plan'): void {
  useSessionStore.setState({ lastSelectedEngineId: engineId })
  store().createNewSession(routingId, '/repo')
  useSessionStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [routingId]: {
        ...s.sessions[routingId],
        selectedEngineId: engineId,
        selectedModel: MODEL[engineId],
        permissionMode: mode,
        status: { ...s.sessions[routingId].status, engineId }
      }
    }
  }))
  mirrorStoreIntoReplica()
}

beforeEach(() => {
  resetReplicaSeam()
  localStorage.clear()
  ;(globalThis as any).window.api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    saveSlashCommands: vi.fn(),
    logError: vi.fn(),
    resolveForkAnchor: vi.fn().mockResolvedValue({ anchorUuid: 'anchor-1' }),
    clearConversation: vi.fn().mockResolvedValue(undefined)
  } as any
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    sessionEngines: {},
    availableModels: MODELS,
    opencodeDefaultModel: MODEL.opencode,
    opencodeDefaultModelConfigured: true,
    piDefaultModel: MODEL.pi,
    piDefaultModelConfigured: true,
    lastSelectedEngineId: 'claude',
    defaultPermissionMode: 'auto',
    // `resetReplicaSeam` empties the replica without projecting, so the store's
    // copy of the last test's value is reset here to match it.
    autoModeDisabledBySettings: false
  })
  mirrorStoreIntoReplica()
})

describe('the mode a run starts in, per engine and per value of the setting', () => {
  it.each(CASES)(
    'bootstrapPermissionMode ($engineId, disabled=$disabled) is $mode',
    ({ engineId, disabled, mode }) => {
      setting(disabled)
      // What the composer shows before a session exists, and what every site below calls.
      expect(bootstrapPermissionMode(store(), engineId)).toBe(mode)
    }
  )

  it.each(CASES)(
    'a new $engineId session (disabled=$disabled) starts in $mode',
    ({ engineId, disabled, mode }) => {
      setting(disabled)
      useSessionStore.setState({ lastSelectedEngineId: engineId })
      store().createNewSession('rid-new', '/repo')
      // Guards the test itself: an engine that fell back to claude would prove nothing.
      expect(store().sessions['rid-new'].selectedEngineId).toBe(engineId)
      expect(store().sessions['rid-new'].permissionMode).toBe(mode)
    }
  )

  it.each(CASES)(
    'a reopened $engineId session (disabled=$disabled) starts in $mode',
    ({ engineId, disabled, mode }) => {
      setting(disabled)
      const [vendorId, modelId] = MODEL[engineId].split('/')
      useSessionStore.setState({
        sessionEngines: {
          'rid-hist': {
            engineId,
            model: {
              engineId,
              vendorId: modelId ? vendorId : 'anthropic',
              modelId: modelId ?? vendorId
            }
          }
        }
      })
      mirrorStoreIntoReplica()
      store().loadHistoricalSession('rid-hist', [], '/repo')
      expect(store().sessions['rid-hist'].selectedEngineId).toBe(engineId)
      expect(store().sessions['rid-hist'].permissionMode).toBe(mode)
    }
  )

  it.each(CASES)(
    'a fork of a $engineId session (disabled=$disabled) starts in $mode, whatever the source held',
    async ({ engineId, disabled, mode }) => {
      staged('src', engineId, 'plan')
      seed.message('src', makeChatMessage({ id: 'm1', role: 'assistant' }))
      useSessionStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          src: {
            ...s.sessions['src'],
            status: {
              ...s.sessions['src'].status,
              capabilities: { ...s.sessions['src'].status.capabilities, forkFromMessage: true }
            }
          }
        }
      }))
      mirrorStoreIntoReplica()
      setting(disabled)

      const forkId = await store().forkFromMessage('src', 'm1')
      expect(forkId).toBeTruthy()
      expect(store().sessions[forkId!].selectedEngineId).toBe(engineId)
      expect(store().sessions[forkId!].permissionMode).toBe(mode)
    }
  )

  it.each(CASES)(
    'clearing a $engineId conversation (disabled=$disabled) sends $mode for the next run',
    async ({ engineId, disabled, mode }) => {
      staged('rid-clear', engineId, 'plan')
      setting(disabled)
      await store().clearConversation('rid-clear')
      expect(window.api.clearConversation).toHaveBeenCalledWith('rid-clear', mode)
    }
  )
})

describe('switching the engine of a session that has not started', () => {
  // The session sits in auto on an engine the setting does not bind; switched to
  // Claude it would spawn with a mode cli.js refuses, so the switch drops it.
  it.each(['opencode', 'pi'] as const)('%s to claude drops auto when the setting is on', (from) => {
    staged('rid-switch', from, 'auto')
    useSessionStore.setState({ activeSessionId: 'rid-switch' })
    setting(true)
    store().setSelectedEngine('claude')
    expect(store().sessions['rid-switch'].selectedEngineId).toBe('claude')
    expect(store().sessions['rid-switch'].permissionMode).toBe('default')
  })

  it.each([
    { from: 'opencode', to: 'pi' },
    { from: 'pi', to: 'opencode' }
  ] as const)('$from to $to keeps auto with the setting on: it is not theirs', ({ from, to }) => {
    staged('rid-switch', from, 'auto')
    useSessionStore.setState({ activeSessionId: 'rid-switch' })
    setting(true)
    store().setSelectedEngine(to)
    expect(store().sessions['rid-switch'].selectedEngineId).toBe(to)
    expect(store().sessions['rid-switch'].permissionMode).toBe('auto')
  })

  it.each([
    { from: 'claude', to: 'opencode' },
    { from: 'opencode', to: 'pi' },
    { from: 'pi', to: 'claude' }
  ] as const)('$from to $to keeps auto when the setting is off', ({ from, to }) => {
    staged('rid-switch', from, 'auto')
    useSessionStore.setState({ activeSessionId: 'rid-switch' })
    store().setSelectedEngine(to)
    expect(store().sessions['rid-switch'].selectedEngineId).toBe(to)
    expect(store().sessions['rid-switch'].permissionMode).toBe('auto')
  })
})

describe('what the setting does not touch', () => {
  it.each(ENGINES)('a non-auto default is left alone on %s', (engineId) => {
    setting(true)
    useSessionStore.setState({ defaultPermissionMode: 'acceptEdits' })
    expect(bootstrapPermissionMode(store(), engineId)).toBe('acceptEdits')
  })

  it.each(ENGINES)('a %s session already in auto keeps its mode', (engineId) => {
    // Nothing changes a running session's mode when the setting changes: ClaudeUI
    // does not, and cli.js re-reads rules on a settings change, not the mode.
    staged('rid-live', engineId, 'auto')
    useSessionStore.setState((s) => ({
      sessions: { ...s.sessions, 'rid-live': { ...s.sessions['rid-live'], sdkActive: true } }
    }))
    mirrorStoreIntoReplica()
    setting(true)
    expect(store().sessions['rid-live'].permissionMode).toBe('auto')
  })
})
