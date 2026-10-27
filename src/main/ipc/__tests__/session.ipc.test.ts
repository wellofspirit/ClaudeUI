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
import { dispatchDesktop } from '../../../core/ipc/desktop-transport-binding'
import * as fs from 'fs'
import * as os from 'os'
import { EventEmitter } from 'events'
import * as path from 'path'

vi.mock('../../../core/codex/codex-locate', () => ({ codexBinaryAvailable: () => false }))
vi.mock('../../../core/codex/model-discovery', () => ({
  discoverCodexModels: vi.fn(async () => [])
}))
vi.mock('../../../core/codex/history', () => ({
  listCodexSessions: vi.fn(async () => []),
  loadCodexHistory: vi.fn()
}))
vi.mock('../../../core/auth/CodexAuthProvider', () => ({
  codexAuthProvider: {
    status: vi.fn(async () => ({ available: false, authenticated: false, authKind: null })),
    loginStart: vi.fn(),
    loginStatus: vi.fn(() => ({ status: 'idle' })),
    loginCancel: vi.fn()
  }
}))

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
    engineId: 'claude',
    // capabilities assigned at module scope below (resolveClaudeCapabilities needs the
    // top-level import, which isn't available inside the hoisted factory).
    capabilities: undefined,
    run: vi.fn(),
    resolveApproval: vi.fn(),
    watchBackground: vi.fn(),
    unwatchBackground: vi.fn(),
    readBackgroundRange: vi.fn(() => ''),
    stopTask: vi.fn(async () => ({ success: true })),
    backgroundTask: vi.fn(async () => ({ success: true })),
    queuedItems: [],
    enqueuePrompt: vi.fn(),
    recallQueued: vi.fn(async () => ({ recalled: [], notRecalled: 0 })),
    askSideQuestion: vi.fn(async () => null),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setEffort: vi.fn(),
    setThinkingMode: vi.fn(),
    voiceStartServer: vi.fn(async () => {}),
    voiceStopServer: vi.fn(async () => {}),
    mcpServerStatus: vi.fn(async () => []),
    mcpToggleServer: vi.fn(async () => {}),
    mcpReconnectServer: vi.fn(async () => {}),
    mcpSetServers: vi.fn(async () => ({})),
    notifySettingsChanged: vi.fn(async () => {}),
    getPlanContent: vi.fn(() => null),
    getSessionLogPath: vi.fn(() => null),
    getUsage: vi.fn(async () => null),
    discoverSkills: vi.fn(async () => [])
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

vi.mock('../../../core/services/git-service', () => {
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

vi.mock('../../../core/services/worktree', () => ({
  createWorktree: vi.fn(async () => ({ path: '/tmp/wt', branch: 'feat' })),
  getWorktreeStatus: vi.fn(async () => ({ dirty: false })),
  removeWorktree: vi.fn(async (_p: string, _b: string, _r: string, _d?: unknown) => ({
    id: '/tmp/wt',
    outcome: 'removed'
  })),
  inventoryWorktrees: vi.fn(async (_cwd: string, _sources?: unknown) => ({
    repoRoot: '/tmp/r',
    managedRoot: '/tmp/r/.claude/worktrees',
    entries: []
  })),
  inspectWorktree: vi.fn(async () => ({ uncommittedFiles: 0 })),
  measureWorktree: vi.fn(
    async (
      _cwd: string,
      _id: string,
      onProgress?: (p: { files: number; bytes: number }) => void
    ) => {
      onProgress?.({ files: 7, bytes: 70 })
      return { bytes: 70, files: 7, links: 0, errors: 0, newestMtimeMs: 0 }
    }
  ),
  removeWorktrees: vi.fn(
    async (
      _cwd: string,
      ids: string[],
      progress: (p: { done: number; total: number; phase: string }) => void,
      _opts: unknown
    ) => {
      progress({ done: ids.length, total: ids.length, phase: 'done' })
      return ids.map((id) => ({ id, outcome: 'removed' }))
    }
  )
}))

// C-S10: a worktree removal re-lists the directories so the linked-worktree markers clear.
vi.mock('../../../core/services/sync-seed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/services/sync-seed')>()),
  refreshCanonicalDirectories: vi.fn(async () => {})
}))

vi.mock('../../../core/services/session-history', () => ({
  listDirectories: vi.fn(async () => []),
  loadSessionHistory: vi.fn(async () => []),
  loadSessionStatusLine: vi.fn(async () => ({ totalCostUsd: 2 })),
  loadSubagentHistory: vi.fn(async () => []),
  buildSubagentFileMap: vi.fn(() => ({})),
  loadBackgroundOutput: vi.fn(() => '')
}))

vi.mock('../../../core/services/session-watcher', () => ({
  watchSession: vi.fn(),
  unwatchSession: vi.fn()
}))

vi.mock('../../../core/services/ui-config', () => ({
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  loadSessionConfig: vi.fn(() => ({})),
  saveSessionConfig: vi.fn(),
  loadSlashCommands: vi.fn(() => []),
  saveSlashCommands: vi.fn(),
  startConfigWatcher: vi.fn(),
  loadEngineConfig: vi.fn(() => ({})),
  saveEngineConfig: vi.fn(),
  loadVendorConfig: vi.fn(() => ({})),
  saveVendorConfig: vi.fn()
}))

vi.mock('../../../core/services/claude-settings', () => ({
  loadClaudePermissions: vi.fn(() => ({ allow: [], deny: [], ask: [] })),
  saveClaudePermissions: vi.fn()
}))

vi.mock('../../../core/services/claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  saveMcpServers: vi.fn(),
  removeMcpServer: vi.fn(),
  readDisabledMcpServers: vi.fn(() => []),
  writeDisabledMcpServers: vi.fn()
}))

vi.mock('../../../core/services/skill-scanner', () => ({
  scanSkills: vi.fn(async () => [])
}))

vi.mock('../../../core/services/custom-command-scanner', () => ({
  scanCustomCommands: vi.fn(async () => [])
}))

vi.mock('../../../core/services/delete-session-files', () => ({
  deleteSessionFiles: vi.fn(async () => {}),
  deleteProjectFiles: vi.fn(async () => {})
}))

vi.mock('../../../core/services/socks-bridge', () => ({
  startSocksBridge: vi.fn(async () => 1080),
  stopSocksBridge: vi.fn(async () => {}),
  // session.ipc.ts's proxy connectivity test now reuses the bridge's handshake.
  socks5Connect: vi.fn(async () => {
    throw new Error('socks5Connect not stubbed for this test')
  })
}))

vi.mock('../../../core/services/usage-fetcher', () => ({
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

vi.mock('../../../core/services/block-usage', () => ({
  blockUsageService: {
    setWindow: vi.fn(),
    setDebounceSecs: vi.fn(),
    recalculate: vi.fn(async () => ({})),
    startWatching: vi.fn(),
    getData: vi.fn(() => null)
  }
}))

vi.mock('../../../core/services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted-sessions'
}))

// Cross-engine dispatcher (ADR-033) — the real singleton pulls the opencode
// client graph; stub it and let tests control resolveApproval's return.
const crossEngineSpies = vi.hoisted(() => ({
  resolveApproval: vi.fn((requestId: string) => requestId.startsWith('xeng:')),
  dispatch: vi.fn(),
  disposeFor: vi.fn(),
  stopDispatch: vi.fn(() => false)
}))

vi.mock('../../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: crossEngineSpies,
  XENG_REQUEST_PREFIX: 'xeng:'
}))

const sharedProviderSpies = vi.hoisted(() => ({
  listDefinitions: vi.fn(() => []),
  listStatuses: vi.fn(async () => []),
  listProviderModels: vi.fn(async () => []),
  saveDefinition: vi.fn(async () => {}),
  removeDefinition: vi.fn(async () => {}),
  setRouteEnabled: vi.fn(async () => {}),
  setApiKey: vi.fn(async () => {}),
  ownKeyHolders: vi.fn(async (): Promise<string[]> => []),
  syncProvider: vi.fn(async () => {}),
  disconnectProvider: vi.fn(async () => {}),
  setRouteDefaultModel: vi.fn(async () => {}),
  probeEndpoint: vi.fn(async () => ({ status: 'detected', server: 'vllm', models: [] }))
}))

vi.mock('../../../core/shared-providers', () => ({ sharedProviderService: sharedProviderSpies }))

vi.mock('../../../core/services/session-manager', () => ({
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

vi.mock('../../../core/services/claude-session', () => {
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

vi.mock('../../../core/sdk', () => ({
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

// The relay itself is voice-relay.test.ts's; here only what the desktop verbs
// hand it — the session, the owner, the language — and when they refuse first.
const voiceRelaySpies = vi.hoisted(() => ({
  start: vi.fn(async (..._args: unknown[]) => {}),
  stop: vi.fn(async (_ownerKey: string) => {})
}))
vi.mock('../../../core/services/voice-relay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/services/voice-relay')>()
  return { ...actual, voiceRelay: voiceRelaySpies }
})

vi.mock('../../../core/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

// The turn-end notes module is dormant (slice 5): the registration must never switch it on.
const sessionNotesSpies = vi.hoisted(() => ({
  configureSessionNotes: vi.fn(),
  enableSessionNotes: vi.fn()
}))
vi.mock('../../../core/services/session-notes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/services/session-notes')>()
  return { ...actual, ...sessionNotesSpies }
})

// Import AFTER mocks.
import { registerSessionIpc, resetLoginStatusReportedForTests } from '../../../core/ipc/session.ipc'
import { setHostAuth } from '../../../core/host'
import {
  resetCachedClaudeModels,
  setCachedClaudeModels
} from '../../../core/services/claude-model-catalog'
import { gitServiceManager } from '../../../core/services/git-service'
import { closeMockupWatchersUnder } from '../../../core/services/mockup-watch-registry'
import { refreshCanonicalDirectories } from '../../../core/services/sync-seed'
import { loadSessionConfig } from '../../../core/services/ui-config'
import { forgetEntriesAndEmit, forgetEntriesQuiet } from '../../../core/ipc/config-commands'
import {
  inventoryWorktrees,
  measureWorktree,
  removeWorktree,
  removeWorktrees
} from '../../../core/services/worktree'
import { gitWatchRegistry } from '../../../core/services/git-watch-registry'
import { commandRegistry, hostConnection } from '../../../core/ipc/command-registry'
import { blobStore } from '../../../core/services/blob-store'
import { addSyncSubscriber } from '../../../core/services/sync-host'
import { setHostWindow } from '../../../core/services/host-window'
import { resolveClaudeCapabilities } from '../../../shared/model-capabilities'
import { query } from '../../../core/sdk'
import {
  loadSessionHistory as loadClaudeHistoryMock,
  loadSessionStatusLine as loadStatusLineMock,
  loadSubagentHistory as loadSubagentHistoryMock
} from '../../../core/services/session-history'

// Fill in the stub's capabilities now that the top-level import is available
// (it can't be referenced inside the vi.hoisted() factory above).
sessionStub.capabilities = resolveClaudeCapabilities('default')

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
    // SyncCore 4d: the registration is window-free, and the two handlers that
    // want the host's window read it from host-window.ts at use time.
    setHostWindow(harness.win)
    registerSessionIpc({
      // S3 stage 1b: the desktop-auth pair is injected now (the registrar left
      // `src/main` and must not import the Electron-bound singletons). Neither
      // channel family under test touches these, so a throwing stub is the
      // honest double — it fails loudly if that ever stops being true.
      requireEngineAuth: () => {
        throw new Error('requireEngineAuth is not stubbed in this suite')
      },
      setAccountEnabled: () => {
        throw new Error('setAccountEnabled is not stubbed in this suite')
      }
    })
  })

  afterEach(() => {
    setHostWindow(null)
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
    it('session:create is registered and creates the session under the caller routing id and cwd', async () => {
      await harness.call('session:create', 'rid-1', '/tmp/cwd')
      expect(sessionManagerSpies.create).toHaveBeenCalledTimes(1)
      const [routingId, , cwd] = sessionManagerSpies.create.mock.calls[0]
      expect(routingId).toBe('rid-1')
      expect(cwd).toBe('/tmp/cwd')
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
      expect(events[0][1]).toMatchObject({ prompt: 'hello' })
    })

    // ADR-053 — a send that queues is the queue's business, not the
    // transcript's: no session:user-message, and the item goes to the session.
    it('session:send on a busy session enqueues instead of broadcasting', async () => {
      const events: any[] = []
      harness.onEvent('session:user-message', (...args) => events.push(args))
      sessionStub.willQueue = true
      try {
        await harness.call('session:send', 'rid-1', 'queued one')
      } finally {
        sessionStub.willQueue = false
      }
      expect(events).toHaveLength(0)
      // (text, uploads, refs) — no attachments, so neither half exists.
      expect(sessionStub.enqueuePrompt).toHaveBeenCalledWith('queued one', undefined, undefined)
    })

    // ADR-087 — the upload is interned once at the top of sendPrompt: the engine
    // keeps the bytes, everything replicated carries only the ref.
    it('session:send interns an upload: the engine gets bytes, the relay gets a ref', async () => {
      const events: any[] = []
      harness.onEvent('session:user-message', (...args) => events.push(args))
      const upload = { mediaType: 'image/png', base64Data: 'iVBORw0KGgo=', fileName: 'a.png' }
      await harness.call('session:send', 'rid-1', 'look', [upload])

      expect(sessionStub.run).toHaveBeenCalledWith('look', [upload])
      const relayed = events[0][1]
      expect(relayed.attachments).toEqual([
        {
          mediaType: 'image/png',
          blobId: expect.stringMatching(/^[0-9a-f]{64}$/),
          bytes: 8,
          fileName: 'a.png'
        }
      ])
      expect(JSON.stringify(relayed)).not.toContain('iVBORw0KGgo=')
    })

    // ADR-087 — `blob:get` is a `chat` query on the invoke lane, and a miss of
    // any kind is `null`, never an error the client has to catch.
    it('blob:get returns the bytes behind a ref; unknown and malformed ids are null', async () => {
      const bytes = Buffer.from('desktop-blob-bytes')
      const ref = blobStore.putBytes('image/png', bytes)!

      expect(await harness.call('blob:get', ref.blobId)).toEqual({
        mediaType: 'image/png',
        base64Data: bytes.toString('base64')
      })
      expect(await harness.call('blob:get', 'a'.repeat(64))).toBeNull()
      for (const bad of ['', 'xyz', 'A'.repeat(64), `${ref.blobId}0`, '../../etc/passwd']) {
        expect(await harness.call('blob:get', bad)).toBeNull()
      }
    })

    it('blob:get is declared chat/query, shared by both transports', () => {
      expect(commandRegistry.declaration('blob:get')).toMatchObject({
        capability: 'chat',
        kind: 'query'
      })
      expect(commandRegistry.channels('desktop')).toContain('blob:get')
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
  // Approval routing — xeng: prefix → cross-engine dispatcher (ADR-033)
  // -------------------------------------------------------------------------

  describe('session:approval-response prefix routing', () => {
    it("routes 'xeng:'-prefixed requestIds to the dispatcher, NOT the session", async () => {
      await harness.call('session:approval-response', 'rid-1', 'xeng:perm-1', 'allow', {
        feedback: 'ok'
      })
      expect(crossEngineSpies.resolveApproval).toHaveBeenCalledWith(
        'xeng:perm-1',
        'allow',
        { feedback: 'ok' },
        undefined
      )
      expect(sessionStub.resolveApproval).not.toHaveBeenCalled()
    })

    it('still routes ordinary requestIds to the session (dispatcher untouched)', async () => {
      await harness.call('session:approval-response', 'rid-1', 'req-9', 'deny')
      expect(sessionStub.resolveApproval).toHaveBeenCalledWith(
        'req-9',
        'deny',
        undefined,
        undefined
      )
      expect(crossEngineSpies.resolveApproval).not.toHaveBeenCalled()
    })

    it('an answer retires the card on every client: emits session:approval-dismiss for the routing id (pi, xeng:)', async () => {
      const dismissals: unknown[][] = []
      harness.onEvent('session:approval-dismiss', (...args) => dismissals.push(args))
      await harness.call('session:approval-response', 'pi-rid', 'req-pi', 'allow')
      await harness.call('session:approval-response', 'parent-rid', 'xeng:perm-9', 'deny')
      expect(dismissals).toEqual([
        ['pi-rid', { requestId: 'req-pi' }],
        ['parent-rid', { requestId: 'xeng:perm-9' }]
      ])
    })

    it('a resolve that throws still dismisses the card and still rejects', async () => {
      const dismissals: unknown[][] = []
      harness.onEvent('session:approval-dismiss', (...args) => dismissals.push(args))
      sessionStub.resolveApproval.mockImplementationOnce(() => {
        throw new Error('Stale or unknown Codex approval')
      })
      await expect(
        harness.call('session:approval-response', 'codex-rid', 'req-x', 'allow')
      ).rejects.toThrow('Stale or unknown Codex approval')
      expect(dismissals).toEqual([['codex-rid', { requestId: 'req-x' }]])
    })

    it('falls through to the session when the dispatcher declines to consume', async () => {
      crossEngineSpies.resolveApproval.mockReturnValueOnce(false)
      await harness.call('session:approval-response', 'rid-1', 'xeng:stale', 'allow')
      expect(sessionStub.resolveApproval).toHaveBeenCalledWith(
        'xeng:stale',
        'allow',
        undefined,
        undefined
      )
    })
  })

  // -------------------------------------------------------------------------
  // ADR-091 part 6 — approve an auto-mode block after the fact
  // -------------------------------------------------------------------------

  describe('session:approve-blocked', () => {
    afterEach(() => {
      delete sessionStub.approveBlocked
      sessionStub.willQueue = false
    })

    it('is a chat command on the session it names, like session:approval-response', () => {
      expect(commandRegistry.declaration('session:approve-blocked')).toMatchObject({
        capability: 'chat',
        kind: 'command'
      })
      expect(commandRegistry.declaration('session:approve-blocked')).toMatchObject(
        commandRegistry.declaration('session:approval-response')!
      )
    })

    it("an idle session: the nudge is sent through the composer's path (a user message)", async () => {
      sessionStub.approveBlocked = vi.fn(() => ({ prompt: 'I approve the bash call …' }))
      const events: any[] = []
      harness.onEvent('session:user-message', (...args) => events.push(args))
      await harness.call('session:approve-blocked', 'rid-1', 'call-9')
      expect(sessionStub.approveBlocked).toHaveBeenCalledWith('call-9')
      expect(sessionStub.run).toHaveBeenCalledWith('I approve the bash call …', undefined)
      expect(events[0][1]).toMatchObject({ prompt: 'I approve the bash call …' })
    })

    it('a busy session: the nudge is queued', async () => {
      sessionStub.approveBlocked = vi.fn(() => ({ prompt: 'nudge' }))
      sessionStub.willQueue = true
      await harness.call('session:approve-blocked', 'rid-1', 'call-9')
      expect(sessionStub.enqueuePrompt).toHaveBeenCalledWith('nudge', undefined, undefined)
      expect(sessionStub.run).not.toHaveBeenCalled()
    })

    it('a nudge a live subagent took, an unknown call, or an engine without the method sends nothing', async () => {
      sessionStub.approveBlocked = vi.fn(() => ({ prompt: null }))
      await harness.call('session:approve-blocked', 'rid-1', 'call-9')
      sessionStub.approveBlocked = vi.fn(() => undefined)
      await harness.call('session:approve-blocked', 'rid-1', 'call-9')
      delete sessionStub.approveBlocked
      await harness.call('session:approve-blocked', 'rid-1', 'call-9')
      sessionManagerSpies.get.mockReturnValueOnce(undefined as any)
      await harness.call('session:approve-blocked', 'missing', 'call-9')
      expect(sessionStub.run).not.toHaveBeenCalled()
      expect(sessionStub.enqueuePrompt).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Stop routing — dispatch toolUseIds → cross-engine dispatcher (ADR-033 M3)
  // -------------------------------------------------------------------------

  describe('session:stop-task dispatch routing', () => {
    it('routes a known dispatch toolUseId to the dispatcher (scoped by routingId), NOT the session', async () => {
      crossEngineSpies.stopDispatch.mockReturnValueOnce(true)
      const result = await harness.call<{ success: boolean }>(
        'session:stop-task',
        'rid-1',
        'toolu_dispatch_1'
      )
      expect(crossEngineSpies.stopDispatch).toHaveBeenCalledWith('toolu_dispatch_1', 'rid-1')
      expect(result).toEqual({ success: true })
      expect(sessionStub.stopTask).not.toHaveBeenCalled()
    })

    it('falls through to the session stopTask when the id is not a known dispatch', async () => {
      const result = await harness.call<{ success: boolean }>(
        'session:stop-task',
        'rid-1',
        'toolu_ordinary_1'
      )
      expect(crossEngineSpies.stopDispatch).toHaveBeenCalledWith('toolu_ordinary_1', 'rid-1')
      expect(sessionStub.stopTask).toHaveBeenCalledWith('toolu_ordinary_1')
      expect(result).toEqual({ success: true })
    })

    it('isDispatch=true: arms a durable stop-intent, returns success even with no live turn, never touches the session path', async () => {
      // Default stopDispatch mock returns false — simulating the upstream race
      // where the Stop click beats the MCP tools/call round-trip entirely.
      const result = await harness.call<{ success: boolean }>(
        'session:stop-task',
        'rid-1',
        'toolu_disp_racy',
        true
      )
      expect(crossEngineSpies.stopDispatch).toHaveBeenCalledWith('toolu_disp_racy', 'rid-1', {
        armIfUnknown: true
      })
      expect(result).toEqual({ success: true })
      expect(sessionStub.stopTask).not.toHaveBeenCalled()
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
  // Git watching — the desktop side of the shared gitWatchRegistry (phase 5 S2:
  // per-connection interest sets, not a collective owner).
  // -------------------------------------------------------------------------

  describe('git watching', () => {
    const CWD = '/tmp/watched'
    const PHONE = 'conn-phone'

    afterEach(() => {
      // The registry is a module singleton shared with the remote path; unwind
      // both connections so state can't leak into the next test.
      gitWatchRegistry.releaseConnection(hostConnection().connectionId)
      gitWatchRegistry.releaseConnection(PHONE)
    })

    it('git:watch starts one poller and broadcasts to every subscriber', async () => {
      // 4c: `git:status-update` is replicated, so it reaches SUBSCRIBERS — there is
      // no "main window AND extras" any more, just clients. A second subscriber
      // stands in for the WebSocket broadcaster, which is the hop that carries this
      // channel to web clients.
      const other: unknown[][] = []
      const offOther = addSyncSubscriber((_seq, channel, args) => {
        if (channel === 'git:status-update') other.push(args)
      })

      await harness.call('git:watch', { cwds: [CWD] })
      expect(gitSvcSpies.startPolling).toHaveBeenCalledTimes(1)
      expect(gitSvcSpies.startPolling.mock.calls[0][1]).toBe(5000)

      const status = { files: [], branch: 'main' }
      const emit = gitSvcSpies.startPolling.mock.calls[0][0] as (s: unknown) => void
      const received: unknown[][] = []
      const off = harness.onEvent('git:status-update', (...args) => received.push(args))
      emit(status)
      off()

      offOther()
      expect(received).toEqual([[{ cwd: CWD, status }]])
      expect(other).toEqual([[{ cwd: CWD, status }]])
    })

    it('a remote connection joins the desktop poller instead of clobbering it (CLOBBER GUARD)', async () => {
      await harness.call('git:watch', { cwds: [CWD] })
      const emit = gitSvcSpies.startPolling.mock.calls[0][0] as (s: unknown) => void
      emit({ files: [], branch: 'main' })

      // The remote dispatcher path reaches the same registry under its own
      // connection id — the union grows, the poller does not.
      gitWatchRegistry.setWatch(PHONE, [CWD])
      expect(gitSvcSpies.startPolling).toHaveBeenCalledTimes(1)

      // The one callback is still the live one.
      const received: unknown[][] = []
      const off = harness.onEvent('git:status-update', (...args) => received.push(args))
      emit({ files: [], branch: 'dev' })
      off()
      expect(received).toEqual([[{ cwd: CWD, status: { files: [], branch: 'dev' } }]])
    })

    it('the desktop clearing its set keeps the poller alive while a phone watches', async () => {
      await harness.call('git:watch', { cwds: [CWD] })
      gitWatchRegistry.setWatch(PHONE, [CWD])

      await harness.call('git:watch', { cwds: [] })
      expect(gitSvcSpies.stopPolling).not.toHaveBeenCalled()
      expect(gitWatchRegistry.watchersOf(CWD)).toEqual([PHONE])
    })

    it('the union emptying tears the poller down', async () => {
      await harness.call('git:watch', { cwds: [CWD] })
      await harness.call('git:watch', { cwds: [] })
      expect(gitSvcSpies.stopPolling).toHaveBeenCalledTimes(1)
      expect(gitWatchRegistry.watchersOf(CWD)).toEqual([])
    })

    it('an empty set from a connection that watches nothing is a no-op', async () => {
      await expect(harness.call('git:watch', { cwds: [] })).resolves.toBeUndefined()
      expect(gitSvcSpies.stopPolling).not.toHaveBeenCalled()
    })

    it('refuses a set larger than the cap rather than clipping it', async () => {
      const many = Array.from({ length: 33 }, (_, i) => `/tmp/many-${i}`)
      await expect(harness.call('git:watch', { cwds: many })).rejects.toThrow(/at most 32/)
      expect(gitSvcSpies.startPolling).not.toHaveBeenCalled()
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

    // ADR-112 — the worktree manager.
    it('declares the manager channels: inventory/inspect/measure are git queries, remove-many a git command, both long ones withProgress', () => {
      expect(commandRegistry.declaration('worktree:inventory')).toMatchObject({
        capability: 'git',
        kind: 'query'
      })
      expect(commandRegistry.declaration('worktree:inspect')).toMatchObject({
        capability: 'git',
        kind: 'query'
      })
      expect(commandRegistry.declaration('worktree:measure')).toMatchObject({
        capability: 'git',
        kind: 'query',
        withProgress: true
      })
      expect(commandRegistry.declaration('worktree:remove-many')).toMatchObject({
        capability: 'git',
        kind: 'command',
        withProgress: true
      })
    })

    it('worktree:inventory passes the real holder sources', async () => {
      const res = await harness.call<any>('worktree:inventory', '/tmp/r')
      expect(res.ok).toBe(true)
      const sources = vi.mocked(inventoryWorktrees).mock.lastCall![1] as object
      expect(vi.mocked(inventoryWorktrees).mock.lastCall![0]).toBe('/tmp/r')
      expect(Object.keys(sources).sort()).toEqual(['sessions', 'terminals', 'xAgents'])
    })

    it('worktree:remove-many enforces holders, forgets entries, closes watchers, forwards progress and returns the results array (no ok key)', async () => {
      const res = await harness.call<any>('worktree:remove-many', '/tmp/r', ['a', 'b'])

      expect(res).toEqual({
        ok: true,
        data: [
          { id: 'a', outcome: 'removed' },
          { id: 'b', outcome: 'removed' }
        ]
      })
      expect(res.data.some((r: object) => 'ok' in r)).toBe(false)
      const [cwd, ids, progress, opts] = vi.mocked(removeWorktrees).mock.lastCall!
      expect(cwd).toBe('/tmp/r')
      expect(ids).toEqual(['a', 'b'])
      expect(progress).toEqual(expect.any(Function))
      expect(opts).toMatchObject({
        enforceHolders: true,
        sources: expect.any(Object),
        forgetEntries: expect.any(Function),
        beforeWalk: expect.any(Function)
      })
    })

    it('after a removal both removal channels re-list the directories (forgetEntries is the one hook)', async () => {
      vi.mocked(refreshCanonicalDirectories).mockClear()
      await harness.call('worktree:remove-many', '/tmp/r', ['a'])
      const manyOpts = vi.mocked(removeWorktrees).mock.lastCall![3] as {
        forgetEntries: (paths: string[]) => void
      }
      manyOpts.forgetEntries(['/tmp/r/.claude/worktrees/a'])
      expect(refreshCanonicalDirectories).toHaveBeenCalledTimes(1)

      await harness.call('worktree:remove', '/tmp/wt', 'feat', '/tmp/r')
      const legacy = vi.mocked(removeWorktree).mock.lastCall![3] as {
        forgetEntries: (paths: string[]) => void
      }
      legacy.forgetEntries(['/tmp/wt'])
      expect(refreshCanonicalDirectories).toHaveBeenCalledTimes(2)
    })

    it('forgetEntriesQuiet (the quit-time hook) forgets and emits but never re-lists the directories', () => {
      vi.mocked(refreshCanonicalDirectories).mockClear()
      vi.mocked(loadSessionConfig).mockReturnValueOnce({
        worktreeInfoMap: { r1: { worktreePath: '/tmp/wt-quiet' } }
      } as never)

      forgetEntriesQuiet(['/tmp/wt-quiet'])

      expect(refreshCanonicalDirectories).not.toHaveBeenCalled()
      // ...while the in-session hook does (a Codex app-server must not start after the teardown).
      forgetEntriesAndEmit(['/tmp/wt-quiet'])
      expect(refreshCanonicalDirectories).toHaveBeenCalledTimes(1)
    })

    it('a failing directories refresh never fails the removal hook', async () => {
      vi.mocked(refreshCanonicalDirectories).mockRejectedValueOnce(new Error('listing failed'))
      await harness.call('worktree:remove-many', '/tmp/r', ['a'])
      const opts = vi.mocked(removeWorktrees).mock.lastCall![3] as {
        forgetEntries: (paths: string[]) => void
      }
      expect(() => opts.forgetEntries(['/tmp/r/.claude/worktrees/a'])).not.toThrow()
      await Promise.resolve()
    })

    it('worktree:remove-many refuses a non-array or oversized id list before touching git', async () => {
      vi.mocked(removeWorktrees).mockClear()
      for (const bad of ['a', null, [1], new Array(501).fill('x')]) {
        const res = await harness.call<any>('worktree:remove-many', '/tmp/r', bad)
        expect(res.ok).toBe(false)
      }
      expect(removeWorktrees).not.toHaveBeenCalled()
    })

    it('the manager channels take only a non-empty absolute directory (N2)', async () => {
      vi.mocked(inventoryWorktrees).mockClear()
      vi.mocked(removeWorktrees).mockClear()
      for (const bad of ['', 'relative/repo', '.', null, 5]) {
        for (const [channel, rest] of [
          ['worktree:inventory', []],
          ['worktree:inspect', ['id']],
          ['worktree:measure', ['id']],
          ['worktree:remove-many', [['a']]]
        ] as const) {
          const res = await harness.call<any>(channel, bad, ...rest)
          expect(res.ok, `${channel} ${String(bad)}`).toBe(false)
        }
      }
      expect(inventoryWorktrees).not.toHaveBeenCalled()
      expect(removeWorktrees).not.toHaveBeenCalled()
    })

    it('worktree:measure forwards the walker’s progress through the reporter', async () => {
      const res = await harness.call<any>('worktree:measure', '/tmp/r', 'id-1')
      expect(res).toMatchObject({ ok: true, data: { files: 7, bytes: 70 } })
      expect(vi.mocked(measureWorktree).mock.lastCall![0]).toBe('/tmp/r')
      expect(vi.mocked(measureWorktree).mock.lastCall![1]).toBe('id-1')
    })

    it('legacy worktree:remove ENFORCES holders (passes sources) and RETURNS the result (C-B3)', async () => {
      const res = await harness.call<any>('worktree:remove', '/tmp/wt', 'feat', '/tmp/r')

      expect(res).toEqual({ ok: true, data: { id: '/tmp/wt', outcome: 'removed' } })
      const deps = vi.mocked(removeWorktree).mock.lastCall![3] as Record<string, unknown>
      expect(deps).toMatchObject({
        sources: expect.any(Object),
        forgetEntries: expect.any(Function),
        beforeWalk: expect.any(Function)
      })
    })

    it('legacy worktree:remove declares withProgress and threads the reporter to the removal (exit review S1)', async () => {
      expect(commandRegistry.declaration('worktree:remove')).toMatchObject({
        capability: 'git',
        kind: 'command',
        withProgress: true
      })
      const reporter = vi.fn()
      // The reporter LEADS the handler args, never the wire's (which stay path, branch, root).
      await dispatchDesktop('worktree:remove', ['/tmp/wt', 'feat', '/tmp/r'], reporter)
      const [wtPath, branch, root, deps] = vi.mocked(removeWorktree).mock.lastCall! as [
        string,
        string,
        string,
        { progress: (p: unknown) => void }
      ]
      expect([wtPath, branch, root]).toEqual(['/tmp/wt', 'feat', '/tmp/r'])
      deps.progress({ done: 1, total: 2, phase: 'walking' })
      expect(reporter).toHaveBeenCalledWith({ done: 1, total: 2, phase: 'walking' })
    })

    it('legacy worktree:remove takes only a non-empty absolute path (N3)', async () => {
      vi.mocked(removeWorktree).mockClear()
      for (const bad of ['', 'relative/wt', '.', null, 5]) {
        const res = await harness.call<any>('worktree:remove', bad, 'feat', '/tmp/r')
        expect(res.ok, String(bad)).toBe(false)
      }
      expect(removeWorktree).not.toHaveBeenCalled()
    })

    it('legacy worktree:remove accepts only a worktree ClaudeUI created (C-S11, server side)', async () => {
      await harness.call('worktree:remove', '/tmp/wt-made', 'feat', '/tmp/r')
      const { createdOnly } = vi.mocked(removeWorktree).mock.lastCall![3] as {
        createdOnly: (p: string) => boolean
      }
      const info = { worktreeName: 'x', originalHeadCommit: 'abc' }
      vi.mocked(loadSessionConfig).mockReturnValue({
        worktreeInfoMap: {
          made: { ...info, worktreePath: '/tmp/wt-made', origin: 'created' },
          seen: { ...info, worktreePath: '/tmp/wt-seen', origin: 'detected' }
        }
      } as never)
      try {
        expect(createdOnly('/tmp/wt-made')).toBe(true)
        expect(createdOnly('/tmp/wt-seen')).toBe(false)
        expect(createdOnly('/tmp/wt-unknown')).toBe(false)
      } finally {
        vi.mocked(loadSessionConfig).mockReturnValue({} as never)
      }
    })

    it('worktree:remove-many does NOT restrict to created worktrees (the manager removes Codex/opencode/orphan ones too)', async () => {
      await harness.call('worktree:remove-many', '/tmp/r', ['a'])
      const opts = vi.mocked(removeWorktrees).mock.lastCall![3] as Record<string, unknown>
      expect(opts.createdOnly).toBeUndefined()
    })
  })

  // C-S7 (ADR-112): the desktop mockup watcher gets the `error` listener its remote twin has,
  // and its watches are closeable by path so a worktree removal is not blocked by them.
  describe('mockup watcher (desktop registration)', () => {
    let root: string
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-mockup-'))
      fs.mkdirSync(path.join(root, '.claude', 'ui', 'mockups', 'm1'), { recursive: true })
    })
    afterEach(() => {
      closeMockupWatchersUnder(root)
      fs.rmSync(root, { recursive: true, force: true })
    })

    it('a watcher fault drops the watch from the map instead of crashing the process or blocking a re-watch', async () => {
      const faults: Array<(err: Error) => void> = []
      // fs.watch itself is not spy-able (frozen module namespace); the listeners it is handed are.
      // The probe uses the production options: on Linux a recursive watch is a different (JS)
      // watcher class from a plain one, so a plain probe's prototype would miss its listeners.
      const probe = fs.watch(root, { recursive: true })
      const watcherProto = Object.getPrototypeOf(probe) as { on: () => unknown }
      probe.close()
      const spy = vi.spyOn(watcherProto, 'on').mockImplementation(function (
        this: unknown,
        event: string,
        fn: (...a: any[]) => void
      ) {
        if (event === 'error') faults.push(fn as (err: Error) => void)
        return EventEmitter.prototype.on.call(this, event, fn)
      } as never)
      try {
        await harness.call('mockup:watch', root, 'm1')
        expect(faults).toHaveLength(1) // the listener exists
        faults[0](new Error('EPERM: watched directory deleted'))
        // Dropped: closing by path now finds nothing, and a fresh watch is accepted again.
        expect(closeMockupWatchersUnder(root)).toBe(0)
        await harness.call('mockup:watch', root, 'm1')
        expect(faults).toHaveLength(2)
      } finally {
        spy.mockRestore()
      }
    })

    it('closeMockupWatchersUnder closes the watch and frees the map key so the mockup can be watched again', async () => {
      await harness.call('mockup:watch', root, 'm1')
      expect(closeMockupWatchersUnder(path.join(root, '.claude'))).toBe(1)
      await harness.call('mockup:watch', root, 'm1')
      expect(closeMockupWatchersUnder(root)).toBe(1)
    })

    it('mockup:unwatch closes the watch and untracks it', async () => {
      await harness.call('mockup:watch', root, 'm1')
      await harness.call('mockup:unwatch', root, 'm1')
      expect(closeMockupWatchersUnder(root)).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Voice channels
  // -------------------------------------------------------------------------

  describe('voice channels', () => {
    beforeEach(() => {
      voiceRelaySpies.start.mockClear()
      voiceRelaySpies.stop.mockClear()
    })

    it('voice:start-recording binds the HOST WINDOW as capture owner, with the language', async () => {
      const res = await harness.call<any>('voice:start-recording', 'rid-1', 'en')
      expect(res.ok).toBe(true)
      expect(voiceRelaySpies.start).toHaveBeenCalledTimes(1)
      const [manager, owner, routingId, language] = voiceRelaySpies.start.mock.calls[0] as [
        unknown,
        { key: string },
        string,
        string
      ]
      expect((manager as { get: unknown }).get).toBe(sessionManagerSpies.get)
      // The key the `voice:audio` feed derives from the IPC sender (the bridge's
      // webContents is id 1).
      expect(owner.key).toBe(`desktop:${harness.win.webContents.id}`)
      expect(routingId).toBe('rid-1')
      expect(language).toBe('en')
    })

    it('voice:start-recording passes the preview choice of the client to the relay (ADR-101)', async () => {
      await harness.call<any>('voice:start-recording', 'rid-1', 'en', { preview: false })
      expect(voiceRelaySpies.start.mock.calls[0][4]).toEqual({ preview: false })

      voiceRelaySpies.start.mockClear()
      await harness.call<any>('voice:start-recording', 'rid-1', 'en')
      expect(voiceRelaySpies.start.mock.calls[0][4]).toEqual({ preview: undefined })
    })

    it('voice:stop-recording ends the host window owner', async () => {
      const res = await harness.call<any>('voice:stop-recording', 'rid-1')
      expect(res.ok).toBe(true)
      expect(voiceRelaySpies.stop).toHaveBeenCalledWith(`desktop:${harness.win.webContents.id}`)
    })

    it('voice:start-recording returns ok=false when no session', async () => {
      sessionManagerSpies.get.mockReturnValueOnce(undefined as any)
      const res = await harness.call<any>('voice:start-recording', 'nope', 'en')
      expect(res.ok).toBe(false)
      expect(res.error).toBe('No active session')
      expect(voiceRelaySpies.start).not.toHaveBeenCalled()
    })

    it('voice:stop-recording releases the window capture even when the session is gone', async () => {
      // The capture is the WINDOW's: a session that vanished mid-press must not
      // leave the relay holding a stream open. The handler never looks it up.
      const res = await harness.call<any>('voice:stop-recording', 'gone')
      expect(res.ok).toBe(true)
      expect(voiceRelaySpies.stop).toHaveBeenCalledWith(`desktop:${harness.win.webContents.id}`)
    })

    it('refuses the start on a Claude binary without the voice-server patch', async () => {
      // ClaudeSession.capabilities.voice is false exactly then.
      const caps = sessionStub.capabilities
      sessionStub.capabilities = { ...caps, voice: false }
      try {
        const res = await harness.call<any>('voice:start-recording', 'rid-1', 'en')
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/voice-server patch/)
        expect(voiceRelaySpies.start).not.toHaveBeenCalled()
      } finally {
        sessionStub.capabilities = caps
      }
    })

    it('the server verbs are gone — no renderer ever called them', async () => {
      await expect(harness.call('voice:start-server', 'rid-1')).rejects.toThrow()
      await expect(harness.call('voice:stop-server', 'rid-1')).rejects.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // Usage / misc
  // -------------------------------------------------------------------------

  describe('misc channels', () => {
    it('does not wire turn-end notes to the session that started a session (slice 5: nothing reports back)', () => {
      expect(sessionNotesSpies.configureSessionNotes).not.toHaveBeenCalled()
      expect(sessionNotesSpies.enableSessionNotes).not.toHaveBeenCalled()
    })

    it('usage:fetch is registered', async () => {
      await expect(harness.call('usage:fetch')).resolves.toBeDefined()
    })

    it('session:get-models is registered', async () => {
      // Past the 2-minute model cache, so this call spawns its probe.
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000)
      try {
        const res = await harness.call<any[]>('session:get-models')
        expect(Array.isArray(res)).toBe(true)
      } finally {
        now.mockRestore()
      }
      // Init-only probe: no reload_plugins in a process killed after initialize.
      expect(vi.mocked(query)).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '',
          options: expect.objectContaining({ reloadPlugins: false })
        })
      )
    })

    // The composer asks per engine (engine-models.ts); the id must reach the
    // handler through the desktop transport, or every request answers all four.
    it('session:get-engine-models carries its engine id: codex probes only codex', async () => {
      const { discoverCodexModels } = await import('../../../core/codex/model-discovery')
      const native = {
        engineId: 'codex' as const,
        vendorId: 'openai',
        vendorName: 'OpenAI',
        models: [{ value: 'gpt', displayName: 'GPT', description: '', engineId: 'codex' as const }]
      }
      vi.mocked(discoverCodexModels).mockResolvedValueOnce([native])
      await expect(harness.call('session:get-engine-models', 'codex')).resolves.toEqual([native])
      // Claude's probe never ran.
      expect(vi.mocked(query)).not.toHaveBeenCalled()
      await expect(harness.call('session:get-engine-models', 'gemini')).rejects.toThrow(
        /unknown engine/
      )
    })

    describe('session:get-models login-status reporting', () => {
      // A remote picker fetch fills the same catalog WITHOUT reporting login status
      // (it has no auth side effects), so a fresh catalog must not make the
      // desktop's first fetch skip its own query.
      const reportLoginStatus = vi.fn()
      const account = { emailAddress: 'someone@example.test' }

      function answerWith(initializationResult: () => Promise<unknown>): void {
        vi.mocked(query).mockImplementationOnce((() => {
          async function* empty(): AsyncGenerator<unknown> {
            /* noop */
          }
          const gen: any = empty()
          gen.supportedModels = async () => [{ value: 'sonnet', description: '' }]
          gen.initializationResult = initializationResult
          return gen
        }) as any)
      }

      beforeEach(() => {
        reportLoginStatus.mockClear()
        vi.mocked(query).mockClear()
        resetCachedClaudeModels()
        resetLoginStatusReportedForTests()
        setHostAuth({
          getAccountState: vi.fn(),
          buildClaudeAccountRef: vi.fn(),
          updateClaudeAuthSource: vi.fn(),
          reportLoginStatus
        } as any)
      })

      afterEach(() => {
        setHostAuth(null)
        resetCachedClaudeModels()
        resetLoginStatusReportedForTests()
      })

      it('queries and reports on the first desktop fetch even when a remote fetch filled the catalog (GUARD)', async () => {
        setCachedClaudeModels([{ value: 'from-remote', description: '' }] as any)
        answerWith(async () => ({ account }))

        const res = await harness.call<any[]>('session:get-models')

        expect(vi.mocked(query)).toHaveBeenCalledTimes(1)
        expect(reportLoginStatus).toHaveBeenCalledTimes(1)
        expect(reportLoginStatus).toHaveBeenCalledWith(account)
        expect(res).toEqual([{ value: 'sonnet', description: '' }])
      })

      it('then serves the next desktop call within the TTL from the cache', async () => {
        answerWith(async () => ({ account }))
        await harness.call('session:get-models')
        vi.mocked(query).mockClear()

        await harness.call('session:get-models')

        expect(vi.mocked(query)).not.toHaveBeenCalled()
        expect(reportLoginStatus).toHaveBeenCalledTimes(1)
      })

      it('an init that cannot be read is non-fatal and does not send later calls past the cache', async () => {
        answerWith(async () => {
          throw new Error('init unavailable')
        })
        await harness.call('session:get-models')
        expect(reportLoginStatus).not.toHaveBeenCalled()
        vi.mocked(query).mockClear()

        await harness.call('session:get-models')

        expect(vi.mocked(query)).not.toHaveBeenCalled()
      })
    })

    it.each([
      ['session:generate-title', 'a conversation'],
      ['session:generate-commit-message', 'diff --git a/x b/x']
    ])('%s spawns its one-shot without a plugin reload', async (channel, arg) => {
      await harness.call(channel, arg)
      expect(vi.mocked(query)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(query).mock.calls[0][0].options).toMatchObject({ reloadPlugins: false })
    })

    it('session:set-permission-mode routes to session.setPermissionMode', async () => {
      await harness.call('session:set-permission-mode', 'rid-1', 'acceptEdits')
      expect(sessionStub.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
    })

    it('session:set-effort routes to session.setEffort', async () => {
      await harness.call('session:set-effort', 'rid-1', 'high')
      expect(sessionStub.setEffort).toHaveBeenCalledWith('high')
    })

    it('registers and routes the shared-provider channel family', async () => {
      const definition = {
        id: 'local',
        name: 'Local',
        kind: 'custom',
        protocol: 'openai-completions',
        baseUrl: 'https://example.test/v1',
        models: [{ id: 'model' }],
        routes: { pi: { enabled: true }, opencode: { enabled: true } },
        managed: true
      }

      await harness.callSafe('shared-provider:list')
      await harness.callSafe('shared-provider:statuses')
      await harness.callSafe('shared-provider:models', 'local')
      await harness.callSafe('shared-provider:save', definition)
      await harness.callSafe('shared-provider:remove', 'local')
      await harness.callSafe('shared-provider:set-route', 'local', 'pi', false)
      await harness.callSafe('shared-provider:set-key', 'local', 'secret')
      await harness.callSafe('shared-provider:sync', 'local')
      await harness.callSafe('shared-provider:disconnect', 'local')
      await harness.callSafe('shared-provider:set-default', 'local', 'opencode', 'model')

      expect(sharedProviderSpies.saveDefinition).toHaveBeenCalledWith(definition)
      expect(sharedProviderSpies.setRouteEnabled).toHaveBeenCalledWith('local', 'pi', false)
      expect(sharedProviderSpies.disconnectProvider).toHaveBeenCalledWith('local')
      // No `replaceOwn` replaces nothing.
      expect(sharedProviderSpies.setApiKey).toHaveBeenCalledWith('local', 'secret', [])
    })

    it('set-key takes replaceOwn as a LIST of harnesses, never a blanket yes (S7f)', async () => {
      sharedProviderSpies.setApiKey.mockClear()
      await harness.callSafe('shared-provider:set-key', 'local', 'secret', ['pi'])
      expect(sharedProviderSpies.setApiKey).toHaveBeenCalledWith('local', 'secret', ['pi'])
      for (const bad of [true, 'pi', ['pi', 'codex']]) {
        await expect(
          harness.callSafe('shared-provider:set-key', 'local', 'secret', bad)
        ).rejects.toThrow(/replaceOwn/)
      }
      expect(sharedProviderSpies.setApiKey).toHaveBeenCalledTimes(1)
    })

    it('own-key-holders answers the service’s list, and refuses a malformed vendor id (S7f)', async () => {
      sharedProviderSpies.ownKeyHolders.mockClear()
      sharedProviderSpies.ownKeyHolders.mockResolvedValueOnce(['opencode'])
      await expect(harness.callSafe('shared-provider:own-key-holders', 'io.net')).resolves.toEqual([
        'opencode'
      ])
      for (const bad of ['', '../auth.json', 'open router', ['openrouter'], null]) {
        await expect(harness.callSafe('shared-provider:own-key-holders', bad)).rejects.toThrow(
          /Invalid provider id/
        )
      }
      expect(sharedProviderSpies.ownKeyHolders).toHaveBeenCalledTimes(1)
    })

    it('shared-provider:probe shape-checks its request before the host dials anything', async () => {
      // `null`s are what the web transport makes of omitted fields.
      await expect(
        harness.callSafe('shared-provider:probe', {
          baseUrl: 'http://gpu:8000/v1',
          protocol: null,
          apiKey: null,
          providerId: 'local'
        })
      ).resolves.toEqual({ status: 'detected', server: 'vllm', models: [] })
      expect(sharedProviderSpies.probeEndpoint).toHaveBeenLastCalledWith({
        baseUrl: 'http://gpu:8000/v1',
        providerId: 'local'
      })

      sharedProviderSpies.probeEndpoint.mockClear()
      for (const bad of [
        undefined,
        { baseUrl: 42 },
        { baseUrl: 'http://gpu/v1', protocol: 'grpc' },
        { baseUrl: 'http://gpu/v1', apiKey: { key: 'x' } },
        { baseUrl: 'http://gpu/v1', providerId: 7 }
      ])
        await expect(harness.callSafe('shared-provider:probe', bad)).rejects.toThrow()
      expect(sharedProviderSpies.probeEndpoint).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // ISession optional-member safety (Item 3)
  //
  // These handlers cast ISession to ClaudeSession before Item 3; the refactor
  // replaced the cast with capability checks + optional-call (`?.`). Verify a
  // session that advertises the capability but doesn't implement the optional
  // method (e.g. a future/partial engine) degrades to the documented fallback
  // instead of throwing "not a function".
  // -------------------------------------------------------------------------

  describe('ISession optional-member safety (Item 3)', () => {
    it('handlers fall back safely when a capability-true session lacks the optional method', async () => {
      const minimalStub: any = {
        engineId: 'claude',
        capabilities: resolveClaudeCapabilities('default'),
        willQueue: false,
        cwd: '/tmp/cwd',
        run: vi.fn(),
        resolveApproval: vi.fn(),
        setPermissionMode: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}),
        // Required ISession members (BaseSession implements them for every
        // engine), so a "minimal" engine still has them.
        queuedItems: [],
        enqueuePrompt: vi.fn(),
        recallQueued: vi.fn(async () => ({ recalled: [], notRecalled: 0 }))
        // Deliberately no optional members: no watchBackground, stopTask,
        // getPlanContent, getSessionLogPath, mcpServerStatus, mcpToggleServer,
        // setEffort, etc.
      }
      sessionManagerSpies.get.mockReturnValue(minimalStub)

      await expect(harness.call<unknown[]>('mcp:status', 'rid-min')).resolves.toEqual([])

      await expect(
        harness.call<{ removed: number }>('session:dequeue-message', 'rid-min', 'val')
      ).resolves.toEqual({ removed: 0 })

      await expect(
        harness.call<string | null>('session:get-plan-content', 'rid-min')
      ).resolves.toBeNull()

      await expect(
        harness.call<string | null>('session:get-session-log-path', 'rid-min')
      ).resolves.toBeNull()

      await expect(
        harness.call<{ success: boolean; error?: string }>('session:stop-task', 'rid-min', 'tool-1')
      ).resolves.toEqual({
        success: false,
        error: 'Provider does not support background tasks'
      })

      // mcp:toggle: capability is true but the method is absent — this is the
      // guard that proves the method-presence check (not just the capability
      // flag) gates the call.
      const mcpToggle = await harness.call<any>('mcp:toggle', 'rid-min', 'srv', true)
      expect(mcpToggle).toEqual({ ok: false, error: 'Provider does not support hosted MCP' })

      await expect(harness.call('session:set-effort', 'rid-min', 'high')).resolves.toBeUndefined()

      // Restore the default stub for any subsequent tests in this file.
      sessionManagerSpies.get.mockReturnValue(sessionStub)
    })

    it('claude:save-permissions invokes notifySettingsChanged via the neutral forEach iteration', async () => {
      await harness.call('claude:save-permissions', 'user', { allow: [], deny: [], ask: [] })
      expect(sessionStub.notifySettingsChanged).toHaveBeenCalled()
    })
  })
  // LOW-RW3 — session:write-custom-title builds
  // ~/.claude/projects/<projectKey>/<sessionId>.jsonl from two caller-supplied
  // strings and appends to it. A traversal segment let the renderer (and, via
  // the remote twin, any token-holding remote client) append attacker-shaped
  // JSON to an arbitrary *.jsonl on disk.
  describe('session:write-custom-title path-segment validation', () => {
    let appendSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      appendSpy = vi.spyOn(fs.promises, 'appendFile').mockResolvedValue(undefined)
    })

    afterEach(() => {
      appendSpy.mockRestore()
    })

    it.each([
      ['..', 'sess-1'],
      ['a/b', 'sess-1'],
      ['a\\b', 'sess-1'],
      ['proj', '../../evil'],
      ['proj', 'a/b']
    ])(
      'rejects traversal (projectKey=%j, sessionId=%j) without writing (GUARD — fails pre-fix)',
      async (projectKey, sessionId) => {
        await expect(
          harness.call('session:write-custom-title', sessionId, projectKey, 'pwned')
        ).rejects.toThrow(/Invalid (sessionId|projectKey)/)
        expect(appendSpy).not.toHaveBeenCalled()
      }
    )

    it('still appends the custom-title entry for plain identifiers', async () => {
      await harness.call('session:write-custom-title', 'sess-1', '-d-proj', 'My title')
      expect(appendSpy).toHaveBeenCalledTimes(1)
      const [target, payload] = appendSpy.mock.calls[0]
      expect(String(target)).toBe(
        path.join(os.homedir(), '.claude', 'projects', '-d-proj', 'sess-1.jsonl')
      )
      expect(String(payload)).toContain('"customTitle":"My title"')
    })
  })

  // ADR-102 Arc 2 — the desktop registrations of the session-load channels. The
  // remote twins are pinned in remote-handlers.ipc.test.ts; the registry asserts
  // the two agree on every declared attribute.
  describe('session load channels (ADR-102 Arc 2)', () => {
    it('session:load-history: the 3-arg call is the full read; options defer only on a literal true', async () => {
      await harness.call('session:load-history', 'sess-1', 'proj-key', undefined)
      expect(loadClaudeHistoryMock).toHaveBeenLastCalledWith('sess-1', 'proj-key', undefined, {
        onProgress: expect.any(Function),
        deferStatusLine: false
      })

      await harness.call('session:load-history', 'sess-1', 'proj-key', 'anchor-1', {
        deferStatusLine: true,
        extra: 'ignored'
      })
      expect(loadClaudeHistoryMock).toHaveBeenLastCalledWith('sess-1', 'proj-key', 'anchor-1', {
        onProgress: expect.any(Function),
        deferStatusLine: true
      })

      for (const bad of [null, 'deferStatusLine', 7, { deferStatusLine: 'true' }, ['x']]) {
        await harness.call('session:load-history', 'sess-1', 'proj-key', undefined, bad)
        expect(vi.mocked(loadClaudeHistoryMock).mock.lastCall?.[3]).toMatchObject({
          deferStatusLine: false
        })
      }
    })

    it('session:load-status-line is an fs-read query with withProgress and forwards the reporter', async () => {
      expect(commandRegistry.declaration('session:load-status-line')).toMatchObject({
        capability: 'fs-read',
        kind: 'query',
        withProgress: true
      })
      await expect(harness.call('session:load-status-line', 'sess-1', 'proj-key')).resolves.toEqual(
        {
          totalCostUsd: 2
        }
      )
      expect(loadStatusLineMock).toHaveBeenLastCalledWith(
        'sess-1',
        'proj-key',
        expect.any(Function)
      )
    })

    it('session:load-subagent-history declares withProgress and keeps its wire args', async () => {
      expect(commandRegistry.declaration('session:load-subagent-history')?.withProgress).toBe(true)
      await harness.call('session:load-subagent-history', 'sess-1', 'proj-key', 'agent-9')
      expect(loadSubagentHistoryMock).toHaveBeenLastCalledWith('sess-1', 'proj-key', 'agent-9')
    })

    // The three Claude history readers join sessionId / projectKey (/ agentId) into a
    // ~/.claude/projects path, and these channels are reachable by any `fs-read`
    // caller. A traversal value must be refused before the reader (the filesystem) runs.
    describe.each([
      ['session:load-history', () => loadClaudeHistoryMock, []],
      ['session:load-status-line', () => loadStatusLineMock, []],
      ['session:load-subagent-history', () => loadSubagentHistoryMock, ['agent-9']]
    ] as const)('%s path-segment validation', (channel, reader, tail) => {
      it.each([
        ['sessionId', ['../x', 'proj-key']],
        ['sessionId', ['a/b', 'proj-key']],
        ['sessionId', ['a\\b', 'proj-key']],
        ['sessionId', ['', 'proj-key']],
        ['projectKey', ['sess-1', '../x']],
        ['projectKey', ['sess-1', 'a/b']],
        ['projectKey', ['sess-1', 'a\\b']],
        ['projectKey', ['sess-1', '..']],
        ['projectKey', ['sess-1', '']]
      ])('refuses a bad %s (%j) before any read (GUARD — fails pre-fix)', async (label, ids) => {
        vi.mocked(reader()).mockClear()
        await expect(harness.call(channel, ...ids, ...tail)).rejects.toThrow(
          new RegExp(`Invalid ${label}`)
        )
        expect(reader()).not.toHaveBeenCalled()
      })

      it('passes a valid call through unchanged', async () => {
        vi.mocked(reader()).mockClear()
        await harness.call(channel, 'sess-1', 'proj-key', ...tail)
        expect(reader()).toHaveBeenCalledTimes(1)
        expect(vi.mocked(reader()).mock.lastCall?.slice(0, 2 + tail.length)).toEqual([
          'sess-1',
          'proj-key',
          ...tail
        ])
      })
    })

    it('session:load-subagent-history refuses a bad agentId before any read (GUARD — fails pre-fix)', async () => {
      vi.mocked(loadSubagentHistoryMock).mockClear()
      for (const agentId of ['../x', 'a/b', 'a\\b', '..', '']) {
        await expect(
          harness.call('session:load-subagent-history', 'sess-1', 'proj-key', agentId)
        ).rejects.toThrow(/Invalid agentId/)
      }
      expect(loadSubagentHistoryMock).not.toHaveBeenCalled()
    })

    it('registers session:load-status-line on the desktop transport', () => {
      expect(commandRegistry.channels('desktop')).toContain('session:load-status-line')
    })

    it('session:load-status-line is on the registrar unbind list (R5)', () => {
      const removed = vi.spyOn(harness.bridge.ipcMain, 'removeHandler')
      registerSessionIpc({
        requireEngineAuth: () => {
          throw new Error('not stubbed')
        },
        setAccountEnabled: () => {
          throw new Error('not stubbed')
        }
      })
      // Twice: once by the registrar's up-front unbind list, once by the binder's
      // own remove-before-handle. One means the channel fell off the list.
      expect(removed.mock.calls.filter(([c]) => c === 'session:load-status-line')).toHaveLength(2)
      removed.mockRestore()
    })
  })
})
