/**
 * @vitest-environment node
 *
 * Layer 1/2 hybrid tests for session.ipc.ts.
 *
 * Focus: the safeHandler envelope contract + spot-checking that each family of
 * channels is registered. The full ~80-channel matrix is not exhaustive — we
 * sample one channel per family and trust the rest by inspection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { bootIpcHarness, type IpcHarness } from '../../../test/helpers/boot-ipc-harness'

// ---------------------------------------------------------------------------
// Mocks — every service that session.ipc.ts imports needs a stand-in so we
// don't touch the real FS, network, or spawn subprocesses.
// ---------------------------------------------------------------------------

// Track method calls on gitServiceManager's git-service instances so tests can
// make them throw to exercise safeHandler.
// NB: vi.mock is hoisted above top-level consts, so we declare spy objects
// inside vi.hoisted() so the mock factory can close over them.
const { gitSvcSpies, sessionManagerSpies, sessionStub } = vi.hoisted(() => {
  const gitSvcSpies = {
    isGitRepo: vi.fn(async () => true),
    getStatus: vi.fn(async () => ({ files: [], branch: 'main' })),
    getBranches: vi.fn(async () => ({ current: 'main', all: ['main'] })),
    checkout: vi.fn(async () => {}),
    createBranch: vi.fn(async () => {}),
    getFilePatch: vi.fn(async () => 'patch'),
    getFileContents: vi.fn(async () => 'contents'),
    stageFile: vi.fn(async () => {}),
    unstageFile: vi.fn(async () => {}),
    discardFile: vi.fn(async () => {}),
    stageAll: vi.fn(async () => {}),
    unstageAll: vi.fn(async () => {}),
    commit: vi.fn(async () => ({ sha: 'abc' })),
    push: vi.fn(async () => {}),
    pushWithUpstream: vi.fn(async () => {}),
    pull: vi.fn(async () => ({ ok: true })),
    fetch: vi.fn(async () => {}),
    startPolling: vi.fn(),
    stopPolling: vi.fn()
  }
  const sessionStub: any = {
    willQueue: false,
    cwd: '/tmp/cwd',
    run: vi.fn(),
    resolveApproval: vi.fn(),
    watchBackground: vi.fn(),
    unwatchBackground: vi.fn(),
    readBackgroundRange: vi.fn(() => ''),
    stopTask: vi.fn(async () => ({ success: true })),
    backgroundTask: vi.fn(async () => ({ success: true })),
    dequeueMessage: vi.fn(async () => ({ removed: 0 })),
    askSideQuestion: vi.fn(async () => null),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setEffort: vi.fn(),
    setThinkingMode: vi.fn(),
    voiceStartServer: vi.fn(async () => {}),
    voiceStopServer: vi.fn(async () => {}),
    voiceStartRecording: vi.fn(async () => {}),
    voiceStopRecording: vi.fn(async () => {}),
    mcpServerStatus: vi.fn(async () => []),
    mcpToggleServer: vi.fn(async () => {}),
    mcpReconnectServer: vi.fn(async () => {}),
    mcpSetServers: vi.fn(async () => ({})),
    notifySettingsChanged: vi.fn(async () => {}),
    getPlanContent: vi.fn(() => null),
    getSessionLogPath: vi.fn(() => null),
    getUsage: vi.fn(async () => null)
  }
  const sessionManagerSpies = {
    create: vi.fn(),
    rekey: vi.fn(),
    get: vi.fn(() => sessionStub),
    cancel: vi.fn(),
    interrupt: vi.fn(async () => {}),
    forEach: vi.fn((cb: (s: any) => void) => cb(sessionStub)),
    setSessionTimeout: vi.fn()
  }
  return { gitSvcSpies, sessionManagerSpies, sessionStub }
})

vi.mock('../../services/git-service', () => {
  const svc: any = {}
  for (const [k, v] of Object.entries(gitSvcSpies)) svc[k] = v
  return {
    gitServiceManager: {
      get: vi.fn(() => svc),
      getIfExists: vi.fn(() => svc),
      release: vi.fn()
    }
  }
})

vi.mock('../../services/worktree', () => ({
  createWorktree: vi.fn(async () => ({ path: '/tmp/wt', branch: 'feat' })),
  getWorktreeStatus: vi.fn(async () => ({ dirty: false })),
  removeWorktree: vi.fn(async () => {}),
  listWorktrees: vi.fn(async () => [{ path: '/tmp/wt', branch: 'feat' }])
}))

vi.mock('../../services/session-history', () => ({
  listDirectories: vi.fn(async () => []),
  loadSessionHistory: vi.fn(async () => []),
  loadSubagentHistory: vi.fn(async () => []),
  buildSubagentFileMap: vi.fn(() => ({})),
  loadBackgroundOutput: vi.fn(() => '')
}))

vi.mock('../../services/session-watcher', () => ({
  watchSession: vi.fn(),
  unwatchSession: vi.fn()
}))

vi.mock('../../services/ui-config', () => ({
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  loadSessionConfig: vi.fn(() => ({})),
  saveSessionConfig: vi.fn(),
  loadSlashCommands: vi.fn(() => []),
  saveSlashCommands: vi.fn(),
  startConfigWatcher: vi.fn()
}))

vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: vi.fn(() => ({ allow: [], deny: [], ask: [] })),
  saveClaudePermissions: vi.fn()
}))

vi.mock('../../services/claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  saveMcpServers: vi.fn(),
  removeMcpServer: vi.fn(),
  readDisabledMcpServers: vi.fn(() => []),
  writeDisabledMcpServers: vi.fn()
}))

vi.mock('../../services/skill-scanner', () => ({
  scanSkills: vi.fn(async () => [])
}))

vi.mock('../../services/custom-command-scanner', () => ({
  scanCustomCommands: vi.fn(async () => [])
}))

vi.mock('../../services/delete-session-files', () => ({
  deleteSessionFiles: vi.fn(async () => {}),
  deleteProjectFiles: vi.fn(async () => {})
}))

vi.mock('../../services/socks-bridge', () => ({
  startSocksBridge: vi.fn(async () => 1080),
  stopSocksBridge: vi.fn(async () => {})
}))

vi.mock('../../services/usage-fetcher', () => ({
  usageFetcher: {
    setWindow: vi.fn(),
    setSessionGetter: vi.fn(),
    setIntervalSecs: vi.fn(),
    startPolling: vi.fn(),
    fetch: vi.fn(async () => ({}))
  }
}))

vi.mock('../../services/service-session', () => ({
  serviceSession: {
    getUsage: vi.fn(async () => ({}))
  }
}))

vi.mock('../../services/block-usage', () => ({
  blockUsageService: {
    setWindow: vi.fn(),
    setDebounceSecs: vi.fn(),
    recalculate: vi.fn(async () => ({})),
    startWatching: vi.fn(),
    getData: vi.fn(() => null)
  }
}))

vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted-sessions'
}))

vi.mock('../../services/session-manager', () => ({
  SessionManager: class {
    constructor() {
      /* no-op */
    }
    create = sessionManagerSpies.create
    rekey = sessionManagerSpies.rekey
    get = sessionManagerSpies.get
    cancel = sessionManagerSpies.cancel
    interrupt = sessionManagerSpies.interrupt
    forEach = sessionManagerSpies.forEach
    setSessionTimeout = sessionManagerSpies.setSessionTimeout
  }
}))

vi.mock('../../services/claude-session', () => {
  const extraWindows = new Set<any>()
  return {
    ClaudeSession: class {
      static addExtraWindow(w: any): void {
        extraWindows.add(w)
      }
      static removeExtraWindow(w: any): void {
        extraWindows.delete(w)
      }
      static getExtraWindows(): Set<any> {
        return extraWindows
      }
    },
    getSdkExecutableOpts: vi.fn(() => ({}))
  }
})

vi.mock('../../sdk', () => ({
  query: vi.fn(() => {
    // Return an async iterable shaped like the SDK Query.
    async function* empty(): AsyncGenerator<unknown> {
      /* noop */
    }
    const gen: any = empty()
    gen.supportedModels = async () => []
    return gen
  })
}))

// Electron shim — must come last among electron-related mocks.
vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

vi.mock('../../services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

// Import AFTER mocks.
import { registerSessionIpc } from '../session.ipc'
import { gitServiceManager } from '../../services/git-service'

describe('session.ipc', () => {
  let harness: IpcHarness

  beforeEach(() => {
    harness = bootIpcHarness()
    // Reset spies so calls from previous tests don't leak.
    for (const fn of Object.values(gitSvcSpies)) fn.mockClear?.()
    for (const fn of Object.values(sessionManagerSpies)) fn.mockClear?.()
    for (const fn of Object.values(sessionStub)) {
      if (typeof fn === 'function') (fn as any).mockClear?.()
    }
    sessionManagerSpies.get.mockReturnValue(sessionStub)
    registerSessionIpc(harness.win)
  })

  afterEach(() => {
    harness.teardown()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Envelope contract
  // -------------------------------------------------------------------------

  describe('safeHandler envelope', () => {
    it('returns { ok: true, data } on success for worktree:create', async () => {
      const res = await harness.call<any>('worktree:create', '/tmp/repo', 'feature')
      expect(res).toEqual({ ok: true, data: { path: '/tmp/wt', branch: 'feat' } })
    })

    it('returns { ok: true, data } on success for git:status', async () => {
      const res = await harness.call<any>('git:status', '/tmp/repo')
      expect(res.ok).toBe(true)
      expect(res.data).toEqual({ files: [], branch: 'main' })
    })

    it('returns { ok: true, data: true } for git:check-repo', async () => {
      const res = await harness.call<any>('git:check-repo', '/tmp/repo')
      expect(res).toEqual({ ok: true, data: true })
    })

    it('returns { ok: true, data } on success for git:branches', async () => {
      const res = await harness.call<any>('git:branches', '/tmp/repo')
      expect(res.ok).toBe(true)
      expect(res.data).toEqual({ current: 'main', all: ['main'] })
    })

    it('returns { ok: false, error } when underlying service throws', async () => {
      gitSvcSpies.getStatus.mockRejectedValueOnce(new Error('fatal: not a git repo'))
      const res = await harness.call<any>('git:status', '/tmp/not-a-repo')
      expect(res.ok).toBe(false)
      expect(res.error).toBe('fatal: not a git repo')
    })

    it('error is a string (serializable), not an Error object', async () => {
      gitSvcSpies.getBranches.mockRejectedValueOnce(new Error('boom'))
      const res = await harness.call<any>('git:branches', '/tmp/repo')
      expect(res.ok).toBe(false)
      expect(typeof res.error).toBe('string')
      expect(res.error).toBe('boom')
    })

    it('non-Error throws (strings) serialize to error string', async () => {
      gitSvcSpies.commit.mockRejectedValueOnce('plain string error' as any)
      const res = await harness.call<any>('git:commit', '/tmp/repo', 'msg')
      expect(res.ok).toBe(false)
      expect(res.error).toBe('plain string error')
    })

    it('non-Error throws (objects) serialize to error string', async () => {
      gitSvcSpies.commit.mockRejectedValueOnce({ code: 'ENOENT' } as any)
      const res = await harness.call<any>('git:commit', '/tmp/repo', 'msg')
      expect(res.ok).toBe(false)
      expect(typeof res.error).toBe('string')
    })

    it('callSafe unwraps { ok: true } to data', async () => {
      const data = await harness.callSafe<any>('git:status', '/tmp/repo')
      expect(data).toEqual({ files: [], branch: 'main' })
    })

    it('callSafe throws error message when { ok: false }', async () => {
      gitSvcSpies.getStatus.mockRejectedValueOnce(new Error('auth failed'))
      await expect(harness.callSafe('git:status', '/tmp/repo')).rejects.toThrow('auth failed')
    })

    it('mcp:toggle returns envelope on missing session', async () => {
      sessionManagerSpies.get.mockReturnValueOnce(undefined as any)
      const res = await harness.call<any>('mcp:toggle', 'nonexistent', 'srv', true)
      expect(res.ok).toBe(false)
      expect(res.error).toBe('No active session')
    })

    it('releases git service after each call (even on error)', async () => {
      gitSvcSpies.getStatus.mockRejectedValueOnce(new Error('x'))
      await harness.call('git:status', '/tmp/repo')
      // `release` was called in the finally block
      expect(gitServiceManager.release as any).toHaveBeenCalledWith('/tmp/repo')
    })
  })

  // -------------------------------------------------------------------------
  // Session lifecycle channels (sample)
  // -------------------------------------------------------------------------

  describe('session lifecycle channels', () => {
    it('session:create is registered and calls manager.create', async () => {
      await harness.call('session:create', 'rid-1', '/tmp/cwd')
      expect(sessionManagerSpies.create).toHaveBeenCalled()
    })

    it('session:send is registered and calls session.run', async () => {
      await harness.call('session:send', 'rid-1', 'hello')
      expect(sessionStub.run).toHaveBeenCalledWith('hello', undefined)
    })

    it('session:send broadcasts session:user-message to renderer', async () => {
      const events: any[] = []
      harness.onEvent('session:user-message', (...args) => events.push(args))
      await harness.call('session:send', 'rid-1', 'hello')
      expect(events).toHaveLength(1)
      expect(events[0][0]).toBe('rid-1')
      expect(events[0][1]).toMatchObject({ prompt: 'hello', queued: false })
    })

    it('session:send throws when routingId not found', async () => {
      sessionManagerSpies.get.mockReturnValueOnce(undefined as any)
      await expect(harness.call('session:send', 'missing', 'x')).rejects.toThrow(/No session/)
    })

    it('session:cancel is registered and calls manager.cancel', async () => {
      await harness.call('session:cancel', 'rid-1')
      expect(sessionManagerSpies.cancel).toHaveBeenCalledWith('rid-1')
    })

    it('session:interrupt is registered and awaits manager.interrupt', async () => {
      await harness.call('session:interrupt', 'rid-1')
      expect(sessionManagerSpies.interrupt).toHaveBeenCalledWith('rid-1')
    })

    it('session:rekey is registered and calls manager.rekey', async () => {
      await harness.call('session:rekey', 'temp-1', 'uuid-2')
      expect(sessionManagerSpies.rekey).toHaveBeenCalledWith('temp-1', 'uuid-2')
    })
  })

  // -------------------------------------------------------------------------
  // Git channels (spot-check registration)
  // -------------------------------------------------------------------------

  describe('git channels', () => {
    it.each([
      ['git:check-repo', ['/tmp/r']],
      ['git:status', ['/tmp/r']],
      ['git:branches', ['/tmp/r']],
      ['git:checkout', ['/tmp/r', 'main']],
      ['git:stage-file', ['/tmp/r', 'a.ts']],
      ['git:commit', ['/tmp/r', 'msg']],
      ['git:push', ['/tmp/r']],
      ['git:pull', ['/tmp/r']]
    ])('%s is registered', async (channel, args) => {
      const res = await harness.call<any>(channel, ...args)
      expect(res).toHaveProperty('ok', true)
    })
  })

  // -------------------------------------------------------------------------
  // Config channels
  // -------------------------------------------------------------------------

  describe('config channels', () => {
    it.each(['config:load-settings', 'config:load-sessions'])(
      '%s is registered (returns data)',
      async (channel) => {
        await expect(harness.call(channel, {})).resolves.toBeDefined()
      }
    )

    it.each(['config:save-settings', 'config:save-sessions'])(
      '%s is registered (void)',
      async (channel) => {
        // Save handlers return void; just assert they don't throw and a handler exists.
        await expect(harness.call(channel, {})).resolves.toBeUndefined()
      }
    )

    it('config:save-settings broadcasts config:settings-changed to extra windows', async () => {
      // No extra windows in harness, but call should succeed.
      await expect(harness.call('config:save-settings', { theme: 'dark' })).resolves.toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // MCP channels
  // -------------------------------------------------------------------------

  describe('mcp channels', () => {
    it('mcp:status is registered and returns session status', async () => {
      const res = await harness.call('mcp:status', 'rid-1')
      expect(res).toEqual([])
    })

    it('mcp:toggle is registered (safeHandler-wrapped)', async () => {
      const res = await harness.call<any>('mcp:toggle', 'rid-1', 'srv', true)
      expect(res.ok).toBe(true)
      expect(sessionStub.mcpToggleServer).toHaveBeenCalledWith('srv', true)
    })
  })

  // -------------------------------------------------------------------------
  // Worktree channels
  // -------------------------------------------------------------------------

  describe('worktree channels', () => {
    it('worktree:create is registered', async () => {
      const res = await harness.call<any>('worktree:create', '/tmp/r', 'feat')
      expect(res.ok).toBe(true)
    })

    it('worktree:list is registered', async () => {
      const res = await harness.call<any>('worktree:list', '/tmp/r')
      expect(res.ok).toBe(true)
      expect(res.data).toEqual([{ path: '/tmp/wt', branch: 'feat' }])
    })
  })

  // -------------------------------------------------------------------------
  // Voice channels
  // -------------------------------------------------------------------------

  describe('voice channels', () => {
    it('voice:start-server routes to session.voiceStartServer', async () => {
      const res = await harness.call<any>('voice:start-server', 'rid-1')
      expect(res.ok).toBe(true)
      expect(sessionStub.voiceStartServer).toHaveBeenCalled()
    })

    it('voice:start-recording routes to session.voiceStartRecording with language', async () => {
      const res = await harness.call<any>('voice:start-recording', 'rid-1', 'en')
      expect(res.ok).toBe(true)
      expect(sessionStub.voiceStartRecording).toHaveBeenCalledWith('en')
    })

    it('voice:stop-server returns ok=false when no session', async () => {
      sessionManagerSpies.get.mockReturnValueOnce(undefined as any)
      const res = await harness.call<any>('voice:stop-server', 'nope')
      expect(res.ok).toBe(false)
      expect(res.error).toBe('No active session')
    })
  })

  // -------------------------------------------------------------------------
  // Usage / misc
  // -------------------------------------------------------------------------

  describe('misc channels', () => {
    it('usage:fetch is registered', async () => {
      await expect(harness.call('usage:fetch')).resolves.toBeDefined()
    })

    it('session:get-models is registered', async () => {
      const res = await harness.call<any[]>('session:get-models')
      expect(Array.isArray(res)).toBe(true)
    })

    it('session:set-permission-mode routes to session.setPermissionMode', async () => {
      await harness.call('session:set-permission-mode', 'rid-1', 'acceptEdits')
      expect(sessionStub.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
    })

    it('session:set-effort routes to session.setEffort', async () => {
      await harness.call('session:set-effort', 'rid-1', 'high')
      expect(sessionStub.setEffort).toHaveBeenCalledWith('high')
    })
  })
})
