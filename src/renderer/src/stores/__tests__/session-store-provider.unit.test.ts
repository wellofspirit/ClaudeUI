/**
 * Unit tests for provider persistence in session-store.
 *
 * Validates that:
 *   - selectedProvider is NOT written to sessionProviders when it's the default ('claude')
 *   - sessionProviders is carried over correctly through rekeySession
 *   - applyExternalSessionConfig restores sessionProviders from disk config
 *
 * Pattern: pure store state transitions, no React, no TestIpcBridge.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'
import type { ProviderId } from '../../../../shared/types'

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
    sessionProviders: {},
    lastSelectedProvider: 'claude' as ProviderId,
    terminalGroups: {},
    activeView: { type: 'chat' }
  })
})

describe('provider persistence: createNewSession', () => {
  it('does NOT write to sessionProviders when provider is claude (default)', () => {
    useSessionStore.setState({ lastSelectedProvider: 'claude' })
    store().createNewSession('r1', '/tmp/proj')
    expect(store().sessionProviders).toEqual({})
    // saveSessionConfig should still be called but without sessionProviders key for 'r1'
    const lastCall = saveSessionConfigSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(lastCall?.sessionProviders).toEqual({})
  })

  it('selectedProvider defaults to claude on newly created session when lastSelectedProvider is claude', () => {
    useSessionStore.setState({ lastSelectedProvider: 'claude' as ProviderId })
    store().createNewSession('r4', '/tmp/proj')
    expect(store().sessions['r4']?.selectedProvider).toBe('claude')
    expect(store().sessions['r4']?.status.provider).toBe('claude')
  })
})

describe('provider persistence: rekeySession', () => {
  it('does not create a sessionProviders entry when rekying a claude session', () => {
    useSessionStore.setState({ lastSelectedProvider: 'claude' as ProviderId })
    store().createNewSession('claude-temp', '/tmp/proj')
    store().rekeySession('claude-temp', 'claude-real')
    // claude sessions should not appear in sessionProviders
    expect(store().sessionProviders['claude-real']).toBeUndefined()
    expect(store().sessionProviders['claude-temp']).toBeUndefined()
  })

  it('is a no-op when oldId === newId', () => {
    useSessionStore.setState({
      sessionProviders: { same: 'claude' as ProviderId }
    })
    store().rekeySession('same', 'same')
    expect(store().sessionProviders['same']).toBe('claude')
  })
})

describe('provider persistence: applyExternalSessionConfig', () => {
  it('restores sessionProviders from the config snapshot', () => {
    store().applyExternalSessionConfig({
      recentSessions: ['s1', 's2'],
      sessionProviders: { s1: 'claude' as ProviderId }
    })
    expect(store().sessionProviders['s1']).toBe('claude')
    expect(store().sessionProviders['s2']).toBeUndefined()
  })

  it('defaults sessionProviders to empty object when absent from config', () => {
    store().applyExternalSessionConfig({ recentSessions: [] })
    expect(store().sessionProviders).toEqual({})
  })
})
