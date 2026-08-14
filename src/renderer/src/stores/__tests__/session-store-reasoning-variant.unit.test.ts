/**
 * Layer 1 unit tests for session-store reasoningVariant field.
 *
 * Covers:
 * - setReasoningVariant sets the per-session field + calls the IPC
 * - setSelectedModel (model change) resets reasoningVariant to null
 * - the replica projected to a wire snapshot includes reasoningVariant in the session snapshot
 * - hydrateReplica (the replica's snapshot path) restores reasoningVariant from the snapshot
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'
import { getReplicaState } from '../replica'
import { toSnapshot } from '../../../../shared/sync/state'
import { resetFactoryCounter } from '@test/factories/messages'
import { hydrateReplica } from '@renderer/stores/replica'
import { resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

const store = () => useSessionStore.getState()

const ROUTE = 'r-reasoning-1'

// IPC mock — we need window.api.setReasoningVariant to be callable
const mockSetReasoningVariant = vi.fn()
const mockSaveSessionConfig = vi.fn()

beforeEach(() => {
  // The replica is a module singleton holding canonical state: resetting only the
  // store would leave the two disagreeing and the next projection would resurrect
  // the previous test's sessions (SyncCore phase 4c).
  resetReplicaSeam()
  resetFactoryCounter()
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: mockSaveSessionConfig,
    saveSettings: vi.fn(),
    setReasoningVariant: mockSetReasoningVariant,
    logError: vi.fn()
  } as any

  mockSetReasoningVariant.mockReset()
  mockSaveSessionConfig.mockReset()

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    recentSessionIds: [],
    availableModels: []
  })
  mirrorStoreIntoReplica()
})

function setupSession(routingId = ROUTE): void {
  store().createNewSession(routingId, '/test')
  useSessionStore.setState({ activeSessionId: routingId })
}

// ---------------------------------------------------------------------------
// setReasoningVariant
// ---------------------------------------------------------------------------

describe('setReasoningVariant', () => {
  it('sets the per-session reasoningVariant field', () => {
    setupSession()
    expect(store().sessions[ROUTE].reasoningVariant).toBeNull()

    store().setReasoningVariant('thinking')
    expect(store().sessions[ROUTE].reasoningVariant).toBe('thinking')
  })

  it('sets reasoningVariant to null (Default)', () => {
    setupSession()
    store().setReasoningVariant('high')
    expect(store().sessions[ROUTE].reasoningVariant).toBe('high')

    store().setReasoningVariant(null)
    expect(store().sessions[ROUTE].reasoningVariant).toBeNull()
  })

  it('accepts a routingId override to target a non-active session', () => {
    setupSession(ROUTE)
    store().createNewSession('other-session', '/other')

    store().setReasoningVariant('low', 'other-session')
    expect(store().sessions['other-session'].reasoningVariant).toBe('low')
    // Active session should be unaffected
    expect(store().sessions[ROUTE].reasoningVariant).toBeNull()
  })

  it('is a no-op when no session is active and no routingId provided', () => {
    // No session setup — no active session
    store().setReasoningVariant('thinking')
    expect(store().sessions).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Reset on model change
// ---------------------------------------------------------------------------

describe('reasoningVariant resets on model change', () => {
  it('setSelectedModel resets reasoningVariant to null', () => {
    setupSession()
    store().setReasoningVariant('thinking')
    expect(store().sessions[ROUTE].reasoningVariant).toBe('thinking')

    // setSelectedModel should reset reasoningVariant to null
    store().setSelectedModel('openai/o3-mini')
    expect(store().sessions[ROUTE].reasoningVariant).toBeNull()
  })

  it('setSelectedModel to same engine also resets reasoningVariant', () => {
    setupSession()
    // Start with an opencode engine session
    useSessionStore.setState({
      sessions: {
        [ROUTE]: {
          ...store().sessions[ROUTE],
          selectedEngineId: 'opencode',
          reasoningVariant: 'high'
        }
      }
    })
    mirrorStoreIntoReplica()
    expect(store().sessions[ROUTE].reasoningVariant).toBe('high')

    // Switching to another opencode model should still reset
    store().setSelectedModel('minimax/minimax-01')
    expect(store().sessions[ROUTE].reasoningVariant).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Remote snapshot includes reasoningVariant
// ---------------------------------------------------------------------------

describe('replica → wire snapshot', () => {
  it('includes reasoningVariant in the session snapshot', () => {
    setupSession()
    store().setReasoningVariant('xhigh')

    const snapshot = toSnapshot(getReplicaState(), 0)
    expect(snapshot.sessions[ROUTE]).toBeDefined()
    expect(snapshot.sessions[ROUTE].reasoningVariant).toBe('xhigh')
  })

  it('includes null reasoningVariant when default', () => {
    setupSession()

    const snapshot = toSnapshot(getReplicaState(), 0)
    expect(snapshot.sessions[ROUTE].reasoningVariant).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// hydrateReplica restores reasoningVariant
// ---------------------------------------------------------------------------

describe('hydrateReplica', () => {
  it('restores a non-null reasoningVariant from a remote snapshot', () => {
    setupSession()

    const snapshot = {
      seq: 1,
      sessions: {
        [ROUTE]: {
          routingId: ROUTE,
          cwd: '/test',
          messages: [],
          streamingText: '',
          streamingThinking: '',
          status: store().sessions[ROUTE].status,
          pendingApprovals: [],
          todos: [],
          taskNotifications: [],
          taskProgressMap: {},
          subagentMessages: {},
          subagentStreamingText: {},
          subagentStreamingThinking: {},
          permissionMode: 'default',
          effort: 'medium',
          thinkingMode: 'adaptive',
          reasoningVariant: 'thinking',
          statusLine: null,
          slashCommands: [],
          sdkSkillNames: []
        }
      },
      directories: [],
      activeSessionId: ROUTE,
      settings: {},
      recentSessionIds: [],
      pinnedSessionIds: [],
      customTitles: {},
      worktreeInfoMap: {}
    }

    hydrateReplica(snapshot as any)
    expect(store().sessions[ROUTE]?.reasoningVariant).toBe('thinking')
  })

  it('restores null reasoningVariant when absent from snapshot', () => {
    setupSession()

    const snapshot = {
      seq: 1,
      sessions: {
        [ROUTE]: {
          routingId: ROUTE,
          cwd: '/test',
          messages: [],
          streamingText: '',
          streamingThinking: '',
          status: store().sessions[ROUTE].status,
          pendingApprovals: [],
          todos: [],
          taskNotifications: [],
          taskProgressMap: {},
          subagentMessages: {},
          subagentStreamingText: {},
          subagentStreamingThinking: {},
          permissionMode: 'default',
          effort: null,
          thinkingMode: null,
          // reasoningVariant omitted
          statusLine: null,
          slashCommands: [],
          sdkSkillNames: []
        }
      },
      directories: [],
      activeSessionId: ROUTE,
      settings: {},
      recentSessionIds: [],
      pinnedSessionIds: [],
      customTitles: {},
      worktreeInfoMap: {}
    }

    hydrateReplica(snapshot as any)
    expect(store().sessions[ROUTE]?.reasoningVariant).toBeNull()
  })
})
