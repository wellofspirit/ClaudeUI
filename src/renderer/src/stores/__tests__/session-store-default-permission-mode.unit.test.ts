/**
 * Unit tests for `defaultPermissionMode` — the Settings autonomy-mode pick
 * reaching NEW sessions.
 *
 * Two behaviours are under test, and they used to be one:
 *
 * 1. The pick is now a ClaudeUI-owned setting (`settings.defaultAutonomyMode`),
 *    NOT `~/.claude/settings.json#permissions.defaultMode`. Claude's file is
 *    read exactly once, to SEED that setting for profiles that predate it —
 *    upstream's "pinned defaults are preserved" rule when auto mode became the
 *    default. Once seeded, the two are independent.
 *
 * 2. The shipped default is `auto`, for every engine — but only where auto can
 *    actually run. `createNewSession` degrades it to 'default' when the engine
 *    or the account can't do auto, so an impossible mode never reaches
 *    `--permission-mode` at spawn.
 *
 * Deliberately NOT asserted: any effect on RUNNING sessions. defaultMode is a
 * bootstrap concern; live modes change only via setPermissionMode.
 *
 * Pattern: pure store state transitions, no React, no TestIpcBridge.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore, hydrateConfigFromDisk } from '../session-store'
import type { ClaudePermissions, EngineId, ModelInfo } from '../../../../shared/types'

const store = () => useSessionStore.getState()

function perms(defaultMode?: string, disableAutoMode?: string): ClaudePermissions {
  return {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode,
    disableAutoMode
  }
}

const saveSettings = vi.fn()

/** Exactly what hydrateConfigFromDisk reads. */
function stubWindowApi(
  userPermissions: Promise<ClaudePermissions>,
  savedSettings: Record<string, unknown> = {}
): void {
  saveSettings.mockClear()
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    loadSettings: vi.fn().mockResolvedValue(savedSettings),
    loadSessionConfig: vi.fn().mockResolvedValue({}),
    loadSlashCommands: vi.fn().mockResolvedValue([]),
    loadEngineConfig: vi.fn().mockResolvedValue({}),
    loadOpencodeSettings: vi.fn().mockResolvedValue({}),
    loadClaudePermissions: vi.fn(() => userPermissions),
    saveSettings,
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
    defaultPermissionMode: 'default',
    autoModeDisabledBySettings: false
  })
})

describe('hydrateConfigFromDisk → defaultPermissionMode', () => {
  it('defaults to "auto" when the profile has expressed no preference', async () => {
    stubWindowApi(Promise.resolve(perms(undefined)))
    await hydrateConfigFromDisk()
    expect(store().defaultPermissionMode).toBe('auto')
    expect(store().settings.defaultAutonomyMode).toBe('full')
  })

  it.each(['plan', 'acceptEdits', 'auto'])(
    'preserves a pinned Claude defaultMode "%s" by seeding it once',
    async (mode) => {
      stubWindowApi(Promise.resolve(perms(mode)))
      await hydrateConfigFromDisk()
      expect(store().defaultPermissionMode).toBe(mode)
    }
  )

  it('preserves a pinned "default" rather than upgrading it to auto', async () => {
    stubWindowApi(Promise.resolve(perms('default')))
    await hydrateConfigFromDisk()
    expect(store().defaultPermissionMode).toBe('default')
    expect(store().settings.defaultAutonomyMode).toBe('ask')
  })

  it('persists the seed, so a later Claude defaultMode change cannot re-seed', async () => {
    stubWindowApi(Promise.resolve(perms('plan')))
    await hydrateConfigFromDisk()
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ defaultAutonomyMode: 'plan' })
    )
  })

  it('adopts the auto default for a mode with no ClaudeUI equivalent', async () => {
    // bypassPermissions is MORE permissive than classifier-gated auto, so
    // seeding the default here only ever de-escalates.
    stubWindowApi(Promise.resolve(perms('bypassPermissions')))
    await hydrateConfigFromDisk()
    expect(store().defaultPermissionMode).toBe('auto')
  })

  it('adopts the auto default when the permissions read rejects', async () => {
    stubWindowApi(Promise.reject(new Error('no settings file')))
    useSessionStore.setState({ defaultPermissionMode: 'plan' })
    await hydrateConfigFromDisk()
    expect(store().defaultPermissionMode).toBe('auto')
  })

  it('lets an already-seeded ClaudeUI setting win over Claude defaultMode', async () => {
    stubWindowApi(Promise.resolve(perms('plan')), { defaultAutonomyMode: 'autoEdit' })
    await hydrateConfigFromDisk()
    expect(store().defaultPermissionMode).toBe('acceptEdits')
    // Already seeded — must not be re-persisted from Claude's file.
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('records a settings-level disableAutoMode', async () => {
    stubWindowApi(Promise.resolve(perms(undefined, 'disable')))
    await hydrateConfigFromDisk()
    expect(store().autoModeDisabledBySettings).toBe(true)
  })
})

describe('createNewSession seeds permissionMode from defaultPermissionMode', () => {
  it('uses the configured default (regression: was hardcoded "default")', () => {
    useSessionStore.setState({ defaultPermissionMode: 'plan' })
    store().createNewSession('rid-plan', '/repo')
    expect(store().sessions['rid-plan'].permissionMode).toBe('plan')
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

describe('createNewSession gates an unavailable auto', () => {
  /** A Claude model list that affirmatively reports no auto-mode support. */
  const noAutoModels = [
    { value: 'claude-x', displayName: 'x', description: '', supportsAutoMode: false }
  ] as ModelInfo[]

  it('keeps auto when nothing says it is unavailable', () => {
    useSessionStore.setState({ defaultPermissionMode: 'auto' })
    store().createNewSession('rid-auto', '/repo')
    expect(store().sessions['rid-auto'].permissionMode).toBe('auto')
  })

  it('degrades to "default" when no Claude model supports auto', () => {
    useSessionStore.setState({ defaultPermissionMode: 'auto', availableModels: noAutoModels })
    store().createNewSession('rid-gated', '/repo')
    expect(store().sessions['rid-gated'].permissionMode).toBe('default')
  })

  it('degrades to "default" when settings disable auto mode', () => {
    useSessionStore.setState({ defaultPermissionMode: 'auto', autoModeDisabledBySettings: true })
    store().createNewSession('rid-disabled', '/repo')
    expect(store().sessions['rid-disabled'].permissionMode).toBe('default')
  })

  it('does not degrade a non-auto default', () => {
    useSessionStore.setState({
      defaultPermissionMode: 'plan',
      autoModeDisabledBySettings: true,
      availableModels: noAutoModels
    })
    store().createNewSession('rid-plan2', '/repo')
    expect(store().sessions['rid-plan2'].permissionMode).toBe('plan')
  })
})
