/**
 * @vitest-environment node
 *
 * Unit tests for handlers-core.ts — the session-domain handler bodies shared
 * by session.ipc.ts (desktop) and remote-handlers.ts (remote WebSocket).
 *
 * Focus: each exported fn behaves identically regardless of which surface
 * calls it. The REQUIRED parity assertion registers a shared fn on a real
 * RemoteDispatcher and compares its result against a direct (desktop-style)
 * call for the same args — proving the "thin wrapper, no envelope" invariant
 * holds end-to-end, not just by inspection of the wrapper code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import { RemoteDispatcher } from '../../../core/services/remote-dispatcher'
import { CommandRegistry, makeRemoteConnection } from '../../../core/ipc/command-registry'
import { resolveClaudeCapabilities } from '../../../shared/model-capabilities'

vi.mock('../../../core/services/skill-scanner', () => ({
  scanSkills: vi.fn(async () => [])
}))

vi.mock('../../../core/services/claude-settings', () => ({
  saveCleanupPeriodDays: vi.fn()
}))

vi.mock('../../../core/services/ui-config', () => ({
  saveSessionConfig: vi.fn(),
  // Pulled in transitively via claude-session → collab-tool →
  // cross-engine-dispatcher (ADR-033).
  loadEngineConfig: vi.fn(() => ({}))
}))

// F1's delete path: the FILE deletes and the directory re-read are collaborators
// with real I/O, so they are stubbed — what these tests pin is the ORDER
// (cancel → replicate the removal → unlink) and the project sweep's membership.
const {
  deleteSessionByEngine,
  deleteProjectFiles,
  deleteSessionFiles,
  refreshCanonicalDirectories
} = vi.hoisted(() => ({
  deleteSessionByEngine: vi.fn(async (_id: string, _key?: string, _engine?: string) => {}),
  deleteProjectFiles: vi.fn(async () => {}),
  deleteSessionFiles: vi.fn(async (_id: string, _key: string) => {}),
  refreshCanonicalDirectories: vi.fn(async () => {})
}))
vi.mock('../../../core/services/session-delete', () => ({ deleteSessionByEngine }))
vi.mock('../../../core/services/delete-session-files', () => ({
  deleteProjectFiles,
  deleteSessionFiles
}))
vi.mock('../../../core/services/sync-seed', () => ({ refreshCanonicalDirectories }))

// R1: a delete must UNWATCH before the file it watches disappears.
const { unwatchSession } = vi.hoisted(() => ({ unwatchSession: vi.fn() }))
vi.mock('../../../core/services/session-watcher', () => ({ unwatchSession }))

// Slice G's Codex walk. The plan and the native delete are the subject of
// `core/codex/__tests__/codex-delete.test.ts`; what these tests pin is that the
// codex branch reaches the walk at all, with hooks wired to this module's own
// unwatch/cancel/replicate, and that a refusal still refreshes the listing.
const { codexDeletePlan, deleteCodexSubtree } = vi.hoisted(() => ({
  codexDeletePlan: vi.fn((...args: any[]) => ({
    nodes: [{ threadId: args[0], title: null, live: false, depth: 0 }],
    order: [args[0]]
  })),
  // Returns the threads it deleted, exactly as the real walk does — a project
  // sweep reads that answer to know what it must not plan again.
  deleteCodexSubtree: vi.fn(async (...args: any[]) => args[0].order as string[])
}))
vi.mock('../../../core/codex/delete', () => ({ codexDeletePlan, deleteCodexSubtree }))

// The lineage scan the walk's one rescan runs. Mocked because the real one
// spawns an app-server; what these tests pin is that a refusal can reach it.
const { scanCodexLineage } = vi.hoisted(() => ({
  scanCodexLineage: vi.fn(async () => ({ read: 0, learned: 0 }))
}))
vi.mock('../../../core/codex/history', () => ({ scanCodexLineage }))

// Import AFTER mocks.
import {
  mcpStatus,
  stopTask,
  getPlanContent,
  getSessionLogPath,
  dequeueMessage,
  saveSessions,
  listDirEntries,
  listPlaces,
  setPermissionMode,
  setModel,
  setAccount,
  deleteSession,
  deleteProject,
  clearConversation
} from '../../../core/ipc/handlers-core'
import { syncCore, addSyncSubscriber } from '../../../core/services/sync-host'

function makeSessionStub(overrides: Record<string, unknown> = {}): any {
  return {
    engineId: 'claude',
    cwd: '/tmp/cwd',
    capabilities: resolveClaudeCapabilities('default'),
    willQueue: false,
    mcpServerStatus: vi.fn(async () => [{ name: 'srv', connected: true }]),
    ...overrides
  }
}

function makeManager(sessionStub: any): any {
  return {
    get: vi.fn(() => sessionStub),
    has: vi.fn(() => sessionStub !== undefined),
    forEach: vi.fn((cb: (s: any) => void) => cb(sessionStub))
  }
}

function makeFakeWindow(): any {
  return {
    webContents: { send: vi.fn() },
    isDestroyed: () => false
  }
}

describe('handlers-core', () => {
  it('mcpStatus behaves identically whether called directly (desktop-style) or via RemoteDispatcher', async () => {
    const sessionStub = makeSessionStub()
    const manager = makeManager(sessionStub)
    const registry = new CommandRegistry()
    const dispatcher = new RemoteDispatcher(registry)
    registry.register({
      channel: 'mcp:status',
      capability: 'config',
      kind: 'query',
      transport: 'remote',
      handler: (rid: string) => mcpStatus(manager, rid)
    })

    const direct = await mcpStatus(manager, 'rid-1')
    const viaDispatcher = await dispatcher.handle(
      { type: 'invoke', id: '1', channel: 'mcp:status', args: ['rid-1'] },
      makeRemoteConnection('password', null)
    )

    expect(viaDispatcher).toEqual(direct)
    expect(direct).toEqual([{ name: 'srv', connected: true }])
  })

  it('stopTask returns the "no active session" shape when the session is missing', async () => {
    const manager = makeManager(undefined)
    const res = await stopTask(manager, 'ghost', 'tool-1')
    expect(res).toEqual({ success: false, error: 'No active session' })
  })

  it('stopTask returns the capability-false shape when backgroundTasks is unsupported', async () => {
    const sessionStub = makeSessionStub({
      capabilities: { ...resolveClaudeCapabilities('default'), backgroundTasks: false }
    })
    const manager = makeManager(sessionStub)
    const res = await stopTask(manager, 'rid-1', 'tool-1')
    expect(res).toEqual({ success: false, error: 'Provider does not support background tasks' })
  })

  it('getPlanContent falls back to null when the session lacks getPlanContent', async () => {
    const sessionStub = makeSessionStub() // capabilities.plan is true, no getPlanContent method
    const manager = makeManager(sessionStub)
    expect(getPlanContent(manager, 'rid-1')).toBeNull()
  })

  it('getSessionLogPath falls back to null when the session lacks getSessionLogPath', () => {
    const sessionStub = makeSessionStub()
    const manager = makeManager(sessionStub)
    expect(getSessionLogPath(manager, 'rid-1')).toBeNull()
  })

  it('dequeueMessage falls back to {removed: 0} when the session is missing', async () => {
    const manager = makeManager(undefined)
    const res = await dequeueMessage(manager, 'ghost', 'val')
    expect(res).toEqual({ removed: 0 })
  })

  it('saveSessions broadcasts to every subscriber, whoever saved (4c)', () => {
    // 4a split this by origin: a desktop save delivered `extras-only` because the
    // saving renderer "already knew". 4c deleted that — the saver is a subscriber
    // like everyone else, and the payload is a whole-config replace, so its own
    // echo is idempotent while remaining authoritative for every other client.
    const win = makeFakeWindow()
    const config = { sessions: [] } as any
    const sink = vi.fn()
    const off = addSyncSubscriber(sink)
    try {
      saveSessions(config)
      expect(sink).toHaveBeenCalledWith(expect.any(Number), 'config:sessions-changed', [config])
      // Never a targeted window send for a replicated channel.
      expect(win.webContents.send).not.toHaveBeenCalled()
    } finally {
      off()
    }
  })

  it('a DESKTOP-originated saveSessions is visible in the next getSnapshot (phase 4b)', () => {
    // The apply has to happen regardless of who saved — otherwise a phone that
    // resynced after a desktop pin/rename would read the pre-save registry until
    // the file watcher happened to fire. SyncCore applies before it delivers,
    // which is what makes this hold; this test is the thing that would notice if
    // that changed.
    syncCore.resetCanonicalForTests()
    saveSessions({
      recentSessions: ['rid-a'],
      pinnedSessions: ['rid-a'],
      customTitles: { 'rid-a': 'Renamed' }
    } as any)

    const snap = syncCore.getSnapshot()
    expect(snap.recentSessionIds).toEqual(['rid-a'])
    expect(snap.pinnedSessionIds).toEqual(['rid-a'])
    expect(snap.customTitles).toEqual({ 'rid-a': 'Renamed' })
  })

  it('listDirEntries returns the default empty shape for a nonexistent path', async () => {
    const res = await listDirEntries('/does/not/exist/zzzzz-unique')
    expect(res).toEqual({ entries: [], isRoot: false, resolvedPath: '' })
  })

  it('listDirEntries seeds the home directory for the empty path', async () => {
    // The remote picker opens with nothing typed. '' used to hit
    // `fs.readdir('')`, which throws into the empty shape — an empty box that
    // listed nothing until the user typed an absolute path. It must NOT fall
    // through to `path.resolve('')` either: that is the process cwd, which for a
    // packaged host is meaningless to the client.
    const home = os.homedir().replace(/\\/g, '/').replace(/\/$/, '')
    const seeded = await listDirEntries('')
    const explicit = await listDirEntries(os.homedir())

    expect(seeded.resolvedPath).toBe(home)
    expect(seeded).toEqual(explicit)
  })

  describe('listPlaces', () => {
    it('answers with a POSIX home, a hostname and a drive list', async () => {
      const places = await listPlaces()

      // The dialog seeds its rail from this, so a backslash in `home` would be
      // a path the browse pane cannot compare against its own POSIX values.
      expect(places.home).not.toBe('')
      expect(places.home).not.toContain('\\')
      expect(places.hostname).not.toBe('')
      expect(Array.isArray(places.drives)).toBe(true)
      for (const drive of places.drives) expect(typeof drive).toBe('string')
    })

    it('reports the roots this OS actually has', async () => {
      const { drives } = await listPlaces()

      if (process.platform === 'win32') {
        // Whatever else is mounted, the drive the home directory lives on must
        // have answered the probe.
        const homeRoot = path.parse(os.homedir()).root.replace(/\\/g, '/')
        expect(drives).toContain(homeRoot)
      } else {
        expect(drives).toEqual(['/'])
      }
    })
  })

  describe('setPermissionMode', () => {
    it('delegates to session.setPermissionMode when a live session exists, without sending directly', async () => {
      const sessionStub = makeSessionStub({ setPermissionMode: vi.fn(async () => {}) })
      const manager = makeManager(sessionStub)
      const win = makeFakeWindow()

      await setPermissionMode(manager, 'rid-1', 'acceptEdits')

      expect(sessionStub.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
      expect(win.webContents.send).not.toHaveBeenCalled()
    })

    it('does not throw and sends nothing for an invalid mode string', async () => {
      const manager = makeManager(undefined)
      const sink = vi.fn()
      const off = addSyncSubscriber(sink)

      await expect(setPermissionMode(manager, 'rid-1', 'not-a-real-mode')).resolves.not.toThrow()
      expect(sink).not.toHaveBeenCalled()
      off()
    })

    it('does not throw and does not call session.setPermissionMode for an invalid mode on a live session', async () => {
      const sessionStub = makeSessionStub({ setPermissionMode: vi.fn(async () => {}) })
      const manager = makeManager(sessionStub)

      await setPermissionMode(manager, 'rid-1', 'bogus')

      expect(sessionStub.setPermissionMode).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // ADR-068 §2 — the per-session account pin is CAPABILITY-gated at the handler
  // -------------------------------------------------------------------------

  describe('setAccount', () => {
    it('delegates to the session when the engine declares perSessionAccount', async () => {
      const sessionStub = makeSessionStub({
        engineId: 'codex',
        capabilities: {
          ...resolveClaudeCapabilities('default'),
          auth: { canDriveLogin: true, multiAccount: false, perSessionAccount: true }
        },
        setAccount: vi.fn(async () => {})
      })
      const manager = makeManager(sessionStub)

      await setAccount(manager, 'rid-1', 'acct-b')
      await setAccount(manager, 'rid-1', null)

      expect(sessionStub.setAccount).toHaveBeenNthCalledWith(1, 'acct-b')
      expect(sessionStub.setAccount).toHaveBeenNthCalledWith(2, null)
    })

    it('REFUSES on an engine without the capability rather than resolving into nothing', async () => {
      // Claude's `auth.perSessionAccount` is false. A silent no-op here would
      // leave the picker showing a pin the session never took.
      const sessionStub = makeSessionStub({ setAccount: vi.fn(async () => {}) })
      const manager = makeManager(sessionStub)

      await expect(setAccount(manager, 'rid-1', 'acct-b')).rejects.toThrow(
        'This engine does not support per-session accounts'
      )
      expect(sessionStub.setAccount).not.toHaveBeenCalled()
    })

    it('refuses a missing session and a malformed id', async () => {
      await expect(setAccount(makeManager(undefined), 'ghost', 'acct-b')).rejects.toThrow(
        'No active session'
      )
      const sessionStub = makeSessionStub({
        capabilities: {
          ...resolveClaudeCapabilities('default'),
          auth: { canDriveLogin: true, multiAccount: false, perSessionAccount: true }
        },
        setAccount: vi.fn(async () => {})
      })
      const manager = makeManager(sessionStub)
      for (const bad of ['', 'x'.repeat(257), 42 as unknown as string])
        await expect(setAccount(manager, 'rid-1', bad)).rejects.toThrow('Invalid account id')
      expect(sessionStub.setAccount).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // F1 — deletion has to reach every replica, not just the deleter
  // -------------------------------------------------------------------------

  describe('deleteSession / deleteProject', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      syncCore.resetCanonicalForTests()
    })

    it('unwatches, cancels, replicates the removal, THEN unlinks the files', async () => {
      const order: string[] = []
      unwatchSession.mockImplementation(() => order.push('unwatch'))
      const manager = {
        cancel: vi.fn(() => order.push('cancel')),
        get: vi.fn(),
        has: vi.fn(() => false),
        forEach: vi.fn()
      } as any
      deleteSessionByEngine.mockImplementation(async () => {
        order.push('unlink')
      })
      const sink = vi.fn((_seq: number, channel: string) => {
        if (channel === 'session:removed') order.push('removed')
      })
      const off = addSyncSubscriber(sink)
      try {
        syncCore.emit('session:created', ['rid-del', { cwd: '/repo' }])
        await deleteSession(manager, 'rid-del', '-repo', 'claude')

        // The order is the fix, and it is an order rather than a set.
        //
        // PRE-FIX the unwatch was missing entirely, and that is not cosmetic:
        // `session:watch-update` is the ONE reducer branch that still bootstraps
        // an entry (`ensured()`), and unlinking a watched `.jsonl` is exactly
        // what makes `fs.watch` fire again — so the post-delete update RE-MINTED
        // the session in canonical and in every replica.
        expect(order).toEqual(['unwatch', 'cancel', 'removed', 'unlink'])
        expect(unwatchSession).toHaveBeenCalledWith('rid-del')
        expect(manager.cancel).toHaveBeenCalledWith('rid-del')
        expect(deleteSessionByEngine).toHaveBeenCalledWith('rid-del', '-repo', 'claude')
        // PRE-FIX: canonical kept the entry forever (removeSession had zero
        // production callers), so every other client — and every resync — still
        // had a session whose transcript no longer exists.
        expect(syncCore.getCanonicalState().sessions['rid-del']).toBeUndefined()
      } finally {
        off()
      }
    })

    it('refreshes the directory listing, so an opencode/pi delete is visible everywhere', async () => {
      const manager = {
        cancel: vi.fn(),
        get: vi.fn(),
        has: vi.fn(() => false),
        forEach: vi.fn()
      } as any
      await deleteSession(manager, 'oc-1', '-repo', 'opencode')
      expect(refreshCanonicalDirectories).toHaveBeenCalled()
    })

    it('sweeps every session on the project — on-disk group members AND live sessions', async () => {
      const manager = {
        cancel: vi.fn(),
        get: vi.fn(),
        has: vi.fn(() => false),
        forEach: vi.fn()
      } as any
      // A live session whose cwd maps to the project key, but which the on-disk
      // listing does not know about yet.
      syncCore.emit('session:created', ['live-1', { cwd: '/repo' }])
      syncCore.emit('session:created', ['other', { cwd: '/elsewhere' }])
      // ...and an on-disk row the listing DOES know about, never spawned here.
      syncCore.setDirectories([
        {
          cwd: '/repo',
          projectKey: '-repo',
          folderName: 'repo',
          sessions: [{ sessionId: 'cold-1', cwd: '/repo', projectKey: '-repo' }]
        }
      ] as never)

      await deleteProject(manager, '-repo')

      expect(manager.cancel.mock.calls.map((c: unknown[]) => c[0]).sort()).toEqual([
        'cold-1',
        'live-1'
      ])
      // Every swept id is unwatched too, not just the one that was live (R1).
      expect(unwatchSession.mock.calls.map((c: unknown[]) => c[0]).sort()).toEqual([
        'cold-1',
        'live-1'
      ])
      expect(syncCore.getCanonicalState().sessions['live-1']).toBeUndefined()
      // A session on a DIFFERENT project is untouched.
      expect(syncCore.getCanonicalState().sessions['other']).toBeDefined()
      expect(deleteProjectFiles).toHaveBeenCalledWith('-repo')
    })

    /**
     * M1. `deleteProjectFiles` removes CLAUDE's files only. opencode keeps its
     * sessions in its own server store and pi under `~/.pi`, so those rows
     * survived the delete — and `refreshCanonicalDirectories()` then re-read them
     * and the merge RE-CREATED the group for the same cwd. On the desktop that
     * lasted until the renderer's own follow-up loop landed; over the remote
     * surface there is no such loop, so the project came back permanently.
     */
    it('deletes opencode / pi sessions through their OWN engines before unlinking', async () => {
      const manager = {
        cancel: vi.fn(),
        get: vi.fn(),
        forEach: vi.fn()
      } as any
      const order: string[] = []
      deleteSessionByEngine.mockImplementation(async (id: string) => {
        order.push(`engine:${id}`)
      })
      deleteProjectFiles.mockImplementation(async () => {
        order.push('unlink-claude')
      })
      syncCore.setDirectories([
        {
          cwd: '/repo',
          projectKey: '-repo',
          folderName: 'repo',
          sessions: [
            { sessionId: 'cl-1', cwd: '/repo', projectKey: '-repo', engineId: 'claude' },
            { sessionId: 'oc-1', cwd: '/repo', projectKey: '-repo', engineId: 'opencode' },
            { sessionId: 'pi-1', cwd: '/repo', projectKey: '-repo', engineId: 'pi' }
          ]
        }
      ] as never)

      await deleteProject(manager, '-repo')

      // Claude rows are NOT deleted one by one — `deleteProjectFiles` takes the
      // whole directory — so only the foreign engines go through the dispatcher.
      expect(deleteSessionByEngine.mock.calls.map((c: unknown[]) => c[0]).sort()).toEqual([
        'oc-1',
        'pi-1'
      ])
      expect(deleteSessionByEngine).toHaveBeenCalledWith('oc-1', '-repo', 'opencode')
      expect(deleteSessionByEngine).toHaveBeenCalledWith('pi-1', '-repo', 'pi')
      // Engine-owned storage first; the irreversible Claude unlink last.
      expect(order[order.length - 1]).toBe('unlink-claude')
    })

    /**
     * A Claude session cli.js relocated into a worktree's project dir
     * (`EnterWorktree`) is listed under its HOME project, but its file lives in
     * `-repo--claude-worktrees-wt`. `deleteProjectFiles('-repo')` removes only
     * the home dir, so the member came straight back on the next listing. It is
     * deleted by its OWN key — one session, never the whole worktree dir, which
     * can hold sessions that are not members of this project.
     */
    it('deletes relocated Claude members by their own key before the home dir', async () => {
      const manager = {
        cancel: vi.fn(),
        get: vi.fn(),
        forEach: vi.fn()
      } as any
      const order: string[] = []
      deleteSessionFiles.mockImplementation(async (id: string, key: string) => {
        order.push(`session:${id}@${key}`)
      })
      deleteProjectFiles.mockImplementation(async () => {
        order.push('unlink-claude')
      })
      syncCore.setDirectories([
        {
          cwd: '/repo',
          projectKey: '-repo',
          folderName: 'repo',
          sessions: [
            { sessionId: 'home-1', cwd: '/repo', projectKey: '-repo', engineId: 'claude' },
            {
              sessionId: 'moved-1',
              cwd: '/repo',
              projectKey: '-repo--claude-worktrees-wt',
              engineId: 'claude'
            },
            // Pre-engine rows carry no engineId — still Claude.
            { sessionId: 'moved-2', cwd: '/repo', projectKey: '-repo--claude-worktrees-wt' },
            { sessionId: 'oc-1', cwd: '/repo', projectKey: '-repo', engineId: 'opencode' }
          ]
        },
        // A session BORN in the worktree — its own project, not a member.
        {
          cwd: '/repo/.claude/worktrees/wt',
          projectKey: '-repo--claude-worktrees-wt',
          folderName: 'wt',
          sessions: [
            {
              sessionId: 'wt-own',
              cwd: '/repo/.claude/worktrees/wt',
              projectKey: '-repo--claude-worktrees-wt',
              engineId: 'claude'
            }
          ]
        }
      ] as never)

      await deleteProject(manager, '-repo')

      // PRE-FIX: nothing but `deleteProjectFiles('-repo')` touched Claude files.
      expect(deleteSessionFiles.mock.calls.map((c: unknown[]) => [c[0], c[1]]).sort()).toEqual([
        ['moved-1', '-repo--claude-worktrees-wt'],
        ['moved-2', '-repo--claude-worktrees-wt']
      ])
      // The home-dir member goes with the directory; the worktree's own session
      // and the worktree DIR are never touched.
      expect(deleteProjectFiles).toHaveBeenCalledTimes(1)
      expect(deleteProjectFiles).toHaveBeenCalledWith('-repo')
      expect(order[order.length - 1]).toBe('unlink-claude')
      expect(manager.cancel.mock.calls.map((c: unknown[]) => c[0])).not.toContain('wt-own')
    })

    /**
     * The other direction. Deleting the WORKTREE-born project must not remove
     * its dir wholesale when a home-project session was relocated into it — the
     * sidebar shows that session under a different project, so `rm -r` on the
     * dir would delete it silently. Every member goes one by one instead.
     */
    it('deletes members one by one when their dir holds ANOTHER project’s relocated session', async () => {
      const manager = { cancel: vi.fn(), get: vi.fn(), forEach: vi.fn() } as any
      syncCore.setDirectories([
        {
          cwd: '/repo',
          projectKey: '-repo',
          folderName: 'repo',
          sessions: [
            {
              sessionId: 'moved-1',
              cwd: '/repo',
              projectKey: '-repo--claude-worktrees-wt',
              engineId: 'claude'
            }
          ]
        },
        {
          cwd: '/repo/.claude/worktrees/wt',
          projectKey: '-repo--claude-worktrees-wt',
          folderName: 'wt',
          sessions: [
            {
              sessionId: 'wt-own',
              cwd: '/repo/.claude/worktrees/wt',
              projectKey: '-repo--claude-worktrees-wt',
              engineId: 'claude'
            }
          ]
        }
      ] as never)

      await deleteProject(manager, '-repo--claude-worktrees-wt')

      expect(deleteProjectFiles).not.toHaveBeenCalled()
      expect(deleteSessionFiles.mock.calls.map((c: unknown[]) => [c[0], c[1]])).toEqual([
        ['wt-own', '-repo--claude-worktrees-wt']
      ])
      expect(manager.cancel.mock.calls.map((c: unknown[]) => c[0])).toEqual(['wt-own'])
    })

    it('a relocated member that fails to delete does not abandon the home dir', async () => {
      const manager = { cancel: vi.fn(), get: vi.fn(), forEach: vi.fn() } as any
      deleteSessionFiles.mockRejectedValueOnce(new Error('EPERM'))
      syncCore.setDirectories([
        {
          cwd: '/repo',
          projectKey: '-repo',
          folderName: 'repo',
          sessions: [
            {
              sessionId: 'moved-1',
              cwd: '/repo',
              projectKey: '-repo--claude-worktrees-wt',
              engineId: 'claude'
            }
          ]
        }
      ] as never)

      await expect(deleteProject(manager, '-repo')).resolves.toBeUndefined()
      expect(deleteProjectFiles).toHaveBeenCalledWith('-repo')
    })

    // -----------------------------------------------------------------------
    // Codex (ADR-066 slice G) — a delete is a leaf-first SUBTREE walk
    // -----------------------------------------------------------------------
    //
    // This branch used to `throw new Error('Codex deletion is unsupported …')`,
    // so the sidebar's delete was a dead end for the one engine whose sessions
    // cannot be removed by unlinking a file.

    it('walks the Codex subtree instead of refusing, with this module’s own hooks', async () => {
      const order: string[] = []
      unwatchSession.mockImplementation((id: string) => order.push(`unwatch:${id}`))
      const manager = {
        cancel: vi.fn((id: string) => order.push(`cancel:${id}`)),
        get: vi.fn(),
        has: vi.fn((id: string) => id === 'cx-live'),
        forEach: vi.fn()
      } as any
      syncCore.emit('session:created', ['cx-root', { cwd: '/repo' }])

      await deleteSession(manager, 'cx-root', '-repo', 'codex')

      expect(deleteCodexSubtree).toHaveBeenCalledTimes(1)
      const [plan, hooks] = deleteCodexSubtree.mock.calls[0] as any
      expect(plan.order).toEqual(['cx-root'])
      // The hooks are the same three steps every other engine's delete takes.
      hooks.unwatch('cx-root')
      hooks.stop('cx-root')
      hooks.removeSession('cx-root')
      expect(order).toEqual(['unwatch:cx-root', 'cancel:cx-root'])
      expect(syncCore.getCanonicalState().sessions['cx-root']).toBeUndefined()
      // `liveness` is answered by the session manager, not by the engine.
      const facts = codexDeletePlan.mock.calls[0][1] as (id: string) => { live: boolean }
      expect(typeof facts).toBe('function')
      expect(facts('cx-live').live).toBe(true)
      expect(facts('cx-root').live).toBe(false)
      // The file-unlinking dispatcher is NOT part of this path.
      expect(deleteSessionByEngine).not.toHaveBeenCalled()
      expect(refreshCanonicalDirectories).toHaveBeenCalled()
    })

    /**
     * The walk's one second chance (db v17). A `-32600` may mean "a branch this
     * app has never heard of still references that thread", and the lineage
     * cache is the only thing that can learn one — but only `handlers-core`
     * knows the root id and the liveness lookup a rebuilt plan needs, so the
     * closure is wired here.
     */
    it('hands the Codex walk a replan that rescans lineage and rebuilds', async () => {
      const manager = {
        cancel: vi.fn(),
        get: vi.fn(),
        has: vi.fn(() => false),
        forEach: vi.fn()
      } as any
      await deleteSession(manager, 'cx-root', '-repo', 'codex')
      const options = deleteCodexSubtree.mock.calls[0][2] as {
        replan?: () => Promise<{ order: string[] }>
      }
      expect(typeof options?.replan).toBe('function')
      codexDeletePlan.mockClear()
      const rebuilt = await options.replan!()
      // `all`: `verified_at` is ignored, because the cache has just been proven
      // incomplete by the refusal.
      expect(scanCodexLineage).toHaveBeenCalledWith(undefined, undefined, 'all')
      // ...and the plan is rebuilt AFTER the scan, or it would read the same
      // cache that was wrong a moment ago.
      expect(scanCodexLineage.mock.invocationCallOrder[0]).toBeLessThan(
        codexDeletePlan.mock.invocationCallOrder[0]
      )
      expect(rebuilt.order).toEqual(['cx-root'])
    })

    it('refreshes the listing even when the Codex walk is refused', async () => {
      const manager = {
        cancel: vi.fn(),
        get: vi.fn(),
        has: vi.fn(() => false),
        forEach: vi.fn()
      } as any
      deleteCodexSubtree.mockRejectedValueOnce(new Error('Codex refused to delete "b" (…)'))
      await expect(deleteSession(manager, 'cx-root', '-repo', 'codex')).rejects.toThrow(
        /Codex refused to delete/
      )
      // Without this the deleted-but-refused rows stay missing on every client:
      // the walk already replicated their removal before asking the binary.
      expect(refreshCanonicalDirectories).toHaveBeenCalled()
    })

    it('sweeps a project’s Codex sessions through the same walk, before the Claude unlink', async () => {
      const manager = {
        cancel: vi.fn(),
        get: vi.fn(),
        has: vi.fn(() => false),
        forEach: vi.fn()
      } as any
      const order: string[] = []
      deleteCodexSubtree.mockImplementation(async (plan: any) => {
        order.push(`codex:${plan.order.join(',')}`)
        return plan.order as string[]
      })
      deleteProjectFiles.mockImplementation(async () => {
        order.push('unlink-claude')
      })
      syncCore.setDirectories([
        {
          cwd: '/repo',
          projectKey: '-repo',
          folderName: 'repo',
          sessions: [
            { sessionId: 'cl-1', cwd: '/repo', projectKey: '-repo', engineId: 'claude' },
            { sessionId: 'cx-1', cwd: '/repo', projectKey: '-repo', engineId: 'codex' }
          ]
        }
      ] as never)

      await deleteProject(manager, '-repo')

      expect(order).toEqual(['codex:cx-1', 'unlink-claude'])
      // Codex never goes through the engine-neutral single-thread delete here —
      // the walk already removed it, and a second ask is refused as "no such
      // thread", which is indistinguishable from a real refusal.
      expect(deleteSessionByEngine).not.toHaveBeenCalled()
    })

    /**
     * A walk can delete MORE than the plan it was handed: its one rescan finds
     * branches the lineage cache never knew. Those ids are gone, so planning a
     * second delete for one of them would be refused as "no such thread" — a
     * refusal indistinguishable from a real one, which would abort the whole
     * project delete.
     */
    it('does not re-plan a thread the previous walk’s rescan already removed', async () => {
      const manager = {
        cancel: vi.fn(),
        get: vi.fn(),
        has: vi.fn(() => false),
        forEach: vi.fn()
      } as any
      // The plan for `cx-1` named only itself; the walk also removed `cx-2`.
      deleteCodexSubtree.mockImplementationOnce(async () => ['cx-1', 'cx-2'])
      syncCore.setDirectories([
        {
          cwd: '/repo',
          projectKey: '-repo',
          folderName: 'repo',
          sessions: [
            { sessionId: 'cx-1', cwd: '/repo', projectKey: '-repo', engineId: 'codex' },
            { sessionId: 'cx-2', cwd: '/repo', projectKey: '-repo', engineId: 'codex' }
          ]
        }
      ] as never)

      await deleteProject(manager, '-repo')

      expect(deleteCodexSubtree).toHaveBeenCalledTimes(1)
      expect(codexDeletePlan.mock.calls.map((call: unknown[]) => call[0])).toEqual(['cx-1'])
      expect(deleteProjectFiles).toHaveBeenCalledWith('-repo')
    })

    it('a refused Codex walk aborts the project delete before anything irreversible', async () => {
      const manager = {
        cancel: vi.fn(),
        get: vi.fn(),
        has: vi.fn(() => false),
        forEach: vi.fn()
      } as any
      deleteCodexSubtree.mockRejectedValueOnce(new Error('Codex refused to delete "cx-1" (…)'))
      syncCore.setDirectories([
        {
          cwd: '/repo',
          projectKey: '-repo',
          folderName: 'repo',
          sessions: [
            { sessionId: 'cl-1', cwd: '/repo', projectKey: '-repo', engineId: 'claude' },
            { sessionId: 'cx-1', cwd: '/repo', projectKey: '-repo', engineId: 'codex' }
          ]
        }
      ] as never)

      await expect(deleteProject(manager, '-repo')).rejects.toThrow(/Codex refused to delete/)
      // A session that still exists must not be left behind a deleted project.
      expect(deleteProjectFiles).not.toHaveBeenCalled()
    })

    it('one engine failing does not abandon the rest of the delete', async () => {
      const manager = { cancel: vi.fn(), get: vi.fn(), forEach: vi.fn() } as any
      deleteSessionByEngine.mockImplementation(async (id: string) => {
        if (id === 'oc-1') throw new Error('opencode server down')
      })
      syncCore.setDirectories([
        {
          cwd: '/repo',
          projectKey: '-repo',
          folderName: 'repo',
          sessions: [
            { sessionId: 'oc-1', cwd: '/repo', projectKey: '-repo', engineId: 'opencode' },
            { sessionId: 'pi-1', cwd: '/repo', projectKey: '-repo', engineId: 'pi' }
          ]
        }
      ] as never)

      await expect(deleteProject(manager, '-repo')).resolves.toBeUndefined()
      expect(deleteSessionByEngine).toHaveBeenCalledWith('pi-1', '-repo', 'pi')
      expect(deleteProjectFiles).toHaveBeenCalledWith('-repo')
    })
  })

  // -------------------------------------------------------------------------
  // F4 — clear-conversation is an event, and it never touches the engine
  // -------------------------------------------------------------------------

  describe('clearConversation', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      syncCore.resetCanonicalForTests()
    })

    it('emits the replicated reset with the mode the client resolved', async () => {
      const manager = makeManager(undefined)
      const sink = vi.fn()
      const off = addSyncSubscriber(sink)
      try {
        await clearConversation(manager, 'rid-clear', 'acceptEdits')
        expect(sink).toHaveBeenCalledWith(expect.any(Number), 'session:conversation-cleared', [
          'rid-clear',
          { permissionMode: 'acceptEdits' }
        ])
      } finally {
        off()
      }
    })

    it('drops an unknown mode rather than replicating it (remote-reachable channel)', async () => {
      const manager = makeManager(undefined)
      const sink = vi.fn()
      const off = addSyncSubscriber(sink)
      try {
        await clearConversation(manager, 'rid-clear', 'not-a-mode')
        expect(sink).toHaveBeenCalledWith(expect.any(Number), 'session:conversation-cleared', [
          'rid-clear',
          { permissionMode: undefined }
        ])
      } finally {
        off()
      }
    })

    /**
     * R11. The fold writes `queue: []` into canonical and every replica, so an
     * item left in the engine's own `SessionQueue` would be a queue of record
     * that disagrees with the queue that actually runs (ADR-053) — injected into
     * the next turn with no card, no take-back and no transcript row.
     * `recallQueued` is the honest primitive: the items come back as `recalled`.
     */
    it('empties the engine queue of record before replicating the reset', async () => {
      const recallQueued = vi.fn(async () => ({ recalled: ['later'], notRecalled: 0 }))
      const manager = makeManager(makeSessionStub({ recallQueued }))
      await clearConversation(manager, 'rid-clear', 'default')
      expect(recallQueued).toHaveBeenCalled()
    })

    it('still replicates the reset when the queue recall throws', async () => {
      // A dead child must not block the reset the user asked for — the fold is
      // what they see.
      const manager = makeManager(
        makeSessionStub({
          recallQueued: vi.fn(async () => {
            throw new Error('child is gone')
          })
        })
      )
      const sink = vi.fn()
      const off = addSyncSubscriber(sink)
      try {
        await expect(clearConversation(manager, 'rid-clear', 'default')).resolves.toBeUndefined()
        expect(sink).toHaveBeenCalledWith(
          expect.any(Number),
          'session:conversation-cleared',
          expect.anything()
        )
      } finally {
        off()
      }
    })
  })

  // -------------------------------------------------------------------------
  // R5 — the pre-spawn echoes are deleted, not merely unused
  // -------------------------------------------------------------------------

  describe('pre-spawn config echoes (deleted — R5)', () => {
    it('setPermissionMode emits NOTHING when no session exists', async () => {
      // It used to emit `session:permission-mode` here "so other clients looking
      // at the same pre-spawn session see the pick". No other client can: a
      // not-yet-spawned session lives only in its creator's replica. With
      // `ensured()` gone the emit reached nobody and still cost a ring entry.
      const manager = makeManager(undefined)
      const sink = vi.fn()
      const off = addSyncSubscriber(sink)
      try {
        await setPermissionMode(manager, 'rid-pre-spawn', 'plan')
        expect(sink).not.toHaveBeenCalled()
      } finally {
        off()
      }
    })

    it('setModel emits NOTHING when no session exists', async () => {
      const manager = { get: vi.fn(() => undefined), forEach: vi.fn() } as any
      const sink = vi.fn()
      const off = addSyncSubscriber(sink)
      try {
        await setModel(manager, 'rid-pre-spawn', 'opus')
        expect(sink).not.toHaveBeenCalled()
      } finally {
        off()
      }
    })

    it('setModel STILL emits for a live session', async () => {
      const manager = {
        get: vi.fn(() => makeSessionStub({ setModel: vi.fn(async () => {}) })),
        forEach: vi.fn()
      } as any
      const sink = vi.fn()
      const off = addSyncSubscriber(sink)
      try {
        await setModel(manager, 'rid-live', 'opus')
        expect(sink).toHaveBeenCalledWith(expect.any(Number), 'session:config-changed', [
          'rid-live',
          { model: 'opus', reasoningVariant: null }
        ])
      } finally {
        off()
      }
    })
  })
})
