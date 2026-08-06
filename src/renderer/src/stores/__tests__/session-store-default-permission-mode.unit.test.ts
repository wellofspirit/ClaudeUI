/**
 * Unit tests for `defaultPermissionMode` — the Settings autonomy-mode pick
 * (`~/.claude/settings.json#permissions.defaultMode`) reaching NEW sessions.
 *
 * Pre-fix this whole path was dead: `createEmptySession` hardcoded
 * `permissionMode: 'default'`, so a user who picked "Read-only (Plan)" in
 * Settings still got a `default`-mode session (the explicit mode is passed
 * straight through to `--permission-mode` at spawn), and cli.js's own
 * defaultMode never got a look-in.
 *
 * Deliberately NOT asserted: any effect on RUNNING sessions. defaultMode is a
 * bootstrap concern; live modes change only via setPermissionMode.
 *
 * Pattern: pure store state transitions, no React, no TestIpcBridge.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore, hydrateConfigFromDisk } from '../session-store'
import type { ClaudePermissions, EngineId, PermissionMode } from '../../../../shared/types'

const store = () => useSessionStore.getState()

function perms(defaultMode?: string): ClaudePermissions {
  return {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode
  }
}

/** Exactly what hydrateConfigFromDisk reads. */
function stubWindowApi(userPermissions: Promise<ClaudePermissions>): void {
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    loadSettings: vi.fn().mockResolvedValue({}),
    loadSessionConfig: vi.fn().mockResolvedValue({}),
    loadSlashCommands: vi.fn().mockResolvedValue([]),
    loadEngineConfig: vi.fn().mockResolvedValue({}),
    loadOpencodeSettings: vi.fn().mockResolvedValue({}),
    loadClaudePermissions: vi.fn(() => userPermissions),
    saveSettings: vi.fn(),
    saveSessionConfig: vi.fn(),
    logError: vi.fn()
  } as any
}

beforeEach(() => {
  stubWindowApi(Promise.resolve(perms()))
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    recentSessionIds: [],
    sessionEngines: {},
    availableModels: [],
    lastSelectedEngineId: 'claude' as EngineId,
    defaultPermissionMode: 'default'
  })
})

describe('hydrateConfigFromDisk → defaultPermissionMode', () => {
  it.each(['plan', 'acceptEdits', 'auto'] as PermissionMode[])(
    'adopts defaultMode "%s" from the user scope',
    async (mode) => {
      stubWindowApi(Promise.resolve(perms(mode)))
      await hydrateConfigFromDisk()
      expect(store().defaultPermissionMode).toBe(mode)
    }
  )

  it('falls back to "default" when defaultMode is unset', async () => {
    stubWindowApi(Promise.resolve(perms(undefined)))
    await hydrateConfigFromDisk()
    expect(store().defaultPermissionMode).toBe('default')
  })

  it('falls back to "default" for a mode with no ClaudeUI equivalent', async () => {
    stubWindowApi(Promise.resolve(perms('bypassPermissions')))
    await hydrateConfigFromDisk()
    expect(store().defaultPermissionMode).toBe('default')
  })

  it('falls back to "default" when the permissions read rejects', async () => {
    stubWindowApi(Promise.reject(new Error('no settings file')))
    useSessionStore.setState({ defaultPermissionMode: 'plan' })
    await hydrateConfigFromDisk()
    expect(store().defaultPermissionMode).toBe('default')
  })
})

describe('createNewSession seeds permissionMode from defaultPermissionMode', () => {
  it('uses the configured default (regression: was hardcoded "default")', () => {
    useSessionStore.setState({ defaultPermissionMode: 'plan' })
    store().createNewSession('rid-plan', '/repo')
    expect(store().sessions['rid-plan'].permissionMode).toBe('plan')
  })

  it('still yields "default" when nothing is configured', () => {
    store().createNewSession('rid-plain', '/repo')
    expect(store().sessions['rid-plain'].permissionMode).toBe('default')
  })

  it('picks up a setDefaultPermissionMode change without a reload', () => {
    store().createNewSession('rid-before', '/repo')
    store().setDefaultPermissionMode('acceptEdits')
    store().createNewSession('rid-after', '/repo')
    expect(store().sessions['rid-before'].permissionMode).toBe('default')
    expect(store().sessions['rid-after'].permissionMode).toBe('acceptEdits')
  })

  it('leaves an already-running session alone', () => {
    store().createNewSession('rid-live', '/repo')
    useSessionStore.setState({
      sessions: {
        ...store().sessions,
        'rid-live': { ...store().sessions['rid-live'], sdkActive: true }
      }
    })
    store().setDefaultPermissionMode('plan')
    expect(store().sessions['rid-live'].permissionMode).toBe('default')
  })
})
