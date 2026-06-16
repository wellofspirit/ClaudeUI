/**
 * Unit tests for provider persistence in session-store (Phase 6).
 *
 * Validates that:
 *   - selectedProvider is written to sessionProviders on createNewSession
 *   - Claude ('claude') is the default and is NOT written to sessionProviders
 *   - sessionProviders is carried over through rekeySession
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

  it('writes to sessionProviders when provider is codex', () => {
    useSessionStore.setState({ lastSelectedProvider: 'codex' as ProviderId })
    store().createNewSession('r2', '/tmp/proj')
    expect(store().sessionProviders['r2']).toBe('codex')
    const lastCall = saveSessionConfigSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect((lastCall?.sessionProviders as Record<string, string>)?.['r2']).toBe('codex')
  })

  it('sets selectedProvider on the created session state', () => {
    useSessionStore.setState({ lastSelectedProvider: 'codex' as ProviderId })
    store().createNewSession('r3', '/tmp/proj')
    expect(store().sessions['r3']?.selectedProvider).toBe('codex')
    expect(store().sessions['r3']?.status.provider).toBe('codex')
  })

  it('selectedProvider defaults to claude on newly created session when lastSelectedProvider is claude', () => {
    useSessionStore.setState({ lastSelectedProvider: 'claude' as ProviderId })
    store().createNewSession('r4', '/tmp/proj')
    expect(store().sessions['r4']?.selectedProvider).toBe('claude')
  })
})

describe('provider persistence: rekeySession', () => {
  it('carries over codex provider from temporary routingId to canonical threadId', () => {
    // Set up: routingId 'temp' with codex provider
    useSessionStore.setState({
      lastSelectedProvider: 'codex' as ProviderId,
      sessionProviders: { temp: 'codex' as ProviderId }
    })
    store().createNewSession('temp', '/tmp/proj')
    // Rekey: temp → real-thread-id
    store().rekeySession('temp', 'real-thread-id')
    expect(store().sessionProviders['temp']).toBeUndefined()
    expect(store().sessionProviders['real-thread-id']).toBe('codex')
  })

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
      sessionProviders: { same: 'codex' as ProviderId }
    })
    store().rekeySession('same', 'same')
    // State should be unchanged
    expect(store().sessionProviders['same']).toBe('codex')
  })
})

describe('provider persistence: applyExternalSessionConfig', () => {
  it('restores sessionProviders from the config snapshot', () => {
    store().applyExternalSessionConfig({
      recentSessions: ['s1', 's2'],
      sessionProviders: { s1: 'codex' as ProviderId }
    })
    expect(store().sessionProviders['s1']).toBe('codex')
    expect(store().sessionProviders['s2']).toBeUndefined()
  })

  it('defaults sessionProviders to empty object when absent from config', () => {
    store().applyExternalSessionConfig({ recentSessions: [] })
    expect(store().sessionProviders).toEqual({})
  })
})
